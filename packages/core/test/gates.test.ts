import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DEFAULT_GATES, evaluateRepair, holdoutGate, regressionGate, trainGate } from "../src/repair.js";
import { DEFAULT_ROLLBACK, rollbackDecision } from "../src/rollback.js";
import { BUDGETS, calibrate, checkBudget, estimateTokens, SAFETY } from "../src/budget.js";
import { paretoCurve, paretoFrontier, predict, range } from "../src/pareto.js";
import { wilsonLowerBound } from "../src/stats.js";
import type { Evidence } from "../src/evidence.js";
import type { ModelId } from "../src/contracts.js";

describe("repair gates", () => {
  const good = { n: 84, passes: 83 };
  const holdout = { n: 36, passes: 35 };
  const others = [
    { target: "chrome:158" as ModelId, parent: { n: 120, passes: 115 }, candidate: { n: 120, passes: 116 }, parentOnDevice: true },
    { target: "cloud:gemini-3.5-flash-lite" as ModelId, parent: { n: 120, passes: 118 }, candidate: { n: 120, passes: 117 }, parentOnDevice: false },
  ];

  it("accepts a candidate that clears all three gates", () => {
    const r = evaluateRepair({ train: good, holdout, regression: others });
    expect(r.accepted).toBe(true);
    expect(r.gates.map((g) => g.gate)).toEqual(["train", "holdout", "regression"]);
  });

  it("stops at the first failing gate", () => {
    expect(evaluateRepair({ train: { n: 84, passes: 60 }, holdout, regression: others })).toMatchObject({ accepted: false, failedAt: "train" });
    expect(evaluateRepair({ train: good, holdout: { n: 36, passes: 20 }, regression: others }).failedAt).toBe("holdout");
    expect(evaluateRepair({ train: good }).failedAt).toBe("holdout");
    expect(evaluateRepair({ train: good, holdout }).failedAt).toBe("regression");
  });

  it("train gate needs minimum evidence", () => {
    expect(trainGate({ n: 29, passes: 29 }, DEFAULT_GATES)).toMatchObject({ pass: false, detail: "n=29 < 30" });
  });

  it("holdout gate catches overfitting even when the holdout LB clears the slackened bar", () => {
    const s = { ...DEFAULT_GATES, holdoutSlack: 0.5 };
    const g = holdoutGate({ n: 300, passes: 300 }, { n: 40, passes: 32 }, s);
    expect(g.pass).toBe(false);
    expect(g.detail).toContain("significantly below train");
    expect(holdoutGate(good, { n: 10, passes: 10 }, DEFAULT_GATES).detail).toBe("n=10 < 15");
  });

  it("regression gate rejects inferiority, lost device routes and unmeasured targets", () => {
    const worse = regressionGate([{ ...others[1]!, candidate: { n: 120, passes: 90 } }], DEFAULT_GATES);
    expect(worse.pass).toBe(false);
    expect(worse.targets?.[0]?.detail).toContain("Δ lower");
    const lostRoute = regressionGate([{ ...others[0]!, parent: { n: 120, passes: 112 }, candidate: { n: 120, passes: 104 } }], DEFAULT_GATES);
    expect(lostRoute.targets?.[0]?.detail).toContain("lose its device route");
    expect(regressionGate([{ ...others[0]!, candidate: { n: 0, passes: 0 } }], DEFAULT_GATES).targets?.[0]?.detail).toContain("not measured");
    expect(regressionGate([], DEFAULT_GATES)).toMatchObject({ pass: true, detail: "no other targets" });
  });

  it("property: an accepted candidate always has train LB ≥ τ", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 150 }).chain((n) => fc.tuple(fc.integer({ min: 0, max: n }), fc.constant(n))), ([p, n]) => {
        const r = evaluateRepair({ train: { n, passes: p }, holdout: { n: 40, passes: 40 }, regression: [] });
        return !r.accepted || (n >= 30 && wilsonLowerBound(p, n) >= DEFAULT_GATES.tau);
      }),
    );
  });
});

describe("rollbackDecision", () => {
  it("waits for enough traffic", () => {
    expect(rollbackDecision({ attempts: 19, escalations: 19, errors: 0 })).toMatchObject({ demote: false, reason: "INSUFFICIENT_TRAFFIC" });
    expect(rollbackDecision({ attempts: 0, escalations: 0, errors: 0 })).toMatchObject({ escalationLb: 0 });
  });
  it("demotes on escalation or error rate when the lower bound crosses the threshold", () => {
    expect(rollbackDecision({ attempts: 100, escalations: 40, errors: 0 })).toMatchObject({ demote: true, metric: "escalation_rate" });
    expect(rollbackDecision({ attempts: 100, escalations: 0, errors: 30 })).toMatchObject({ demote: true, metric: "error_rate" });
    expect(rollbackDecision({ attempts: 100, escalations: 5, errors: 2 })).toMatchObject({ demote: false, reason: "HEALTHY" });
  });
  it("does not flap on a point estimate just above the threshold", () => {
    // 4/20 = 20% > 15%, but we are not 95% sure the true rate exceeds 15%.
    expect(rollbackDecision({ attempts: 20, escalations: 4, errors: 0 }).demote).toBe(false);
  });
  it("property: never demotes below the point-estimate threshold", () => {
    fc.assert(
      fc.property(fc.integer({ min: 20, max: 1000 }).chain((n) => fc.tuple(fc.integer({ min: 0, max: n }), fc.constant(n))), ([esc, n]) => {
        const d = rollbackDecision({ attempts: n, escalations: esc, errors: 0 });
        return !d.demote || esc / n > DEFAULT_ROLLBACK.maxEscalationRate;
      }),
    );
  });
});

