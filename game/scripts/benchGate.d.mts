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

export interface WorkerWindowReport {
  kept: number;
  ticks: number;
  seconds: number;
  medianTickMs: number;
  maxTickMs: number;
  encodeMedianMs: number;
  encodeMaxMs: number;
  dropped: { beforeStart: number; afterStop: number; epoch: number; repeated: number };
}

export function judgeWorkerWindow(report: WorkerWindowReport | null): string[];
