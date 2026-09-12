import { useMemo } from 'react';
import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import type { SlideResults, ResultData, CountedItem, WordTally } from '@pulse/shared';
import styles from './Results.module.css';

/**
 * Live results, drawn as SVG.
 *
 * Built by hand rather than with a chart library: these are simple shapes,
 * and a general-purpose library would cost more in bundle size than the
 * drawing code costs to write. It also lets every bar animate from its
 * previous value rather than redrawing, which is what makes a room watch.
 */

export function Results({
  results,
  revealCorrect = false,
}: {
  results: SlideResults | null;
  /**
   * Whether to mark the right answer.
   *
   * Off while a quiz is still taking answers: the correct bar standing out
   * on the projector would tell the room what to pick.
   */
  revealCorrect?: boolean;
}) {
  if (!results || results.count === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.waitingDots} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className={styles.emptyText}>Waiting for the first answer</p>
      </div>
    );
  }

  const data = results.data as ResultData;

  switch (data.type) {
    case 'counts':
      return <Bars items={data.items} total={results.count} reveal={revealCorrect} />;
    case 'words':
      return <WordCloud words={data.words} />;
    case 'texts':
      return <TextWall entries={data.entries} />;
    case 'numeric':
      return <NumericSummary summary={data.summary} />;
    case 'nps':
      return <NpsResult summary={data.summary} />;
    case 'scales':
      return <ScaleBars statements={data.statements} />;
    case 'ranking':
      return <RankingList items={data.items} />;
    case 'points':
      return <PointsBars items={data.items} />;
    case 'scatter':
      return <Scatter points={data.points} />;
    case 'pins':
      return <PinMap pins={data.pins} />;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Bars                                                                */
/* ------------------------------------------------------------------ */

function Bars({ items, total, reveal }: { items: CountedItem[]; total: number; reveal: boolean }) {
  // Scaled to the leader rather than to 100%, so a close race still fills
  // the screen and small differences stay visible from the back of a room.
  const peak = Math.max(...items.map((i) => i.count), 1);

  return (
    <div className={styles.bars}>
      {items.map((item, i) => (
        <div
          key={item.id}
          className={styles.barRow}
          // Once revealed, everything that is not the right answer recedes,
          // so the correct one is unmistakable from the back of a room.
          data-reveal={reveal ? (item.correct === true ? 'correct' : 'wrong') : undefined}
        >
          <div className={styles.barLabel}>
            <span className={styles.barKey}>{String.fromCharCode(65 + i)}</span>
            <span className={styles.barText}>{item.label}</span>
            {reveal && item.correct === true && (
              <span className={styles.correctTag} aria-label="Correct answer">
                <Check size={16} strokeWidth={3} />
              </span>
            )}
          </div>

          <div className={styles.barTrack}>
            <motion.div
              className={styles.barFill}
              data-correct={reveal && item.correct === true}
              data-series={i % 12}
              initial={{ width: 0 }}
              animate={{ width: `${String((item.count / peak) * 100)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />
          </div>

          <div className={styles.barValue}>
            <span className={styles.barPercent}>{item.percent}%</span>
            <span className={styles.barCount}>{item.count}</span>
          </div>
        </div>
      ))}

      <p className={styles.total}>
        {total} {total === 1 ? 'answer' : 'answers'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Word cloud                                                          */
/* ------------------------------------------------------------------ */

/**
 * A word cloud without a layout library.
 *
 * Words are laid out in rows sized by frequency. A true spiral packing looks
 * impressive and is unreadable from row ten; this stays legible, which is
 * the only thing a word cloud is for.
 */
function WordCloud({ words }: { words: WordTally[] }) {
  const shown = words.slice(0, 40);
  const peak = Math.max(...shown.map((w) => w.count), 1);

  return (
    <div className={styles.cloud}>
      {shown.map((word, i) => {
        const weight = word.count / peak;
        return (
          <motion.span
            key={word.word}
            className={styles.cloudWord}
            data-series={i % 12}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 18 }}
            style={{
              // Clamped so one runaway word cannot push everything else off
              // the screen, and nothing falls below readable at the back.
              fontSize: `clamp(18px, ${String(1.4 + weight * 4.6)}vw, 86px)`,
              opacity: 0.55 + weight * 0.45,
            }}
            title={`${word.word}: ${String(word.count)}`}
          >
            {word.word}
          </motion.span>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

function TextWall({ entries }: { entries: { id: string; text: string; upvotes: number }[] }) {
  return (
    <div className={styles.textWall}>
      {entries.slice(0, 30).map((entry) => (
        <motion.blockquote
          key={entry.id}
          className={styles.textCard}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          {entry.text}
          {entry.upvotes > 0 && <span className={styles.upvotes}>▲ {entry.upvotes}</span>}
        </motion.blockquote>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Numeric                                                             */
/* ------------------------------------------------------------------ */

function NumericSummary({
  summary,
}: {
  summary: {
    count: number;
    average: number;
    median: number;
    min: number;
    max: number;
    buckets: { from: number; to: number; count: number }[];
  };
}) {
  const peak = Math.max(...summary.buckets.map((b) => b.count), 1);

  return (
    <div className={styles.numeric}>
      <div className={styles.stats}>
        <Stat label="Average" value={summary.average} />
        <Stat label="Median" value={summary.median} />
        <Stat label="Lowest" value={summary.min} />
        <Stat label="Highest" value={summary.max} />
      </div>

      <div className={styles.histogram}>
        {summary.buckets.map((bucket, i) => (
          <div key={i} className={styles.histColumn} title={`${bucket.from}–${bucket.to}`}>
            <motion.div
              className={styles.histBar}
              initial={{ height: 0 }}
              animate={{ height: `${String((bucket.count / peak) * 100)}%` }}
              transition={{ type: 'spring', stiffness: 130, damping: 20 }}
            />
            <span className={styles.histLabel}>{bucket.from}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* NPS                                                                 */
/* ------------------------------------------------------------------ */

function NpsResult({
  summary,
}: {
  summary: {
    count: number;
    score: number;
    promoters: number;
    passives: number;
    detractors: number;
    distribution: number[];
  };
}) {
  const peak = Math.max(...summary.distribution, 1);

  return (
    <div className={styles.nps}>
      <div className={styles.npsScore}>
        <motion.span
          className={styles.npsNumber}
          key={summary.score}
          initial={{ scale: 0.85, opacity: 0.4 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 16 }}
        >
          {summary.score}
        </motion.span>
        <span className={styles.npsCaption}>Net Promoter Score</span>
      </div>

      <div className={styles.npsSplit}>
        <NpsBand
          label="Detractors"
          count={summary.detractors}
          total={summary.count}
          band="detractor"
        />
        <NpsBand label="Passives" count={summary.passives} total={summary.count} band="passive" />
        <NpsBand
          label="Promoters"
          count={summary.promoters}
          total={summary.count}
          band="promoter"
        />
      </div>

      <div className={styles.histogram}>
        {summary.distribution.map((count, score) => (
          <div key={score} className={styles.histColumn}>
            <motion.div
              className={styles.histBar}
              data-band={score >= 9 ? 'promoter' : score >= 7 ? 'passive' : 'detractor'}
              initial={{ height: 0 }}
              animate={{ height: `${String((count / peak) * 100)}%` }}
              transition={{ type: 'spring', stiffness: 130, damping: 20 }}
            />
            <span className={styles.histLabel}>{score}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NpsBand({
  label,
  count,
  total,
  band,
}: {
  label: string;
  count: number;
  total: number;
  band: string;
}) {
  const percent = total === 0 ? 0 : Math.round((count / total) * 100);
  return (
    <div className={styles.npsBand} data-band={band}>
      <span className={styles.npsBandValue}>{percent}%</span>
      <span className={styles.npsBandLabel}>{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scales, ranking, points                                             */
/* ------------------------------------------------------------------ */

function ScaleBars({
  statements,
}: {
  statements: { statementId: string; label: string; average: number; count: number }[];
}) {
  const peak = Math.max(...statements.map((s) => s.average), 1);

  return (
    <div className={styles.bars}>
      {statements.map((statement, i) => (
        <div key={statement.statementId} className={styles.barRow}>
          <div className={styles.barLabel}>
            <span className={styles.barText}>{statement.label}</span>
          </div>
          <div className={styles.barTrack}>
            <motion.div
              className={styles.barFill}
              data-series={i % 12}
              initial={{ width: 0 }}
              animate={{ width: `${String((statement.average / peak) * 100)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />
          </div>
          <div className={styles.barValue}>
            <span className={styles.barPercent}>{statement.average}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function RankingList({
  items,
}: {
  items: { id: string; label: string; averageRank: number; count: number }[];
}) {
  return (
    <ol className={styles.ranking}>
      {items.map((item, i) => (
        <motion.li
          key={item.id}
          className={styles.rankRow}
          layout
          transition={{ type: 'spring', stiffness: 160, damping: 22 }}
        >
          <span className={styles.rankPosition} data-top={i === 0}>
            {i + 1}
          </span>
          <span className={styles.rankLabel}>{item.label}</span>
          <span className={styles.rankScore}>
            {item.count === 0 ? '—' : item.averageRank.toFixed(1)}
          </span>
        </motion.li>
      ))}
    </ol>
  );
}

function PointsBars({
  items,
}: {
  items: { id: string; label: string; total: number; percent: number }[];
}) {
  const peak = Math.max(...items.map((i) => i.total), 1);

  return (
    <div className={styles.bars}>
      {items.map((item, i) => (
        <div key={item.id} className={styles.barRow}>
          <div className={styles.barLabel}>
            <span className={styles.barText}>{item.label}</span>
          </div>
          <div className={styles.barTrack}>
            <motion.div
              className={styles.barFill}
              data-series={i % 12}
              initial={{ width: 0 }}
              animate={{ width: `${String((item.total / peak) * 100)}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />
          </div>
          <div className={styles.barValue}>
            <span className={styles.barPercent}>{item.percent}%</span>
            <span className={styles.barCount}>{item.total}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scatter and pins                                                    */
/* ------------------------------------------------------------------ */

function Scatter({
  points,
}: {
  points: { id: string; label: string; x: number; y: number; count: number }[];
}) {
  return (
    <div className={styles.scatterWrap}>
      <svg className={styles.scatter} viewBox="0 0 100 100" preserveAspectRatio="none">
        <line x1="50" y1="0" x2="50" y2="100" className={styles.axis} />
        <line x1="0" y1="50" x2="100" y2="50" className={styles.axis} />
      </svg>

      {points
        .filter((p) => p.count > 0)
        .map((point, i) => (
          <motion.span
            key={point.id}
            className={styles.dot}
            data-series={i % 12}
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            // y is inverted: the data's 1 is the top of the grid, but SVG
            // and CSS both measure downward from the top.
            style={{ left: `${String(point.x * 100)}%`, top: `${String((1 - point.y) * 100)}%` }}
          >
            <span className={styles.dotLabel}>{point.label}</span>
          </motion.span>
        ))}
    </div>
  );
}

function PinMap({ pins }: { pins: { x: number; y: number }[] }) {
  const positions = useMemo(() => pins.slice(0, 600), [pins]);

  return (
    <div className={styles.pinWrap}>
      {positions.map((pin, i) => (
        <motion.span
          key={i}
          className={styles.pin}
          initial={{ opacity: 0, scale: 0 }}
          animate={{ opacity: 0.75, scale: 1 }}
          transition={{ duration: 0.25 }}
          style={{ left: `${String(pin.x * 100)}%`, top: `${String(pin.y * 100)}%` }}
        />
      ))}
    </div>
  );
}