describe("token budget", () => {
  it("estimates conservatively and counts dense scripts per character", () => {
    expect(estimateTokens("abcdef", "android-nano")).toBe(2);
    expect(estimateTokens("注文番号", "android-nano")).toBe(4);
    expect(estimateTokens("안녕 hi", "chrome-nano")).toBe(3);
    expect(estimateTokens("abcdefgh", "gemini-cloud")).toBe(2);
  });
  it("applies the 85% safety margin and the per-family output cap", () => {
    const limit = Math.floor(BUDGETS["android-nano"].totalTokens * SAFETY);
    const fits = checkBudget("x".repeat(3 * (limit - 256)), "android-nano", 1000);
    expect(fits).toMatchObject({ fits: true, reservedOutputTokens: 256, limitTokens: limit });
    const over = checkBudget("x".repeat(3 * (limit - 256) + 3), "android-nano", 256);
    expect(over.fits).toBe(false);
    expect(over.reason).toContain("85%");
  });
  it("enforces calibrated rejections", () => {
    let c = calibrate({}, { inputChars: 9000, rejected: true });
    c = calibrate(c, { inputChars: 7000, rejected: true });
    c = calibrate(c, { inputChars: 8000, rejected: true });
    c = calibrate(c, { inputChars: 3000, rejected: false });
    c = calibrate(c, { inputChars: 2000, rejected: false });
    expect(c).toEqual({ rejectedAtChars: 7000, acceptedAtChars: 3000 });
    expect(checkBudget("x".repeat(6000), "chrome-nano", 100, c)).toMatchObject({ fits: false, reason: "a device rejected 7000 chars" });
    expect(checkBudget("x".repeat(5000), "chrome-nano", 100, c).fits).toBe(true);
  });
});

describe("pareto", () => {
  const ev = (target: ModelId, passes: number, n: number): Evidence => ({
    variantId: "v1", target, n, passes, lb: wilsonLowerBound(passes, n), passRate: passes / n,
    p95LatencyMs: 1000, flakiness: 0, integrityFailures: 0, errors: 0, pending: 0, cases: n / 3,
  });
  const evidence = [ev("android:nano-v4", 118, 120), ev("chrome:158", 114, 120), ev("ios:26.1", 95, 120)];
  const traffic = { mix: { "android:nano-v4": 0.5, "chrome:158": 0.3, "ios:26.1": 0.2 } as Partial<Record<ModelId, number>>, monthlyCalls: 1_000_000, cloudCostPerCall: 0.0002 };
  const base = { minN: 30, latencyBudgetMs: 3000, flakinessWarn: 0.2 };

  it("predicts share, cost and pass rate for one τ", () => {
    const p = predict(evidence, 0.97, traffic, { ...base, tau: 0.85 });
    expect(p.routedToDevice).toEqual(["android:nano-v4", "chrome:158"]);
    expect(p.deviceShare).toBeGreaterThan(0.7);
    expect(p.monthlyCloudCost).toBeGreaterThan(0);
    expect(p.expectedPassRate).toBeLessThanOrEqual(1);
    const p2 = predict(evidence, 0.97, traffic, { ...base, tau: 0.85 }, { "android:nano-v4": 0 });
    expect(p2.deviceShare).toBeGreaterThan(p.deviceShare);
    expect(predict(evidence, 0.97, { ...traffic, mix: {} }, { ...base, tau: 0.85 }).deviceShare).toBe(0);
  });

  it("property: raising τ never increases device share or lowers cloud cost", () => {
    const curve = paretoCurve(evidence, 0.97, traffic, base);
    expect(curve).toHaveLength(50);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.deviceShare).toBeLessThanOrEqual(curve[i - 1]!.deviceShare + 1e-12);
      expect(curve[i]!.monthlyCloudCost).toBeGreaterThanOrEqual(curve[i - 1]!.monthlyCloudCost - 1e-9);
    }
    const front = paretoFrontier(curve);
    expect(front.length).toBeGreaterThan(0);
    expect(front.length).toBeLessThanOrEqual(curve.length);
  });

  it("builds τ grids", () => {
    expect(range(0.5, 0.52, 0.01)).toEqual([0.5, 0.51, 0.52]);
  });
});
