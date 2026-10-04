import { describe, it, expect } from 'vitest';
import {
  scoreAnswer,
  pointsFor,
  buildLeaderboard,
  difficultyWeight,
  type ScoreRow,
} from './scoring.js';

const QUIZ = { pointsMax: 1000, pointsMin: 500, countdownSeconds: 20 };

describe('pointsFor', () => {
  it('awards the maximum for an instant answer', () => {
    expect(pointsFor(0, QUIZ).points).toBe(1000);
  });

  it('awards the minimum at the end of the countdown', () => {
    expect(pointsFor(20_000, QUIZ).points).toBe(500);
  });

  it('keeps most of the bonus early, then drops away', () => {
    // The curve exists so the opening seconds are worth racing for. Half
    // the clock still leaves most of the bonus; the last quarter is where
    // it actually costs.
    const quarter = pointsFor(5_000, QUIZ).points;
    const half = pointsFor(10_000, QUIZ).points;
    const threeQuarters = pointsFor(15_000, QUIZ).points;

    expect(quarter).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(threeQuarters);

    // Half way through, a correct answer is still worth well over 90% of
    // the maximum — a thoughtful answer is not punished.
    expect(half).toBeGreaterThan(900);

    // The final quarter is where the cost lands.
    expect(quarter - half).toBeLessThan(half - threeQuarters);
  });

  it('never exceeds the maximum, however early', () => {
    // A device with a skewed clock can report a negative elapsed time.
    expect(pointsFor(-5000, QUIZ).points).toBe(1000);
  });

  it('scores nothing at all once the clock has expired', () => {
    // Clamping to the minimum meant someone answering a minute into a
    // twenty second question earned as much as someone who just made it,
    // which rewards not trying.
    const late = pointsFor(60_000, QUIZ);
    expect(late.points).toBe(0);
    expect(late.tooLate).toBe(true);
  });

  it('allows a moment of grace for the network', () => {
    // A tap as the clock hits zero still has to travel. Being punished for
    // latency is not the game.
    const justOver = pointsFor(20_400, QUIZ);
    expect(justOver.tooLate).toBe(false);
    expect(justOver.points).toBeGreaterThan(0);
  });

  it('never falls below the minimum while the clock is still running', () => {
    expect(pointsFor(20_000, QUIZ).points).toBe(500);
  });

  it('handles a zero-length countdown without dividing by zero', () => {
    const result = pointsFor(1000, { ...QUIZ, countdownSeconds: 0 });
    expect(Number.isFinite(result.points)).toBe(true);
  });
});

describe('scoreAnswer - quiz_select', () => {
  const config = {
    ...QUIZ,
    options: [
      { id: 'a', label: 'Paris', correct: true },
      { id: 'b', label: 'Rome' },
      { id: 'c', label: 'Madrid' },
    ],
  };

  it('scores a correct answer', () => {
    const result = scoreAnswer(
      { kind: 'quiz_select', payload: { optionIds: ['a'] }, elapsedMs: 0 },
      config,
    );
    expect(result.correct).toBe(true);
    expect(result.points).toBe(1000);
  });

  it('gives nothing for a wrong answer, however fast', () => {
    const result = scoreAnswer(
      { kind: 'quiz_select', payload: { optionIds: ['b'] }, elapsedMs: 0 },
      config,
    );
    expect(result.correct).toBe(false);
    expect(result.points).toBe(0);
  });

  it('requires every correct option when there are several', () => {
    const multi = {
      ...QUIZ,
      options: [
        { id: 'a', label: 'A', correct: true },
        { id: 'b', label: 'B', correct: true },
        { id: 'c', label: 'C' },
      ],
    };

    // Picking one of two correct answers is not correct.
    expect(
      scoreAnswer({ kind: 'quiz_select', payload: { optionIds: ['a'] }, elapsedMs: 0 }, multi)
        .correct,
    ).toBe(false);

    expect(
      scoreAnswer({ kind: 'quiz_select', payload: { optionIds: ['a', 'b'] }, elapsedMs: 0 }, multi)
        .correct,
    ).toBe(true);
  });

  it('rejects a correct answer padded with a wrong one', () => {
    expect(
      scoreAnswer({ kind: 'quiz_select', payload: { optionIds: ['a', 'b'] }, elapsedMs: 0 }, config)
        .correct,
    ).toBe(false);
  });

  it('scores nothing when the author marked no correct option', () => {
    const unmarked = { ...QUIZ, options: [{ id: 'a', label: 'A' }] };
    expect(
      scoreAnswer({ kind: 'quiz_select', payload: { optionIds: ['a'] }, elapsedMs: 0 }, unmarked)
        .correct,
    ).toBe(false);
  });

  it('survives a malformed payload', () => {
    expect(() =>
      scoreAnswer({ kind: 'quiz_select', payload: null, elapsedMs: 0 }, config),
    ).not.toThrow();
    expect(scoreAnswer({ kind: 'quiz_select', payload: 'junk', elapsedMs: 0 }, config).points).toBe(
      0,
    );
  });
});

