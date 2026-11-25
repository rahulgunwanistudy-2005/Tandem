/**
 * TypeScript mirror of contracts/*.schema.json.
 * test/contracts.test.ts validates the golden fixtures against the JSON Schemas and runs them
 * through these types, so a drift between the two fails CI.
 */

export type Platform = "chrome" | "android" | "ios" | "cloud";
/** `<platform>:<model>`; a trailing `*` is a platform wildcard. */
export type ModelId = `${Platform}:${string}`;
export type InferenceMode =
  "PREFER_ON_DEVICE" | "ONLY_ON_DEVICE" | "PREFER_IN_CLOUD" | "ONLY_IN_CLOUD";
export type Backend = "ON_DEVICE" | "IN_CLOUD" | "UNKNOWN";
export type Split = "train" | "holdout";

export const ERROR_CODES = [
  "MODEL_UNAVAILABLE",
  "MODEL_DOWNLOADING",
  "BUSY",
  "QUOTA",
  "GUARDRAIL",
  "SCHEMA_INVALID",
  "INPUT_TOO_LONG",
  "INTEGRITY_CLOUD_ANSWER",
  "OFFLINE",
  "UNKNOWN",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface OutputSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  nullable?: boolean;
  enum?: string[];
  properties?: Record<string, OutputSchema>;
  required?: string[];
  items?: OutputSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export type OutputKind = "json" | "enum" | "text";

export interface Feature {
  id: string;
  name: string;
  description?: string;
  outputKind: OutputKind;
  outputSchema: OutputSchema;
  genConfig: { temperature?: number; topK?: number; maxOutputTokens?: number };
  latencyBudgetMs: number;
  cloudModel: string;
  defaultVariantId?: string;
}

export interface Variant {
  id: string;
  featureId: string;
  systemInstruction: string;
  promptTemplate: string;
  sha256: string;
  parentId?: string;
  origin: "human" | "repair";
  targetModelId?: ModelId;
  rationale?: string;
}

export type Scalar = string | number | boolean | null;

export type Assert =
  | { kind: "equals"; path: string; value: Scalar }
  | { kind: "one_of"; path: string; values: Scalar[] }
  | { kind: "not_null"; path: string }
  | { kind: "regex"; path: string; pattern: string; flags?: string; negate?: boolean }
  | { kind: "length"; path: string; min?: number; max?: number; unit?: "chars" | "words" }
  | {
      kind: "contains";
      path: string;
      substring: string;
      caseSensitive?: boolean;
      negate?: boolean;
    };

export interface Case {
  id: string;
  input: { text: string; imagePath?: string };
  asserts: Assert[];
  rubric?: string;
  split: Split;
  tags: string[];
}

export interface JobResult {
  outputText?: string;
  backend: Backend;
  latencyMs: number;
  ttftMs?: number;
  modelId: ModelId;
  inputChars: number;
  errorCode?: ErrorCode;
  errorMessage?: string;
}

export interface CheckResult {
  id: string;
  pass: boolean;
  detail?: string;
}

export interface JudgeResult {
  pass: boolean;
  score: number;
  reason: string;
  cacheKey: string;
  model?: string;
}

export type Verdict = "pass" | "fail" | "integrity_fail" | "error" | "pending_judge";

export interface Job {
  id: string;
  runId: string;
  caseId: string;
  variantId: string;
  target: ModelId;
  split?: Split;
  sample: number;
  state: "queued" | "leased" | "done" | "failed";
  leaseOwner?: string;
  leaseExpiresAt?: string;
  attempt: number;
  result?: JobResult;
  checks?: CheckResult[];
  judge?: JudgeResult;
  verdict?: Verdict;
}

export type RuleReason =
  | "PASSED"
  | "INSUFFICIENT_EVIDENCE"
  | "LB_BELOW_TAU"
  | "LATENCY_OVER_BUDGET"
  | "INTEGRITY_FAILURES"
  | "NO_EVIDENCE"
  | "AUTO_ROLLBACK"
  | "MANUAL";

export interface RuleEvidence {
  n: number;
  passes: number;
  lb: number;
  p95LatencyMs?: number;
  flakiness?: number;
  integrityFailures?: number;
}

export interface PolicyRule {
  mode: InferenceMode;
  variantId: string;
  reason: RuleReason;
  evidence?: RuleEvidence;
}

export interface PolicyVariant {
  systemInstruction: string;
  promptTemplate: string;
  sha256: string;
}

export interface Policy {
  schemaVersion: 1;
  featureId: string;
  version: number;
  compiledAt: string;
  tau: number;
  sourceRunIds?: string[];
  default: PolicyRule;
  rules: Record<string, PolicyRule>;
  variants: Record<string, PolicyVariant>;
  outputSchema?: OutputSchema;
  outputKind?: OutputKind;
  cloudModel?: string;
}

export interface TelemetryEvent {
  eventId: string;
  featureId: string;
  modelId: ModelId;
  platform: Platform;
  policyVersion: number;
  variantId?: string;
  mode: InferenceMode;
  backend: Backend;
  latencyMs: number;
  validation: "pass" | "fail" | "skipped";
  escalated: boolean;
  errorCode?: ErrorCode;
  ts: number;
  sdk: string;
}
