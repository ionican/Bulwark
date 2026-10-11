// Types for scripts/benchGate.mjs (imported by test/w24r2b-review-gate.test.ts).

export interface BenchSample {
  s: number;
  d: Record<string, number>;
  cov: Record<string, number[]>;
  alive: number;
  ungrouped: string[];
  frame?: { tick: number; paused: boolean; calls: number; triangles: number; floorCalls: number; floorTriangles: number };
}

export function judgeSamples(
  window: BenchSample[],
  opts: { zoomOut: boolean; aliens: string[]; turrets: string[]; buildingKinds: string[]; minAlive?: number; doors?: boolean },
): string[];

import type { WorkerWindowReport } from '../src/workerWindow.ts';
export type { WorkerWindowReport };

export function judgeWorkerWindow(report: WorkerWindowReport | null): string[];
