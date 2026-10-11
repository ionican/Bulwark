import { describe, expect, it } from 'vitest';
import { LOD_FULL, LOD_ICON, LOD_SIMPLE, chooseLod } from '../src/render/lod.ts';

describe('LOD choice', () => {
  const T = [60, 125];
  it('a new object takes the level for its distance', () => {
    expect(chooseLod(255, 30, T)).toBe(LOD_FULL);
    expect(chooseLod(255, 90, T)).toBe(LOD_SIMPLE);
    expect(chooseLod(255, 200, T)).toBe(LOD_ICON);
  });
  it('holds its level inside the hysteresis band', () => {
    expect(chooseLod(LOD_FULL, 62, T, 0.08)).toBe(LOD_FULL);
    expect(chooseLod(LOD_SIMPLE, 58, T, 0.08)).toBe(LOD_SIMPLE);
    expect(chooseLod(LOD_SIMPLE, 130, T, 0.08)).toBe(LOD_SIMPLE);
    expect(chooseLod(LOD_ICON, 120, T, 0.08)).toBe(LOD_ICON);
  });
  it('switches once past the band, including jumps across two levels', () => {
    expect(chooseLod(LOD_FULL, 65, T, 0.08)).toBe(LOD_SIMPLE);
    expect(chooseLod(LOD_SIMPLE, 54, T, 0.08)).toBe(LOD_FULL);
    expect(chooseLod(LOD_FULL, 300, T, 0.08)).toBe(LOD_ICON);
    expect(chooseLod(LOD_ICON, 10, T, 0.08)).toBe(LOD_FULL);
  });
});
