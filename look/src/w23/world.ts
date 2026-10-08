// W23 workshop world: a wall grid with its gates, deposits and extractors, engineers, the
// commander, dropped turret pods and salvage piles, on W17's terrain. Each frame it updates the
// moving things and pushes every visible part into the shared batches at its own detail level.

import { Color, Frustum, Matrix4, Sphere, Vector3, type PerspectiveCamera } from 'three';
import type { Particles } from '../fx/particles.ts';
import type { Tracers } from '../fx/tracers.ts';
import { PType } from '../fx/particles.ts';
import type { PartBatches } from './batches.ts';
import { BEAM_CYAN, type Beams } from './beams.ts';
import { EXTRACTOR_HEIGHT, FLOW_SEGS, extractorMatrix, extractorPose, flowSegment, pivotMatrix, type Extractor, type ExtractorKind, type ExtractorPose } from './extractors.ts';
import { ICON, type GroundIcons, type ScreenMarkers } from './icons.ts';
import { LevelTracker, type AssetKind, ASSET_KINDS } from './lod.ts';
import { BUILT } from './mats.ts';
import type { PartDef, PartSet } from './parts.ts';
import { CMD_PARTS, CMD_SEGS } from './rig/commander.ts';
import { segmentParts } from './rig/engineer.ts';
import type { Ground } from './rig/biped.ts';
import { GateDoor, type Mover } from './walls/gate.ts';
import { WallGrid } from './walls/grid.ts';
import { TIERS, gateInstance, leafOffsets, wallInstances } from './walls/layout.ts';
import { wallMatrix } from './walls/geometry.ts';
import { CommanderUnit, EngineerUnit, type Site, type Unit } from './units.ts';

export interface Deposit {
  kind: ExtractorKind;
  /** Footprint centre (world). */
  x: number;
  y: number;
  z: number;
  extractor: Extractor | null;
  site: Site | null;
}

export interface DrawCtx {
  batches: PartBatches;
  parts: PartSet;
  icons: GroundIcons;
  markers: ScreenMarkers;
  beams: Beams;
  camera: PerspectiveCamera;
  frustum: Frustum;
  /** World units per pixel per unit distance. */
  wppd: number;
  fx: Particles;
  tracers: Tracers;
  /** Fixed detail level (detail-level view), or null for by distance. */
  forced: number | null;
  /** Debug badges: callback per drawn object with its level. */
  badge?: (x: number, y: number, z: number, level: number) => void;
  /** Hide icons and markers (close-up line-up). */
  noMarkers?: boolean;
  /** Labels: called with the drawn object's world position. */
  sdt: number;
}

const _m = new Matrix4();
const _m2 = new Matrix4();
const _base = new Matrix4();
const _v = new Vector3();
const _w = new Vector3();
const _sph = new Sphere();
const TRACER_HDR = new Color(6, 4.2, 2);

export interface Pod {
  x: number;
  y: number;
  z: number;
  yaw: number;
  age: number;
}

export class World {
  readonly grid: WallGrid;
  readonly tileY: Float32Array;
  readonly doors = new Map<number, GateDoor>();
  /** Wall tiles under construction (tile index → site). */
  readonly wallSites = new Map<number, Site>();
  readonly deposits: Deposit[] = [];
  readonly engineers: EngineerUnit[] = [];
  readonly commanders: CommanderUnit[] = [];
  readonly pods: Pod[] = [];
  readonly piles: Array<{ x: number; y: number; z: number; n: number }> = [];
  readonly trackers = Object.fromEntries(ASSET_KINDS.map((k) => [k, new LevelTracker(k, 64)])) as Record<AssetKind, LevelTracker>;
  /** Level override per asset kind for the detail-level view (index → level). */
  levelOf: ((kind: AssetKind, x: number, z: number) => number | null) | null = null;
  time = 0;
  private wallVersion = -1;
  private wMat = new Float32Array(0);
  private wPart: PartDef[] = [];
  private wTiles: Array<{ tile: number; first: number; n: number; cx: number; cy: number; cz: number }> = [];
  private pose: ExtractorPose = { spin: 0, slide: 0, fill: 0, light: 0, flow: [] };
  private sparkAcc = 0;

