import { parseOutput, type Job } from "@tandem/core";
import type { Judge } from "../judge.js";
import type { Catalog } from "./loop.js";

export interface JudgeTarget {
  pid: string;
  runId: string;
  featureId: string;
}

export interface JudgeSink {
  attach(t: JudgeTarget, job: Job, patch: Pick<Job, "judge" | "verdict" | "checks">): Promise<void>;
}

/**
 * Grades `pending_judge` samples one at a time. The final verdict is the judge's pass/fail; the
 * judge's reason is appended to the checks so the cell drawer shows why.
 */
export async function judgeJob(
  t: JudgeTarget,
  job: Job,
  judge: Judge,
  catalog: Catalog,
  sink: JudgeSink,
): Promise<boolean> {
  if (job.verdict !== "pending_judge" || job.result?.outputText === undefined) return false;
  const { feature, testCase } = await catalog.load(t.featureId, job.variantId, job.caseId);
  const parsed = parseOutput(feature.outputKind, job.result.outputText);
  const result = await judge.judge({
    feature,
    variantId: job.variantId,
    testCase,
    output: parsed.ok ? parsed.value : job.result.outputText,
  });
  await sink.attach(t, job, {
    judge: result,
    verdict: result.pass ? "pass" : "fail",
    checks: [
      ...(job.checks ?? []).filter((c) => c.id !== "judge"),
      { id: "judge", pass: result.pass, detail: result.reason },
    ],
  });
  return true;
}
