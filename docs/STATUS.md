# STATUS

_Last updated: 2026-11-26 01:35 IST._

## Clock

The brief was written for a Nov 17 start. **Work actually started Nov 25, 04:08 IST.** That leaves
~5.5 days to the hard deadline (Dec 1, 03:30 IST) and ~5.5 days to the internal target (Nov 30,
18:00 IST). The 13-day plan in the brief is compressed into the schedule below. Scope decisions
follow the brief's §8 ladder; nothing on the never-cut list moves.

| Day (IST)      | Build                                                                                                                                   | Rahul                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Wed Nov 25** | contracts, `core` (stats/compiler/gates/budget) + tests, rules + rules tests, CI, console shell, web runtime, Chrome runner             | quota account (**closes 23:30 IST today**), Firebase project + products, free disk, Chrome gate check, Android device check |
| Thu Nov 26     | console end-to-end on real Chrome Nano: features, cases, leasing, cloud reference, judge + cache, live matrix; Android runtime + runner | pair Android phone, register debug tokens                                                                                   |
| Fri Nov 27     | Android Counter; cross-device matrix; repair loop with gates; compiler; `publishPolicy`; realtime application                           | run cases on phone                                                                                                          |
| Sat Nov 28     | telemetry, aggregation, Observe, `autoRollback`, τ dial + Pareto; iOS only if hardware exists; design QA pass                           | iPhone (if any)                                                                                                             |
| Sun Nov 29     | hardening, Hosting deploy, README/ARCHITECTURE/ADRs final, **record video**                                                             | record + upload                                                                                                             |
| Mon Nov 30     | buffer; submit by 18:00 IST                                                                                                             | submit on Devpost                                                                                                           |

## Hardware audit (from this Mac, 2026-11-25)

| Item         | Found                                                  | Verdict                                                                                                                           |
| ------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Mac          | Apple M1, **8 GB** unified memory, macOS 26.3          | —                                                                                                                                 |
| Free disk    | **21 GiB** on `/` (14 GB in `~/Library/Caches`)        | **Below Chrome's 22 GB gate.** Must free space.                                                                                   |
| Chrome       | 158.0.8127.37 (desktop)                                | Version OK (≥ 139). GPU path needs > 4 GB VRAM; the 16 GB-RAM CPU path is not met. **Confirm at `chrome://on-device-internals`.** |
| Xcode        | Command Line Tools only, no Xcode.app                  | iOS build impossible until Xcode is installed (needs ~15–20 GB more disk).                                                        |
| Android      | `adb` present; no SDK, no Gradle; JDK 24               | Need Android SDK (Studio or cmdline-tools). JDK 21 recommended for AGP. Device: **unknown — ask Rahul.**                          |
| Firebase CLI | not installed                                          | Installing as a dev dependency (`firebase-tools`) so the repo is self-contained.                                                  |
| GitHub       | remote `rahulgunwanistudy-2005/Tandem` (public, empty) | push via git credential helper.                                                                                                   |

Open questions for Rahul are in the "Blocked" section.

## Done (Nov 25, morning)

- Repo scaffold, `CLAUDE.md`, Apache-2.0 `LICENSE`, ESLint (no `any` / no Firebase / no Node in
  `core`), Prettier, CI (lint, types, core coverage gate, rules on emulator, gitleaks).
- Platform docs re-verified → `docs/PLATFORM_NOTES.md` (differences from the brief listed there).
- `contracts/`: 9 JSON Schemas + golden fixtures (valid and deliberately invalid).
- `packages/core`: Wilson/Newcombe stats (checked against Newcombe 1998 reference values),
  deterministic checks + integrity, evidence, compiler, resolver, repair gates, token budget with
  calibration, rollback, Pareto dial, stratified split, canonical hashing. **113 tests, 100% lines,
  95.5% branches.**
- `firebase/`: rules with job-lease state machine, telemetry allowlist, pairing codes; **19 emulator
  tests**, mutation-checked.
- ADRs 0001–0005, README skeleton (claims only what exists).

## Done (Nov 25, evening)

- `packages/runtime-web` (`@tandem/runtime`): `createTandem()` / `tandem.generate()` with
  **verified fallback** — resolve the published rule for this model, check Prompt API availability
  and the on-device token budget, retry `BUSY` with jittered backoff, reject any device-call answer
  not labelled `on_device` (`INTEGRITY_CLOUD_ANSWER`), validate output against the feature schema,
  escalate per the rule's mode. Policies from Remote Config (`tandem_policy_<featureId>`) with
  real-time `onConfigUpdate` → `activate` → reload of only the updated keys; bad or older publishes
  are rejected and the last good policy stays live. Content-free telemetry batched into
  `projects/{pid}/telemetry_raw` (allowlist = schema = rules), flushed on page hide.
  **74 tests, 100% lines, 95.9% branches**, including a property test (300 random scenarios) that
  only schema-valid answers are returned, `ON_DEVICE` is reported only for a real device answer,
  and every call emits exactly one schema-valid event containing no input text. That property test
  caught a real mislabelling path (a cloud call reported as on-device), now fixed.
