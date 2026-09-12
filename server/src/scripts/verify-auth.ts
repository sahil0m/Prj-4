/**
 * End-to-end verification of the authentication layer against the real
 * database. This is security-critical code, so the checks are adversarial:
 * each one represents an attack or a failure mode that must not work.
 *
 *   npm run auth:verify -w server
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import { User, RefreshToken } from '../models/index.js';
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
  createdUserIds.push(registered.user._id.toString());

  await check('registration creates an account and a session', () => {
    assert(registered.user.email === email, 'email not normalised');
    assert(registered.session.accessToken.length > 20, 'no access token issued');
    assert(registered.session.refreshToken.length > 20, 'no refresh token issued');
  });

  await check('the access token carries the right claims', () => {
    const claims = verifyAccessToken(registered.session.accessToken);
    assert(claims.sub === registered.user._id.toString(), 'subject mismatch');
    assert(claims.tv === 0, 'token version should start at zero');
    assert(claims.email === email, 'email claim missing');
  });

  await check('the password is stored as an argon2id hash, never in plain text', async () => {
    const row = await User.findById(registered.user._id).select('+passwordHash').lean();
    assert(row?.passwordHash, 'no hash stored');
    assert(
      row.passwordHash.startsWith('$argon2id$'),
      `unexpected hash format: ${row.passwordHash.slice(0, 20)}`,
    );
    assert(!row.passwordHash.includes(PASSWORD), 'the plain password appears in the hash');
  });

  await check('the refresh token is stored hashed, never in plain text', async () => {
    const stored = await RefreshToken.findOne({ userId: registered.user._id }).lean();
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
    assert(result.user._id.toString() === registered.user._id.toString(), 'wrong user returned');
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
    const old = await RefreshToken.findOne({
      tokenHash: hashRefreshToken(first.session.refreshToken),
    }).lean();
    assert(old?.usedAt, 'the used token was not marked');
    assert(old.revokedReason === 'rotated', `unexpected reason: ${String(old.revokedReason)}`);
  });

  await check('reusing a spent refresh token is refused', () =>
    expectFailure(
      () => auth.refresh(first.session.refreshToken, DEVICE),
      'token_reuse_detected',
      'replaying a used token',
    ),
  );

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

    await auth.logoutEverywhere(a.user._id.toString());

    // The JWT still verifies cryptographically; what changes is that its
    // token version no longer matches the account, which is what the
    // requireAuth middleware checks.
    const fresh = await User.findById(a.user._id).lean();
    assert(fresh, 'user vanished');
    const claimsA = verifyAccessToken(a.session.accessToken);
    const claimsB = verifyAccessToken(b.session.accessToken);
    assert(fresh.tokenVersion > claimsA.tv, 'token version was not bumped');
    assert(fresh.tokenVersion > claimsB.tv, 'second session not invalidated');

    const live = await RefreshToken.countDocuments({ userId: a.user._id, revokedAt: null });
    assert(live === 0, `${live} refresh tokens survived logout-everywhere`);
  });

  /* ---------------- password change ---------------- */

  await check('changing the password requires the current one', async () => {
    const u = await auth.register(
      { email: `pw-${stamp}@example.test`, password: PASSWORD, name: 'PW User' },
      DEVICE,
    );
    createdUserIds.push(u.user._id.toString());

    await expectFailure(
      () => auth.changePassword(u.user._id.toString(), 'wrong-current', 'a-brand-new-passphrase'),
      'invalid_credentials',
      'change with wrong current password',
    );
  });

  await check('changing the password revokes every existing session', async () => {
    const u = await auth.register(
      { email: `pw2-${stamp}@example.test`, password: PASSWORD, name: 'PW2 User' },
      DEVICE,
    );
    createdUserIds.push(u.user._id.toString());

    await auth.login(u.user.email, PASSWORD, DEVICE);
    await auth.changePassword(u.user._id.toString(), PASSWORD, 'a-brand-new-passphrase');

    const live = await RefreshToken.countDocuments({ userId: u.user._id, revokedAt: null });
    assert(live === 0, `${live} sessions survived a password change`);

    const fresh = await User.findById(u.user._id).lean();
    assert(fresh && fresh.tokenVersion > 0, 'token version not bumped on password change');
  });

  await check('the new password works and the old one does not', async () => {
    const u = await auth.register(
      { email: `pw3-${stamp}@example.test`, password: PASSWORD, name: 'PW3 User' },
      DEVICE,
    );
    createdUserIds.push(u.user._id.toString());

    await auth.changePassword(u.user._id.toString(), PASSWORD, 'the-replacement-passphrase');
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
  createdUserIds.push(social.user._id.toString());

  await check('a first social sign-in creates the account', () => {
    assert(social.created, 'expected a new account');
    assert(social.user.identities.length === 1, 'identity not linked');
    assert(social.user.emailVerifiedAt, 'verified email not recorded');
    assert(!social.user.passwordHash, 'a social account should have no password');
  });

  await check('signing in again with the same provider reuses the account', async () => {
    const again = await auth.socialLogin(googleProfile, DEVICE);
    assert(!again.created, 'a duplicate account was created');
    assert(
      again.user._id.toString() === social.user._id.toString(),
      'a different account was returned',
    );
  });

  await check('a verified social email links to an existing password account', async () => {
    const linkEmail = `link-${stamp}@example.test`;
    const existing = await auth.register(
      { email: linkEmail, password: PASSWORD, name: 'Link User' },
      DEVICE,
    );
    createdUserIds.push(existing.user._id.toString());

    const linked = await auth.socialLogin(
      { ...googleProfile, subject: `sub-link-${stamp}`, email: linkEmail, emailVerified: true },
      DEVICE,
    );
    assert(!linked.created, 'a second account was created instead of linking');
    assert(linked.user.identities.length === 1, 'identity not attached');
  });

  await check('an UNVERIFIED social email cannot hijack an existing account', async () => {
    // This is the account-takeover path: register at a provider with someone
    // else's address, leave it unverified, and try to sign in as them.
    const victimEmail = `victim-${stamp}@example.test`;
    const victim = await auth.register(
      { email: victimEmail, password: PASSWORD, name: 'Victim' },
      DEVICE,
    );
    createdUserIds.push(victim.user._id.toString());

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
    createdUserIds.push(u.user._id.toString());

    const second = await auth.login(u.user.email, PASSWORD, {
      userAgent: 'Other Device',
      ip: '198.51.100.4',
    });

    const list = await auth.listSessions(u.user._id.toString(), second.session.refreshToken);
    assert(list.length === 2, `expected 2 sessions, found ${list.length}`);
    assert(list.filter((s) => s.current).length === 1, 'exactly one session should be current');
  });

  await check('revoking one session leaves the others alone', async () => {
    const u = await auth.register(
      { email: `rev-${stamp}@example.test`, password: PASSWORD, name: 'Rev User' },
      DEVICE,
    );
    createdUserIds.push(u.user._id.toString());
    await auth.login(u.user.email, PASSWORD, { userAgent: 'Second', ip: '198.51.100.9' });

    const before = await auth.listSessions(u.user._id.toString());
    assert(before.length === 2, 'setup failed');
    const target = before[0];
    assert(target, 'no session to revoke');

    await auth.revokeSession(u.user._id.toString(), target.id);
    const after = await auth.listSessions(u.user._id.toString());
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
    createdUserIds.push(a.user._id.toString(), b.user._id.toString());

    const theirs = await auth.listSessions(a.user._id.toString());
    const target = theirs[0];
    assert(target, 'setup failed');

    await expectFailure(
      () => auth.revokeSession(b.user._id.toString(), target.id),
      'session_not_found',
      'cross-account session revocation',
    );
  });

  /* ---------------- public shape ---------------- */

  await check('the public user shape never leaks the password hash', async () => {
    const u = await User.findById(registered.user._id).select('+passwordHash');
    assert(u, 'user missing');
    const publicUser = auth.toPublicUser(u);
    const serialised = JSON.stringify(publicUser);
    assert(!serialised.includes('argon2'), 'the hash leaked into the public shape');
    assert(!('passwordHash' in publicUser), 'passwordHash present on the public shape');
    assert(publicUser.hasPassword, 'hasPassword flag should be true here');
  });

  /* ---------------- cleanup ---------------- */

  process.stdout.write(`\n${D}Cleaning up...${X}\n`);
  await RefreshToken.deleteMany({ userId: { $in: createdUserIds } });
  await User.deleteMany({ _id: { $in: createdUserIds } });

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
