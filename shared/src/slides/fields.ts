import { z } from 'zod';
import { SLIDE_REGISTRY } from './registry.js';
import type { SlideKind } from './kinds.js';

/**
 * Editor field descriptions, derived from each kind's Zod schema.
 *
 * Writing a form per slide kind would mean 34 forms to keep in step with 34
 * schemas, and every new kind would need both. Reading the schema instead
 * means the editor gains a field the moment the schema does, and a field's
 * limits in the form are the same numbers the server validates against.
 */

export type FieldKind =
  | 'text'
  | 'longtext'
  | 'number'
  | 'boolean'
  | 'select'
  | 'options'
  | 'textList'
  | 'url'
  | 'slideRef';

/**
 * One editable column inside a list of objects.
 *
 * Derived from the element's own schema, so a list editor shows exactly
 * what that kind's entries hold. Previously every list was edited as a
 * label and nothing else, which left Image Choice with no way to set an
 * image, Quick Form with no way to choose a field type, and Quiz: Match
 * with no editor at all.
 */
export interface ColumnSpec {
  name: string;
  label: string;
  kind: 'text' | 'url' | 'boolean' | 'correct' | 'select' | 'textList';
  choices?: string[];
  /** Entries may leave it empty. */
  optional: boolean;
  max?: number;
}

export interface FieldSpec {
  /** The config key this field writes. */
  name: string;
  kind: FieldKind;
  label: string;
  /** Shown under the control. */
  hint?: string;
  min?: number;
  max?: number;
  /** For 'select', the allowed values. */
  choices?: string[];
  /**
   * For 'slideRef', which slides may be chosen.
   *
   * 'answerable' excludes content slides, which have no results to show.
   */
  refScope?: 'answerable';
  /** For 'options', what each entry holds. */
  columns?: ColumnSpec[];
  /** For 'textList', whether entries are plain text or colours. */
  itemFormat?: 'text' | 'color';
  /** How many entries the schema allows, so the editor can stop at the edge. */
  minItems?: number;
  maxItems?: number;
  /** Fields shared by every slide are grouped separately in the editor. */
  common: boolean;
}

/** Keys every slide carries; they get one shared section in the editor. */
const COMMON: Record<string, { label: string; kind: FieldKind; hint?: string }> = {
  prompt: { label: 'Question', kind: 'text', hint: 'What the room sees at the top.' },
  subtitle: { label: 'Subtitle', kind: 'text' },
  speakerNotes: {
    label: 'Speaker notes',
    kind: 'longtext',
    hint: 'Only you see these while presenting.',
  },
  timerSeconds: {
    label: 'Timer (seconds)',
    kind: 'number',
    hint: '0 means no timer.',
  },
  participationOpen: { label: 'Open for answers', kind: 'boolean' },
  resultsHiddenByDefault: { label: 'Hide results until revealed', kind: 'boolean' },
  skipped: { label: 'Skip this slide', kind: 'boolean' },
};

/**
 * Names humanise() cannot do anything sensible with.
 *
 * A trailing single letter becomes its own word -- labelA turns into
 * "Label a" -- which reads as a typo rather than a label.
 */
const RENAMED: Record<string, string> = {
  labelA: 'First label',
  labelB: 'Second label',
};

/** Turns camelCase into a readable label: maxCharacters -> "Max characters". */
function humanise(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Strips wrappers so the underlying type can be identified. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  // Defaults, optionals and nullables all wrap the real type.
  for (let i = 0; i < 10; i += 1) {
    if (current instanceof z.ZodDefault) {
      // _def is Zod's internal shape and is typed loosely; the inner type of
      // a ZodDefault is always a schema, so state that rather than inherit
      // the `any`.
      const def = current._def as { innerType: z.ZodTypeAny };
      current = def.innerType;
    } else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
    } else {
      break;
    }
  }
  return current;
}

/** Reads min/max out of a number schema's checks. */
function numberRange(schema: z.ZodNumber): { min?: number; max?: number } {
  const range: { min?: number; max?: number } = {};
  for (const check of schema._def.checks) {
    if (check.kind === 'min') range.min = check.value;
    if (check.kind === 'max') range.max = check.value;
  }
  return range;
}

/** Reads min/max out of an array schema's checks. */
function arrayRange(schema: z.ZodTypeAny): { minItems?: number; maxItems?: number } {
  const def = schema._def as {
    minLength?: { value: number } | null;
    maxLength?: { value: number } | null;
  };

  return {
    ...(def.minLength ? { minItems: def.minLength.value } : {}),
    ...(def.maxLength ? { maxItems: def.maxLength.value } : {}),
  };
}

/** The largest length a string schema allows, for an input's maxlength. */
function stringMax(schema: z.ZodString): number | undefined {
  for (const check of schema._def.checks) {
    if (check.kind === 'max') return check.value;
  }
  return undefined;
}

/** Whether a string schema only accepts a hex colour. */
function isColor(schema: z.ZodString): boolean {
  return schema._def.checks.some(
    (check) => check.kind === 'regex' && check.regex.source.includes('0-9a-fA-F'),
  );
}

/** Whether a schema describes a URL, including the "empty or a URL" drafts. */
function isUrlLike(name: string, schema: z.ZodTypeAny): boolean {
  if (name.toLowerCase().endsWith('url')) return true;
  if (schema instanceof z.ZodUnion) return true;
  return schema instanceof z.ZodString && schema._def.checks.some((c) => c.kind === 'url');
}

/**
 * The editable columns of a list entry.
 *
 * Everything the element's schema declares except its id, which is
 * generated and never typed. An element whose fields this cannot describe
 * yields no columns, and the caller leaves the field out rather than
 * showing a control that writes the wrong shape.
 */
