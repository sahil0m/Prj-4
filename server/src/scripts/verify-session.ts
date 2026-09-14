/**
 * A whole session, driven the way a room drives one.
 *
 * The presenter half goes over HTTP and the phone half over a real socket,
 * against a running server. Every check here exists because the thing it
 * checks was once reported as broken from an actual room:
 *
 *   - the deck's theme reached neither screen, so a styled deck looked
 *     like the default on the phone everyone was holding
 *   - a deck with a Q&A slide gave the audience no way to ask anything
 *   - the join address on the projector was one of several the machine
 *     has, and not the one the phones could reach
 *   - a wrong answer showed "0 points, 1st place"
 *   - the exports were a mix of formats
 *
 * Run the server first, then:
 *   npm run session:verify --workspace @pulse/server
 */
import { io, type Socket } from 'socket.io-client';
import { and, eq, like } from 'drizzle-orm';
import { connectDb, disconnectDb, db } from '../lib/db.js';
import { users } from '../db/schema.js';
import type { JoinResult, AckResult, DeckThemeLike } from '@pulse/shared';

const BASE = process.env.PULSE_URL ?? 'http://localhost:4000';
const API = `${BASE}/api`;

const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    process.stdout.write(`  ${G}PASS${X}  ${name}\n`);
    return;
  }
  failed += 1;
  process.stdout.write(`  ${R}FAIL${X}  ${name}\n${detail ? `        ${D}${detail}${X}\n` : ''}`);
}

interface ApiResult<T> {
  status: number;
  body: T;
}

async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<ApiResult<T>> {
  const { method = 'GET', body, token } = options;

  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  return { status: response.status, body: (text === '' ? null : JSON.parse(text)) as T };
}

interface Slide {
  id: string;
  kind: string;
}
interface Deck {
  id: string;
  slides: Slide[];
}
interface LiveSession {
  id: string;
  joinCode: string;
  joinUrls: string[];
  theme?: DeckThemeLike;
}

const ACCENT = '#ff7a1a';

