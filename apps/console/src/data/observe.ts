import { DEFAULT_ROLLBACK, wilsonLowerBound, type ModelId } from "@tandem/core";

/** Mirrors functions/src/telemetry.ts HourAggregate (written by aggregateTelemetry). */
export interface HourAggregate {
  featureId: string;
  modelId: ModelId;
  platform: string;
  hour: number;
  calls: number;
  onDevice: number;
  inCloud: number;
  deviceAttempts: number;
  escalations: number;
  errors: number;
  errorCodes: Record<string, number>;
  policyVersions: number[];
  p95LatencyMs: number | null;
  deviceP95LatencyMs: number | null;
}

export interface Incident {
  id: string;
  kind: "AUTO_ROLLBACK";
  featureId: string;
  target: string;
  fromVersion: number;
  toVersion: number;
  metric: "escalation_rate" | "error_rate";
  observed: number;
  lowerBound: number;
  threshold: number;
  window: { attempts: number; escalations: number; errors: number; ms: number };
  at?: { toMillis(): number };
}

export interface ModelSummary {
  featureId: string;
  modelId: ModelId;
  calls: number;
  onDeviceShare: number;
  deviceAttempts: number;
  escalationRate: number;
  escalationLb: number;
  errorRate: number;
  errorLb: number;
  /** worst hourly p95 in the window (hourly rollups cannot be merged into an exact p95) */
  worstP95Ms: number | null;
  versions: number[];
  topError?: string;
  /** calls per hour, oldest first: [hour, onDevice, other] */
  hours: [number, number, number][];
  atRisk: boolean;
}

/** Roll hourly aggregates up per (feature, model) for the Observe page. */
export function summarize(aggs: readonly HourAggregate[], t = DEFAULT_ROLLBACK): ModelSummary[] {
  const groups = new Map<string, HourAggregate[]>();
  for (const a of aggs) {
    const k = `${a.featureId}\u0000${a.modelId}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const out: ModelSummary[] = [];
  for (const g of groups.values()) {
    const sum = (f: (a: HourAggregate) => number) => g.reduce((s, a) => s + f(a), 0);
    const calls = sum((a) => a.calls);
    const attempts = sum((a) => a.deviceAttempts);
    const esc = Math.min(sum((a) => a.escalations), attempts);
    const err = Math.min(sum((a) => a.errors), Math.max(attempts, 0));
    const codes: Record<string, number> = {};
    for (const a of g) for (const [c, n] of Object.entries(a.errorCodes)) codes[c] = (codes[c] ?? 0) + n;
    const topError = Object.entries(codes).sort((x, y) => y[1] - x[1])[0]?.[0];
    const p95s = g.map((a) => a.p95LatencyMs).filter((x): x is number => x !== null);
    const escalationLb = attempts ? wilsonLowerBound(esc, attempts) : 0;
    const errorLb = attempts ? wilsonLowerBound(err, attempts) : 0;
    out.push({
      featureId: g[0]!.featureId,
      modelId: g[0]!.modelId,
      calls,
      onDeviceShare: calls ? sum((a) => a.onDevice) / calls : 0,
      deviceAttempts: attempts,
      escalationRate: attempts ? esc / attempts : 0,
      escalationLb,
      errorRate: attempts ? err / attempts : 0,
      errorLb,
      worstP95Ms: p95s.length ? Math.max(...p95s) : null,
      versions: [...new Set(g.flatMap((a) => a.policyVersions))].sort((a, b) => a - b),
      ...(topError ? { topError } : {}),
      hours: [...g].sort((a, b) => a.hour - b.hour).map((a) => [a.hour, a.onDevice, a.calls - a.onDevice]),
      atRisk: attempts >= t.minAttempts && (escalationLb > t.maxEscalationRate || errorLb > t.maxErrorRate),
    });
  }
  return out.sort((a, b) => a.featureId.localeCompare(b.featureId) || b.calls - a.calls);
}
