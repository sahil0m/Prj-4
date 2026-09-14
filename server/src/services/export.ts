import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { responses, participants, type Session } from '../db/schema.js';
import { definitionFor, type CountedItem, type SlideKind } from '@pulse/shared';
import * as sessions from './sessions.js';

/**
 * Getting the data out.
 *
 * A session's results belong to the person who ran it, and a product that
 * holds them hostage is one nobody should trust. Two shapes are offered:
 * a wide CSV for a spreadsheet, and JSON for anything else.
 */

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Escapes one CSV field.
 *
 * The leading-character guard matters: a spreadsheet treats a cell starting
 * with =, +, - or @ as a formula, so an answer of "=1+1" becomes a live
 * calculation, and a crafted one can run a command on the reader's machine.
 * Prefixing with a quote neutralises it while keeping the text readable.
 */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';

  // Objects are serialised rather than stringified: String({}) yields
  // "[object Object]", which is a silently useless cell in someone's
  // spreadsheet rather than an obvious failure.
  let text: string;

  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else if (value instanceof Date) text = value.toISOString();
  else text = JSON.stringify(value);

  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvRow(fields: unknown[]): string {
  return fields.map(csvField).join(',');
}

/** Renders one answer as a single readable cell. */
function answerToText(kind: SlideKind, payload: unknown, config: Record<string, unknown>): string {
  const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};

  const labelFor = (id: string): string => {
    const options = Array.isArray(config.options)
      ? (config.options as { id: string; label: string }[])
      : [];
    const items = Array.isArray(config.items)
      ? (config.items as { id: string; label: string }[])
      : [];
    const statements = Array.isArray(config.statements)
      ? (config.statements as { id: string; label: string }[])
      : [];

    return [...options, ...items, ...statements].find((entry) => entry.id === id)?.label ?? id;
  };

  switch (kind) {
    case 'word_cloud':
      return Array.isArray(data.words) ? data.words.join(', ') : '';

    case 'open_text':
    case 'quiz_type':
      return typeof data.text === 'string' ? data.text : '';

    case 'multiple_choice':
    case 'image_choice':
    case 'quiz_select':
      return Array.isArray(data.optionIds)
        ? data.optionIds.map((id) => labelFor(String(id))).join(', ')
        : '';

    case 'who_will_win':
      return typeof data.optionId === 'string' ? labelFor(data.optionId) : '';

    case 'true_false':
      return data.value === true ? 'True' : data.value === false ? 'False' : '';

    case 'nps':
      return typeof data.score === 'number' ? String(data.score) : '';

    case 'star_rating':
      return typeof data.stars === 'number' ? String(data.stars) : '';

    case 'guess_number':
      return typeof data.value === 'number' ? String(data.value) : '';

    case 'scales': {
      const values = data.values as Record<string, number> | undefined;
      if (!values) return '';
      return Object.entries(values)
        .map(([id, value]) => `${labelFor(id)}: ${String(value)}`)
        .join('; ');
    }

    case 'ranking':
    case 'quiz_order':
      return Array.isArray(data.order)
        ? data.order.map((id, i) => `${String(i + 1)}. ${labelFor(String(id))}`).join('; ')
        : '';

    case 'points_100': {
      const allocation = data.allocation as Record<string, number> | undefined;
      if (!allocation) return '';
      return Object.entries(allocation)
        .filter(([, points]) => points > 0)
        .map(([id, points]) => `${labelFor(id)}: ${String(points)}`)
        .join('; ');
    }

    case 'grid_2x2': {
      const positions = data.positions as Record<string, { x: number; y: number }> | undefined;
      if (!positions) return '';
      return Object.entries(positions)
        .map(([id, point]) => `${labelFor(id)}: (${point.x.toFixed(2)}, ${point.y.toFixed(2)})`)
        .join('; ');
    }

    case 'pin_image':
    case 'map_pin': {
      const pins = Array.isArray(data.pins) ? (data.pins as { x: number; y: number }[]) : [];
      return pins.map((pin) => `(${pin.x.toFixed(3)}, ${pin.y.toFixed(3)})`).join('; ');
    }

    default:
      // Anything without a specific rendering still exports its raw shape,
      // which is more useful than an empty cell.
      return JSON.stringify(payload);
  }
}

/**
 * One row per answer.
 *
 * Long rather than wide: a wide sheet needs a column per slide and breaks
 * whenever a deck changes, while this shape opens cleanly in a pivot table.
 */
