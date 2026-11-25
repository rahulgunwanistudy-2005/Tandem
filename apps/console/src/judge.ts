import {
  canonicalJson,
  judgeCacheKey,
  parseOutput,
  validateOutput,
  type Case,
  type Feature,
  type JudgeResult,
  type OutputSchema,
} from "@tandem/core";
import type { InferenceBackend } from "@tandem/runtime";

export const JUDGE_SCHEMA: OutputSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean", description: "true only if every rubric point is satisfied" },
    score: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string", description: "one sentence naming the deciding rubric point" },
  },
  required: ["pass", "score", "reason"],
};

export const JUDGE_SYSTEM = [
  "You are a strict evaluator for a product feature's model output.",
  "Grade ONLY against the rubric. Do not reward style, length or politeness unless the rubric asks.",
  "pass=true only if every rubric point is satisfied. score is your confidence the output meets the rubric (0..1).",
  "reason: one short sentence naming the rubric point that decided the verdict. Never quote personal data.",
].join("\n");

export function judgePrompt(
  feature: Pick<Feature, "name" | "description">,
  testCase: Pick<Case, "input" | "rubric">,
  output: unknown,
): string {
  return [
    `Feature: ${feature.name}${feature.description ? ` — ${feature.description}` : ""}`,
    "",
    "User input:",
    "<<<",
    testCase.input.text,
    ">>>",
    "",
    "Model output:",
    "<<<",
    typeof output === "string" ? output : canonicalJson(output),
    ">>>",
    "",
    "Rubric:",
    testCase.rubric ?? "",
  ].join("\n");
}

export type JudgeVerdict = Pick<JudgeResult, "pass" | "score" | "reason">;

/** Parse and validate the judge's JSON; anything malformed is rejected, never guessed. */
export function parseJudge(text: string): JudgeVerdict | undefined {
  const p = parseOutput("json", text);
  if (!p.ok || validateOutput(JUDGE_SCHEMA, p.value).length > 0) return undefined;
  const v = p.value as JudgeVerdict;
  return { pass: v.pass, score: Math.round(v.score * 1000) / 1000, reason: v.reason.slice(0, 300) };
}

export interface JudgeCache {
  get(key: string): Promise<(JudgeVerdict & { model?: string }) | undefined>;
  put(key: string, v: JudgeVerdict & { model: string }): Promise<void>;
}

export interface JudgeInput {
  feature: Pick<Feature, "id" | "name" | "description">;
  variantId: string;
  testCase: Pick<Case, "id" | "input" | "rubric">;
  /** Parsed output when parsing succeeded, else raw text (the cache key uses the same value). */
  output: unknown;
}

/**
 * Cloud judge (ONLY_IN_CLOUD through AI Logic, ADR 0001). Results are cached by
 * sha256(featureId, variantId, caseId, canonical output), so a rerun with an identical answer
 * never pays for the judge twice.
 */
export class Judge {
  hits = 0;
  calls = 0;

  constructor(
    private readonly backend: InferenceBackend,
    private readonly cache: JudgeCache,
    private readonly model: () => string,
  ) {}

  async judge(i: JudgeInput): Promise<JudgeResult> {
    const cacheKey = await judgeCacheKey(i.feature.id, i.variantId, i.testCase.id, i.output);
    const hit = await this.cache.get(cacheKey).catch(() => undefined);
    if (hit) {
      this.hits++;
      return { ...hit, cacheKey };
    }
    const model = this.model();
    this.calls++;
    const res = await this.backend.generate({
      target: "cloud",
      cloudModel: model,
      systemInstruction: JUDGE_SYSTEM,
      prompt: judgePrompt(i.feature, i.testCase, i.output),
      outputKind: "json",
      outputSchema: JUDGE_SCHEMA,
    });
    const v = parseJudge(res.text);
    if (!v) throw new Error("judge returned malformed output");
    await this.cache.put(cacheKey, { ...v, model }).catch(() => undefined);
    return { ...v, cacheKey, model };
  }
}
