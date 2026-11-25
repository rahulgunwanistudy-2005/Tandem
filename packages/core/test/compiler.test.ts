import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { aggregateEvidence, type Evidence, type SampleOutcome } from "../src/evidence.js";
import {
  compilePolicy,
  decide,
  decideAll,
  diffPolicies,
  DEFAULT_SETTINGS,
  type CompilerSettings,
} from "../src/compiler.js";
import { resolveRule } from "../src/resolve.js";
import { wilsonLowerBound } from "../src/stats.js";
import type { ModelId, Policy } from "../src/contracts.js";

const S: CompilerSettings = { ...DEFAULT_SETTINGS, latencyBudgetMs: 3000 };

function ev(target: ModelId, passes: number, n: number, extra: Partial<Evidence> = {}): Evidence {
  return {
    variantId: "v1",
    target,
    n,
    passes,
    lb: wilsonLowerBound(passes, n),
    passRate: n ? passes / n : 0,
    p95LatencyMs: 1000,
    flakiness: 0,
    integrityFailures: 0,
    errors: 0,
    pending: 0,
    cases: Math.ceil(n / 3),
    ...extra,
  };
}

function samples(
  target: ModelId,
  variantId: string,
  perCase: boolean[][],
  split: "train" | "holdout" = "train",
): SampleOutcome[] {
  return perCase.flatMap((outs, i) =>
    outs.map(
      (pass, k) =>
        ({
          caseId: `c${i}`,
          variantId,
          target,
          split,
          verdict: pass ? "pass" : "fail",
          latencyMs: 500 + 10 * i + k,
        }) as SampleOutcome,
    ),
  );
}

describe("aggregateEvidence", () => {
  it("computes n, passes, LB, latency percentiles and flakiness", () => {
    const s = samples("android:nano-v4", "v1", [
      [true, true, true],
      [true, false, true],
      [false, false, false],
    ]);
    s.push({
      caseId: "c9",
      variantId: "v1",
      target: "android:nano-v4",
      split: "train",
      verdict: "pending_judge",
    });
    s.push({
      caseId: "c8",
      variantId: "v1",
      target: "android:nano-v4",
      split: "train",
      verdict: "integrity_fail",
    });
    s.push({
      caseId: "c7",
      variantId: "v1",
      target: "android:nano-v4",
      split: "train",
      verdict: "error",
    });
    const [e] = aggregateEvidence(s);
    expect(e).toMatchObject({
      n: 11,
      passes: 5,
      pending: 1,
      integrityFailures: 1,
      errors: 1,
      cases: 5,
    });
    expect(e?.lb).toBeCloseTo(wilsonLowerBound(5, 11), 4);
    expect(e?.flakiness).toBeCloseTo(1 / 5, 4);
    expect(e?.p95LatencyMs).toBe(522);
  });
  it("filters by split and groups by (variant, target)", () => {
    const s = [
      ...samples("chrome:158", "v1", [[true]], "train"),
      ...samples("chrome:158", "v2", [[true]], "holdout"),
      ...samples("android:nano-v4", "v1", [[false]], "holdout"),
    ];
    expect(aggregateEvidence(s)).toHaveLength(3);
    expect(aggregateEvidence(s, "holdout").map((e) => `${e.target}/${e.variantId}`)).toEqual([
      "android:nano-v4/v1",
      "chrome:158/v2",
    ]);
    expect(aggregateEvidence([], "train")).toEqual([]);
  });
});