export async function responsesCsv(session: Session): Promise<string> {
  const snapshot = sessions.snapshotOf(session);

  const rows = await db
    .select({
      slideId: responses.slideId,
      participantId: responses.participantId,
      payload: responses.payload,
      isCorrect: responses.isCorrect,
      points: responses.points,
      submittedAt: responses.submittedAt,
    })
    .from(responses)
    .where(and(eq(responses.sessionId, session.id), isNull(responses.deletedAt)))
    .orderBy(asc(responses.submittedAt));

  const people = await db
    .select({ id: participants.id, displayName: participants.displayName })
    .from(participants)
    .where(eq(participants.sessionId, session.id));

  const names = new Map(people.map((p) => [p.id, p.displayName]));

  const lines: string[] = [
    csvRow([
      'Submitted at',
      'Participant',
      'Slide number',
      'Slide type',
      'Question',
      'Answer',
      'Correct',
      'Points',
    ]),
  ];

  for (const row of rows) {
    const index = snapshot.slides.findIndex((s) => s.id === row.slideId);
    const slide = snapshot.slides[index];
    if (!slide) continue;

    const participantId = row.participantId;

    lines.push(
      csvRow([
        row.submittedAt.toISOString(),
        // An empty name is anonymous, so ?? alone would not catch it.
        names.get(participantId)?.trim() === ''
          ? 'Anonymous'
          : (names.get(participantId) ?? 'Anonymous'),
        index + 1,
        definitionFor(slide.kind).label,
        typeof slide.config.prompt === 'string' ? slide.config.prompt : '',
        answerToText(slide.kind, row.payload, slide.config),
        row.isCorrect === null ? '' : row.isCorrect ? 'Yes' : 'No',
        row.points ?? '',
      ]),
    );
  }

  return lines.join('\r\n');
}

/** The final standings, for a quiz. */
export async function leaderboardCsv(session: Session): Promise<string> {
  const entries = await sessions.leaderboardFor(session);

  const lines = [csvRow(['Rank', 'Name', 'Score', 'Correct', 'Answered'])];

  for (const entry of entries) {
    lines.push(
      csvRow([entry.rank, entry.displayName, entry.score, entry.correctCount, entry.answeredCount]),
    );
  }

  return lines.join('\r\n');
}

/**
 * The statistics, one row per option.
 *
 * What a presenter is usually after afterwards: how many people were in the
 * room, how many answered each question, and how the answers split. The
 * per-answer export says who said what; this one says what the room said.
 *
 * Long rather than wide, like the answers export, so it opens straight into
 * a pivot table without a column per option.
 */
export async function statisticsCsv(session: Session): Promise<string> {
  const snapshot = sessions.snapshotOf(session);
  const participants = await sessions.countParticipants(session.id);

  const lines: string[] = [
    csvRow([
      'Slide number',
      'Slide type',
      'Question',
      'Option',
      'Answers',
      'Share of answers',
      'Correct option',
      'People who answered',
      'People in session',
      'Response rate',
    ]),
  ];

  for (const [index, slide] of snapshot.slides.entries()) {
    const results = await sessions.resultsFor(session, slide.id);
    if (!results) continue;

    const definition = definitionFor(slide.kind);
    const prompt = typeof slide.config.prompt === 'string' ? slide.config.prompt : '';
    const rate = participants === 0 ? '' : `${((results.count / participants) * 100).toFixed(1)}%`;

    const row = (option: string, count: number | '', share: string, correct: string) =>
      csvRow([
        index + 1,
        definition.label,
        prompt,
        option,
        count,
        share,
        correct,
        results.count,
        participants,
        rate,
      ]);

    const data = results.data as { type: string; items?: CountedItem[] };

    // Kinds that tally into options get a row each; everything else gets one
    // row carrying its totals, so no slide is silently missing.
    if (data.type === 'counts' && Array.isArray(data.items) && data.items.length > 0) {
      for (const item of data.items) {
        lines.push(
          row(
            item.label,
            item.count,
            `${item.percent.toFixed(1)}%`,
            item.correct === true ? 'Yes' : item.correct === false ? 'No' : '',
          ),
        );
      }
      continue;
    }

    lines.push(row('', results.count, '', ''));
  }

  return lines.join('\r\n');
}

/** Everything, for anyone who would rather work with the raw shapes. */
export async function sessionJson(session: Session): Promise<Record<string, unknown>> {
  const snapshot = sessions.snapshotOf(session);

  const slides = await Promise.all(
    snapshot.slides.map(async (slide, index) => {
      const results = await sessions.resultsFor(session, slide.id);
      return {
        number: index + 1,
        id: slide.id,
        kind: slide.kind,
        prompt: typeof slide.config.prompt === 'string' ? slide.config.prompt : '',
        responseCount: results?.count ?? 0,
        results: results?.data ?? null,
      };
    }),
  );

  return {
    session: {
      id: session.id,
      title: session.title,
      joinCode: session.joinCode,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      participantCount: await sessions.countParticipants(session.id),
    },
    slides,
    leaderboard: await sessions.leaderboardFor(session),
  };
}

/** A filename that sorts chronologically and is safe on every filesystem. */
export function exportFilename(session: Session, kind: string, extension: string): string {
  const date = session.startedAt.toISOString().slice(0, 10);

  const title = session.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return `${date}-${title || 'session'}-${kind}.${extension}`;
}
