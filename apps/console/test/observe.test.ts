import { describe, expect, it } from "vitest";
import { summarize, type HourAggregate } from "../src/data/observe.js";

const agg = (o: Partial<HourAggregate>): HourAggregate => ({
  featureId: "triage",
  modelId: "chrome:158",
  platform: "chrome",
  hour: 0,
  calls: 0,
  onDevice: 0,
  inCloud: 0,
  deviceAttempts: 0,
  escalations: 0,
  errors: 0,
  errorCodes: {},
  policyVersions: [],
  p95LatencyMs: null,
  deviceP95LatencyMs: null,
  ...o,
});

describe("summarize", () => {
  it("rolls hours up per feature and model and flags confidently bad routes", () => {
    const s = summarize([
      agg({ hour: 3_600_000, calls: 40, onDevice: 30, deviceAttempts: 40, escalations: 10, errors: 1, errorCodes: { BUSY: 1 }, policyVersions: [4], p95LatencyMs: 1800 }),
      agg({ hour: 0, calls: 20, onDevice: 10, deviceAttempts: 20, escalations: 10, errorCodes: { BUSY: 2, QUOTA: 1 }, policyVersions: [3, 4], p95LatencyMs: 2500 }),
      agg({ featureId: "reply", modelId: "cloud:web", calls: 5, inCloud: 5 }),
    ]);
    expect(s.map((x) => x.featureId)).toEqual(["reply", "triage"]);
    const t = s[1]!;
    expect(t).toMatchObject({ calls: 60, onDeviceShare: 40 / 60, deviceAttempts: 60, escalationRate: 20 / 60, worstP95Ms: 2500, versions: [3, 4], topError: "BUSY", atRisk: true });
    expect(t.hours).toEqual([[0, 10, 10], [3_600_000, 30, 10]]);
    expect(t.escalationLb).toBeGreaterThan(0.15);
    expect(s[0]).toMatchObject({ deviceAttempts: 0, escalationRate: 0, escalationLb: 0, errorLb: 0, worstP95Ms: null, atRisk: false });
    expect(s[0]!.topError).toBeUndefined();
  });

  it("does not flag quiet or healthy routes", () => {
    expect(summarize([agg({ calls: 10, deviceAttempts: 10, escalations: 10 })])[0]!.atRisk).toBe(false);
    expect(summarize([agg({ calls: 200, onDevice: 199, deviceAttempts: 200, escalations: 1 })])[0]!.atRisk).toBe(false);
    expect(summarize([agg({ calls: 0 })])[0]!.onDeviceShare).toBe(0);
  });
});
