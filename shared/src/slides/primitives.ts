import { z } from 'zod';

/** A short, stable id generated on the client for list items. */
export const zLocalId = z.string().min(1).max(64);

/**
 * A URL that is safe to place in an href or src attribute.
 *
 * Zod's .url() accepts ANY scheme, including `javascript:` and `data:`,
 * both of which are script-execution vectors when rendered. We allow only
 * http and https.
 */
export const zSafeUrl = z
  .string()
  .max(2000)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a valid web address.' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only http and https links are allowed.',
      });
    }
  });

/**
 * A real number. Plain z.number() accepts NaN and Infinity, which silently
 * poison every average and total computed from them.
 */
export const zFiniteNumber = z
  .number()
  .refine((n) => Number.isFinite(n), 'Must be a finite number.');

/** A finite number constrained to a range. */
export const zFiniteInRange = (min: number, max: number) =>
  zFiniteNumber.refine((n) => n >= min && n <= max, `Must be between ${min} and ${max}.`);

export const zOption = z.object({
  id: zLocalId,
  label: z.string().trim().min(1).max(200),
  imageUrl: zSafeUrl.optional(),
  /** Quiz only: marks this option as a correct answer. */
  correct: z.boolean().optional(),
});
export type Option = z.infer<typeof zOption>;

export const zItem = z.object({
  id: zLocalId,
  label: z.string().trim().min(1).max(200),
});
export type Item = z.infer<typeof zItem>;

export const zStatement = z.object({
  id: zLocalId,
  label: z.string().trim().min(1).max(200),
});
export type Statement = z.infer<typeof zStatement>;

/** Shared by every slide kind. */
export const zSlideBase = z.object({
  /** Big text shown on the presenter screen. */
  prompt: z.string().trim().max(500).default(''),
  /** Optional smaller line under the prompt. */
  subtitle: z.string().trim().max(500).default(''),
  /** Presenter-only notes. */
  speakerNotes: z.string().max(5000).default(''),
  /** Countdown attached to the slide, in seconds. 0 = no timer. */
  timerSeconds: z.number().int().min(0).max(3600).default(0),
  /** Skipped slides stay in the deck but are jumped over when presenting. */
  skipped: z.boolean().default(false),
  /** Participation can be closed per slide. */
  participationOpen: z.boolean().default(true),
  /** Hide the live result until the presenter reveals it. */
  resultsHiddenByDefault: z.boolean().default(false),
});

export const zResultLayoutBar = z.enum(['bars', 'donut', 'pie', 'dots']);
export type ResultLayoutBar = z.infer<typeof zResultLayoutBar>;

export const zOpenTextLayout = z.enum(['cards', 'bubbles', 'grid', 'ticker']);
export type OpenTextLayout = z.infer<typeof zOpenTextLayout>;
