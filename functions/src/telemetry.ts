/**
 * Pure telemetry logic for aggregateTelemetry and autoRollback. Events are content-free
 * (contracts/telemetry.schema.json); nothing here ever sees prompt or output text.
 */
import {
  DEFAULT_ROLLBACK,
  percentile,
  rollbackDecision,
  wildcardFor,
  type ModelId,
  type Policy,
  type RollbackDecision,
  type RollbackThresholds,
  type TelemetryEvent,
  type WindowStats,
} from "@tandem/core";

export const HOUR_MS = 60 * 60 * 1000;
export const ROLLBACK_WINDOW_MS = HOUR_MS;
export const hourOf = (ts: number) => Math.floor(ts / HOUR_MS) * HOUR_MS;
export const aggId = (featureId: string, modelId: string, hour: number) =>
  `${featureId}__${modelId.replace(/[^A-Za-z0-9._-]/g, "_")}__${hour}`;

export interface HourAggregate {
  featureId: string;
  modelId: ModelId;
  platform: TelemetryEvent["platform"];
  hour: number;
  calls: number;
  onDevice: number;
  inCloud: number;
  /** calls a policy sent to the device first */
  deviceAttempts: number;
  escalations: number;
  errors: number;
  errorCodes: Record<string, number>;
  validation: { pass: number; fail: number; skipped: number };
  policyVersions: number[];
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  deviceP95LatencyMs: number | null;
}

const isDeviceMode = (m: TelemetryEvent["mode"]) => m === "PREFER_ON_DEVICE" || m === "ONLY_ON_DEVICE";
/** GUARDRAIL is a policy outcome (the model declined), not a quality failure of the route. */
const isError = (e: TelemetryEvent) => e.errorCode !== undefined && e.errorCode !== "GUARDRAIL";

/** Hourly rollups per (feature, model). Recomputed from raw events, so re-running is idempotent. */
export function aggregate(events: readonly TelemetryEvent[]): HourAggregate[] {
  const groups = new Map<string, TelemetryEvent[]>();
  for (const e of events) {
    const k = aggId(e.featureId, e.modelId, hourOf(e.ts));
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  const out: HourAggregate[] = [];
  for (const g of groups.values()) {
    const first = g[0]!;
    const errorCodes: Record<string, number> = {};
    const validation = { pass: 0, fail: 0, skipped: 0 };
    for (const e of g) {
      if (e.errorCode) errorCodes[e.errorCode] = (errorCodes[e.errorCode] ?? 0) + 1;
      validation[e.validation]++;
    }
    const device = g.filter((e) => e.backend === "ON_DEVICE");
    out.push({
      featureId: first.featureId,
      modelId: first.modelId,
      platform: first.platform,
      hour: hourOf(first.ts),
      calls: g.length,
      onDevice: device.length,
      inCloud: g.filter((e) => e.backend === "IN_CLOUD").length,
      deviceAttempts: g.filter((e) => isDeviceMode(e.mode)).length,
      escalations: g.filter((e) => e.escalated).length,
      errors: g.filter(isError).length,
      errorCodes,
      validation,
      policyVersions: [...new Set(g.map((e) => e.policyVersion))].sort((a, b) => a - b),
      p50LatencyMs: percentile(g.map((e) => e.latencyMs), 50) ?? null,
      p95LatencyMs: percentile(g.map((e) => e.latencyMs), 95) ?? null,
      deviceP95LatencyMs: percentile(device.map((e) => e.latencyMs), 95) ?? null,
    });
  }
  return out.sort((a, b) => a.hour - b.hour || a.featureId.localeCompare(b.featureId) || a.modelId.localeCompare(b.modelId));
}

/** The live rule key an event's model resolves to (exact, then platform wildcard). */
export function ruleKeyFor(policy: Policy, modelId: ModelId): string | undefined {
  if (policy.rules[modelId]) return modelId;
  const w = wildcardFor(modelId);
  return policy.rules[w] ? w : undefined;
}

/**
 * Window stats for each on-device rule of the live policy. Only events served under the live
 * version count, so a rule that was just re-promoted starts from a clean window and a demotion is
 * never re-triggered by the traffic that caused it.
 */
export function windowStats(policy: Policy, events: readonly TelemetryEvent[]): Map<string, WindowStats> {
  const out = new Map<string, WindowStats>();
  for (const [key, rule] of Object.entries(policy.rules))
    if (isDeviceMode(rule.mode)) out.set(key, { attempts: 0, escalations: 0, errors: 0 });
  for (const e of events) {
    if (e.featureId !== policy.featureId || e.policyVersion !== policy.version || !isDeviceMode(e.mode)) continue;
    const key = ruleKeyFor(policy, e.modelId);
    const w = key === undefined ? undefined : out.get(key);
    if (!w) continue;
    w.attempts++;
    if (e.escalated) w.escalations++;
    if (isError(e)) w.errors++;
  }
  return out;
}

export interface Demotion {
  target: string;
  decision: Extract<RollbackDecision, { demote: true }>;
  window: WindowStats;
}

export function demotions(policy: Policy, events: readonly TelemetryEvent[], t: RollbackThresholds = DEFAULT_ROLLBACK): Demotion[] {
  const out: Demotion[] = [];
  for (const [target, window] of windowStats(policy, events)) {
    const decision = rollbackDecision(window, t);
    if (decision.demote) out.push({ target, decision, window });
  }
  return out;
}

/**
 * The next policy version with the given rules sent back to the cloud. The variant stays the
 * default (human) one — the same rule the compiler writes for a cloud-routed model.
 */
export function demotedPolicy(live: Policy, targets: readonly string[], now: Date): Policy {
  const rules = { ...live.rules };
  for (const t of targets) {
    const r = rules[t];
    if (!r) continue;
    rules[t] = { mode: "ONLY_IN_CLOUD", variantId: live.default.variantId, reason: "AUTO_ROLLBACK", ...(r.evidence ? { evidence: r.evidence } : {}) };
  }
  const used = new Set([live.default.variantId, ...Object.values(rules).map((r) => r.variantId)]);
  const variants = Object.fromEntries(Object.entries(live.variants).filter(([id]) => used.has(id)));
  return { ...live, version: live.version + 1, compiledAt: now.toISOString(), rules, variants };
}
