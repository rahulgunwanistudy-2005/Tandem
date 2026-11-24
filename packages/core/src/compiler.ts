import type { ModelId, Policy, PolicyRule, PolicyVariant, RuleReason, Feature } from "./contracts.js";
import type { Evidence } from "./evidence.js";
import { isDeviceTarget } from "./models.js";

/**
 * The policy compiler: run statistics in, one routing rule per device model out.
 *
 * Rule for each (variant, model):
 *   route to device (PREFER_ON_DEVICE) iff
 *     n ≥ minN                      (otherwise INSUFFICIENT_EVIDENCE)
 *     integrityFailures = 0         (otherwise INTEGRITY_FAILURES)
 *     Wilson LB₉₅(passes, n) ≥ τ    (otherwise LB_BELOW_TAU)
 *     p95 latency ≤ budget          (otherwise LATENCY_OVER_BUDGET)
 *   else ONLY_IN_CLOUD.
 * Across variants of the same model the compiler picks the qualifying variant with the highest LB
 * (ties: lower p95, then variant id). If none qualifies, the model routes to cloud with the reason
 * of its best variant, so the UI can say *why*.
 */

export interface CompilerSettings {
  tau: number;
  minN: number;
  latencyBudgetMs: number;
  flakinessWarn: number;
}

export const DEFAULT_SETTINGS: Omit<CompilerSettings, "latencyBudgetMs"> = {
  tau: 0.85,
  minN: 30,
  flakinessWarn: 0.2,
};

export interface RuleDecision {
  target: ModelId;
  variantId: string;
  routeToDevice: boolean;
  reason: RuleReason;
  evidence: Evidence;
  flaky: boolean;
}

export function decide(e: Evidence, s: CompilerSettings): Omit<RuleDecision, "target" | "variantId" | "evidence"> {
  const flaky = e.flakiness > s.flakinessWarn;
  if (e.n < s.minN) return { routeToDevice: false, reason: "INSUFFICIENT_EVIDENCE", flaky };
  if (e.integrityFailures > 0) return { routeToDevice: false, reason: "INTEGRITY_FAILURES", flaky };
  if (e.lb < s.tau) return { routeToDevice: false, reason: "LB_BELOW_TAU", flaky };
  if (e.p95LatencyMs === undefined || e.p95LatencyMs > s.latencyBudgetMs) {
    return { routeToDevice: false, reason: "LATENCY_OVER_BUDGET", flaky };
  }
  return { routeToDevice: true, reason: "PASSED", flaky };
}

/** Badness order when no variant qualifies: report the reason closest to passing. */
const REASON_RANK: Record<RuleReason, number> = {
  PASSED: 0,
  LATENCY_OVER_BUDGET: 1,
  LB_BELOW_TAU: 2,
  INTEGRITY_FAILURES: 3,
  INSUFFICIENT_EVIDENCE: 4,
  NO_EVIDENCE: 5,
  AUTO_ROLLBACK: 6,
  MANUAL: 7,
};

function better(a: RuleDecision, b: RuleDecision): boolean {
  if (a.routeToDevice !== b.routeToDevice) return a.routeToDevice;
  if (!a.routeToDevice && REASON_RANK[a.reason] !== REASON_RANK[b.reason]) {
    return REASON_RANK[a.reason] < REASON_RANK[b.reason];
  }
  if (a.evidence.lb !== b.evidence.lb) return a.evidence.lb > b.evidence.lb;
  const pa = a.evidence.p95LatencyMs ?? Infinity;
  const pb = b.evidence.p95LatencyMs ?? Infinity;
  if (pa !== pb) return pa < pb;
  return a.variantId < b.variantId;
}

/** Best decision per device target. Cloud targets (the reference) never get rules. */
export function decideAll(evidence: readonly Evidence[], s: CompilerSettings): RuleDecision[] {
  const best = new Map<ModelId, RuleDecision>();
  for (const e of evidence) {
    if (!isDeviceTarget(e.target)) continue;
    const d: RuleDecision = { target: e.target, variantId: e.variantId, evidence: e, ...decide(e, s) };
    const cur = best.get(e.target);
    if (!cur || better(d, cur)) best.set(e.target, d);
  }
  return [...best.values()].sort((a, b) => a.target.localeCompare(b.target));
}

