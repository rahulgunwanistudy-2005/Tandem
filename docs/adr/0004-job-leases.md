# ADR 0004 — Jobs are claimed with transactional leases, executed sequentially per device

**Status:** accepted (2026-11-25)

## Context

Phones sleep, tabs close, AICore returns BUSY. A run must survive a runner disappearing mid-job, and
on-device inference is single-stream, so parallelism on one device only adds contention.

## Decision

A runner claims queued jobs whose `target` equals its own device `modelId` in a Firestore transaction,
setting `leaseOwner`, `leaseExpiresAt = now + 60 s` (rules cap it at 120 s) and `attempt + 1`, and
heartbeats while working. `reapLeases` (scheduled) requeues expired leases up to an attempt cap. The
state machine is enforced in `firestore.rules` and tested in `firebase/test/rules.test.ts`; a completed
result must report the job's own target as `modelId`.

## Consequences

No job runs twice concurrently; a dead runner delays a run by at most one lease period; the rules, not
client code, guarantee a device cannot claim another model's work.
