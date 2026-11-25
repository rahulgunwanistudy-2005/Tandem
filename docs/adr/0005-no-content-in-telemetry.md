# ADR 0005 — Runtime telemetry carries no content

**Status:** accepted (2026-11-25)

## Context

Firebase AI Monitoring shows nothing for on-device calls, so Tandem's runtime SDK reports its own
telemetry. On-device inference is often chosen _for_ privacy; shipping prompts or outputs to a server
would defeat the reason the developer chose the device.

## Decision

A telemetry event is a fixed set of operational fields — feature, model id, policy version, mode,
backend, latency, validation result, escalation flag, error code, timestamp, SDK version
(`contracts/telemetry.schema.json`). Both the JSON Schema and the Firestore rules use an exact
allowlist, so a client that tries to add `prompt` or `outputText` is rejected. Raw events expire after
7 days (Firestore TTL on `expireAt`); hourly aggregates are kept.

## Consequences

Tandem can show on-device share, escalations, latency and errors per model without ever holding user
content. It cannot show _what_ failed in production — that is what test runs are for.
