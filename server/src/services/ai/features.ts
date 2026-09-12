import { z } from 'zod';
import { SLIDE_REGISTRY, definitionFor, type SlideKind, type SlideConfig } from '@pulse/shared';
import { HttpError } from '../../app.js';
import { logger } from '../../lib/logger.js';
import { complete, AiError, type ProviderName } from './providers.js';

/**
 * What the AI actually does.
 *
 * Every feature here follows the same shape: ask for JSON, validate it
 * against a schema, and repair or reject rather than trusting it. A model
 * will occasionally return four options when asked for three, or invent a
 * slide kind that does not exist. Handing that straight to the editor
 * produces a deck that fails to save, which is worse than no AI at all.
 */

/* ------------------------------------------------------------------ */
/* Deck generation                                                     */
/* ------------------------------------------------------------------ */

/** The kinds the model may choose from, with a one-line brief for each. */
const GENERATABLE: SlideKind[] = [
  'multiple_choice',
  'word_cloud',
  'open_text',
  'true_false',
  'scales',
  'ranking',
  'nps',
  'star_rating',
  'guess_number',
  'quiz_select',
  'heading',
  'paragraph',
  'bullets',
  'quote',
];

const zGeneratedSlide = z.object({
  kind: z.enum(GENERATABLE as [SlideKind, ...SlideKind[]]),
  prompt: z.string().trim().min(1).max(300),
  subtitle: z.string().trim().max(200).optional(),
  options: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
  /** Index into `options`, for quiz slides. */
  correctIndex: z.number().int().min(0).max(7).optional(),
  statements: z.array(z.string().trim().min(1).max(120)).max(6).optional(),
  items: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
  body: z.string().trim().max(600).optional(),
});

const zGeneratedDeck = z.object({
  title: z.string().trim().min(1).max(120),
  slides: z.array(zGeneratedSlide).min(1).max(20),
});

export interface GenerateDeckInput {
  topic: string;
  slideCount: number;
  audience?: string;
  /** Nudges the mix towards questions, a quiz, or a mixed session. */
  style?: 'mixed' | 'quiz' | 'discussion' | 'feedback';
  /** Text from an uploaded document, when the deck is built from source. */
  sourceText?: string;
  sourceName?: string;
}

export interface GeneratedDeck {
  title: string;
  slides: { kind: SlideKind; config: SlideConfig }[];
  provider: ProviderName;
}

const DECK_SYSTEM = `You design audience participation decks for live presentations.

You return ONLY a JSON object. No markdown, no commentary, no code fences.

Shape:
{
  "title": "short deck title",
  "slides": [
    {
      "kind": "one of the allowed kinds",
      "prompt": "the question or heading the room sees",
      "subtitle": "optional one line of context",
      "options": ["for choice and quiz kinds, 2-6 short options"],
      "correctIndex": 0,
      "statements": ["for scales, 2-5 short statements"],
      "items": ["for ranking and bullets, 3-6 short items"],
      "body": "for paragraph and quote kinds"
    }
  ]
}

Allowed kinds and what each does:
- multiple_choice: pick one of several options. Needs options.
- quiz_select: same, but one option is correct. Needs options and correctIndex.
- word_cloud: everyone types one word. No options.
- open_text: everyone types a sentence. No options.
- true_false: a statement the room agrees or disagrees with. No options.
- scales: rate several statements on a scale. Needs statements.
- ranking: put items in order. Needs items.
- nps: how likely to recommend, 0-10. No options.
- star_rating: rate out of five. No options.
- guess_number: guess a number. No options.
- heading: a title slide. No options.
- paragraph: a slide of text. Needs body.
- bullets: a list. Needs items.
- quote: a quotation. Needs body.

Rules:
- Questions must be answerable by someone who just walked into the room.
- Keep every prompt under 15 words. They are read from the back of a hall.
- Options must be short enough to read on a phone: 1-4 words each.
- Never repeat a question.
- Open with something easy that warms the room up.
- For a quiz, make the wrong options plausible, not silly.`;

