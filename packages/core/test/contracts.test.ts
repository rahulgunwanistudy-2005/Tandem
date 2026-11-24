import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { Case, Feature, Job, Policy, TelemetryEvent, Variant } from "../src/contracts.js";
import { runDeterministicChecks, verdictFor } from "../src/checks.js";
import { resolveRule } from "../src/resolve.js";
import { variantHash } from "../src/canonical.js";
import { wilsonLowerBound } from "../src/stats.js";

/**
 * Contract tests: every golden fixture validates against its JSON Schema, every *.invalid.json
 * fixture is rejected, and the valid fixtures behave as expected when fed to the TS engine.
 * The Kotlin and Swift test suites load the same fixtures.
 */

const dir = join(import.meta.dirname, "../../../contracts");
const fx = join(dir, "fixtures");
const load = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

const addFormats = (addFormatsImport as unknown as { default?: typeof addFormatsImport }).default ?? addFormatsImport;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
for (const f of readdirSync(dir).filter((f) => f.endsWith(".schema.json"))) {
  ajv.addSchema(load(join(dir, f)), f);
}

const schemaFor = (fixture: string) => `${fixture.split(".")[0]}.schema.json`;

describe("golden fixtures", () => {
  const files = readdirSync(fx).filter((f) => f.endsWith(".json"));

  it("exist for every schema", () => {
    for (const s of ["feature", "variant", "case", "job", "policy", "telemetry"]) {
      expect(files.some((f) => f.startsWith(`${s}.`))).toBe(true);
    }
  });

  it.each(files.filter((f) => !f.includes(".invalid.")))("%s is valid", (f) => {
    const validate = ajv.getSchema(schemaFor(f));
    expect(validate, `schema for ${f}`).toBeDefined();
    const ok = validate!(load(join(fx, f)));
    expect(validate!.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it.each(files.filter((f) => f.includes(".invalid.")))("%s is rejected", (f) => {
    expect(ajv.getSchema(schemaFor(f))!(load(join(fx, f)))).toBe(false);
  });
});

describe("fixtures through the engine", () => {
  const feature = load<Feature>(join(fx, "feature.triage.json"));
  const variant = load<Variant>(join(fx, "variant.triage-v1.json"));
  const kase = load<Case>(join(fx, "case.triage-001.json"));
  const pass = load<Job>(join(fx, "job.device-pass.json"));
  const integrity = load<Job>(join(fx, "job.integrity-fail.json"));
  const policy = load<Policy>(join(fx, "policy.triage.json"));
  const event = load<TelemetryEvent>(join(fx, "telemetry.event.json"));

  it("variant sha256 matches its content", async () => {
    expect(await variantHash(variant.systemInstruction, variant.promptTemplate)).toBe(variant.sha256);
  });

  it("job verdicts are reproducible from their results", () => {
    for (const job of [pass, integrity]) {
      const det = runDeterministicChecks(feature, kase, job.target, job.result!);
      expect(verdictFor(det, kase, job.judge, job.result!)).toBe(job.verdict);
      expect(det.checks.map((c) => c.id)).toEqual(job.checks!.map((c) => c.id));
    }
  });

  it("policy evidence LBs are honest Wilson bounds", () => {
    for (const rule of Object.values(policy.rules)) {
      if (!rule.evidence) continue;
      expect(rule.evidence.lb).toBeCloseTo(wilsonLowerBound(rule.evidence.passes, rule.evidence.n), 4);
    }
  });

  it("policy resolves for the telemetry event's model", () => {
    const r = resolveRule(policy, event.modelId);
    expect(r.rule.mode).toBe(event.mode);
    expect(resolveRule(policy, "android:nano-v9").matchedBy).toBe("wildcard");
  });

  it("telemetry schema forbids content fields", () => {
    const validate = ajv.getSchema("telemetry.schema.json")!;
    for (const field of ["prompt", "input", "output", "outputText", "text"]) {
      expect(validate({ ...event, [field]: "secret" })).toBe(false);
    }
  });
});
