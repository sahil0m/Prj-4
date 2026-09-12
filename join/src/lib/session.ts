import { io, type Socket } from 'socket.io-client';
import type {
  ServerEvents,
  ClientEvents,
  SessionState,
  ParticipantSlide,
  SlideResults,
  JoinResult,
  AckResult,
} from '@pulse/shared';

/**
 * The participant's connection.
 *
 * Written for a phone on bad wifi, which is the normal case rather than the
 * edge case:
 *
 *   - The device token is generated once and kept, so a refresh rejoins as
 *     the same person rather than becoming a second voter.
 *   - Answers are queued and retried. A tap that happens during a dropped
 *     connection must not be silently lost — the person tapped, they believe
 *     they voted, and they will not tap again.
 *   - Every answer carries a message id generated before sending, so a retry
 *     is recognised by the server and counted exactly once.
 */

const DEVICE_KEY = 'pulse.device';
const QUEUE_KEY = 'pulse.queue';

/* ------------------------------------------------------------------ */
/* Device identity                                                     */
/* ------------------------------------------------------------------ */

/**
 * A random id for this browser. It is meaningless outside a session and is
 * never derived from anything about the person.
 */
export function deviceToken(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing && existing.length >= 16) return existing;

    const fresh = randomId(32);
    localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    // Private browsing can refuse storage. A per-tab id still works for the
    // length of the session; only a refresh would count as a new person.
    return randomId(32);
  }
}

