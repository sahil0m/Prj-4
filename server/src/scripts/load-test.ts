/**
 * A lecture hall, simulated.
 *
 * Connects many phones to one live session and makes them behave like a
 * room does: everybody joins at once when the slide goes up, and everybody
 * answers within a few seconds of each other. That burst is the shape of
 * the load, and it is the only shape worth testing -- a product that keeps
 * up with answers trickling in one a second will still fall over when two
 * hundred people all look up at the same question.
 *
 * Run the server first, then:
 *   npm run load:test --workspace @pulse/server -- --phones 200
 */
import { io, type Socket } from 'socket.io-client';
import { and, eq, like } from 'drizzle-orm';
import { connectDb, disconnectDb, db } from '../lib/db.js';
import { users } from '../db/schema.js';
import * as auth from '../services/auth.js';
import type { JoinResult, AckResult } from '@pulse/shared';

const BASE = process.env.PULSE_URL ?? 'http://localhost:4000';
const API = `${BASE}/api`;

const G = '\x1b[32m';
const Y = '\x1b[33m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = Number(args[at + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const PHONES = flag('phones', 150);

const say = (line = '') => process.stdout.write(`${line}\n`);

/**
 * How long until the presenter screen stops being redrawn.
 *
 * What a presenter experiences is not the last acknowledgement but the
 * last redraw, so that is what this measures. Reading the counts the
 * instant the last answer is acknowledged measures how far behind the
 * broadcasts are -- which is how an earlier run of this reported zero
 * leaderboards that had in fact been sent.
 */
let lastEvent = 0;

