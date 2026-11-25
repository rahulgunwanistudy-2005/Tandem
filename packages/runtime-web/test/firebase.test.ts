import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirebaseApp } from "firebase/app";
import type { Firestore } from "firebase/firestore";
import { GOOD, policyWith } from "./helpers.js";

/**
 * The Firebase SDK is mocked at the module boundary so these tests pin exactly what Tandem asks
 * of it (modes, on-device create options, schemas, Remote Config keys, Firestore paths). The
 * mocked enum values are copied from the installed @firebase/ai 3.1.0 typings.
 */
const sdk = vi.hoisted(() => ({
  models: [] as Array<{
    params: Record<string, unknown>;
    generateContent: ReturnType<typeof vi.fn>;
    initializeDeviceModel: ReturnType<typeof vi.fn>;
  }>,
  nextResponse: {
    text: '{"intent":"other","urgency":"low"}',
    inferenceSource: "on_device" as string | undefined,
  },
  rcValues: {} as Record<string, string>,
  rcObserver: undefined as
    | undefined
    | {
        next: (u: { getUpdatedKeys(): Set<string> }) => void;
        error: (e: unknown) => void;
        complete: () => void;
      },
  fetchAndActivate: vi.fn(async () => true),
  activate: vi.fn(async () => true),
  setCustomSignals: vi.fn(async () => undefined),
  unsubscribe: vi.fn(),
  batches: [] as Array<{
    sets: Array<[string, Record<string, unknown>]>;
    commit: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("firebase/ai", () => ({
  InferenceMode: {
    PREFER_ON_DEVICE: "prefer_on_device",
    ONLY_ON_DEVICE: "only_on_device",
    ONLY_IN_CLOUD: "only_in_cloud",
    PREFER_IN_CLOUD: "prefer_in_cloud",
  },
  InferenceSource: { ON_DEVICE: "on_device", IN_CLOUD: "in_cloud" },
  GoogleAIBackend: class {},
  getAI: vi.fn(() => ({ kind: "ai" })),
  getGenerativeModel: vi.fn((_ai: unknown, params: Record<string, unknown>) => {
    const m = {
      params,
      generateContent: vi.fn(async () => ({
        response: {
          text: () => sdk.nextResponse.text,
          inferenceSource: sdk.nextResponse.inferenceSource,
        },
      })),
      initializeDeviceModel: vi.fn(async (cb?: (p: number) => void) => cb?.(1)),
    };
    sdk.models.push(m);
    return m;
  }),
}));

vi.mock("firebase/remote-config", () => ({
  getRemoteConfig: vi.fn(() => ({
    settings: { minimumFetchIntervalMillis: 0, fetchTimeoutMillis: 60000 },
  })),
  getValue: vi.fn((_rc: unknown, key: string) => ({ asString: () => sdk.rcValues[key] ?? "" })),
  fetchAndActivate: sdk.fetchAndActivate,
  activate: sdk.activate,
  setCustomSignals: sdk.setCustomSignals,
  onConfigUpdate: vi.fn((_rc: unknown, observer: typeof sdk.rcObserver) => {
    sdk.rcObserver = observer;
    return sdk.unsubscribe;
  }),
}));

vi.mock("firebase/firestore", () => ({
  doc: vi.fn((_db: unknown, ...path: string[]) => path.join("/")),
  Timestamp: { fromMillis: (ms: number) => ({ ms }) },
  writeBatch: vi.fn(() => {
    const b = {
      sets: [] as Array<[string, Record<string, unknown>]>,
      set(ref: string, data: Record<string, unknown>) {
        b.sets.push([ref, data]);
      },
      commit: vi.fn(async () => undefined),
    };
    sdk.batches.push(b);
    return b;
  }),
}));

const {
  createTandem,
  FirebaseAIBackend,
  FirestoreTelemetrySink,
  toBackend,
  cloudGenerationConfig,
  deviceConstraint,
  TELEMETRY_TTL_MS,
} = await import("../src/firebase.js");

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sdk.models.length = 0;
  sdk.batches.length = 0;
  sdk.rcValues = {};
  sdk.nextResponse = { text: GOOD, inferenceSource: "on_device" };
  vi.clearAllMocks();
});

describe("mapping helpers", () => {
  it("maps inferenceSource and never trusts an unlabeled device answer", () => {
    expect(toBackend("on_device", "device")).toBe("ON_DEVICE");
    expect(toBackend("in_cloud", "device")).toBe("IN_CLOUD");
    expect(toBackend(undefined, "device")).toBe("UNKNOWN");
    expect(toBackend(undefined, "cloud")).toBe("IN_CLOUD");
  });

  it("builds cloud generation configs and device constraints per output kind", () => {
    const schema = policyWith("PREFER_ON_DEVICE").outputSchema;
    expect(cloudGenerationConfig("json", schema)).toEqual({
      responseMimeType: "application/json",
      responseSchema: schema,
    });
    expect(cloudGenerationConfig("json", undefined)).toEqual({
      responseMimeType: "application/json",
    });
    expect(cloudGenerationConfig("enum", { type: "string", enum: ["low", "high"] })).toEqual({
      responseMimeType: "text/x.enum",
      responseSchema: { type: "string", format: "enum", enum: ["low", "high"] },
    });
    expect(cloudGenerationConfig("text", undefined)).toBeUndefined();
    expect(deviceConstraint("text", schema)).toBeUndefined();
    expect(deviceConstraint("json", undefined)).toBeUndefined();
    expect(deviceConstraint("enum", { type: "string", enum: ["a"] })).toEqual({
      type: "string",
      enum: ["a"],
    });
    expect(deviceConstraint("enum", { type: "string" })).toEqual({ type: "string" });
    expect(deviceConstraint("json", schema)).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });
});

describe("FirebaseAIBackend", () => {
  const req = {
    systemInstruction: "Classify.",
    prompt: "Ticket: hi",
    outputKind: "json" as const,
    outputSchema: policyWith("PREFER_ON_DEVICE").outputSchema,
    cloudModel: "gemini-3.5-flash-lite",
  };

  it("pins device calls to ONLY_ON_DEVICE with the system prompt on the session", async () => {
    const b = new FirebaseAIBackend({} as never, ["en", "es"]);
    const r = await b.generate({ ...req, target: "device" });
    expect(r).toEqual({ text: GOOD, backend: "ON_DEVICE" });
    const p = sdk.models[0]?.params as {
      mode: string;
      inCloudParams: Record<string, unknown>;
      onDeviceParams: {
        createOptions: Record<string, unknown>;
        promptOptions: { responseConstraint: unknown };
      };
    };
    expect(p.mode).toBe("only_on_device");
    expect(p.inCloudParams).toMatchObject({
      model: "gemini-3.5-flash-lite",
      systemInstruction: "Classify.",
    });
    expect(p.onDeviceParams.createOptions).toEqual({
      expectedInputs: [{ type: "text", languages: ["en", "es"] }],
      expectedOutputs: [{ type: "text", languages: ["en", "es"] }],
      initialPrompts: [{ role: "system", content: [{ type: "text", value: "Classify." }] }],
    });
    expect(p.onDeviceParams.promptOptions.responseConstraint).toMatchObject({
      additionalProperties: false,
    });
    expect(sdk.models[0]?.generateContent).toHaveBeenCalledWith("Ticket: hi");
  });

  it("pins cloud calls to ONLY_IN_CLOUD and caches models per request shape", async () => {
    const b = new FirebaseAIBackend({} as never);
    sdk.nextResponse = { text: GOOD, inferenceSource: "in_cloud" };
    await b.generate({ ...req, target: "cloud" });
    await b.generate({ ...req, target: "cloud", prompt: "other" });
    expect(sdk.models).toHaveLength(1);
    expect(sdk.models[0]?.params.mode).toBe("only_in_cloud");
    const text = {
      ...req,
      outputKind: "text" as const,
      outputSchema: undefined,
      systemInstruction: "",
    };
    await b.generate({ ...text, target: "device" });
    const p = sdk.models[1]?.params as {
      inCloudParams: Record<string, unknown>;
      onDeviceParams: Record<string, unknown>;
    };
    expect(p.inCloudParams).not.toHaveProperty("generationConfig");
    expect(p.onDeviceParams).not.toHaveProperty("promptOptions");
    expect(p.onDeviceParams.createOptions).not.toHaveProperty("initialPrompts");
    for (let i = 0; i < 40; i++)
      await b.generate({ ...req, target: "cloud", systemInstruction: `s${i}` });
    expect(sdk.models.length).toBe(42);
    await b.generate({ ...req, target: "cloud", systemInstruction: "s39" });
    expect(sdk.models.length).toBe(42); // still cached after eviction of the oldest
  });

  it("prepare() starts the download through initializeDeviceModel", async () => {
    const b = new FirebaseAIBackend({} as never);
    const progress = vi.fn();
    await b.prepare(progress);
    expect(sdk.models[0]?.params.mode).toBe("prefer_on_device");
    expect(progress).toHaveBeenCalledWith(1);
    expect(await b.availability()).toBe("unavailable"); // no Prompt API in Node
  });
});

describe("FirestoreTelemetrySink", () => {
  it("writes each event under the project's telemetry_raw with a 7-day expiry", async () => {
    const sink = new FirestoreTelemetrySink({} as Firestore, "p1");
    const e = { eventId: "evt_00000001", ts: 1000 } as never;
    await sink.write([e]);
    expect(sdk.batches[0]?.sets).toEqual([
      [
        "projects/p1/telemetry_raw/evt_00000001",
        { eventId: "evt_00000001", ts: 1000, expireAt: { ms: 1000 + TELEMETRY_TTL_MS } },
      ],
    ]);
    expect(sdk.batches[0]?.commit).toHaveBeenCalledOnce();
  });
});

describe("createTandem", () => {
  const app = {} as FirebaseApp;

  it("loads policies from Remote Config, routes, generates and records telemetry", async () => {
    sdk.rcValues = { tandem_policy_triage: JSON.stringify(policyWith("PREFER_ON_DEVICE")) };
    const t = createTandem({
      app,
      features: ["triage"],
      modelId: "chrome:158",
      telemetry: { firestore: {} as Firestore, projectId: "p1", maxBatch: 1 },
    });
    await t.ready;
    expect(sdk.setCustomSignals).toHaveBeenCalledWith(expect.anything(), {
      tandem_model_id: "chrome:158",
    });
    expect(t.policies.get("triage")?.version).toBe(4);
    expect(t.route("triage").order).toEqual(["device", "cloud"]);
    expect(t.modelId).toBe("chrome:158");
    // Node has no Prompt API → device unavailable → verified escalation to cloud
    sdk.nextResponse = { text: GOOD, inferenceSource: "in_cloud" };
    const r = await t.generate<{ intent: string }>("triage", "where is it");
    expect(r).toMatchObject({
      backend: "IN_CLOUD",
      escalated: true,
      escalationReason: "MODEL_UNAVAILABLE",
    });
    expect(r.value.intent).toBe("other");
    await t.flushTelemetry();
    expect(sdk.batches.flatMap((b) => b.sets.map((s) => s[0]))).toHaveLength(1);
    expect(await t.deviceAvailability()).toBe("unavailable");
    await t.prepareDevice();
    t.dispose();
    expect(sdk.unsubscribe).toHaveBeenCalledOnce();
  });

  it("applies real-time Remote Config updates and survives offline startup", async () => {
    sdk.fetchAndActivate.mockRejectedValueOnce(new Error("offline"));
    const onError = vi.fn();
    const t = createTandem({
      app,
      features: ["triage", "reply"],
      modelId: "chrome:158",
      defaults: { triage: policyWith("ONLY_IN_CLOUD", { version: 1 }) },
      onError,
    });
    await t.ready;
    expect(onError).toHaveBeenCalledOnce();
    expect(t.policies.get("triage")?.version).toBe(1);
    const changes = vi.fn();
    t.onPolicyChange(changes);
    sdk.rcValues = { tandem_policy_triage: JSON.stringify(policyWith("PREFER_ON_DEVICE")) };
    sdk.rcObserver?.next({ getUpdatedKeys: () => new Set(["tandem_policy_triage", "unrelated"]) });
    await flush();
    expect(sdk.activate).toHaveBeenCalledOnce();
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ featureId: "triage" }));
    expect(t.route("triage").rule.mode).toBe("PREFER_ON_DEVICE");
    sdk.rcObserver?.error(new Error("stream closed"));
    sdk.rcObserver?.complete();
    expect(onError).toHaveBeenCalledTimes(2);
    await t.flushTelemetry(); // no telemetry configured: no-op
    t.dispose();
  });

  it("can disable realtime and telemetry, and detects the model id itself", async () => {
    const t = createTandem({
      app,
      features: [],
      realtime: false,
      telemetry: false,
      minimumFetchIntervalMillis: 0,
    });
    await t.ready;
    expect(t.modelId).toMatch(/^(chrome:\d+|cloud:web)$/);
    t.dispose();
    expect(sdk.unsubscribe).not.toHaveBeenCalled();
  });

  it("flushes telemetry when the page is hidden", async () => {
    const listeners: Record<string, () => void> = {};
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { add: g.addEventListener, remove: g.removeEventListener, doc: g.document };
    g.addEventListener = (n: string, fn: () => void) => (listeners[n] = fn);
    g.removeEventListener = vi.fn();
    g.document = { visibilityState: "hidden" };
    try {
      sdk.rcValues = { tandem_policy_triage: JSON.stringify(policyWith("ONLY_IN_CLOUD")) };
      sdk.nextResponse = { text: GOOD, inferenceSource: "in_cloud" };
      const t = createTandem({
        app,
        features: ["triage"],
        modelId: "chrome:158",
        telemetry: { firestore: {} as Firestore, projectId: "p1" },
      });
      await t.ready;
      await t.generate("triage", "x");
      expect(sdk.batches).toHaveLength(0);
      listeners.visibilitychange?.();
      await flush();
      expect(sdk.batches).toHaveLength(1);
      t.dispose();
      expect(g.removeEventListener).toHaveBeenCalled();
    } finally {
      g.addEventListener = saved.add;
      g.removeEventListener = saved.remove;
      g.document = saved.doc;
    }
  });
});
