import {
  canonicalJson,
  DEFAULT_GATES,
  evaluateRepair,
  isDeviceTarget,
  parseOutput,
  validateOutput,
  variantHash,
  type Case,
  type Evidence,
  type Feature,
  type GateSettings,
  type Job,
  type ModelId,
  type OutputSchema,
  type Policy,
  type RepairEvaluation,
  type Variant,
} from "@tandem/core";
import type { InferenceBackend } from "@tandem/runtime";
import { evidenceOf } from "./data/plan.js";

/**
 * Repair: a cloud model proposes a new prompt variant for a (feature, device model) pair that
 * failed, from TRAIN failures only — holdout cases are never shown to it, so the holdout gate stays
 * an honest test (ADR 0003). The candidate then runs beside its parent in one run, on every target,
 * and the three gates decide.
 */

export const REPAIR_SCHEMA: OutputSchema = {
  type: "object",
  properties: {
    systemInstruction: { type: "string", minLength: 10, maxLength: 4000 },
    promptTemplate: { type: "string", minLength: 10, maxLength: 8000 },
    rationale: { type: "string", maxLength: 600 },
  },
  required: ["systemInstruction", "promptTemplate", "rationale"],
};

export const REPAIR_SYSTEM = [
  "You improve prompts for a small on-device language model (much weaker than you).",
  "You get the current system instruction and prompt template, the output schema, and failing examples with what was expected.",
  "Write a new system instruction and prompt template that fix the failure patterns for the small model without overfitting to the examples:",
  "- describe rules and definitions, never copy example messages or their answers into the prompt;",
  "- keep it short: small models follow short, explicit, enumerated rules better than long prose;",
  "- the template must contain the placeholder {{input}} exactly once.",
  "rationale: one or two sentences on which failure pattern each change addresses.",
].join("\n");

export interface Failure {
  input: string;
  output?: string;
  failed: string[];
}

/** Train-split failures of `variantId` on `target`, most common failure first. Holdout is excluded. */
export function trainFailures(jobs: readonly Job[], cases: ReadonlyMap<string, Case>, variantId: string, target: ModelId, max = 12): Failure[] {
  const out: Failure[] = [];
  for (const j of jobs) {
    if (j.variantId !== variantId || j.target !== target || j.state !== "done") continue;
    if (j.verdict === "pass" || j.verdict === "pending_judge") continue;
    const c = cases.get(j.caseId);
    if (!c || c.split !== "train" || j.split === "holdout") continue;
    out.push({
      input: c.input.text,
      ...(j.result?.outputText !== undefined ? { output: j.result.outputText } : {}),
      failed: (j.checks ?? []).filter((k) => !k.pass).map((k) => `${k.id}${k.detail ? `: ${k.detail}` : ""}`),
    });
  }
  return out.slice(0, max);
}

export function repairPrompt(feature: Pick<Feature, "name" | "description" | "outputSchema" | "outputKind">, parent: Pick<Variant, "systemInstruction" | "promptTemplate">, target: ModelId, failures: readonly Failure[]): string {
  return [
    `Feature: ${feature.name}${feature.description ? ` — ${feature.description}` : ""}`,
    `Target model: ${target} (small on-device model)`,
    `Output kind: ${feature.outputKind}; schema: ${canonicalJson(feature.outputSchema)}`,
    "",
    "Current system instruction:",
    "<<<",
    parent.systemInstruction,
    ">>>",
    "Current prompt template:",
    "<<<",
    parent.promptTemplate,
    ">>>",
    "",
    `Failing examples (${failures.length}):`,
    ...failures.map((f, i) =>
      [`#${i + 1} input: ${f.input}`, `   output: ${f.output ?? "(none)"}`, `   failed: ${f.failed.join(" | ") || "unknown"}`].join("\n"),
    ),
  ].join("\n");
}

export interface Proposal {
  systemInstruction: string;
  promptTemplate: string;
  rationale: string;
}

export function parseProposal(text: string): Proposal | undefined {
  const p = parseOutput("json", text);
  if (!p.ok || validateOutput(REPAIR_SCHEMA, p.value).length > 0) return undefined;
  const v = p.value as Proposal;
  if (v.promptTemplate.split("{{input}}").length !== 2) return undefined;
  return v;
}

/** Ask the cloud repair model for a candidate; returns an immutable repair variant ready to save. */
export async function proposeRepair(o: {
  backend: InferenceBackend;
  model: string;
  feature: Feature;
  parent: Variant;
  target: ModelId;
  failures: readonly Failure[];
  existingIds: readonly string[];
}): Promise<Variant> {
  if (o.failures.length === 0) throw new Error("no train failures to repair");
  const res = await o.backend.generate({
    target: "cloud",
    cloudModel: o.model,
    systemInstruction: REPAIR_SYSTEM,
    prompt: repairPrompt(o.feature, o.parent, o.target, o.failures),
    outputKind: "json",
    outputSchema: REPAIR_SCHEMA,
  });
  const p = parseProposal(res.text);
  if (!p) throw new Error("repair model returned an unusable proposal");
  return {
    id: nextVariantId(o.existingIds),
    featureId: o.feature.id,
    systemInstruction: p.systemInstruction,
    promptTemplate: p.promptTemplate,
    sha256: await variantHash(p.systemInstruction, p.promptTemplate),
    parentId: o.parent.id,
    origin: "repair",
    targetModelId: o.target,
    rationale: p.rationale.slice(0, 600),
  };
}

export function nextVariantId(existing: readonly string[]): string {
  return `v${Math.max(0, ...existing.map((v) => Number(v.replace(/\D/g, "")) || 0)) + 1}`;
}

export interface CandidateVerdict {
  candidate: string;
  parent: string;
  target: ModelId;
  evaluation: RepairEvaluation;
  train: Evidence | undefined;
  holdout: Evidence | undefined;
}

/**
 * Gate every (candidate, device target) pair in a run that also measured the parent. Parent and
 * candidate ran side by side, so the regression gate compares like with like.
 */
export function gateRun(jobs: readonly Job[], parentId: string, live: Policy | undefined, settings: GateSettings = DEFAULT_GATES): CandidateVerdict[] {
  const all = evidenceOf(jobs);
  const train = evidenceOf(jobs, "train");
  const holdout = evidenceOf(jobs, "holdout");
  const find = (ev: Evidence[], v: string, t: ModelId) => ev.find((e) => e.variantId === v && e.target === t);
  const variants = [...new Set(jobs.map((j) => j.variantId))].filter((v) => v !== parentId);
  const targets = [...new Set(jobs.map((j) => j.target))];
  const out: CandidateVerdict[] = [];
  for (const candidate of variants)
    for (const target of targets.filter(isDeviceTarget)) {
      const tr = find(train, candidate, target);
      const ho = find(holdout, candidate, target);
      const regression = targets
        .filter((t) => t !== target)
        .map((t) => ({
          target: t,
          parent: find(all, parentId, t) ?? { n: 0, passes: 0 },
          candidate: find(all, candidate, t) ?? { n: 0, passes: 0 },
          parentOnDevice: (live?.rules[t]?.mode ?? "ONLY_IN_CLOUD").includes("DEVICE"),
        }));
      out.push({
        candidate,
        parent: parentId,
        target,
        train: tr,
        holdout: ho,
        evaluation: evaluateRepair(
          { train: tr ?? { n: 0, passes: 0 }, ...(ho ? { holdout: ho } : {}), regression },
          settings,
        ),
      });
    }
  return out;
}
