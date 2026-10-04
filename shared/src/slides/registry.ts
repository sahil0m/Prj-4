import type { ZodTypeAny } from 'zod';
import type { SlideKind, SlideFamily } from './kinds.js';
import { SLIDE_KINDS } from './kinds.js';
import * as C from './configs.js';
import type { SlideConfig } from './configs.js';

/**
 * One entry per slide kind. This table is the single source of truth the
 * rest of the product reads from:
 *
 *   - the editor renders its form from `configSchema` + `defaults`
 *   - the join app picks an input from `kind`
 *   - the present view picks a chart from `kind`
 *   - the exporter uses `exportColumns`
 *   - the aggregator uses `aggregate`
 *
 * Adding a slide type means adding a kind to SLIDE_KINDS, a schema in
 * configs.ts, an answer shape in answers.ts, and an entry here. The
 * compiler then points at every remaining place that needs attention.
 */
export interface SlideDefinition<K extends SlideKind = SlideKind> {
  kind: K;
  /** Shown in the "add slide" menu. */
  label: string;
  /** One line describing what the audience does. */
  blurb: string;
  /**
   * The fuller explanation, behind the information button in the picker.
   *
   * Written for someone deciding whether this is the slide they want: what
   * they set up, what the audience does on their phone, and what appears
   * on the projector. The blurb has to fit on a card, so it cannot answer
   * any of those properly.
   */
  details: string;
  family: SlideFamily;
  /** Lucide icon name used across the editor and menus. */
  icon: string;
  /** Does the audience submit something? Content slides do not. */
  answerable: boolean;
  /** Quiz slides carry a countdown and a score. */
  isQuiz: boolean;
  /** Can this slide's answers be used to segment other slides? */
  segmentable: boolean;
  /** Zod schema for this kind's config. */
  configSchema: ZodTypeAny;
  /** A ready-to-insert config, used when the user adds the slide. */
  defaults: () => SlideConfig;
  /** Column headers used by the spreadsheet exporter. */
  exportColumns: string[];
}

/** Deterministic ids for seeded options so defaults are stable in tests. */
const id = (n: number) => `o${n}`;

const base = {
  prompt: '',
  subtitle: '',
  speakerNotes: '',
  timerSeconds: 0,
  skipped: false,
  participationOpen: true,
  resultsHiddenByDefault: false,
} as const;

const quizBase = { ...base, countdownSeconds: 20, pointsMax: 1000, pointsMin: 500 } as const;

