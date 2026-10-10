// The build stamp (src/version.ts): set at build time from git (vite.config.ts define), formatted for
// the corner, the help panel and the page title.

import { describe, expect, it } from 'vitest';
import { BUILD, cornerLabel, versionLabel } from '../src/version.ts';

describe('build stamp', () => {
  it('is set from git when the config is loaded', () => {
    expect(BUILD.number).toBeGreaterThan(100);
    expect(BUILD.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(BUILD.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reads build number, commit and date, and says when the tree had uncommitted changes', () => {
    expect(versionLabel({ number: 129, commit: 'c537d2e', date: '2026-10-10', local: false })).toBe('build 129 · c537d2e · 10 Oct 2026');
    expect(versionLabel({ number: 130, commit: 'abc1234', date: '2026-01-02', local: true })).toBe('build 130 · abc1234 · 2 Jan 2026 · local changes');
    expect(versionLabel({ number: 0, commit: 'unknown', date: '', local: true })).toBe('build 0 · unknown · local changes');
  });

  it('the corner shows the short form', () => {
    expect(cornerLabel({ number: 129, commit: 'c537d2e', date: '2026-10-10', local: false })).toBe('build 129 · c537d2e');
    expect(cornerLabel({ number: 133, commit: '6912149', date: '2026-10-10', local: true })).toBe('build 133 · 6912149 · local');
  });
});
