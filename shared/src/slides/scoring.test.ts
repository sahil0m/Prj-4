import { describe, it, expect } from 'vitest';
import { scoreAnswer, pointsFor, buildLeaderboard, type ScoreRow } from './scoring.js';

const QUIZ = { pointsMax: 1000, pointsMin: 500, countdownSeconds: 20 };

describe('pointsFor', () => {
  it('awards the maximum for an instant answer', () => {
    expect(pointsFor(0, QUIZ).points).toBe(1000);
  });

  it('awards the minimum at the end of the countdown', () => {
    expect(pointsFor(20_000, QUIZ).points).toBe(500);
  });

  it('scales linearly in between', () => {
    expect(pointsFor(10_000, QUIZ).points).toBe(750);
    expect(pointsFor(5_000, QUIZ).points).toBe(875);
  });

  it('never exceeds the maximum, however early', () => {
    // A device with a skewed clock can report a negative elapsed time.
    expect(pointsFor(-5000, QUIZ).points).toBe(1000);
  });

  it('never falls below the minimum, however late', () => {
    expect(pointsFor(600_000, QUIZ).points).toBe(500);
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
