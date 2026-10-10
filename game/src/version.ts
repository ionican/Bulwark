// The build stamp (Richard, 2026-10-10: "put version numbers on this so people know which they're
// playing"). vite.config.ts sets __BUILD__ from git when it builds: the build number is the count of
// commits on the branch, so it grows with every change as long as history is kept (merge into main,
// do not squash), plus the commit and its date. Shown in the corner (ui/hud.ts), in the help panel,
// in the page title, and as __game.version.

export interface Build {
  number: number;
  commit: string;
  /** Commit date, YYYY-MM-DD ('' when unknown). */
  date: string;
  /** Built from a tree with uncommitted changes. */
  local: boolean;
}

declare const __BUILD__: Build | undefined;

export const BUILD: Build = typeof __BUILD__ === 'undefined' ? { number: 0, commit: 'unknown', date: '', local: true } : __BUILD__;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "build 129 · c537d2e · 10 Oct 2026", plus " · local changes" for a build of uncommitted work. */
export function versionLabel(b: Build = BUILD): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b.date);
  const date = m ? ` · ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
  return `build ${b.number} · ${b.commit}${date}${b.local ? ' · local changes' : ''}`;
}

/** The corner's short form, "build 129 · c537d2e" (" · local" for uncommitted work): narrow enough to
 *  clear the build bar on smaller windows; the date stays in the help panel and the page title. */
export function cornerLabel(b: Build = BUILD): string {
  return `build ${b.number} · ${b.commit}${b.local ? ' · local' : ''}`;
}
