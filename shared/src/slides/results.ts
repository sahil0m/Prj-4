import type { SlideKind } from './kinds.js';

/**
 * Turning raw answers into the numbers a chart draws.
 *
 * This lives in shared rather than on the server because the presenter view
 * recomputes locally as answers stream in — re-aggregating a thousand rows
 * server-side on every submission would be wasteful, and two different
 * implementations would eventually disagree about what a room voted.
 */

export interface CountedItem {
  id: string;
  label: string;
  count: number;
  /** 0–100, rounded to one decimal. */
  percent: number;
  correct?: boolean;
  /**
   * The option's picture, where it has one.
   *
   * Carried through so an Image Choice result shows the images people were
   * choosing between. Without it the room picks between pictures and then
   * sees a chart of text, with no way to tell which bar was which.
   */
  imageUrl?: string;
}

export interface WordTally {
  word: string;
  count: number;
}

export interface TextEntry {
  id: string;
  text: string;
  upvotes: number;
}

export interface NumericSummary {
  count: number;
  average: number;
  median: number;
  min: number;
  max: number;
  /** Histogram buckets for the distribution chart. */
  buckets: { from: number; to: number; count: number }[];
}

export interface NpsSummary {
  count: number;
  score: number;
  promoters: number;
  passives: number;
  detractors: number;
  /** Counts for each 0–10 value. */
  distribution: number[];
}

export interface ScaleSummary {
  statementId: string;
  label: string;
  average: number;
  count: number;
}

export interface RankingSummary {
  id: string;
  label: string;
  /** Lower is better; the mean position across all ballots. */
  averageRank: number;
  count: number;
}

export interface PointsSummary {
  id: string;
  label: string;
  total: number;
  average: number;
  percent: number;
}

export interface ScatterSummary {
  id: string;
  label: string;
  x: number;
  y: number;
  count: number;
}

export interface FieldSummary {
  fieldId: string;
  label: string;
  /** Free text answers, for a text field. */
  texts: string[];
  /** Counts per option, for a choice or boolean field. */
  counts: { label: string; count: number }[];
  /** Mean, for a numeric field. */
  average: number | null;
  responses: number;
}

export interface Stroke {
  color: string;
  width: number;
  points: number[];
}

/** Anything the server or a chart may receive for a slide. */
export type ResultData =
  | { type: 'counts'; items: CountedItem[]; totalVotes: number }
  | { type: 'words'; words: WordTally[] }
  | { type: 'texts'; entries: TextEntry[] }
  | { type: 'numeric'; summary: NumericSummary }
  | { type: 'nps'; summary: NpsSummary }
  | { type: 'scales'; statements: ScaleSummary[] }
  | { type: 'ranking'; items: RankingSummary[] }
  | { type: 'points'; items: PointsSummary[] }
  | { type: 'scatter'; points: ScatterSummary[] }
  | { type: 'pins'; pins: { x: number; y: number }[] }
  | { type: 'fields'; fields: FieldSummary[] }
  | { type: 'drawings'; drawings: { id: string; strokes: Stroke[] }[] }
  | { type: 'none' };

/** One stored answer, as the aggregator needs it. */
export interface AnswerRow {
  id: string;
  payload: unknown;
  displayName?: string;
  upvotes?: number;
}

