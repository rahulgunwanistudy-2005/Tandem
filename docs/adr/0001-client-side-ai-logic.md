# ADR 0001 — All inference, including judge and repair, runs through Firebase AI Logic on App Check–protected clients

**Status:** accepted (2026-11-25)

## Context

Tandem needs three kinds of cloud inference besides the on-device runs: a cloud reference answer,
a judge verdict, and repair proposals. The usual pattern is a Cloud Function holding a Gemini API key.

## Decision

Every model call — device and cloud — goes through the Firebase AI Logic client SDK from the console
(`ONLY_IN_CLOUD` for reference, judge and repair). Cloud Functions do orchestration only (Remote Config
admin, pairing, aggregation, rollback, lease reaping). Model names come from Remote Config.

## Consequences

- No Gemini API key exists anywhere in the project; App Check (enforced since Nov 2, 2026) and AI Logic
  per-user rate limits protect the endpoint.
- The same SDK surface is exercised for every call, so the hybrid path _is_ the product, not a demo.
- Judge cost is paid per console user, capped by rate limits; the judge cache (ADR 0002 hash) avoids
  paying twice.
