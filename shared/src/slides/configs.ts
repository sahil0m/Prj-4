import { z } from 'zod';
import {
  zSlideBase,
  zOption,
  zItem,
  zStatement,
  zResultLayoutBar,
  zOpenTextLayout,
  zLocalId,
} from './primitives.js';

/**
 * A URL that is allowed to be empty while the author is still building the
 * slide. Completeness is enforced separately by `validateSlideReady`, so the
 * editor can hold a half-finished slide without throwing.
 */
export const zDraftUrl = z
  .union([z.literal(''), z.string().url().max(2000)])
  .optional()
  .default('');

/* ------------------------------------------------------------------ */
/* Free text                                                           */
/* ------------------------------------------------------------------ */

export const zWordCloud = zSlideBase.extend({
  kind: z.literal('word_cloud'),
  entriesPerPerson: z.number().int().min(1).max(10).default(1),
  maxCharacters: z.number().int().min(1).max(60).default(30),
  allowMultipleSubmissions: z.boolean().default(false),
});

export const zOpenText = zSlideBase.extend({
  kind: z.literal('open_text'),
  maxCharacters: z.number().int().min(10).max(1000).default(250),
  allowMultipleSubmissions: z.boolean().default(false),
  layout: zOpenTextLayout.default('cards'),
  allowUpvotes: z.boolean().default(true),
});

/* ------------------------------------------------------------------ */
/* Choice                                                              */
/* ------------------------------------------------------------------ */

export const zMultipleChoice = zSlideBase.extend({
  kind: z.literal('multiple_choice'),
  options: z.array(zOption).min(2).max(20),
  multiSelect: z.boolean().default(false),
  maxSelections: z.number().int().min(1).max(20).default(1),
  layout: zResultLayoutBar.default('bars'),
  showPercentages: z.boolean().default(true),
  showCounts: z.boolean().default(false),
});

export const zImageChoice = zSlideBase.extend({
  kind: z.literal('image_choice'),
  options: z.array(zOption.extend({ imageUrl: zDraftUrl })).max(12).default([]),
  multiSelect: z.boolean().default(false),
  showPercentages: z.boolean().default(true),
});

export const zTrueFalse = zSlideBase.extend({
  kind: z.literal('true_false'),
  trueLabel: z.string().trim().max(60).default('True'),
  falseLabel: z.string().trim().max(60).default('False'),
  layout: zResultLayoutBar.default('bars'),
});

export const zWhoWillWin = zSlideBase.extend({
  kind: z.literal('who_will_win'),
  options: z.array(zOption).min(2).max(8),
});

/* ------------------------------------------------------------------ */
/* Rating, ordering, allocation                                        */
/* ------------------------------------------------------------------ */

export const zScales = zSlideBase.extend({
  kind: z.literal('scales'),
  statements: z.array(zStatement).min(1).max(12),
  min: z.number().int().min(0).max(10).default(1),
  max: z.number().int().min(2).max(100).default(5),
  step: z.number().min(0.1).max(10).default(1),
  minLabel: z.string().trim().max(60).default('Strongly disagree'),
  maxLabel: z.string().trim().max(60).default('Strongly agree'),
  layout: z.enum(['bars', 'spider']).default('bars'),
});

export const zRanking = zSlideBase.extend({
  kind: z.literal('ranking'),
  items: z.array(zItem).min(2).max(12),
});

export const zPoints100 = zSlideBase.extend({
  kind: z.literal('points_100'),
  items: z.array(zItem).min(2).max(10),
  totalPoints: z.number().int().min(10).max(1000).default(100),
});

export const zGrid2x2 = zSlideBase.extend({
  kind: z.literal('grid_2x2'),
  items: z.array(zItem).min(1).max(12),
  xLabelLow: z.string().trim().max(40).default('Low effort'),
  xLabelHigh: z.string().trim().max(40).default('High effort'),
  yLabelLow: z.string().trim().max(40).default('Low value'),
  yLabelHigh: z.string().trim().max(40).default('High value'),
  backgroundImageUrl: zDraftUrl,
});

export const zPinImage = zSlideBase.extend({
  kind: z.literal('pin_image'),
  imageUrl: zDraftUrl,
  pinsPerPerson: z.number().int().min(1).max(10).default(1),
  showHeatmap: z.boolean().default(true),
});

export const zGuessNumber = zSlideBase.extend({
  kind: z.literal('guess_number'),
  min: z.number().default(0),
  max: z.number().default(1000),
  unit: z.string().trim().max(20).default(''),
  correctValue: z.number().optional(),
});

export const zStarRating = zSlideBase.extend({
  kind: z.literal('star_rating'),
  stars: z.number().int().min(3).max(10).default(5),
});

export const zNps = zSlideBase.extend({
  kind: z.literal('nps'),
  lowLabel: z.string().trim().max(60).default('Not at all likely'),
  highLabel: z.string().trim().max(60).default('Extremely likely'),
});

/* ------------------------------------------------------------------ */
/* Quiz                                                                */
/* ------------------------------------------------------------------ */

const zQuizBase = zSlideBase.extend({
  countdownSeconds: z.number().int().min(5).max(300).default(20),
  pointsMax: z.number().int().min(0).max(10000).default(1000),
  pointsMin: z.number().int().min(0).max(10000).default(500),
});

export const zQuizSelect = zQuizBase.extend({
  kind: z.literal('quiz_select'),
  options: z.array(zOption).min(2).max(8),
});

export const zQuizType = zQuizBase.extend({
  kind: z.literal('quiz_type'),
  acceptedAnswers: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  caseSensitive: z.boolean().default(false),
  /** Allows small typos through, measured by edit distance. */
  fuzzyTolerance: z.number().int().min(0).max(3).default(1),
});

