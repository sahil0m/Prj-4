/**
 * Every slide kind the product supports.
 *
 * This list is the spine of the codebase. Adding a value here and then
 * satisfying the compiler is the complete checklist for shipping a new
 * slide type — the editor form, the participant input, the result chart,
 * the export columns and the AI schema are all keyed off it.
 */
export const SLIDE_KINDS = [
  // --- free text -----------------------------------------------------
  'word_cloud',
  'open_text',

  // --- choice --------------------------------------------------------
  'multiple_choice',
  'image_choice',
  'true_false',
  'who_will_win',

  // --- rating, ordering, allocation ----------------------------------
  'scales',
  'ranking',
  'points_100',
  'grid_2x2',
  'pin_image',
  'guess_number',
  'star_rating',
  'nps',

  // --- quiz ----------------------------------------------------------
  'quiz_select',
  'quiz_type',
  'quiz_match',
  'quiz_order',
  'leaderboard',

  // --- audience driven -----------------------------------------------
  'qa',
  'quick_form',

  // --- ours only -----------------------------------------------------
  'drawing',
  'map_pin',

  // --- content (no participation) ------------------------------------
  'heading',
  'paragraph',
  'bullets',
  'big_number',
  'quote',
  'image',
  'video',
  'instructions',
  'section_break',
  'embed',
  'compare',
] as const;

export type SlideKind = (typeof SLIDE_KINDS)[number];

/** Families group kinds for the editor's "add slide" menu. */
export const SLIDE_FAMILIES = [
  'text',
  'choice',
  'rating',
  'quiz',
  'audience',
  'creative',
  'content',
] as const;

export type SlideFamily = (typeof SLIDE_FAMILIES)[number];

export const FAMILY_LABELS: Record<SlideFamily, string> = {
  text: 'Words & sentences',
  choice: 'Pick an option',
  rating: 'Rate, rank & place',
  quiz: 'Quiz',
  audience: 'From the audience',
  creative: 'Draw & map',
  content: 'Content',
};