- SDK behaviour read from the installed `@firebase/ai` 3.1.0 source and recorded in
  `PLATFORM_NOTES.md` (lowercase enum values; `ONLY_ON_DEVICE` waits on a download that needs a
  user gesture; new session per call; `systemInstruction` not forwarded to Chrome).
- **Not yet verified on hardware**: no real Gemini Nano call has been made through the runtime.

## Done (Nov 26, night)

- **First real on-device run.** `apps/console` drove a 40-job triage run on Chrome 158's Gemini
  Nano on this M1: every answer labelled `on_device`, **12/40 pass**, Wilson LB 0.181, p50 3.9 s /
  p95 9.8 s. The compiler routed `chrome:158` to the cloud (`LB_BELOW_TAU`) and `publishPolicy`
  (functions emulator) recorded v1. Numbers in `PLATFORM_NOTES.md`.
- `apps/console` (Vite + React): emulator mode, anonymous/Google sign-in, Counter demo seed
  (triage 40 cases, reply 16 cases with rubrics), runner loop with transactional leases and
  heartbeats, cloud reference runner, judge with output-hash cache, live matrix, Wilson evidence,
  compile + diff + publish, devices page with pairing codes. 26 tests, 99% lines on runner/judge/plan.
- `functions/`: `publishPolicy` (membership, shape, next-version concurrency, RC JSON parameter,
  Firestore record), `claimPairing`, `reapLeases`; esbuild bundle; 20 tests.
- Rules: members' consoles lease `cloud:*` reference jobs (emulator test added, 20 rules tests).
- Core fix: a device error with no answer is an error, not an integrity failure.
- Bugs found by running it for real: a just-created project was opened before it committed (rules
  denial ended the runner's listener) and StrictMode disposed the runner's queue. Both fixed.
- Firebase: GCP project **`tandem-hybrid-ai`** created under the gcloud account. Adding Firebase to
  it returns 403 until that account accepts the Firebase terms in the console (see Blocked).

## Next

1. Repair loop: propose a variant for a failing device model (cloud repair model), run it on train +
   holdout, apply the three gates, show the decision. Triage v1's `language` failures are the demo.
2. `aggregateTelemetry` + `autoRollback` + Observe page; counter-web sample app on `@tandem/runtime`.
3. Second platform: Android (needs SDK + a supported phone) or Apple Foundation Models through the
   iOS Simulator on this Mac (needs Xcode 26; Command Line Tools here are Swift 6.0.3 / SDK 15.2).
4. Once Firebase is added: deploy rules, functions, hosting; real cloud reference + judge + RC publish.

## Blocked (needs Rahul)

1. Hackathon quota account — Sprint 3 request closes **Nov 25 10:00 AM PT = 23:30 IST today**.
2. Firebase: open https://console.firebase.google.com signed in as the gcloud account, choose
   "Create a project" → "Add Firebase to a Google Cloud project" → **tandem-hybrid-ai**, accept the
   terms. Everything after that is scripted. Functions need Blaze: linking the existing billing
   account is a spending decision, so it waits for an explicit yes.
3. ~~Disk space~~ — **resolved**: 245 GB free after cleanup (Chrome's 22 GB gate and Xcode both fit).
4. `chrome://on-device-internals` result on this Mac.
5. Which Android phone (model) is on hand? Which iPhone (model, iOS version, Apple Intelligence on)?

## Decisions

- **D1 — compressed schedule** (above). Web + Android are the two guaranteed platforms; iOS is
  attempted only if an Apple Intelligence iPhone and Xcode are both available by Nov 28.
- **D2 — Firebase CLI as a workspace dev dependency** rather than a global install, so a fresh
  clone works with `pnpm exec firebase`.
- **D3 — `firebase.json` at the repo root** (not under `firebase/`) because the CLI resolves it from
  the working directory; rules, indexes and the RC template live in `firebase/`.
- **D4 — repair margins:** holdout slack 0.10, regression non-inferiority margin 0.10 (ADR 0003).
- **D5 — default project id `demo-tandem`** so emulators run offline with no real project.