export const zQuizMatch = zQuizBase.extend({
  kind: z.literal('quiz_match'),
  pairs: z
    .array(
      z.object({
        id: zLocalId,
        left: z.string().trim().min(1).max(120),
        right: z.string().trim().min(1).max(120),
      }),
    )
    .min(2)
    .max(8),
});

export const zQuizOrder = zQuizBase.extend({
  kind: z.literal('quiz_order'),
  /** Stored in the correct order; shuffled for participants. */
  steps: z.array(zItem).min(2).max(10),
});

export const zLeaderboard = zSlideBase.extend({
  kind: z.literal('leaderboard'),
  topN: z.number().int().min(3).max(50).default(10),
  showPoints: z.boolean().default(true),
});

/* ------------------------------------------------------------------ */
/* Audience driven                                                     */
/* ------------------------------------------------------------------ */

export const zQa = zSlideBase.extend({
  kind: z.literal('qa'),
  moderated: z.boolean().default(false),
  allowUpvotes: z.boolean().default(true),
  allowAnonymous: z.boolean().default(true),
});

export const zFormField = z.object({
  id: zLocalId,
  label: z.string().trim().min(1).max(120),
  type: z.enum(['text', 'email', 'number', 'select', 'checkbox']),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().max(120)).max(20).optional(),
});

export const zQuickForm = zSlideBase.extend({
  kind: z.literal('quick_form'),
  fields: z.array(zFormField).min(1).max(12),
  submitLabel: z.string().trim().max(40).default('Submit'),
});

/* ------------------------------------------------------------------ */
/* Ours only                                                           */
/* ------------------------------------------------------------------ */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const zDrawing = zSlideBase.extend({
  kind: z.literal('drawing'),
  backgroundImageUrl: zDraftUrl,
  strokeColors: z.array(z.string().regex(HEX_COLOR)).max(12).default([]),
});

export const zMapPin = zSlideBase.extend({
  kind: z.literal('map_pin'),
  centerLat: z.number().min(-90).max(90).default(20),
  centerLng: z.number().min(-180).max(180).default(0),
  zoom: z.number().int().min(1).max(18).default(2),
  pinsPerPerson: z.number().int().min(1).max(5).default(1),
});

/* ------------------------------------------------------------------ */
/* Content slides                                                      */
/* ------------------------------------------------------------------ */

export const zHeading = zSlideBase.extend({
  kind: z.literal('heading'),
  align: z.enum(['left', 'center']).default('center'),
});

export const zParagraph = zSlideBase.extend({
  kind: z.literal('paragraph'),
  body: z.string().max(5000).default(''),
});

export const zBullets = zSlideBase.extend({
  kind: z.literal('bullets'),
  items: z.array(z.string().trim().max(300)).min(1).max(12),
  numbered: z.boolean().default(false),
  revealOneByOne: z.boolean().default(false),
});

export const zBigNumber = zSlideBase.extend({
  kind: z.literal('big_number'),
  value: z.string().trim().max(20).default('42'),
  caption: z.string().trim().max(200).default(''),
});

export const zQuote = zSlideBase.extend({
  kind: z.literal('quote'),
  quote: z.string().trim().max(1000).default(''),
  attribution: z.string().trim().max(200).default(''),
});

export const zImage = zSlideBase.extend({
  kind: z.literal('image'),
  imageUrl: zDraftUrl,
  alt: z.string().trim().max(300).default(''),
  fit: z.enum(['contain', 'cover']).default('contain'),
});

export const zVideo = zSlideBase.extend({
  kind: z.literal('video'),
  url: zDraftUrl,
  autoplay: z.boolean().default(false),
  loop: z.boolean().default(false),
});

export const zInstructions = zSlideBase.extend({
  kind: z.literal('instructions'),
  showQr: z.boolean().default(true),
  showCode: z.boolean().default(true),
});

export const zSectionBreak = zSlideBase.extend({
  kind: z.literal('section_break'),
  label: z.string().trim().max(120).default(''),
});

export const zEmbed = zSlideBase.extend({
  kind: z.literal('embed'),
  url: zDraftUrl,
  provider: z.enum(['generic', 'powerpoint', 'google_slides', 'miro']).default('generic'),
});

export const zCompare = zSlideBase.extend({
  kind: z.literal('compare'),
  slideIdA: z.string().max(64).default(''),
  slideIdB: z.string().max(64).default(''),
  labelA: z.string().trim().max(60).default('Before'),
  labelB: z.string().trim().max(60).default('After'),
});

/* ------------------------------------------------------------------ */
/* The union                                                           */
/* ------------------------------------------------------------------ */

export const zSlideConfig = z.discriminatedUnion('kind', [
  zWordCloud,
  zOpenText,
  zMultipleChoice,
  zImageChoice,
  zTrueFalse,
  zWhoWillWin,
  zScales,
  zRanking,
  zPoints100,
  zGrid2x2,
  zPinImage,
  zGuessNumber,
  zStarRating,
  zNps,
  zQuizSelect,
  zQuizType,
  zQuizMatch,
  zQuizOrder,
  zLeaderboard,
  zQa,
  zQuickForm,
  zDrawing,
  zMapPin,
  zHeading,
  zParagraph,
  zBullets,
  zBigNumber,
  zQuote,
  zImage,
  zVideo,
  zInstructions,
  zSectionBreak,
  zEmbed,
  zCompare,
]);

export type SlideConfig = z.infer<typeof zSlideConfig>;

/** Narrow a SlideConfig to one kind. */
export type ConfigOf<K extends SlideConfig['kind']> = Extract<SlideConfig, { kind: K }>;
