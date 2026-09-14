/**
 * End-to-end verification of the authentication layer against the real
 * database. This is security-critical code, so the checks are adversarial:
 * each one represents an attack or a failure mode that must not work.
 *
 *   npm run auth:verify -w server
 */
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { connectDb, disconnectDb, db } from '../lib/db.js';
import { users, refreshTokens } from '../db/schema.js';
import * as auth from '../services/auth.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { HttpError } from '../app.js';

const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

let passed = 0;
let failed = 0;

async function check(label: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ${G}PASS${X}  ${label}\n`);
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`  ${R}FAIL${X}  ${label}\n        ${D}${msg}${X}\n`);
  }
}

/** Refresh tokens still usable for an account. */
async function liveTokens(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  return row?.value ?? 0;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Asserts that a call fails with a specific error code. */
async function expectFailure(
  fn: () => Promise<unknown>,
  code: string,
  what: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HttpError && err.code === code) return;
    const actual = err instanceof HttpError ? err.code : String(err);
    throw new Error(`${what}: expected code "${code}", got "${actual}"`);
  }
  throw new Error(`${what}: it succeeded, but should have failed`);
}

const DEVICE: auth.DeviceInfo = { userAgent: 'VerifyScript/1.0', ip: '203.0.113.7' };
const PASSWORD = 'correct-horse-battery-staple';

async function main() {
  await connectDb();
  process.stdout.write(`\n${B}Verifying authentication${X}\n\n`);

  const stamp = Date.now();
  const email = `auth-${stamp}@example.test`;
  const createdUserIds: string[] = [];

  /* ---------------- registration ---------------- */

  const registered = await auth.register(
    { email, password: PASSWORD, name: 'Verify User' },
    DEVICE,
  );
  createdUserIds.push(registered.user.id);

  await check('registration creates an account and a session', () => {
    assert(registered.user.email === email, 'email not normalised');
    assert(registered.session.accessToken.length > 20, 'no access token issued');
    assert(registered.session.refreshToken.length > 20, 'no refresh token issued');
  });

  await check('the access token carries the right claims', () => {
    const claims = verifyAccessToken(registered.session.accessToken);
    assert(claims.sub === registered.user.id, 'subject mismatch');
    assert(claims.tv === 0, 'token version should start at zero');
    assert(claims.email === email, 'email claim missing');
  });

  await check('the password is stored as an argon2id hash, never in plain text', async () => {
    const [row] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, registered.user.id));
    assert(row?.passwordHash, 'no hash stored');
    assert(
      row.passwordHash.startsWith('$argon2id$'),
      `unexpected hash format: ${row.passwordHash.slice(0, 20)}`,
    );
    assert(!row.passwordHash.includes(PASSWORD), 'the plain password appears in the hash');
  });

  await check('the refresh token is stored hashed, never in plain text', async () => {
    const [stored] = await db
      .select({ tokenHash: refreshTokens.tokenHash })
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, registered.user.id));
    assert(stored, 'no refresh token row');
    assert(
      stored.tokenHash !== registered.session.refreshToken,
      'the refresh token was stored in plain text',
    );
    assert(stored.tokenHash.length === 64, 'hash is not sha-256');
  });

  await check('registering the same email twice is refused', () =>
    expectFailure(
      () => auth.register({ email, password: PASSWORD, name: 'Impostor' }, DEVICE),
      'email_taken',
      'duplicate registration',
    ),
  );

  /* ---------------- login ---------------- */

  await check('login succeeds with the right password', async () => {
    const result = await auth.login(email, PASSWORD, DEVICE);
    assert(result.user.id === registered.user.id, 'wrong user returned');
  });

  await check('login fails with the wrong password', () =>
    expectFailure(
      () => auth.login(email, 'not-the-right-password', DEVICE),
      'invalid_credentials',
      'wrong password',
    ),
  );

  await check('login fails for an account that does not exist', () =>
    expectFailure(
      () => auth.login(`nobody-${stamp}@example.test`, PASSWORD, DEVICE),
      'invalid_credentials',
      'unknown account',
    ),
  );

  await check('a wrong password and an unknown account are indistinguishable', async () => {
    // Same error code and message, so the response cannot be used to
    // enumerate which addresses are registered.
    let wrongPasswordMsg = '';
    let unknownUserMsg = '';
    try {
      await auth.login(email, 'wrong', DEVICE);
    } catch (e) {
      wrongPasswordMsg = e instanceof Error ? e.message : '';
    }
    try {
      await auth.login(`ghost-${stamp}@example.test`, 'wrong', DEVICE);
    } catch (e) {
      unknownUserMsg = e instanceof Error ? e.message : '';
    }
    assert(
      wrongPasswordMsg === unknownUserMsg && wrongPasswordMsg.length > 0,
      `messages differ: "${wrongPasswordMsg}" vs "${unknownUserMsg}"`,
    );
  });

  await check('login timing does not reveal whether an account exists', async () => {
    const time = async (fn: () => Promise<unknown>) => {
      const t0 = process.hrtime.bigint();
      await fn().catch(() => undefined);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };

    // Three runs each, take the median, to smooth out scheduler noise.
    const existing: number[] = [];
    const missing: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      existing.push(await time(() => auth.login(email, 'wrong-password', DEVICE)));
      missing.push(
        await time(() => auth.login(`nope-${stamp}-${i}@example.test`, 'wrong-password', DEVICE)),
      );
    }
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[1] ?? 0;
    const a = median(existing);
    const b = median(missing);
    const ratio = Math.max(a, b) / Math.max(Math.min(a, b), 0.001);

    // Both paths run a real argon2 verification, so they should be close.
    // A large gap would mean the decoy hash is not being used.
    assert(ratio < 3, `timing differs too much: ${a.toFixed(1)}ms vs ${b.toFixed(1)}ms`);
  });

  /* ---------------- refresh rotation ---------------- */

  const first = await auth.login(email, PASSWORD, DEVICE);

  const rotated = await auth.refresh(first.session.refreshToken, DEVICE);

  await check('refreshing issues a brand new refresh token', () => {
    assert(
      rotated.session.refreshToken !== first.session.refreshToken,
      'the same refresh token was handed back',
    );
  });

  await check('the old refresh token is retired after use', async () => {
    const { hashRefreshToken } = await import('../lib/tokens.js');
    const [old] = await db
      .select({ usedAt: refreshTokens.usedAt, revokedReason: refreshTokens.revokedReason })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(first.session.refreshToken)));
    assert(old?.usedAt, 'the used token was not marked');
    assert(old.revokedReason === 'rotated', `unexpected reason: ${String(old.revokedReason)}`);
  });

  await check('reusing a spent refresh token is refused', async () => {
    const { hashRefreshToken } = await import('../lib/tokens.js');

    /*
     * Aged past the grace window first.
     *
     * A token presented again within seconds of its rotation is treated as
     * one browser sending the same cookie twice, not as theft. A thief's
     * replay arrives later than that, which is what this drives.
     */
    await db
      .update(refreshTokens)
      .set({ usedAt: new Date(Date.now() - 60_000), revokedAt: new Date(Date.now() - 60_000) })
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(first.session.refreshToken)));
    auth.authInternals.forgetRotations();

    await expectFailure(
      () => auth.refresh(first.session.refreshToken, DEVICE),
      'token_reuse_detected',
      'replaying a used token',
    );
  });

  await check('reuse revokes the entire token family, not just one token', async () => {
    // The attacker replayed the old token above. The legitimate user's
    // newer token must now be dead too, because we cannot tell them apart.
    await expectFailure(
      () => auth.refresh(rotated.session.refreshToken, DEVICE),
      'token_reuse_detected',
      'the honest holder after a detected theft',
    );
  });

  await check('an invented refresh token is refused', () =>
    expectFailure(
      () => auth.refresh('not-a-real-token-at-all', DEVICE),
      'invalid_refresh_token',
      'forged token',
    ),
  );

  /* ---------------- logout ---------------- */

  const forLogout = await auth.login(email, PASSWORD, DEVICE);
  await auth.logout(forLogout.session.refreshToken);

  await check('a refresh token stops working after logout', () =>
    expectFailure(
      () => auth.refresh(forLogout.session.refreshToken, DEVICE),
      'token_reuse_detected',
      'refresh after logout',
    ),
  );

  await check('logging out everywhere invalidates every access token', async () => {
    const a = await auth.login(email, PASSWORD, DEVICE);
    const b = await auth.login(email, PASSWORD, DEVICE);

    const beforeA = verifyAccessToken(a.session.accessToken);
    assert(beforeA.sub, 'token unreadable before logout');

    await auth.logoutEverywhere(a.user.id);

    // The JWT still verifies cryptographically; what changes is that its
    // token version no longer matches the account, which is what the
    // requireAuth middleware checks.
    const [fresh] = await db
      .select({ tokenVersion: users.tokenVersion })
      .from(users)
      .where(eq(users.id, a.user.id));
    assert(fresh, 'user vanished');
    const claimsA = verifyAccessToken(a.session.accessToken);
    const claimsB = verifyAccessToken(b.session.accessToken);
    assert(fresh.tokenVersion > claimsA.tv, 'token version was not bumped');
    assert(fresh.tokenVersion > claimsB.tv, 'second session not invalidated');

    const live = await liveTokens(a.user.id);
    assert(live === 0, `${live} refresh tokens survived logout-everywhere`);
  });

  /* ---------------- password change ---------------- */

  await check('changing the password requires the current one', async () => {
    const u = await auth.register(
      { email: `pw-${stamp}@example.test`, password: PASSWORD, name: 'PW User' },
      DEVICE,
    );
    createdUserIds.push(u.user.id);

    await expectFailure(
      () => auth.changePassword(u.user.id, 'wrong-current', 'a-brand-new-passphrase'),
      'invalid_credentials',
      'change with wrong current password',
    );
  });

  await check('changing the password revokes every existing session', async () => {
    const u = await auth.register(
      { email: `pw2-${stamp}@example.test`, password: PASSWORD, name: 'PW2 User' },
      DEVICE,
    );
    createdUserIds.push(u.user.id);

    await auth.login(u.user.email, PASSWORD, DEVICE);
    await auth.changePassword(u.user.id, PASSWORD, 'a-brand-new-passphrase');

    const live = await liveTokens(u.user.id);
    assert(live === 0, `${live} sessions survived a password change`);

    const [fresh] = await db
      .select({ tokenVersion: users.tokenVersion })
      .from(users)
      .where(eq(users.id, u.user.id));
    assert(fresh && fresh.tokenVersion > 0, 'token version not bumped on password change');
  });

  await check('the new password works and the old one does not', async () => {
    const u = await auth.register(
      { email: `pw3-${stamp}@example.test`, password: PASSWORD, name: 'PW3 User' },
      DEVICE,
    );
    createdUserIds.push(u.user.id);

    await auth.changePassword(u.user.id, PASSWORD, 'the-replacement-passphrase');
    const ok = await auth.login(u.user.email, 'the-replacement-passphrase', DEVICE);
    assert(ok.session.accessToken, 'new password rejected');

    await expectFailure(
      () => auth.login(u.user.email, PASSWORD, DEVICE),
      'invalid_credentials',
      'old password after change',
    );
  });

  /* ---------------- social login ---------------- */

  const googleProfile: auth.SocialProfile = {
    provider: 'google',
    subject: `google-subject-${stamp}`,
    email: `social-${stamp}@example.test`,
    name: 'Social User',
    avatarUrl: 'https://example.com/avatar.png',
    emailVerified: true,
  };

  const social = await auth.socialLogin(googleProfile, DEVICE);
  createdUserIds.push(social.user.id);

  await check('a first social sign-in creates the account', () => {
    assert(social.created, 'expected a new account');
    assert(
      social.user.providers.length === 1 && social.user.providers[0] === 'google',
      'identity not linked',
    );
    assert(social.user.emailVerifiedAt, 'verified email not recorded');
    assert(!social.user.hasPassword, 'a social account should have no password');
  });

  await check('signing in again with the same provider reuses the account', async () => {
    const again = await auth.socialLogin(googleProfile, DEVICE);
    assert(!again.created, 'a duplicate account was created');
    assert(again.user.id === social.user.id, 'a different account was returned');
  });

  await check('a verified social email links to an existing password account', async () => {
    const linkEmail = `link-${stamp}@example.test`;
    const existing = await auth.register(
      { email: linkEmail, password: PASSWORD, name: 'Link User' },
      DEVICE,
    );
    createdUserIds.push(existing.user.id);

    const linked = await auth.socialLogin(
      { ...googleProfile, subject: `sub-link-${stamp}`, email: linkEmail, emailVerified: true },
      DEVICE,
    );
    assert(!linked.created, 'a second account was created instead of linking');
    assert(linked.user.providers.includes('google'), 'identity not attached');
    // Linking adds a way in; it must not take the password away.
    assert(linked.user.hasPassword, 'linking Google removed the existing password');
  });

  await check('an UNVERIFIED social email cannot hijack an existing account', async () => {
    // This is the account-takeover path: register at a provider with someone
    // else's address, leave it unverified, and try to sign in as them.
    const victimEmail = `victim-${stamp}@example.test`;
    const victim = await auth.register(
      { email: victimEmail, password: PASSWORD, name: 'Victim' },
      DEVICE,
    );
    createdUserIds.push(victim.user.id);

    await expectFailure(
      () =>
        auth.socialLogin(
          {
            ...googleProfile,
            subject: `attacker-${stamp}`,
            email: victimEmail,
            emailVerified: false,
          },
          DEVICE,
        ),
      'email_unverified_at_provider',
      'takeover via unverified provider email',
    );
  });

  await check('registering with the email of a social-only account is refused', () =>
    expectFailure(
      () =>
        auth.register({ email: googleProfile.email, password: PASSWORD, name: 'Hijacker' }, DEVICE),
      'use_social_login',
      'password registration over a social account',
    ),
  );

  /* ---------------- sessions list ---------------- */

  await check('the sessions list marks the current device', async () => {
    const u = await auth.register(
      { email: `sess-${stamp}@example.test`, password: PASSWORD, name: 'Sess User' },
      DEVICE,
    );
    createdUserIds.push(u.user.id);

    const second = await auth.login(u.user.email, PASSWORD, {
      userAgent: 'Other Device',
      ip: '198.51.100.4',
    });

    const list = await auth.listSessions(u.user.id, second.session.refreshToken);
    assert(list.length === 2, `expected 2 sessions, found ${list.length}`);
    assert(list.filter((s) => s.current).length === 1, 'exactly one session should be current');
  });

  await check('revoking one session leaves the others alone', async () => {
    const u = await auth.register(
      { email: `rev-${stamp}@example.test`, password: PASSWORD, name: 'Rev User' },
      DEVICE,
    );
    createdUserIds.push(u.user.id);
    await auth.login(u.user.email, PASSWORD, { userAgent: 'Second', ip: '198.51.100.9' });

    const before = await auth.listSessions(u.user.id);
    assert(before.length === 2, 'setup failed');
    const target = before[0];
    assert(target, 'no session to revoke');

    await auth.revokeSession(u.user.id, target.id);
    const after = await auth.listSessions(u.user.id);
    assert(after.length === 1, `expected 1 session left, found ${after.length}`);
  });

  await check('you cannot revoke a session belonging to someone else', async () => {
    const a = await auth.register(
      { email: `owner-${stamp}@example.test`, password: PASSWORD, name: 'Owner' },
      DEVICE,
    );
    const b = await auth.register(
      { email: `other-${stamp}@example.test`, password: PASSWORD, name: 'Other' },
      DEVICE,
    );
    createdUserIds.push(a.user.id, b.user.id);

    const theirs = await auth.listSessions(a.user.id);
    const target = theirs[0];
    assert(target, 'setup failed');

    await expectFailure(
      () => auth.revokeSession(b.user.id, target.id),
      'session_not_found',
      'cross-account session revocation',
    );
  });

  /* ---------------- public shape ---------------- */

  await check('the public user shape never leaks the password hash', async () => {
    const u = await auth.getAccount(registered.user.id);
    assert(u, 'user missing');
    const publicUser = auth.toPublicUser(u);
    const serialised = JSON.stringify(publicUser);
    assert(!serialised.includes('argon2'), 'the hash leaked into the public shape');
    assert(!('passwordHash' in publicUser), 'passwordHash present on the public shape');
    assert(publicUser.hasPassword, 'hasPassword flag should be true here');
  });

  // The bug this guards: hasPassword was once derived from a hash that most
  // queries did not load, so any path that skipped it -- refresh, for one --
  // reported a password account as having none, which would let the account
  // settings screen overwrite a credential without asking for the current
  // one. An account now never carries the hash at all; the flag must still
  // be right.
  await check('hasPassword is right on an account that never loads the hash', async () => {
    const u = await auth.getAccount(registered.user.id);
    assert(u, 'user missing');
    assert(!('passwordHash' in u), 'an account carried the password hash');
    assert(auth.toPublicUser(u).hasPassword, 'hasPassword must not depend on loading the hash');
  });

  await check('a refreshed session still reports hasPassword', async () => {
    const fresh = await auth.register(
      { email: `proj-${stamp}@example.test`, password: PASSWORD, name: 'Projection Probe' },
      DEVICE,
    );
    createdUserIds.push(fresh.user.id);

    const rotated = await auth.refresh(fresh.session.refreshToken, DEVICE);
    assert(
      auth.toPublicUser(rotated.user).hasPassword,
      'refresh reported a password account as passwordless',
    );
  });

  /* ---------------- suspension ---------------- */

  /*
   * Every authenticated request already refused a suspended account, so
   * this was "enforced" -- but only after a successful sign-in, a redirect
   * to the dashboard and a screen of failing requests. Refusing at the
   * door is the difference between a decision and a bug.
   */
  await check('a suspended account cannot sign in', async () => {
    const suspendedEmail = `suspended-${stamp}@example.test`;
    const made = await auth.register(
      { email: suspendedEmail, password: PASSWORD, name: 'Suspended' },
      DEVICE,
    );
    createdUserIds.push(made.user.id);

    await db
      .update(users)
      .set({ suspendedAt: new Date(), suspendedReason: 'Testing' })
      .where(eq(users.id, made.user.id));

    await expectFailure(
      () => auth.login(suspendedEmail, PASSWORD, DEVICE),
      'account_suspended',
      'sign-in by a suspended account',
    );
  });

  await check('the wrong password on a suspended account still says wrong password', async () => {
    const suspendedEmail = `suspended2-${stamp}@example.test`;
    const made = await auth.register(
      { email: suspendedEmail, password: PASSWORD, name: 'Suspended Two' },
      DEVICE,
    );
    createdUserIds.push(made.user.id);

    await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, made.user.id));

    // Credentials are checked first on purpose. Announcing the suspension
    // to someone who does not know the password would tell anyone who
    // asked which addresses have suspended accounts.
    await expectFailure(
      () => auth.login(suspendedEmail, 'not-the-password', DEVICE),
      'invalid_credentials',
      'a bad password on a suspended account',
    );
  });

  await check('restoring an account lets it sign in again', async () => {
    const restoredEmail = `restored-${stamp}@example.test`;
    const made = await auth.register(
      { email: restoredEmail, password: PASSWORD, name: 'Restored' },
      DEVICE,
    );
    createdUserIds.push(made.user.id);

    await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, made.user.id));
    await db
      .update(users)
      .set({ suspendedAt: null, suspendedReason: '' })
      .where(eq(users.id, made.user.id));

    const result = await auth.login(restoredEmail, PASSWORD, DEVICE);
    assert(result.user.id === made.user.id, 'restored account was refused');
  });

  /* ---------------- concurrency ---------------- */

  /*
   * Guarantees that only hold if the database enforces them. Each check
   * fires the same request several times at once rather than one after
   * another, because a race never shows up in a test that waits its turn.
   */

  await check('the same refresh token sent several times at once keeps the session', async () => {
    /*
     * The failure this guards is the one that shipped: a browser can send
     * the same refresh cookie twice at once -- two tabs, or a page restore
     * racing a retry -- and treating the duplicate as theft signed people
     * out of a session they were actively using.
     */
    const racer = await auth.register(
      { email: `race-refresh-${stamp}@example.test`, password: PASSWORD, name: 'Racer' },
      DEVICE,
    );
    createdUserIds.push(racer.user.id);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => auth.refresh(racer.session.refreshToken, DEVICE)),
    );

    const failures = results.filter((r) => r.status === 'rejected');
    assert(
      failures.length === 0,
      `${String(failures.length)} of 6 duplicate refreshes were refused`,
    );

    // Every caller must be given a token that works, and they should all
    // have been handed the same one.
    const issued = new Set(
      results.map((r) => (r.status === 'fulfilled' ? r.value.session.refreshToken : '')),
    );
    assert(issued.size === 1, `${String(issued.size)} different tokens were handed out`);

    const [winner] = [...issued];
    assert(winner, 'no token was issued');

    // Still signed in, and the token just issued still works.
    const after = await auth.refresh(winner, DEVICE);
    assert(after.user.id === racer.user.id, 'the session did not survive');
    createdUserIds.push(after.user.id);
  });

  await check('a replay long after the rotation still revokes the family', async () => {
    // The grace window must not blunt reuse detection itself.
    const victim = await auth.register(
      { email: `race-theft-${stamp}@example.test`, password: PASSWORD, name: 'Victim' },
      DEVICE,
    );
    createdUserIds.push(victim.user.id);

    const stolen = victim.session.refreshToken;
    const honest = await auth.refresh(stolen, DEVICE);

    const { hashRefreshToken } = await import('../lib/tokens.js');
    await db
      .update(refreshTokens)
      .set({ usedAt: new Date(Date.now() - 60_000), revokedAt: new Date(Date.now() - 60_000) })
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(stolen)));
    auth.authInternals.forgetRotations();

    await expectFailure(
      () => auth.refresh(stolen, DEVICE),
      'token_reuse_detected',
      'a replay after the grace window',
    );

    // And the honest holder is signed out too, because the two cannot be
    // told apart once a token is in two hands.
    await expectFailure(
      () => auth.refresh(honest.session.refreshToken, DEVICE),
      'token_reuse_detected',
      'the legitimate token after a detected theft',
    );

    const live = await liveTokens(victim.user.id);
    assert(live === 0, `${String(live)} tokens survived a detected reuse`);
  });

  await check('two sign-ups for the same email at once create one account', async () => {
    const raceEmail = `race-signup-${stamp}@example.test`;

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        auth.register({ email: raceEmail, password: PASSWORD, name: 'Twin' }, DEVICE),
      ),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') createdUserIds.push(r.value.user.id);
    }

    const accounts = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, raceEmail));
    for (const a of accounts) if (!createdUserIds.includes(a.id)) createdUserIds.push(a.id);

    assert(accounts.length === 1, `${String(accounts.length)} accounts exist for one email`);

    const refused = results.filter((r) => r.status === 'rejected');
    assert(refused.length === 3, `${String(refused.length)} of the duplicates were refused`);
    for (const r of refused) {
      const reason = r.reason as unknown;
      assert(
        reason instanceof HttpError && reason.code === 'email_taken',
        `a duplicate failed with ${String(reason)} rather than email_taken`,
      );
    }
  });

  /* ---------------- cleanup ---------------- */

  process.stdout.write(`\n${D}Cleaning up...${X}\n`);
  // Refresh tokens and linked identities go with their user, by cascade.
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }

  process.stdout.write(
    `\n  ${passed > 0 ? G : D}${passed} passed${X}` +
      (failed > 0 ? `   ${R}${B}${failed} failed${X}` : '') +
      '\n\n',
  );

  await disconnectDb();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err: unknown) => {
  process.stderr.write(`\n${R}${B}Verification crashed${X}\n${String(err)}\n\n`);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