describe("decide", () => {
  it("routes to device only when every condition holds", () => {
    expect(decide(ev("android:nano-v4", 120, 120), S)).toMatchObject({
      routeToDevice: true,
      reason: "PASSED",
    });
    expect(decide(ev("android:nano-v4", 29, 29), S).reason).toBe("INSUFFICIENT_EVIDENCE");
    expect(decide(ev("android:nano-v4", 120, 120, { integrityFailures: 1 }), S).reason).toBe(
      "INTEGRITY_FAILURES",
    );
    expect(decide(ev("android:nano-v4", 96, 120), S).reason).toBe("LB_BELOW_TAU");
    expect(decide(ev("android:nano-v4", 120, 120, { p95LatencyMs: 3001 }), S).reason).toBe(
      "LATENCY_OVER_BUDGET",
    );
    const { p95LatencyMs: _p, ...noLatency } = ev("android:nano-v4", 120, 120);
    expect(decide(noLatency as Evidence, S).reason).toBe("LATENCY_OVER_BUDGET");
  });

  it("is inclusive at τ and at minN", () => {
    const e = ev("android:nano-v4", 30, 30);
    expect(decide(e, { ...S, tau: e.lb }).routeToDevice).toBe(true);
    expect(decide(e, { ...S, tau: e.lb + 1e-9 }).routeToDevice).toBe(false);
    expect(decide(ev("android:nano-v4", 30, 30, { p95LatencyMs: 3000 }), S).routeToDevice).toBe(
      true,
    );
  });

  it("flags flakiness above 20% without changing the route", () => {
    expect(decide(ev("android:nano-v4", 120, 120, { flakiness: 0.21 }), S)).toMatchObject({
      routeToDevice: true,
      flaky: true,
    });
    expect(decide(ev("android:nano-v4", 120, 120, { flakiness: 0.2 }), S).flaky).toBe(false);
  });

  it("property: a device route implies n ≥ minN, no integrity failures, LB ≥ τ, p95 ≤ budget", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 300 })
          .chain((n) => fc.tuple(fc.integer({ min: 0, max: n }), fc.constant(n))),
        fc.integer({ min: 0, max: 2 }),
        fc.integer({ min: 100, max: 6000 }),
        fc.double({ min: 0.5, max: 0.99, noNaN: true }),
        ([p, n], integ, p95, tau) => {
          const e = ev("chrome:158", p, n, { integrityFailures: integ, p95LatencyMs: p95 });
          const d = decide(e, { ...S, tau });
          return (
            !d.routeToDevice ||
            (n >= S.minN && integ === 0 && e.lb >= tau && p95 <= S.latencyBudgetMs)
          );
        },
      ),
    );
  });

  it("property: raising τ never promotes a model", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 30, max: 300 })
          .chain((n) => fc.tuple(fc.integer({ min: 0, max: n }), fc.constant(n))),
        fc.double({ min: 0.5, max: 0.98, noNaN: true }),
        fc.double({ min: 0, max: 0.2, noNaN: true }),
        ([p, n], tau, bump) => {
          const e = ev("chrome:158", p, n);
          return (
            !decide(e, { ...S, tau: Math.min(1, tau + bump) }).routeToDevice ||
            decide(e, { ...S, tau }).routeToDevice
          );
        },
      ),
    );
  });
});

describe("decideAll", () => {
  it("picks the best variant per device target and ignores the cloud reference", () => {
    const all = [
      ev("android:nano-v4", 100, 120, { variantId: "v1" }),
      ev("android:nano-v4", 119, 120, { variantId: "v2" }),
      ev("android:nano-v4", 119, 120, { variantId: "v3", p95LatencyMs: 800 }),
      ev("cloud:gemini-3.5-flash-lite", 120, 120),
      ev("chrome:158", 10, 10, { variantId: "a" }),
      ev("chrome:158", 50, 120, { variantId: "b" }),
    ];
    const d = decideAll(all, S);
    expect(d.map((x) => `${x.target}:${x.variantId}:${x.reason}`)).toEqual([
      "android:nano-v4:v3:PASSED",
      "chrome:158:b:LB_BELOW_TAU", // closer to passing than "insufficient evidence"
    ]);
  });
  it("breaks exact ties by variant id", () => {
    const d = decideAll(
      [ev("ios:26.1", 120, 120, { variantId: "z" }), ev("ios:26.1", 120, 120, { variantId: "a" })],
      S,
    );
    expect(d[0]?.variantId).toBe("a");
  });
});

