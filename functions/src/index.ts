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

  let rcVersion: string | undefined;
  if (!emulated) {
    const rc = getRemoteConfig();
    const template = await rc.getTemplate();
    template.parameters[policyKey(featureId)] = policyParameter(policy!);
    await rc.validateTemplate(template);
    const published = await rc.publishTemplate(template); // 412 if someone published meanwhile
    rcVersion = published.version?.versionNumber;
  }

  const ref = db.doc(`projects/${pid}/policies/${featureId}-v${policy!.version}`);
  await ref.create({
    featureId,
    version: policy!.version,
    policy: policy!,
    publishedAt: FieldValue.serverTimestamp(),
    publishedBy: req.auth!.uid,
    reason: typeof req.data.reason === "string" ? req.data.reason.slice(0, 200) : "published from a run",
    remoteConfig: emulated ? "skipped (emulator)" : { key: policyKey(featureId), version: rcVersion ?? null },
  });
  logger.info("policy published", { pid, featureId, version: policy!.version, rcVersion });
  return { version: policy!.version, rcVersion: rcVersion ?? null };
});

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
