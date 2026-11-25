/**
 * Tandem Cloud Functions — orchestration only, no inference (ADR 0001).
 * APIs checked against the installed firebase-functions 7.4.0 and firebase-admin 14.5.1 typings.
 */
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { getRemoteConfig } from "firebase-admin/remote-config";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import type { Policy, TelemetryEvent } from "@tandem/core";
import { aggId, aggregate, demotedPolicy, demotions, HOUR_MS, hourOf, ROLLBACK_WINDOW_MS } from "./telemetry.js";
import {
  checkPairing,
  checkPublish,
  policyKey,
  policyParameter,
  reap,
  Rejection,
  type PairRequest,
  type PublishRequest,
} from "./logic.js";

initializeApp();
const db = getFirestore();
const REGION = "us-central1";
/** Remote Config has no emulator; locally the policy is recorded in Firestore only. */
const emulated = process.env.FUNCTIONS_EMULATOR === "true";

const asHttps = (e: unknown): never => {
  if (e instanceof Rejection) throw new HttpsError(e.code, e.message);
  throw e;
};

/**
 * Publish a compiled policy: validate, write `tandem_policy_<featureId>` into the Remote Config
 * template (ETag-guarded by the Admin SDK), then record the version in Firestore. Apps listening
 * with onConfigUpdate apply it within seconds, with no app release.
 */
export const publishPolicy = onCall<PublishRequest>({ region: REGION, enforceAppCheck: !emulated }, async (req) => {
  const { pid, featureId } = req.data ?? ({} as PublishRequest);
  if (typeof pid !== "string" || !pid) throw new HttpsError("invalid-argument", "pid required");
  const project = await db.doc(`projects/${pid}`).get();
  const latest = await db
    .collection(`projects/${pid}/policies`)
    .where("featureId", "==", featureId)
    .orderBy("version", "desc")
    .limit(1)
    .get();
  let policy;
  try {
    policy = checkPublish(req.data, {
      uid: req.auth?.uid,
      memberUids: project.exists ? (project.get("memberUids") as string[]) : undefined,
      latestVersion: (latest.docs[0]?.get("version") as number | undefined) ?? 0,
    });
  } catch (e) {
    asHttps(e);
  }

  const rcVersion = await writePolicy(pid, featureId, policy!, {
    publishedBy: req.auth!.uid,
    reason: typeof req.data.reason === "string" ? req.data.reason.slice(0, 200) : "published from a run",
  });
  logger.info("policy published", { pid, featureId, version: policy!.version, rcVersion });
  return { version: policy!.version, rcVersion: rcVersion ?? null };
});

/**
 * Write a policy version. The Firestore record is created first with `create`, which claims the
 * version atomically: two writers racing for the same version cannot both get past it. Then Remote
 * Config (ETag-guarded). If Remote Config fails the claim is released, so the record never says a
 * version is live when apps cannot see it.
 */
async function writePolicy(pid: string, featureId: string, policy: Policy, meta: { publishedBy: string; reason: string }) {
  const ref = db.doc(`projects/${pid}/policies/${featureId}-v${policy.version}`);
  await ref.create({
    featureId,
    version: policy.version,
    policy,
    publishedAt: FieldValue.serverTimestamp(),
    ...meta,
    remoteConfig: emulated ? "skipped (emulator)" : "publishing",
  });
  if (emulated) return undefined;
  try {
    const rc = getRemoteConfig();
    const template = await rc.getTemplate();
    template.parameters[policyKey(featureId)] = policyParameter(policy);
    await rc.validateTemplate(template);
    const published = await rc.publishTemplate(template); // 412 if the template changed meanwhile
    const rcVersion = published.version?.versionNumber;
    await ref.update({ remoteConfig: { key: policyKey(featureId), version: rcVersion ?? null } });
    return rcVersion;
  } catch (e) {
    await ref.delete();
    throw e;
  }
}