  constructor(
    readonly ox: number,
    readonly oz: number,
    w: number,
    h: number,
    readonly ground: Ground,
    readonly parts: PartSet,
  ) {
    this.grid = new WallGrid(w, h);
    this.tileY = new Float32Array(w * h);
    for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) this.tileY[z * w + x] = ground(ox + x + 0.5, oz + z + 0.5) - 0.03;
  }

  /** World tile coordinates → grid tile. */
  tileAt(wx: number, wz: number): [number, number] {
    return [Math.floor(wx - this.ox), Math.floor(wz - this.oz)];
  }

  tileCentre(x: number, z: number, out = new Vector3()): Vector3 {
    return out.set(this.ox + x + 0.5, this.tileY[z * this.grid.w + x] ?? 0, this.oz + z + 0.5);
  }

  addDeposit(kind: ExtractorKind, x: number, z: number): Deposit {
    const d: Deposit = { kind, x, y: this.ground(x, z), z, extractor: null, site: null };
    this.deposits.push(d);
    return d;
  }

  /** An extractor on a deposit; `built` 1 = complete and working. */
  addExtractor(d: Deposit, built = 1, rot = 0): Extractor {
    const e: Extractor = { kind: d.kind, x: d.x, y: d.y, z: d.z, rot, built, working: built >= 1, t: Math.random() * 5, damage: 0 };
    d.extractor = e;
    return e;
  }

  /** A construction site for an extractor on deposit d (the extractor appears and prints upward). */
  extractorSite(d: Deposit, rot = 0): Site {
    const site: Site = {
      label: `${d.kind} extractor`,
      progress: 0,
      buildTime: 9,
      centre: new Vector3(d.x, d.y, d.z),
      height: EXTRACTOR_HEIGHT[d.kind] + 0.3,
      reach: 1.6,
      onStart: () => {
        if (!d.extractor) this.addExtractor(d, 0, rot);
      },
      onDone: () => {
        if (d.extractor) {
          d.extractor.built = 1;
          d.extractor.working = true;
        }
        d.site = null;
      },
    };
    d.site = site;
    return site;
  }

  /** A construction site for one wall tile (tier t): the tile joins its neighbours at once. */
  wallSite(x: number, z: number, tier: number): Site {
    const idx = z * this.grid.w + x;
    const c = this.tileCentre(x, z);
    const site: Site = {
      label: 'wall',
      progress: 0,
      buildTime: 4,
      centre: c,
      height: TIERS[tier]!.top + 0.3,
      reach: 1.2,
      onStart: () => {
        this.grid.set(x, z, tier);
        this.wallSites.set(idx, site);
      },
      onDone: () => this.wallSites.delete(idx),
    };
    return site;
  }

  addEngineer(u: EngineerUnit, x: number, z: number, yaw: number): EngineerUnit {
    u.place(x, z, yaw, this.ground);
    this.engineers.push(u);
    return u;
  }

  addCommander(u: CommanderUnit, x: number, z: number, yaw: number): CommanderUnit {
    u.place(x, z, yaw, this.ground);
    this.commanders.push(u);
    return u;
  }

  get commander(): CommanderUnit | null {
    return this.commanders[0] ?? null;
  }

  units(): Unit[] {
    return [...this.engineers, ...this.commanders];
  }

  private syncDoors(): void {
    for (const id of [...this.doors.keys()]) if (!this.grid.gates.has(id)) this.doors.delete(id);
    for (const g of this.grid.gates.values()) {
      if (this.doors.has(g.id)) continue;
      const gi = gateInstance(g);
      this.doors.set(g.id, new GateDoor(this.ox + gi.x + 0.5, this.oz + gi.z + 0.5, g.axis, gi.depth));
    }
  }

  update(dt: number): void {
    this.time += dt;
    for (const u of this.engineers) u.update(dt, this.ground);
    for (const c of this.commanders) c.update(dt, this.ground);
    // pods appear where an engineer's drop gesture set them down
    for (const u of this.engineers) {
      if (u.rig.podDown && u.rig.action === 'drop' && !this.pods.some((p) => p.age < 1 && Math.hypot(p.x - u.rig.podAt.x, p.z - u.rig.podAt.z) < 0.05)) {
        this.pods.push({ x: u.rig.podAt.x, y: u.rig.podAt.y, z: u.rig.podAt.z, yaw: u.rig.podYaw, age: 0 });
      }
    }
    for (const p of this.pods) p.age += dt;
    this.syncDoors();
    const movers: Mover[] = this.units().map((u) => ({ kind: u.kind, x: u.x, z: u.z }));
    for (const d of this.doors.values()) d.update(dt, movers);
    for (const d of this.deposits) if (d.extractor?.working) d.extractor.t += dt;
  }

  // ---- drawing ---------------------------------------------------------------------------------------

  private rebuildWalls(): void {
    const list = wallInstances(this.grid);
    this.wMat = new Float32Array(list.length * 16);
    this.wPart = [];
    this.wTiles = [];
    const w = this.grid.w;
    list.forEach((inst, i) => {
      const tile = inst.z * w + inst.x;
      const y = this.tileY[tile]!;
      wallMatrix(_m, this.ox + inst.x + 0.5, y, this.oz + inst.z + 0.5, inst.rot, inst.off);
      _m.toArray(this.wMat, i * 16);
      this.wPart.push(this.parts.get(inst.part));
      const last = this.wTiles[this.wTiles.length - 1];
      if (last && last.tile === tile) last.n++;
      else this.wTiles.push({ tile, first: i, n: 1, cx: this.ox + inst.x + 0.5, cy: y + 0.8, cz: this.oz + inst.z + 0.5 });
    });
    this.wallVersion = this.grid.version;
  }

  private lvl(kind: AssetKind, i: number, d: number, ctx: DrawCtx, x: number, z: number): number {
    const f = this.levelOf?.(kind, x, z) ?? ctx.forced;
    return this.trackers[kind].level(i, d, f);
  }

  /** Icon quad matrix: on the ground at (x, y, z), size s tiles. */
  private iconAt(ctx: DrawCtx, icon: number, x: number, y: number, z: number, s: number, yaw = 0): void {
    _m.makeRotationY(yaw).scale(_v.set(s, 1, s)).setPosition(x, y, z);
    ctx.icons.push(icon, _m);
  }

  draw(ctx: DrawCtx): void {
    const { batches: B, camera, frustum, wppd } = ctx;
    const cp = camera.position;
    const P = (id: string) => this.parts.get(id);
    if (this.wallVersion !== this.grid.version) this.rebuildWalls();
    const visible = (x: number, y: number, z: number, r: number) => {
      _sph.center.set(x, y, z);
      _sph.radius = r;
      return frustum.intersectsSphere(_sph);
    };

    // walls
    for (const t of this.wTiles) {
      if (!visible(t.cx, t.cy, t.cz, 1.4)) continue;
      const d = Math.hypot(t.cx - cp.x, t.cy - cp.y, t.cz - cp.z);
      const lv = this.lvl('wall', t.tile, d, ctx, t.cx, t.cz);
      const tx = t.tile % this.grid.w;
      const tz = Math.floor(t.tile / this.grid.w);
      const site = this.wallSites.get(t.tile);
      const cut = site ? this.tileY[t.tile]! + site.height * site.progress : BUILT;
      const damage = this.grid.damageAt(tx, tz);
      B.count('wall', lv);
      ctx.badge?.(t.cx, t.cy + 1.2, t.cz, lv);
      if (lv === 3) {
        if (!site || site.progress > 0.5) this.iconAt(ctx, ICON.wall, t.cx, this.tileY[t.tile]! + 1.5, t.cz, 1 / 2.8);
        continue;
      }
      for (let k = 0; k < t.n; k++) {
        const i = t.first + k;
        B.push(this.wPart[i]!, lv, this.wMat, i * 16, 1, damage, cut);
      }
    }

    // gates
    for (const g of this.grid.gates.values()) {
      const gi = gateInstance(g);
      const cx = this.ox + gi.x + 0.5;
      const cz = this.oz + gi.z + 0.5;
      const tile = g.cz * this.grid.w + g.cx;
      const cy = this.tileY[tile]!;
      if (!visible(cx, cy + 1, cz, 2.5 + gi.depth / 2)) continue;
      const d = Math.hypot(cx - cp.x, cy + 1 - cp.y, cz - cp.z);
      const lv = this.lvl('gate', g.id, d, ctx, cx, cz);
      B.count('gate', lv);
      ctx.badge?.(cx, cy + 2.4, cz, lv);
      const door = this.doors.get(g.id);
      const open = door?.open ?? 0;
      if (lv === 3) {
        this.iconAt(ctx, ICON.gate, cx, cy + 1.6, cz, 3.2 / 2.8, gi.rot === 0 ? 0 : -Math.PI / 2);
        continue;
      }
      // gate space → world: T(centre) · R(gate) · T(offset) · R(piece)
      wallMatrix(_m2, cx, cy, cz, gi.rot, [0, 0, 0]);
      for (const pc of gi.parts) {
        _m.copy(_m2).multiply(wallMatrix(_base, pc.off[0], pc.off[1], pc.off[2], pc.rot, [0, 0, 0]));
        B.push(P(pc.part), lv, _m);
      }
      const moving = door ? door.open > 0 && door.open < 1 : false;
      const glow = moving ? 0.4 + 0.6 * (Math.sin(this.time * 14) > 0 ? 1 : 0) : open > 0.5 ? 1.4 : 0.6;
      // one telescoping door set across the middle of the passage
      for (const off of leafOffsets(open)) {
        wallMatrix(_m, cx, cy, cz, gi.rot, off);
        B.push(P('gate/leaf'), lv, _m, 0, glow);
      }
    }

    // deposits and extractors
    this.deposits.forEach((dp, i) => {
      if (!visible(dp.x, dp.y + 1, dp.z, 2.4)) return;
      const d = Math.hypot(dp.x - cp.x, dp.y + 1 - cp.y, dp.z - cp.z);
      const e = dp.extractor;
      const kind: AssetKind = e ? e.kind : 'deposit';
      const lv = this.lvl(kind, i, d, ctx, dp.x, dp.z);
      B.count(kind, lv);
      ctx.badge?.(dp.x, dp.y + (e ? 2.8 : 1.4), dp.z, lv);
      extractorMatrix(_base, { x: dp.x, y: dp.y, z: dp.z, rot: e?.rot ?? 0 });
      if (lv === 3) {
        const icon = e && e.built >= 0.5 ? (e.kind === 'mass' ? ICON.mass : ICON.rare) : dp.kind === 'mass' ? ICON.massDeposit : ICON.rareDeposit;
        this.iconAt(ctx, icon, dp.x, dp.y + 2, dp.z, Math.max(2.4, 16 * wppd * d) / 2.8);
        return;
      }
      // the ore is always there; the kerb marks a bare deposit (or one being built on)
      if (dp.kind === 'mass') {
        if (!e || e.built < 1) B.push(P('deposit/massOre'), lv, _base);
        if (!e) B.push(P('deposit/markerMass'), lv, _base);
      } else {
        B.push(P('deposit/rareCrystal'), lv, _base, 0, 0.45);
        if (!e) B.push(P('deposit/markerRare'), lv, _base);
      }
      if (!e) return;
      const cut = e.built < 1 ? dp.y + (EXTRACTOR_HEIGHT[e.kind] + 0.3) * e.built : BUILT;
      const pose = extractorPose(e, this.pose);
      if (e.kind === 'mass') {
        B.push(P('mass/base'), lv, _base, 0, 1, e.damage, cut);
        B.push(P('mass/drum'), lv, pivotMatrix(_m, _base, pose.spin, 0), 0, 1, e.damage, cut);
        B.push(P('mass/head'), lv, pivotMatrix(_m, _base, 0, pose.slide), 0, 1, e.damage, cut);
        B.push(P('mass/fill'), lv, pivotMatrix(_m, _base, 0, 0.08 + pose.fill), 0, 1, 0, cut);
        B.push(P('mass/light'), lv, _base, 0, pose.light * 2, 0, cut);
      } else {
        B.push(P('rare/base'), lv, _base, 0, 1, e.damage, cut);
        B.push(P('rare/ring'), lv, pivotMatrix(_m, _base, pose.spin, 0), 0, e.working ? 1.2 : 0.2, e.damage, cut);
        B.push(P('rare/pump'), lv, pivotMatrix(_m, _base, 0, pose.slide), 0, e.working ? 1 : 0.2, e.damage, cut);
        B.push(P('rare/light'), lv, _base, 0, pose.light * 2, 0, cut);
      }
      if (lv <= 1)
        for (let k = 0; k < FLOW_SEGS; k++) {
          const o = flowSegment(e.kind, k);
          B.push(P('flow/seg'), lv, pivotMatrix(_m, _base, 0, 0, o), 0, pose.flow[k]!, 0, cut);
        }
    });

    // pods (temporary turrets dropped by engineers) and salvage piles
    for (const p of this.pods) {
      if (!visible(p.x, p.y + 0.3, p.z, 0.6)) continue;
      const d = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z);
      const lv = Math.min(2, this.trackers.engineer.level(1000 + (this.pods.indexOf(p) % 200), d, this.levelOf?.('engineer', p.x, p.z) ?? ctx.forced));
      _m.makeRotationY(p.yaw).setPosition(p.x, p.y, p.z);
      const cut = p.age < 1.2 ? p.y + 0.32 * (p.age / 1.2) : BUILT;
      B.push(P('eng/pod'), lv, _m, 0, p.age > 1.2 ? 1.5 : 0.3, 0, cut);
    }
    for (const pl of this.piles) {
      const d = Math.hypot(pl.x - cp.x, pl.y - cp.y, pl.z - cp.z);
      const lv = Math.min(2, this.trackers.engineer.level(1300, d, ctx.forced));
      for (let k = 0; k < pl.n; k++) {
        _m.makeRotationY(k * 1.3).setPosition(pl.x + ((k % 3) - 1) * 0.14, pl.y + 0.1 + Math.floor(k / 3) * 0.1, pl.z + ((k * 7) % 3 - 1) * 0.12);
        B.push(P('eng/box'), lv, _m);
      }
    }

    // engineers
    for (const u of this.engineers) {
      const rig = u.rig;
      const px = rig.pos.x;
      const py = rig.legs.pelvisY;
      const pz = rig.pos.z;
      if (!visible(px, py, pz, 1.0)) continue;
      const d = Math.hypot(px - cp.x, py - cp.y, pz - cp.z);
      const lv = this.lvl('engineer', u.id, d, ctx, px, pz);
      B.count('engineer', lv);
      ctx.badge?.(px, py + 0.8, pz, lv);
      if (lv <= 2) {
        const segs = segmentParts(rig.variant, u.carrying);
        segs.forEach((id, k) => {
          if (id) B.push(P(id), lv, rig.mats[k]!);
        });
      }
      if (!ctx.noMarkers && lv >= 1) ctx.markers.push(px, py + (lv === 3 ? 0.3 : 0.9), pz, ICON.engineer, lv === 3 ? 18 : lv === 2 ? 17 : 15);
    }

    // commanders
    this.commanders.forEach((c, ci) => {
      const rig = c.rig;
      const px = rig.pos.x;
      const py = rig.legs.pelvisY + 0.5;
      const pz = rig.pos.z;
      if (!visible(px, py, pz, 3)) return;
      const d = Math.hypot(px - cp.x, py - cp.y, pz - cp.z);
      const lv = this.lvl('commander', ci, d, ctx, px, pz);
      B.count('commander', lv);
      ctx.badge?.(px, py + 2.6, pz, lv);
      if (lv <= 2) CMD_SEGS.forEach((s, k) => B.push(P(CMD_PARTS[s]), lv, rig.mats[k]!));
      if (!ctx.noMarkers && lv >= 2) ctx.markers.push(px, py + (lv === 3 ? 0 : 2.4), pz, lv === 3 ? ICON.commanderRing : ICON.commander, lv === 3 ? 34 : 24);
    });

    // beams, sparks and shots
    this.sparkAcc += ctx.sdt * 40;
    const spark = this.sparkAcc >= 1;
    if (spark) this.sparkAcc = 0;
    for (const u of this.units()) {
      if (!u.building) continue;
      const big = u.kind === 'commander';
      ctx.beams.push(u.beamFrom, u.beamTo, big ? 0.07 : 0.028, BEAM_CYAN, big ? 5 : 4, cp, wppd, big ? 3 : 2.4);
      // a hot spot where the beam meets the structure
      _v.copy(u.beamTo);
      _v.x -= big ? 0.06 : 0.025;
      _w.copy(u.beamTo);
      _w.x += big ? 0.06 : 0.025;
      ctx.beams.push(_v, _w, big ? 0.1 : 0.045, BEAM_CYAN, 2.5, cp, wppd, 3.5);
      if (spark && ctx.sdt > 0) ctx.fx.spawn({ type: PType.Spark, x: u.beamTo.x, y: u.beamTo.y, z: u.beamTo.z, vx: (Math.random() - 0.5) * 3, vy: Math.random() * 2, vz: (Math.random() - 0.5) * 3, life: 0.35, s0: 0.05, s1: 0.02, r: 1.6, g: 6, b: 9, a: 1, drag: 1.2 });
    }
    for (const c of this.commanders) {
      if (!c.shot) continue;
      const r = c.rig;
      ctx.fx.muzzle(r.muzzle.x, r.muzzle.y, r.muzzle.z, r.muzzleDir, true);
      const hit = r.aim.clone();
      ctx.tracers.fire({ from: r.muzzle.clone(), to: hit, dur: Math.max(0.08, r.muzzle.distanceTo(hit) / 60), arc: 0, len: 2.2, width: 0.07, colour: TRACER_HDR, beam: false, onHit: () => ctx.fx.sparks(hit.x, hit.y, hit.z, 5, 5) });
    }
  }
}
