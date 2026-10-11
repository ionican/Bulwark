// Screenshots for scripts/check-render.mjs and scripts/check-queue.mjs: where they go by default,
// and how one is taken through the scripts' agent-browser session.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The vault's art reference folder: the run 2b, W26 and W27 screenshots go here unless --shots is given. */
export const ART_REF = join(homedir(), 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', "Rick's World", 'Resources', 'Bulwark Art Reference');

/**
 * A screenshot of the page to `path` (its folder created). `hideUi`: every page element but the
 * canvas hidden for the shot and restored after; `settle`: frames drawn first. `browser` is the
 * calling script's { ab, js, frames } (agent-browser command, page eval, wait for n frames).
 */
export async function screenshot(browser, path, { hideUi = false, settle = 3 } = {}) {
  const { ab, js, frames } = browser;
  mkdirSync(dirname(path), { recursive: true });
  if (hideUi) js(`(document.querySelectorAll('body > :not(canvas)').forEach((e) => (e.dataset.shotHidden = e.style.visibility, e.style.visibility = 'hidden')), true)`);
  await frames(settle);
  ab('screenshot', path);
  if (hideUi) js(`(document.querySelectorAll('[data-shot-hidden]').forEach((e) => { e.style.visibility = e.dataset.shotHidden; delete e.dataset.shotHidden; }), true)`);
  return path;
}
