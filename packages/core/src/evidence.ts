import type { ModelId, RuleEvidence, Split, Verdict } from "./contracts.js";
import { flakiness, percentile, wilsonLowerBound } from "./stats.js";

/** One finished sample, reduced to what the statistics need. */
export interface SampleOutcome {
  caseId: string;
  variantId: string;
  target: ModelId;
  split?: Split;
  verdict: Verdict;
  latencyMs?: number;
}

export interface Evidence extends RuleEvidence {
  variantId: string;
  target: ModelId;
  n: number;
  passes: number;
  lb: number;
  passRate: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  flakiness: number;
  integrityFailures: number;
  errors: number;
  /** samples still waiting for the judge; excluded from n. */
  pending: number;
  cases: number;
}

const key = (variantId: string, target: string) => `${variantId}\u0000${target}`;

/**
 * Aggregate sample outcomes into evidence per (variant, target), optionally for one split.
 * `pending_judge` samples are excluded from n; everything else counts (errors count as failures —
 * a model that times out or refuses has not earned the device).
 */
export function aggregateEvidence(samples: readonly SampleOutcome[], split?: Split): Evidence[] {
  const groups = new Map<string, SampleOutcome[]>();
  for (const s of samples) {
    if (split && s.split !== split) continue;
    const k = key(s.variantId, s.target);
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }

  const out: Evidence[] = [];
  for (const g of groups.values()) {
    const first = g[0] as SampleOutcome;
    const decided = g.filter((s) => s.verdict !== "pending_judge");
    const passes = decided.filter((s) => s.verdict === "pass").length;
    const n = decided.length;
    const byCase = new Map<string, boolean[]>();
    for (const s of decided) {
      const arr = byCase.get(s.caseId);
      if (arr) arr.push(s.verdict === "pass");
      else byCase.set(s.caseId, [s.verdict === "pass"]);
    }
    const latencies = decided.map((s) => s.latencyMs).filter((v): v is number => typeof v === "number");
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    out.push({
      variantId: first.variantId,
      target: first.target,
      n,
      passes,
      lb: round4(wilsonLowerBound(passes, n)),
      passRate: n === 0 ? 0 : passes / n,
      ...(p50 !== undefined ? { p50LatencyMs: p50 } : {}),
      ...(p95 !== undefined ? { p95LatencyMs: p95 } : {}),
      flakiness: round4(flakiness(byCase)),
      integrityFailures: decided.filter((s) => s.verdict === "integrity_fail").length,
      errors: decided.filter((s) => s.verdict === "error").length,
      pending: g.length - n,
      cases: byCase.size,
    });
  }
  return out.sort((a, b) => (a.target + a.variantId).localeCompare(b.target + b.variantId));
}

export function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
