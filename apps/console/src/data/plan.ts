import {
  aggregateEvidence,
  isDeviceTarget,
  type Case,
  type Evidence,
  type Job,
  type ModelId,
  type SampleOutcome,
  type Split,
} from "@tandem/core";

export interface RunPlan {
  runId: string;
  featureId: string;
  variantIds: string[];
  targets: ModelId[];
  samples: number;
  cases: Pick<Case, "id" | "split">[];
}

export const MAX_JOBS_PER_RUN = 2000;

/** Stable job id: rerunning the same plan addresses the same documents. */
export function jobId(caseId: string, variantId: string, target: ModelId, sample: number): string {
  return `${caseId}__${variantId}__${target}__${sample}`;
}

/** Every (case × variant × target × sample) as a queued job. */
export function planJobs(p: RunPlan): Job[] {
  if (p.samples < 1 || !Number.isInteger(p.samples)) throw new RangeError("samples must be ≥ 1");
  if (p.targets.length === 0) throw new RangeError("pick at least one target");
  if (p.variantIds.length === 0) throw new RangeError("pick at least one variant");
  const total = p.cases.length * p.variantIds.length * p.targets.length * p.samples;
  if (total > MAX_JOBS_PER_RUN)
    throw new RangeError(`${total} jobs is over the ${MAX_JOBS_PER_RUN}-job limit per run`);
  const jobs: Job[] = [];
  // Sample-major order so every case gets one sample before any gets two: a half-finished run
  // already covers the whole suite.
  for (let sample = 0; sample < p.samples; sample++)
    for (const c of p.cases)
      for (const variantId of p.variantIds)
        for (const target of p.targets)
          jobs.push({
            id: jobId(c.id, variantId, target, sample),
            runId: p.runId,
            caseId: c.id,
            variantId,
            target,
            split: c.split,
            sample,
            state: "queued",
            attempt: 0,
          });
  return jobs;
}

export interface RunProgress {
  total: number;
  queued: number;
  leased: number;
  done: number;
  failed: number;
  pendingJudge: number;
}

export function progressOf(jobs: readonly Pick<Job, "state" | "verdict">[]): RunProgress {
  const p: RunProgress = { total: jobs.length, queued: 0, leased: 0, done: 0, failed: 0, pendingJudge: 0 };
  for (const j of jobs) {
    p[j.state]++;
    if (j.verdict === "pending_judge") p.pendingJudge++;
  }
  return p;
}

/** Finished jobs → the statistics' sample outcomes. Cancelled (failed, no verdict) jobs are skipped. */
export function outcomesOf(jobs: readonly Job[]): SampleOutcome[] {
  const out: SampleOutcome[] = [];
  for (const j of jobs) {
    if (j.state !== "done" || !j.verdict) continue;
    out.push({
      caseId: j.caseId,
      variantId: j.variantId,
      target: j.target,
      ...(j.split ? { split: j.split } : {}),
      verdict: j.verdict,
      ...(j.result ? { latencyMs: j.result.latencyMs } : {}),
    });
  }
  return out;
}

export function evidenceOf(jobs: readonly Job[], split?: Split): Evidence[] {
  return aggregateEvidence(outcomesOf(jobs), split);
}

/** Matrix cell: every sample of one case on one (variant, target). */
export interface Cell {
  caseId: string;
  variantId: string;
  target: ModelId;
  jobs: Job[];
  passes: number;
  decided: number;
}

export function matrix(jobs: readonly Job[]): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  for (const j of jobs) {
    const k = cellKey(j.caseId, j.variantId, j.target);
    let c = cells.get(k);
    if (!c) {
      c = { caseId: j.caseId, variantId: j.variantId, target: j.target, jobs: [], passes: 0, decided: 0 };
      cells.set(k, c);
    }
    c.jobs.push(j);
    if (j.state === "done" && j.verdict && j.verdict !== "pending_judge") {
      c.decided++;
      if (j.verdict === "pass") c.passes++;
    }
  }
  for (const c of cells.values()) c.jobs.sort((a, b) => a.sample - b.sample);
  return cells;
}

export const cellKey = (caseId: string, variantId: string, target: ModelId) =>
  `${caseId}\u0000${variantId}\u0000${target}`;

/** Device targets first (sorted), then the cloud reference. */
export function orderTargets(targets: Iterable<ModelId>): ModelId[] {
  return [...new Set(targets)].sort((a, b) => {
    const da = isDeviceTarget(a);
    const db = isDeviceTarget(b);
    return da === db ? a.localeCompare(b) : da ? -1 : 1;
  });
}