describe('scoreAnswer - quiz_type', () => {
  const config = { ...QUIZ, correctText: 'The Great Gatsby', acceptedAnswers: ['Gatsby'] };

  /*
   * Both of these were offered in the editor and ignored by the scoring:
   * an author could ask for exact case, or forgive a typo, and neither
   * changed whether an answer counted.
   */
  const typed = (text: string, extra: Record<string, unknown> = {}) =>
    scoreAnswer({ kind: 'quiz_type', payload: { text }, elapsedMs: 0 }, { ...config, ...extra })
      .correct;

  describe('case sensitivity', () => {
    it('accepts any case by default', () => {
      expect(typed('the great gatsby')).toBe(true);
    });

    it('requires the authors own case when they ask for it', () => {
      expect(typed('the great gatsby', { caseSensitive: true })).toBe(false);
      expect(typed('The Great Gatsby', { caseSensitive: true })).toBe(true);
    });
  });

  describe('typo tolerance', () => {
    it('forgives a single typo when one is allowed', () => {
      expect(typed('The Great Gatsy', { fuzzyTolerance: 1 })).toBe(true);
    });

    it('forgives nothing when the allowance is zero', () => {
      expect(typed('The Great Gatsy', { fuzzyTolerance: 0 })).toBe(false);
    });

    it('does not forgive more mistakes than allowed', () => {
      expect(typed('The Grat Gatsy', { fuzzyTolerance: 1 })).toBe(false);
      expect(typed('The Grat Gatsy', { fuzzyTolerance: 2 })).toBe(true);
    });

    /*
     * The guard that keeps tolerance honest: on a short answer one edit
     * is a different word, not a slip. Without it, a quiz asking for a
     * three-letter answer would accept most of the alphabet.
     */
    it('never turns a short wrong answer into a right one', () => {
      const shortConfig = { ...QUIZ, correctText: 'cat', acceptedAnswers: [] };
      const score = (text: string) =>
        scoreAnswer(
          { kind: 'quiz_type', payload: { text }, elapsedMs: 0 },
          { ...shortConfig, fuzzyTolerance: 2 },
        ).correct;

      expect(score('cat')).toBe(true);
      expect(score('cap')).toBe(false);
      expect(score('dog')).toBe(false);
    });

    it('applies the same tolerance to an alternative spelling', () => {
      // "Gatsy" and "Gatsbyy" are each one edit from the accepted "Gatsby".
      expect(typed('Gatsy', { fuzzyTolerance: 1 })).toBe(true);
      expect(typed('Gatsbyy', { fuzzyTolerance: 1 })).toBe(true);
      // Two edits away, with only one forgiven.
      expect(typed('Gtsyy', { fuzzyTolerance: 1 })).toBe(false);
    });
  });

  it('accepts an exact answer', () => {
    expect(
      scoreAnswer(
        { kind: 'quiz_type', payload: { text: 'The Great Gatsby' }, elapsedMs: 0 },
        config,
      ).correct,
    ).toBe(true);
  });

  it('ignores case and surrounding space', () => {
    expect(
      scoreAnswer(
        { kind: 'quiz_type', payload: { text: '  the great gatsby  ' }, elapsedMs: 0 },
        config,
      ).correct,
    ).toBe(true);
  });

  it('ignores punctuation', () => {
    expect(
      scoreAnswer(
        { kind: 'quiz_type', payload: { text: 'The Great Gatsby!' }, elapsedMs: 0 },
        config,
      ).correct,
    ).toBe(true);
  });

  it('accepts an alternative spelling the author allowed', () => {
    expect(
      scoreAnswer({ kind: 'quiz_type', payload: { text: 'gatsby' }, elapsedMs: 0 }, config).correct,
    ).toBe(true);
  });

  it('ignores accents, so cafe matches the accented spelling', () => {
    const accented = { ...QUIZ, correctText: 'café' };
    expect(
      scoreAnswer({ kind: 'quiz_type', payload: { text: 'cafe' }, elapsedMs: 0 }, accented).correct,
    ).toBe(true);
  });

  it('rejects a different answer', () => {
    expect(
      scoreAnswer({ kind: 'quiz_type', payload: { text: 'Moby Dick' }, elapsedMs: 0 }, config)
        .correct,
    ).toBe(false);
  });

  it('rejects an empty answer', () => {
    expect(
      scoreAnswer({ kind: 'quiz_type', payload: { text: '   ' }, elapsedMs: 0 }, config).correct,
    ).toBe(false);
  });
});

