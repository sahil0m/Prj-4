import { useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { DayPicker, type DateRange } from 'react-day-picker';
import { Calendar, X, ChevronLeft, ChevronRight } from 'lucide-react';
import 'react-day-picker/style.css';
import styles from './DateRangePicker.module.css';

/**
 * Picking a span of days.
 *
 * This replaced two native date inputs. They worked, but they showed
 * "dd-mm-yyyy" until typed into, gave no sense of which days actually had
 * sessions, and made the most common request -- "the last week" -- into
 * two separate acts of arithmetic. A range is a shape, and a calendar is
 * the only control that shows it as one.
 *
 * The presets are the point as much as the calendar is. Almost every real
 * question here is relative ("this month", "the last fortnight"), and
 * answering those by counting backwards from today is the kind of small
 * friction that stops people filtering at all.
 */

export interface DateRangeValue {
  /** YYYY-MM-DD, or empty for open-ended. */
  from: string;
  to: string;
}

export function DateRangePicker({
  value,
  onChange,
}: {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const months = useMonthCount();

  const selected: DateRange | undefined =
    value.from === '' && value.to === ''
      ? undefined
      : { from: parseDate(value.from), to: parseDate(value.to) };

  const commit = (range: DateRange | undefined) => {
    onChange({
      from: range?.from ? formatDate(range.from) : '',
      to: range?.to ? formatDate(range.to) : '',
    });
  };

  const chosen = value.from !== '' || value.to !== '';

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={styles.trigger} data-chosen={chosen}>
          <Calendar size={15} />
          <span className={styles.triggerLabel}>{describe(value)}</span>

          {/* Clearing without opening the calendar, because "show me
              everything again" should not need a second dialog. */}
          {chosen && (
            <span
              className={styles.clear}
              role="button"
              tabIndex={0}
              aria-label="Clear dates"
              onClick={(event) => {
                event.stopPropagation();
                commit(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                commit(undefined);
              }}
            >
              <X size={13} />
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content className={styles.panel} sideOffset={8} align="end">
          <div className={styles.presets}>
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={styles.preset}
                data-active={matches(preset, value)}
                onClick={() => {
                  commit(preset.range());
                  setOpen(false);
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className={styles.calendar}>
            <DayPicker
              mode="range"
              selected={selected}
              onSelect={commit}
              numberOfMonths={months}
              defaultMonth={selected?.from}
              /* Nothing was presented tomorrow, so offering it is noise. */
              disabled={{ after: new Date() }}
              showOutsideDays
              components={{
                PreviousMonthButton: (props) => (
                  <button {...props} type="button">
                    <ChevronLeft size={16} />
                  </button>
                ),
                NextMonthButton: (props) => (
                  <button {...props} type="button">
                    <ChevronRight size={16} />
                  </button>
                ),
              }}
            />
          </div>

          <footer className={styles.footer}>
            <button
              type="button"
              className={styles.footerClear}
              disabled={!chosen}
              onClick={() => {
                commit(undefined);
              }}
            >
              Clear
            </button>

            <button
              type="button"
              className={styles.done}
              onClick={() => {
                setOpen(false);
              }}
            >
              Done
            </button>
          </footer>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

const daysAgo = (days: number): Date => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
};

const PRESETS: { label: string; range: () => DateRange }[] = [
  { label: 'Last 7 days', range: () => ({ from: daysAgo(6), to: new Date() }) },
  { label: 'Last 30 days', range: () => ({ from: daysAgo(29), to: new Date() }) },
  {
    label: 'This month',
    range: () => {
      const now = new Date();
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
    },
  },
  {
    label: 'Last month',
    range: () => {
      const now = new Date();
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        // Day zero of this month is the last day of the previous one.
        to: new Date(now.getFullYear(), now.getMonth(), 0),
      };
    },
  },
  {
    label: 'This year',
    range: () => {
      const now = new Date();
      return { from: new Date(now.getFullYear(), 0, 1), to: now };
    },
  },
];

/** Whether a preset describes the range currently chosen. */
function matches(preset: { range: () => DateRange }, value: DateRangeValue): boolean {
  const range = preset.range();
  return (
    range.from !== undefined &&
    formatDate(range.from) === value.from &&
    range.to !== undefined &&
    formatDate(range.to) === value.to
  );
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/*
 * Local date parts, never toISOString().
 *
 * toISOString converts to UTC first, so anyone east of Greenwich in the
 * evening gets tomorrow's date and anyone west gets yesterday's. A filter
 * that is off by one day for half the world is worse than no filter.
 */
function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

function parseDate(value: string): Date | undefined {
  if (value === '') return undefined;
  // Parsed as local midnight rather than UTC, for the same reason.
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** "12 – 18 Mar", "Mar 2026", "All time". */
function describe(value: DateRangeValue): string {
  const from = parseDate(value.from);
  const to = parseDate(value.to);

  if (!from && !to) return 'All time';

  const day = (date: Date) =>
    date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  if (from && !to) return `From ${day(from)}`;
  if (!from && to) return `Until ${day(to)}`;
  if (!from || !to) return 'All time';

  if (formatDate(from) === formatDate(to)) return day(from);

  // Within one month the month and year are said once, not twice.
  if (from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth()) {
    return `${String(from.getDate())} – ${day(to)}`;
  }

  return `${day(from)} – ${day(to)}`;
}

/* ------------------------------------------------------------------ */

/**
 * Two months side by side, one on a narrow window.
 *
 * Two is what makes a range easy to choose, because most ranges cross a
 * month boundary -- but two will not fit on a laptop in a split window,
 * and a calendar that overflows its popover is unusable.
 */
function useMonthCount(): number {
  const [months, setMonths] = useState(2);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 720px)');

    const update = () => {
      setMonths(query.matches ? 1 : 2);
    };

    update();
    query.addEventListener('change', update);

    return () => {
      query.removeEventListener('change', update);
    };
  }, []);

  return months;
}
