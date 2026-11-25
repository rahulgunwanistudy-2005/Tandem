# ADR 0003 — Repairs must pass train, holdout and regression gates

**Status:** accepted (2026-11-25)

## Context

A cloud model rewriting a prompt until a device passes is an optimiser, and optimisers overfit: the
repaired prompt can memorise the failing cases or break other models.

## Decision

Cases are split 70/30 train/holdout, stratified and deterministic (seeded FNV-1a, `split.ts`), so the
holdout never drifts. A candidate is accepted only if, in order:

1. **train** — Wilson LB ≥ τ on the failing model's train split (n ≥ 30);
2. **holdout** — Wilson LB ≥ τ − 0.10 on holdout (n ≥ 15), **and** holdout is not significantly below
   train (upper bound of the Newcombe difference ≥ 0) — the overfit guard;
3. **regression** — on every other target, non-inferior to the parent (Newcombe lower bound of
   candidate − parent ≥ −0.10) and no target the parent routed to device loses that route.

## Consequences

Later gates are skipped when an earlier one fails, saving device time. Margins are explicit
parameters (`DEFAULT_GATES`) and shown in the Repair screen.