describe("compilePolicy + resolveRule", () => {
  const variants = {
    v1: { systemInstruction: "s", promptTemplate: "{{input}}", sha256: "a".repeat(64) },
    v2: { systemInstruction: "s2", promptTemplate: "x {{input}}", sha256: "b".repeat(64) },
  };
  const feature = {
    id: "triage",
    outputKind: "json" as const,
    outputSchema: { type: "object" as const },
    cloudModel: "gemini-3.5-flash-lite",
    latencyBudgetMs: 3000,
  };
  const policy = compilePolicy({
    feature,
    defaultVariantId: "v1",
    variants,
    evidence: [
      ev("android:nano-v4", 120, 120, { variantId: "v2" }),
      ev("chrome:158", 80, 120, { variantId: "v2" }),
    ],
    settings: DEFAULT_SETTINGS,
    version: 4,
    sourceRunIds: ["r1"],
    now: new Date("2026-11-25T00:00:00Z"),
  });

  it("compiles rules, keeps cloud-routed models on the default variant, and embeds used variants", () => {
    expect(policy.rules["android:nano-v4"]).toMatchObject({
      mode: "PREFER_ON_DEVICE",
      variantId: "v2",
      reason: "PASSED",
    });
    expect(policy.rules["chrome:158"]).toMatchObject({
      mode: "ONLY_IN_CLOUD",
      variantId: "v1",
      reason: "LB_BELOW_TAU",
    });
    expect(policy.default).toEqual({
      mode: "ONLY_IN_CLOUD",
      variantId: "v1",
      reason: "NO_EVIDENCE",
    });
    expect(Object.keys(policy.variants)).toEqual(["v1", "v2"]);
    expect(policy.compiledAt).toBe("2026-11-25T00:00:00.000Z");
  });

  it("validates its inputs", () => {
    const base = {
      feature,
      defaultVariantId: "v1",
      variants,
      evidence: [],
      settings: DEFAULT_SETTINGS,
      version: 1,
      sourceRunIds: [],
    };
    expect(() => compilePolicy({ ...base, settings: { ...DEFAULT_SETTINGS, tau: 0 } })).toThrow(
      RangeError,
    );
    expect(() => compilePolicy({ ...base, defaultVariantId: "nope" })).toThrow(/default variant/);
    expect(() =>
      compilePolicy({ ...base, evidence: [ev("ios:26.1", 1, 1, { variantId: "ghost" })] }),
    ).toThrow(/unknown variant/);
    expect(compilePolicy(base).rules).toEqual({});
  });

  it("resolves exact → wildcard → default and survives a dangling variant", () => {
    expect(resolveRule(policy, "android:nano-v4")).toMatchObject({
      matchedBy: "exact",
      rule: { variantId: "v2" },
    });
    expect(resolveRule(policy, "ios:26.1")).toMatchObject({ matchedBy: "default" });
    const withWildcard: Policy = {
      ...policy,
      rules: {
        ...policy.rules,
        "ios:*": { mode: "PREFER_ON_DEVICE", variantId: "v1", reason: "MANUAL" },
      },
    };
    expect(resolveRule(withWildcard, "ios:26.2").matchedBy).toBe("wildcard");
    const dangling: Policy = {
      ...policy,
      rules: { "ios:26.1": { mode: "PREFER_ON_DEVICE", variantId: "ghost", reason: "MANUAL" } },
    };
    expect(resolveRule(dangling, "ios:26.1").matchedBy).toBe("default");
    expect(() => resolveRule({ ...policy, variants: {} }, "ios:26.1")).toThrow(
      /no default variant/,
    );
  });

  it("diffs policies", () => {
    const after: Policy = {
      ...policy,
      rules: {
        "android:nano-v4": {
          ...policy.rules["android:nano-v4"]!,
          mode: "ONLY_IN_CLOUD",
          reason: "AUTO_ROLLBACK",
        },
        "chrome:158": { ...policy.rules["chrome:158"]!, mode: "PREFER_ON_DEVICE" },
        "ios:26.1": { mode: "PREFER_ON_DEVICE", variantId: "v1", reason: "PASSED" },
      },
    };
    const kinds = Object.fromEntries(diffPolicies(policy, after).map((c) => [c.target, c.kind]));
    expect(kinds).toEqual({
      "android:nano-v4": "demoted",
      "chrome:158": "promoted",
      "ios:26.1": "added",
    });
    const removed = diffPolicies(after, {
      ...after,
      rules: { "ios:26.1": { ...after.rules["ios:26.1"]!, variantId: "v2" } },
    });
    expect(removed.map((c) => c.kind)).toEqual(["removed", "removed", "variant"]);
    expect(diffPolicies(undefined, policy).every((c) => c.kind === "added")).toBe(true);
    expect(diffPolicies(policy, policy).every((c) => c.kind === "unchanged")).toBe(true);
  });
});
