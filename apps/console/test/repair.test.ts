import { describe, expect, it } from "vitest";
import type { Case, Job, ModelId, Verdict } from "@tandem/core";
import type { InferenceBackend } from "@tandem/runtime";
import { counterDemo } from "../src/data/seed.js";
import { gateRun, nextVariantId, parseProposal, proposeRepair, repairPrompt, trainFailures } from "../src/repair.js";

const seed = await counterDemo();
const triage = seed[0]!;
const cases = new Map<string, Case>(triage.cases.map((c) => [c.id, c]));
const trainCase = triage.cases.find((c) => c.split === "train")!;
const holdoutCase = triage.cases.find((c) => c.split === "holdout")!;

const job = (caseId: string, variantId: string, target: ModelId, verdict: Verdict, split: "train" | "holdout", sample = 0): Job => ({
  id: `${caseId}-${variantId}-${target}-${sample}`,
  runId: "r",
  caseId,
  variantId,
  target,
  split,
  sample,
  state: "done",
  attempt: 1,
  verdict,
  result: { backend: "ON_DEVICE", latencyMs: 900, modelId: target, inputChars: 10, outputText: '{"language":"other"}' },
  checks: [{ id: "assert:2:equals", pass: verdict === "pass", detail: 'expected "en", got "other"' }],
});

describe("trainFailures", () => {
  it("shows only train failures of the variant on the target — never holdout", () => {
    const jobs = [
      job(trainCase.id, "v1", "chrome:158", "fail", "train"),
      job(holdoutCase.id, "v1", "chrome:158", "fail", "holdout"),
      job(trainCase.id, "v1", "chrome:158", "pass", "train", 1),
      job(trainCase.id, "v1", "cloud:m", "fail", "train"),
    ];
    const f = trainFailures(jobs, cases, "v1", "chrome:158");
    expect(f).toHaveLength(1);
    expect(f[0]!.input).toBe(trainCase.input.text);
    expect(f[0]!.failed[0]).toContain('expected "en"');
    expect(repairPrompt(triage.feature, triage.variants[0]!, "chrome:158", f)).not.toContain(holdoutCase.input.text);
  });
});

describe("proposals", () => {
  const good = JSON.stringify({ systemInstruction: "Answer JSON only, always.", promptTemplate: "Rules...\nMessage:\n{{input}}", rationale: "Defines language codes." });
  it("accepts only schema-valid proposals with exactly one {{input}}", () => {
    expect(parseProposal(good)?.rationale).toBe("Defines language codes.");
    expect(parseProposal(good.replace("{{input}}", "nothing here"))).toBeUndefined();
    expect(parseProposal(JSON.stringify({ systemInstruction: "x" }))).toBeUndefined();
    expect(parseProposal("{{input}} {{input}}")).toBeUndefined();
  });

  it("returns an immutable repair variant pinned to its target", async () => {
    const backend: InferenceBackend = { availability: async () => "unavailable", generate: async () => ({ text: good, backend: "IN_CLOUD" }) };
    const v = await proposeRepair({ backend, model: "gemini-4-hydrogen", feature: triage.feature, parent: triage.variants[0]!, target: "chrome:158", failures: [{ input: "x", failed: ["a"] }], existingIds: ["v1", "v3"] });
    expect(v).toMatchObject({ id: "v4", origin: "repair", parentId: "v1", targetModelId: "chrome:158", featureId: "triage" });
    expect(v.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(proposeRepair({ backend, model: "m", feature: triage.feature, parent: triage.variants[0]!, target: "chrome:158", failures: [], existingIds: [] })).rejects.toThrow(/no train failures/);
    const bad: InferenceBackend = { ...backend, generate: async () => ({ text: "sure", backend: "IN_CLOUD" }) };
    await expect(proposeRepair({ backend: bad, model: "m", feature: triage.feature, parent: triage.variants[0]!, target: "chrome:158", failures: [{ input: "x", failed: [] }], existingIds: [] })).rejects.toThrow(/unusable/);
    expect(nextVariantId([])).toBe("v1");
  });
});

describe("gateRun", () => {
  const many = (variantId: string, target: ModelId, split: "train" | "holdout", n: number, passes: number) =>
    Array.from({ length: n }, (_, i) => job(`${split}${i}`, variantId, target, i < passes ? "pass" : "fail", split));

  it("accepts a candidate that passes train, holdout and regression", () => {
    const jobs = [
      ...many("v1", "chrome:158", "train", 40, 12),
      ...many("v2", "chrome:158", "train", 40, 40),
      ...many("v2", "chrome:158", "holdout", 20, 20),
      ...many("v1", "cloud:m", "train", 40, 38),
      ...many("v2", "cloud:m", "train", 40, 39),
    ];
    const [r] = gateRun(jobs, "v1", undefined);
    expect(r).toMatchObject({ candidate: "v2", target: "chrome:158" });
    expect(r!.evaluation.accepted).toBe(true);
    expect(r!.evaluation.gates.map((g) => g.gate)).toEqual(["train", "holdout", "regression"]);
  });

  it("stops at the first failing gate", () => {
    const weak = gateRun([...many("v2", "chrome:158", "train", 40, 30), ...many("v1", "chrome:158", "train", 40, 10)], "v1", undefined);
    expect(weak[0]!.evaluation).toMatchObject({ accepted: false, failedAt: "train" });
    const noHoldout = gateRun(many("v2", "chrome:158", "train", 40, 40), "v1", undefined);
    expect(noHoldout[0]!.evaluation.failedAt).toBe("holdout");
    const regress = gateRun(
      [
        ...many("v2", "chrome:158", "train", 40, 40),
        ...many("v2", "chrome:158", "holdout", 20, 20),
        ...many("v1", "android:nano", "train", 40, 40),
        ...many("v2", "android:nano", "train", 40, 20),
      ],
      "v1",
      { rules: { "android:nano": { mode: "PREFER_ON_DEVICE" } } } as never,
    );
    const chrome = regress.find((r) => r.target === "chrome:158")!;
    expect(chrome.evaluation.failedAt).toBe("regression");
  });
});

describe("edge cases", () => {
  it("handles failures without output or checks, missing cases and pending samples", () => {
    const bare: Job = { ...job(trainCase.id, "v1", "chrome:158", "error", "train"), result: { backend: "UNKNOWN", latencyMs: 0, modelId: "chrome:158", inputChars: 1, errorCode: "BUSY" }, checks: undefined };
    const jobs = [
      bare,
      job("gone", "v1", "chrome:158", "fail", "train"),
      job(trainCase.id, "v1", "chrome:158", "pending_judge", "train", 2),
      { ...job(trainCase.id, "v1", "chrome:158", "fail", "train", 3), state: "leased" as const },
    ];
    const f = trainFailures(jobs, cases, "v1", "chrome:158");
    expect(f).toEqual([{ input: trainCase.input.text, failed: [] }]);
    const p = repairPrompt({ ...triage.feature, description: undefined }, triage.variants[0]!, "chrome:158", [{ input: "x", failed: [] }]);
    expect(p).toContain("output: (none)");
    expect(p).toContain("failed: unknown");
  });

  it("gates a candidate with no measurements as a train failure", () => {
    const r = gateRun([job("a", "v2", "cloud:m", "pass", "train"), job("a", "v1", "chrome:158", "pass", "train")], "v1", undefined);
    expect(r).toEqual([expect.objectContaining({ candidate: "v2", target: "chrome:158", train: undefined })]);
    expect(r[0]!.evaluation.failedAt).toBe("train");
  });
});
