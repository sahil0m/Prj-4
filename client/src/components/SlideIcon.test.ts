import { describe, it, expect } from 'vitest';
import { ALL_DEFINITIONS } from '@pulse/shared';
import { SLIDE_ICON_NAMES } from './SlideIcon';

describe('SlideIcon', () => {
  it('has an icon for every slide kind', () => {
    // The icon map is written out by hand so that only the icons actually
    // used reach the bundle. That means it can fall behind the registry, and
    // a missing entry renders a blank square with no error — this test is
    // what turns that into a build failure.
    const missing = ALL_DEFINITIONS.filter((d) => !SLIDE_ICON_NAMES.includes(d.icon)).map(
      (d) => `${d.kind} needs ${d.icon}`,
    );

    expect(missing, `add these to ICONS in SlideIcon.tsx: ${missing.join(', ')}`).toEqual([]);
  });

  it('carries no icons the registry does not use', () => {
    const used = new Set(ALL_DEFINITIONS.map((d) => d.icon));
    const unused = SLIDE_ICON_NAMES.filter((name) => !used.has(name));

    expect(unused, `these are dead weight in the bundle: ${unused.join(', ')}`).toEqual([]);
  });
});
