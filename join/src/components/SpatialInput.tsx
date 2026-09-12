import { useRef, useState } from 'react';

/**
 * Only what these handlers actually read.
 *
 * Preact's own event types are all marked deprecated in favour of a
 * namespace it does not export at the top level, and React's types are the
 * wrong shape under the compat alias. Naming the two coordinates and the
 * pointer id is both accurate and immune to either library moving its
 * types again.
 */
interface PointerLike {
  clientX: number;
  clientY: number;
  pointerId: number;
  currentTarget: { setPointerCapture: (id: number) => void };
}
import styles from './SpatialInput.module.css';

/**
 * The four slide kinds that need a surface rather than a control.
 *
 * All of them share the same problem: a finger is imprecise, the page
 * wants to scroll, and the result has to be normalised to 0..1 so it means
 * the same thing on every screen size. That logic lives here once.
 */

interface Point {
  x: number;
  y: number;
}

/** Where a touch or click landed, as a fraction of the surface. */
function normalise(event: { clientX: number; clientY: number }, element: HTMLElement): Point {
  const box = element.getBoundingClientRect();

  // Clamped, because a drag that leaves the element still reports a
  // position, and a pin at 1.4 would be stored and then drawn off-screen.
  return {
    x: Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1),
    y: Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1),
  };
}

/* ------------------------------------------------------------------ */
/* Pin on an image                                                     */
/* ------------------------------------------------------------------ */