/** Labels the aggregator needs from the slide config. */
export interface LabelSource {
  options?: { id: string; label: string; correct?: boolean }[];
  items?: { id: string; label: string }[];
  statements?: { id: string; label: string }[];
  pairs?: { id: string; left: string; right: string }[];
  fields?: {
    id: string;
    label: string;
    type?: string;
    options?: { id: string; label: string }[];
  }[];
  min?: number;
  max?: number;
  stars?: number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function percentOf(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numbers(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Counts by id, preserving the order options were defined in. */
function tallyIds(
  ids: string[][],
  options: { id: string; label: string; correct?: boolean; imageUrl?: string }[],
): { items: CountedItem[]; totalVotes: number } {
  const counts = new Map<string, number>();
  let totalVotes = 0;

  for (const ballot of ids) {
    for (const id of ballot) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      totalVotes += 1;
    }
  }

  const items = options.map((option) => {
    const count = counts.get(option.id) ?? 0;
    const item: CountedItem = {
      id: option.id,
      label: option.label,
      count,
      percent: percentOf(count, totalVotes),
    };
    if (option.correct !== undefined) item.correct = option.correct;
    if (option.imageUrl !== undefined && option.imageUrl !== '') item.imageUrl = option.imageUrl;
    return item;
  });

  return { items, totalVotes };
}

/** Buckets a set of numbers for a histogram. */
function histogram(
  values: number[],
  min: number,
  max: number,
  count = 10,
): NumericSummary['buckets'] {
  if (values.length === 0 || max <= min) return [];

  const width = (max - min) / count;
  const buckets = Array.from({ length: count }, (_, i) => ({
    from: round(min + i * width),
    to: round(min + (i + 1) * width),
    count: 0,
  }));

  for (const value of values) {
    // The final bucket is closed at the top so `max` itself has a home.
    const index = Math.min(count - 1, Math.max(0, Math.floor((value - min) / width)));
    const bucket = buckets[index];
    if (bucket) bucket.count += 1;
  }

  return buckets;
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Tallies answers for one slide.
 *
 * Unknown or malformed payloads are skipped rather than throwing: a single
 * bad row must never take down the results a room is watching.
 */
export function aggregate(kind: SlideKind, rows: AnswerRow[], config: LabelSource): ResultData {
  switch (kind) {
    case 'word_cloud': {
      const counts = new Map<string, { display: string; count: number }>();

      for (const row of rows) {
        const payload = asRecord(row.payload);
        const words = Array.isArray(payload?.words) ? payload.words : [];
        for (const raw of words) {
          if (typeof raw !== 'string') continue;
          const word = raw.trim();
          if (word === '') continue;
          // Case-insensitive grouping, but the first spelling seen is shown,
          // so "React" and "react" merge without shouting at the room.
          const key = word.toLowerCase();
          const existing = counts.get(key);
          if (existing) existing.count += 1;
          else counts.set(key, { display: word, count: 1 });
        }
      }

      const words = [...counts.values()]
        .map((entry) => ({ word: entry.display, count: entry.count }))
        .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

      return { type: 'words', words };
    }

    case 'open_text':
    case 'quiz_type': {
      const entries: TextEntry[] = [];
      for (const row of rows) {
        const payload = asRecord(row.payload);
        const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
        if (text === '') continue;
        entries.push({ id: row.id, text, upvotes: row.upvotes ?? 0 });
      }
      entries.sort((a, b) => b.upvotes - a.upvotes);
      return { type: 'texts', entries };
    }

    case 'multiple_choice':
    case 'image_choice':
    case 'quiz_select': {
      const ballots = rows.map((row) => {
        const payload = asRecord(row.payload);
        return Array.isArray(payload?.optionIds)
          ? payload.optionIds.filter((v): v is string => typeof v === 'string')
          : [];
      });
      return { type: 'counts', ...tallyIds(ballots, config.options ?? []) };
    }

    case 'quiz_match': {
      // Per pair, how many matched it correctly. A single right-or-wrong
      // total would hide which pair the room actually found hard.
      const pairs = config.pairs ?? [];
      const correct = new Map<string, number>();

      for (const row of rows) {
        const payload = asRecord(row.payload);
        const matches = asRecord(payload?.matches);
        if (!matches) continue;

        for (const pair of pairs) {
          const given = matches[pair.id];
          if (typeof given === 'string' && given.trim() === pair.right.trim()) {
            correct.set(pair.id, (correct.get(pair.id) ?? 0) + 1);
          }
        }
      }

      const items: CountedItem[] = pairs.map((pair) => {
        const count = correct.get(pair.id) ?? 0;
        return {
          id: pair.id,
          label: pair.left,
          count,
          percent: percentOf(count, rows.length),
          correct: true,
        };
      });

      return { type: 'counts', items, totalVotes: rows.length };
    }

    case 'quick_form': {
      const fields = config.fields ?? [];

      const summaries: FieldSummary[] = fields.map((field) => {
        const texts: string[] = [];
        const counts = new Map<string, number>();
        const numbers: number[] = [];

        for (const row of rows) {
          const payload = asRecord(row.payload);
          const values = asRecord(payload?.fields);
          const value = values?.[field.id];

          if (value === undefined || value === null || value === '') continue;

          if (typeof value === 'number' && Number.isFinite(value)) {
            numbers.push(value);
          } else if (typeof value === 'boolean') {
            const label = value ? 'Yes' : 'No';
            counts.set(label, (counts.get(label) ?? 0) + 1);
          } else if (typeof value === 'string') {
            // A choice field stores an option id; anything else is prose.
            const option = field.options?.find((o) => o.id === value);
            if (option) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
            else texts.push(value);
          }
        }

        const responses =
          texts.length + numbers.length + [...counts.values()].reduce((a, b) => a + b, 0);

        return {
          fieldId: field.id,
          label: field.label,
          texts,
          counts: [...counts.entries()]
            .map(([label, count]) => ({ label, count }))
            .sort((a, b) => b.count - a.count),
          average:
            numbers.length > 0
              ? round(numbers.reduce((sum, n) => sum + n, 0) / numbers.length)
              : null,
          responses,
        };
      });

      return { type: 'fields', fields: summaries };
    }

    case 'drawing': {
      const drawings: { id: string; strokes: Stroke[] }[] = [];

      for (const row of rows) {
        const payload = asRecord(row.payload);
        const raw = Array.isArray(payload?.strokes) ? payload.strokes : [];

        const strokes: Stroke[] = [];

        for (const entry of raw) {
          const stroke = asRecord(entry);
          const points = Array.isArray(stroke?.points)
            ? stroke.points.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
            : [];

          // Fewer than two pairs is not a line, and an odd count means the
          // payload was truncated; either way it cannot be drawn.
          if (points.length < 4 || points.length % 2 !== 0) continue;

          strokes.push({
            color: typeof stroke?.color === 'string' ? stroke.color : '#8b84fc',
            width: typeof stroke?.width === 'number' ? stroke.width : 1.6,
            points,
          });
        }

        if (strokes.length > 0) drawings.push({ id: row.id, strokes });
      }

      return { type: 'drawings', drawings };
    }

    case 'who_will_win': {
      const ballots = rows.map((row) => {
        const payload = asRecord(row.payload);
        return typeof payload?.optionId === 'string' ? [payload.optionId] : [];
      });
      return { type: 'counts', ...tallyIds(ballots, config.options ?? []) };
    }

    case 'true_false': {
      const ballots = rows.map((row) => {
        const payload = asRecord(row.payload);
        if (typeof payload?.value !== 'boolean') return [];
        return [payload.value ? 'true' : 'false'];
      });
      return {
        type: 'counts',
        ...tallyIds(ballots, [
          { id: 'true', label: 'True' },
          { id: 'false', label: 'False' },
        ]),
      };
    }

    case 'guess_number':
    case 'star_rating': {
      const key = kind === 'guess_number' ? 'value' : 'stars';
      const values: number[] = [];

      for (const row of rows) {
        const payload = asRecord(row.payload);
        const value = payload?.[key];
        if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
      }

      const sorted = [...values].sort((a, b) => a - b);
      const total = values.reduce((sum, v) => sum + v, 0);

      const low = config.min ?? sorted[0] ?? 0;
      const high = config.max ?? sorted[sorted.length - 1] ?? 0;

      return {
        type: 'numeric',
        summary: {
          count: values.length,
          average: values.length > 0 ? round(total / values.length) : 0,
          median: round(median(sorted)),
          min: sorted[0] ?? 0,
          max: sorted[sorted.length - 1] ?? 0,
          buckets: histogram(values, low, high, kind === 'star_rating' ? (config.stars ?? 5) : 10),
        },
      };
    }

    case 'nps': {
      const distribution = Array.from({ length: 11 }, () => 0);
      let promoters = 0;
      let passives = 0;
      let detractors = 0;
      let count = 0;

      for (const row of rows) {
        const payload = asRecord(row.payload);
        const score = payload?.score;
        if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 10) {
          continue;
        }
        distribution[score] = (distribution[score] ?? 0) + 1;
        count += 1;
        if (score >= 9) promoters += 1;
        else if (score >= 7) passives += 1;
        else detractors += 1;
      }

      // The standard definition: %promoters − %detractors, on a −100..100 scale.
      const score = count === 0 ? 0 : Math.round(((promoters - detractors) / count) * 100);

      return {
        type: 'nps',
        summary: { count, score, promoters, passives, detractors, distribution },
      };
    }

    case 'scales': {
      const totals = new Map<string, { sum: number; count: number }>();

      for (const row of rows) {
        const payload = asRecord(row.payload);
        const values = asRecord(payload?.values);
        if (!values) continue;

        for (const [statementId, value] of Object.entries(values)) {
          if (typeof value !== 'number' || !Number.isFinite(value)) continue;
          const entry = totals.get(statementId) ?? { sum: 0, count: 0 };
          entry.sum += value;
          entry.count += 1;
          totals.set(statementId, entry);
        }
      }

      const statements = (config.statements ?? []).map((statement) => {
        const entry = totals.get(statement.id);
        return {
          statementId: statement.id,
          label: statement.label,
          average: entry && entry.count > 0 ? round(entry.sum / entry.count) : 0,
          count: entry?.count ?? 0,
        };
      });

      return { type: 'scales', statements };
    }

    case 'ranking':
    case 'quiz_order': {
      const totals = new Map<string, { sum: number; count: number }>();

      for (const row of rows) {
        const payload = asRecord(row.payload);
        const order = Array.isArray(payload?.order) ? payload.order : [];
        order.forEach((id, index) => {
          if (typeof id !== 'string') return;
          const entry = totals.get(id) ?? { sum: 0, count: 0 };
          // Ranks are 1-based so the number reads the way people say it.
          entry.sum += index + 1;
          entry.count += 1;
          totals.set(id, entry);
        });
      }

      const source = config.items ?? config.options ?? [];
      const items = source
        .map((item) => {
          const entry = totals.get(item.id);
          return {
            id: item.id,
            label: item.label,
            averageRank: entry && entry.count > 0 ? round(entry.sum / entry.count) : 0,
            count: entry?.count ?? 0,
          };
        })
        // Items nobody ranked sort last rather than first.
        .sort((a, b) => {
          if (a.count === 0 && b.count === 0) return 0;
          if (a.count === 0) return 1;
          if (b.count === 0) return -1;
          return a.averageRank - b.averageRank;
        });

      return { type: 'ranking', items };
    }

    case 'points_100': {
      const totals = new Map<string, { sum: number; count: number }>();
      let grandTotal = 0;

      for (const row of rows) {
        const payload = asRecord(row.payload);
        const allocation = asRecord(payload?.allocation);
        if (!allocation) continue;

        for (const [id, points] of Object.entries(allocation)) {
          if (typeof points !== 'number' || !Number.isFinite(points)) continue;
          const entry = totals.get(id) ?? { sum: 0, count: 0 };
          entry.sum += points;
          entry.count += 1;
          totals.set(id, entry);
          grandTotal += points;
        }
      }

      const items = (config.items ?? [])
        .map((item) => {
          const entry = totals.get(item.id);
          const total = entry?.sum ?? 0;
          return {
            id: item.id,
            label: item.label,
            total,
            average: entry && entry.count > 0 ? round(total / entry.count) : 0,
            percent: percentOf(total, grandTotal),
          };
        })
        .sort((a, b) => b.total - a.total);

      return { type: 'points', items };
    }

    case 'grid_2x2': {
      const totals = new Map<string, { x: number; y: number; count: number }>();

      for (const row of rows) {
        const payload = asRecord(row.payload);
        const positions = asRecord(payload?.positions);
        if (!positions) continue;

        for (const [id, raw] of Object.entries(positions)) {
          const point = asRecord(raw);
          const x = point?.x;
          const y = point?.y;
          if (typeof x !== 'number' || typeof y !== 'number') continue;
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

          const entry = totals.get(id) ?? { x: 0, y: 0, count: 0 };
          entry.x += x;
          entry.y += y;
          entry.count += 1;
          totals.set(id, entry);
        }
      }

      const points = (config.items ?? []).map((item) => {
        const entry = totals.get(item.id);
        const count = entry?.count ?? 0;
        return {
          id: item.id,
          label: item.label,
          x: count > 0 ? round((entry?.x ?? 0) / count, 4) : 0.5,
          y: count > 0 ? round((entry?.y ?? 0) / count, 4) : 0.5,
          count,
        };
      });

      return { type: 'scatter', points };
    }

    case 'pin_image':
    case 'map_pin': {
      const pins: { x: number; y: number }[] = [];

      for (const row of rows) {
        const payload = asRecord(row.payload);
        const list = Array.isArray(payload?.pins) ? payload.pins : [];
        for (const raw of list) {
          const point = asRecord(raw);
          const x = point?.x;
          const y = point?.y;
          if (
            typeof x === 'number' &&
            typeof y === 'number' &&
            Number.isFinite(x) &&
            Number.isFinite(y)
          ) {
            pins.push({ x, y });
          }
        }
      }

      return { type: 'pins', pins };
    }

    // Content slides and kinds whose results are rendered from the raw rows.
    default:
      return { type: 'none' };
  }
}

/** Exposed for tests and for charts that need the same rounding. */
export const resultHelpers = { percentOf, median, round, histogram, numbers };
