import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parsePolicy } from "../../packages/runtime-web/src/policy.js";
import type { Policy, TelemetryEvent } from "@tandem/core";
import { aggId, aggregate, demotedPolicy, demotions, HOUR_MS, ruleKeyFor, windowStats } from "../src/telemetry.js";

const policy = JSON.parse(readFileSync(new URL("../../contracts/fixtures/policy.triage.json", import.meta.url), "utf8")) as Policy;
const base = JSON.parse(readFileSync(new URL("../../contracts/fixtures/telemetry.event.json", import.meta.url), "utf8")) as TelemetryEvent;

let n = 0;
const ev = (o: Partial<TelemetryEvent> = {}): TelemetryEvent => ({
  ...base,
  eventId: `evt_${String(n++).padStart(8, "0")}`,
  featureId: "triage",
  modelId: "android:nano-v4",
  platform: "android",
  policyVersion: 3,
  mode: "PREFER_ON_DEVICE",
  backend: "ON_DEVICE",
  validation: "pass",
  escalated: false,
  latencyMs: 800,
  ts: 5 * HOUR_MS + 1000,
  ...o,
});
const many = (k: number, o: Partial<TelemetryEvent> = {}) => Array.from({ length: k }, () => ev(o));

describe("aggregate", () => {
  it("rolls events up per feature, model and hour", () => {
    const events = [
      ...many(8),
      ev({ backend: "IN_CLOUD", escalated: true, validation: "fail", latencyMs: 2400 }),
      ev({ errorCode: "BUSY", backend: "UNKNOWN", validation: "skipped" }),
      ev({ errorCode: "GUARDRAIL", validation: "skipped" }),
      ev({ ts: 6 * HOUR_MS + 5, policyVersion: 4 }),
      ev({ modelId: "chrome:158", platform: "chrome", mode: "ONLY_IN_CLOUD", backend: "IN_CLOUD" }),
    ];
    const aggs = aggregate(events);
    expect(aggs.map((a) => aggId(a.featureId, a.modelId, a.hour))).toEqual([
      `triage__android_nano-v4__${5 * HOUR_MS}`,
      `triage__chrome_158__${5 * HOUR_MS}`,
      `triage__android_nano-v4__${6 * HOUR_MS}`,
    ]);
    const a = aggs[0]!;
    expect(a).toMatchObject({ calls: 11, onDevice: 9, inCloud: 1, deviceAttempts: 11, escalations: 1, errors: 1, errorCodes: { BUSY: 1, GUARDRAIL: 1 } });
    expect(a.validation).toEqual({ pass: 8, fail: 1, skipped: 2 });
    expect(a.p50LatencyMs).toBe(800);
    expect(a.p95LatencyMs).toBe(2400);
    expect(aggs[1]).toMatchObject({ deviceAttempts: 0, onDevice: 0, deviceP95LatencyMs: null });
    expect(aggs[2]!.policyVersions).toEqual([4]);
    expect(aggregate([])).toEqual([]);
  });
});

describe("autoRollback", () => {
  it("resolves rule keys exactly, then by platform wildcard", () => {
    expect(ruleKeyFor(policy, "android:nano-v4")).toBe("android:nano-v4");
    expect(ruleKeyFor(policy, "android:nano-v5")).toBe("android:*");
    expect(ruleKeyFor(policy, "ios:26.1")).toBeUndefined();
  });

  it("counts only on-device attempts served under the live version", () => {
    const w = windowStats(policy, [
      ...many(5),
      ev({ escalated: true }),
      ev({ errorCode: "BUSY" }),
      ev({ errorCode: "GUARDRAIL" }),
      ev({ policyVersion: 2, escalated: true }),
      ev({ mode: "ONLY_IN_CLOUD" }),
      ev({ featureId: "reply" }),
      ev({ modelId: "chrome:158" }),
    ]);
    expect([...w.keys()]).toEqual(["android:nano-v4"]);
    expect(w.get("android:nano-v4")).toEqual({ attempts: 8, escalations: 1, errors: 1 });
  });

  it("leaves healthy or quiet rules alone and demotes a rule whose escalations are confidently high", () => {
    expect(demotions(policy, many(10, { escalated: true }))).toEqual([]);
    expect(demotions(policy, many(60))).toEqual([]);
    const d = demotions(policy, [...many(30), ...many(20, { escalated: true, backend: "IN_CLOUD" })]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ target: "android:nano-v4", decision: { demote: true, metric: "escalation_rate" }, window: { attempts: 50, escalations: 20 } });
  });

  it("writes the next version with the rule in the cloud and stays a valid policy", () => {
    const next = demotedPolicy(policy, ["android:nano-v4", "missing"], new Date("2026-11-27T00:00:00Z"));
    expect(next.version).toBe(4);
    expect(next.rules["android:nano-v4"]).toMatchObject({ mode: "ONLY_IN_CLOUD", variantId: "v1", reason: "AUTO_ROLLBACK", evidence: { n: 120 } });
    expect(next.rules["chrome:158"]).toEqual(policy.rules["chrome:158"]);
    expect(Object.keys(next.variants)).toEqual(["v1"]);
    expect(parsePolicy(JSON.stringify(next), "triage").ok).toBe(true);
    const bare = demotedPolicy({ ...policy, rules: { "android:nano-v4": { mode: "PREFER_ON_DEVICE", variantId: "v1", reason: "PASSED" } } }, ["android:nano-v4"], new Date(0));
    expect(bare.rules["android:nano-v4"]).toEqual({ mode: "ONLY_IN_CLOUD", variantId: "v1", reason: "AUTO_ROLLBACK" });
  });
});
