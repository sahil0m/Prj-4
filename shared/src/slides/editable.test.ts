import { describe, it, expect } from 'vitest';
import { SLIDE_KINDS, type SlideKind } from './kinds.js';
import { SLIDE_REGISTRY } from './registry.js';
import { fieldsFor, type FieldSpec } from './fields.js';
import { isSlideReady } from './readiness.js';
import type { SlideConfig } from './configs.js';

/*
 * Every setting a slide kind has must be reachable in the editor, and
 * every state the editor can produce must be saveable.
 *
 * Both halves failed in ways nobody could see from the code. Image Choice
 * had an image on every option that no control could set, so the slide was
 * a Multiple Choice with extra steps. Quiz: Match stored its pairs in a
 * shape the editor skipped, so the slide could be added and never filled
 * in. And adding an entry to any list wrote a blank label, which the
 * schema refused -- so every autosave failed with a 422 until the author
 * happened to type something, with nothing on screen to say why.
 */

const LIST_KINDS = new Set(['options', 'textList']);

/** What the editor writes when someone clicks "Add" on a list. */
function addEntry(field: FieldSpec, list: unknown[]): unknown[] {
  if (field.kind === 'textList') {
    return [...list, field.itemFormat === 'color' ? '#6366f1' : ''];
  }

  const blank: Record<string, unknown> = { id: `new${String(list.length)}` };

  for (const column of field.columns ?? []) {
    if (column.kind === 'boolean' || column.kind === 'correct') blank[column.name] = false;
    else if (column.kind === 'select') blank[column.name] = column.choices?.[0] ?? '';
    else if (column.kind === 'textList') blank[column.name] = [];
    else if (!column.optional) blank[column.name] = '';
  }

  return [...list, blank];
}

describe('every slide kind is fully editable', () => {
  it('has a control for every setting it stores', () => {
    const gaps: string[] = [];

    for (const kind of SLIDE_KINDS) {
      const defaults = SLIDE_REGISTRY[kind].defaults() as Record<string, unknown>;
      const editable = new Set(fieldsFor(kind).map((field) => field.name));

      for (const name of Object.keys(defaults)) {
        if (name === 'kind' || editable.has(name)) continue;
        gaps.push(`${kind}.${name}`);
      }
    }

    expect(gaps, `these settings have no editor control: ${gaps.join(', ')}`).toEqual([]);
  });

  it('describes what each list entry holds, not just a label', () => {
    // Image Choice is the case that proves it: its options carry a picture,
    // and an editor that only knows about labels cannot set one.
    const options = fieldsFor('image_choice').find((field) => field.name === 'options');

    expect(options?.kind).toBe('options');
    expect(options?.columns?.map((column) => column.name)).toContain('imageUrl');
    expect(options?.columns?.find((column) => column.name === 'imageUrl')?.kind).toBe('url');
  });

  it('describes a list of plain strings as its own kind', () => {
    const items = fieldsFor('bullets').find((field) => field.name === 'items');
    expect(items?.kind).toBe('textList');
    expect(items?.minItems).toBe(1);
  });

  it('gives a quiz pair both of its sides', () => {
    const pairs = fieldsFor('quiz_match').find((field) => field.name === 'pairs');
    expect(pairs?.columns?.map((column) => column.name)).toEqual(['left', 'right']);
  });

  it('gives a form field its type and its required flag', () => {
    const fields = fieldsFor('quick_form').find((field) => field.name === 'fields');
    const byName = new Map(fields?.columns?.map((column) => [column.name, column]));

    expect(byName.get('type')?.kind).toBe('select');
    expect(byName.get('type')?.choices).toContain('select');
    expect(byName.get('required')?.kind).toBe('boolean');
  });

  it('carries the limits the schema sets, so the editor can stop at the edge', () => {
    const options = fieldsFor('quiz_select').find((field) => field.name === 'options');
    expect(options?.minItems).toBe(2);
    expect(options?.maxItems).toBe(8);
  });
});