async function settle(quietFor = 700, limit = 20_000): Promise<number> {
  const started = performance.now();

  for (;;) {
    if (lastEvent > 0 && performance.now() - lastEvent >= quietFor) break;
    if (performance.now() - started > limit) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return lastEvent > 0 ? Math.max(0, lastEvent - started) : 0;
}

/** Milliseconds, as a reader wants them. */
const ms = (value: number) => `${value.toFixed(0)}ms`;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

function report(label: string, timings: number[], budget: number): boolean {
  const p50 = percentile(timings, 50);
  const p95 = percentile(timings, 95);
  const worst = Math.max(...timings, 0);
  const ok = p95 <= budget;

  say(
    `  ${ok ? `${G}ok  ` : `${R}SLOW`}${X} ${label.padEnd(34)} ` +
      `${D}median${X} ${ms(p50).padStart(7)}   ${D}95th${X} ${ms(p95).padStart(7)}   ` +
      `${D}worst${X} ${ms(worst).padStart(7)}   ${D}budget ${String(budget)}ms${X}`,
  );

  return ok;
}

async function api<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${String(response.status)} ${text}`);
  return (text === '' ? null : JSON.parse(text)) as T;
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const email = `load-${String(stamp)}@example.test`;

  say(`\n${B}A room of ${String(PHONES)} phones, against ${BASE}${X}\n`);

  /* ---------------- a session to join ---------------- */

  /*
   * The presenter is created through the service rather than the sign-up
   * endpoint, which allows five accounts an hour from one address -- the
   * right rule for the real world and the wrong one for a tool that is
   * run repeatedly against a laptop.
   */
  await connectDb();

  const { session: presenterSession } = await auth.register(
    { email, password: 'a-strong-passphrase-here', name: 'Load Test' },
    { userAgent: 'load-test', ip: '127.0.0.1' },
  );

  const token = presenterSession.accessToken;

  const { deck } = await api<{ deck: { id: string; slides: { id: string; kind: string }[] } }>(
    '/decks',
    { title: 'Load test', slideKinds: ['word_cloud', 'quiz_select'] },
    token,
  );

  const wordSlide = deck.slides.find((s) => s.kind === 'word_cloud');
  const quizSlide = deck.slides.find((s) => s.kind === 'quiz_select');
  if (!wordSlide || !quizSlide) throw new Error('the deck is not what was asked for');

  const { session } = await api<{ session: { id: string; joinCode: string } }>(
    '/sessions',
    { deckId: deck.id },
    token,
  );

  /* ---------------- the presenter watches ---------------- */

  const presenter: Socket = io(BASE, {
    transports: ['websocket'],
    forceNew: true,
    auth: { token },
  });

  let resultsSeen = 0;
  let leaderboardSeen = 0;
  presenter.on('results:update', () => {
    resultsSeen += 1;
    lastEvent = performance.now();
  });
  presenter.on('leaderboard:update', () => {
    leaderboardSeen += 1;
    lastEvent = performance.now();
  });

  await new Promise<void>((resolve) =>
    presenter.on('connect', () => {
      resolve();
    }),
  );
  await new Promise<void>((resolve) => {
    presenter.emit('presenter:join', { sessionId: session.id }, () => {
      resolve();
    });
  });

  /* ---------------- the room arrives ---------------- */

  const phones: Socket[] = [];
  const joinTimings: number[] = [];

  const connected = await Promise.all(
    Array.from({ length: PHONES }, async (_, i) => {
      const socket: Socket = io(BASE, { transports: ['websocket'], forceNew: true });
      phones.push(socket);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('connect timed out'));
        }, 30_000);
        socket.on('connect', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      const started = performance.now();
      const result = await new Promise<JoinResult>((resolve) => {
        socket.emit(
          'participant:join',
          {
            joinCode: session.joinCode,
            deviceToken: `load-${String(stamp)}-${String(i)}`,
            displayName: `Student ${String(i + 1)}`,
          },
          resolve,
        );
      });
      joinTimings.push(performance.now() - started);

      return result.ok;
    }),
  );

  const joined = connected.filter(Boolean).length;
  say(`${D}${String(joined)} of ${String(PHONES)} phones joined${X}\n`);

  let healthy = joined === PHONES;
  healthy = report('everyone joins at once', joinTimings, 3000) && healthy;

  /* ---------------- everybody answers ---------------- */

  const WORDS = ['curious', 'tired', 'ready', 'hopeful', 'awake', 'hungry', 'focused'];

  resultsSeen = 0;
  lastEvent = 0;
  const wordRefusals = new Map<string, number>();
  const answerStart = performance.now();

  const answerTimings = await Promise.all(
    phones.map(async (socket, i) => {
      const started = performance.now();
      const ack = await new Promise<AckResult>((resolve) => {
        socket.emit(
          'participant:answer',
          {
            slideId: wordSlide.id,
            payload: { words: [WORDS[i % WORDS.length]] },
            clientMsgId: `w-${String(stamp)}-${String(i)}`,
          },
          resolve,
        );
      });

      if (!ack.ok) wordRefusals.set(ack.code, (wordRefusals.get(ack.code) ?? 0) + 1);
      return performance.now() - started;
    }),
  );

  const answerWall = performance.now() - answerStart;
  const settled = await settle();

  if (wordRefusals.size > 0) {
    healthy = false;
    for (const [code, count] of wordRefusals) {
      say(`  ${R}LOST${X} ${String(count)} answers refused with ${B}${code}${X}`);
    }
  }
  healthy = report('everyone answers at once', answerTimings, 3000) && healthy;

  say(
    `  ${D}all ${String(joined)} answers took${X} ${ms(answerWall)} ` +
      `${D}(${(joined / (answerWall / 1000)).toFixed(0)} answers a second)${X}`,
  );
  say(
    `  ${D}the presenter screen settled${X} ${ms(settled)} ${D}after the last answer, having` +
      ` received${X} ${String(resultsSeen)} ${D}updates${X}`,
  );

  healthy = settled < 3000 && healthy;

  /* ---------------- a quiz, which also scores and ranks ---------------- */

  await new Promise<void>((resolve) => {
    presenter.emit('presenter:goto', { slideId: quizSlide.id }, () => {
      resolve();
    });
  });

  resultsSeen = 0;
  leaderboardSeen = 0;
  lastEvent = 0;

  const refusals = new Map<string, number>();

  const quizResults = await Promise.all(
    phones.map(async (socket, i) => {
      const started = performance.now();
      const ack = await new Promise<AckResult>((resolve) => {
        socket.emit(
          'participant:answer',
          {
            slideId: quizSlide.id,
            payload: { optionIds: [i % 2 === 0 ? 'o1' : 'o2'] },
            clientMsgId: `q-${String(stamp)}-${String(i)}`,
          },
          resolve,
        );
      });

      if (!ack.ok) refusals.set(ack.code, (refusals.get(ack.code) ?? 0) + 1);
      return performance.now() - started;
    }),
  );

  const quizTimings = quizResults;

  /*
   * An answer refused under load is worse than a slow one: the person
   * tapped, saw nothing, and their answer is not in the result.
   */
  if (refusals.size > 0) {
    healthy = false;
    for (const [code, count] of refusals) {
      say(`  ${R}LOST${X} ${String(count)} answers refused with ${B}${code}${X}`);
    }
  }

  const quizSettled = await settle();

  healthy = report('everyone answers a quiz at once', quizTimings, 4000) && healthy;
  say(
    `  ${D}the presenter screen settled${X} ${ms(quizSettled)} ${D}after the last answer, having` +
      ` received${X} ${String(resultsSeen)} ${D}tally and${X} ${String(leaderboardSeen)}` +
      ` ${D}leaderboard updates${X}`,
  );

  healthy = quizSettled < 4000 && healthy;

  /* ---------------- moving the room on ---------------- */

  const slideTimings: number[] = [];
  for (const target of [wordSlide.id, quizSlide.id, wordSlide.id]) {
    const started = performance.now();
    await new Promise<void>((resolve) => {
      presenter.emit('presenter:goto', { slideId: target }, () => {
        resolve();
      });
    });
    slideTimings.push(performance.now() - started);
  }

  healthy = report('moving everyone to the next slide', slideTimings, 2000) && healthy;

  /* ---------------- what the presenter waits for ---------------- */

  const leaderboardTimings: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    await new Promise<void>((resolve) => {
      presenter.emit('presenter:join', { sessionId: session.id }, () => {
        resolve();
      });
    });
    leaderboardTimings.push(performance.now() - started);
  }

  healthy = report('a presenter screen reconnecting', leaderboardTimings, 2000) && healthy;

  /* ---------------- tidy up ---------------- */

  for (const socket of phones) socket.close();
  presenter.close();

  await api(`/sessions/${session.id}/end`, {}, token);

  await db.delete(users).where(and(eq(users.email, email), like(users.email, '%@example.test')));
  await disconnectDb();

  say(
    `\n  ${healthy ? `${G}${B}The room keeps up.${X}` : `${Y}${B}Something is too slow above.${X}`}\n`,
  );

  process.exit(healthy ? 0 : 1);
}

main().catch(async (err: unknown) => {
  say(`\n${R}${B}The run itself failed${X} ${String(err)}`);
  say(`${D}Is the server running? npm run dev${X}\n`);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
