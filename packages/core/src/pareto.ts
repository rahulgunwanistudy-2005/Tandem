import type { ModelId } from "./contracts.js";
import type { Evidence } from "./evidence.js";
import { decideAll, type CompilerSettings } from "./compiler.js";

/**
 * The budget dial. For each τ on a grid, compile the routing and predict:
 *  - on-device share of traffic,
 *  - monthly cloud cost (cloud-routed calls + escalations from device-routed calls),
 *  - expected pass rate (device models at their measured pass rate, cloud at the reference rate).
 * All costs are ESTIMATES from user-provided traffic mix and per-call price; the UI labels them so.
 */

export interface TrafficModel {
  /** share of calls per device model; normalised internally */
  mix: Partial<Record<ModelId, number>>;
  monthlyCalls: number;
  /** estimated USD per cloud call for this feature */
  cloudCostPerCall: number;
}

export interface ParetoPoint {
  tau: number;
  deviceShare: number;
  monthlyCloudCost: number;
  expectedPassRate: number;
  routedToDevice: ModelId[];
}

export function predict(
  evidence: readonly Evidence[],
  cloudPassRate: number,
  traffic: TrafficModel,
  settings: CompilerSettings,
  /** per-model share of device answers that fail local validation and escalate (default 1 − passRate) */
  escalationRate?: Partial<Record<ModelId, number>>,
): ParetoPoint {
  const decisions = decideAll(evidence, settings);
  const total = Object.values(traffic.mix).reduce<number>((a, b) => a + (b ?? 0), 0);
  let deviceShare = 0;
  let cloudShare = 0;
  let pass = 0;
  const routed: ModelId[] = [];
  for (const [model, raw] of Object.entries(traffic.mix) as Array<[ModelId, number | undefined]>) {
    const w = total > 0 ? (raw ?? 0) / total : 0;
    const d = decisions.find((x) => x.target === model);
    if (d?.routeToDevice) {
      routed.push(model);
      const esc = escalationRate?.[model] ?? 1 - d.evidence.passRate;
      deviceShare += w * (1 - esc);
      cloudShare += w * esc; // escalated calls are paid for in the cloud
      // Device passes, plus escalated answers re-answered by the cloud. `esc` is a subset of the
      // failures, so passRate + esc ≤ 1. The default esc = 1 − passRate assumes every failure is
      // caught by local validation, which is optimistic for semantic failures; callers pass the
      // measured deterministic-failure share when they have it.
      pass += w * (d.evidence.passRate + Math.min(esc, 1 - d.evidence.passRate) * cloudPassRate);
    } else {
      cloudShare += w;
      pass += w * cloudPassRate;
    }
  }
  return {
    tau: settings.tau,
    deviceShare,
    monthlyCloudCost: cloudShare * traffic.monthlyCalls * traffic.cloudCostPerCall,
    expectedPassRate: Math.min(1, pass),
    routedToDevice: routed.sort(),
  };
}

export function paretoCurve(
  evidence: readonly Evidence[],
  cloudPassRate: number,
  traffic: TrafficModel,
  base: Omit<CompilerSettings, "tau">,
  taus: readonly number[] = range(0.5, 0.99, 0.01),
): ParetoPoint[] {
  return taus.map((tau) => predict(evidence, cloudPassRate, traffic, { ...base, tau }));
}

/** Points not dominated on (lower cost, higher pass rate). */
export function paretoFrontier(points: readonly ParetoPoint[]): ParetoPoint[] {
  return points.filter(
    (p) =>
      !points.some(
        (q) =>
          q.monthlyCloudCost <= p.monthlyCloudCost &&
          q.expectedPassRate >= p.expectedPassRate &&
          (q.monthlyCloudCost < p.monthlyCloudCost || q.expectedPassRate > p.expectedPassRate),
      ),
  );
}

export function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  const n = Math.round((to - from) / step);
  for (let i = 0; i <= n; i++) out.push(Math.round((from + i * step) * 1000) / 1000);
  return out;
}