export interface CompileInput {
  feature: Pick<Feature, "id" | "outputKind" | "outputSchema" | "cloudModel" | "latencyBudgetMs">;
  defaultVariantId: string;
  variants: Record<string, PolicyVariant>;
  evidence: readonly Evidence[];
  settings: Omit<CompilerSettings, "latencyBudgetMs"> & { latencyBudgetMs?: number };
  version: number;
  sourceRunIds: string[];
  now?: Date;
}

export function compilePolicy(input: CompileInput): Policy {
  const s: CompilerSettings = {
    ...input.settings,
    latencyBudgetMs: input.settings.latencyBudgetMs ?? input.feature.latencyBudgetMs,
  };
  if (!(s.tau > 0 && s.tau <= 1)) throw new RangeError(`tau must be in (0, 1], got ${s.tau}`);
  if (!input.variants[input.defaultVariantId]) {
    throw new Error(`default variant "${input.defaultVariantId}" is not in variants`);
  }

  const rules: Record<string, PolicyRule> = {};
  const used = new Set<string>([input.defaultVariantId]);
  for (const d of decideAll(input.evidence, s)) {
    if (!input.variants[d.variantId]) throw new Error(`evidence references unknown variant "${d.variantId}"`);
    // A cloud-routed model runs the default (human) variant in the cloud: repaired variants are
    // tuned for a device model, and the cloud reference was measured on the default.
    const variantId = d.routeToDevice ? d.variantId : input.defaultVariantId;
    used.add(variantId);
    rules[d.target] = {
      mode: d.routeToDevice ? "PREFER_ON_DEVICE" : "ONLY_IN_CLOUD",
      variantId,
      reason: d.reason,
      evidence: {
        n: d.evidence.n,
        passes: d.evidence.passes,
        lb: d.evidence.lb,
        ...(d.evidence.p95LatencyMs !== undefined ? { p95LatencyMs: d.evidence.p95LatencyMs } : {}),
        flakiness: d.evidence.flakiness,
        integrityFailures: d.evidence.integrityFailures,
      },
    };
  }

  const variants: Record<string, PolicyVariant> = {};
  for (const id of [...used].sort()) variants[id] = input.variants[id] as PolicyVariant;

  return {
    schemaVersion: 1,
    featureId: input.feature.id,
    version: input.version,
    compiledAt: (input.now ?? new Date()).toISOString(),
    tau: s.tau,
    sourceRunIds: input.sourceRunIds,
    // Unknown models (not tested) go to the cloud. Tandem never routes an untested model to device.
    default: { mode: "ONLY_IN_CLOUD", variantId: input.defaultVariantId, reason: "NO_EVIDENCE" },
    rules,
    variants,
    outputSchema: input.feature.outputSchema,
    outputKind: input.feature.outputKind,
    cloudModel: input.feature.cloudModel,
  };
}

export interface RuleChange {
  target: string;
  before?: PolicyRule;
  after?: PolicyRule;
  kind: "added" | "removed" | "promoted" | "demoted" | "variant" | "unchanged";
}

/** Diff two policies for the Policy screen. */
export function diffPolicies(before: Policy | undefined, after: Policy): RuleChange[] {
  const targets = new Set([...Object.keys(before?.rules ?? {}), ...Object.keys(after.rules)]);
  const out: RuleChange[] = [];
  for (const t of [...targets].sort()) {
    const b = before?.rules[t];
    const a = after.rules[t];
    let kind: RuleChange["kind"];
    if (!b) kind = "added";
    else if (!a) kind = "removed";
    else if (onDevice(b) !== onDevice(a)) kind = onDevice(a) ? "promoted" : "demoted";
    else if (b.variantId !== a.variantId) kind = "variant";
    else kind = "unchanged";
    out.push({ target: t, ...(b ? { before: b } : {}), ...(a ? { after: a } : {}), kind });
  }
  return out;
}

export function onDevice(r: Pick<PolicyRule, "mode">): boolean {
  return r.mode === "PREFER_ON_DEVICE" || r.mode === "ONLY_ON_DEVICE";
}