function columnsFor(element: z.ZodObject<z.ZodRawShape>): ColumnSpec[] {
  const columns: ColumnSpec[] = [];

  for (const [key, raw] of Object.entries(element.shape)) {
    if (key === 'id') continue;

    const field = raw;
    const inner = unwrap(field);
    const optional = field.isOptional();
    const label = RENAMED[key] ?? humanise(key);

    if (inner instanceof z.ZodBoolean) {
      // The correct answer is one choice among the entries, not a
      // checkbox on each, so it gets a column of its own.
      columns.push({ name: key, label, kind: key === 'correct' ? 'correct' : 'boolean', optional });
      continue;
    }

    if (inner instanceof z.ZodEnum) {
      columns.push({
        name: key,
        label,
        kind: 'select',
        choices: inner.options as string[],
        optional,
      });
      continue;
    }

    if (inner instanceof z.ZodArray) {
      const nested = unwrap(inner.element as z.ZodTypeAny);
      // A list inside a row -- the choices of a dropdown field. Edited as
      // one comma-separated box rather than a list inside a list.
      if (nested instanceof z.ZodString) {
        columns.push({ name: key, label, kind: 'textList', optional });
      }
      continue;
    }

    if (inner instanceof z.ZodString || inner instanceof z.ZodUnion) {
      columns.push({
        name: key,
        label,
        kind: isUrlLike(key, inner) ? 'url' : 'text',
        optional,
        ...(inner instanceof z.ZodString ? { max: stringMax(inner) } : {}),
      });
      continue;
    }
  }

  return columns;
}

function specFor(name: string, schema: z.ZodTypeAny): FieldSpec | null {
  const inner = unwrap(schema);
  const common = name in COMMON;
  const meta = COMMON[name];
  const label = meta?.label ?? RENAMED[name] ?? humanise(name);

  // The discriminator is structural, never editable.
  if (name === 'kind') return null;

  if (meta?.kind === 'longtext') {
    return { name, kind: 'longtext', label, hint: meta.hint, common: true };
  }

  if (inner instanceof z.ZodBoolean) {
    return { name, kind: 'boolean', label, hint: meta?.hint, common };
  }

  if (inner instanceof z.ZodNumber) {
    const range = numberRange(inner);
    return { name, kind: 'number', label, hint: meta?.hint, ...range, common };
  }

  if (inner instanceof z.ZodEnum) {
    const choices = inner.options as string[];
    return { name, kind: 'select', label, choices, hint: meta?.hint, common };
  }

  if (inner instanceof z.ZodArray) {
    const range = arrayRange(inner);
    const element = unwrap(inner.element as z.ZodTypeAny);

    /*
     * Any list of objects is editable, not only ones with a label.
     *
     * Restricting it to a label meant Quiz: Match, whose entries are a
     * left and a right side, had no editor at all -- the slide could be
     * added and never filled in.
     */
    if (element instanceof z.ZodObject) {
      const columns = columnsFor(element as z.ZodObject<z.ZodRawShape>);
      if (columns.length === 0) return null;

      return { name, kind: 'options', label, columns, ...range, hint: meta?.hint, common: false };
    }

    // A list of plain strings: the lines of a bullet slide, the spellings a
    // typed quiz answer accepts, a drawing's palette.
    if (element instanceof z.ZodString) {
      return {
        name,
        kind: 'textList',
        label,
        itemFormat: isColor(element) ? 'color' : 'text',
        ...range,
        hint: meta?.hint,
        common: false,
      };
    }

    return null;
  }

  if (inner instanceof z.ZodString) {
    /*
     * A reference to another slide, not free text.
     *
     * Compare stores two slide ids. Rendered as a plain text box -- which
     * is what a bare string schema produces -- it asked the author to type
     * an id they have no way of knowing, so the slide could be added and
     * configured but never actually made to show anything. The editor
     * turns this into a picker.
     */
    if (name === 'slideIdA' || name === 'slideIdB') {
      return {
        name,
        kind: 'slideRef',
        // humanise() would produce "Slide id a", which reads as a typo.
        label: name === 'slideIdA' ? 'First slide' : 'Second slide',
        hint: 'Its results are shown on this slide.',
        refScope: 'answerable',
        common,
      };
    }

    return { name, kind: 'text', label, hint: meta?.hint, common };
  }

  // A union of '' and a URL is how draft image fields are typed.
  if (inner instanceof z.ZodUnion) {
    return { name, kind: 'url', label, hint: meta?.hint, common };
  }

  return null;
}

const cache = new Map<SlideKind, FieldSpec[]>();

/**
 * The editable fields for a slide kind, common ones first.
 *
 * Cached because the shape never changes at runtime and the editor asks for
 * it on every render.
 */
export function fieldsFor(kind: SlideKind): FieldSpec[] {
  const cached = cache.get(kind);
  if (cached) return cached;

  const schema = unwrap(SLIDE_REGISTRY[kind].configSchema);
  if (!(schema instanceof z.ZodObject)) {
    cache.set(kind, []);
    return [];
  }

  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const specs: FieldSpec[] = [];

  for (const [name, field] of Object.entries(shape)) {
    const spec = specFor(name, field);
    if (spec) specs.push(spec);
  }

  // Common fields lead with the prompt; the rest keep schema order, which
  // reads more naturally than alphabetical.
  const order = Object.keys(COMMON);
  specs.sort((a, b) => {
    if (a.common !== b.common) return a.common ? -1 : 1;
    if (!a.common) return 0;
    return order.indexOf(a.name) - order.indexOf(b.name);
  });

  cache.set(kind, specs);
  return specs;
}
