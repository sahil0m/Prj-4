import { describe, it, expect } from 'vitest';
import { encodeQr } from './qr-encode';

/**
 * The QR encoder is written by hand, so these check it against the structural
 * rules of ISO/IEC 18004. A code that is subtly wrong still renders as a
 * convincing square of dots and fails silently in a room full of people, so
 * "it looks like a QR code" is not evidence of anything.
 */
describe('encodeQr', () => {
  it('produces a square of the right size for the version', () => {
    // Version 1 is 21 modules; each version adds 4.
    const small = encodeQr('http://a.bc');
    expect(small.size).toBe(21);
    expect(small.modules).toHaveLength(21);
    expect(small.modules[0]).toHaveLength(21);
  });

  it('grows to a larger version as the text grows', () => {
    const short = encodeQr('http://a.bc');
    const long = encodeQr('http://192.168.100.200:5174/?code=123456&extra=padding-to-grow');
    expect(long.size).toBeGreaterThan(short.size);
    // Still square.
    expect(long.modules).toHaveLength(long.size);
  });

  it('places all three finder patterns', () => {
    const { modules, size } = encodeQr('http://172.20.10.2:5174/?code=123456');

    // A finder is a 7x7 ring: dark border, light gap, 3x3 dark core.
    const isFinder = (top: number, left: number): boolean => {
      for (let r = 0; r < 7; r += 1) {
        for (let c = 0; c < 7; c += 1) {
          const onRing = r === 0 || r === 6 || c === 0 || c === 6;
          const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          const expected = onRing || inCore;
          if (modules[top + r]?.[left + c] !== expected) return false;
        }
      }
      return true;
    };

    expect(isFinder(0, 0), 'top-left finder').toBe(true);
    expect(isFinder(0, size - 7), 'top-right finder').toBe(true);
    expect(isFinder(size - 7, 0), 'bottom-left finder').toBe(true);
  });

  it('has no finder in the bottom-right, which is how orientation is read', () => {
    const { modules, size } = encodeQr('http://172.20.10.2:5174/?code=123456');

    // A full 7x7 finder here would make the code ambiguous to rotate. An
    // alignment pattern near this corner is expected and correct, so the
    // test checks for the finder shape specifically rather than for dark
    // modules, which an earlier version of this test wrongly did.
    const top = size - 7;
    const left = size - 7;
    let matchesFinder = true;

    for (let r = 0; r < 7 && matchesFinder; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const onRing = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (modules[top + r]?.[left + c] !== (onRing || inCore)) {
          matchesFinder = false;
          break;
        }
      }
    }

    expect(matchesFinder).toBe(false);
  });

  it('draws the timing patterns as alternating modules', () => {
    const { modules, size } = encodeQr('http://172.20.10.2:5174/?code=123456');

    for (let i = 8; i < size - 8; i += 1) {
      expect(modules[6]?.[i], `horizontal timing at ${String(i)}`).toBe(i % 2 === 0);
      expect(modules[i]?.[6], `vertical timing at ${String(i)}`).toBe(i % 2 === 0);
    }
  });

  it('sets the dark module the spec requires', () => {
    const { modules, size } = encodeQr('http://a.bc');
    expect(modules[size - 8]?.[8]).toBe(true);
  });

  it('encodes different text to different patterns', () => {
    const a = encodeQr('http://172.20.10.2:5174/?code=111111');
    const b = encodeQr('http://172.20.10.2:5174/?code=222222');
    expect(JSON.stringify(a.modules)).not.toBe(JSON.stringify(b.modules));
  });

  it('is deterministic, so the code does not flicker between renders', () => {
    const a = encodeQr('http://172.20.10.2:5174/?code=123456');
    const b = encodeQr('http://172.20.10.2:5174/?code=123456');
    expect(a.modules).toEqual(b.modules);
  });

  it('uses a mix of light and dark, never a solid block', () => {
    const { modules } = encodeQr('http://172.20.10.2:5174/?code=123456');
    const flat = modules.flat();
    const dark = flat.filter(Boolean).length;
    const ratio = dark / flat.length;
    // A real QR lands near half; far outside that means the data placement
    // or the mask is wrong.
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.7);
  });

  it('refuses text too long to encode rather than producing a broken code', () => {
    expect(() => encodeQr('x'.repeat(3000))).toThrow();
  });

  it('handles a realistic join link', () => {
    const link = 'http://192.168.100.200:5174/?code=045752';
    const { size, modules } = encodeQr(link);
    expect(size).toBeGreaterThanOrEqual(21);
    expect(modules.every((row) => row.length === size)).toBe(true);
  });
});