describe('scoreAnswer - quiz_order', () => {
  const config = { ...QUIZ, correctOrder: ['a', 'b', 'c'] };

  it('accepts the right order', () => {
    expect(
      scoreAnswer({ kind: 'quiz_order', payload: { order: ['a', 'b', 'c'] }, elapsedMs: 0 }, config)
        .correct,
    ).toBe(true);
  });

  it('rejects a wrong order', () => {
    expect(
      scoreAnswer({ kind: 'quiz_order', payload: { order: ['b', 'a', 'c'] }, elapsedMs: 0 }, config)
        .correct,
    ).toBe(false);
  });

  it('rejects an incomplete order', () => {
    expect(
      scoreAnswer({ kind: 'quiz_order', payload: { order: ['a', 'b'] }, elapsedMs: 0 }, config)
        .correct,
    ).toBe(false);
  });
});

describe('scoreAnswer - non-quiz kinds', () => {
  it('scores nothing rather than throwing', () => {
    const result = scoreAnswer(
      { kind: 'word_cloud', payload: { words: ['hello'] }, elapsedMs: 0 },
      QUIZ,
    );
    expect(result.correct).toBe(false);
    expect(result.points).toBe(0);
  });
});

describe('buildLeaderboard', () => {
  const rows = (...entries: [string, string, number, boolean][]): ScoreRow[] =>
    entries.map(([participantId, displayName, points, correct]) => ({
      participantId,
      displayName,
      points,
      correct,
    }));

  it('totals points across slides', () => {
    const board = buildLeaderboard(
      rows(['p1', 'Ana', 800, true], ['p1', 'Ana', 900, true], ['p2', 'Ben', 1000, true]),
    );

    expect(board[0]?.displayName).toBe('Ana');
    expect(board[0]?.score).toBe(1700);
    expect(board[1]?.score).toBe(1000);
  });

  it('counts correct and answered separately', () => {
    const board = buildLeaderboard(
      rows(['p1', 'Ana', 800, true], ['p1', 'Ana', 0, false], ['p1', 'Ana', 700, true]),
    );
    expect(board[0]?.correctCount).toBe(2);
    expect(board[0]?.answeredCount).toBe(3);
  });

  it('gives tied players the same rank and skips the next', () => {
    // Two on 1000 are both first; the next is third, not second.
    const board = buildLeaderboard(
      rows(['p1', 'Ana', 1000, true], ['p2', 'Ben', 1000, true], ['p3', 'Cal', 500, true]),
    );

    expect(board[0]?.rank).toBe(1);
    expect(board[1]?.rank).toBe(1);
    expect(board[2]?.rank).toBe(3);
  });

  it('breaks a tie on points by who got more right', () => {
    const board = buildLeaderboard(
      rows(['p1', 'Ana', 500, true], ['p1', 'Ana', 500, true], ['p2', 'Ben', 1000, true]),
    );
    // Both on 1000, but Ana answered two correctly.
    expect(board[0]?.displayName).toBe('Ana');
  });

  it('orders an exact tie alphabetically, so the list does not jitter', () => {
    const board = buildLeaderboard(rows(['p2', 'Zoe', 500, true], ['p1', 'Ana', 500, true]));
    expect(board[0]?.displayName).toBe('Ana');
  });

  it('reports movement since the previous slide', () => {
    const previous = new Map([
      ['p1', 3],
      ['p2', 1],
    ]);

    const board = buildLeaderboard(
      rows(['p1', 'Ana', 2000, true], ['p2', 'Ben', 100, true]),
      previous,
    );

    // Ana climbed from 3rd to 1st.
    expect(board[0]?.change).toBe(2);
    // Ben fell from 1st to 2nd.
    expect(board[1]?.change).toBe(-1);
  });

  it('reports no movement for someone new', () => {
    const board = buildLeaderboard(rows(['p1', 'Ana', 500, true]), new Map());
    expect(board[0]?.change).toBe(null);
  });

  it('falls back to Anonymous rather than showing a blank row', () => {
    const board = buildLeaderboard(rows(['p1', '', 500, true]));
    expect(board[0]?.displayName).toBe('Anonymous');
  });

  it('returns an empty board rather than throwing when nobody played', () => {
    expect(buildLeaderboard([])).toEqual([]);
  });
});

