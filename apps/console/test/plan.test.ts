import { describe, expect, it, vi } from "vitest";
import { isModelId, validateOutput, type Job } from "@tandem/core";
import type { InferenceBackend, InferenceRequest } from "@tandem/runtime";
import {
  cellKey,
  evidenceOf,
  jobId,
  matrix,
  MAX_JOBS_PER_RUN,
  orderTargets,
  planJobs,
  progressOf,
} from "../src/data/plan.js";
import { counterDemo } from "../src/data/seed.js";
import { Judge, JUDGE_SCHEMA, judgePrompt, parseJudge, type JudgeCache } from "../src/judge.js";

describe("planJobs", () => {
  const cases = [
    { id: "c1", split: "train" as const },
    { id: "c2", split: "holdout" as const },
  ];
  const plan = { runId: "r1", featureId: "triage", variantIds: ["v1"], targets: ["chrome:158", "cloud:gemini-3.5-flash-lite"] as const, samples: 2, cases };

  it("expands case × variant × target × sample, sample-major, with stable ids", () => {
    const jobs = planJobs({ ...plan, targets: [...plan.targets] });
    expect(jobs).toHaveLength(8);
    expect(jobs.slice(0, 4).every((j) => j.sample === 0)).toBe(true);
    expect(jobs[0]).toMatchObject({ id: jobId("c1", "v1", "chrome:158", 0), state: "queued", attempt: 0, split: "train" });
    expect(new Set(jobs.map((j) => j.id)).size).toBe(8);
    expect(jobs.every((j) => !j.id.includes("/"))).toBe(true);
  });

  it("rejects empty or oversized plans", () => {
    const p = { ...plan, targets: [...plan.targets] };
    expect(() => planJobs({ ...p, samples: 0 })).toThrow(RangeError);
    expect(() => planJobs({ ...p, targets: [] })).toThrow(/target/);
    expect(() => planJobs({ ...p, variantIds: [] })).toThrow(/variant/);
    expect(() => planJobs({ ...p, samples: MAX_JOBS_PER_RUN })).toThrow(/limit/);
  });
});

describe("progress, evidence and matrix", () => {
  const done = (caseId: string, target: Job["target"], verdict: Job["verdict"], sample = 0, latencyMs = 900): Job => ({
    id: jobId(caseId, "v1", target, sample),
    runId: "r1",
    caseId,
    variantId: "v1",
    target,
    split: "train",
    sample,
    state: "done",
    attempt: 1,
    verdict,
    result: { backend: "ON_DEVICE", latencyMs, modelId: target, inputChars: 10 },
  });
  const jobs: Job[] = [
    done("c1", "chrome:158", "pass"),
    done("c1", "chrome:158", "fail", 1),
    done("c2", "chrome:158", "pending_judge"),
    done("c1", "cloud:gemini-3.5-flash-lite", "pass"),
    { ...done("c2", "cloud:gemini-3.5-flash-lite", undefined), state: "queued", verdict: undefined },
    { ...done("c3", "chrome:158", undefined), state: "failed", verdict: undefined },
  ];

  it("counts states and judge backlog", () => {
    expect(progressOf(jobs)).toEqual({ total: 6, queued: 1, leased: 0, done: 4, failed: 1, pendingJudge: 1 });
  });

  it("aggregates only decided samples into evidence", () => {
    const ev = evidenceOf(jobs);
    const chrome = ev.find((e) => e.target === "chrome:158")!;
    expect(chrome).toMatchObject({ n: 2, passes: 1, pending: 1 });
    expect(evidenceOf(jobs, "holdout")).toEqual([]);
  });

  it("builds matrix cells per case/variant/target", () => {
    const m = matrix(jobs);
    const cell = m.get(cellKey("c1", "v1", "chrome:158"))!;
    expect(cell).toMatchObject({ passes: 1, decided: 2 });
    expect(cell.jobs.map((j) => j.sample)).toEqual([0, 1]);
    expect(m.get(cellKey("c2", "v1", "chrome:158"))!.decided).toBe(0);
  });

  it("orders device targets before the cloud reference", () => {
    expect(orderTargets(["cloud:a", "chrome:158", "android:nano", "chrome:158"])).toEqual([
      "android:nano",
      "chrome:158",
      "cloud:a",
    ]);
  });
});

