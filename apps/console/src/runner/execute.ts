import {
  backoffMs,
  checkBudget,
  classifyWebError,
  familyOf,
  isDeviceTarget,
  parseModelId,
  renderPrompt,
  runDeterministicChecks,
  verdictFor,
  type Case,
  type CheckResult,
  type ErrorCode,
  type Feature,
  type JobResult,
  type ModelId,
  type Variant,
  type Verdict,
} from "@tandem/core";
import type { InferenceBackend, InferenceRequest } from "@tandem/runtime";

export interface ExecuteInput {
  target: ModelId;
  feature: Feature;
  variant: Pick<Variant, "systemInstruction" | "promptTemplate">;
  testCase: Case;
  backend: InferenceBackend;
  /** BUSY retries before giving up (on-device inference is single-stream). */
  busyRetries?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

export interface Execution {
  result: JobResult;
  checks: CheckResult[];
  verdict: Verdict;
  /** Parsed output when parsing succeeded; the judge reads it. */
  parsed?: unknown;
}

const MAX_MESSAGE = 300;
const DEFAULT_OUTPUT_RESERVE = 256;

/**
 * Run one job on its target and grade it with the deterministic checks.
 *
 * Device targets: the model must report `available` (no silent download), the prompt must fit the
 * family's token budget, and the call is pinned ONLY_ON_DEVICE. Whatever backend the SDK reports is
 * recorded as-is, so a cloud answer on a device job becomes an integrity failure in the checks —
 * never a pass. Cloud targets (the reference) are pinned ONLY_IN_CLOUD on the named model.
 */
export async function executeJob(i: ExecuteInput): Promise<Execution> {
  const result = await infer(i);
  const det = runDeterministicChecks(i.feature, i.testCase, i.target, result);
  return {
    result,
    checks: det.checks,
    verdict: verdictFor(det, i.testCase, undefined, result),
    ...(det.parsed !== undefined ? { parsed: det.parsed } : {}),
  };
}

async function infer(i: ExecuteInput): Promise<JobResult> {
  const clock = i.clock ?? (() => performance.now());
  const sleep = i.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const device = isDeviceTarget(i.target);
  const prompt = renderPrompt(i.variant.promptTemplate, i.testCase.input.text);
  const sys = i.variant.systemInstruction;
  const inputChars = [...sys].length + [...prompt].length;
  const base = { modelId: i.target, inputChars };
  const failed = (errorCode: ErrorCode, latencyMs: number, message?: string): JobResult => ({
    ...base,
    backend: "UNKNOWN",
    latencyMs: round1(latencyMs),
    errorCode,
    ...(message ? { errorMessage: message.slice(0, MAX_MESSAGE) } : {}),
  });

  if (device) {
    let availability: string;
    try {
      availability = await i.backend.availability();
    } catch (e) {
      return failed("MODEL_UNAVAILABLE", 0, messageOf(e));
    }
    if (availability === "downloading") return failed("MODEL_DOWNLOADING", 0);
    if (availability !== "available") return failed("MODEL_UNAVAILABLE", 0, availability);
    const budget = checkBudget(
      `${sys}\n${prompt}`,
      familyOf(i.target),
      i.feature.genConfig.maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE,
    );
    if (!budget.fits) return failed("INPUT_TOO_LONG", 0, budget.reason);
  }

  const req: InferenceRequest = {
    target: device ? "device" : "cloud",
    systemInstruction: sys,
    prompt,
    outputKind: i.feature.outputKind,
    outputSchema: i.feature.outputSchema,
    cloudModel: device ? i.feature.cloudModel : parseModelId(i.target).model,
  };

  const retries = i.busyRetries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const t0 = clock();
    try {
      const res = await i.backend.generate(req);
      return { ...base, outputText: res.text, backend: res.backend, latencyMs: round1(clock() - t0) };
    } catch (e) {
      const code = classifyWebError(e);
      if (code === "BUSY" && attempt < retries) {
        await sleep(backoffMs(attempt, 250, 4000, i.rand));
        continue;
      }
      return failed(code, clock() - t0, messageOf(e));
    }
  }
}

function messageOf(e: unknown): string | undefined {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : undefined;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
