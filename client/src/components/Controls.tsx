import * as Switch from '@radix-ui/react-switch';
import * as Slider from '@radix-ui/react-slider';
import * as Select from '@radix-ui/react-select';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Check, ChevronDown, Info } from 'lucide-react';
import styles from './Controls.module.css';

/**
 * The form controls, built on Radix primitives.
 *
 * These replace hand-rolled equivalents. A checkbox styled to look like a
 * switch is not a switch: it announces itself wrongly to a screen reader,
 * loses its focus ring, and behaves differently under a keyboard. Radix
 * handles all of that and leaves the appearance entirely to us.
 */

/* ------------------------------------------------------------------ */
/* Switch                                                              */
/* ------------------------------------------------------------------ */

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  id: string;
}) {
  return (
    <div className={styles.toggleRow}>
      <label className={styles.toggleText} htmlFor={id}>
        <span className={styles.label}>{label}</span>
        {hint !== undefined && hint !== '' && <span className={styles.hint}>{hint}</span>}
      </label>

      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className={styles.switchRoot}
      >
        <Switch.Thumb className={styles.switchThumb} />
      </Switch.Root>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Slider                                                              */
/* ------------------------------------------------------------------ */

/**
 * A number chosen by dragging.
 *
 * Used where a range is small and bounded — a countdown, a star count —
 * because dragging communicates the limits in a way a text field cannot,
 * and removes the whole class of out-of-range values.
 */
export function Range({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  hint,
  suffix,
  id,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  hint?: string;
  suffix?: string;
  id: string;
}) {
  return (
    <div className={styles.field}>
      <div className={styles.rangeHead}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        <span className={styles.rangeValue}>
          {value}
          {suffix !== undefined && suffix !== '' ? ` ${suffix}` : ''}
        </span>
      </div>

      <Slider.Root
        id={id}
        className={styles.sliderRoot}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => {
          const first = next[0];
          if (first !== undefined) onChange(first);
        }}
      >
        <Slider.Track className={styles.sliderTrack}>
          <Slider.Range className={styles.sliderRange} />
        </Slider.Track>
        <Slider.Thumb className={styles.sliderThumb} aria-label={label} />
      </Slider.Root>

      {hint !== undefined && hint !== '' && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

/**
 * A choice from a list.
 *
 * A native select cannot be styled consistently across browsers and looks
 * out of place in a designed interface; this keeps the keyboard behaviour
 * and typeahead of the native element while matching everything else.
 */
export function Choice({
  value,
  onChange,
  options,
  label,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
  id: string;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>

      <Select.Root value={value} onValueChange={onChange}>
        <Select.Trigger id={id} className={styles.selectTrigger} aria-label={label}>
          <Select.Value />
          <Select.Icon>
            <ChevronDown size={15} />
          </Select.Icon>
        </Select.Trigger>

        <Select.Portal>
          <Select.Content className={styles.selectContent} position="popper" sideOffset={4}>
            <Select.Viewport className={styles.selectViewport}>
              {options.map((option) => (
                <Select.Item key={option.value} value={option.value} className={styles.selectItem}>
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator className={styles.selectIndicator}>
                    <Check size={14} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

/** Wraps the app once, so individual tooltips need no provider of their own. */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={300}>
      {children}
    </Tooltip.Provider>
  );
}

/**
 * An explanation that appears on hover or focus.
 *
 * Keyboard-reachable, unlike a title attribute, and it disappears on
 * Escape — which matters when one is covering the thing you are trying to
 * read.
 */
export function Hint({ children, text }: { children: React.ReactNode; text: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className={styles.tooltip} sideOffset={6}>
          {text}
          <Tooltip.Arrow className={styles.tooltipArrow} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** A small question mark that explains a setting. */
export function InfoHint({ text }: { text: string }) {
  return (
    <Hint text={text}>
      <button type="button" className={styles.infoButton} aria-label={text}>
        <Info size={13} />
      </button>
    </Hint>
  );
}
