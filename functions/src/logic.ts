/**
 * Pure decision logic for the Cloud Functions, kept free of Firebase so it is unit-tested.
 * The functions themselves (index.ts) only read, call these, and write.
 */
import { isModelId, type ModelId, type Policy } from "@tandem/core";
import { parsePolicy } from "../../packages/runtime-web/src/policy.js";

export const POLICY_KEY_PREFIX = "tandem_policy_";
export const policyKey = (featureId: string) => `${POLICY_KEY_PREFIX}${featureId}`;
export const MAX_LEASE_ATTEMPTS = 3;
export const PAIR_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const FEATURE_ID = /^[a-z][a-z0-9_-]{0,63}$/;

export class Rejection extends Error {
  constructor(
    readonly code: "invalid-argument" | "permission-denied" | "failed-precondition" | "not-found" | "aborted",
    message: string,
  ) {
    super(message);
  }
}

export interface PublishRequest {
  pid: string;
  featureId: string;
  policy: unknown;
  /** The version the caller compiled against (0 = nothing published yet). */
  expectedVersion: number;
  reason?: string;
}

/**
 * Validate a publish: the caller must be a project member, the policy must be well formed and for
 * this feature, and its version must be exactly the next one (optimistic concurrency: two people
 * publishing from stale screens cannot overwrite each other).
 */
export function checkPublish(
  req: PublishRequest,
  ctx: { uid: string | undefined; memberUids: string[] | undefined; latestVersion: number },
): Policy {
  if (!ctx.uid) throw new Rejection("permission-denied", "sign in to publish");
  if (!ctx.memberUids) throw new Rejection("not-found", "project not found");
  if (!ctx.memberUids.includes(ctx.uid)) throw new Rejection("permission-denied", "not a member of this project");
  if (typeof req.featureId !== "string" || !FEATURE_ID.test(req.featureId))
    throw new Rejection("invalid-argument", "bad featureId");
  const parsed = parsePolicy(JSON.stringify(req.policy ?? null), req.featureId);
  if (!parsed.ok) throw new Rejection("invalid-argument", `policy rejected: ${parsed.error}`);
  if (req.expectedVersion !== ctx.latestVersion)
    throw new Rejection("aborted", `policy changed since you compiled (live v${ctx.latestVersion}, you saw v${req.expectedVersion})`);
  if (parsed.policy.version !== ctx.latestVersion + 1)
    throw new Rejection("invalid-argument", `version must be ${ctx.latestVersion + 1}`);
  return parsed.policy;
}

export interface PairRequest {
  code: string;
  device: { platform: "android" | "ios" | "chrome"; modelId: string; label?: string; osVersion?: string };
}

export interface PairingDoc {
  pid: string;
  createdBy: string;
  expiresAtMs: number;
  claimedBy?: string;
}

/** Validate a pairing claim from a runner app. */
export function checkPairing(req: PairRequest, uid: string | undefined, pairing: PairingDoc | undefined, nowMs: number) {
  if (!uid) throw new Rejection("permission-denied", "sign in first");
  if (typeof req.code !== "string" || !PAIR_CODE.test(req.code)) throw new Rejection("invalid-argument", "bad code");
  if (!pairing) throw new Rejection("not-found", "unknown or used code");
  if (pairing.claimedBy) throw new Rejection("failed-precondition", "code already used");
  if (pairing.expiresAtMs <= nowMs) throw new Rejection("failed-precondition", "code expired");
  const d = req.device;
  if (!d || !["android", "ios", "chrome"].includes(d.platform)) throw new Rejection("invalid-argument", "bad platform");
  if (!isModelId(d.modelId) || d.modelId.split(":")[0] !== d.platform || d.modelId.endsWith(":*"))
    throw new Rejection("invalid-argument", "modelId must be <platform>:<model> for this platform");
  return {
    pid: pairing.pid,
    device: {
      platform: d.platform,
      modelId: d.modelId as ModelId,
      label: (d.label ?? d.platform).slice(0, 80),
      osVersion: (d.osVersion ?? "unknown").slice(0, 40),
      availability: "unknown",
      runnerUid: uid,
    },
  };
}

/** What to do with a leased job whose lease has expired. */
export function reap(job: { attempt: number }): { state: "queued" } | { state: "failed"; verdict: "error" } {
  return job.attempt >= MAX_LEASE_ATTEMPTS ? { state: "failed", verdict: "error" } : { state: "queued" };
}

/** Remote Config parameter for a policy. JSON type so the console shows it structured. */
export function policyParameter(policy: Policy) {
  return {
    defaultValue: { value: JSON.stringify(policy) },
    valueType: "JSON" as const,
    description: `Tandem routing for "${policy.featureId}" v${policy.version} (compiled ${policy.compiledAt}).`,
  };
}
