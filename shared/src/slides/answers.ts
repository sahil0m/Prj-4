import { z } from 'zod';
import { zLocalId, zFiniteNumber, zFiniteInRange } from './primitives.js';

/**
 * The shape of one participant's answer, per slide kind.
 *
 * These are validated on the server before anything is stored, so a
 * malicious client cannot inject an unexpected shape into the database
 * or the live aggregate.
 */

/* --- free text ------------------------------------------------------ */

export const zWordCloudAnswer = z.object({
  kind: z.literal('word_cloud'),
  words: z.array(z.string().trim().min(1).max(60)).min(1).max(10),
});

export const zOpenTextAnswer = z.object({
  kind: z.literal('open_text'),
  text: z.string().trim().min(1).max(1000),
});

/* --- choice --------------------------------------------------------- */

export const zMultipleChoiceAnswer = z.object({
  kind: z.literal('multiple_choice'),
  optionIds: z.array(zLocalId).min(1).max(20),
});

export const zImageChoiceAnswer = z.object({
  kind: z.literal('image_choice'),
  optionIds: z.array(zLocalId).min(1).max(12),
});

export const zTrueFalseAnswer = z.object({
  kind: z.literal('true_false'),
  value: z.boolean(),
});

export const zWhoWillWinAnswer = z.object({
  kind: z.literal('who_will_win'),
  optionId: zLocalId,
});

/* --- rating, ordering, allocation ----------------------------------- */

export const zScalesAnswer = z.object({
  kind: z.literal('scales'),
  /** statementId -> chosen value */
  values: z.record(zLocalId, zFiniteNumber),
});

export const zRankingAnswer = z.object({
  kind: z.literal('ranking'),
  /** item ids, best first */
  order: z.array(zLocalId).min(1).max(12),
});

export const zPoints100Answer = z.object({
  kind: z.literal('points_100'),
  /** itemId -> points awarded */
  allocation: z.record(zLocalId, z.number().int().min(0).max(1000)),
});

export const zGrid2x2Answer = z.object({
  kind: z.literal('grid_2x2'),
  /** itemId -> position, each axis normalised 0..1 */
  positions: z.record(
    zLocalId,
    z.object({ x: zFiniteInRange(0, 1), y: zFiniteInRange(0, 1) }),
  ),
});

export const zPinImageAnswer = z.object({
  kind: z.literal('pin_image'),
  pins: z
    .array(z.object({ x: zFiniteInRange(0, 1), y: zFiniteInRange(0, 1) }))
    .min(1)
    .max(10),
});

export const zGuessNumberAnswer = z.object({
  kind: z.literal('guess_number'),
  value: zFiniteNumber,
});

export const zStarRatingAnswer = z.object({
  kind: z.literal('star_rating'),
  stars: z.number().int().min(1).max(10),
});

export const zNpsAnswer = z.object({
  kind: z.literal('nps'),
  score: z.number().int().min(0).max(10),
});

/* --- quiz ----------------------------------------------------------- */

export const zQuizSelectAnswer = z.object({
  kind: z.literal('quiz_select'),
  optionIds: z.array(zLocalId).min(1).max(8),
  /** Milliseconds from countdown start to submission. Used for scoring. */
  elapsedMs: z.number().int().min(0).max(600_000),
});

export const zQuizTypeAnswer = z.object({
  kind: z.literal('quiz_type'),
  text: z.string().trim().min(1).max(200),
  elapsedMs: z.number().int().min(0).max(600_000),
});

export const zQuizMatchAnswer = z.object({
  kind: z.literal('quiz_match'),
  /** pairId -> the right-hand label the participant matched to it */
  matches: z.record(zLocalId, z.string().trim().max(120)),
  elapsedMs: z.number().int().min(0).max(600_000),
});

export const zQuizOrderAnswer = z.object({
  kind: z.literal('quiz_order'),
  order: z.array(zLocalId).min(2).max(10),
  elapsedMs: z.number().int().min(0).max(600_000),
});

/* --- audience driven ------------------------------------------------ */

export const zQuickFormAnswer = z.object({
  kind: z.literal('quick_form'),
  /** fieldId -> value */
  fields: z.record(zLocalId, z.union([z.string().max(1000), zFiniteNumber, z.boolean()])),
});

/* --- ours only ------------------------------------------------------ */

export const zDrawingAnswer = z.object({
  kind: z.literal('drawing'),
  /** Simplified strokes, each a flat list of normalised x,y pairs. */
  strokes: z
    .array(
      z.object({
        color: z.string().max(16),
        width: zFiniteInRange(0.1, 20),
        points: z
          .array(zFiniteInRange(0, 1))
          .min(4)
          .max(4000)
          .refine((p) => p.length % 2 === 0, 'Points must be x,y pairs.'),
      }),
    )
    .min(1)
    .max(200),
});

export const zMapPinAnswer = z.object({
  kind: z.literal('map_pin'),
  pins: z
    .array(z.object({ lat: zFiniteInRange(-90, 90), lng: zFiniteInRange(-180, 180) }))
    .min(1)
    .max(5),
});

/* --- union ---------------------------------------------------------- */

export const zAnswer = z.discriminatedUnion('kind', [
  zWordCloudAnswer,
  zOpenTextAnswer,
  zMultipleChoiceAnswer,
  zImageChoiceAnswer,
  zTrueFalseAnswer,
  zWhoWillWinAnswer,
  zScalesAnswer,
  zRankingAnswer,
  zPoints100Answer,
  zGrid2x2Answer,
  zPinImageAnswer,
  zGuessNumberAnswer,
  zStarRatingAnswer,
  zNpsAnswer,
  zQuizSelectAnswer,
  zQuizTypeAnswer,
  zQuizMatchAnswer,
  zQuizOrderAnswer,
  zQuickFormAnswer,
  zDrawingAnswer,
  zMapPinAnswer,
]);

export type Answer = z.infer<typeof zAnswer>;
export type AnswerOf<K extends Answer['kind']> = Extract<Answer, { kind: K }>;

/** Slide kinds that accept an answer from the audience. */
export type AnswerableKind = Answer['kind'];
