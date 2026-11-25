import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { TandemError, type ModelId, type Policy } from "@tandem/core";
import { orderFor, TandemEngine, verifyOutput } from "../src/engine.js";
import { PolicyStore } from "../src/policy.js";
import {
  BAD,
  GOOD,
  ok,
  policyErrors,
  policyWith,
  recorder,
  ScriptedBackend,
  telemetryErrors,
  type Step,
} from "./helpers.js";

function setup(
  policy: Policy,
  backend: ScriptedBackend,
  modelId: ModelId = "chrome:158",
  extra: Partial<ConstructorParameters<typeof TandemEngine>[0]> = {},
) {
  const telemetry = recorder();
  const sleep = vi.fn(async (_ms: number) => undefined);
  let clock = 1_000;
  const engine = new TandemEngine({
    modelId,
    backend,
    policies: new PolicyStore({ [policy.featureId]: policy }),
    telemetry,
    sleep,
    now: () => (clock += 7),
    newId: () => `evt_${clock}`,
    rand: () => 0.5,
    ...extra,
  });
  return { engine, telemetry, sleep };
}

describe("test policies are themselves valid contracts", () => {
  it.each(["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"] as const)(
    "%s",
    (m) => expect(policyErrors(policyWith(m))).toEqual([]),
  );
});

describe("PREFER_ON_DEVICE", () => {
  it("serves a verified on-device answer", async () => {
    const b = new ScriptedBackend({ device: [ok(GOOD, "ON_DEVICE")] });
    const { engine, telemetry } = setup(policyWith("PREFER_ON_DEVICE"), b);
    const r = await engine.generate("triage", "where is my order");
    expect(r).toMatchObject({
      value: { intent: "other", urgency: "low" },
      backend: "ON_DEVICE",
      escalated: false,
      variantId: "v2",
      policyVersion: 4,
      matchedBy: "exact",
      mode: "PREFER_ON_DEVICE",
    });
    expect(r.escalationReason).toBeUndefined();
    expect(b.calls[0]).toMatchObject({
      target: "device",
      systemInstruction: "Classify the ticket. JSON only.",
      prompt: "Ticket:\nwhere is my order",
      outputKind: "json",
      cloudModel: "gemini-3.5-flash-lite",
    });
    expect(telemetry.events).toHaveLength(1);
    expect(telemetry.events[0]).toMatchObject({
      backend: "ON_DEVICE",
      validation: "pass",
      escalated: false,
      modelId: "chrome:158",
      platform: "chrome",
      sdk: "web/0.1.0",
    });
    expect(telemetry.events[0]).not.toHaveProperty("errorCode");
  });

  it.each<[string, ConstructorParameters<typeof ScriptedBackend>[0], string]>([
    ["invalid output", { device: [ok(BAD, "ON_DEVICE")] }, "SCHEMA_INVALID"],
    ["unparseable output", { device: [ok("Sure! here you go", "ON_DEVICE")] }, "SCHEMA_INVALID"],
    [
      "a cloud answer to a device call",
      { device: [ok(GOOD, "IN_CLOUD")] },
      "INTEGRITY_CLOUD_ANSWER",
    ],
    ["an unlabeled answer", { device: [ok(GOOD, "UNKNOWN")] }, "INTEGRITY_CLOUD_ANSWER"],
    ["a model still downloading", { availability: "downloading" }, "MODEL_DOWNLOADING"],
    ["a model not yet downloaded", { availability: "downloadable" }, "MODEL_UNAVAILABLE"],
    ["no Prompt API", { availability: "unavailable" }, "MODEL_UNAVAILABLE"],
    ["availability() throwing", { availability: new Error("Failed to fetch") }, "OFFLINE"],
    ["a guardrail", { device: [new Error("Response was blocked due to SAFETY")] }, "GUARDRAIL"],
  ])("escalates to the cloud on %s", async (_, script, code) => {
    const b = new ScriptedBackend({ ...script, cloud: [ok(GOOD, "IN_CLOUD")] });
    const { engine, telemetry } = setup(policyWith("PREFER_ON_DEVICE"), b);
    const r = await engine.generate("triage", "x");
    expect(r).toMatchObject({ backend: "IN_CLOUD", escalated: true, escalationReason: code });
    expect(b.calls.at(-1)?.target).toBe("cloud");
    expect(telemetry.events[0]).toMatchObject({
      escalated: true,
      errorCode: code,
      backend: "IN_CLOUD",
    });
  });

  it("never sends an over-budget prompt to the device", async () => {
    const b = new ScriptedBackend({ cloud: [ok(GOOD, "IN_CLOUD")] });
    const { engine } = setup(policyWith("PREFER_ON_DEVICE"), b);
    const r = await engine.generate("triage", "lorem ipsum ".repeat(5000));
    expect(r.escalationReason).toBe("INPUT_TOO_LONG");
    expect(b.targets()).toEqual(["cloud"]);
  });

  it("retries BUSY with backoff before giving up on the device", async () => {
    const busy = new Error("service busy");
    const b = new ScriptedBackend({ device: [busy, busy, ok(GOOD, "ON_DEVICE")] });
    const { engine, sleep } = setup(policyWith("PREFER_ON_DEVICE"), b);
    expect((await engine.generate("triage", "x")).backend).toBe("ON_DEVICE");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([125, 250]);

    const b2 = new ScriptedBackend({ device: [busy, busy, busy], cloud: [ok(GOOD, "IN_CLOUD")] });
    const r2 = await setup(policyWith("PREFER_ON_DEVICE"), b2).engine.generate("triage", "x");
    expect(r2.escalationReason).toBe("BUSY");
    expect(b2.targets()).toEqual(["device", "device", "device", "cloud"]);
  });
});

