import type { Case, CheckResult, Feature, JobResult, JudgeResult, ModelId, Verdict } from "./contracts.js";
import { evaluateAssert } from "./assertions.js";
import { parseOutput, validateOutput } from "./schema.js";
import { isDeviceTarget } from "./models.js";

/**
 * Deterministic checks for one sample. They run before the judge and cost nothing.
 * Order matters: the first failure explains the verdict in the run matrix.
 *
 *   integrity → error → parse → schema → asserts → latency
 */
export interface DeterministicOutcome {
  checks: CheckResult[];
  /** true when every deterministic check passed. */
  pass: boolean;
  /** true when the answer did not come from the device on a device target. */
  integrityFailure: boolean;
  /** the parsed output, when parsing succeeded (used by the judge and the cell drawer). */
  parsed?: unknown;
}

export function runDeterministicChecks(
  feature: Pick<Feature, "outputKind" | "outputSchema" | "latencyBudgetMs">,
  testCase: Pick<Case, "asserts">,
  target: ModelId,
  result: JobResult,
): DeterministicOutcome {
  const checks: CheckResult[] = [];

  // 1. Integrity: a device target must be answered by the device. A silent cloud fallback is
  //    never an on-device pass. UNKNOWN is treated as a failure too: we only trust what we can see.
  if (isDeviceTarget(target)) {
    const ok = result.backend === "ON_DEVICE";
    checks.push({ id: "integrity", pass: ok, ...(ok ? {} : { detail: `device job answered by ${result.backend}` }) });
    if (!ok) return { checks, pass: false, integrityFailure: true };
  }

  // 2. Runner-reported error.
  if (result.errorCode) {
    checks.push({ id: "error", pass: false, detail: `${result.errorCode}${result.errorMessage ? `: ${result.errorMessage}` : ""}` });
    return { checks, pass: false, integrityFailure: result.errorCode === "INTEGRITY_CLOUD_ANSWER" };
  }
  if (result.outputText === undefined) {
    checks.push({ id: "error", pass: false, detail: "no output" });
    return { checks, pass: false, integrityFailure: false };
  }

  // 3. Parse.
  const parsed = parseOutput(feature.outputKind, result.outputText);
  checks.push({ id: "parse", pass: parsed.ok, ...(parsed.ok ? {} : { detail: parsed.error }) });
  if (!parsed.ok) return { checks, pass: false, integrityFailure: false };

  // 4. Schema (JSON and enum outputs).
  if (feature.outputKind !== "text") {
    const issues = validateOutput(feature.outputSchema, parsed.value);
    const ok = issues.length === 0;
    checks.push({
      id: "schema",
      pass: ok,
      ...(ok ? {} : { detail: issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join("; ") }),
    });
  }

  // 5. Case assertions.
  testCase.asserts.forEach((a, i) => checks.push(evaluateAssert(a, parsed.value, i)));

  // 6. Latency budget.
  const latencyOk = result.latencyMs <= feature.latencyBudgetMs;
  checks.push({
    id: "latency",
    pass: latencyOk,
    ...(latencyOk ? {} : { detail: `${Math.round(result.latencyMs)} ms > budget ${feature.latencyBudgetMs} ms` }),
  });

  return { checks, pass: checks.every((c) => c.pass), integrityFailure: false, parsed: parsed.value };
}

/** Whether a sample needs the cloud judge: only deterministic passes that carry a rubric. */
export function needsJudge(det: DeterministicOutcome, testCase: Pick<Case, "rubric">): boolean {
  return det.pass && typeof testCase.rubric === "string" && testCase.rubric.trim().length > 0;
}

/**
 * Final verdict for a sample.
 * A sample passes only if deterministic checks pass, the judge passes where a rubric exists,
 * and (for device targets) the backend was ON_DEVICE — the last is enforced by `integrity`.
 */
export function verdictFor(
  det: DeterministicOutcome,
  testCase: Pick<Case, "rubric">,
  judge: JudgeResult | undefined,
  result: Pick<JobResult, "errorCode">,
): Verdict {
  if (det.integrityFailure) return "integrity_fail";
  if (result.errorCode) return "error";
  if (!det.pass) return "fail";
  if (needsJudge(det, testCase)) {
    if (!judge) return "pending_judge";
    return judge.pass ? "pass" : "fail";
  }
  return "pass";
}