describe('a half-written slide still saves', () => {
  /*
   * The 422 loop: adding an entry, or clearing one to retype it, produced
   * a config the server refused. A deck is written one keystroke at a
   * time, and every one of those keystrokes has to be saveable.
   */
  it('accepts a freshly added entry in every list', () => {
    const rejected: string[] = [];

    for (const kind of SLIDE_KINDS) {
      for (const field of fieldsFor(kind)) {
        if (!LIST_KINDS.has(field.kind)) continue;

        const config = structuredClone(SLIDE_REGISTRY[kind].defaults()) as Record<string, unknown>;
        const list = Array.isArray(config[field.name]) ? (config[field.name] as unknown[]) : [];
        config[field.name] = addEntry(field, list);

        const result = SLIDE_REGISTRY[kind].configSchema.safeParse(config);
        if (!result.success) {
          rejected.push(`${kind}.${field.name}: ${result.error.issues[0]?.message ?? ''}`);
        }
      }
    }

    expect(rejected, `adding an entry made these unsaveable: ${rejected.join(' | ')}`).toEqual([]);
  });

  it('accepts an entry whose text has been cleared', () => {
    const rejected: string[] = [];

    for (const kind of SLIDE_KINDS) {
      for (const field of fieldsFor(kind)) {
        if (field.kind !== 'options') continue;

        const config = structuredClone(SLIDE_REGISTRY[kind].defaults()) as Record<string, unknown>;
        const list = (config[field.name] as Record<string, unknown>[] | undefined) ?? [];

        config[field.name] = list.map((entry) => {
          const cleared = { ...entry };
          for (const column of field.columns ?? []) {
            if (column.kind === 'text' || column.kind === 'url') cleared[column.name] = '';
          }
          return cleared;
        });

        const result = SLIDE_REGISTRY[kind].configSchema.safeParse(config);
        if (!result.success) {
          rejected.push(`${kind}.${field.name}: ${result.error.issues[0]?.message ?? ''}`);
        }
      }
    }

    expect(rejected, `clearing text made these unsaveable: ${rejected.join(' | ')}`).toEqual([]);
  });
});

describe('but a half-written slide is not ready to present', () => {
  /*
   * The other half of the bargain. Editing is forgiving precisely because
   * readiness is strict: a slide nobody could answer must never reach a
   * room, however freely it saved on the way there.
   */
  const blanked: [SlideKind, (config: Record<string, unknown>) => void][] = [
    [
      'multiple_choice',
      (c) =>
        (c.options = [
          { id: 'a', label: '' },
          { id: 'b', label: '' },
        ]),
    ],
    [
      'quiz_match',
      (c) =>
        (c.pairs = [
          { id: 'a', left: '', right: '' },
          { id: 'b', left: '', right: '' },
        ]),
    ],
    ['bullets', (c) => (c.items = [''])],
    ['quick_form', (c) => (c.fields = [{ id: 'a', label: '', type: 'text', required: false }])],
  ];

  for (const [kind, blank] of blanked) {
    it(`refuses to present an empty ${kind}`, () => {
      const config = structuredClone(SLIDE_REGISTRY[kind].defaults()) as Record<string, unknown>;
      config.prompt = 'A question';
      blank(config);

      expect(SLIDE_REGISTRY[kind].configSchema.safeParse(config).success).toBe(true);
      expect(isSlideReady(config as unknown as SlideConfig)).toBe(false);
    });
  }

  it('says an image choice is not ready until its options have images', () => {
    const config = structuredClone(SLIDE_REGISTRY.image_choice.defaults()) as Record<
      string,
      unknown
    >;
    config.prompt = 'Pick one';
    config.options = [
      { id: 'a', label: 'One', imageUrl: '' },
      { id: 'b', label: 'Two', imageUrl: '' },
    ];

    expect(isSlideReady(config as unknown as SlideConfig)).toBe(false);
  });
});
