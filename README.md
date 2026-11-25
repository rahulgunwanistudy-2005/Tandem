# Tandem

[![CI](https://github.com/rahulgunwanistudy-2005/Tandem/actions/workflows/ci.yml/badge.svg)](https://github.com/rahulgunwanistudy-2005/Tandem/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> Tandem runs your prompts on the real on-device models, has a cloud model judge and repair the
> failures, and publishes per-model routing to your app through Remote Config, with no app release.

**The fallback is not the feature. Knowing which prompts have earned the device is, and that is a test
result.**

Entry for Google's **#BuildHybridAI 2026** (Firebase AI Logic hybrid inference).

> **Build status (Nov 25, 2026):** the routing engine, data contracts and security rules are complete
> and tested. The console, the runtime SDKs and the sample app are in progress — see
> [`docs/STATUS.md`](docs/STATUS.md). This README only claims what exists in the repo today.

## The loop

```
 AUTHOR ──► TEST ──► JUDGE ──► REPAIR ──► PUBLISH ──► OBSERVE ──► ROLL BACK
 feature    real      cloud     cloud      Remote      runtime     automatic
 + cases    devices   verdicts  rewrites   Config      telemetry   demotion
```

## The routing rule (implemented: [`packages/core/src/compiler.ts`](packages/core/src/compiler.ts))

For each (feature, prompt variant, device model) a run produces `n = cases × k samples`. A sample
passes only if its deterministic checks pass, the cloud judge passes it (when the case has a rubric),
and the answer really came from the device. Then:

```
route to device (PREFER_ON_DEVICE)  ⇔  n ≥ 30
                                    ∧  integrity failures = 0
                                    ∧  WilsonLB₉₅(passes, n) ≥ τ        (τ = 0.85 by default)
                                    ∧  p95 latency ≤ feature budget
otherwise ONLY_IN_CLOUD, with the reason recorded in the policy.

WilsonLB(p̂, n) = ( p̂ + z²/2n − z·√( p̂(1−p̂)/n + z²/4n² ) ) / (1 + z²/n),   z = 1.96
```

A perfect 20/20 does **not** earn the device (LB 0.839); 30/30 does (LB 0.886). Untested models
always route to cloud. Why Wilson: [ADR 0002](docs/adr/0002-wilson-lower-bound.md).

**Integrity check.** Device jobs run with `ONLY_ON_DEVICE`; a result whose `inferenceSource` is not
`ON_DEVICE` (iOS: `modelVersion` is not the system model) is an `INTEGRITY_CLOUD_ANSWER` failure —
a silent cloud fallback can never count as an on-device pass
([`checks.ts`](packages/core/src/checks.ts)).

**Repair gates.** A repaired prompt is accepted only after it passes the failing model's train split,
then its holdout split with an overfit guard, then a non-inferiority check on every other target
([`repair.ts`](packages/core/src/repair.ts), [ADR 0003](docs/adr/0003-train-holdout-gates.md)).

**Auto-rollback** demotes a live rule when the Wilson lower bound of its escalation or error rate
crosses a threshold — the same statistic in both directions, so a few unlucky calls cannot flap a rule
([`rollback.ts`](packages/core/src/rollback.ts)).

## Privacy

Runtime telemetry is content-free by construction: the JSON Schema
([`contracts/telemetry.schema.json`](contracts/telemetry.schema.json)) and the Firestore rules both use
an exact field allowlist, so an event carrying `prompt` or `outputText` is rejected. Raw events expire
after 7 days. [ADR 0005](docs/adr/0005-no-content-in-telemetry.md).

## Repository

| Path                                                  | What                                                                              | State                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------- |
| [`contracts/`](contracts)                             | JSON Schemas for every data shape + golden fixtures                               | done                         |
| [`packages/core/`](packages/core)                     | pure TS engine: checks, Wilson, compiler, repair gates, budgets, rollback, Pareto | done — 113 tests, 100% lines |
| [`firebase/`](firebase)                               | Firestore rules (lease state machine, telemetry allowlist), indexes, RC template  | done — 19 emulator tests     |
| `apps/console/`                                       | dashboard + Chrome on-device runner                                               | in progress                  |
| `packages/runtime-web/`, `apps/android/`, `apps/ios/` | runtime SDKs with verified fallback                                               | in progress                  |
| `functions/`                                          | publishPolicy, claimPairing, aggregateTelemetry, autoRollback, reapLeases         | in progress                  |

Architecture decisions: [`docs/adr/`](docs/adr). Platform API notes (verified Nov 25, 2026):
[`docs/PLATFORM_NOTES.md`](docs/PLATFORM_NOTES.md).

## Develop

```bash
pnpm install
pnpm lint && pnpm typecheck
pnpm --filter @tandem/core test:coverage
pnpm --filter @tandem/firebase test:rules   # Firestore emulator; needs Java 21+
```

`firebase.json` and web Firebase config are public by design; no API keys or secrets are committed
(gitleaks runs in CI).

## License

[Apache-2.0](LICENSE)