describe("other modes", () => {
  it("ONLY_ON_DEVICE throws instead of falling back, and says why", async () => {
    const b = new ScriptedBackend({ device: [ok(GOOD, "IN_CLOUD")] });
    const { engine, telemetry } = setup(policyWith("ONLY_ON_DEVICE"), b);
    const err = await engine.generate("triage", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TandemError);
    expect(err).toMatchObject({ code: "INTEGRITY_CLOUD_ANSWER" });
    expect(b.targets()).toEqual(["device"]);
    expect(telemetry.events[0]).toMatchObject({
      escalated: false,
      errorCode: "INTEGRITY_CLOUD_ANSWER",
      backend: "IN_CLOUD",
      validation: "skipped",
    });
  });

  it("ONLY_IN_CLOUD never touches the device", async () => {
    const b = new ScriptedBackend({ cloud: [ok(GOOD, "IN_CLOUD")] });
    const { engine } = setup(policyWith("ONLY_IN_CLOUD"), b);
    expect((await engine.generate("triage", "x")).backend).toBe("IN_CLOUD");
    expect(b.availabilityCalls).toBe(0);
  });

  it("PREFER_IN_CLOUD falls back to the device when offline", async () => {
    const b = new ScriptedBackend({
      cloud: [new Error("Failed to fetch")],
      device: [ok(GOOD, "ON_DEVICE")],
    });
    const r = await setup(policyWith("PREFER_IN_CLOUD"), b).engine.generate("triage", "x");
    expect(r).toMatchObject({ backend: "ON_DEVICE", escalated: true, escalationReason: "OFFLINE" });
  });

  it("a model with no rule gets the default (cloud) route", async () => {
    const b = new ScriptedBackend({ cloud: [ok(GOOD, "IN_CLOUD")] });
    const { engine } = setup(policyWith("PREFER_ON_DEVICE"), b, "chrome:157");
    const r = await engine.generate("triage", "x");
    expect(r).toMatchObject({ matchedBy: "default", variantId: "v1", mode: "ONLY_IN_CLOUD" });
    expect(b.calls[0]?.prompt).toBe("Ticket: x");
  });

  it("non-Chrome browsers always use the cloud, whatever the rule says", async () => {
    const p = policyWith("ONLY_ON_DEVICE");
    p.rules["cloud:web"] = { mode: "ONLY_ON_DEVICE", variantId: "v2", reason: "MANUAL" };
    const b = new ScriptedBackend({ cloud: [ok(GOOD, "IN_CLOUD")] });
    const { engine } = setup(p, b, "cloud:web");
    expect((await engine.generate("triage", "x")).backend).toBe("IN_CLOUD");
    expect(engine.route("triage").order).toEqual(["cloud"]);
  });

  it("throws the last failure when every target fails", async () => {
    const b = new ScriptedBackend({
      device: [ok(BAD, "ON_DEVICE")],
      cloud: [new Error("429 RESOURCE_EXHAUSTED")],
    });
    const { engine, telemetry } = setup(policyWith("PREFER_ON_DEVICE"), b);
    await expect(engine.generate("triage", "x")).rejects.toMatchObject({ code: "QUOTA" });
    expect(telemetry.events[0]).toMatchObject({
      escalated: true,
      errorCode: "QUOTA",
      backend: "UNKNOWN",
    });
  });

  it("an invalid cloud answer is a SCHEMA_INVALID error, not a silent pass", async () => {
    const b = new ScriptedBackend({ cloud: [ok(BAD, "IN_CLOUD")] });
    const { engine, telemetry } = setup(policyWith("ONLY_IN_CLOUD"), b);
    await expect(engine.generate("triage", "x")).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    expect(telemetry.events[0]).toMatchObject({ validation: "fail", backend: "IN_CLOUD" });
  });
});

