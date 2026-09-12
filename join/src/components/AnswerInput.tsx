import { useState } from 'react';
import type { SlideKind } from '@pulse/shared';
import { PinInput, MapInput, GridInput, DrawingInput } from './SpatialInput';
import { QuickFormInput, MatchInput } from './FormInput';
import styles from './AnswerInput.module.css';

/**
 * The answer controls, one per slide kind.
 *
 * Every target here is at least 44px tall, because this is used one-handed,
 * often standing, sometimes in a dark room. Nothing depends on hover, and
 * nothing depends on precision.
 */

interface Option {
  id: string;
  label: string;
  imageUrl?: string;
}

export interface AnswerInputProps {
  kind: SlideKind;
  config: Record<string, unknown>;
  disabled: boolean;
  onSubmit: (payload: unknown) => void;
}

function optionsOf(config: Record<string, unknown>): Option[] {
  return Array.isArray(config.options) ? (config.options as Option[]) : [];
}

function itemsOf(config: Record<string, unknown>): Option[] {
  return Array.isArray(config.items) ? (config.items as Option[]) : [];
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function AnswerInput(props: AnswerInputProps) {
  switch (props.kind) {
    case 'multiple_choice':
    case 'image_choice':
    case 'quiz_select':
      return <ChoiceInput {...props} />;

    case 'who_will_win':
      return <ChoiceInput {...props} single />;

    case 'true_false':
      return <TrueFalseInput {...props} />;

    case 'word_cloud':
      return <WordsInput {...props} />;

    case 'open_text':
    case 'quiz_type':
      return <TextInput {...props} />;

    case 'star_rating':
      return <StarsInput {...props} />;

    case 'nps':
      return <NpsInput {...props} />;

    case 'guess_number':
      return <NumberInput {...props} />;

    case 'scales':
      return <ScalesInput {...props} />;

    case 'ranking':
    case 'quiz_order':
      return <RankingInput {...props} />;

    case 'points_100':
      return <PointsInput {...props} />;

    case 'pin_image':
      return <PinInput {...props} />;

    case 'map_pin':
      return <MapInput {...props} />;

    case 'grid_2x2':
      return <GridInput {...props} />;

    case 'drawing':
      return <DrawingInput {...props} />;

    case 'quick_form':
      return <QuickFormInput {...props} />;

    case 'quiz_match':
      return <MatchInput {...props} />;

    default:
      return <p className={styles.watchOnly}>Nothing to answer here — look at the screen.</p>;
  }
}

/* ------------------------------------------------------------------ */
/* Choice                                                              */
/* ------------------------------------------------------------------ */

function ChoiceInput({
  kind,
  config,
  disabled,
  onSubmit,
  single,
}: AnswerInputProps & { single?: boolean }) {
  const options = optionsOf(config);
  const multi = single ? false : config.multiSelect === true;
  const max = numberOf(config.maxSelections, multi ? options.length : 1);

  const [picked, setPicked] = useState<string[]>([]);

  const toggle = (id: string) => {
    if (disabled) return;

    if (!multi) {
      // A single-choice tap is the answer; asking for a second confirm tap
      // costs the room time for nothing.
      onSubmit(kind === 'who_will_win' ? { optionId: id } : { optionIds: [id] });
      setPicked([id]);
      return;
    }

    setPicked((current) =>
      current.includes(id)
        ? current.filter((x) => x !== id)
        : current.length >= max
          ? current
          : [...current, id],
    );
  };

  return (
    <div className={styles.stack}>
      <div className={styles.options}>
        {options.map((option, i) => (
          <button
            key={option.id}
            type="button"
            className={styles.option}
            data-picked={picked.includes(option.id)}
            disabled={disabled}
            onClick={() => {
              toggle(option.id);
            }}
          >
            <span className={styles.optionKey}>{String.fromCharCode(65 + i)}</span>
            <span className={styles.optionLabel}>{option.label || `Option ${String(i + 1)}`}</span>
          </button>
        ))}
      </div>

      {multi && (
        <>
          <p className={styles.hint}>
            {picked.length} of {max} selected
          </p>
          <SubmitButton
            disabled={disabled || picked.length === 0}
            onClick={() => {
              onSubmit({ optionIds: picked });
            }}
          />
        </>
      )}
    </div>
  );
}

function TrueFalseInput({ disabled, onSubmit }: AnswerInputProps) {
  return (
    <div className={styles.twoUp}>
      <button
        type="button"
        className={`${styles.bigChoice} ${styles.trueChoice}`}
        disabled={disabled}
        onClick={() => {
          onSubmit({ value: true });
        }}
      >
        True
      </button>
      <button
        type="button"
        className={`${styles.bigChoice} ${styles.falseChoice}`}
        disabled={disabled}
        onClick={() => {
          onSubmit({ value: false });
        }}
      >
        False
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

function WordsInput({ config, disabled, onSubmit }: AnswerInputProps) {
  const maxChars = numberOf(config.maxCharacters, 30);
  const entries = numberOf(config.entriesPerPerson, 1);

  const [words, setWords] = useState<string[]>(() => Array.from({ length: entries }, () => ''));

  const filled = words.map((w) => w.trim()).filter((w) => w !== '');

  return (
    <div className={styles.stack}>
      {words.map((word, i) => (
        <input
          key={i}
          className={styles.input}
          value={word}
          maxLength={maxChars}
          disabled={disabled}
          placeholder={entries > 1 ? `Word ${String(i + 1)}` : 'Type one word'}
          // Off, because a phone keyboard capitalising the first letter makes
          // "React" and "react" look like disagreement to the person typing.
          autoCapitalize="none"
          autoCorrect="off"
          enterKeyHint={i === words.length - 1 ? 'send' : 'next'}
          onChange={(e) => {
            setWords((current) => current.map((w, j) => (j === i ? e.currentTarget.value : w)));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filled.length > 0) onSubmit({ words: filled });
          }}
        />
      ))}

      <SubmitButton
        disabled={disabled || filled.length === 0}
        onClick={() => {
          onSubmit({ words: filled });
        }}
      />
    </div>
  );
}

function TextInput({ config, disabled, onSubmit }: AnswerInputProps) {
  const maxChars = numberOf(config.maxCharacters, 250);
  const [text, setText] = useState('');

  const remaining = maxChars - text.length;

  return (
    <div className={styles.stack}>
      <textarea
        className={styles.textarea}
        value={text}
        maxLength={maxChars}
        rows={4}
        disabled={disabled}
        placeholder="Type your answer"
        onChange={(e) => {
          setText(e.currentTarget.value);
        }}
      />
      <p className={styles.hint} data-warn={remaining < 20}>
        {remaining} characters left
      </p>
      <SubmitButton
        disabled={disabled || text.trim() === ''}
        onClick={() => {
          onSubmit({ text: text.trim() });
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rating                                                              */
/* ------------------------------------------------------------------ */

function StarsInput({ config, disabled, onSubmit }: AnswerInputProps) {
  const total = numberOf(config.stars, 5);
  const [value, setValue] = useState(0);

  return (
    <div className={styles.stack}>
      <div className={styles.stars} role="group" aria-label="Rating">
        {Array.from({ length: total }, (_, i) => i + 1).map((star) => (
          <button
            key={star}
            type="button"
            className={styles.star}
            data-on={star <= value}
            disabled={disabled}
            aria-label={`${String(star)} of ${String(total)}`}
            onClick={() => {
              setValue(star);
            }}
          >
            <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true">
              <path
                d="M12 2.5l2.9 6.2 6.6.9-4.8 4.6 1.2 6.6L12 17.7 6.1 20.8l1.2-6.6L2.5 9.6l6.6-.9z"
                fill="currentColor"
              />
            </svg>
          </button>
        ))}
      </div>

      <SubmitButton
        disabled={disabled || value === 0}
        onClick={() => {
          onSubmit({ stars: value });
        }}
      />
    </div>
  );
}

function NpsInput({ disabled, onSubmit }: AnswerInputProps) {
  const [score, setScore] = useState<number | null>(null);

  return (
    <div className={styles.stack}>
      <div className={styles.npsGrid}>
        {Array.from({ length: 11 }, (_, i) => i).map((n) => (
          <button
            key={n}
            type="button"
            className={styles.npsButton}
            data-picked={score === n}
            data-band={n >= 9 ? 'promoter' : n >= 7 ? 'passive' : 'detractor'}
            disabled={disabled}
            onClick={() => {
              setScore(n);
            }}
          >
            {n}
          </button>
        ))}
      </div>

      <div className={styles.npsLegend}>
        <span>Not likely</span>
        <span>Very likely</span>
      </div>

      <SubmitButton
        disabled={disabled || score === null}
        onClick={() => {
          if (score !== null) onSubmit({ score });
        }}
      />
    </div>
  );
}

function NumberInput({ config, disabled, onSubmit }: AnswerInputProps) {
  const min = numberOf(config.min, 0);
  const max = numberOf(config.max, 1000);
  const unit = typeof config.unit === 'string' ? config.unit : '';

  const [value, setValue] = useState('');

  const parsed = Number(value);
  const valid = value !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max;

  return (
    <div className={styles.stack}>
      <div className={styles.numberRow}>
        <input
          className={`${styles.input} ${styles.numberInput}`}
          // inputMode rather than type=number: it brings up the numeric
          // keypad without the spinner arrows, which are unusable on a phone.
          inputMode="decimal"
          value={value}
          disabled={disabled}
          placeholder={`${String(min)}–${String(max)}`}
          onChange={(e) => {
            setValue(e.currentTarget.value);
          }}
        />
        {unit !== '' && <span className={styles.unit}>{unit}</span>}
      </div>

      {value !== '' && !valid && (
        <p className={styles.hint} data-warn="true">
          Enter a number between {min} and {max}.
        </p>
      )}

      <SubmitButton
        disabled={disabled || !valid}
        onClick={() => {
          onSubmit({ value: parsed });
        }}
      />
    </div>
  );
}

function ScalesInput({ config, disabled, onSubmit }: AnswerInputProps) {
  const statements = Array.isArray(config.statements) ? (config.statements as Option[]) : [];
  const min = numberOf(config.min, 1);
  const max = numberOf(config.max, 5);

  const [values, setValues] = useState<Record<string, number>>({});
  const complete = statements.every((s) => values[s.id] !== undefined);

  return (
    <div className={styles.stack}>
      {statements.map((statement) => (
        <div key={statement.id} className={styles.scaleRow}>
          <p className={styles.scaleLabel}>{statement.label}</p>
          <div className={styles.scaleButtons}>
            {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
              <button
                key={n}
                type="button"
                className={styles.scaleButton}
                data-picked={values[statement.id] === n}
                disabled={disabled}
                onClick={() => {
                  setValues((current) => ({ ...current, [statement.id]: n }));
                }}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      ))}

      <SubmitButton
        disabled={disabled || !complete}
        onClick={() => {
          onSubmit({ values });
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ordering and allocation                                             */
/* ------------------------------------------------------------------ */

/**
 * Ranking, without drag and drop.
 *
 * Dragging a list on a phone fights the page scroll and is hard for anyone
 * with a motor impairment. Up and down buttons are slower to look at and far
 * easier to use, and they work with a screen reader.
 */
function RankingInput({ config, disabled, onSubmit }: AnswerInputProps) {
  const source = itemsOf(config).length > 0 ? itemsOf(config) : optionsOf(config);
  const [order, setOrder] = useState<Option[]>(source);

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= order.length) return;

    setOrder((current) => {
      const next = [...current];
      const a = next[index];
      const b = next[target];
      if (!a || !b) return current;
      next[index] = b;
      next[target] = a;
      return next;
    });
  };

  return (
    <div className={styles.stack}>
      <p className={styles.hint}>Best at the top.</p>

      <ol className={styles.rankList}>
        {order.map((item, i) => (
          <li key={item.id} className={styles.rankItem}>
            <span className={styles.rankNumber}>{i + 1}</span>
            <span className={styles.rankLabel}>{item.label}</span>
            <span className={styles.rankControls}>
              <button
                type="button"
                className={styles.rankButton}
                disabled={disabled || i === 0}
                aria-label={`Move ${item.label} up`}
                onClick={() => {
                  move(i, -1);
                }}
              >
                <Chevron up />
              </button>
              <button
                type="button"
                className={styles.rankButton}
                disabled={disabled || i === order.length - 1}
                aria-label={`Move ${item.label} down`}
                onClick={() => {
                  move(i, 1);
                }}
              >
                <Chevron />
              </button>
            </span>
          </li>
        ))}
      </ol>

      <SubmitButton
        disabled={disabled}
        onClick={() => {
          onSubmit({ order: order.map((o) => o.id) });
        }}
      />
    </div>
  );
}

function PointsInput({ config, disabled, onSubmit }: AnswerInputProps) {
  const items = itemsOf(config);
  const budget = numberOf(config.totalPoints, 100);

  const [allocation, setAllocation] = useState<Record<string, number>>({});

  const spent = Object.values(allocation).reduce((sum, n) => sum + n, 0);
  const left = budget - spent;

  const setPoints = (id: string, raw: string) => {
    const value = Math.max(0, Math.floor(Number(raw) || 0));
    const others = spent - (allocation[id] ?? 0);
    // Clamped to what is actually left, so the total can never exceed the
    // budget and the server never has to reject the whole answer.
    const capped = Math.min(value, budget - others);
    setAllocation((current) => ({ ...current, [id]: capped }));
  };

  return (
    <div className={styles.stack}>
      <div className={styles.budget} data-spent={left === 0}>
        <strong>{left}</strong> of {budget} points left
      </div>

      {items.map((item) => (
        <div key={item.id} className={styles.pointsRow}>
          <span className={styles.pointsLabel}>{item.label}</span>
          <input
            className={styles.pointsInput}
            inputMode="numeric"
            value={allocation[item.id] ?? ''}
            disabled={disabled}
            placeholder="0"
            onChange={(e) => {
              setPoints(item.id, e.currentTarget.value);
            }}
          />
        </div>
      ))}

      <SubmitButton
        disabled={disabled || spent === 0}
        onClick={() => {
          onSubmit({ allocation });
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function SubmitButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className={styles.submit} disabled={disabled} onClick={onClick}>
      Send
    </button>
  );
}

function Chevron({ up }: { up?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={up ? { transform: 'rotate(180deg)' } : undefined}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
