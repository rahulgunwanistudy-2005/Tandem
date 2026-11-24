import { wilsonLowerBound } from "./stats.js";

/**
 * Auto-rollback decision for one live on-device rule, evaluated by the scheduled autoRollback
 * function over a sliding window of runtime telemetry.
 *
 * Demote when we are 95% confident the true rate is above the threshold — i.e. the Wilson *lower*
 * bound of the observed rate exceeds it. Using the lower bound (not the point estimate) means a
 * handful of unlucky calls cannot flap a rule; the same statistic that promoted the rule is the one
 * that demotes it.
 */
export interface WindowStats {
  /** on-device attempts in the window (events whose rule mode was on-device) */
  attempts: number;
  /** attempts that failed local validation and escalated to cloud */
  escalations: number;
  /** attempts that ended in an error (any code other than GUARDRAIL, which is policy not quality) */
  errors: number;
}

export interface RollbackThresholds {
  maxEscalationRate: number;
  maxErrorRate: number;
  minAttempts: number;
}

export const DEFAULT_ROLLBACK: RollbackThresholds = {
  maxEscalationRate: 0.15,
  maxErrorRate: 0.1,
  minAttempts: 20,
};

export type RollbackDecision =
  | { demote: false; reason: "INSUFFICIENT_TRAFFIC" | "HEALTHY"; escalationLb: number; errorLb: number }
  | { demote: true; metric: "escalation_rate" | "error_rate"; observed: number; lowerBound: number; threshold: number };

export function rollbackDecision(w: WindowStats, t: RollbackThresholds = DEFAULT_ROLLBACK): RollbackDecision {
  const escalationLb = w.attempts === 0 ? 0 : wilsonLowerBound(Math.min(w.escalations, w.attempts), w.attempts);
  const errorLb = w.attempts === 0 ? 0 : wilsonLowerBound(Math.min(w.errors, w.attempts), w.attempts);
  if (w.attempts < t.minAttempts) return { demote: false, reason: "INSUFFICIENT_TRAFFIC", escalationLb, errorLb };
  if (escalationLb > t.maxEscalationRate) {
    return { demote: true, metric: "escalation_rate", observed: w.escalations / w.attempts, lowerBound: escalationLb, threshold: t.maxEscalationRate };
  }
  if (errorLb > t.maxErrorRate) {
    return { demote: true, metric: "error_rate", observed: w.errors / w.attempts, lowerBound: errorLb, threshold: t.maxErrorRate };
  }
  return { demote: false, reason: "HEALTHY", escalationLb, errorLb };
}
