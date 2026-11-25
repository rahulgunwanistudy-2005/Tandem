# ADR 0002 — Route on the Wilson 95% lower bound, not the pass rate

**Status:** accepted (2026-11-25)

## Context

A run produces n = cases × k samples per (feature, variant, model), typically 30–150. "Passed 29 of 30"
and "passed 290 of 300" have the same rate but very different certainty. A router that promotes on the
point estimate promotes lucky small samples.

## Decision

Route a model to device only if the Wilson score lower bound of its pass rate is ≥ τ (default 0.85),
n ≥ 30, there are zero integrity failures and p95 latency is within budget
(`packages/core/src/compiler.ts`). Wilson is used because, unlike the Wald interval, it stays inside
[0, 1] and behaves at p̂ = 1, which is exactly where good on-device prompts live.

## Consequences

- A perfect 20/20 does **not** route to device (LB 0.839); 30/30 does (LB 0.886). The UI explains this
  as "insufficient evidence".
- The same statistic demotes rules in production: auto-rollback fires when the Wilson lower bound of
  the escalation rate exceeds its threshold (`rollback.ts`), so promotion and demotion are symmetric and
  a few unlucky calls cannot flap a rule.
- Implementation verified against Newcombe (1998) reference values in `stats.test.ts`.