export const SLIDE_REGISTRY: { [K in SlideKind]: SlideDefinition<K> } = {
  /* ---------------- free text ---------------- */
  word_cloud: {
    kind: 'word_cloud',
    label: 'Word Cloud',
    blurb: 'People type short words. Popular words grow bigger.',
    details:
      'You write a prompt. Each person types one or more short words on their phone and sends them. The words appear on the projector as they arrive, and a word several people send grows larger than the rest. Good for opening a lecture, since one word is the least a room can be asked for.',
    family: 'text',
    icon: 'Cloud',
    answerable: true,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zWordCloud,
    defaults: () => ({
      ...base,
      kind: 'word_cloud',
      prompt: 'In one word, how are you feeling?',
      entriesPerPerson: 1,
      maxCharacters: 30,
      allowMultipleSubmissions: false,
    }),
    exportColumns: ['Word'],
  },
  open_text: {
    kind: 'open_text',
    label: 'Open Text',
    blurb: 'People write a sentence. Answers group by meaning.',
    details:
      'You ask a question that needs a sentence rather than a word. Answers appear on the projector as cards, grouped where several people have said much the same thing, so a hundred responses stay readable. Nothing is scored; it is for hearing the room.',
    family: 'text',
    icon: 'MessageSquareText',
    answerable: true,
    isQuiz: false,
    segmentable: true,
    configSchema: C.zOpenText,
    defaults: () => ({
      ...base,
      kind: 'open_text',
      prompt: 'What is on your mind?',
      maxCharacters: 250,
      allowMultipleSubmissions: false,
      layout: 'cards',
      allowUpvotes: true,
    }),
    exportColumns: ['Response', 'Upvotes'],
  },

  /* ---------------- choice ---------------- */
  multiple_choice: {
    kind: 'multiple_choice',
    label: 'Multiple Choice',
    blurb: 'Tap one option, or several. Shown as bars or a donut.',
    details:
      'You write a question and the options. Each person taps one, or several if you allow it. The projector shows the counts filling in live, as bars or a donut, and you can hide them until everyone has answered so the first votes do not sway the rest.',
    family: 'choice',
    icon: 'ListChecks',
    answerable: true,
    isQuiz: false,
    segmentable: true,
    configSchema: C.zMultipleChoice,
    defaults: () => ({
      ...base,
      kind: 'multiple_choice',
      prompt: 'Which do you prefer?',
      options: [
        { id: id(1), label: 'Option one' },
        { id: id(2), label: 'Option two' },
        { id: id(3), label: 'Option three' },
      ],
      multiSelect: false,
      maxSelections: 1,
      layout: 'bars',
      showPercentages: true,
      showCounts: false,
    }),
    exportColumns: ['Option', 'Votes', 'Share'],
  },
  image_choice: {
    kind: 'image_choice',
    label: 'Image Choice',
    blurb: 'The options are pictures instead of words.',
    details:
      'The same as Multiple Choice, but each option is a picture you upload rather than a line of text. The audience taps the image on their phone, and the projector shows the pictures with their share of the vote. Use it when the options are visual: designs, charts, photographs.',
    family: 'choice',
    icon: 'Images',
    answerable: true,
    isQuiz: false,
    segmentable: true,
    configSchema: C.zImageChoice,
    defaults: () => ({
      ...base,
      kind: 'image_choice',
      prompt: 'Which design do you prefer?',
      options: [],
      multiSelect: false,
      showPercentages: true,
    }),
    exportColumns: ['Option', 'Votes', 'Share'],
  },
  true_false: {
    kind: 'true_false',
    label: 'True or False',
    blurb: 'A fast two-option question.',
    details:
      'One statement, two buttons. The fastest question to ask and to answer, so it suits checking a single point mid-lecture. The projector shows the split between the two sides as the answers arrive.',
    family: 'choice',
    icon: 'ToggleLeft',
    answerable: true,
    isQuiz: false,
    segmentable: true,
    configSchema: C.zTrueFalse,
    defaults: () => ({
      ...base,
      kind: 'true_false',
      prompt: 'True or false?',
      trueLabel: 'True',
      falseLabel: 'False',
      layout: 'bars',
    }),
    exportColumns: ['Answer', 'Votes', 'Share'],
  },
  who_will_win: {
    kind: 'who_will_win',
    label: 'Who Will Win',
    blurb: 'A multiple choice styled as a race, with a winner.',
    details:
      'A multiple choice drawn as a race. The options run across the projector and the leader pulls ahead as votes arrive, with a winner at the end. The audience simply picks an option; the difference is entirely in how the room watches the result.',
    family: 'choice',
    icon: 'Trophy',
    answerable: true,
    isQuiz: false,
    segmentable: true,
    configSchema: C.zWhoWillWin,
    defaults: () => ({
      ...base,
      kind: 'who_will_win',
      prompt: 'Who will win?',
      options: [
        { id: id(1), label: 'Contender one' },
        { id: id(2), label: 'Contender two' },
      ],
    }),
    exportColumns: ['Contender', 'Votes', 'Share'],
  },

  /* ---------------- rating / ordering ---------------- */
  scales: {
    kind: 'scales',
    label: 'Scales',
    blurb: 'Rate several statements on a scale.',
    details:
      'You list several statements and set the range, such as one to five or disagree to agree. Each person rates every statement on their phone. The projector shows the average for each, so the statements can be compared against one another rather than read one at a time.',
    family: 'rating',
    icon: 'SlidersHorizontal',
    answerable: true,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zScales,
    defaults: () => ({
      ...base,
      kind: 'scales',
      prompt: 'How much do you agree?',
      statements: [
        { id: id(1), label: 'I know what is expected of me' },
        { id: id(2), label: 'I have what I need to do my work' },
      ],
      min: 1,
      max: 5,
      step: 1,
      minLabel: 'Strongly disagree',
      maxLabel: 'Strongly agree',
      layout: 'bars',
    }),
    exportColumns: ['Statement', 'Average', 'Responses'],
  },
  ranking: {
    kind: 'ranking',
    label: 'Ranking',
    blurb: 'Drag items into order. One ranking for the room.',
    details:
      'You list the items. Each person drags them into their own order on their phone, and the projector shows one combined ranking for the room with the points each item collected. Use it when the question is what matters most, not what is popular.',
    family: 'rating',
    icon: 'ArrowUpDown',
    answerable: true,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zRanking,
    defaults: () => ({
      ...base,
      kind: 'ranking',
      prompt: 'Put these in order of importance',
      items: [
        { id: id(1), label: 'First item' },
        { id: id(2), label: 'Second item' },
        { id: id(3), label: 'Third item' },
      ],
    }),
    exportColumns: ['Item', 'Rank', 'Score'],
  },
  points_100: {
    kind: 'points_100',
    label: '100 Points',
    blurb: 'Share 100 points between items. Forces real choices.',
    details:
      'You list the items and each person has a hundred points to divide between them. Spending on one means not spending on another, which is what makes this different from rating everything highly. The projector shows the totals the room allocated.',
    family: 'rating',
    icon: 'Coins',
    answerable: true,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zPoints100,
    defaults: () => ({
      ...base,
      kind: 'points_100',
      prompt: 'Spend 100 points across these',
      items: [
        { id: id(1), label: 'First item' },
        { id: id(2), label: 'Second item' },
        { id: id(3), label: 'Third item' },
      ],
      totalPoints: 100,
    }),
    exportColumns: ['Item', 'Total points', 'Average'],
  },
  grid_2x2: {
    kind: 'grid_2x2',
    label: '2 by 2 Grid',
    blurb: 'Place items on a square with two axes.',
    details:
      'You name the two axes, such as effort against value. Each person places the items on a square on their phone. The projector shows every placement as a dot, so the clusters and the outliers are visible at once.',
    family: 'rating',
    icon: 'Grid2x2',
    answerable: true,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zGrid2x2,
    defaults: () => ({
      ...base,
      kind: 'grid_2x2',
      prompt: 'Place each item on the grid',
      items: [
        { id: id(1), label: 'First item' },
        { id: id(2), label: 'Second item' },
      ],
      xLabelLow: 'Low effort',
      xLabelHigh: 'High effort',
      yLabelLow: 'Low value',
      yLabelHigh: 'High value',
      backgroundImageUrl: '',
    }),
    exportColumns: ['Item', 'Average X', 'Average Y', 'Responses'],
  },
  pin_image: {
    kind: 'pin_image',
    label: 'Pin on Image',
    blurb: 'Tap anywhere on a picture to drop a pin.',
    details:
      'You upload a picture. Each person taps a point on it, and the pin appears on the projector over the same picture. Use it for anything positional: a spot on a diagram, a step in a flow, a place on a floor plan.',
    family: 'rating',
    icon: 'MapPin',
    answerable: true,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zPinImage,
    defaults: () => ({
      ...base,
      kind: 'pin_image',
      prompt: 'Where would you click first?',
      imageUrl: '',
      pinsPerPerson: 1,
      showHeatmap: true,
    }),
    exportColumns: ['X', 'Y'],
  },
  guess_number: {
    kind: 'guess_number',
    label: 'Guess the Number',
    blurb: 'Type a number. Shows spread and average.',
    details:
      'You ask for a number. Each person types one on their phone, and the projector shows the spread of guesses with the average and, if you set one, how close the room came to the true answer. Good for estimates before revealing a figure.',
    family: 'rating',
    icon: 'Hash',
    answerable: true,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zGuessNumber,
    defaults: () => ({
      ...base,
      kind: 'guess_number',
      prompt: 'Take a guess',
      min: 0,
      max: 1000,
      unit: '',
    }),
    exportColumns: ['Guess'],
  },
  star_rating: {
    kind: 'star_rating',
    label: 'Star Rating',
    blurb: 'A simple one-to-five style rating.',
    details:
      'A single thing rated out of five. The audience taps the stars; the projector shows the average and how many people have rated so far. The simplest way to ask how something went.',
    family: 'rating',
    icon: 'Star',
    answerable: true,
    isQuiz: false,
    segmentable: true,
    configSchema: C.zStarRating,
    defaults: () => ({
      ...base,
      kind: 'star_rating',
      prompt: 'How would you rate this?',
      stars: 5,
    }),
    exportColumns: ['Stars', 'Votes'],
  },
  nps: {
    kind: 'nps',
    label: 'Net Promoter Score',
    blurb: 'The standard zero-to-ten recommendation question.',
    details:
      'The standard zero-to-ten question about whether someone would recommend something. The projector shows the score calculated the usual way, with promoters, passives and detractors separated, so the figure means the same as it does elsewhere.',
    family: 'rating',
    icon: 'Gauge',
    answerable: true,
    isQuiz: false,
    segmentable: true,
    configSchema: C.zNps,
    defaults: () => ({
      ...base,
      kind: 'nps',
      prompt: 'How likely are you to recommend us?',
      lowLabel: 'Not at all likely',
      highLabel: 'Extremely likely',
    }),
    exportColumns: ['Score', 'Group', 'Count'],
  },

  /* ---------------- quiz ---------------- */
  quiz_select: {
    kind: 'quiz_select',
    label: 'Quiz: Select Answer',
    blurb: 'Multiple choice with a correct answer and a countdown.',
    details:
      'A multiple choice with a correct answer and a countdown. You mark which option is right and how long the room has. Answering sooner scores more, so the points reward both knowing and deciding. Each phone is told privately whether it was right; the projector shows the distribution and then the answer.',
    family: 'quiz',
    icon: 'CircleCheck',
    answerable: true,
    isQuiz: true,
    segmentable: false,
    configSchema: C.zQuizSelect,
    defaults: () => ({
      ...quizBase,
      kind: 'quiz_select',
      prompt: 'Which one is correct?',
      options: [
        { id: id(1), label: 'Correct answer', correct: true },
        { id: id(2), label: 'Wrong answer' },
        { id: id(3), label: 'Another wrong answer' },
      ],
    }),
    exportColumns: ['Participant', 'Answer', 'Correct', 'Time (ms)', 'Points'],
  },
  quiz_type: {
    kind: 'quiz_type',
    label: 'Quiz: Type Answer',
    blurb: 'People type the answer. Checked against your list.',
    details:
      'The audience types the answer rather than picking one. You list the spellings that count, and can allow small misspellings and ignore capitals, so a right answer typed quickly on a phone is not marked wrong. Scoring and the countdown work as they do for the other quiz slides.',
    family: 'quiz',
    icon: 'Keyboard',
    answerable: true,
    isQuiz: true,
    segmentable: false,
    configSchema: C.zQuizType,
    defaults: () => ({
      ...quizBase,
      kind: 'quiz_type',
      prompt: 'What is the answer?',
      acceptedAnswers: ['answer'],
      caseSensitive: false,
      fuzzyTolerance: 1,
    }),
    exportColumns: ['Participant', 'Answer', 'Correct', 'Time (ms)', 'Points'],
  },
  quiz_match: {
    kind: 'quiz_match',
    label: 'Quiz: Match Pairs',
    blurb: 'Join items on the left to items on the right.',
    details:
      'You write pairs: a term and its definition, a country and its capital. The audience joins the left column to the right on their phone. Partly correct answers score partly, so a person who matched three of four is not treated as having failed.',
    family: 'quiz',
    icon: 'Link2',
    answerable: true,
    isQuiz: true,
    segmentable: false,
    configSchema: C.zQuizMatch,
    defaults: () => ({
      ...quizBase,
      kind: 'quiz_match',
      prompt: 'Match each pair',
      pairs: [
        { id: id(1), left: 'First', right: 'Match one' },
        { id: id(2), left: 'Second', right: 'Match two' },
      ],
    }),
    exportColumns: ['Participant', 'Correct pairs', 'Time (ms)', 'Points'],
  },
  quiz_order: {
    kind: 'quiz_order',
    label: 'Quiz: Order the Steps',
    blurb: 'Put a process into the correct order.',
    details:
      'You write the steps in their correct order and the audience is shown them shuffled, to drag back into place. Scoring credits how close the submitted order is, not only an exact match. Use it for processes, chronologies and anything sequential.',
    family: 'quiz',
    icon: 'ListOrdered',
    answerable: true,
    isQuiz: true,
    segmentable: false,
    configSchema: C.zQuizOrder,
    defaults: () => ({
      ...quizBase,
      kind: 'quiz_order',
      prompt: 'Put these steps in order',
      steps: [
        { id: id(1), label: 'First step' },
        { id: id(2), label: 'Second step' },
        { id: id(3), label: 'Third step' },
      ],
    }),
    exportColumns: ['Participant', 'Correct positions', 'Time (ms)', 'Points'],
  },
  leaderboard: {
    kind: 'leaderboard',
    label: 'Leaderboard',
    blurb: 'Top scorers so far. Faster correct answers score more.',
    details:
      'Shows the standings so far, so it belongs between quiz questions rather than at the end alone. Nobody answers it. Scores come from every quiz slide already played, with faster correct answers worth more, and each phone also sees its own position privately.',
    family: 'quiz',
    icon: 'Medal',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zLeaderboard,
    defaults: () => ({
      ...base,
      kind: 'leaderboard',
      prompt: 'Leaderboard',
      topN: 10,
      showPoints: true,
    }),
    exportColumns: ['Rank', 'Participant', 'Points'],
  },

  /* ---------------- audience driven ---------------- */
  qa: {
    kind: 'qa',
    label: 'Questions & Answers',
    blurb: 'People send questions any time and vote them up.',
    details:
      'A channel for the room to ask you things. People send questions from their phone at any point in the session, not only while this slide is up, and vote up questions already asked. The projector lists them with the most-voted first, and you mark one as answered once you have dealt with it.',
    family: 'audience',
    icon: 'MessagesSquare',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zQa,
    defaults: () => ({
      ...base,
      kind: 'qa',
      prompt: 'Ask me anything',
      moderated: false,
      allowUpvotes: true,
      allowAnonymous: true,
    }),
    exportColumns: ['Question', 'Upvotes', 'Status'],
  },
  quick_form: {
    kind: 'quick_form',
    label: 'Quick Form',
    blurb: 'Collect a name, an email, or any field you define.',
    details:
      'Several fields on one slide: a name, an email address, a number, a dropdown, a checkbox. You define the fields and which are required. Use it for sign-ups and registrations, where the usual one-question-per-slide shape would be tedious. The responses download as a spreadsheet.',
    family: 'audience',
    icon: 'ClipboardList',
    answerable: true,
    isQuiz: false,
    segmentable: true,
    configSchema: C.zQuickForm,
    defaults: () => ({
      ...base,
      kind: 'quick_form',
      prompt: 'Tell us about yourself',
      fields: [{ id: id(1), label: 'Your name', type: 'text', required: true }],
      submitLabel: 'Submit',
    }),
    exportColumns: ['Field', 'Value'],
  },

  /* ---------------- ours only ---------------- */
  drawing: {
    kind: 'drawing',
    label: 'Drawing',
    blurb: 'People sketch an answer on their phone.',
    details:
      'Each person draws on their phone with a finger and sends the sketch. The projector shows the drawings as they arrive. Useful where words are the slow way to answer: a shape, a graph, a diagram.',
    family: 'creative',
    icon: 'Pencil',
    answerable: true,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zDrawing,
    defaults: () => ({
      ...base,
      kind: 'drawing',
      prompt: 'Draw your answer',
      backgroundImageUrl: '',
      strokeColors: [],
    }),
    exportColumns: ['Participant', 'Strokes'],
  },
  map_pin: {
    kind: 'map_pin',
    label: 'Map Pin',
    blurb: 'Drop a pin on a real map.',
    details:
      'A real map. Each person drops a pin on a place, and the projector shows every pin on the same map. Use it for where people are from, where they have worked, or any question whose answer is a location.',
    family: 'creative',
    icon: 'Globe',
    answerable: true,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zMapPin,
    defaults: () => ({
      ...base,
      kind: 'map_pin',
      prompt: 'Where are you joining from?',
      centerLat: 20,
      centerLng: 0,
      zoom: 2,
      pinsPerPerson: 1,
    }),
    exportColumns: ['Latitude', 'Longitude'],
  },

  /* ---------------- content ---------------- */
  heading: {
    kind: 'heading',
    label: 'Heading',
    blurb: 'A large title slide.',
    details:
      'A title, large and centred, with an optional line beneath it. Nobody answers it. Use it to open the session or to mark where a new topic begins.',
    family: 'content',
    icon: 'Heading1',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zHeading,
    defaults: () => ({ ...base, kind: 'heading', prompt: 'Your heading', align: 'center' }),
    exportColumns: [],
  },
  paragraph: {
    kind: 'paragraph',
    label: 'Paragraph',
    blurb: 'A block of text.',
    details:
      'A block of text on the projector, for context the room should read rather than answer. Nobody answers it.',
    family: 'content',
    icon: 'Text',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zParagraph,
    defaults: () => ({ ...base, kind: 'paragraph', prompt: '', body: '' }),
    exportColumns: [],
  },
  bullets: {
    kind: 'bullets',
    label: 'Bullet List',
    blurb: 'A list, optionally revealed one line at a time.',
    details:
      'A list of points, which you can reveal one line at a time with the arrow keys so the room reads with you rather than ahead of you. Nobody answers it.',
    family: 'content',
    icon: 'List',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zBullets,
    defaults: () => ({
      ...base,
      kind: 'bullets',
      prompt: 'Key points',
      items: ['First point', 'Second point'],
      numbered: false,
      revealOneByOne: false,
    }),
    exportColumns: [],
  },
  big_number: {
    kind: 'big_number',
    label: 'Big Number',
    blurb: 'One statistic, very large.',
    details:
      'One figure, as large as the slide allows, with a line of explanation under it. For the statistic a talk turns on, where a chart would bury it.',
    family: 'content',
    icon: 'TrendingUp',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zBigNumber,
    defaults: () => ({ ...base, kind: 'big_number', prompt: '', value: '42', caption: '' }),
    exportColumns: [],
  },
  quote: {
    kind: 'quote',
    label: 'Quote',
    blurb: 'A pull quote with attribution.',
    details: 'A pull quote with its attribution, set larger than body text. Nobody answers it.',
    family: 'content',
    icon: 'Quote',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zQuote,
    defaults: () => ({ ...base, kind: 'quote', prompt: '', quote: '', attribution: '' }),
    exportColumns: [],
  },
  image: {
    kind: 'image',
    label: 'Image',
    blurb: 'A full-slide picture or GIF.',
    details:
      'A picture filling the slide, uploaded from your machine or linked from the web. Animated GIFs play. Nobody answers it.',
    family: 'content',
    icon: 'Image',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zImage,
    defaults: () => ({ ...base, kind: 'image', imageUrl: '', alt: '', fit: 'contain' }),
    exportColumns: [],
  },
  video: {
    kind: 'video',
    label: 'Video',
    blurb: 'An embedded or uploaded video.',
    details:
      'A video, either uploaded or embedded from a link, playing on the projector. Nobody answers it.',
    family: 'content',
    icon: 'Video',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zVideo,
    defaults: () => ({ ...base, kind: 'video', url: '', autoplay: false, loop: false }),
    exportColumns: [],
  },
  instructions: {
    kind: 'instructions',
    label: 'How to Join',
    blurb: 'Shows the join code and QR code large.',
    details:
      'Shows the join code and QR code at full size, so the room can join without you reading the code aloud. Worth placing first, and again after a break when people have locked their phones.',
    family: 'content',
    icon: 'QrCode',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zInstructions,
    defaults: () => ({
      ...base,
      kind: 'instructions',
      prompt: 'Join in',
      showQr: true,
      showCode: true,
    }),
    exportColumns: [],
  },
  section_break: {
    kind: 'section_break',
    label: 'Section Break',
    blurb: 'A divider between parts of the session.',
    details:
      'A divider between parts of a session, so a long deck reads as sections rather than one run of slides. Nobody answers it.',
    family: 'content',
    icon: 'Minus',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zSectionBreak,
    defaults: () => ({ ...base, kind: 'section_break', prompt: '', label: '' }),
    exportColumns: [],
  },
  embed: {
    kind: 'embed',
    label: 'Embed',
    blurb: 'A web page, PowerPoint, Google Slides or Miro board.',
    details:
      'Puts another page inside the slide: a web page, a Google Slides deck, a PowerPoint, a Miro board. Use it to show existing material without rebuilding it here. Nobody answers it.',
    family: 'content',
    icon: 'ExternalLink',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zEmbed,
    defaults: () => ({ ...base, kind: 'embed', url: '', provider: 'generic' }),
    exportColumns: [],
  },
  compare: {
    kind: 'compare',
    label: 'Compare',
    blurb: 'Two slides side by side, to show a before and after.',
    details:
      'Two slides shown side by side, for a before and after, or two results next to each other. You choose which two. Nobody answers it directly; what it shows comes from the slides it refers to.',
    family: 'content',
    icon: 'Columns2',
    answerable: false,
    isQuiz: false,
    segmentable: false,
    configSchema: C.zCompare,
    defaults: () => ({
      ...base,
      kind: 'compare',
      prompt: 'Then and now',
      slideIdA: '',
      slideIdB: '',
      labelA: 'Before',
      labelB: 'After',
    }),
    exportColumns: [],
  },
};

/* ------------------------------------------------------------------ */
/* Derived helpers                                                     */
/* ------------------------------------------------------------------ */

export const ALL_DEFINITIONS: SlideDefinition[] = SLIDE_KINDS.map((k) => SLIDE_REGISTRY[k]);

export const ANSWERABLE_KINDS = ALL_DEFINITIONS.filter((d) => d.answerable).map((d) => d.kind);

export const QUIZ_KINDS = ALL_DEFINITIONS.filter((d) => d.isQuiz).map((d) => d.kind);

export const SEGMENTABLE_KINDS = ALL_DEFINITIONS.filter((d) => d.segmentable).map((d) => d.kind);

export function definitionFor(kind: SlideKind): SlideDefinition {
  return SLIDE_REGISTRY[kind];
}

export function definitionsByFamily(family: SlideFamily): SlideDefinition[] {
  return ALL_DEFINITIONS.filter((d) => d.family === family);
}

export function isAnswerable(kind: SlideKind): boolean {
  return SLIDE_REGISTRY[kind].answerable;
}

export function isQuiz(kind: SlideKind): boolean {
  return SLIDE_REGISTRY[kind].isQuiz;
}