export async function generateDeck(input: GenerateDeckInput): Promise<GeneratedDeck> {
  const count = Math.min(Math.max(input.slideCount, 1), 15);

  const styleBrief =
    input.style === 'quiz'
      ? 'Mostly quiz_select slides with correct answers, plus a heading to open.'
      : input.style === 'discussion'
        ? 'Mostly open_text and word_cloud, to get the room talking.'
        : input.style === 'feedback'
          ? 'Mostly scales, nps and star_rating, to gather opinions.'
          : 'A mix of kinds so the session keeps changing shape.';

  // With a document, the instruction changes from "invent questions about a
  // topic" to "ask about this material" — a different and far more useful
  // task, and one the model does much better when told so explicitly.
  const source = input.sourceText?.trim();

  const prompt = source
    ? [
        `Build the deck from this document${input.sourceName ? ` (${input.sourceName})` : ''}.`,
        input.topic ? `The presenter also said: ${input.topic}` : '',
        input.audience ? `Audience: ${input.audience}` : '',
        `Number of slides: ${String(count)}`,
        styleBrief,
        '',
        'Every question must be answerable from the document below. Use its',
        'own terms and examples. Do not invent facts that are not in it.',
        '',
        '--- DOCUMENT ---',
        source,
        '--- END DOCUMENT ---',
      ]
        .filter(Boolean)
        .join('\n')
    : [
        `Topic: ${input.topic}`,
        input.audience ? `Audience: ${input.audience}` : '',
        `Number of slides: ${String(count)}`,
        styleBrief,
      ]
        .filter(Boolean)
        .join('\n');

  const result = await complete(
    {
      system: DECK_SYSTEM,
      prompt,
      // Lower temperature with source material: the task is to draw
      // questions out of a document accurately, not to be inventive.
      temperature: source ? 0.5 : 0.85,
      maxTokens: 4000,
      json: true,
    },
    'gemini',
  );

  const parsed = zGeneratedDeck.safeParse(parseJson(result.text));

  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues, provider: result.provider },
      'AI deck was malformed',
    );
    throw new HttpError(
      502,
      'The AI returned something unusable. Try again, or rephrase the topic.',
      'ai_bad_output',
    );
  }

  return {
    title: parsed.data.title,
    // Each generated slide is turned into a real config through the same
    // defaults the editor uses, so an AI deck is indistinguishable from a
    // hand-built one and cannot carry a field the schema would reject.
    slides: parsed.data.slides.map(toSlideConfig),
    provider: result.provider,
  };
}

/** Turns one generated slide into a validated config for its kind. */
export function toSlideConfig(slide: z.infer<typeof zGeneratedSlide>): {
  kind: SlideKind;
  config: SlideConfig;
} {
  const defaults = SLIDE_REGISTRY[slide.kind].defaults() as Record<string, unknown>;

  const config: Record<string, unknown> = {
    ...defaults,
    prompt: slide.prompt,
    ...(slide.subtitle ? { subtitle: slide.subtitle } : {}),
  };

  if (slide.options && slide.options.length >= 2 && 'options' in defaults) {
    config.options = slide.options.map((label, i) => ({
      id: `o${String(i + 1)}`,
      label,
      // Only quiz kinds carry a correct flag; adding it elsewhere would be
      // stripped by the schema anyway, but this keeps the intent clear.
      ...(definitionFor(slide.kind).isQuiz ? { correct: i === (slide.correctIndex ?? 0) } : {}),
    }));
  }

  if (slide.statements && 'statements' in defaults) {
    config.statements = slide.statements.map((label, i) => ({
      id: `s${String(i + 1)}`,
      label,
    }));
  }

  if (slide.items && 'items' in defaults) {
    config.items = slide.items.map((label, i) => ({ id: `i${String(i + 1)}`, label }));
  }

  if (slide.body) {
    if ('body' in defaults) config.body = slide.body;
    if ('text' in defaults) config.text = slide.body;
    if ('quote' in defaults) config.quote = slide.body;
  }

  // The kind's own schema is the final authority. If the model produced
  // something subtly wrong, the defaults stand rather than a broken slide.
  const validated = SLIDE_REGISTRY[slide.kind].configSchema.safeParse(config);

  return {
    kind: slide.kind,
    config: (validated.success ? validated.data : defaults) as SlideConfig,
  };
}