describe("Counter demo seed", () => {
  it("is well-formed: valid hashes, templates with {{input}}, asserts on schema fields, both splits", async () => {
    const seed = await counterDemo();
    expect(seed.map((s) => s.feature.id)).toEqual(["triage", "reply"]);
    for (const { feature, variants, cases } of seed) {
      expect(variants[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(variants[0]!.promptTemplate).toContain("{{input}}");
      expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
      const splits = new Set(cases.map((c) => c.split));
      expect(splits).toEqual(new Set(["train", "holdout"]));
      for (const c of cases)
        for (const a of c.asserts) expect(Object.keys(feature.outputSchema.properties ?? {})).toContain(a.path);
    }
    expect(seed[0]!.cases.length).toBeGreaterThanOrEqual(40);
    expect(seed[1]!.cases.every((c) => c.rubric)).toBe(true);
    expect(isModelId(`cloud:${seed[0]!.feature.cloudModel}`)).toBe(true);
  });
});

describe("Judge", () => {
  const feature = { id: "reply", name: "Reply draft", description: "Draft a reply." };
  const testCase = { id: "r001", input: { text: "Where is CT-1?" }, rubric: "Mentions CT-1." };
  const store = (): JudgeCache & { m: Map<string, unknown> } => {
    const m = new Map<string, unknown>();
    return {
      m,
      get: async (k) => m.get(k) as never,
      put: async (k, v) => void m.set(k, v),
    };
  };

  it("validates the judge schema strictly", () => {
    expect(parseJudge('{"pass":true,"score":0.91234,"reason":"ok"}')).toEqual({ pass: true, score: 0.912, reason: "ok" });
    expect(parseJudge('{"pass":"yes","score":1,"reason":"ok"}')).toBeUndefined();
    expect(parseJudge("not json")).toBeUndefined();
    expect(validateOutput(JUDGE_SCHEMA, { pass: true, score: 2, reason: "x" })).not.toEqual([]);
  });

  it("puts input, output and rubric in the prompt", () => {
    const p = judgePrompt(feature, testCase, { reply: "CT-1 is on its way" });
    expect(p).toContain("Where is CT-1?");
    expect(p).toContain('{"reply":"CT-1 is on its way"}');
    expect(p).toContain("Mentions CT-1.");
    expect(judgePrompt({ name: "X" }, { input: { text: "a" } }, "raw")).toContain("raw");
  });

  it("calls the cloud judge once per identical output and caches the verdict", async () => {
    const generate = vi.fn(async (_req: InferenceRequest) => ({ text: '{"pass":true,"score":0.9,"reason":"Mentions CT-1."}', backend: "IN_CLOUD" as const }));
    const backend: InferenceBackend = { availability: async () => "unavailable", generate };
    const cache = store();
    const judge = new Judge(backend, cache, () => "gemini-3.8-flash");
    const a = await judge.judge({ feature, variantId: "v1", testCase, output: { reply: "x", n: 1 } });
    const b = await judge.judge({ feature, variantId: "v1", testCase, output: { n: 1, reply: "x" } });
    expect(a).toMatchObject({ pass: true, model: "gemini-3.8-flash" });
    expect(a.cacheKey).toMatch(/^[a-f0-9]{64}$/);
    expect(b.cacheKey).toBe(a.cacheKey);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toMatchObject({ target: "cloud", cloudModel: "gemini-3.8-flash", outputKind: "json" });
    expect([judge.calls, judge.hits]).toEqual([1, 1]);
  });

  it("rejects malformed judge output and tolerates a broken cache", async () => {
    const backend: InferenceBackend = {
      availability: async () => "unavailable",
      generate: async () => ({ text: "PASS", backend: "IN_CLOUD" }),
    };
    const broken: JudgeCache = { get: () => Promise.reject(new Error("x")), put: () => Promise.reject(new Error("x")) };
    await expect(new Judge(backend, broken, () => "m").judge({ feature, variantId: "v1", testCase, output: "x" })).rejects.toThrow(/malformed/);
    const ok: InferenceBackend = { ...backend, generate: async () => ({ text: '{"pass":false,"score":0.2,"reason":"no"}', backend: "IN_CLOUD" }) };
    expect((await new Judge(ok, broken, () => "m").judge({ feature, variantId: "v1", testCase, output: "x" })).pass).toBe(false);
  });
});
