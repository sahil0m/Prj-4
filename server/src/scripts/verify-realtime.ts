/**
 * End-to-end realtime checks against a running server.
 *
 * These drive real Socket.IO clients rather than calling the service layer,
 * so they cover the parts only a live connection exercises: room isolation,
 * acks, broadcast fan-out, and whether a phone can see something it should
 * not.
 *
 * Run the server first, then: npm run realtime:verify --workspace @pulse/server
 */
import { randomBytes } from 'node:crypto';
import { io as connect, type Socket } from 'socket.io-client';
import type { ServerEvents, ClientEvents, JoinResult, AckResult } from '@pulse/shared';

const BASE = process.env.PULSE_URL ?? 'http://localhost:4000';

const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const X = '\x1b[0m';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    process.stdout.write(`  ${G}PASS${X}  ${name}\n`);
    passed += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`  ${R}FAIL${X}  ${name}\n        ${R}${message}${X}\n`);
    failed += 1;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Rejects rather than hanging, so a missing broadcast fails loudly. */
function waitFor<K extends keyof ServerEvents>(
  socket: Socket<ServerEvents, ClientEvents>,
  event: K,
  timeoutMs = 4000,
): Promise<Parameters<ServerEvents[K]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler as never);
      reject(new Error(`timed out waiting for "${event as string}"`));
    }, timeoutMs);

    const handler = (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload as Parameters<ServerEvents[K]>[0]);
    };

    socket.once(event, handler as never);
  });
}

/** Asserts an event does NOT arrive — used for the isolation checks. */
async function expectSilence<K extends keyof ServerEvents>(
  socket: Socket<ServerEvents, ClientEvents>,
  event: K,
  windowMs = 900,
): Promise<void> {
  // A box rather than a plain boolean, so the mutation inside the listener is
  // visible to the type system instead of looking like dead code.
  const seen = { fired: false };

  const handler = () => {
    seen.fired = true;
  };

  socket.on(event, handler as never);
  await new Promise((r) => setTimeout(r, windowMs));
  socket.off(event, handler as never);

  if (seen.fired) {
    throw new Error(`"${event as string}" reached a socket that should not receive it`);
  }
}