/** A runner app redeems a 6-character code shown in the console and becomes the project's runner. */
export const claimPairing = onCall<PairRequest>({ region: REGION, enforceAppCheck: !emulated }, async (req) => {
  const code = req.data?.code;
  if (typeof code !== "string") throw new HttpsError("invalid-argument", "code required");
  const pairRef = db.doc(`pairings/${code.toUpperCase()}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(pairRef);
    let ok;
    try {
      ok = checkPairing(
        { ...req.data, code: code.toUpperCase() },
        req.auth?.uid,
        snap.exists
          ? {
              pid: snap.get("pid") as string,
              createdBy: snap.get("createdBy") as string,
              expiresAtMs: (snap.get("expiresAt") as Timestamp).toMillis(),
            }
          : undefined,
        Date.now(),
      );
    } catch (e) {
      return asHttps(e);
    }
    tx.update(db.doc(`projects/${ok.pid}`), { runnerUids: FieldValue.arrayUnion(req.auth!.uid) });
    tx.set(db.doc(`projects/${ok.pid}/devices/${req.auth!.uid}`), {
      ...ok.device,
      lastSeen: FieldValue.serverTimestamp(),
    });
    tx.delete(pairRef);
    return { pid: ok.pid };
  });
});

/** Requeue jobs whose runner vanished mid-lease; give up after MAX_LEASE_ATTEMPTS (ADR 0004). */
export const reapLeases = onSchedule({ schedule: "every 1 minutes", region: REGION }, async () => {
  const expired = await db
    .collectionGroup("jobs")
    .where("state", "==", "leased")
    .where("leaseExpiresAt", "<", Timestamp.now())
    .limit(400)
    .get();
  if (expired.empty) return;
  const batch = db.batch();
  for (const d of expired.docs) {
    const next = reap({ attempt: (d.get("attempt") as number) ?? 0 });
    batch.update(d.ref, {
      ...next,
      leaseOwner: FieldValue.delete(),
      leaseExpiresAt: FieldValue.delete(),
    });
  }
  await batch.commit();
  logger.info("reaped leases", { count: expired.size });
});

const rawSince = (pid: string, sinceMs: number) =>
  db
    .collection(`projects/${pid}/telemetry_raw`)
    .where("ts", ">=", sinceMs)
    .get()
    .then((q) => q.docs.map((d) => {
      const { expireAt: _expireAt, ...e } = d.data();
      return e as TelemetryEvent;
    }));

/**
 * Hourly rollups of content-free runtime telemetry into `telemetry_agg` (kept after raw events
 * expire). The current and previous hour are recomputed from raw each run, so it is idempotent.
 */
export const aggregateTelemetry = onSchedule({ schedule: "every 5 minutes", region: REGION }, async () => {
  const projects = await db.collection("projects").select().get();
  for (const p of projects.docs) {
    const events = await rawSince(p.id, hourOf(Date.now()) - HOUR_MS);
    if (events.length === 0) continue;
    const batch = db.batch();
    for (const a of aggregate(events))
      batch.set(db.doc(`projects/${p.id}/telemetry_agg/${aggId(a.featureId, a.modelId, a.hour)}`), { ...a, updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
    logger.info("telemetry aggregated", { pid: p.id, events: events.length });
  }
});

/**
 * Demote a live on-device rule when the Wilson lower bound of its escalation or error rate over the
 * last hour of field traffic exceeds the threshold (core rollbackDecision). Publishes the next policy
 * version through the same path as a human publish and records an incident.
 */
export const autoRollback = onSchedule({ schedule: "every 5 minutes", region: REGION }, async () => {
  const projects = await db.collection("projects").select().get();
  for (const p of projects.docs) {
    const policies = await db.collection(`projects/${p.id}/policies`).orderBy("version", "desc").get();
    const live = new Map<string, Policy>();
    for (const d of policies.docs) {
      const f = d.get("featureId") as string;
      if (!live.has(f)) live.set(f, d.get("policy") as Policy);
    }
    if (live.size === 0) continue;
    const events = await rawSince(p.id, Date.now() - ROLLBACK_WINDOW_MS);
    for (const policy of live.values()) {
      const ds = demotions(policy, events);
      if (ds.length === 0) continue;
      const next = demotedPolicy(policy, ds.map((d) => d.target), new Date());
      try {
        await writePolicy(p.id, policy.featureId, next, {
          publishedBy: "autoRollback",
          reason: `auto-rollback: ${ds.map((d) => `${d.target} ${d.decision.metric} LB ${d.decision.lowerBound.toFixed(3)} > ${d.decision.threshold}`).join("; ")}`.slice(0, 200),
        });
      } catch (e) {
        logger.warn("rollback publish lost a race; next run re-evaluates", { pid: p.id, featureId: policy.featureId, error: String(e) });
        continue;
      }
      const batch = db.batch();
      for (const d of ds)
        batch.set(db.collection(`projects/${p.id}/incidents`).doc(), {
          kind: "AUTO_ROLLBACK",
          featureId: policy.featureId,
          target: d.target,
          fromVersion: policy.version,
          toVersion: next.version,
          metric: d.decision.metric,
          observed: d.decision.observed,
          lowerBound: d.decision.lowerBound,
          threshold: d.decision.threshold,
          window: { ...d.window, ms: ROLLBACK_WINDOW_MS },
          at: FieldValue.serverTimestamp(),
        });
      await batch.commit();
      logger.warn("auto-rollback", { pid: p.id, featureId: policy.featureId, toVersion: next.version, targets: ds.map((d) => d.target) });
    }
  }
});
