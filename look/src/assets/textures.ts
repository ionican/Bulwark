// Loads the CC0 textures listed in public/assets/manifest.json (written by scripts/fetch-assets.mjs).
// Each file is fetched once and kept as a Blob; the quality setting decodes it at full size (high)
// or half size (medium) with createImageBitmap, so switching quality swaps GPU textures without a
// second download. Tracks an estimate of GPU texture memory.

import { LinearMipmapLinearFilter, NoColorSpace, RepeatWrapping, SRGBColorSpace, Texture, type ColorSpace } from 'three';

export type Quality = 'high' | 'medium';

interface ManifestFile {
  path: string;
  url: string;
  bytes: number;
}
interface ManifestAsset {
  id: string;
  files: Record<string, ManifestFile>;
}

interface Slot {
  key: string;
  blob: Blob;
  colour: ColorSpace;
  texture: Texture;
}

export class TextureBank {
  private slots = new Map<string, Slot>();
  /** Textures made in code (composites, noise), counted in the memory estimate. */
  readonly derived = new Set<Texture>();
  quality: Quality = 'high';
  anisotropy = 8;
  downloadedBytes = 0;
  hdrUrl = '';

  async load(onProgress?: (done: number, total: number) => void): Promise<void> {
    const manifest = (await (await fetch('assets/manifest.json')).json()) as { assets: ManifestAsset[] };
    const jobs: Array<Promise<void>> = [];
    let done = 0;
    let total = 0;
    for (const a of manifest.assets) {
      for (const [key, f] of Object.entries(a.files)) {
        if (key === 'hdr') {
          this.hdrUrl = f.path;
          continue;
        }
        total++;
        jobs.push(
          (async () => {
            const r = await fetch(f.path);
            if (!r.ok) throw new Error(`texture ${f.path}: HTTP ${r.status}`);
            const blob = await r.blob();
            this.downloadedBytes += blob.size;
            const t = new Texture();
            const colour = key === 'diff' ? SRGBColorSpace : NoColorSpace;
            t.colorSpace = colour;
            t.wrapS = t.wrapT = RepeatWrapping;
            t.minFilter = LinearMipmapLinearFilter;
            t.flipY = false;
            t.name = `${a.id}/${key}`;
            this.slots.set(`${a.id}/${key}`, { key: `${a.id}/${key}`, blob, colour, texture: t });
            onProgress?.(++done, total);
          })(),
        );
      }
    }
    await Promise.all(jobs);
    await this.decodeAll();
  }

  private async decodeAll(): Promise<void> {
    await Promise.all([...this.slots.values()].map((s) => this.decode(s)));
  }

  private async decode(s: Slot): Promise<void> {
    const probe = await createImageBitmap(s.blob);
    const div = this.quality === 'high' ? 1 : 2;
    const w = Math.max(64, probe.width / div);
    const h = Math.max(64, probe.height / div);
    probe.close();
    // Decoded flipped (OpenGL UV convention, as the GL normal maps expect) at the target size.
    const bmp = await createImageBitmap(s.blob, { imageOrientation: 'flipY', resizeWidth: w, resizeHeight: h, resizeQuality: 'high', colorSpaceConversion: 'none' });
    const old = s.texture.image as ImageBitmap | undefined;
    s.texture.dispose();
    s.texture.image = bmp;
    s.texture.anisotropy = this.anisotropy;
    s.texture.needsUpdate = true;
    if (old && 'close' in old) old.close();
  }

  async setQuality(q: Quality, anisotropy: number): Promise<void> {
    this.quality = q;
    this.anisotropy = anisotropy;
    await this.decodeAll();
  }

  tex(key: string): Texture {
    const s = this.slots.get(key);
    if (!s) throw new Error(`no texture ${key}`);
    return s.texture;
  }

  /** Pixels of a loaded texture at the current quality (for building composites in code). */
  pixels(key: string): ImageData {
    const img = this.tex(key).image as ImageBitmap;
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, img.width, img.height);
  }

  /** Estimated GPU bytes for all textures: RGBA8 with a full mip chain (×4/3). */
  memoryBytes(): number {
    let b = 0;
    const add = (t: Texture) => {
      const img = t.image as { width?: number; height?: number } | undefined;
      if (img?.width && img.height) b += img.width * img.height * 4 * (4 / 3);
    };
    for (const s of this.slots.values()) add(s.texture);
    for (const t of this.derived) add(t);
    return b;
  }

  get count(): number {
    return this.slots.size + this.derived.size;
  }
}
