import type { SlideKind } from './kinds.js';

/**
 * Quiz scoring.
 *
 * Two rules decide every score, and both exist to keep a room engaged:
 *
 *   1. A wrong answer scores nothing. Partial credit for a guess makes the
 *      leaderboard meaningless.
 *   2. A correct answer scores more the faster it arrives, between a floor
 *      and a ceiling. Without the speed component the first ten people to
 *      answer are indistinguishable from the last ten, and the room stops
 *      racing; with too steep a curve, one slow answer ends someone's
 *      session and they disengage. The floor is what keeps them playing.
 *
 * This lives in shared because the presenter recomputes a leaderboard
 * locally as answers stream in, and two implementations would eventually
 * disagree about who won — in front of the people who played.
 */

export interface ScoringConfig {
  /** Awarded for an instant correct answer. */
  pointsMax: number;
  /** Awarded for a correct answer that arrives as the clock runs out. */
  pointsMin: number;
  /** The countdown length, in seconds. */
  countdownSeconds: number;
}

export interface ScoreResult {
  correct: boolean;
  points: number;
  /** 0 when instant, 1 at the end of the countdown. */
  speedFraction: number;
}

/** What the participant sent, reduced to what scoring needs. */
export interface ScorableAnswer {
  kind: SlideKind;
  payload: unknown;
  elapsedMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Normalises a typed answer before comparing it.
 *
 * Someone who types "  The Great Gatsby " has answered correctly, and a quiz
 * that says otherwise feels broken rather than strict.
 */
function normalise(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      // Strip accents, so "cafe" matches "café".
      .replace(/[̀-ͯ]/g, '')
      .replace(/[.,!?;:'"()]/g, '')
      .replace(/\s+/g, ' ')
  );
}

/** Points for a correct answer, scaled by how quickly it arrived. */
export function pointsFor(
  elapsedMs: number,
  config: ScoringConfig,
): {
  points: number;
  speedFraction: number;
} {
  const windowMs = Math.max(config.countdownSeconds, 1) * 1000;

  // Clamped: a clock that started late, or a device with a skewed clock,
  // must never produce points above the maximum or below the minimum.
  const fraction = Math.min(Math.max(elapsedMs / windowMs, 0), 1);

  const span = config.pointsMax - config.pointsMin;
  const points = Math.round(config.pointsMax - span * fraction);

  return { points, speedFraction: fraction };
}

/**
 * Scores one answer against a slide's configuration.
 *
 * Returns zero points for anything that is not a quiz kind, rather than
 * throwing: a deck mixes quiz and non-quiz slides freely, and the caller
 * should not have to check first.
 */
export function scoreAnswer(answer: ScorableAnswer, config: Record<string, unknown>): ScoreResult {
  const scoring: ScoringConfig = {
    pointsMax: typeof config.pointsMax === 'number' ? config.pointsMax : 1000,
    pointsMin: typeof config.pointsMin === 'number' ? config.pointsMin : 500,
    countdownSeconds: typeof config.countdownSeconds === 'number' ? config.countdownSeconds : 20,
  };

  const correct = isCorrect(answer, config);

  if (!correct) return { correct: false, points: 0, speedFraction: 1 };

  const { points, speedFraction } = pointsFor(answer.elapsedMs, scoring);
  return { correct: true, points, speedFraction };
}

/** Whether the answer matches the slide's correct answer. */
function isCorrect(answer: ScorableAnswer, config: Record<string, unknown>): boolean {
  const payload = asRecord(answer.payload);
  if (!payload) return false;

  switch (answer.kind) {
    case 'quiz_select': {
      const options = Array.isArray(config.options)
        ? (config.options as { id: string; correct?: boolean }[])
        : [];

      const correctIds = options.filter((o) => o.correct === true).map((o) => o.id);
      if (correctIds.length === 0) return false;

      const chosen = strings(payload.optionIds);
      if (chosen.length === 0) return false;

      // Every correct option and nothing else. A question with two correct
      // answers is not satisfied by picking one of them.
      return chosen.length === correctIds.length && correctIds.every((id) => chosen.includes(id));
    }

    case 'quiz_type': {
      const typed = typeof payload.text === 'string' ? normalise(payload.text) : '';
      if (typed === '') return false;

      // Several spellings may be accepted; the author lists them.
      const accepted = [
        ...(typeof config.correctText === 'string' ? [config.correctText] : []),
        ...strings(config.acceptedAnswers),
      ].map(normalise);

      return accepted.includes(typed);
    }

    case 'quiz_order': {
      const submitted = strings(payload.order);
      const correctOrder = strings(config.correctOrder);

      if (correctOrder.length === 0 || submitted.length !== correctOrder.length) return false;
      return submitted.every((id, i) => id === correctOrder[i]);
    }

    case 'quiz_match': {
      const matches = asRecord(payload.matches);
      const pairs = Array.isArray(config.pairs)
        ? (config.pairs as { id: string; right: string }[])
        : [];

      if (!matches || pairs.length === 0) return false;

      return pairs.every((pair) => {
        const given = matches[pair.id];
        return typeof given === 'string' && normalise(given) === normalise(pair.right);
      });
    }

    default:
      // Not a quiz slide, so there is nothing to be right about.
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* Leaderboard                                                         */
/* ------------------------------------------------------------------ */

export interface LeaderboardEntry {
  participantId: string;
  displayName: string;
  score: number;
  correctCount: number;
  answeredCount: number;
  /** 1-based, with ties sharing a position. */
  rank: number;
  /** Movement since the previous slide; null on the first. */
  change: number | null;
}

export interface ScoreRow {
  participantId: string;
  displayName: string;
  points: number;
  correct: boolean;
}

/**
 * Builds the standings.
 *
 * Ties share a rank and the next rank skips accordingly — two people on
 * second place are both second, and the next is fourth. Ranking them
 * arbitrarily would be visibly unfair to a room that can see the scores.
 */
export function buildLeaderboard(
  rows: ScoreRow[],
  previous?: Map<string, number>,
): LeaderboardEntry[] {
  const totals = new Map<
    string,
    { displayName: string; score: number; correctCount: number; answeredCount: number }
  >();

  for (const row of rows) {
    const entry = totals.get(row.participantId) ?? {
      displayName: row.displayName,
      score: 0,
      correctCount: 0,
      answeredCount: 0,
    };

    entry.score += row.points;
    entry.answeredCount += 1;
    if (row.correct) entry.correctCount += 1;
    // A late name change should show, so the most recent one wins.
    if (row.displayName) entry.displayName = row.displayName;

    totals.set(row.participantId, entry);
  }

  const sorted = [...totals.entries()].sort((a, b) => {
    if (b[1].score !== a[1].score) return b[1].score - a[1].score;
    // A tie on points goes to whoever got more right, then alphabetically so
    // the order is stable between renders rather than jittering.
    if (b[1].correctCount !== a[1].correctCount) return b[1].correctCount - a[1].correctCount;
    return a[1].displayName.localeCompare(b[1].displayName);
  });

  const entries: LeaderboardEntry[] = [];
  let lastScore: number | null = null;
  let lastRank = 0;

  sorted.forEach(([participantId, totals_], index) => {
    const rank = totals_.score === lastScore ? lastRank : index + 1;
    lastScore = totals_.score;
    lastRank = rank;

    const before = previous?.get(participantId);

    entries.push({
      participantId,
      displayName: totals_.displayName || 'Anonymous',
      score: totals_.score,
      correctCount: totals_.correctCount,
      answeredCount: totals_.answeredCount,
      rank,
      // Positive means they climbed, which is how a room reads an arrow.
      change: before === undefined ? null : before - rank,
    });
  });

  return entries;
}
