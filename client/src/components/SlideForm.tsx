import { useId } from 'react';
import { Plus, Trash2, GripVertical, Check } from 'lucide-react';
import { fieldsFor, definitionFor, type FieldSpec, type SlideKind } from '@pulse/shared';
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
    return <OptionsEditor field={field} config={config} onChange={onChange} />;
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
/* Options                                                             */
/* ------------------------------------------------------------------ */

interface Option {
  id: string;
  label: string;
  correct?: boolean;
  imageUrl?: string;
}

/**
 * The answer choices for a multiple-choice or quiz slide.
 *
 * Quiz kinds gain a correct-answer tick; everything else shows labels only.
 */
function OptionsEditor({
  field,
  config,
  onChange,
}: {
  field: FieldSpec;
  config: Config;
  onChange: (patch: Config) => void;
}) {
  const raw = config[field.name];
  const options: Option[] = Array.isArray(raw) ? (raw as Option[]) : [];
  const isQuiz = options.some((o) => 'correct' in o);

  const write = (next: Option[]) => {
    onChange({ [field.name]: next });
  };

  const setLabel = (index: number, label: string) => {
    write(options.map((o, i) => (i === index ? { ...o, label } : o)));
  };

  const markCorrect = (index: number) => {
    write(options.map((o, i) => ({ ...o, correct: i === index })));
  };

  const add = () => {
    // Ids only need to be unique inside the slide.
    const id = `o${String(Date.now()).slice(-6)}${String(options.length)}`;
    write([...options, { id, label: '' }]);
  };

  const remove = (index: number) => {
    write(options.filter((_, i) => i !== index));
  };

  return (
    <div className={styles.field}>
      <span className={styles.label}>{field.label}</span>

      <ul className={styles.options}>
        {options.map((option, index) => (
          <li key={option.id} className={styles.option}>
            <GripVertical size={14} className={styles.optionGrip} aria-hidden="true" />

            {isQuiz && (
              <button
                type="button"
                className={styles.correctToggle}
                data-correct={option.correct === true}
                onClick={() => {
                  markCorrect(index);
                }}
                aria-label={`Mark option ${String(index + 1)} correct`}
                title="Mark as the correct answer"
              >
                <Check size={12} />
              </button>
            )}

            <input
              className={styles.optionInput}
              value={option.label}
              placeholder={`Option ${String(index + 1)}`}
              onChange={(e) => {
                setLabel(index, e.target.value);
              }}
            />

            <button
              type="button"
              className={styles.optionRemove}
              onClick={() => {
                remove(index);
              }}
              // Most choice schemas require at least two options; removing
              // below that would fail validation on save.
              disabled={options.length <= 2}
              aria-label={`Remove option ${String(index + 1)}`}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>

      <button type="button" className={styles.addOption} onClick={add}>
        <Plus size={15} />
        Add option
      </button>
    </div>
  );
}

/** "bars" -> "Bars", "stacked_bars" -> "Stacked bars". */
function humaniseChoice(value: string): string {
  const spaced = value.replace(/[_-]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
