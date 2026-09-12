/**
 * A minimal QR encoder.
 *
 * Written rather than imported: the `qrcode` package is around 12KB gzipped
 * and brings a canvas renderer we do not want. This encodes a URL — short,
 * ASCII, and known in advance — which needs only byte mode and a fixed
 * error-correction level, so the implementation stays small enough to read.
 *
 * Follows ISO/IEC 18004. Versions 1-10 cover URLs far longer than a join
 * link, and error correction level M tolerates a quarter of the code being
 * obscured, which matters when it is projected onto a screen someone walks
 * in front of.
 */

/* ------------------------------------------------------------------ */
/* Galois field arithmetic, for Reed-Solomon error correction          */
/* ------------------------------------------------------------------ */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    // The generator polynomial for QR's GF(256).
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] ?? 0;
})();

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[((LOG[a] ?? 0) + (LOG[b] ?? 0)) % 255] ?? 0;
}

/** Builds the generator polynomial for `degree` error-correction codewords. */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] ?? 0) ^ mul(poly[j] ?? 0, 1);
      next[j + 1] = (next[j + 1] ?? 0) ^ mul(poly[j] ?? 0, EXP[i] ?? 0);
    }
    poly = next;
  }
  return poly;
}

function errorCorrection(data: number[], count: number): number[] {
  const gen = generator(count);
  const remainder = new Array<number>(count).fill(0);

  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < count; i += 1) {
      remainder[i] = (remainder[i] ?? 0) ^ mul(gen[i + 1] ?? 0, factor);
    }
  }

  return remainder;
}

/* ------------------------------------------------------------------ */
/* Version tables (level M)                                            */
/* ------------------------------------------------------------------ */

/** [version, total codewords, EC codewords per block, block count] */
const VERSIONS: [number, number, number, number][] = [
  [1, 26, 10, 1],
  [2, 44, 16, 1],
  [3, 70, 26, 1],
  [4, 100, 18, 2],
  [5, 134, 24, 2],
  [6, 172, 16, 4],
  [7, 196, 18, 4],
  [8, 242, 22, 4],
  [9, 292, 22, 5],
  [10, 346, 26, 5],
];

const ALIGNMENT: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

function pickVersion(byteLength: number): [number, number, number, number] {
  for (const spec of VERSIONS) {
    const [, total, ecPerBlock, blocks] = spec;
    const capacity = total - ecPerBlock * blocks;
    // 4 bits mode + 8 or 16 bits length + the data itself.
    const overhead = byteLength < 256 ? 2 : 3;
    if (capacity >= byteLength + overhead) return spec;
  }
  throw new Error('That link is too long for a QR code.');
}

/* ------------------------------------------------------------------ */
/* Encoding                                                            */
/* ------------------------------------------------------------------ */

export function encodeQr(text: string): { size: number; modules: boolean[][] } {
  const bytes = [...new TextEncoder().encode(text)];
  const [version, total, ecPerBlock, blocks] = pickVersion(bytes.length);

  const dataCount = total - ecPerBlock * blocks;
  const lengthBits = version >= 10 ? 16 : 8;

  /* ---- bit stream ---- */

  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, lengthBits);
  for (const byte of bytes) push(byte, 8);

  // Terminator, then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < dataCount * 8; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0);
    data.push(byte);
  }

  // The two alternating pad bytes the spec requires.
  const PAD = [0xec, 0x11];
  let padIndex = 0;
  while (data.length < dataCount) {
    data.push(PAD[padIndex % 2] ?? 0);
    padIndex += 1;
  }

  /* ---- blocks and interleaving ---- */

  const shortBlock = Math.floor(dataCount / blocks);
  const longBlocks = dataCount % blocks;

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;

  for (let i = 0; i < blocks; i += 1) {
    const size = shortBlock + (i >= blocks - longBlocks ? 1 : 0);
    const block = data.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(errorCorrection(block, ecPerBlock));
  }

  const codewords: number[] = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));

  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) {
      const byte = block[i];
      if (byte !== undefined) codewords.push(byte);
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ecBlocks) {
      const byte = block[i];
      if (byte !== undefined) codewords.push(byte);
    }
  }

  /* ---- matrix ---- */

  const size = version * 4 + 17;
  const modules: (boolean | null)[][] = Array.from({ length: size }, () =>
    new Array<boolean | null>(size).fill(null),
  );

  const set = (r: number, c: number, value: boolean) => {
    const row = modules[r];
    if (row && c >= 0 && c < size) row[c] = value;
  };

  // Finder patterns, one in each corner except bottom-right.
  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        if (row + r < 0 || row + r >= size || col + c < 0 || col + c >= size) continue;
        const onRing = r >= 0 && r <= 6 && (c === 0 || c === 6);
        const onCol = c >= 0 && c <= 6 && (r === 0 || r === 6);
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(row + r, col + c, onRing || onCol || inCore);
      }
    }
  };

  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment patterns, skipping the ones that would sit on a finder.
  const centres = ALIGNMENT[version] ?? [];
  for (const r of centres) {
    for (const c of centres) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Dark module, always set.
  set(size - 8, 8, true);

  // Reserve the format areas so data does not land in them.
  for (let i = 0; i < 9; i += 1) {
    if (modules[8]?.[i] === null) set(8, i, false);
    if (modules[i]?.[8] === null) set(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    if (modules[8]?.[size - 1 - i] === null) set(8, size - 1 - i, false);
    if (modules[size - 1 - i]?.[8] === null) set(size - 1 - i, 8, false);
  }

  /* ---- place the data, zig-zagging up and down ---- */

  let bitIndex = 0;
  let upward = true;

  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col -= 1; // the vertical timing column is skipped

    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;

      for (let c = 0; c < 2; c += 1) {
        const target = col - c;
        if (modules[row]?.[target] !== null) continue;

        const byte = codewords[bitIndex >> 3] ?? 0;
        const bit = (byte >> (7 - (bitIndex & 7))) & 1;
        bitIndex += 1;

        // Mask 0: the simplest of the eight, and adequate for a URL.
        const masked = (row + target) % 2 === 0 ? bit ^ 1 : bit;
        set(row, target, masked === 1);
      }
    }
    upward = !upward;
  }

  /* ---- format information (level M, mask 0) ---- */

  const FORMAT = 0b101010000010010;
  for (let i = 0; i < 15; i += 1) {
    const bit = ((FORMAT >> i) & 1) === 1;

    if (i < 6) set(i, 8, bit);
    else if (i < 8) set(i + 1, 8, bit);
    else if (i === 8) set(8, 7, bit);
    else set(8, 14 - i, bit);

    if (i < 8) set(8, size - 1 - i, bit);
    else set(size - 15 + i, 8, bit);
  }

  return {
    size,
    modules: modules.map((row) => row.map((cell) => cell === true)),
  };
}
