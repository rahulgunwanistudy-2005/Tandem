import { describe, expect, it, vi } from "vitest";
import type { Backend, Case, Feature, ModelId } from "@tandem/core";
import type { DeviceAvailability, InferenceBackend, InferenceRequest } from "@tandem/runtime";
import { executeJob } from "../src/runner/execute.js";
import { RunnerLoop, type JobQueue, type QueuedJob, type RunnerEvent } from "../src/runner/loop.js";
import { counterDemo } from "../src/data/seed.js";

const seed = await counterDemo();
const triage = seed[0]!;
const feature: Feature = triage.feature;
const variant = triage.variants[0]!;
const kase: Case = triage.cases.find((c) => c.id === "t001")!;
const GOOD = '{"intent":"damaged_item","urgency":"high","orderId":"CT-48213","language":"en"}';

type Step = { text: string; backend: Backend } | Error;

class FakeBackend implements InferenceBackend {
  calls: InferenceRequest[] = [];
  constructor(
    public steps: Step[],
    public avail: DeviceAvailability | Error = "available",
  ) {}
  async availability() {
    if (this.avail instanceof Error) throw this.avail;
    return this.avail;
  }
  async generate(req: InferenceRequest) {
    this.calls.push(req);
    const s = this.steps.shift();
    if (!s) throw new Error("unscripted");
    if (s instanceof Error) throw s;
    return s;
  }
}

let t = 0;
const clock = () => (t += 500);
const exec = (target: ModelId, b: FakeBackend, extra: Partial<Parameters<typeof executeJob>[0]> = {}) =>
  executeJob({ target, feature, variant, testCase: kase, backend: b, clock, sleep: async () => {}, rand: () => 0, ...extra });

describe("executeJob", () => {
  it("passes a correct on-device answer and pins the call to the device", async () => {
    const b = new FakeBackend([{ text: GOOD, backend: "ON_DEVICE" }]);
    const e = await exec("chrome:158", b);
    expect(e.verdict).toBe("pass");
    expect(e.result).toMatchObject({ backend: "ON_DEVICE", modelId: "chrome:158", latencyMs: 500 });
    expect(b.calls[0]).toMatchObject({ target: "device", cloudModel: "gemini-3.5-flash-lite" });
    expect(b.calls[0]!.prompt).toContain("CT-48213");
    expect(b.calls[0]!.prompt).not.toContain("{{input}}");
    expect(e.parsed).toEqual(JSON.parse(GOOD));
  });

  it("never passes a correct answer that came from the cloud on a device job", async () => {
    const e = await exec("chrome:158", new FakeBackend([{ text: GOOD, backend: "IN_CLOUD" }]));
    expect(e.verdict).toBe("integrity_fail");
    expect(e.result.outputText).toBe(GOOD);
    const u = await exec("chrome:158", new FakeBackend([{ text: GOOD, backend: "UNKNOWN" }]));
    expect(u.verdict).toBe("integrity_fail");
  });

  it("runs the cloud reference on the target's model", async () => {
    const b = new FakeBackend([{ text: GOOD, backend: "IN_CLOUD" }], "unavailable");
    const e = await exec("cloud:gemini-3.8-flash", b);
    expect(e.verdict).toBe("pass");
    expect(b.calls[0]).toMatchObject({ target: "cloud", cloudModel: "gemini-3.8-flash" });
  });

  it.each<[DeviceAvailability | Error, string]>([
    ["downloadable", "MODEL_UNAVAILABLE"],
    ["unavailable", "MODEL_UNAVAILABLE"],
    ["downloading", "MODEL_DOWNLOADING"],
    [new Error("boom"), "MODEL_UNAVAILABLE"],
  ])("does not call an unready device (%s) and reports an error, not an integrity failure", async (a, code) => {
    const b = new FakeBackend([], a);
    const e = await exec("chrome:158", b);
    expect(b.calls).toHaveLength(0);
    expect(e.verdict).toBe("error");
    expect(e.result.errorCode).toBe(code);
  });

  it("refuses inputs over the on-device token budget before calling", async () => {
    const b = new FakeBackend([]);
    const long = { ...kase, input: { text: "word ".repeat(9000) } };
    const e = await executeJob({ target: "chrome:158", feature, variant, testCase: long, backend: b, clock });
    expect(b.calls).toHaveLength(0);
    expect(e.result.errorCode).toBe("INPUT_TOO_LONG");
  });

  it("retries BUSY with backoff, then reports the error", async () => {
    const sleep = vi.fn(async () => {});
    const busy = () => new Error("The device is busy, too many requests");
    const ok = await exec("chrome:158", new FakeBackend([busy(), { text: GOOD, backend: "ON_DEVICE" }]), { sleep });
    expect(ok.verdict).toBe("pass");
    expect(sleep).toHaveBeenCalledTimes(1);
    const no = await exec("chrome:158", new FakeBackend([busy(), busy(), busy()]), { sleep });
    expect(no.result).toMatchObject({ errorCode: "BUSY", backend: "UNKNOWN" });
    expect(no.result.errorMessage).toContain("busy");
    const other = await exec("chrome:158", new FakeBackend([new Error("weird failure")]));
    expect(other.result.errorCode).toBe("UNKNOWN");
  });

  it("grades parse, schema and assertion failures", async () => {
    const bad = await exec("chrome:158", new FakeBackend([{ text: GOOD.replace("damaged_item", "billing"), backend: "ON_DEVICE" }]));
    expect(bad.verdict).toBe("fail");
    expect(bad.checks.find((c) => !c.pass)?.id).toMatch(/^assert:/);
    const junk = await exec("chrome:158", new FakeBackend([{ text: "sure! here you go", backend: "ON_DEVICE" }]));
    expect(junk.checks.at(-1)?.id).toBe("parse");
  });
});

