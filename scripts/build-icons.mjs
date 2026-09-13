/*
 * Generates the app icons.
 *
 * Neither app had one, so every tab showed a generic browser glyph and
 * "Add to Home Screen" on a phone produced a blank square -- which is the
 * single most visible way a product looks unfinished.
 *
 * Written by hand rather than pulled from a library: rasterising a rounded
 * square and a polyline is a page of maths, and Node's own zlib is all a
 * PNG actually needs. An icon generator is not worth a dependency, a build
 * step, or a service that has to stay free.
 *
 * Run with: node scripts/build-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/* ------------------------------------------------------------------ */
/* The mark                                                            */
/* ------------------------------------------------------------------ */

/** The accent, top to bottom. Matches --color-accent in the theme. */
const ACCENT = { top: [0x8b, 0x6c, 0xf8], bottom: [0x5b, 0x3f, 0xd6] };

/*
 * A pulse trace, in units of the icon's width.
 *
 * Flat, up, a deep spike down, a small recovery, flat again -- the shape
 * of a heartbeat on a monitor, which is what the product is named after
 * and what still reads at sixteen pixels.
 */
const TRACE = [
  [0.16, 0.5],
  [0.34, 0.5],
  [0.42, 0.3],
  [0.5, 0.72],
  [0.58, 0.4],
  [0.65, 0.5],
  [0.84, 0.5],
];

const STROKE = 0.088;
const RADIUS = 0.23;

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/** Distance from a point to a line segment. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;

  // A zero-length segment is a point.
  const t =
    lengthSquared === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1);

  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance to the whole trace. Round joins and caps fall out of the min. */
function distanceToTrace(px, py) {
  let best = Infinity;

  for (let i = 0; i < TRACE.length - 1; i += 1) {
    const [ax, ay] = TRACE[i];
    const [bx, by] = TRACE[i + 1];
    best = Math.min(best, distanceToSegment(px, py, ax, ay, bx, by));
  }

  return best;
}

/** Signed distance to a rounded square: negative inside. */
function roundedBox(px, py, radius) {
  const qx = Math.abs(px - 0.5) - (0.5 - radius);
  const qy = Math.abs(py - 0.5) - (0.5 - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Coverage from a signed distance, softened across roughly one pixel. */
function coverage(distance, feather) {
  return clamp(0.5 - distance / feather, 0, 1);
}

/* ------------------------------------------------------------------ */
/* Raster                                                              */
/* ------------------------------------------------------------------ */

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const feather = 1.4 / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Pixel centres, so the mark is not half a pixel off.
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;

      const tile = coverage(roundedBox(px, py, RADIUS), feather);
      const line = coverage(distanceToTrace(px, py) - STROKE / 2, feather);

      // Vertical gradient across the tile.
      const r = ACCENT.top[0] + (ACCENT.bottom[0] - ACCENT.top[0]) * py;
      const g = ACCENT.top[1] + (ACCENT.bottom[1] - ACCENT.top[1]) * py;
      const b = ACCENT.top[2] + (ACCENT.bottom[2] - ACCENT.top[2]) * py;

      // The trace is white over the gradient, and only where the tile is.
      const ink = line * tile;

      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(r + (255 - r) * ink);
      pixels[offset + 1] = Math.round(g + (255 - g) * ink);
      pixels[offset + 2] = Math.round(b + (255 - b) * ink);
      pixels[offset + 3] = Math.round(tile * 255);
    }
  }

  return pixels;
}

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }

  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Every scanline carries a filter byte. Filter 0 (none) keeps this
  // simple; zlib still compresses the large flat areas well.
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);

  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* SVG                                                                 */
/* ------------------------------------------------------------------ */

/*
 * The vector version, which is what a desktop browser prefers: one file
 * that stays sharp at every size instead of a pile of PNGs.
 */
function svg() {
  const points = TRACE.map(([x, y]) => `${(x * 64).toFixed(1)},${(y * 64).toFixed(1)}`).join(' ');

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    '  <defs>',
    '    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">',
    '      <stop offset="0" stop-color="#8b6cf8"/>',
    '      <stop offset="1" stop-color="#5b3fd6"/>',
    '    </linearGradient>',
    '  </defs>',
    `  <rect width="64" height="64" rx="${(RADIUS * 64).toFixed(1)}" fill="url(#g)"/>`,
    `  <polyline points="${points}" fill="none" stroke="#fff"`,
    `    stroke-width="${(STROKE * 64).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`,
    '</svg>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);

  const bytes = typeof contents === 'string' ? Buffer.byteLength(contents) : contents.length;
  process.stdout.write(`  ${path.padEnd(38)} ${(bytes / 1024).toFixed(1)} KB\n`);
}

const mark = svg();

for (const app of ['client', 'join']) {
  write(`${app}/public/favicon.svg`, mark);
  write(`${app}/public/apple-touch-icon.png`, encodePng(180, render(180)));
}

// Only the join app is installed to a home screen; the presenter view is a
// desktop tool, and a manifest there would be a file nobody reads.
for (const size of [192, 512]) {
  write(`join/public/icon-${String(size)}.png`, encodePng(size, render(size)));
}

write(
  'join/public/manifest.webmanifest',
  `${JSON.stringify(
    {
      name: 'Pulse',
      short_name: 'Pulse',
      description: 'Answer live polls and quizzes.',
      start_url: '/',
      display: 'standalone',
      background_color: '#0b0d17',
      theme_color: '#0b0d17',
      orientation: 'portrait',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  )}\n`,
);
