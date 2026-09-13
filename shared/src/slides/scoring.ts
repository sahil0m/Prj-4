import type { SlideKind } from './kinds.js';

/**
 * Quiz scoring.
 *
 * Four rules decide every score, and each exists because its absence
 * produced a scoreboard nobody believed:
 *
 *   1. A wrong answer scores nothing. Partial credit for a guess makes the
 *      leaderboard meaningless.
 *   2. An answer after the clock expires scores nothing either. Clamping it
 *      to the minimum — which an earlier version did — meant someone
 *      answering at sixty seconds on a twenty-second question earned the
 *      same as someone who made it with a tenth of a second to spare. That
 *      rewards not trying.
 *   3. Speed pays, but on a curve rather than a straight line. Linearly,
 *      the first second and the tenth cost the same, so there is nothing to
 *      race for; the curve here keeps most of the points available early
 *      and then falls away, which is what makes a room hurry.
 *   4. A hard question is worth more. Every question counting the same
 *      means one that everybody got right carries as much weight as one
 *      only two people managed, and the final order stops reflecting who
 *      actually knew more.
 *
 * This lives in shared because the presenter recomputes a leaderboard
 * locally as answers stream in, and two implementations would eventually
 * disagree about who won — in front of the people who played.
 */

export interface ScoringConfig {
  /** Awarded for an instant correct answer. */
  pointsMax: number;
  /** The floor for a correct answer that arrives as the clock runs out. */
  pointsMin: number;
  /** The countdown length, in seconds. */
  countdownSeconds: number;
}

export interface ScoreResult {
  correct: boolean;
  points: number;
  /** 0 when instant, 1 at the end of the countdown. */
  speedFraction: number;
  /** True when the answer arrived after the clock expired. */
  tooLate: boolean;
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

/**
 * How much of the speed bonus survives after a given fraction of the clock.
 *
 * A quarter-power curve: half the time elapsed still leaves roughly 84% of
 * the bonus, and it falls away sharply only near the end. That keeps a room
 * racing for the opening seconds without making a thoughtful answer at
 * three-quarters time feel worthless.
 */
function speedCurve(fraction: number): number {
  return 1 - Math.pow(fraction, 4);
}

/** Points for a correct answer, scaled by how quickly it arrived. */
export function pointsFor(
  elapsedMs: number,
  config: ScoringConfig,
): {
  points: number;
  speedFraction: number;
  tooLate: boolean;
} {
  const windowMs = Math.max(config.countdownSeconds, 1) * 1000;

  // A negative elapsed time means a skewed device clock, not a prescient
  // participant; treated as instant rather than rejected.
  const elapsed = Math.max(elapsedMs, 0);

  // A small grace period, because a tap at the moment the clock hits zero
  // still has to travel. Being punished for the network is not the game.
  const graceMs = 750;

  if (elapsed > windowMs + graceMs) {
    return { points: 0, speedFraction: 1, tooLate: true };
  }

  const fraction = Math.min(elapsed / windowMs, 1);
  const span = config.pointsMax - config.pointsMin;

  const points = Math.round(config.pointsMin + span * speedCurve(fraction));

  return { points, speedFraction: fraction, tooLate: false };
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

  if (!correct) return { correct: false, points: 0, speedFraction: 1, tooLate: false };

  const { points, speedFraction, tooLate } = pointsFor(answer.elapsedMs, scoring);

  // Still recorded as correct even when it scored nothing: someone who knew
  // the answer but was slow should see that they knew it.
  return { correct: true, points, speedFraction, tooLate };
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
/* Difficulty                                                          */
/* ------------------------------------------------------------------ */

/**
 * A multiplier for how hard a question turned out to be.
 *
 * Measured from the room rather than declared by the author, because an
 * author is a poor judge of what their own audience will find hard. A
 * question nobody got is worth half again; one everybody got is worth
 * slightly less than face value.
 *
 * The range is deliberately narrow. A wide one would let a single obscure
 * question decide the whole contest, which feels arbitrary to a room that
 * answered nine others well.
 */
export function difficultyWeight(correctCount: number, answeredCount: number): number {
  // Too few answers to judge; treat it as average rather than inferring
  // difficulty from one person's luck.
  if (answeredCount < 3) return 1;

  const rate = correctCount / answeredCount;

  // 0.85 when everyone was right, 1.5 when nobody was.
  return Math.round((0.85 + (1 - rate) * 0.65) * 100) / 100;
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
  /** 0-100, rounded. What share of their answers were right. */
  accuracy: number;
  /** Mean seconds to answer, over correct answers only. */
  averageSeconds: number | null;
  /** The longest run of correct answers, in the order they were given. */
  bestStreak: number;
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
  /** Used for the average; ignored when the answer was wrong. */
  elapsedMs?: number;
  /** Orders a participant's answers, so a streak means something. */
  slideIndex?: number;
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
  interface Totals {
    displayName: string;
    score: number;
    correctCount: number;
    answeredCount: number;
    totalMs: number;
    timedCount: number;
    /** Kept in answer order so a streak can be measured. */
    sequence: { index: number; correct: boolean }[];
  }

  const totals = new Map<string, Totals>();

  for (const row of rows) {
    const entry = totals.get(row.participantId) ?? {
      displayName: row.displayName,
      score: 0,
      correctCount: 0,
      answeredCount: 0,
      totalMs: 0,
      timedCount: 0,
      sequence: [],
    };

    entry.score += row.points;
    entry.answeredCount += 1;
    if (row.correct) entry.correctCount += 1;

    // Only correct answers count towards the average: the time someone took
    // to be wrong says nothing useful about them.
    if (row.correct && typeof row.elapsedMs === 'number' && row.elapsedMs >= 0) {
      entry.totalMs += row.elapsedMs;
      entry.timedCount += 1;
    }

    entry.sequence.push({ index: row.slideIndex ?? entry.sequence.length, correct: row.correct });

    // A late name change should show, so the most recent one wins.
    if (row.displayName) entry.displayName = row.displayName;

    totals.set(row.participantId, entry);
  }

  const sorted = [...totals.entries()].sort((a, b) => {
    if (b[1].score !== a[1].score) return b[1].score - a[1].score;
    // A tie on points goes to whoever got more right, then to whoever was
    // faster, then alphabetically so the order is stable between renders
    // rather than jittering.
    if (b[1].correctCount !== a[1].correctCount) return b[1].correctCount - a[1].correctCount;

    const aAvg = a[1].timedCount > 0 ? a[1].totalMs / a[1].timedCount : Infinity;
    const bAvg = b[1].timedCount > 0 ? b[1].totalMs / b[1].timedCount : Infinity;
    if (aAvg !== bAvg) return aAvg - bAvg;

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
      accuracy:
        totals_.answeredCount === 0
          ? 0
          : Math.round((totals_.correctCount / totals_.answeredCount) * 100),
      averageSeconds:
        totals_.timedCount > 0
          ? Math.round((totals_.totalMs / totals_.timedCount / 1000) * 10) / 10
          : null,
      bestStreak: longestStreak(totals_.sequence),
      rank,
      // Positive means they climbed, which is how a room reads an arrow.
      change: before === undefined ? null : before - rank,
    });
  });

  return entries;
}

/** The longest run of correct answers, in the order they were given. */
function longestStreak(sequence: { index: number; correct: boolean }[]): number {
  const ordered = [...sequence].sort((a, b) => a.index - b.index);

  let best = 0;
  let run = 0;

  for (const item of ordered) {
    run = item.correct ? run + 1 : 0;
    if (run > best) best = run;
  }

  return best;
}
