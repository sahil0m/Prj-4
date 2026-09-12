import { z } from 'zod';

/** A short, stable id generated on the client for list items. */
export const zLocalId = z.string().min(1).max(64);

export const zOption = z.object({
  id: zLocalId,
  label: z.string().trim().min(1).max(200),
  imageUrl: z.string().url().max(2000).optional(),
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
