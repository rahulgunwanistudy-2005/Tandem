# CLAUDE.md — Tandem

Tandem runs your prompts on the real on-device models, has a cloud model judge and repair the
failures, and publishes per-model routing to your app through Remote Config, with no app release.

Entry for Google's #BuildHybridAI 2026 (Firebase AI Logic hybrid inference). Deadline:
**Nov 30, 2026 2:00 PM PT = Dec 1 03:30 IST**. Internal submit target: **Nov 30 18:00 IST**.

## Rules for every session

1. **Verify before building.** Never code an AI Logic / Remote Config API from memory. The SDK is
   experimental. Check `docs/PLATFORM_NOTES.md` first; if an API isn't recorded there, read the docs
   page (or the installed package's `.d.ts`) and record it before using it.
2. **No fake engine.** Every number shown in the UI, README or video comes from real runs. The CI-only
   fake runner (`apps/console/src/runner/fake/`) is labelled and excluded from production builds.
3. **Integrity check is sacred.** A device job whose answer did not come from the device
   (`inferenceSource !== ON_DEVICE`, or iOS `modelVersion` not the system model) is an
   `INTEGRITY_CLOUD_ANSWER` failure — never a pass.
4. **No content in telemetry.** Telemetry events never carry prompt or output text. The schema in
   `contracts/telemetry.schema.json` has `additionalProperties: false`; keep it that way.
5. **Commits:** conventional commits (`feat(core): …`, `fix(rules): …`, `docs: …`). Commit and push
   after every working slice. **Never add AI attribution lines** (no `Co-Authored-By`, no
   "Generated with" footers) to commits or PR descriptions — this is the repo owner's explicit rule.
6. Update `docs/STATUS.md` at the end of each work block: done / next / blocked / decisions.
7. Before marking anything done ask: can a judge _see_ it in the video or README in under 10 seconds?

## Repo map

```
contracts/            JSON Schemas (draft 2020-12) — single source of truth for data shapes
  fixtures/           golden JSON validated by TS (and later Kotlin/Swift) tests
packages/core/        pure TS, no Firebase: assertions, Wilson LB, flakiness, policy compiler,
                      repair gates, token-budget estimator, error taxonomy, canonical JSON/hash
packages/runtime-web/ @tandem/runtime — tandem.generate() for web apps (AI Logic + RC + telemetry)
packages/ui/          design tokens + shared React components
apps/console/         Vite + React: Tandem dashboard AND the Chrome on-device runner
apps/counter-web/     sample app "Counter" (support inbox) on web
apps/android/         Gradle: :runtime (Kotlin SDK), :app (Runner + Counter tabs)
apps/ios/             SwiftPM TandemRuntime + app (Runner + Counter tabs)
functions/            Cloud Functions v2: publishPolicy, claimPairing, aggregateTelemetry,
                      autoRollback, reapLeases (orchestration only — no inference)
firebase/             firestore.rules, indexes, remoteconfig template, emulator config
docs/                 ARCHITECTURE, PLATFORM_NOTES, STATUS, DEMO_SCRIPT, adr/
```

## Commands

```bash
pnpm install                       # all JS workspaces
pnpm -r typecheck                  # tsc --noEmit everywhere
pnpm -r test                       # vitest (core has coverage thresholds ≥ 90%)
pnpm --filter @tandem/core test:coverage
pnpm lint
pnpm test:rules                    # firestore rules tests on the emulator (needs Java 21+)
pnpm --filter @tandem/console dev  # console on http://localhost:5173
```

## Conventions

- TypeScript `strict`, `noUncheckedIndexedAccess`; **no `any` in `packages/core`**.
- Data shapes live in `contracts/*.schema.json`; TS types in `packages/core/src/contracts.ts` are
  checked against the golden fixtures by `packages/core/test/contracts.test.ts`.
- Error taxonomy (shared across TS/Kotlin/Swift): `MODEL_UNAVAILABLE`, `MODEL_DOWNLOADING`, `BUSY`,
  `QUOTA`, `GUARDRAIL`, `SCHEMA_INVALID`, `INPUT_TOO_LONG`, `INTEGRITY_CLOUD_ANSWER`, `OFFLINE`,
  `UNKNOWN`.
- Two signal colours only: **device** and **cloud** (tokens in `packages/ui/src/tokens.css`).
  Everything else is neutral.

## Never cut

Real on-device runs on ≥ 2 platforms · the integrity check · deterministic checks + judge ·
Wilson-based routing · Remote Config publish with real-time application · runtime SDK with verified
fallback · telemetry for on-device calls · App Check · the design bar · tests and CI · the README.

Cut order if late: receipt_read → custom-signal conditions → rollout % UI → iOS Counter → iOS entirely
(only if no Apple Intelligence device; say so in README).
