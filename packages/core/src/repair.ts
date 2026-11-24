import type { ModelId } from "./contracts.js";
import type { Evidence } from "./evidence.js";
import { newcombeDifference, wilsonLowerBound } from "./stats.js";

/**
 * Repair acceptance gates. A candidate prompt variant for a failing (feature, model) pair is
 * accepted only if all three pass, in order (later gates are not run if an earlier one fails, which
 * saves device time):
 *
 *  1. TRAIN      on the failing model, train split:   LB₉₅ ≥ τ and n ≥ minN.
 *  2. HOLDOUT    on the failing model, holdout split: LB₉₅ ≥ τ − holdoutSlack and n ≥ minHoldoutN,
 *                and the holdout pass rate is not significantly below train (overfit guard:
 *                upper bound of Newcombe(holdout − train) ≥ 0).
 *  3. REGRESSION on every other target, both splits:  non-inferior to the parent variant —
 *                lower bound of Newcombe(candidate − parent) ≥ −margin — and no target that the
 *                parent routed to device loses its device route.
 *
 * Holdout gets a slack because it is ~30% of cases (smaller n ⇒ wider interval); the overfit
 * guard is what actually catches prompts tuned to the train cases. See docs/adr/0003.
 */

export interface GateSettings {
  tau: number;
  minN: number;
  minHoldoutN: number;
  holdoutSlack: number;
  regressionMargin: number;
}

export const DEFAULT_GATES: GateSettings = {
  tau: 0.85,
  minN: 30,
  minHoldoutN: 15,
  holdoutSlack: 0.1,
  regressionMargin: 0.1,
};

export type GateName = "train" | "holdout" | "regression";

export interface GateResult {
  gate: GateName;
  pass: boolean;
  detail: string;
  /** per-target details for the regression gate */
  targets?: Array<{ target: ModelId; pass: boolean; diffLower: number; detail: string }>;
}

export interface RepairEvaluation {
  accepted: boolean;
  gates: GateResult[];
  /** the first gate that failed, if any */
  failedAt?: GateName;
}

type Counts = Pick<Evidence, "n" | "passes">;

export function trainGate(train: Counts, s: GateSettings): GateResult {
  const lb = wilsonLowerBound(train.passes, train.n);
  if (train.n < s.minN) return { gate: "train", pass: false, detail: `n=${train.n} < ${s.minN}` };
  const pass = lb >= s.tau;
  return { gate: "train", pass, detail: `${train.passes}/${train.n}, LB ${fmt(lb)} ${pass ? "≥" : "<"} τ ${fmt(s.tau)}` };
}

export function holdoutGate(train: Counts, holdout: Counts, s: GateSettings): GateResult {
  if (holdout.n < s.minHoldoutN) return { gate: "holdout", pass: false, detail: `n=${holdout.n} < ${s.minHoldoutN}` };
  const lb = wilsonLowerBound(holdout.passes, holdout.n);
  const need = s.tau - s.holdoutSlack;
  const gap = newcombeDifference(holdout.passes, holdout.n, train.passes, train.n);
  const lbOk = lb >= need;
  const notOverfit = gap.upper >= 0;
  const pass = lbOk && notOverfit;
  const parts = [`${holdout.passes}/${holdout.n}, LB ${fmt(lb)} ${lbOk ? "≥" : "<"} ${fmt(need)}`];
  if (!notOverfit) parts.push(`holdout significantly below train (Δ upper ${fmt(gap.upper)} < 0)`);
  return { gate: "holdout", pass, detail: parts.join("; ") };
}

export interface RegressionTarget {
  target: ModelId;
  parent: Counts;
  candidate: Counts;
  /** whether the parent variant currently routes this target to device */
  parentOnDevice: boolean;
}

export function regressionGate(targets: readonly RegressionTarget[], s: GateSettings): GateResult {
  const rows = targets.map((t) => {
    const diff = newcombeDifference(t.candidate.passes, t.candidate.n, t.parent.passes, t.parent.n);
    const nonInferior = diff.lower >= -s.regressionMargin;
    const keepsDevice = !t.parentOnDevice || wilsonLowerBound(t.candidate.passes, t.candidate.n) >= s.tau;
    const pass = t.candidate.n > 0 && nonInferior && keepsDevice;
    const why: string[] = [];
    if (t.candidate.n === 0) why.push("not measured");
    if (!nonInferior) why.push(`Δ lower ${fmt(diff.lower)} < −${fmt(s.regressionMargin)}`);
    if (!keepsDevice) why.push("would lose its device route");
    return {
      target: t.target,
      pass,
      diffLower: diff.lower,
      detail: pass ? `Δ lower ${fmt(diff.lower)}` : why.join("; "),
    };
  });
  const failed = rows.filter((r) => !r.pass);
  return {
    gate: "regression",
    pass: failed.length === 0,
    detail:
      targets.length === 0
        ? "no other targets"
        : failed.length === 0
          ? `${rows.length} target(s) non-inferior`
          : `regressed on ${failed.map((f) => f.target).join(", ")}`,
    targets: rows,
  };
}

export function evaluateRepair(
  input: { train: Counts; holdout?: Counts; regression?: readonly RegressionTarget[] },
  s: GateSettings = DEFAULT_GATES,
): RepairEvaluation {
  const gates: GateResult[] = [];
  const t = trainGate(input.train, s);
  gates.push(t);
  if (!t.pass) return { accepted: false, gates, failedAt: "train" };
  if (!input.holdout) return { accepted: false, gates, failedAt: "holdout" };
  const h = holdoutGate(input.train, input.holdout, s);
  gates.push(h);
  if (!h.pass) return { accepted: false, gates, failedAt: "holdout" };
  if (!input.regression) return { accepted: false, gates, failedAt: "regression" };
  const r = regressionGate(input.regression, s);
  gates.push(r);
  if (!r.pass) return { accepted: false, gates, failedAt: "regression" };
  return { accepted: true, gates };
}

function fmt(x: number): string {
  return x.toFixed(3);
}