function randomId(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newMessageId(): string {
  return randomId(16);
}

/* ------------------------------------------------------------------ */
/* Offline queue                                                       */
/* ------------------------------------------------------------------ */

interface QueuedAnswer {
  slideId: string;
  payload: unknown;
  clientMsgId: string;
  queuedAt: number;
}

/**
 * Answers waiting to reach the server.
 *
 * Persisted, so an answer survives the phone locking, the tab being
 * backgrounded and evicted, or the browser being closed and reopened
 * mid-session.
 */
function readQueue(): QueuedAnswer[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedAnswer[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedAnswer[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Out of storage or refused; the in-memory queue still drains this visit.
  }
}

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface SessionHandlers {
  onState: (state: SessionState) => void;
  onSlide: (slide: ParticipantSlide | null) => void;
  onResults: (results: SlideResults) => void;
  onEnded: () => void;
  onStatus: (status: ConnectionStatus) => void;
  /** Fires when a queued answer finally lands, so the UI can confirm it. */
  onAnswerAccepted: (slideId: string) => void;
}

export class SessionConnection {
  private socket: Socket<ServerEvents, ClientEvents> | null = null;
  private queue: QueuedAnswer[] = readQueue();
  private joinCode = '';
  private displayName: string | undefined;
  private draining = false;

  constructor(private readonly handlers: SessionHandlers) {}

  /** True when there is an answer the server has not confirmed. */
  get pendingCount(): number {
    return this.queue.length;
  }

  async join(joinCode: string, displayName?: string): Promise<JoinResult> {
    this.joinCode = joinCode;
    this.displayName = displayName;

    const socket: Socket<ServerEvents, ClientEvents> = io({
      transports: ['websocket', 'polling'],
      // Socket.IO's own backoff, capped so a phone that wakes in a pocket
      // does not sit for a minute before trying again.
      reconnectionDelay: 700,
      reconnectionDelayMax: 5000,
      timeout: 12_000,
    });

    this.socket = socket;
    this.handlers.onStatus('connecting');

    socket.on('connect', () => {
      this.handlers.onStatus('connected');
      // A reconnect must re-join before anything else: the server keeps no
      // memory of which socket belonged to whom.
      void this.rejoin();
    });

    socket.on('disconnect', () => {
      this.handlers.onStatus('reconnecting');
    });

    socket.io.on('reconnect_attempt', () => {
      this.handlers.onStatus('reconnecting');
    });

    socket.io.on('error', () => {
      this.handlers.onStatus('offline');
    });

    socket.on('session:state', (state) => {
      this.handlers.onState(state);
    });
    socket.on('slide:show', (slide) => {
      this.handlers.onSlide(slide);
    });
    socket.on('results:update', (results) => {
      this.handlers.onResults(results);
    });
    socket.on('session:ended', () => {
      this.handlers.onEnded();
    });

    return new Promise<JoinResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, code: 'timeout', message: 'Could not reach the session. Try again.' });
      }, 12_000);

      socket.once('connect', () => {
        socket.emit(
          'participant:join',
          { joinCode, deviceToken: deviceToken(), displayName },
          (result) => {
            clearTimeout(timer);
            if (result.ok) void this.drain();
            resolve(result);
          },
        );
      });

      socket.once('connect_error', () => {
        clearTimeout(timer);
        resolve({
          ok: false,
          code: 'offline',
          message: 'No connection. Check your internet and try again.',
        });
      });
    });
  }

  /** Silent re-join after a reconnect; the UI never sees it. */
  private async rejoin(): Promise<void> {
    if (!this.socket || !this.joinCode) return;

    await new Promise<void>((resolve) => {
      this.socket?.emit(
        'participant:join',
        { joinCode: this.joinCode, deviceToken: deviceToken(), displayName: this.displayName },
        (result) => {
          if (result.ok) {
            this.handlers.onState(result.session);
            this.handlers.onSlide(result.slide);
          }
          resolve();
        },
      );
    });

    await this.drain();
  }

  /**
   * Sends an answer, or queues it if the send fails.
   *
   * Resolves as soon as the answer is safely recorded — either accepted by
   * the server or written to the queue. The person has done their part; the
   * UI should say so rather than spinning while the network struggles.
   */
  async answer(slideId: string, payload: unknown): Promise<AckResult> {
    const item: QueuedAnswer = {
      slideId,
      payload,
      clientMsgId: newMessageId(),
      queuedAt: Date.now(),
    };

    if (!this.socket?.connected) {
      this.enqueue(item);
      return { ok: true };
    }

    const result = await this.send(item);

    if (!result.ok && isRetryable(result.code)) {
      this.enqueue(item);
      return { ok: true };
    }

    return result;
  }

  private send(item: QueuedAnswer): Promise<AckResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, code: 'timeout', message: 'The network is slow.' });
      }, 8000);

      this.socket?.emit(
        'participant:answer',
        { slideId: item.slideId, payload: item.payload, clientMsgId: item.clientMsgId },
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      );
    });
  }

  private enqueue(item: QueuedAnswer): void {
    this.queue.push(item);
    writeQueue(this.queue);
  }

  /** Pushes queued answers through, oldest first, stopping on a failure. */
  private async drain(): Promise<void> {
    if (this.draining || this.queue.length === 0) return;
    this.draining = true;

    try {
      while (this.queue.length > 0 && this.socket?.connected) {
        const item = this.queue[0];
        if (!item) break;

        const result = await this.send(item);

        // A rejection that will never succeed — a closed session, an answer
        // that is no longer valid — must leave the queue, or it blocks
        // everything behind it forever.
        if (result.ok || !isRetryable(result.code)) {
          this.queue.shift();
          writeQueue(this.queue);
          if (result.ok) this.handlers.onAnswerAccepted(item.slideId);
        } else {
          break;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  reaction(emoji: 'clap' | 'heart' | 'laugh' | 'wow' | 'thumbsUp'): void {
    this.socket?.emit('participant:reaction', { emoji });
  }

  question(text: string): Promise<AckResult> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve({ ok: false, code: 'offline', message: 'No connection.' });
        return;
      }
      this.socket.emit('participant:question', { text, clientMsgId: newMessageId() }, resolve);
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

/** Errors worth retrying, as opposed to ones that will always fail. */
function isRetryable(code: string): boolean {
  return code === 'timeout' || code === 'offline' || code === 'internal' || code === 'rate_limited';
}

/** Clears a finished session's leftovers without touching the device id. */
export function clearQueue(): void {
  try {
    localStorage.removeItem(QUEUE_KEY);
  } catch {
    // Nothing to do; the queue is already unreachable.
  }
}
