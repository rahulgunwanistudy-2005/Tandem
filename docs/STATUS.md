# STATUS

_Last updated: 2026-11-25 (IST)._

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

## Next

1. `packages/runtime-web` (`tandem.generate` with verified fallback, telemetry batching).
2. `apps/console`: auth, projects, features/cases editor, Chrome runner with leasing, cloud reference,
   judge + cache, live run matrix. Needs the Firebase project (see Blocked).
3. `functions/`: `claimPairing`, `publishPolicy` (ETag), `reapLeases`.
4. Android runtime + runner + Counter (needs Android SDK + device).

## Blocked (needs Rahul)

1. Hackathon quota account — Sprint 3 request closes **Nov 25 10:00 AM PT = 23:30 IST today**.
2. Firebase project with AI Logic (Gemini Developer API), App Check, Firestore, Auth (Anonymous +
   Google), Remote Config, Functions (Blaze), Hosting; budget alert.
3. Disk space: free ≥ 25 GB so Chrome's Nano gate passes (and more if iOS is in scope).
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
