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

export type FieldKind = 'text' | 'longtext' | 'number' | 'boolean' | 'select' | 'options' | 'url';

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

function specFor(name: string, schema: z.ZodTypeAny): FieldSpec | null {
  const inner = unwrap(schema);
  const common = name in COMMON;
  const meta = COMMON[name];
  const label = meta?.label ?? humanise(name);

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
    // Option lists get their own editor; other arrays are not editable here.
    const element = unwrap(inner.element as z.ZodTypeAny);
    if (element instanceof z.ZodObject && 'label' in element.shape) {
      return { name, kind: 'options', label, hint: meta?.hint, common: false };
    }
    return null;
  }

  if (inner instanceof z.ZodString) {
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
