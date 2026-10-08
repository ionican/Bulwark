// W23 units in the workshop: engineers and the commander following simple task lists (walk a path,
// build a site, carry salvage, drop a temporary turret, fire). Movement is scripted along paths
// (the game's pathfinding is not part of the asset workshop); the rigs animate whatever motion the
// task produces, so the feet plant at any speed and on any heading.

import { Vector3 } from 'three';
import type { Ground } from './rig/biped.ts';
import { CommanderRig } from './rig/commander.ts';
import { COMMANDER_TURN, COMMANDER_WALK, ENGINEER_RUN, ENGINEER_WALK } from './rig/specs.ts';
import { EngineerRig, type EngAction, type EngVariant } from './rig/engineer.ts';

/** A thing being built: progress 0 … 1 over buildTime seconds of one engineer's work. */
export interface Site {
  label: string;
  progress: number;
  /** Seconds for one engineer (the commander builds twice as fast: W13's build power 10 vs 5). */
  buildTime: number;
  /** Centre on the ground (world). */
  centre: Vector3;
  /** Height the build cut climbs to. */
  height: number;
  /** Where to stand: distance from the centre. */
  reach: number;
  /** Called once when the build completes. */
  onDone?: () => void;
  /** Called when building starts. */
  onStart?: () => void;
}

export type Task =
  | { kind: 'walk'; to: Array<[number, number]>; run?: boolean }
  | { kind: 'build'; site: Site }
  | { kind: 'wait'; s: number }
  | { kind: 'face'; x: number; z: number }
  | { kind: 'carry'; on: boolean; onDone?: () => void }
  | { kind: 'drop' }
  | { kind: 'fire'; at: Vector3; s: number }
  | { kind: 'action'; action: EngAction; s: number }
  | { kind: 'call'; fn: () => void };

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const headingTo = (dx: number, dz: number) => Math.atan2(-dz, dx);

/** Point on a site the beam plays on: wanders over the footprint at the current cut height. */
export function beamPoint(site: Site, t: number, out: Vector3): Vector3 {
  const r = Math.min(0.9, site.reach * 0.45);
  return out.set(site.centre.x + Math.sin(t * 2.3) * r * 0.8, site.centre.y + site.height * Math.min(1, site.progress) + 0.02, site.centre.z + Math.cos(t * 1.7) * r * 0.6);
}

abstract class UnitBase {
  x = 0;
  z = 0;
  yaw = 0;
  tasks: Task[] = [];
  /** Task time (seconds into the current task). */
  tt = 0;
  /** Site under construction by this unit this frame (null when not building). */
  building: Site | null = null;
  readonly beamFrom = new Vector3();
  readonly beamTo = new Vector3();
  clock = 0;
  speedScale = 1;

  abstract readonly kind: 'engineer' | 'commander';
  protected abstract walkSpeed(run: boolean): number;
  protected abstract turnRate(): number;
  /** Builder rate (sites per second relative to one engineer). */
  protected abstract rate(): number;
  /** Whether the unit must turn on the spot before walking (the commander). */
  protected turnFirst = false;

  get idle(): boolean {
    return this.tasks.length === 0;
  }

  then(...t: Task[]): this {
    this.tasks.push(...t);
    return this;
  }

  /** Heading change towards `want` at the unit's turn rate; returns the remaining difference. */
  protected turnTo(want: number, dt: number): number {
    const d = wrapPi(want - this.yaw);
    const step = this.turnRate() * dt;
    this.yaw = wrapPi(this.yaw + Math.max(-step, Math.min(step, d)));
    return wrapPi(want - this.yaw);
  }