/* ------------------------------------------------------------------ */
/* Improving one slide                                                 */
/* ------------------------------------------------------------------ */

const zSuggestions = z.object({
  prompts: z.array(z.string().trim().min(1).max(200)).min(1).max(5),
  options: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
});

export interface ImproveInput {
  kind: SlideKind;
  prompt: string;
  options?: string[];
}

export async function improveSlide(input: ImproveInput): Promise<{
  prompts: string[];
  options?: string[];
  provider: ProviderName;
}> {
  const definition = definitionFor(input.kind);

  const system = `You improve questions for live audience polls.

Return ONLY JSON: {"prompts": ["...", "..."], "options": ["..."]}

Give three rewrites of the question: clearer, shorter, and more engaging.
Keep every rewrite under 15 words — they are read from the back of a hall.
If the slide has options, suggest a better set, 1-4 words each.
Never change what the question is asking.`;

  const prompt = [
    `Slide type: ${definition.label} — ${definition.blurb}`,
    `Current question: ${input.prompt || '(empty)'}`,
    input.options?.length ? `Current options: ${input.options.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Groq first: this runs while the author is typing, so speed matters more
  // than the last few percent of quality.
  const result = await complete(
    { system, prompt, temperature: 0.8, maxTokens: 700, json: true },
    'groq',
  );

  const parsed = zSuggestions.safeParse(parseJson(result.text));

  if (!parsed.success) {
    throw new HttpError(502, 'The AI returned something unusable.', 'ai_bad_output');
  }

  return { ...parsed.data, provider: result.provider };
}

/* ------------------------------------------------------------------ */
/* Summarising open text                                               */
/* ------------------------------------------------------------------ */

const zSummary = z.object({
  headline: z.string().trim().min(1).max(200),
  themes: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(60),
        count: z.number().int().min(0),
        example: z.string().trim().max(300).optional(),
      }),
    )
    .max(8),
  sentiment: z.enum(['positive', 'mixed', 'negative', 'neutral']).optional(),
});

export type TextSummary = z.infer<typeof zSummary> & { provider: ProviderName };

/**
 * Groups a wall of free text into themes.
 *
 * This is the feature that earns its place: two hundred open answers are
 * unreadable on a projector, and a presenter cannot summarise them live.
 */
export async function summariseResponses(
  question: string,
  answers: string[],
): Promise<TextSummary> {
  if (answers.length === 0) {
    throw new HttpError(422, 'There are no answers to summarise yet.', 'no_answers');
  }

  const system = `You summarise audience answers for a presenter, live, in front of a room.

Return ONLY JSON:
{
  "headline": "one sentence a presenter can read aloud",
  "themes": [{"label": "short theme name", "count": 5, "example": "a representative answer"}],
  "sentiment": "positive" | "mixed" | "negative" | "neutral"
}

Rules:
- Group similar answers into at most 6 themes, biggest first.
- Counts must add up to roughly the number of answers given.
- Use the room's own words for theme labels, not corporate paraphrase.
- The headline states what the room actually said. Never flatter them.`;

  // Capped so a very large room cannot exceed a free tier's context window.
  // The sample is taken across the list rather than the first N, so a late
  // surge of one opinion is still represented.
  const sample = evenSample(answers, 300);

  const prompt = [
    `Question: ${question}`,
    `Total answers: ${String(answers.length)}`,
    sample.length < answers.length ? `Showing a sample of ${String(sample.length)}.` : '',
    '',
    'Answers:',
    ...sample.map((answer) => `- ${answer.slice(0, 300)}`),
  ]
    .filter(Boolean)
    .join('\n');

  const result = await complete(
    { system, prompt, temperature: 0.4, maxTokens: 1500, json: true },
    'gemini',
  );

  const parsed = zSummary.safeParse(parseJson(result.text));

  if (!parsed.success) {
    throw new HttpError(502, 'The AI returned something unusable.', 'ai_bad_output');
  }

  return { ...parsed.data, provider: result.provider };
}

/** Takes `limit` items spread evenly across the list, never just the first. */
export function evenSample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;

  const step = items.length / limit;
  const sample: T[] = [];

  for (let i = 0; i < limit; i += 1) {
    const item = items[Math.floor(i * step)];
    if (item !== undefined) sample.push(item);
  }

  return sample;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Reads JSON out of a model's reply.
 *
 * Native JSON mode covers most of it, but Ollama's smaller models still wrap
 * their output in code fences or add a sentence before the object. Rather
 * than fail the whole request over formatting, this digs the object out.
 */
export function parseJson(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to the recovery attempts below.
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // Still not valid; try the brace scan.
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');

  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // Genuinely unparseable.
    }
  }

  throw new AiError('bad_json', 'The AI did not return valid JSON.', true);
}

/* ------------------------------------------------------------------ */
/* Quota                                                               */
/* ------------------------------------------------------------------ */

/**
 * Per-user daily AI allowance.
 *
 * The free tiers are shared across everyone on this server, so one user
 * generating fifty decks would leave the rest without AI for the day — and
 * they would discover it mid-presentation. A per-user cap keeps the quota
 * spread fairly, and admins can see who is near it.
 */
export const DAILY_AI_LIMIT = 100;

export interface QuotaState {
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Counts one request against the user's day, and refuses past the cap.
 *
 * Uses a single atomic update rather than read-then-write, so two requests
 * arriving together cannot both read the same count and both pass.
 */
export async function consumeQuota(userId: string): Promise<QuotaState> {
  const { User } = await import('../../models/index.js');

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // Reset first, in its own conditional update: a user whose window has
  // rolled over starts the day at zero without a separate read.
  await User.updateOne(
    { _id: userId, $or: [{ aiRequestsResetAt: null }, { aiRequestsResetAt: { $lt: startOfDay } }] },
    { $set: { aiRequestsToday: 0, aiRequestsResetAt: new Date() } },
  );

  const updated = await User.findOneAndUpdate(
    { _id: userId, aiRequestsToday: { $lt: DAILY_AI_LIMIT } },
    { $inc: { aiRequestsToday: 1 } },
    { new: true, projection: { aiRequestsToday: 1 } },
  ).lean();

  if (!updated) {
    throw new HttpError(
      429,
      `You have used all ${String(DAILY_AI_LIMIT)} AI requests for today. They reset at midnight.`,
      'ai_quota_exhausted',
    );
  }

  const used = updated.aiRequestsToday;
  return { used, limit: DAILY_AI_LIMIT, remaining: Math.max(0, DAILY_AI_LIMIT - used) };
}

/** The user's current allowance, without spending any of it. */
export async function quotaFor(userId: string): Promise<QuotaState> {
  const { User } = await import('../../models/index.js');

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const user = await User.findById(userId).select('aiRequestsToday aiRequestsResetAt').lean();

  // A stale window means the count belongs to a previous day.
  // A missing user cannot have spent anything; a stale window means the
  // count belongs to a previous day.
  const resetAt = user?.aiRequestsResetAt ?? null;
  const stale = !user || resetAt === null || resetAt < startOfDay;
  const used = stale ? 0 : user.aiRequestsToday;

  return { used, limit: DAILY_AI_LIMIT, remaining: Math.max(0, DAILY_AI_LIMIT - used) };
}