class MemQueue implements JobQueue {
  claimed: string[] = [];
  completed: { path: string; verdict: string }[] = [];
  beats = 0;
  constructor(
    public jobs: QueuedJob[],
    public failClaim = false,
    public failComplete = false,
  ) {}
  async next(accept: (t: ModelId) => boolean) {
    return this.jobs.find((j) => accept(j.job.target) && !this.claimed.includes(j.path));
  }
  async claim(q: QueuedJob) {
    if (this.failClaim) return false;
    this.claimed.push(q.path);
    return true;
  }
  async heartbeat() {
    this.beats++;
  }
  async complete(q: QueuedJob, e: { verdict: string }) {
    if (this.failComplete) throw new Error("lease lost");
    this.completed.push({ path: q.path, verdict: e.verdict });
  }
}

const qj = (target: ModelId, id: string = target): QueuedJob => ({
  path: `runs/r1/jobs/${id}`,
  featureId: "triage",
  job: { id, runId: "r1", caseId: "t001", variantId: "v1", target, attempt: 0 },
});
const catalog = { load: async () => ({ feature, variant, testCase: kase }) };

describe("RunnerLoop", () => {
  it("claims only accepted targets, runs, completes and reports", async () => {
    const q = new MemQueue([qj("cloud:gemini-3.5-flash-lite"), qj("chrome:158")]);
    const events: RunnerEvent["type"][] = [];
    const loop = new RunnerLoop({
      owner: "u1",
      accept: (t) => t === "chrome:158",
      queue: q,
      catalog,
      backend: new FakeBackend([{ text: GOOD, backend: "ON_DEVICE" }]),
      onEvent: (e) => {
        events.push(e.type);
        throw new Error("listener bugs are ignored");
      },
    });
    expect(await loop.tick()).toBe(true);
    expect(q.completed).toEqual([{ path: "runs/r1/jobs/chrome:158", verdict: "pass" }]);
    expect(events).toEqual(["claimed", "done"]);
    expect(await loop.tick()).toBe(false);
  });

  it("heartbeats while a slow job runs", async () => {
    vi.useFakeTimers();
    const q = new MemQueue([qj("chrome:158")]);
    const loop = new RunnerLoop({
      owner: "u1",
      accept: () => true,
      queue: q,
      catalog,
      backend: new FakeBackend([]),
      heartbeatMs: 1000,
      execute: () => new Promise((r) => setTimeout(() => r({ result: { backend: "ON_DEVICE", latencyMs: 1, modelId: "chrome:158", inputChars: 1 }, checks: [], verdict: "pass" }), 3500)),
    });
    const p = loop.tick();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toBe(true);
    expect(q.beats).toBe(3);
    vi.useRealTimers();
  });

  it("survives lost claims, lost leases and broken catalogs", async () => {
    const events: RunnerEvent[] = [];
    const base = { owner: "u1", accept: () => true, catalog, onEvent: (e: RunnerEvent) => events.push(e) };
    const lost = new RunnerLoop({ ...base, queue: new MemQueue([qj("chrome:158")], true), backend: new FakeBackend([]) });
    expect(await lost.tick()).toBe(false);

    const expired = new MemQueue([qj("chrome:158")], false, true);
    await new RunnerLoop({ ...base, queue: expired, backend: new FakeBackend([{ text: GOOD, backend: "ON_DEVICE" }]) }).tick();
    expect(events.map((e) => e.type)).toEqual(["claimed", "lost", "error"]);

    events.length = 0;
    const broken = new RunnerLoop({
      ...base,
      queue: new MemQueue([qj("chrome:158")]),
      catalog: { load: async () => Promise.reject(new Error("case deleted")) },
      backend: new FakeBackend([]),
    });
    expect(await broken.tick()).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["claimed", "error"]);

    events.length = 0;
    const flaky = new MemQueue([]);
    flaky.next = () => Promise.reject(new Error("offline"));
    expect(await new RunnerLoop({ ...base, queue: flaky, backend: new FakeBackend([]) }).tick()).toBe(false);
    expect(events[0]?.type).toBe("error");
  });

  it("starts, idles and stops cleanly", async () => {
    const q = new MemQueue([qj("chrome:158"), qj("chrome:158", "second")]);
    const sleeps: number[] = [];
    const loop = new RunnerLoop({
      owner: "u1",
      accept: () => true,
      queue: q,
      catalog,
      backend: new FakeBackend([
        { text: GOOD, backend: "ON_DEVICE" },
        { text: GOOD, backend: "ON_DEVICE" },
      ]),
      idleMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
        await loop.stop();
      },
    });
    loop.start();
    loop.start(); // idempotent
    expect(loop.active).toBe(true);
    await vi.waitFor(() => expect(q.completed).toHaveLength(2));
    await vi.waitFor(() => expect(loop.active).toBe(false));
    expect(sleeps).toEqual([5]);
    expect(loop.leaseMs).toBe(60_000);
  });
});

describe("defaults", () => {
  it("uses the real clock, timer and jitter when none are injected", async () => {
    const b = new FakeBackend([new Error("device busy"), { text: GOOD, backend: "ON_DEVICE" }]);
    const e = await executeJob({ target: "chrome:158", feature, variant, testCase: kase, backend: b, rand: () => 0.01 });
    expect(e.verdict).toBe("pass");
    expect(e.result.latencyMs).toBeGreaterThanOrEqual(0);
    const loop = new RunnerLoop({ owner: "u", accept: () => true, queue: new MemQueue([]), catalog, backend: b, idleMs: 1 });
    loop.start();
    await new Promise((r) => setTimeout(r, 5));
    await loop.stop();
    expect(loop.active).toBe(false);
  });
});
