import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { Backend, InferenceMode, Policy, TelemetryEvent } from "@tandem/core";
import type {
  DeviceAvailability,
  InferenceBackend,
  InferenceRequest,
  InferenceResponse,
} from "../src/types.js";

const contracts = join(import.meta.dirname, "../../../contracts");
const load = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

const addFormats =
  (addFormatsImport as unknown as { default?: typeof addFormatsImport }).default ??
  addFormatsImport;
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  allowUnionTypes: true,
});
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
for (const f of readdirSync(contracts).filter((f) => f.endsWith(".schema.json")))
  ajv.addSchema(load(join(contracts, f)), f);

export function telemetryErrors(e: unknown): string[] {
  const v = ajv.getSchema("telemetry.schema.json");
  if (!v) throw new Error("telemetry schema not loaded");
  return v(e) ? [] : (v.errors ?? []).map((x) => `${x.instancePath} ${x.message ?? ""}`);
}

export function policyErrors(p: unknown): string[] {
  const v = ajv.getSchema("policy.schema.json");
  if (!v) throw new Error("policy schema not loaded");
  return v(p) ? [] : (v.errors ?? []).map((x) => `${x.instancePath} ${x.message ?? ""}`);
}

export const fixturePolicy = (): Policy =>
  load<Policy>(join(contracts, "fixtures/policy.triage.json"));

export const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["order_status", "damaged_item", "other"] },
    urgency: { type: "string", enum: ["low", "normal", "high"] },
  },
  required: ["intent", "urgency"],
} as const;

export const GOOD = '{"intent":"other","urgency":"low"}';
export const BAD = '{"intent":"refund","urgency":"low"}';

/** A triage policy whose rule for `chrome:158` uses the given mode. */
export function policyWith(mode: InferenceMode, extra: Partial<Policy> = {}): Policy {
  return {
    schemaVersion: 1,
    featureId: "triage",
    version: 4,
    compiledAt: "2026-11-25T10:00:00.000Z",
    tau: 0.85,
    default: { mode: "ONLY_IN_CLOUD", variantId: "v1", reason: "NO_EVIDENCE" },
    rules: {
      "chrome:158": {
        mode,
        variantId: "v2",
        reason: "PASSED",
        evidence: { n: 120, passes: 118, lb: 0.94 },
      },
    },
    variants: {
      v1: {
        systemInstruction: "Classify.",
        promptTemplate: "Ticket: {{input}}",
        sha256: "a".repeat(64),
      },
      v2: {
        systemInstruction: "Classify the ticket. JSON only.",
        promptTemplate: "Ticket:\n{{input}}",
        sha256: "b".repeat(64),
      },
    },
    outputSchema: structuredClone(TRIAGE_SCHEMA) as unknown as Policy["outputSchema"],
    outputKind: "json",
    cloudModel: "gemini-3.5-flash-lite",
    ...extra,
  };
}

export type Step = InferenceResponse | Error;

/** Scripted backend: each target pops its next scripted answer; records every request. */
export class ScriptedBackend implements InferenceBackend {
  readonly calls: InferenceRequest[] = [];
  availabilityCalls = 0;
  constructor(
    public script: {
      device?: Step[];
      cloud?: Step[];
      availability?: DeviceAvailability | Error;
    } = {},
  ) {}

  async availability(): Promise<DeviceAvailability> {
    this.availabilityCalls++;
    const a = this.script.availability ?? "available";
    if (a instanceof Error) throw a;
    return a;
  }

  async generate(req: InferenceRequest): Promise<InferenceResponse> {
    this.calls.push(req);
    const q = this.script[req.target] ?? [];
    const step = q.shift();
    if (!step) throw new Error(`unscripted ${req.target} call`);
    if (step instanceof Error) throw step;
    return step;
  }

  targets(): string[] {
    return this.calls.map((c) => c.target);
  }
}

export const ok = (text: string, backend: Backend): InferenceResponse => ({ text, backend });

export function recorder(): { events: TelemetryEvent[]; record(e: TelemetryEvent): void } {
  const events: TelemetryEvent[] = [];
  return { events, record: (e) => void events.push(e) };
}