describe("output kinds", () => {
  it("text features skip validation; enum features are checked", async () => {
    const text = policyWith("PREFER_ON_DEVICE", { outputKind: "text" });
    delete text.outputSchema;
    const b = new ScriptedBackend({ device: [ok(" Hi there ", "ON_DEVICE")] });
    const t = setup(text, b);
    expect((await t.engine.generate("triage", "x")).value).toBe(" Hi there ");
    expect(t.telemetry.events[0]?.validation).toBe("skipped");

    const noKind = policyWith("PREFER_ON_DEVICE");
    delete noKind.outputKind;
    delete noKind.outputSchema;
    const b2 = new ScriptedBackend({ device: [ok("free text", "ON_DEVICE")] });
    expect((await setup(noKind, b2).engine.generate("triage", "x")).value).toBe("free text");

    const en = policyWith("PREFER_ON_DEVICE", {
      outputKind: "enum",
      outputSchema: { type: "string", enum: ["low", "high"] },
    });
    const b3 = new ScriptedBackend({
      device: [ok('"high"', "ON_DEVICE"), ok("medium", "ON_DEVICE")],
      cloud: [ok("low", "IN_CLOUD")],
    });
    const e = setup(en, b3);
    expect((await e.engine.generate("triage", "x")).value).toBe("high");
    expect((await e.engine.generate("triage", "y")).value).toBe("low");
  });

  it("verifyOutput reports the first schema issue", () => {
    const r = verifyOutput("json", { type: "object", required: ["a"] }, "{}");
    expect(r).toEqual({
      ok: false,
      message: "1 schema issue(s); first: a: missing required property",
    });
    expect(verifyOutput("json", undefined, "[1]")).toEqual({ ok: true, value: [1], checked: true });
  });
});