async function main(): Promise<void> {
  process.stdout.write(`\n${B}A session end to end, against ${BASE}${X}\n\n`);

  const stamp = Date.now();
  const email = `session-verify-${String(stamp)}@example.test`;

  /* ---------------- the presenter's side ---------------- */

  const registered = await api<{ accessToken: string }>('/auth/register', {
    method: 'POST',
    body: { email, password: 'a-strong-passphrase-here', name: 'Session Verify' },
  });

  if (registered.status !== 201) {
    throw new Error(`could not register a presenter: ${String(registered.status)}`);
  }

  const token = registered.body.accessToken;

  const created = await api<{ deck: Deck }>('/decks', {
    method: 'POST',
    token,
    body: { title: 'Session verification', slideKinds: ['quiz_select', 'qa'] },
  });
  const deck = created.body.deck;

  // A theme an author chose, which both screens have to honour.
  await api('/decks/' + deck.id, {
    method: 'PATCH',
    token,
    body: { theme: { accent: ACCENT, background: '#fff8f0', mode: 'light' } },
  });

  const quizSlide = deck.slides.find((slide) => slide.kind === 'quiz_select');
  if (!quizSlide) throw new Error('the quiz slide was not created');

  await api(`/decks/${deck.id}/slides/${quizSlide.id}`, {
    method: 'PUT',
    token,
    body: {
      prompt: 'Which join returns all records from both tables?',
      options: [
        { id: 'a', label: 'INNER JOIN', correct: false },
        { id: 'b', label: 'FULL OUTER JOIN', correct: true },
      ],
    },
  });

  const started = await api<{ session: LiveSession }>('/sessions', {
    method: 'POST',
    token,
    body: { deckId: deck.id },
  });
  const session = started.body.session;

  check(
    'the session offers every address this machine has',
    Array.isArray(session.joinUrls) && session.joinUrls.length > 0,
    JSON.stringify(session.joinUrls),
  );
  check(
    'the session carries the deck theme',
    session.theme?.accent === ACCENT,
    JSON.stringify(session.theme),
  );

  /* ---------------- the phone's side ---------------- */

  const phone: Socket = io(BASE, { transports: ['websocket'], forceNew: true });

  const emit = <T>(event: string, payload: unknown): Promise<T> =>
    new Promise((resolve) => {
      phone.emit(event, payload, resolve);
    });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the phone could not connect'));
    }, 8000);
    phone.on('connect', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const joined = await emit<JoinResult>('participant:join', {
    joinCode: session.joinCode,
    deviceToken: `verify-${String(stamp)}`,
    displayName: 'Sahil',
  });

  check('the phone joins with the code', joined.ok, joined.ok ? '' : joined.message);

  if (joined.ok) {
    check(
      'the phone is given the deck theme',
      joined.theme?.accent === ACCENT,
      JSON.stringify(joined.theme),
    );
    check(
      'a deck with a Q&A slide lets the audience ask',
      joined.allowQuestions,
      `allowQuestions was ${String(joined.allowQuestions)}`,
    );
  }

  const asked = await emit<AckResult>('participant:question', {
    text: 'Can you go over that once more?',
    clientMsgId: `q-${String(stamp)}`,
  });
  check('the phone can send a question', asked.ok, asked.ok ? '' : asked.message);

  /*
   * Listening before answering: the result is sent immediately after the
   * acknowledgement, so a listener attached afterwards misses it.
   */
  const outcome = new Promise<{ correct: boolean; points: number; rank: number | null } | null>(
    (resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, 5000);
      phone.on(
        'quiz:result',
        (result: { correct: boolean; points: number; rank: number | null }) => {
          clearTimeout(timer);
          resolve(result);
        },
      );
    },
  );

  const answered = await emit<AckResult>('participant:answer', {
    slideId: quizSlide.id,
    payload: { optionIds: ['a'] },
    clientMsgId: `a-${String(stamp)}`,
  });
  check('the phone can answer', answered.ok, answered.ok ? '' : answered.message);

  // A phone still holding a slide whose options have changed.
  const stale = await emit<AckResult>('participant:answer', {
    slideId: quizSlide.id,
    payload: { optionIds: ['no-such-option'] },
    clientMsgId: `stale-${String(stamp)}`,
  });
  check(
    'an answer naming an option the slide does not have is refused',
    !stale.ok && stale.code === 'stale_slide',
    JSON.stringify(stale),
  );

  const result = await outcome;
  check(
    'a wrong answer scores nothing',
    result !== null && !result.correct && result.points === 0,
    JSON.stringify(result),
  );

  /* ---------------- getting the data out ---------------- */

  for (const [format, label] of [
    ['csv', 'answers'],
    ['statistics', 'statistics'],
    ['leaderboard', 'leaderboard'],
  ] as const) {
    const response = await fetch(`${API}/sessions/${session.id}/export?format=${format}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    const filename = response.headers.get('content-disposition') ?? '';

    check(
      `the ${label} export is a CSV file`,
      response.status === 200 && filename.includes('.csv') && text.includes(','),
      `status ${String(response.status)}, ${filename}`,
    );

    if (format === 'statistics') {
      check(
        'the statistics name each option and the size of the room',
        text.includes('FULL OUTER JOIN') && text.includes('People in session'),
        text.split('\r\n')[1] ?? '',
      );
    }
  }

  phone.close();
  await api(`/sessions/${session.id}/end`, { method: 'POST', token });

  /* ---------------- tidy up ---------------- */

  await connectDb();
  await db.delete(users).where(and(eq(users.email, email), like(users.email, '%@example.test')));
  await disconnectDb();

  process.stdout.write(
    `\n  ${passed > 0 ? G : D}${String(passed)} passed${X}` +
      (failed > 0 ? `   ${R}${B}${String(failed)} failed${X}` : '') +
      '\n\n',
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err: unknown) => {
  process.stderr.write(`\n${R}${B}The run itself failed${X}\n${String(err)}\n\n`);
  process.stderr.write(`${D}Is the server running? npm run dev${X}\n\n`);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
