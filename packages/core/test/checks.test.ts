import { describe, expect, it } from "vitest";
import { needsJudge, runDeterministicChecks, verdictFor } from "../src/checks.js";
import type { Feature, JobResult } from "../src/contracts.js";

const feature: Pick<Feature, "outputKind" | "outputSchema" | "latencyBudgetMs"> = {
  outputKind: "json",
  latencyBudgetMs: 3000,
  outputSchema: {
    type: "object",
    properties: { intent: { type: "string", enum: ["billing", "other"] } },
    required: ["intent"],
  },
};
const kase = { asserts: [{ kind: "equals" as const, path: "intent", value: "billing" }] };
const ok: JobResult = { outputText: '{"intent":"billing"}', backend: "ON_DEVICE", latencyMs: 900, modelId: "android:nano-v4", inputChars: 100 };

describe("runDeterministicChecks", () => {
  it("passes a correct on-device answer", () => {
    const d = runDeterministicChecks(feature, kase, "android:nano-v4", ok);
    expect(d.pass).toBe(true);
    expect(d.checks.map((c) => c.id)).toEqual(["integrity", "parse", "schema", "assert:0:equals", "latency"]);
    expect(d.parsed).toEqual({ intent: "billing" });
  });

  it("rejects a cloud answer on a device target as an integrity failure, even if correct", () => {
    const d = runDeterministicChecks(feature, kase, "chrome:158", { ...ok, backend: "IN_CLOUD" });
    expect(d).toMatchObject({ pass: false, integrityFailure: true });
    expect(d.checks).toEqual([{ id: "integrity", pass: false, detail: "device job answered by IN_CLOUD" }]);
  });

  it("treats an UNKNOWN backend on a device target as an integrity failure", () => {
    expect(runDeterministicChecks(feature, kase, "ios:26.1", { ...ok, backend: "UNKNOWN" }).integrityFailure).toBe(true);
  });

  it("does not run integrity on the cloud reference", () => {
    const d = runDeterministicChecks(feature, kase, "cloud:gemini-3.5-flash-lite", { ...ok, backend: "IN_CLOUD" });
    expect(d.pass).toBe(true);
    expect(d.checks[0]?.id).toBe("parse");
  });

  it("stops at runner errors and missing output", () => {
    const e = runDeterministicChecks(feature, kase, "android:nano-v4", { ...ok, errorCode: "BUSY", errorMessage: "AICore busy" });
    expect(e.checks.at(-1)).toEqual({ id: "error", pass: false, detail: "BUSY: AICore busy" });
    const ie = runDeterministicChecks(feature, kase, "android:nano-v4", { ...ok, errorCode: "INTEGRITY_CLOUD_ANSWER" });
    expect(ie.integrityFailure).toBe(true);
    const { outputText: _drop, ...noText } = ok;
    expect(runDeterministicChecks(feature, kase, "android:nano-v4", noText).checks.at(-1)?.detail).toBe("no output");
  });

  it("fails on parse, schema, assert and latency", () => {
    expect(runDeterministicChecks(feature, kase, "android:nano-v4", { ...ok, outputText: "nope" }).checks.at(-1)?.id).toBe("parse");
    const schema = runDeterministicChecks(feature, kase, "android:nano-v4", { ...ok, outputText: '{"intent":"refund"}' });
    expect(schema.checks.find((c) => c.id === "schema")?.pass).toBe(false);
    expect(schema.pass).toBe(false);
    const slow = runDeterministicChecks(feature, kase, "android:nano-v4", { ...ok, latencyMs: 3001 });
    expect(slow.checks.at(-1)).toMatchObject({ id: "latency", pass: false });
    expect(runDeterministicChecks(feature, kase, "android:nano-v4", { ...ok, latencyMs: 3000 }).pass).toBe(true);
  });

  it("skips schema checks for text features", () => {
    const d = runDeterministicChecks({ ...feature, outputKind: "text" }, { asserts: [] }, "android:nano-v4", { ...ok, outputText: "Hello" });
    expect(d.checks.map((c) => c.id)).toEqual(["integrity", "parse", "latency"]);
  });
});

describe("verdictFor", () => {
  const det = runDeterministicChecks(feature, kase, "android:nano-v4", ok);
  const judge = { pass: true, score: 0.9, reason: "fine", cacheKey: "a".repeat(64) };
  it("covers every verdict", () => {
    expect(verdictFor(det, {}, undefined, ok)).toBe("pass");
    expect(verdictFor(det, { rubric: "be kind" }, undefined, ok)).toBe("pending_judge");
    expect(verdictFor(det, { rubric: "be kind" }, judge, ok)).toBe("pass");
    expect(verdictFor(det, { rubric: "be kind" }, { ...judge, pass: false }, ok)).toBe("fail");
    expect(verdictFor({ ...det, pass: false }, {}, undefined, ok)).toBe("fail");
    expect(verdictFor({ ...det, integrityFailure: true }, {}, undefined, ok)).toBe("integrity_fail");
    expect(verdictFor({ ...det, pass: false }, {}, undefined, { errorCode: "BUSY" })).toBe("error");
  });
  it("only sends deterministic passes with a non-blank rubric to the judge", () => {
    expect(needsJudge(det, { rubric: "  " })).toBe(false);
    expect(needsJudge({ ...det, pass: false }, { rubric: "x" })).toBe(false);
    expect(needsJudge(det, { rubric: "x" })).toBe(true);
  });
});
