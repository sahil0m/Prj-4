import { describe, it, expect } from 'vitest';
import { SLIDE_KINDS } from './kinds.js';
import { SLIDE_REGISTRY, ALL_DEFINITIONS, ANSWERABLE_KINDS, QUIZ_KINDS } from './registry.js';
import { zSlideConfig } from './configs.js';
import { zAnswer } from './answers.js';

describe('slide registry', () => {
  it('has exactly one definition per kind, keyed correctly', () => {
    expect(ALL_DEFINITIONS).toHaveLength(SLIDE_KINDS.length);
    for (const kind of SLIDE_KINDS) {
      expect(SLIDE_REGISTRY[kind].kind).toBe(kind);
    }
  });

  it('has no duplicate kinds', () => {
    expect(new Set(SLIDE_KINDS).size).toBe(SLIDE_KINDS.length);
  });

  it('gives every definition human-readable metadata', () => {
    for (const def of ALL_DEFINITIONS) {
      expect(def.label.length, `${def.kind} label`).toBeGreaterThan(0);
      expect(def.blurb.length, `${def.kind} blurb`).toBeGreaterThan(0);
      expect(def.icon.length, `${def.kind} icon`).toBeGreaterThan(0);
    }
  });

  it('produces defaults that pass their own config schema', () => {
    for (const def of ALL_DEFINITIONS) {
      const result = def.configSchema.safeParse(def.defaults());
      if (!result.success) {
        throw new Error(`${def.kind} defaults invalid: ${JSON.stringify(result.error.issues)}`);
      }
      expect(result.success).toBe(true);
    }
  });

  it('produces defaults that pass the discriminated union', () => {
    for (const def of ALL_DEFINITIONS) {
      const result = zSlideConfig.safeParse(def.defaults());
      if (!result.success) {
        throw new Error(
          `${def.kind} not accepted by union: ${JSON.stringify(result.error.issues)}`,
        );
      }
      expect(result.success).toBe(true);
    }
  });

  it('marks every quiz kind as answerable', () => {
    for (const kind of QUIZ_KINDS) {
      expect(SLIDE_REGISTRY[kind].answerable, `${kind} must be answerable`).toBe(true);
    }
  });

  it('gives every answerable kind an answer schema', () => {
    const answerKinds = new Set<string>(zAnswer.options.map((o) => o.shape.kind.value));
    for (const kind of ANSWERABLE_KINDS) {
      expect(
        answerKinds.has(kind as string),
        `${kind} is answerable but has no answer schema`,
      ).toBe(true);
    }
  });

  it('does not give non-answerable kinds an answer schema', () => {
    const answerKinds = new Set<string>(zAnswer.options.map((o) => o.shape.kind.value));
    for (const def of ALL_DEFINITIONS) {
      if (!def.answerable) {
        expect(
          answerKinds.has(def.kind as string),
          `${def.kind} is content but has an answer schema`,
        ).toBe(false);
      }
    }
  });

  it('gives every answerable kind at least one export column', () => {
    for (const kind of ANSWERABLE_KINDS) {
      expect(SLIDE_REGISTRY[kind].exportColumns.length, `${kind} export columns`).toBeGreaterThan(
        0,
      );
    }
  });

  it('keeps quiz point ranges sane', () => {
    for (const kind of QUIZ_KINDS) {
      const cfg = SLIDE_REGISTRY[kind].defaults() as { pointsMax: number; pointsMin: number };
      expect(cfg.pointsMax).toBeGreaterThanOrEqual(cfg.pointsMin);
    }
  });
});
