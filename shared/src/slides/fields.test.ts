import { describe, it, expect } from 'vitest';
import { fieldsFor } from './fields.js';
import { SLIDE_KINDS } from './kinds.js';
import { SLIDE_REGISTRY } from './registry.js';

describe('fieldsFor', () => {
  it('never exposes the kind discriminator as editable', () => {
    for (const kind of SLIDE_KINDS) {
      expect(fieldsFor(kind).some((f) => f.name === 'kind')).toBe(false);
    }
  });

  it('gives every slide kind at least a prompt', () => {
    for (const kind of SLIDE_KINDS) {
      const names = fieldsFor(kind).map((f) => f.name);
      expect(names, `${kind} has no prompt field`).toContain('prompt');
    }
  });

  it('lists common fields before kind-specific ones', () => {
    const fields = fieldsFor('word_cloud');
    const lastCommon = fields.map((f) => f.common).lastIndexOf(true);
    const firstSpecific = fields.map((f) => f.common).indexOf(false);
    expect(firstSpecific === -1 || lastCommon < firstSpecific).toBe(true);
  });

  it('starts with the prompt, the field an author fills first', () => {
    expect(fieldsFor('word_cloud')[0]?.name).toBe('prompt');
  });

  it('reads numeric bounds straight off the schema', () => {
    const field = fieldsFor('word_cloud').find((f) => f.name === 'maxCharacters');
    expect(field?.kind).toBe('number');
    expect(field?.min).toBe(1);
    expect(field?.max).toBe(60);
  });

  it('detects booleans', () => {
    const field = fieldsFor('word_cloud').find((f) => f.name === 'allowMultipleSubmissions');
    expect(field?.kind).toBe('boolean');
  });

  it('detects enums and carries their choices', () => {
    const field = fieldsFor('multiple_choice').find((f) => f.name === 'layout');
    expect(field?.kind).toBe('select');
    expect(field?.choices?.length).toBeGreaterThan(1);
  });

  it('treats an option list as its own editor', () => {
    const field = fieldsFor('multiple_choice').find((f) => f.name === 'options');
    expect(field?.kind).toBe('options');
  });

  it('turns camelCase into a readable label', () => {
    const field = fieldsFor('word_cloud').find((f) => f.name === 'entriesPerPerson');
    expect(field?.label).toBe('Entries per person');
  });

  it('produces only fields the schema will actually accept', () => {
    // A derived field the schema strips or rejects would be an editor
    // control that silently never saves. Every field must survive a
    // round-trip through its own kind's validation.
    //
    // Note this cannot simply check the defaults: a field may be optional
    // with no default (guess_number.correctValue), which is still editable.
    for (const kind of SLIDE_KINDS) {
      const definition = SLIDE_REGISTRY[kind];
      const defaults = definition.defaults() as Record<string, unknown>;

      for (const field of fieldsFor(kind)) {
        const sample = sampleValue(field, defaults[field.name]);
        if (sample === undefined) continue;

        const parsed = definition.configSchema.safeParse({ ...defaults, [field.name]: sample });
        expect(parsed.success, `${kind}.${field.name} was rejected by its own schema`).toBe(true);

        if (parsed.success) {
          const result = parsed.data as Record<string, unknown>;
          expect(
            Object.prototype.hasOwnProperty.call(result, field.name),
            `${kind}.${field.name} was stripped by its own schema`,
          ).toBe(true);
        }
      }
    }
  });

  it('is stable across calls', () => {
    expect(fieldsFor('nps')).toBe(fieldsFor('nps'));
  });
});

/** A value the field's control could plausibly produce. */
function sampleValue(
  field: { kind: string; min?: number; max?: number; choices?: string[] },
  current: unknown,
): unknown {
  switch (field.kind) {
    case 'boolean':
      return typeof current === 'boolean' ? !current : true;
    case 'number':
      // Inside the schema's own bounds, so a rejection means a real mismatch.
      return field.min ?? field.max ?? 1;
    case 'select':
      return field.choices?.[0];
    // A slide id. Any string is valid to the schema; the editor is what
    // restricts it to slides that actually exist.
    case 'slideRef':
      return 'slide-1';
    case 'text':
    case 'longtext':
      return 'Sample text';
    case 'url':
      return 'https://example.com/a.png';
    // Option lists have their own editor and their own validation.
    case 'options':
      return undefined;
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Slide references                                                    */
/* ------------------------------------------------------------------ */

/*
 * Compare stores two slide ids. A bare string schema produces a plain text
 * box, which asked the author to type an id they had no way of knowing --
 * so the slide could be added and configured but never made to show
 * anything. These pin the field kind that makes it a picker instead.
 */
describe('slide references', () => {
  it('renders the compare targets as pickers, not text boxes', () => {
    const fields = fieldsFor('compare');

    for (const name of ['slideIdA', 'slideIdB']) {
      const field = fields.find((f) => f.name === name);
      expect(field, `${name} is missing from the compare form`).toBeDefined();
      expect(field?.kind).toBe('slideRef');
      expect(field?.refScope).toBe('answerable');
    }
  });

  it('labels them readably', () => {
    const labels = fieldsFor('compare').map((f) => f.label);

    // humanise() turns slideIdA into "Slide id a" and labelA into
    // "Label a", both of which read as typos on screen.
    expect(labels).toContain('First slide');
    expect(labels).toContain('Second slide');
    expect(labels).toContain('First label');
    expect(labels).toContain('Second label');
    expect(labels.some((l) => /\bid a\b|\blabel a\b/i.test(l))).toBe(false);
  });

  it('is the only kind that uses a slide reference', () => {
    // A picker needs the deck passed to the form. If another kind starts
    // using one, whoever adds it has to thread that through too.
    const using = SLIDE_KINDS.filter((kind) => fieldsFor(kind).some((f) => f.kind === 'slideRef'));

    expect(using).toEqual(['compare']);
  });
});