  /** Runs the current task; returns the motion mode for the rig. */
  protected step(dt: number): { mode: 'idle' | 'walk' | 'run' | 'turn' | 'build' | 'fire' | 'other'; fireAt?: Vector3 } {
    this.building = null;
    const t = this.tasks[0];
    if (!t) return { mode: 'idle' };
    this.tt += dt;
    const next = () => {
      this.tasks.shift();
      this.tt = 0;
    };
    switch (t.kind) {
      case 'walk': {
        const [tx, tz] = t.to[0]!;
        const dx = tx - this.x;
        const dz = tz - this.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.05) {
          t.to.shift();
          if (!t.to.length) next();
          return { mode: 'walk' };
        }
        const rem = this.turnTo(headingTo(dx, dz), dt);
        if (this.turnFirst && Math.abs(rem) > 0.35) return { mode: 'turn' };
        const v = this.walkSpeed(!!t.run) * this.speedScale * (Math.abs(rem) > 1 ? 0.3 : 1);
        const s = Math.min(d, v * dt);
        this.x += (dx / d) * s;
        this.z += (dz / d) * s;
        return { mode: t.run ? 'run' : 'walk' };
      }
      case 'face': {
        const rem = this.turnTo(headingTo(t.x - this.x, t.z - this.z), dt);
        if (Math.abs(rem) < 0.02) next();
        return { mode: this.turnFirst ? 'turn' : 'idle' };
      }
      case 'build': {
        const s = t.site;
        if (this.tt <= dt) s.onStart?.();
        // the commander turns its torso, not its legs; an engineer faces the site
        if (!this.turnFirst) this.turnTo(headingTo(s.centre.x - this.x, s.centre.z - this.z), dt);
        s.progress = Math.min(1, s.progress + (dt * this.rate()) / s.buildTime);
        this.building = s;
        if (s.progress >= 1) {
          s.onDone?.();
          next();
        }
        return { mode: 'build' };
      }
      case 'wait':
        if (this.tt >= t.s) next();
        return { mode: 'idle' };
      case 'carry':
        this.setCarry(t.on);
        t.onDone?.();
        next();
        return { mode: 'idle' };
      case 'drop':
        if (this.tt >= 1.85) next();
        return { mode: 'other' };
      case 'fire':
        if (this.tt >= t.s) next();
        return { mode: 'fire', fireAt: t.at };
      case 'action':
        if (this.tt >= t.s) next();
        return { mode: 'other' };
      case 'call':
        t.fn();
        next();
        return { mode: 'idle' };
    }
  }

  protected setCarry(_on: boolean): void {}
}

export class EngineerUnit extends UnitBase {
  readonly kind = 'engineer' as const;
  readonly rig: EngineerRig;
  carrying = false;
  /** Index for the detail-level tracker. */
  constructor(
    readonly id: number,
    variant: EngVariant,
  ) {
    super();
    this.rig = new EngineerRig(variant);
  }

  protected walkSpeed(run: boolean): number {
    return run ? ENGINEER_RUN : ENGINEER_WALK;
  }
  protected turnRate(): number {
    return 5;
  }
  protected rate(): number {
    return 1;
  }
  protected override setCarry(on: boolean): void {
    this.carrying = on;
  }

  place(x: number, z: number, yaw: number, ground: Ground): void {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.rig.place(x, z, yaw, ground);
  }

  update(dt: number, ground: Ground): void {
    this.clock += dt;
    const task = this.tasks[0];
    const r = this.step(dt);
    const rig = this.rig;
    if (task?.kind === 'drop' && rig.action !== 'drop' && this.tt <= dt) rig.setAction('drop');
    else if (task?.kind === 'action' && this.tt <= dt) rig.setAction(task.action);
    else if (task?.kind !== 'drop' && task?.kind !== 'action') {
      const a: EngAction = r.mode === 'build' ? 'build' : this.carrying ? 'carry' : r.mode === 'run' ? 'run' : r.mode === 'walk' ? 'walk' : 'idle';
      rig.setAction(a);
    }
    if (this.building) beamPoint(this.building, this.clock, rig.aim);
    rig.update(dt, this.x, this.z, this.yaw, ground);
    if (this.building) {
      this.beamFrom.copy(rig.tip);
      this.beamTo.copy(rig.aim);
    }
  }
}

export class CommanderUnit extends UnitBase {
  readonly kind = 'commander' as const;
  readonly rig = new CommanderRig();
  /** Set on the frame a shot leaves the muzzle. */
  shot = false;
  protected override turnFirst = true;

  protected walkSpeed(): number {
    return COMMANDER_WALK;
  }
  protected turnRate(): number {
    return COMMANDER_TURN;
  }
  protected rate(): number {
    return 2;
  }

  place(x: number, z: number, yaw: number, ground: Ground): void {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.rig.place(x, z, yaw, ground);
  }

  update(dt: number, ground: Ground): void {
    this.clock += dt;
    const r = this.step(dt);
    const rig = this.rig;
    rig.setAction(r.mode === 'build' ? 'build' : r.mode === 'fire' ? 'fire' : r.mode === 'turn' ? 'turn' : r.mode === 'walk' || r.mode === 'run' ? 'walk' : 'idle');
    if (this.building) beamPoint(this.building, this.clock, rig.aim);
    if (r.fireAt) rig.aim.copy(r.fireAt);
    rig.update(dt, this.x, this.z, this.yaw, ground);
    this.shot = rig.fired;
    if (this.building) {
      this.beamFrom.copy(rig.emitter);
      this.beamTo.copy(rig.aim);
    }
  }
}

export type Unit = EngineerUnit | CommanderUnit;