describe('difficultyWeight', () => {
  it('treats a question everyone answered correctly as worth slightly less', () => {
    expect(difficultyWeight(10, 10)).toBeLessThan(1);
  });

  it('treats a question nobody got as worth more', () => {
    expect(difficultyWeight(0, 10)).toBeGreaterThan(1.4);
  });

  it('treats an even split as about face value', () => {
    const weight = difficultyWeight(5, 10);
    expect(weight).toBeGreaterThan(1.1);
    expect(weight).toBeLessThan(1.25);
  });

  it('does not infer difficulty from one or two answers', () => {
    // Two people getting it wrong says nothing about the question.
    expect(difficultyWeight(0, 2)).toBe(1);
    expect(difficultyWeight(1, 1)).toBe(1);
  });

  it('stays within a narrow band, so one question cannot decide everything', () => {
    for (let correct = 0; correct <= 20; correct += 1) {
      const weight = difficultyWeight(correct, 20);
      expect(weight).toBeGreaterThanOrEqual(0.85);
      expect(weight).toBeLessThanOrEqual(1.5);
    }
  });
});

describe('leaderboard detail', () => {
  const row = (
    participantId: string,
    displayName: string,
    points: number,
    correct: boolean,
    elapsedMs?: number,
    slideIndex?: number,
  ): ScoreRow => ({ participantId, displayName, points, correct, elapsedMs, slideIndex });

  it('reports accuracy as a percentage', () => {
    const board = buildLeaderboard([
      row('p1', 'Ana', 900, true),
      row('p1', 'Ana', 0, false),
      row('p1', 'Ana', 800, true),
      row('p1', 'Ana', 0, false),
    ]);

    expect(board[0]?.accuracy).toBe(50);
  });

  it('averages only the time taken over correct answers', () => {
    const board = buildLeaderboard([
      row('p1', 'Ana', 900, true, 2000),
      row('p1', 'Ana', 0, false, 19_000),
      row('p1', 'Ana', 800, true, 4000),
    ]);

    // 2s and 4s, not the 19s spent being wrong.
    expect(board[0]?.averageSeconds).toBe(3);
  });

  it('reports no average when nothing was answered correctly', () => {
    const board = buildLeaderboard([row('p1', 'Ana', 0, false, 5000)]);
    expect(board[0]?.averageSeconds).toBe(null);
  });

  it('measures the longest run of correct answers', () => {
    const board = buildLeaderboard([
      row('p1', 'Ana', 900, true, 1000, 0),
      row('p1', 'Ana', 900, true, 1000, 1),
      row('p1', 'Ana', 0, false, 1000, 2),
      row('p1', 'Ana', 900, true, 1000, 3),
      row('p1', 'Ana', 900, true, 1000, 4),
      row('p1', 'Ana', 900, true, 1000, 5),
    ]);

    // Three at the end beats two at the start.
    expect(board[0]?.bestStreak).toBe(3);
  });

  it('measures a streak in slide order, not arrival order', () => {
    // Answers can arrive out of order in a self-paced session.
    const board = buildLeaderboard([
      row('p1', 'Ana', 900, true, 1000, 2),
      row('p1', 'Ana', 0, false, 1000, 1),
      row('p1', 'Ana', 900, true, 1000, 0),
    ]);

    expect(board[0]?.bestStreak).toBe(1);
  });

  it('breaks a tie on points and accuracy by who was faster', () => {
    const board = buildLeaderboard([
      row('p1', 'Slow', 1000, true, 15_000),
      row('p2', 'Quick', 1000, true, 2000),
    ]);

    expect(board[0]?.displayName).toBe('Quick');
  });
});
