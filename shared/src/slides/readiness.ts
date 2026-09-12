import type { SlideConfig } from './configs.js';

/**
 * Two different questions get two different answers:
 *
 *   1. "Is this config structurally valid?"  -> the Zod schemas.
 *      A half-built slide must stay valid, or the editor throws while the
 *      author is still typing.
 *
 *   2. "Is this slide finished enough to show a room?" -> this file.
 *      Checked when the author presses Present, and surfaced in the editor
 *      as a gentle warning badge rather than an error.
 */

export type IssueLevel = 'error' | 'warning';

export interface ReadinessIssue {
  level: IssueLevel;
  /** Which config field the problem is on, for focusing the right input. */
  field: string;
  message: string;
}

const needsPrompt = (c: SlideConfig): ReadinessIssue[] =>
  c.prompt.trim().length === 0
    ? [{ level: 'error', field: 'prompt', message: 'Add a question or title.' }]
    : [];

/**
 * Returns every reason this slide is not ready to present.
 * An empty array means the slide is good to go.
 */
export function validateSlideReady(config: SlideConfig): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];

  switch (config.kind) {
    /* --- content slides that only need their own content --- */
    case 'heading':
    case 'section_break':
      break;

    case 'paragraph':
      if (config.body.trim().length === 0) {
        issues.push({ level: 'error', field: 'body', message: 'Add some text.' });
      }
      break;

    case 'bullets':
      if (config.items.every((i) => i.trim().length === 0)) {
        issues.push({ level: 'error', field: 'items', message: 'Add at least one bullet point.' });
      }
      break;

    case 'quote':
      if (config.quote.trim().length === 0) {
        issues.push({ level: 'error', field: 'quote', message: 'Add the quote text.' });
      }
      break;

    case 'big_number':
      if (config.value.trim().length === 0) {
        issues.push({ level: 'error', field: 'value', message: 'Add a number to display.' });
      }
      break;

    case 'image':
      if (!config.imageUrl) {
        issues.push({ level: 'error', field: 'imageUrl', message: 'Upload or link an image.' });
      }
      if (config.imageUrl && !config.alt.trim()) {
        issues.push({
          level: 'warning',
          field: 'alt',
          message: 'Add a description so screen readers can describe this image.',
        });
      }
      break;

    case 'video':
      if (!config.url) {
        issues.push({ level: 'error', field: 'url', message: 'Add a video link.' });
      }
      break;

    case 'embed':
      if (!config.url) {
        issues.push({ level: 'error', field: 'url', message: 'Add the link to embed.' });
      }
      break;

    case 'instructions':
      if (!config.showQr && !config.showCode) {
        issues.push({
          level: 'warning',
          field: 'showQr',
          message: 'Nobody can join from this slide with both the code and QR hidden.',
        });
      }
      break;

    case 'compare':
      if (!config.slideIdA || !config.slideIdB) {
        issues.push({ level: 'error', field: 'slideIdA', message: 'Pick two slides to compare.' });
      } else if (config.slideIdA === config.slideIdB) {
        issues.push({
          level: 'error',
          field: 'slideIdB',
          message: 'Pick two different slides.',
        });
      }
      break;

    /* --- free text --- */
    case 'word_cloud':
    case 'open_text':
      issues.push(...needsPrompt(config));
      break;

    /* --- choice --- */
    case 'multiple_choice':
    case 'who_will_win':
    case 'quiz_select': {
      issues.push(...needsPrompt(config));
      const labelled = config.options.filter((o) => o.label.trim().length > 0);
      if (labelled.length < 2) {
        issues.push({ level: 'error', field: 'options', message: 'Add at least two options.' });
      }
      const seen = new Map<string, string>();
      for (const o of labelled) {
        const key = o.label.trim().toLowerCase();
        const first = seen.get(key);
        if (first !== undefined) {
          issues.push({
            level: 'warning',
            field: 'options',
            message: `Two options both say "${first}".`,
          });
          break;
        }
        seen.set(key, o.label.trim());
      }
      if (config.kind === 'quiz_select' && !config.options.some((o) => o.correct)) {
        issues.push({
          level: 'error',
          field: 'options',
          message: 'Mark at least one option as the correct answer.',
        });
      }
      break;
    }

    case 'image_choice': {
      issues.push(...needsPrompt(config));
      if (config.options.length < 2) {
        issues.push({ level: 'error', field: 'options', message: 'Add at least two images.' });
      }
      const missing = config.options.filter((o) => !o.imageUrl).length;
      if (missing > 0) {
        issues.push({
          level: 'error',
          field: 'options',
          message: `${missing} option${missing === 1 ? ' has' : 's have'} no image yet.`,
        });
      }
      break;
    }

    case 'true_false':
    case 'star_rating':
    case 'nps':
    case 'guess_number':
      issues.push(...needsPrompt(config));
      break;

    /* --- rating and ordering --- */
    case 'scales': {
      issues.push(...needsPrompt(config));
      if (config.statements.filter((s) => s.label.trim()).length === 0) {
        issues.push({
          level: 'error',
          field: 'statements',
          message: 'Add at least one statement.',
        });
      }
      if (config.max <= config.min) {
        issues.push({
          level: 'error',
          field: 'max',
          message: 'The highest value must be above the lowest.',
        });
      }
      break;
    }

    case 'ranking':
    case 'points_100': {
      issues.push(...needsPrompt(config));
      if (config.items.filter((i) => i.label.trim()).length < 2) {
        issues.push({ level: 'error', field: 'items', message: 'Add at least two items.' });
      }
      break;
    }

    case 'grid_2x2': {
      issues.push(...needsPrompt(config));
      if (config.items.filter((i) => i.label.trim()).length === 0) {
        issues.push({ level: 'error', field: 'items', message: 'Add at least one item to place.' });
      }
      break;
    }

    case 'pin_image':
      issues.push(...needsPrompt(config));
      if (!config.imageUrl) {
        issues.push({
          level: 'error',
          field: 'imageUrl',
          message: 'Upload the image people will pin on.',
        });
      }
      break;

    case 'map_pin':
    case 'drawing':
      issues.push(...needsPrompt(config));
      break;

    /* --- quiz --- */
    case 'quiz_type':
      issues.push(...needsPrompt(config));
      if (config.acceptedAnswers.filter((a) => a.trim()).length === 0) {
        issues.push({
          level: 'error',
          field: 'acceptedAnswers',
          message: 'Add at least one accepted answer.',
        });
      }
      break;

    case 'quiz_match':
      issues.push(...needsPrompt(config));
      if (config.pairs.filter((p) => p.left.trim() && p.right.trim()).length < 2) {
        issues.push({
          level: 'error',
          field: 'pairs',
          message: 'Add at least two complete pairs.',
        });
      }
      break;

    case 'quiz_order':
      issues.push(...needsPrompt(config));
      if (config.steps.filter((s) => s.label.trim()).length < 2) {
        issues.push({ level: 'error', field: 'steps', message: 'Add at least two steps.' });
      }
      break;

    case 'leaderboard':
      break;

    /* --- audience --- */
    case 'qa':
      issues.push(...needsPrompt(config));
      break;

    case 'quick_form': {
      issues.push(...needsPrompt(config));
      const named = config.fields.filter((f) => f.label.trim());
      if (named.length === 0) {
        issues.push({ level: 'error', field: 'fields', message: 'Add at least one field.' });
      }
      for (const f of config.fields) {
        if (f.type === 'select' && (!f.options || f.options.filter((o) => o.trim()).length < 2)) {
          issues.push({
            level: 'error',
            field: 'fields',
            message: `"${f.label || 'Dropdown'}" needs at least two choices.`,
          });
          break;
        }
      }
      break;
    }

    default: {
      // Exhaustiveness guard: adding a slide kind without handling it here
      // becomes a compile error rather than a silent gap.
      const never: never = config;
      throw new Error(`Unhandled slide kind: ${JSON.stringify(never)}`);
    }
  }

  return issues;
}

export function isSlideReady(config: SlideConfig): boolean {
  return !validateSlideReady(config).some((i) => i.level === 'error');
}

export interface DeckReadiness {
  ready: boolean;
  /** Keyed by slide id. Only slides with issues appear. */
  bySlide: Record<string, ReadinessIssue[]>;
  errorCount: number;
  warningCount: number;
}

export function validateDeckReady(
  slides: { id: string; config: SlideConfig; skipped?: boolean }[],
): DeckReadiness {
  const bySlide: Record<string, ReadinessIssue[]> = {};
  let errorCount = 0;
  let warningCount = 0;

  for (const slide of slides) {
    if (slide.skipped || slide.config.skipped) continue;
    const issues = validateSlideReady(slide.config);
    if (issues.length === 0) continue;
    bySlide[slide.id] = issues;
    for (const i of issues) {
      if (i.level === 'error') errorCount += 1;
      else warningCount += 1;
    }
  }

  return { ready: errorCount === 0, bySlide, errorCount, warningCount };
}