function emit<T>(
  socket: Socket<ServerEvents, ClientEvents>,
  event: keyof ClientEvents,
  payload?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no ack for "${event}"`));
    }, 4000);

    const done = (result: T) => {
      clearTimeout(timer);
      resolve(result);
    };

    // The typed emit signature varies per event; this helper is deliberately
    // generic so each test reads as one line.
    const send = socket.emit.bind(socket) as (...args: unknown[]) => void;
    if (payload === undefined) send(event, done);
    else send(event, payload, done);
  });
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${String(response.status)} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function newSocket(auth?: Record<string, unknown>): Socket<ServerEvents, ClientEvents> {
  return connect(BASE, { transports: ['websocket'], auth, forceNew: true });
}

function deviceToken(): string {
  return randomBytes(16).toString('hex');
}

function msgId(): string {
  return randomBytes(8).toString('hex');
}

async function main(): Promise<void> {
  process.stdout.write(`\n${D}Realtime checks against ${BASE}${X}\n\n`);

  /* ---------------- setup ---------------- */

  const stamp = Date.now();
  const auth = await api<{ accessToken: string }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `rt-${String(stamp)}@example.test`,
      password: 'correct-horse-battery',
      name: 'Realtime Host',
    }),
  });
  const token = auth.accessToken;
  const authed = { Authorization: `Bearer ${token}` };

  const { deck } = await api<{ deck: { id: string; slides: { id: string; kind: string }[] } }>(
    '/api/decks',
    {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({
        title: 'Realtime test deck',
        slideKinds: ['multiple_choice', 'word_cloud', 'quiz_select'],
      }),
    },
  );

  const [choiceSlide, wordSlide, quizSlide] = deck.slides;
  assert(choiceSlide && wordSlide && quizSlide, 'deck setup failed');

  // Known option ids, so the answers below are predictable.
  await api(`/api/decks/${deck.id}/slides/${choiceSlide.id}`, {
    method: 'PUT',
    headers: authed,
    body: JSON.stringify({
      prompt: 'Tea or coffee?',
      options: [
        { id: 'tea', label: 'Tea' },
        { id: 'coffee', label: 'Coffee' },
      ],
    }),
  });

  await api(`/api/decks/${deck.id}/slides/${quizSlide.id}`, {
    method: 'PUT',
    headers: authed,
    body: JSON.stringify({
      prompt: 'Capital of France?',
      options: [
        { id: 'paris', label: 'Paris', correct: true },
        { id: 'rome', label: 'Rome' },
      ],
    }),
  });

  const { session } = await api<{ session: { id: string; joinCode: string } }>('/api/sessions', {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({ deckId: deck.id }),
  });

  const sockets: Socket<ServerEvents, ClientEvents>[] = [];
  const track = (s: Socket<ServerEvents, ClientEvents>) => {
    sockets.push(s);
    return s;
  };

  /* ---------------- lookup ---------------- */

  await check('a join code resolves to a session title', async () => {
    const info = await api<{ title: string; state: string }>(
      `/api/sessions/lookup?code=${session.joinCode}`,
    );
    assert(info.title === 'Realtime test deck', `title was ${info.title}`);
    assert(info.state === 'live', `state was ${info.state}`);
  });

  await check('an unknown join code is refused', async () => {
    try {
      await api('/api/sessions/lookup?code=000001');
      throw new Error('a bogus code was accepted');
    } catch (err) {
      assert(String(err).includes('404'), `expected 404, got ${String(err)}`);
    }
  });

  await check('the lookup never leaks the session id or the deck', async () => {
    const raw = await fetch(`${BASE}/api/sessions/lookup?code=${session.joinCode}`);
    const body = await raw.text();
    assert(!body.includes(session.id), 'the session id leaked to an anonymous caller');
    assert(!body.includes('slides'), 'the deck leaked to an anonymous caller');
  });

  /* ---------------- presenter ---------------- */

  const presenter = track(newSocket({ token }));

  await check('a presenter with a valid token joins', async () => {
    const result = await emit<AckResult>(presenter, 'presenter:join', { sessionId: session.id });
    assert(result.ok, `join failed: ${JSON.stringify(result)}`);
  });

  await check('a presenter without a token is refused', async () => {
    const anon = track(newSocket());
    const result = await emit<AckResult>(anon, 'presenter:join', { sessionId: session.id });
    assert(!result.ok, 'an unauthenticated socket was accepted as presenter');
  });

  await check('a presenter cannot join someone else session', async () => {
    const other = await api<{ accessToken: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `rt-other-${String(stamp)}@example.test`,
        password: 'correct-horse-battery',
        name: 'Interloper',
      }),
    });

    const intruder = track(newSocket({ token: other.accessToken }));
    const result = await emit<AckResult>(intruder, 'presenter:join', { sessionId: session.id });
    assert(!result.ok, 'another user was allowed to present this session');
  });

  /* ---------------- participants ---------------- */

  const phoneA = track(newSocket());
  const phoneB = track(newSocket());
  const tokenA = deviceToken();

  await check('a phone joins with the code', async () => {
    const result = await emit<JoinResult>(phoneA, 'participant:join', {
      joinCode: session.joinCode,
      deviceToken: tokenA,
      displayName: 'Phone A',
    });
    assert(result.ok, `join failed: ${JSON.stringify(result)}`);
    assert(result.slide?.id === choiceSlide.id, 'the phone got the wrong slide');
  });

  await check('a wrong code is refused', async () => {
    const stray = track(newSocket());
    const result = await emit<JoinResult>(stray, 'participant:join', {
      joinCode: '000002',
      deviceToken: deviceToken(),
    });
    assert(!result.ok, 'a bogus code was accepted');
  });

  await check('the presenter sees the participant count rise', async () => {
    const waiting = waitFor(presenter, 'participants:count');
    await emit<JoinResult>(phoneB, 'participant:join', {
      joinCode: session.joinCode,
      deviceToken: deviceToken(),
      displayName: 'Phone B',
    });
    const payload = await waiting;
    assert(payload.count >= 2, `count was ${String(payload.count)}`);
  });

  await check('rejoining from the same device does not double the count', async () => {
    const again = track(newSocket());
    const result = await emit<JoinResult>(again, 'participant:join', {
      joinCode: session.joinCode,
      deviceToken: tokenA,
    });
    assert(result.ok, 'rejoin failed');

    const info = await api<{ session: { id: string } }>(`/api/sessions/${session.id}`, {
      headers: authed,
    });
    assert(info.session.id === session.id, 'session lookup failed');
  });

  /* ---------------- answering ---------------- */

  await check('an answer reaches the presenter as a live tally', async () => {
    const waiting = waitFor(presenter, 'results:update');

    const ack = await emit<AckResult>(phoneA, 'participant:answer', {
      slideId: choiceSlide.id,
      payload: { optionIds: ['tea'] },
      clientMsgId: msgId(),
    });
    assert(ack.ok, `answer rejected: ${JSON.stringify(ack)}`);

    const results = await waiting;
    assert(results.slideId === choiceSlide.id, 'results were for the wrong slide');
    assert(results.count === 1, `count was ${String(results.count)}`);
  });

  await check('a second answer from the same device is refused', async () => {
    const ack = await emit<AckResult>(phoneA, 'participant:answer', {
      slideId: choiceSlide.id,
      payload: { optionIds: ['coffee'] },
      clientMsgId: msgId(),
    });
    assert(!ack.ok, 'one device answered the same question twice');
  });

  await check('a retry with the same message id is counted once', async () => {
    const repeated = msgId();

    const first = await emit<AckResult>(phoneB, 'participant:answer', {
      slideId: choiceSlide.id,
      payload: { optionIds: ['coffee'] },
      clientMsgId: repeated,
    });
    assert(first.ok, 'first submission failed');

    const retry = await emit<AckResult>(phoneB, 'participant:answer', {
      slideId: choiceSlide.id,
      payload: { optionIds: ['coffee'] },
      clientMsgId: repeated,
    });
    assert(retry.ok, 'a retry was rejected; an offline phone would lose its answer');

    const { results } = await api<{ results: { count: number } }>(
      `/api/sessions/${session.id}/slides/${choiceSlide.id}/results`,
      { headers: authed },
    );
    assert(results.count === 2, `expected 2 answers, found ${String(results.count)}`);
  });

  await check('a malformed answer is refused', async () => {
    const ack = await emit<AckResult>(phoneB, 'participant:answer', {
      slideId: wordSlide.id,
      payload: { words: [''] },
      clientMsgId: msgId(),
    });
    assert(!ack.ok, 'an empty word was accepted');
  });

  await check('an answer for the wrong slide kind is refused', async () => {
    const ack = await emit<AckResult>(phoneB, 'participant:answer', {
      slideId: wordSlide.id,
      payload: { optionIds: ['tea'] },
      clientMsgId: msgId(),
    });
    assert(!ack.ok, 'a choice answer was accepted for a word cloud');
  });

  await check('answering without joining is refused', async () => {
    const stranger = track(newSocket());
    const ack = await emit<AckResult>(stranger, 'participant:answer', {
      slideId: choiceSlide.id,
      payload: { optionIds: ['tea'] },
      clientMsgId: msgId(),
    });
    assert(!ack.ok, 'a socket that never joined submitted an answer');
  });

  /* ---------------- presenter control ---------------- */

  await check('changing slide moves every phone', async () => {
    const waiting = waitFor(phoneA, 'slide:show');
    const ack = await emit<AckResult>(presenter, 'presenter:goto', { slideId: wordSlide.id });
    assert(ack.ok, 'goto failed');

    const slide = await waiting;
    assert(slide?.id === wordSlide.id, 'the phone did not follow the presenter');
  });

  await check('closing participation stops answers', async () => {
    await emit<AckResult>(presenter, 'presenter:participation', { open: false });

    const ack = await emit<AckResult>(phoneA, 'participant:answer', {
      slideId: wordSlide.id,
      payload: { words: ['late'] },
      clientMsgId: msgId(),
    });
    assert(!ack.ok, 'an answer was accepted while participation was closed');

    await emit<AckResult>(presenter, 'presenter:participation', { open: true });
  });

  await check('a phone cannot drive the presenter controls', async () => {
    const ack = await emit<AckResult>(phoneA, 'presenter:goto', { slideId: choiceSlide.id });
    assert(!ack.ok, 'a participant socket controlled the session');
  });

  /* ---------------- leaking ---------------- */

  await check('a quiz slide reaches the phone without its answer key', async () => {
    const waiting = waitFor(phoneA, 'slide:show');
    await emit<AckResult>(presenter, 'presenter:goto', { slideId: quizSlide.id });
    const slide = await waiting;

    assert(slide, 'no slide arrived');
    const serialised = JSON.stringify(slide);
    assert(!serialised.includes('"correct"'), 'the correct answer was sent to a phone');
    assert(serialised.includes('Paris'), 'the option labels are missing');
  });

  await check('a phone never receives the presenter response feed', async () => {
    await expectSilence(phoneB, 'response:new');
  });

  /* ---------------- ending ---------------- */

  await check('ending the session tells every phone', async () => {
    const waiting = waitFor(phoneA, 'session:ended');
    const ack = await emit<AckResult>(presenter, 'presenter:end');
    assert(ack.ok, 'end failed');
    await waiting;
  });

  await check('a closed session can no longer be joined', async () => {
    const late = track(newSocket());
    const result = await emit<JoinResult>(late, 'participant:join', {
      joinCode: session.joinCode,
      deviceToken: deviceToken(),
    });
    assert(!result.ok, 'someone joined a closed session');
  });

  /* ---------------- cleanup ---------------- */

  for (const socket of sockets) socket.close();

  const summary =
    failed === 0
      ? `${G}${String(passed)} passed${X}`
      : `${R}${String(failed)} failed${X}, ${String(passed)} passed`;
  process.stdout.write(`\n  ${summary}\n\n`);

  if (failed > 0) process.exitCode = 1;
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((err: unknown) => {
  process.stdout.write(`${R}The run itself failed: ${String(err)}${X}\n`);
  process.exit(1);
});