export function PinInput({
  config,
  disabled,
  onSubmit,
}: {
  config: Record<string, unknown>;
  disabled: boolean;
  onSubmit: (payload: unknown) => void;
}) {
  const imageUrl = typeof config.imageUrl === 'string' ? config.imageUrl : '';
  const max = typeof config.pinsPerPerson === 'number' ? config.pinsPerPerson : 1;

  const [pins, setPins] = useState<Point[]>([]);
  const surface = useRef<HTMLDivElement>(null);

  const place = (event: PointerLike) => {
    if (disabled || !surface.current) return;

    const point = normalise(event, surface.current);

    setPins((current) => {
      // Past the limit the oldest pin is replaced, which is what someone
      // expects from tapping again rather than an error telling them to
      // remove one first.
      const next = current.length >= max ? current.slice(1) : current;
      return [...next, point];
    });
  };

  if (imageUrl === '') {
    return <p className={styles.missing}>The presenter has not added an image yet.</p>;
  }

  return (
    <div className={styles.stack}>
      <div
        ref={surface}
        className={styles.surface}
        onPointerDown={place}
        // The surface is the control, so the browser must not treat a tap
        // on it as the start of a scroll or a double-tap zoom.
        style={{ touchAction: 'none' }}
      >
        <img src={imageUrl} alt="" className={styles.image} draggable={false} />

        {pins.map((pin, i) => (
          <span
            key={i}
            className={styles.pin}
            style={{ left: `${String(pin.x * 100)}%`, top: `${String(pin.y * 100)}%` }}
          />
        ))}
      </div>

      <p className={styles.hint}>
        {pins.length === 0
          ? max === 1
            ? 'Tap the picture'
            : `Tap the picture — up to ${String(max)} pins`
          : `${String(pins.length)} of ${String(max)} placed`}
      </p>

      <button
        type="button"
        className={styles.submit}
        disabled={disabled || pins.length === 0}
        onClick={() => {
          onSubmit({ pins });
        }}
      >
        Send
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pin on a map                                                        */
/* ------------------------------------------------------------------ */

/**
 * A world map, drawn as SVG.
 *
 * A tile-based map needs a network request per tile and a mapping library;
 * both are weight this page cannot afford, and neither is needed to answer
 * "roughly where are you". This is a simplified equirectangular outline,
 * which converts to latitude and longitude by direct proportion.
 */
export function MapInput({
  config,
  disabled,
  onSubmit,
}: {
  config: Record<string, unknown>;
  disabled: boolean;
  onSubmit: (payload: unknown) => void;
}) {
  const max = typeof config.pinsPerPerson === 'number' ? config.pinsPerPerson : 1;

  const [pins, setPins] = useState<Point[]>([]);
  const surface = useRef<HTMLDivElement>(null);

  const place = (event: PointerLike) => {
    if (disabled || !surface.current) return;

    const point = normalise(event, surface.current);
    setPins((current) => [...(current.length >= max ? current.slice(1) : current), point]);
  };

  return (
    <div className={styles.stack}>
      <div
        ref={surface}
        className={`${styles.surface} ${styles.mapSurface}`}
        onPointerDown={place}
        style={{ touchAction: 'none' }}
      >
        <WorldMap />

        {pins.map((pin, i) => (
          <span
            key={i}
            className={styles.pin}
            style={{ left: `${String(pin.x * 100)}%`, top: `${String(pin.y * 100)}%` }}
          />
        ))}
      </div>

      <p className={styles.hint}>
        {pins.length === 0
          ? 'Tap where you are'
          : `${String(pins.length)} of ${String(max)} placed`}
      </p>

      <button
        type="button"
        className={styles.submit}
        disabled={disabled || pins.length === 0}
        onClick={() => {
          // Converted to real coordinates before sending: the map schema
          // stores latitude and longitude, not screen fractions, so a pin
          // still means the same place on a different sized screen.
          onSubmit({
            pins: pins.map((pin) => ({
              lng: pin.x * 360 - 180,
              lat: 90 - pin.y * 180,
            })),
          });
        }}
      >
        Send
      </button>
    </div>
  );
}

/**
 * A rough world outline.
 *
 * Deliberately crude: enough to recognise the continents and point at the
 * right part of one, at a fraction of the bytes a real dataset would cost.
 */
function WorldMap() {
  return (
    <svg viewBox="0 0 360 180" className={styles.map} preserveAspectRatio="none" aria-hidden="true">
      <rect width="360" height="180" className={styles.ocean} />
      <g className={styles.land}>
        {/* North America */}
        <path d="M30 30 L95 28 L105 48 L92 70 L70 78 L58 66 L44 62 L34 48 Z" />
        {/* Central and South America */}
        <path d="M78 82 L92 80 L100 95 L112 112 L106 140 L92 152 L84 136 L88 112 L76 96 Z" />
        {/* Europe */}
        <path d="M166 30 L196 28 L200 44 L186 56 L170 52 L162 40 Z" />
        {/* Africa */}
        <path d="M168 60 L205 58 L212 84 L200 118 L184 134 L174 116 L166 88 Z" />
        {/* Asia */}
        <path d="M204 24 L300 26 L318 48 L300 72 L262 78 L230 66 L210 48 Z" />
        {/* India */}
        <path d="M236 70 L256 68 L252 92 L242 98 L234 84 Z" />
        {/* South-east Asia */}
        <path d="M268 82 L296 80 L302 96 L286 104 L270 96 Z" />
        {/* Australia */}
        <path d="M290 112 L326 110 L334 130 L316 142 L294 134 Z" />
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Two by two grid                                                     */
/* ------------------------------------------------------------------ */

/**
 * Placing items on two axes.
 *
 * One item at a time rather than all at once: a phone screen cannot show
 * twelve draggable labels without them overlapping, and tapping through
 * them in turn is both clearer and easier with a thumb.
 */
export function GridInput({
  config,
  disabled,
  onSubmit,
}: {
  config: Record<string, unknown>;
  disabled: boolean;
  onSubmit: (payload: unknown) => void;
}) {
  const items = Array.isArray(config.items)
    ? (config.items as { id: string; label: string }[])
    : [];

  const label = (key: string, fallback: string): string =>
    typeof config[key] === 'string' && config[key] !== '' ? config[key] : fallback;

  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [index, setIndex] = useState(0);
  const surface = useRef<HTMLDivElement>(null);

  const current = items[index];
  const placed = Object.keys(positions).length;

  const place = (event: PointerLike) => {
    if (disabled || !surface.current || !current) return;

    const point = normalise(event, surface.current);
    setPositions((existing) => ({ ...existing, [current.id]: point }));

    // Moves to the next unplaced item, so a tap always advances rather than
    // leaving someone wondering what to do next.
    const nextUnplaced = items.findIndex(
      (item, i) => i > index && positions[item.id] === undefined,
    );
    if (nextUnplaced !== -1) setIndex(nextUnplaced);
  };

  if (items.length === 0) {
    return <p className={styles.missing}>The presenter has not added any items yet.</p>;
  }

  return (
    <div className={styles.stack}>
      <p className={styles.gridPrompt}>
        {placed === items.length ? 'All placed' : `Place: ${current?.label ?? ''}`}
      </p>

      <div className={styles.gridWrap}>
        <span className={`${styles.axis} ${styles.axisTop}`}>{label('yLabelHigh', 'High')}</span>
        <span className={`${styles.axis} ${styles.axisBottom}`}>{label('yLabelLow', 'Low')}</span>
        <span className={`${styles.axis} ${styles.axisLeft}`}>{label('xLabelLow', 'Low')}</span>
        <span className={`${styles.axis} ${styles.axisRight}`}>{label('xLabelHigh', 'High')}</span>

        <div
          ref={surface}
          className={`${styles.surface} ${styles.gridSurface}`}
          onPointerDown={place}
          style={{ touchAction: 'none' }}
        >
          <span className={styles.gridLineV} />
          <span className={styles.gridLineH} />

          {items.map((item, i) => {
            const point = positions[item.id];
            if (!point) return null;

            return (
              <span
                key={item.id}
                className={styles.gridDot}
                data-active={i === index}
                style={{ left: `${String(point.x * 100)}%`, top: `${String(point.y * 100)}%` }}
              >
                {item.label}
              </span>
            );
          })}
        </div>
      </div>

      {/* Tapping a chip returns to that item, so a misplacement is fixable
          without starting over. */}
      <div className={styles.chips}>
        {items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            className={styles.chip}
            data-placed={positions[item.id] !== undefined}
            data-active={i === index}
            disabled={disabled}
            onClick={() => {
              setIndex(i);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className={styles.submit}
        disabled={disabled || placed === 0}
        onClick={() => {
          onSubmit({ positions });
        }}
      >
        {placed < items.length ? `Send ${String(placed)} of ${String(items.length)}` : 'Send'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Freehand drawing.
 *
 * Strokes are captured as normalised points and sent as paths rather than
 * as an image: a PNG from a phone is tens of kilobytes, a path is a few
 * hundred bytes, and a room of a hundred people makes that difference the
 * whole feature.
 */
export function DrawingInput({
  config,
  disabled,
  onSubmit,
}: {
  config: Record<string, unknown>;
  disabled: boolean;
  onSubmit: (payload: unknown) => void;
}) {
  const background = typeof config.backgroundImageUrl === 'string' ? config.backgroundImageUrl : '';

  const colors =
    Array.isArray(config.strokeColors) && config.strokeColors.length > 0
      ? (config.strokeColors as string[])
      : ['#8b84fc', '#f472b6', '#a3e635', '#fbbf24', '#22d3ee'];

  const [strokes, setStrokes] = useState<{ color: string; points: Point[] }[]>([]);
  const [color, setColor] = useState(colors[0] ?? '#8b84fc');
  const drawing = useRef(false);
  const surface = useRef<HTMLDivElement>(null);

  const start = (event: PointerLike) => {
    if (disabled || !surface.current) return;

    drawing.current = true;
    // Captured so a finger that leaves the surface mid-stroke keeps
    // drawing rather than ending the line abruptly.
    event.currentTarget.setPointerCapture(event.pointerId);

    const point = normalise(event, surface.current);
    setStrokes((current) => [...current, { color, points: [point] }]);
  };

  const move = (event: PointerLike) => {
    if (!drawing.current || !surface.current) return;

    const point = normalise(event, surface.current);

    setStrokes((current) => {
      const last = current[current.length - 1];
      if (!last) return current;

      // Points closer than this add nothing visible and trebles the payload.
      const previous = last.points[last.points.length - 1];
      if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.004) {
        return current;
      }

      return [...current.slice(0, -1), { ...last, points: [...last.points, point] }];
    });
  };

  const end = () => {
    drawing.current = false;
  };

  const toPath = (points: Point[]): string =>
    points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${(p.x * 100).toFixed(2)} ${(p.y * 100).toFixed(2)}`)
      .join(' ');

  return (
    <div className={styles.stack}>
      <div
        ref={surface}
        className={`${styles.surface} ${styles.drawSurface}`}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        style={{ touchAction: 'none' }}
      >
        {background !== '' && (
          <img src={background} alt="" className={styles.image} draggable={false} />
        )}

        <svg viewBox="0 0 100 100" className={styles.ink} preserveAspectRatio="none">
          {strokes.map((stroke, i) => (
            <path
              key={i}
              d={toPath(stroke.points)}
              stroke={stroke.color}
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      </div>

      <div className={styles.tools}>
        <div className={styles.colors}>
          {colors.map((option) => (
            <button
              key={option}
              type="button"
              className={styles.colorDot}
              data-active={option === color}
              style={{ background: option }}
              aria-label={`Colour ${option}`}
              onClick={() => {
                setColor(option);
              }}
            />
          ))}
        </div>

        <button
          type="button"
          className={styles.undo}
          disabled={strokes.length === 0}
          onClick={() => {
            setStrokes((current) => current.slice(0, -1));
          }}
        >
          Undo
        </button>
      </div>

      <button
        type="button"
        className={styles.submit}
        disabled={disabled || strokes.length === 0}
        onClick={() => {
          // Flattened to x,y pairs, which is how the schema stores a stroke:
          // an array of numbers is markedly smaller on the wire than an
          // array of objects, and a room of a hundred makes that matter.
          onSubmit({
            strokes: strokes.map((stroke) => ({
              color: stroke.color,
              width: 1.6,
              points: stroke.points.flatMap((point) => [
                Math.round(point.x * 1000) / 1000,
                Math.round(point.y * 1000) / 1000,
              ]),
            })),
          });
        }}
      >
        Send
      </button>
    </div>
  );
}