describe("plumbing", () => {
  it("unknown features and malformed model ids are errors", async () => {
    const b = new ScriptedBackend();
    const { engine } = setup(policyWith("PREFER_ON_DEVICE"), b);
    await expect(engine.generate("nope", "x")).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(() => setup(policyWith("PREFER_ON_DEVICE"), b, "safari" as ModelId)).toThrow(
      SyntaxError,
    );
  });

  it("route() explains the decision without calling a model", () => {
    const b = new ScriptedBackend();
    const { engine } = setup(policyWith("PREFER_ON_DEVICE"), b);
    expect(engine.route("triage")).toMatchObject({
      modelId: "chrome:158",
      policyVersion: 4,
      matchedBy: "exact",
      variantId: "v2",
      order: ["device", "cloud"],
      rule: { reason: "PASSED", evidence: { lb: 0.94 } },
    });
    expect(engine.modelId).toBe("chrome:158");
    expect(b.calls).toHaveLength(0);
    expect(orderFor("ONLY_IN_CLOUD")).toEqual(["cloud"]);
  });

  it("a throwing telemetry recorder never breaks inference", async () => {
    const b = new ScriptedBackend({ device: [ok(GOOD, "ON_DEVICE")] });
    const { engine } = setup(policyWith("PREFER_ON_DEVICE"), b, "chrome:158", {
      telemetry: {
        record: () => {
          throw new Error("disk full");
        },
      },
    });
    await expect(engine.generate("triage", "x")).resolves.toMatchObject({ backend: "ON_DEVICE" });
  });

  it("works with real timers and ids when none are injected", async () => {
    const b = new ScriptedBackend({ device: [new Error("busy"), ok(GOOD, "ON_DEVICE")] });
    const telemetry = recorder();
    const engine = new TandemEngine({
      modelId: "chrome:158",
      backend: b,
      policies: new PolicyStore({ triage: policyWith("PREFER_ON_DEVICE") }),
      telemetry,
      rand: () => 0,
    });
    await engine.generate("triage", "x");
    expect(telemetry.events[0]?.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(telemetryErrors(telemetry.events[0])).toEqual([]);
  });
});

describe("invariants (property-based)", () => {
  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.constant(ok(GOOD, "ON_DEVICE")),
    fc.constant(ok(GOOD, "IN_CLOUD")),
    fc.constant(ok(GOOD, "UNKNOWN")),
    fc.constant(ok(BAD, "ON_DEVICE")),
    fc.constant(ok(BAD, "IN_CLOUD")),
    fc.constant(ok("not json", "ON_DEVICE")),
    fc.constantFrom(
      new Error("service busy"),
      new Error("Failed to fetch"),
      new Error("429 quota"),
      new Error("blocked: SAFETY"),
      new Error("???"),
    ),
  );
  const scenario = fc.record({
    mode: fc.constantFrom(
      "PREFER_ON_DEVICE",
      "ONLY_ON_DEVICE",
      "PREFER_IN_CLOUD",
      "ONLY_IN_CLOUD",
    ) as fc.Arbitrary<"PREFER_ON_DEVICE" | "ONLY_ON_DEVICE" | "PREFER_IN_CLOUD" | "ONLY_IN_CLOUD">,
    availability: fc.constantFrom(
      "available",
      "downloadable",
      "downloading",
      "unavailable",
    ) as fc.Arbitrary<"available" | "downloadable" | "downloading" | "unavailable">,
    device: fc.array(step, { minLength: 3, maxLength: 3 }),
    cloud: fc.array(step, { minLength: 3, maxLength: 3 }),
  });

  it("only schema-valid answers are returned; ON_DEVICE only when the device really answered; one valid, content-free event per call", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const b = new ScriptedBackend({
          availability: s.availability,
          device: [...s.device],
          cloud: [...s.cloud],
        });
        const { engine, telemetry } = setup(policyWith(s.mode), b);
        let result;
        try {
          result = await engine.generate("triage", "secret customer text");
        } catch (e) {
          expect(e).toBeInstanceOf(TandemError);
        }
        if (result) {
          expect(result.value).toEqual({ intent: "other", urgency: "low" });
          if (result.backend === "ON_DEVICE") {
            // the answer came from a device call that really reported ON_DEVICE
            expect(s.mode).not.toBe("ONLY_IN_CLOUD");
            expect(b.targets().at(-1)).toBe("device");
          }
          if (s.mode === "ONLY_ON_DEVICE") expect(result.backend).toBe("ON_DEVICE");
          if (s.mode === "ONLY_IN_CLOUD")
            expect(b.targets().every((t) => t === "cloud")).toBe(true);
        }
        expect(telemetry.events).toHaveLength(1);
        expect(telemetryErrors(telemetry.events[0])).toEqual([]);
        expect(JSON.stringify(telemetry.events)).not.toContain("secret");
      }),
      { numRuns: 300 },
    );
  });
});
