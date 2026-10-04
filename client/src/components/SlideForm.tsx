import { useId } from 'react';
import { Plus, Trash2, GripVertical, Check } from 'lucide-react';
import {
  fieldsFor,
  definitionFor,
  type ColumnSpec,
  type FieldSpec,
  type SlideKind,
} from '@pulse/shared';
import { Toggle, Range, Choice } from './Controls';
import styles from './SlideForm.module.css';

/** A slide as the picker needs to know it. */
export interface SlideRef {
  id: string;
  kind: SlideKind;
  position: number;
  prompt: string;
  answerable: boolean;
}

/*
 * Radix refuses an empty Select.Item value, so "not chosen" travels under
 * a sentinel and is translated back at the boundary. Storing the sentinel
 * would leak a UI detail into the deck.
 */
const NONE = '__none__';

type Config = Record<string, unknown>;

/**
 * The settings panel for one slide.
 *
 * Controls are generated from the slide's own schema, so a new slide kind
 * gets a working editor with nothing written by hand, and every numeric
 * limit shown here is the limit the server enforces.
 */
export function SlideForm({
  kind,
  config,
  onChange,
  slides = [],
  slideId,
}: {
  kind: SlideKind;
  config: Config;
  onChange: (patch: Config) => void;
  /**
   * The rest of the deck, for fields that point at another slide.
   *
   * Only Compare uses this today. Passing the whole deck rather than a
   * prepared list keeps the filtering next to the field that needs it.
   */
  slides?: SlideRef[];
  /** The slide being edited, so it cannot be made to compare with itself. */
  slideId?: string;
}) {
  const fields = fieldsFor(kind);
  const definition = definitionFor(kind);

  const common = fields.filter((f) => f.common);
  const specific = fields.filter((f) => !f.common);

  return (
    <div className={styles.form}>
      <header className={styles.head}>
        <span className={styles.kindLabel}>{definition.label}</span>
        <p className={styles.kindBlurb}>{definition.blurb}</p>
      </header>

      <Section>
        {common.map((field) => (
          <Field
            key={field.name}
            field={field}
            config={config}
            onChange={onChange}
            slides={slides}
            slideId={slideId}
          />
        ))}
      </Section>

      {specific.length > 0 && (
        <Section title="Settings for this type">
          {specific.map((field) => (
            <Field
              key={field.name}
              field={field}
              config={config}
              onChange={onChange}
              slides={slides}
              slideId={slideId}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      {title && <h3 className={styles.sectionTitle}>{title}</h3>}
      {children}
    </section>
  );
}

function Field({
  field,
  config,
  onChange,
  slides = [],
  slideId,
}: {
  field: FieldSpec;
  config: Config;
  onChange: (patch: Config) => void;
  slides?: SlideRef[];
  slideId?: string;
}) {
  const id = useId();
  const value = config[field.name];

  if (field.kind === 'options') {
    return <ListEditor field={field} config={config} onChange={onChange} />;
  }

  if (field.kind === 'textList') {
    return <TextListEditor field={field} config={config} onChange={onChange} />;
  }

  if (field.kind === 'boolean') {
    return (
      <Toggle
        id={id}
        checked={value === true}
        label={field.label}
        hint={field.hint}
        onChange={(checked) => {
          onChange({ [field.name]: checked });
        }}
      />
    );
  }

  // A bounded number is a slider rather than a text field: dragging shows
  // the limits, and there is no way to type something out of range.
  if (
    field.kind === 'number' &&
    field.min !== undefined &&
    field.max !== undefined &&
    field.max - field.min <= 300
  ) {
    return (
      <Range
        id={id}
        value={typeof value === 'number' ? value : field.min}
        min={field.min}
        max={field.max}
        label={field.label}
        hint={field.hint}
        onChange={(next) => {
          onChange({ [field.name]: next });
        }}
      />
    );
  }

  /*
   * A pointer at another slide in the same deck.
   *
   * The value stored is an id, but nobody can type an id, so the choice is
   * made by prompt and position. Only slides the audience answers are
   * offered: a heading has no results to compare.
   */
  if (field.kind === 'slideRef') {
    const usable = slides.filter((s) => s.answerable && s.id !== slideId);

    if (usable.length === 0) {
      return (
        <div className={styles.field}>
          <span className={styles.label}>{field.label}</span>
          <p className={styles.hint}>
            Add a question slide to this deck first, then choose it here.
          </p>
        </div>
      );
    }

    return (
      <Choice
        id={id}
        value={typeof value === 'string' && value !== '' ? value : NONE}
        label={field.label}
        hint={field.hint}
        options={[
          { value: NONE, label: 'Not chosen' },
          ...usable.map((s) => ({
            value: s.id,
            // Position included because two slides often share a prompt --
            // "before" and "after" are usually the same question twice.
            label: `${String(s.position + 1)}. ${s.prompt || definitionFor(s.kind).label}`,
          })),
        ]}
        onChange={(next) => {
          onChange({ [field.name]: next === NONE ? '' : next });
        }}
      />
    );
  }

  if (field.kind === 'select' && field.choices) {
    return (
      <Choice
        id={id}
        value={typeof value === 'string' ? value : (field.choices[0] ?? '')}
        label={field.label}
        options={field.choices.map((choice) => ({
          value: choice,
          label: humaniseChoice(choice),
        }))}
        onChange={(next) => {
          onChange({ [field.name]: next });
        }}
      />
    );
  }

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {field.label}
      </label>

      {field.kind === 'longtext' && (
        <textarea
          id={id}
          className={styles.textarea}
          rows={3}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => {
            onChange({ [field.name]: e.target.value });
          }}
        />
      )}

      {field.kind === 'select' && (
        <select
          id={id}
          className={styles.select}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => {
            onChange({ [field.name]: e.target.value });
          }}
        >
          {field.choices?.map((choice) => (
            <option key={choice} value={choice}>
              {humaniseChoice(choice)}
            </option>
          ))}
        </select>
      )}

      {field.kind === 'number' && (
        <input
          id={id}
          type="number"
          className={styles.input}
          value={typeof value === 'number' ? value : ''}
          min={field.min}
          max={field.max}
          onChange={(e) => {
            // An empty box is a cleared field, not zero; sending 0 would
            // silently change the setting while the author is retyping.
            if (e.target.value === '') return;
            const next = Number(e.target.value);
            if (Number.isFinite(next)) onChange({ [field.name]: next });
          }}
        />
      )}

      {(field.kind === 'text' || field.kind === 'url') && (
        <input
          id={id}
          type={field.kind === 'url' ? 'url' : 'text'}
          className={styles.input}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.kind === 'url' ? 'https://…' : undefined}
          onChange={(e) => {
            onChange({ [field.name]: e.target.value });
          }}
        />
      )}

      {field.hint && <p className={styles.hint}>{field.hint}</p>}
      {field.kind === 'number' && field.min !== undefined && field.max !== undefined && (
        <p className={styles.hint}>
          Between {field.min} and {field.max}.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

type Entry = Record<string, unknown> & { id: string };

/**
 * A list of entries, with whatever each entry actually holds.
 *
 * The columns come from the kind's own schema, so this one editor covers
 * every list in the product: choices with a picture, a form's fields with
 * their type, a quiz's left-and-right pairs. It used to edit a label and
 * nothing else, which left Image Choice with no way to set an image and
 * Quiz: Match with no editor at all.
 */
function ListEditor({
  field,
  config,
  onChange,
}: {
  field: FieldSpec;
  config: Config;
  onChange: (patch: Config) => void;
}) {
  const raw = config[field.name];
  const entries: Entry[] = Array.isArray(raw) ? (raw as Entry[]) : [];
  const columns = field.columns ?? [];

  // What the schema allows, rather than a guess: a bullet list may go down
  // to one line, a ranking may not go below two.
  const minItems = field.minItems ?? 0;
  const maxItems = field.maxItems ?? 50;

  const write = (next: Entry[]) => {
    onChange({ [field.name]: next });
  };

  const setValue = (index: number, name: string, value: unknown) => {
    write(entries.map((entry, i) => (i === index ? { ...entry, [name]: value } : entry)));
  };

  /** The right answer is one of the entries, so marking one clears the rest. */
  const markCorrect = (index: number, name: string) => {
    write(entries.map((entry, i) => ({ ...entry, [name]: i === index })));
  };

  const add = () => {
    const blank: Entry = { id: newEntryId(entries.length) };

    for (const column of columns) {
      if (column.kind === 'boolean' || column.kind === 'correct') blank[column.name] = false;
      else if (column.kind === 'select') blank[column.name] = column.choices?.[0] ?? '';
      else if (column.kind === 'textList') blank[column.name] = [];
      else if (!column.optional) blank[column.name] = '';
    }

    write([...entries, blank]);
  };

  return (
    <div className={styles.field}>
      <span className={styles.label}>{field.label}</span>
      {field.hint !== undefined && <p className={styles.hint}>{field.hint}</p>}

      <ul className={styles.options}>
        {entries.map((entry, index) => (
          <li key={entry.id} className={styles.option} data-rows={columns.length > 2}>
            <GripVertical size={14} className={styles.optionGrip} aria-hidden="true" />

            <div className={styles.optionFields}>
              {columns.map((column) => (
                <ListCell
                  key={column.name}
                  column={column}
                  value={entry[column.name]}
                  index={index}
                  onChange={(value) => {
                    setValue(index, column.name, value);
                  }}
                  onMarkCorrect={() => {
                    markCorrect(index, column.name);
                  }}
                />
              ))}
            </div>

            <button
              type="button"
              className={styles.optionRemove}
              onClick={() => {
                write(entries.filter((_, i) => i !== index));
              }}
              disabled={entries.length <= minItems}
              title={
                entries.length <= minItems
                  ? `This slide needs at least ${String(minItems)}.`
                  : undefined
              }
              aria-label={`Remove ${String(index + 1)}`}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        className={styles.addOption}
        onClick={add}
        disabled={entries.length >= maxItems}
        title={entries.length >= maxItems ? `At most ${String(maxItems)}.` : undefined}
      >
        <Plus size={15} />
        Add
      </button>
    </div>
  );
}

/** One editable value inside a list entry. */
function ListCell({
  column,
  value,
  index,
  onChange,
  onMarkCorrect,
}: {
  column: ColumnSpec;
  value: unknown;
  index: number;
  onChange: (value: unknown) => void;
  onMarkCorrect: () => void;
}) {
  if (column.kind === 'correct') {
    return (
      <button
        type="button"
        className={styles.correctToggle}
        data-correct={value === true}
        onClick={onMarkCorrect}
        aria-label={`Mark ${String(index + 1)} correct`}
        title="Mark as the correct answer"
      >
        <Check size={12} />
      </button>
    );
  }

  if (column.kind === 'boolean') {
    return (
      <label className={styles.optionFlag}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        {column.label}
      </label>
    );
  }

  if (column.kind === 'select') {
    return (
      <select
        className={styles.optionSelect}
        value={typeof value === 'string' ? value : (column.choices?.[0] ?? '')}
        aria-label={column.label}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {(column.choices ?? []).map((choice) => (
          <option key={choice} value={choice}>
            {humaniseChoice(choice)}
          </option>
        ))}
      </select>
    );
  }

  if (column.kind === 'textList') {
    // A list inside a row, edited as one line. Typing commas is quicker
    // than a second nested editor, and these are short lists of choices.
    const items = Array.isArray(value) ? (value as string[]) : [];

    return (
      <input
        className={styles.optionInput}
        value={items.join(', ')}
        placeholder={`${column.label}, separated by commas`}
        aria-label={column.label}
        onChange={(event) => {
          onChange(
            event.target.value
              .split(',')
              .map((part) => part.trim())
              .filter((part) => part !== ''),
          );
        }}
      />
    );
  }

  return (
    <input
      className={column.kind === 'url' ? styles.optionUrl : styles.optionInput}
      type={column.kind === 'url' ? 'url' : 'text'}
      value={typeof value === 'string' ? value : ''}
      maxLength={column.max}
      placeholder={column.kind === 'url' ? 'https://… (optional)' : column.label}
      aria-label={column.label}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Plain lists                                                         */
/* ------------------------------------------------------------------ */

/**
 * A list of plain strings: the lines of a bullet slide, the spellings a
 * typed quiz answer will accept, the colours a drawing offers.
 */
function TextListEditor({
  field,
  config,
  onChange,
}: {
  field: FieldSpec;
  config: Config;
  onChange: (patch: Config) => void;
}) {
  const raw = config[field.name];
  const items: string[] = Array.isArray(raw) ? (raw as string[]) : [];

  const isColor = field.itemFormat === 'color';
  const minItems = field.minItems ?? 0;
  const maxItems = field.maxItems ?? 50;

  const write = (next: string[]) => {
    onChange({ [field.name]: next });
  };

  return (
    <div className={styles.field}>
      <span className={styles.label}>{field.label}</span>
      {field.hint !== undefined && <p className={styles.hint}>{field.hint}</p>}

      <ul className={styles.options}>
        {items.map((item, index) => (
          // Index as key: these are plain strings with nothing to identify
          // them, and the list is only ever edited in place.
          <li key={index} className={styles.option}>
            <GripVertical size={14} className={styles.optionGrip} aria-hidden="true" />

            <input
              className={isColor ? styles.optionColor : styles.optionInput}
              type={isColor ? 'color' : 'text'}
              value={item || (isColor ? '#6366f1' : '')}
              placeholder={`${field.label} ${String(index + 1)}`}
              aria-label={`${field.label} ${String(index + 1)}`}
              onChange={(event) => {
                write(items.map((value, i) => (i === index ? event.target.value : value)));
              }}
            />

            <button
              type="button"
              className={styles.optionRemove}
              onClick={() => {
                write(items.filter((_, i) => i !== index));
              }}
              disabled={items.length <= minItems}
              title={
                items.length <= minItems
                  ? `This slide needs at least ${String(minItems)}.`
                  : undefined
              }
              aria-label={`Remove ${String(index + 1)}`}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        className={styles.addOption}
        onClick={() => {
          write([...items, isColor ? '#6366f1' : '']);
        }}
        disabled={items.length >= maxItems}
        title={items.length >= maxItems ? `At most ${String(maxItems)}.` : undefined}
      >
        <Plus size={15} />
        Add
      </button>
    </div>
  );
}

/** Ids only need to be unique inside one slide. */
function newEntryId(position: number): string {
  return `o${String(Date.now()).slice(-6)}${String(position)}`;
}

/** "bars" -> "Bars", "stacked_bars" -> "Stacked bars". */
function humaniseChoice(value: string): string {
  const spaced = value.replace(/[_-]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
