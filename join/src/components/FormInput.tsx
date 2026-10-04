import { useState } from 'react';
import styles from './SpatialInput.module.css';
import formStyles from './FormInput.module.css';

/**
 * The last two answerable kinds: a short form, and matching pairs.
 *
 * Both collect structured answers rather than a single value, which is why
 * they need their own components rather than a variant of the choice input.
 */

/* ------------------------------------------------------------------ */
/* Quick form                                                          */
/* ------------------------------------------------------------------ */

interface FormField {
  id: string;
  label: string;
  type?: string;
  required?: boolean;
  /** The choices of a select field, as the schema stores them: plain strings. */
  options?: string[];
}

/**
 * A handful of questions on one screen.
 *
 * Everything on one screen rather than a wizard: these are short by design,
 * and a room answering a five-field form does not want five taps of "next"
 * while the presenter waits.
 */
export function QuickFormInput({
  config,
  disabled,
  onSubmit,
}: {
  config: Record<string, unknown>;
  disabled: boolean;
  onSubmit: (payload: unknown) => void;
}) {
  const fields = Array.isArray(config.fields) ? (config.fields as FormField[]) : [];

  const [values, setValues] = useState<Record<string, string | number | boolean>>({});

  const set = (id: string, value: string | number | boolean) => {
    setValues((current) => ({ ...current, [id]: value }));
  };

  // A required field with nothing in it blocks sending; everything else is
  // optional, so a partial answer is still worth having.
  const complete = fields.every((field) => {
    if (field.required !== true) return true;
    const value = values[field.id];
    return value !== undefined && value !== '' && value !== false;
  });

  if (fields.length === 0) {
    return <p className={styles.missing}>The presenter has not added any questions yet.</p>;
  }

  return (
    <div className={styles.stack}>
      {fields.map((field) => (
        <div key={field.id} className={formStyles.field}>
          <label className={formStyles.label} htmlFor={`f-${field.id}`}>
            {field.label}
            {field.required === true && <span className={formStyles.required}>required</span>}
          </label>

          {/*
            The type names come from the field's own schema: text, email,
            number, select, checkbox. This used to look for 'choice' and
            'boolean', which the schema has never produced -- so a dropdown
            and a tick box both rendered as a plain text box.
          */}
          {field.type === 'select' && field.options && field.options.length > 0 ? (
            <div className={formStyles.choices}>
              {field.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={formStyles.choice}
                  data-picked={values[field.id] === option}
                  disabled={disabled}
                  onClick={() => {
                    set(field.id, option);
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          ) : field.type === 'checkbox' ? (
            <button
              type="button"
              className={formStyles.toggle}
              data-on={values[field.id] === true}
              disabled={disabled}
              onClick={() => {
                set(field.id, values[field.id] !== true);
              }}
            >
              {values[field.id] === true ? 'Yes' : 'No'}
            </button>
          ) : (
            <input
              id={`f-${field.id}`}
              className={formStyles.input}
              // inputMode rather than type=number: the numeric keypad
              // without the spinner arrows, which are unusable on a phone.
              type={field.type === 'email' ? 'email' : 'text'}
              inputMode={
                field.type === 'number' ? 'decimal' : field.type === 'email' ? 'email' : 'text'
              }
              autoComplete={field.type === 'email' ? 'email' : 'off'}
              value={String(values[field.id] ?? '')}
              maxLength={1000}
              disabled={disabled}
              onChange={(e) => {
                const raw = e.currentTarget.value;
                set(field.id, field.type === 'number' ? Number(raw) || 0 : raw);
              }}
            />
          )}
        </div>
      ))}

      <button
        type="button"
        className={styles.submit}
        disabled={disabled || !complete || Object.keys(values).length === 0}
        onClick={() => {
          onSubmit({ fields: values });
        }}
      >
        Send
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Match pairs                                                         */
/* ------------------------------------------------------------------ */

interface Pair {
  id: string;
  left: string;
  right: string;
}

/**
 * Matching one column to another.
 *
 * Tap a left item, then tap its match. Drawing lines between two columns is
 * how this looks on a desktop and is unusable with a thumb; two taps is
 * both easier and works with a screen reader.
 */
export function MatchInput({
  config,
  disabled,
  onSubmit,
}: {
  config: Record<string, unknown>;
  disabled: boolean;
  onSubmit: (payload: unknown) => void;
}) {
  const pairs = Array.isArray(config.pairs) ? (config.pairs as Pair[]) : [];

  const [matches, setMatches] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);

  // Shuffled once on mount, and deterministically per session: presenting
  // the right column in the same order as the left would give the answer
  // away, and reshuffling on every render would move it under a thumb.
  const [rights] = useState(() =>
    pairs.map((pair) => pair.right).sort((a, b) => a.localeCompare(b)),
  );

  const pick = (right: string) => {
    if (disabled || selected === null) return;

    setMatches((current) => {
      // One right-hand item can only serve one pair, so choosing it again
      // releases it from wherever it was. Rebuilt rather than mutated: a
      // delete on a computed key is easy to get subtly wrong.
      const freed = Object.fromEntries(
        Object.entries(current).filter(([key, value]) => key === selected || value !== right),
      );

      return { ...freed, [selected]: right };
    });

    setSelected(null);
  };

  if (pairs.length === 0) {
    return <p className={styles.missing}>The presenter has not added any pairs yet.</p>;
  }

  const done = Object.keys(matches).length;

  return (
    <div className={styles.stack}>
      <p className={styles.hint}>
        {selected === null
          ? done === pairs.length
            ? 'All matched'
            : 'Tap something on the left, then its match'
          : 'Now tap its match'}
      </p>

      <div className={formStyles.columns}>
        <div className={formStyles.column}>
          {pairs.map((pair) => (
            <button
              key={pair.id}
              type="button"
              className={formStyles.matchItem}
              data-selected={selected === pair.id}
              data-matched={matches[pair.id] !== undefined}
              disabled={disabled}
              onClick={() => {
                setSelected(selected === pair.id ? null : pair.id);
              }}
            >
              <span className={formStyles.matchLabel}>{pair.left}</span>
              {matches[pair.id] !== undefined && (
                <span className={formStyles.matchedTo}>{matches[pair.id]}</span>
              )}
            </button>
          ))}
        </div>

        <div className={formStyles.column}>
          {rights.map((right) => (
            <button
              key={right}
              type="button"
              className={formStyles.matchItem}
              data-used={Object.values(matches).includes(right)}
              disabled={disabled || selected === null}
              onClick={() => {
                pick(right);
              }}
            >
              {right}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        className={styles.submit}
        disabled={disabled || done === 0}
        onClick={() => {
          onSubmit({ matches });
        }}
      >
        {done < pairs.length ? `Send ${String(done)} of ${String(pairs.length)}` : 'Send'}
      </button>
    </div>
  );
}
