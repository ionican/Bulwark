// Downloads the CC0 textures and HDRI used by the W17 look test into public/assets/, then writes
// public/assets/manifest.json (local file → source URL, bytes) and CREDITS.md from the same list.
// Sources: Poly Haven public API (api.polyhaven.com) and ambientCG public API/downloads. Both CC0.
// Re-runnable: files already present with the expected size are kept.
//
//   node scripts/fetch-assets.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets');
const UA = { 'User-Agent': 'bulwark-w17-look-test (personal prototype)' };

// role → how the app uses it. Poly Haven maps: diff (base colour), nor_gl (OpenGL normal), arm (AO/rough/metal packed).
const ASSETS = [
  { id: 'cliff_side', source: 'polyhaven', res: '2k', role: 'terrain: steep cliff faces (horizontal strata)' },
  { id: 'sandy_gravel_02', source: 'polyhaven', res: '2k', role: 'terrain: sandy flats' },
  { id: 'rock_face', source: 'polyhaven', res: '1k', role: 'terrain: dark rock in gullies and canyon floors' },
  { id: 'concrete_panels', source: 'polyhaven', res: '1k', role: 'buildings: foundation pads and paving' },
  { id: 'metal_plate_02', source: 'polyhaven', res: '1k', role: 'buildings: dark trim; aliens: gunmetal hulls' },
  { id: 'Metal016', source: 'ambientcg', res: '1K-JPG', role: 'buildings: ivory painted panels (tinted)' },
  { id: 'Metal047B', source: 'ambientcg', res: '1K-JPG', role: 'buildings: copper/bronze fittings (bolts, gear rings, hinges)', maps: ['Color', 'NormalGL', 'Roughness'] },
  { id: 'rogland_sunset', source: 'polyhaven-hdri', res: '1k', role: 'image-based lighting (environment), low warm sun' },
];

const PH_MAPS = { Diffuse: 'diff', nor_gl: 'nor', arm: 'arm' };
const ACG_MAPS = { Color: 'diff', NormalGL: 'nor', Roughness: 'rough', Metalness: 'metal' };

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function download(url, dest, expected) {
  if (existsSync(dest) && (!expected || statSync(dest).size === expected)) return statSync(dest).size;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (expected && buf.length !== expected) throw new Error(`${url}: got ${buf.length} bytes, API said ${expected}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return buf.length;
}

const manifest = { generated: new Date().toISOString(), assets: [] };
let total = 0;

for (const a of ASSETS) {
  const entry = { id: a.id, source: a.source, res: a.res, role: a.role, licence: 'CC0 1.0', files: {} };
  if (a.source === 'polyhaven' || a.source === 'polyhaven-hdri') {
    const info = await getJson(`https://api.polyhaven.com/info/${a.id}`);
    const files = await getJson(`https://api.polyhaven.com/files/${a.id}`);
    entry.name = info.name;
    entry.authors = Object.keys(info.authors ?? {});
    entry.page = `https://polyhaven.com/a/${a.id}`;
    if (a.source === 'polyhaven-hdri') {
      const f = files.hdri[a.res].hdr;
      const dest = join(OUT, a.id, `${a.id}_${a.res}.hdr`);
      const bytes = await download(f.url, dest, f.size);
      entry.files.hdr = { path: `assets/${a.id}/${a.id}_${a.res}.hdr`, url: f.url, bytes };
      total += bytes;
    } else {
      for (const [apiKey, key] of Object.entries(PH_MAPS)) {
        const f = files[apiKey]?.[a.res]?.jpg;
        if (!f) throw new Error(`${a.id}: no ${apiKey} ${a.res} jpg`);
        const name = f.url.split('/').pop();
        const bytes = await download(f.url, join(OUT, a.id, name), f.size);
        entry.files[key] = { path: `assets/${a.id}/${name}`, url: f.url, bytes };
        total += bytes;
      }
    }
  } else if (a.source === 'ambientcg') {
    const q = await getJson(`https://ambientcg.com/api/v2/full_json?id=${a.id}&include=downloadData`);
    const asset = q.foundAssets[0];
    const dl = asset.downloadFolders.default.downloadFiletypeCategories.zip.downloads.find((d) => d.attribute === a.res);
    entry.name = asset.displayName;
    entry.authors = ['Lennart Demes (ambientCG)'];
    entry.page = `https://ambientcg.com/view?id=${a.id}`;
    entry.zip = { url: dl.downloadLink, bytes: dl.size };
    const dir = join(OUT, a.id);
    const mapNames = a.maps ?? Object.keys(ACG_MAPS);
    const want = mapNames.map((m) => `${a.id}_${a.res}_${m}.jpg`);
    if (!want.every((w) => existsSync(join(dir, w)))) {
      const zipPath = join(OUT, `${a.id}.zip`);
      await download(dl.downloadLink, zipPath, dl.size);
      const tmp = join(OUT, `${a.id}_unzip`);
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      execFileSync('unzip', ['-q', '-o', zipPath, '-d', tmp]);
      mkdirSync(dir, { recursive: true });
      for (const w of want) {
        const hit = readdirSync(tmp).find((f) => f === w);
        if (!hit) throw new Error(`${a.id}: ${w} not in zip`);
        renameSync(join(tmp, hit), join(dir, w));
      }
      rmSync(tmp, { recursive: true, force: true });
      rmSync(zipPath, { force: true });
    }
    for (const m of mapNames) {
      const key = ACG_MAPS[m];
      const name = `${a.id}_${a.res}_${m}.jpg`;
      const bytes = statSync(join(dir, name)).size;
      entry.files[key] = { path: `assets/${a.id}/${name}`, url: dl.downloadLink, bytes };
      total += bytes;
    }
  }
  manifest.assets.push(entry);
  console.log(`${a.id}: ${Object.values(entry.files).reduce((s, f) => s + f.bytes, 0)} bytes`);
}
manifest.totalBytes = total;
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const mb = (b) => (b / 1048576).toFixed(2);
let md = `# Credits — W17 look test\n\nEvery downloaded asset is CC0 1.0 (public domain dedication); attribution is not required and is given anyway. `;
md += `Downloaded by \`scripts/fetch-assets.mjs\` from the public APIs; no account was used. Everything else in the scene (geometry, panel seams, particles, sky, UI icons) is generated by code.\n\n`;
md += `Total texture and HDRI bytes on disk: ${total} (${mb(total)} MiB).\n\n`;
md += `| Asset | Source | Licence | Resolution | Used for | Authors |\n|---|---|---|---|---|---|\n`;
for (const e of manifest.assets) md += `| ${e.name} (\`${e.id}\`) | ${e.page} | CC0 1.0 | ${e.res} | ${e.role} | ${e.authors.join(', ')} |\n`;
md += `\n## Files\n\n| File | Bytes | Downloaded from |\n|---|---|---|\n`;
for (const e of manifest.assets) for (const f of Object.values(e.files)) md += `| \`public/${f.path}\` | ${f.bytes} | ${f.url} |\n`;
md += `\nLicence texts: Poly Haven — https://polyhaven.com/license ; ambientCG — https://docs.ambientcg.com/license/ (both CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/).\n`;
md += `\nnpm packages: three (MIT), postprocessing (Zlib), n8ao (ISC).\n`;
writeFileSync(join(ROOT, 'CREDITS.md'), md);
console.log(`total ${total} bytes (${mb(total)} MiB)`);
