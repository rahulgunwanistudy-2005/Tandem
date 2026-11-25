import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
} from "firebase/firestore";

/**
 * Security-rules tests on the Firestore emulator.
 * Run: pnpm --filter @tandem/firebase test:rules
 */

let env: RulesTestEnvironment;
const P = "projects/p1";
const OWNER = "owner";
const MEMBER = "member";
const RUNNER = "runner-android";
const STRANGER = "stranger";
const inSec = (s: number) => Timestamp.fromMillis(Date.now() + s * 1000);

const db = (uid: string | null) =>
  uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-tandem",
    firestore: { rules: readFileSync(join(import.meta.dirname, "../firestore.rules"), "utf8") },
  });
});
afterAll(async () => env?.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const a = ctx.firestore();
    await setDoc(doc(a, P), {
      name: "Counter",
      ownerUid: OWNER,
      memberUids: [OWNER, MEMBER],
      runnerUids: [RUNNER],
      settings: { tau: 0.85 },
    });
    await setDoc(doc(a, `${P}/features/triage`), { name: "Triage" });
    await setDoc(doc(a, `${P}/features/triage/variants/v1`), {
      promptTemplate: "x {{input}}",
      sha256: "a".repeat(64),
      origin: "human",
    });
    await setDoc(doc(a, `${P}/features/triage/cases/c1`), {
      input: { text: "hi" },
      split: "train",
    });
    await setDoc(doc(a, `${P}/devices/${RUNNER}`), {
      platform: "android",
      modelId: "android:nano-v4",
      runnerUid: RUNNER,
    });
    await setDoc(doc(a, `${P}/runs/r1`), { createdBy: OWNER, status: "running" });
    await setDoc(doc(a, `${P}/runs/r1/jobs/j-android`), {
      target: "android:nano-v4",
      state: "queued",
      attempt: 0,
      caseId: "c1",
    });
    await setDoc(doc(a, `${P}/runs/r1/jobs/j-chrome`), {
      target: "chrome:158",
      state: "queued",
      attempt: 0,
      caseId: "c1",
    });
    await setDoc(doc(a, `${P}/policies/1`), { version: 1 });
    await setDoc(doc(a, "projects/p2"), {
      name: "Other",
      ownerUid: STRANGER,
      memberUids: [STRANGER],
      runnerUids: [],
    });
  });
});

describe("projects", () => {
  it("members and runners read; strangers and anonymous do not", async () => {
    await assertSucceeds(getDoc(doc(db(MEMBER), P)));
    await assertSucceeds(getDoc(doc(db(RUNNER), P)));
    await assertFails(getDoc(doc(db(STRANGER), P)));
    await assertFails(getDoc(doc(db(null), P)));
  });

  it("anyone signed in can create a project they own, alone, with no runners", async () => {
    await assertSucceeds(
      setDoc(doc(db(STRANGER), "projects/new"), {
        name: "Mine",
        ownerUid: STRANGER,
        memberUids: [STRANGER],
        runnerUids: [],
      }),
    );
    await assertFails(
      setDoc(doc(db(STRANGER), "projects/new2"), {
        name: "x",
        ownerUid: OWNER,
        memberUids: [STRANGER],
      }),
    );
    await assertFails(
      setDoc(doc(db(STRANGER), "projects/new3"), {
        name: "x",
        ownerUid: STRANGER,
        memberUids: [STRANGER, OWNER],
      }),
    );
    await assertFails(
      setDoc(doc(db(STRANGER), "projects/new4"), {
        name: "x",
        ownerUid: STRANGER,
        memberUids: [STRANGER],
        runnerUids: [STRANGER],
      }),
    );
    await assertFails(
      setDoc(doc(db(STRANGER), "projects/new5"), {
        name: "",
        ownerUid: STRANGER,
        memberUids: [STRANGER],
      }),
    );
  });

  it("members edit settings; only the owner manages members; nobody adds runners from a client", async () => {
    await assertSucceeds(updateDoc(doc(db(MEMBER), P), { settings: { tau: 0.9 } }));
    await assertFails(updateDoc(doc(db(MEMBER), P), { memberUids: [OWNER, MEMBER, STRANGER] }));
    await assertSucceeds(updateDoc(doc(db(OWNER), P), { memberUids: [OWNER, MEMBER, STRANGER] }));
    await assertFails(updateDoc(doc(db(OWNER), P), { memberUids: [MEMBER] }));
    await assertFails(updateDoc(doc(db(OWNER), P), { runnerUids: [RUNNER, STRANGER] }));
    await assertSucceeds(updateDoc(doc(db(OWNER), P), { runnerUids: [] }));
    await assertFails(updateDoc(doc(db(OWNER), P), { ownerUid: MEMBER }));
    await assertFails(updateDoc(doc(db(RUNNER), P), { settings: {} }));
    await assertFails(deleteDoc(doc(db(MEMBER), P)));
    await assertSucceeds(deleteDoc(doc(db(OWNER), P)));
  });
});

describe("authoring data", () => {
  it("runners read features and cases but cannot write them", async () => {
    await assertSucceeds(getDoc(doc(db(RUNNER), `${P}/features/triage/cases/c1`)));
    await assertFails(
      setDoc(doc(db(RUNNER), `${P}/features/triage/cases/c2`), { input: { text: "x" } }),
    );
    await assertSucceeds(
      setDoc(doc(db(MEMBER), `${P}/features/triage/cases/c2`), { input: { text: "x" } }),
    );
    await assertFails(getDoc(doc(db(STRANGER), `${P}/features/triage`)));
  });

  it("variants are immutable and validated", async () => {
    const ok = {
      promptTemplate: "Classify {{input}}",
      sha256: "b".repeat(64),
      origin: "repair",
      systemInstruction: "",
    };
    await assertSucceeds(setDoc(doc(db(MEMBER), `${P}/features/triage/variants/v2`), ok));
    await assertFails(
      setDoc(doc(db(MEMBER), `${P}/features/triage/variants/v3`), {
        ...ok,
        promptTemplate: "no placeholder",
      }),
    );
    await assertFails(
      setDoc(doc(db(MEMBER), `${P}/features/triage/variants/v4`), { ...ok, sha256: "nope" }),
    );
    await assertFails(
      updateDoc(doc(db(MEMBER), `${P}/features/triage/variants/v1`), {
        promptTemplate: "y {{input}}",
      }),
    );
    await assertFails(deleteDoc(doc(db(OWNER), `${P}/features/triage/variants/v1`)));
  });
});

describe("devices", () => {
  it("a runner registers only its own device, with a consistent modelId", async () => {
    const d = {
      platform: "android",
      modelId: "android:nano-v4",
      runnerUid: RUNNER,
      availability: "available",
    };
    await assertSucceeds(setDoc(doc(db(RUNNER), `${P}/devices/${RUNNER}`), d));
    await assertFails(setDoc(doc(db(RUNNER), `${P}/devices/someone-else`), d));
    await assertFails(
      setDoc(doc(db(RUNNER), `${P}/devices/${RUNNER}`), { ...d, modelId: "chrome:158" }),
    );
    await assertFails(
      setDoc(doc(db(RUNNER), `${P}/devices/${RUNNER}`), {
        ...d,
        platform: "cloud",
        modelId: "cloud:x",
      }),
    );
    await assertFails(setDoc(doc(db(RUNNER), `${P}/devices/${RUNNER}`), { ...d, secret: 1 }));
    await assertFails(
      setDoc(doc(db(STRANGER), `${P}/devices/${STRANGER}`), { ...d, runnerUid: STRANGER }),
    );
  });
  it("the console user registers the Chrome tab as a device too", async () => {
    await assertSucceeds(
      setDoc(doc(db(MEMBER), `${P}/devices/${MEMBER}`), {
        platform: "chrome",
        modelId: "chrome:158",
        runnerUid: MEMBER,
      }),
    );
  });
});

describe("job lease state machine", () => {
  const job = (uid: string, id = "j-android") => doc(db(uid), `${P}/runs/r1/jobs/${id}`);
  const claim = (uid: string, extra: Record<string, unknown> = {}) => ({
    state: "leased",
    leaseOwner: uid,
    leaseExpiresAt: inSec(60),
    attempt: 1,
    ...extra,
  });

  it("a runner claims only jobs for its own model", async () => {
    await assertSucceeds(updateDoc(job(RUNNER), claim(RUNNER)));
    await assertFails(updateDoc(job(RUNNER, "j-chrome"), claim(RUNNER)));
  });

  it("members' consoles claim cloud reference jobs; runners and strangers cannot", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `${P}/runs/r1/jobs/j-cloud`), {
        target: "cloud:gemini-3.5-flash-lite",
        state: "queued",
        attempt: 0,
        caseId: "c1",
      });
    });
    await assertFails(updateDoc(job(RUNNER, "j-cloud"), claim(RUNNER)));
    await assertFails(updateDoc(job(STRANGER, "j-cloud"), claim(STRANGER)));
    await assertSucceeds(updateDoc(job(MEMBER, "j-cloud"), claim(MEMBER)));
    await assertSucceeds(
      updateDoc(job(MEMBER, "j-cloud"), {
        state: "done",
        result: { modelId: "cloud:gemini-3.5-flash-lite", backend: "IN_CLOUD", latencyMs: 640 },
        verdict: "pass",
      }),
    );
    // a member without a matching device still cannot claim device work
    await assertFails(updateDoc(job(MEMBER, "j-chrome"), claim(MEMBER)));
  });

  it("claims must be well-formed", async () => {
    await assertFails(updateDoc(job(RUNNER), claim(MEMBER)));
    await assertFails(updateDoc(job(RUNNER), claim(RUNNER, { attempt: 5 })));
    await assertFails(updateDoc(job(RUNNER), claim(RUNNER, { leaseExpiresAt: inSec(3600) })));
    await assertFails(updateDoc(job(RUNNER), claim(RUNNER, { leaseExpiresAt: inSec(-5) })));
    await assertFails(updateDoc(job(RUNNER), claim(RUNNER, { result: { backend: "ON_DEVICE" } })));
    await assertFails(updateDoc(job(STRANGER), claim(STRANGER)));
  });

  it("a leased job cannot be claimed again", async () => {
    await assertSucceeds(updateDoc(job(RUNNER), claim(RUNNER)));
    await assertFails(updateDoc(job(RUNNER), claim(RUNNER, { attempt: 2 })));
  });

  it("only the lease owner heartbeats and completes, and the reported model must match", async () => {
    await assertSucceeds(updateDoc(job(RUNNER), claim(RUNNER)));
    await assertSucceeds(updateDoc(job(RUNNER), { leaseExpiresAt: inSec(90) }));
    await assertFails(updateDoc(job(MEMBER), { leaseExpiresAt: inSec(90) }));
    const result = {
      modelId: "android:nano-v4",
      backend: "ON_DEVICE",
      latencyMs: 812,
      inputChars: 300,
      outputText: "{}",
    };
    await assertFails(
      updateDoc(job(RUNNER), { state: "done", result: { ...result, modelId: "android:nano-v3" } }),
    );
    await assertFails(
      updateDoc(job(RUNNER), { state: "done", result: { ...result, backend: "SOMEWHERE" } }),
    );
    await assertFails(updateDoc(job(MEMBER), { state: "done", result }));
    await assertSucceeds(
      updateDoc(job(RUNNER), {
        state: "done",
        result,
        verdict: "pending_judge",
        completedAt: serverTimestamp(),
      }),
    );
    // finished jobs are frozen for runners
    await assertFails(updateDoc(job(RUNNER), { leaseExpiresAt: inSec(90) }));
  });

  it("the console attaches judge results to finished jobs and cancels unfinished ones", async () => {
    await assertFails(updateDoc(job(MEMBER), { judge: { pass: true } }));
    await assertSucceeds(updateDoc(job(MEMBER, "j-chrome"), { state: "failed" }));
    await assertSucceeds(updateDoc(job(RUNNER), claim(RUNNER)));
    await assertSucceeds(
      updateDoc(job(RUNNER), {
        state: "done",
        result: { modelId: "android:nano-v4", backend: "ON_DEVICE", latencyMs: 1 },
      }),
    );
    await assertSucceeds(
      updateDoc(job(MEMBER), { judge: { pass: true, score: 1, reason: "ok" }, verdict: "pass" }),
    );
    await assertFails(
      updateDoc(job(MEMBER), {
        result: { modelId: "android:nano-v4", backend: "ON_DEVICE", latencyMs: 0 },
      }),
    );
  });

  it("members create queued jobs only", async () => {
    const col = collection(db(MEMBER), `${P}/runs/r1/jobs`);
    await assertSucceeds(addDoc(col, { target: "ios:26.1", state: "queued", attempt: 0 }));
    await assertFails(addDoc(col, { target: "ios:26.1", state: "done", attempt: 0 }));
    await assertFails(addDoc(col, { target: "ios:26.1", state: "queued", attempt: 0, result: {} }));
    await assertFails(
      addDoc(collection(db(RUNNER), `${P}/runs/r1/jobs`), {
        target: "android:nano-v4",
        state: "queued",
        attempt: 0,
      }),
    );
  });
});

describe("function-owned collections", () => {
  it("policies, incidents and aggregates are read-only to clients", async () => {
    await assertSucceeds(getDoc(doc(db(MEMBER), `${P}/policies/1`)));
    await assertFails(getDoc(doc(db(RUNNER), `${P}/policies/1`)));
    await assertFails(setDoc(doc(db(OWNER), `${P}/policies/2`), { version: 2 }));
    await assertFails(setDoc(doc(db(OWNER), `${P}/incidents/i1`), {}));
    await assertFails(setDoc(doc(db(OWNER), `${P}/telemetry_agg/a1`), {}));
  });
  it("judge cache is create-only", async () => {
    const key = "c".repeat(64);
    await assertSucceeds(
      setDoc(doc(db(MEMBER), `${P}/judge_cache/${key}`), {
        pass: true,
        score: 0.9,
        reason: "ok",
        model: "gemini-3.8-flash",
      }),
    );
    await assertFails(
      setDoc(doc(db(MEMBER), `${P}/judge_cache/${key}`), {
        pass: false,
        score: 0,
        reason: "flip",
        model: "x",
      }),
    );
    await assertFails(setDoc(doc(db(MEMBER), `${P}/judge_cache/short`), { pass: true }));
  });
});

describe("telemetry", () => {
  const event = (id: string) => ({
    eventId: id,
    featureId: "triage",
    modelId: "android:nano-v4",
    platform: "android",
    policyVersion: 3,
    variantId: "v1",
    mode: "PREFER_ON_DEVICE",
    backend: "ON_DEVICE",
    latencyMs: 1204,
    validation: "pass",
    escalated: false,
    ts: Date.now(),
    sdk: "android/0.1.0",
    expireAt: inSec(7 * 86400),
  });
  const ref = (uid: string | null, id: string) => doc(db(uid), `${P}/telemetry_raw/${id}`);

  it("any signed-in app may create a well-formed, content-free event", async () => {
    await assertSucceeds(setDoc(ref(STRANGER, "evt_00000001"), event("evt_00000001")));
    await assertSucceeds(
      setDoc(ref(STRANGER, "evt_00000002"), { ...event("evt_00000002"), errorCode: "BUSY" }),
    );
  });
  it("rejects content fields, bad shapes, unauthenticated writes and edits", async () => {
    await assertFails(
      setDoc(ref(STRANGER, "evt_00000003"), { ...event("evt_00000003"), outputText: "secret" }),
    );
    await assertFails(
      setDoc(ref(STRANGER, "evt_00000004"), { ...event("evt_00000004"), prompt: "secret" }),
    );
    await assertFails(
      setDoc(ref(STRANGER, "evt_00000005"), { ...event("evt_00000005"), backend: "MARS" }),
    );
    await assertFails(
      setDoc(ref(STRANGER, "evt_00000006"), { ...event("evt_00000006"), latencyMs: -1 }),
    );
    await assertFails(
      setDoc(ref(STRANGER, "evt_00000007"), { ...event("evt_00000007"), errorCode: "OOPS" }),
    );
    await assertFails(
      setDoc(ref(STRANGER, "evt_00000008"), {
        ...event("evt_00000008"),
        expireAt: inSec(30 * 86400),
      }),
    );
    await assertFails(setDoc(ref(STRANGER, "evt_00000009"), event("evt_mismatch")));
    await assertFails(setDoc(ref(null, "evt_00000010"), event("evt_00000010")));
    await assertFails(
      setDoc(doc(db(STRANGER), "projects/nope/telemetry_raw/evt_00000011"), event("evt_00000011")),
    );
    await assertSucceeds(setDoc(ref(STRANGER, "evt_00000012"), event("evt_00000012")));
    await assertFails(updateDoc(ref(STRANGER, "evt_00000012"), { latencyMs: 1 }));
    await assertFails(getDoc(ref(STRANGER, "evt_00000012")));
    await assertSucceeds(getDoc(ref(MEMBER, "evt_00000012")));
  });
});

describe("pairing codes", () => {
  const code = (uid: string, c: string, extra: Record<string, unknown> = {}) =>
    setDoc(doc(db(uid), `pairings/${c}`), {
      pid: "p1",
      createdBy: uid,
      expiresAt: inSec(300),
      ...extra,
    });

  it("members create short-lived codes for their project", async () => {
    await assertSucceeds(code(MEMBER, "ABC234"));
    await assertSucceeds(getDoc(doc(db(OWNER), "pairings/ABC234")));
    await assertFails(getDoc(doc(db(RUNNER), "pairings/ABC234")));
  });
  it("rejects strangers, long TTLs, bad codes and client claims", async () => {
    await assertFails(code(STRANGER, "ABC235"));
    await assertFails(code(MEMBER, "ABC236", { expiresAt: inSec(3600) }));
    await assertFails(code(MEMBER, "abc237"));
    await assertFails(code(MEMBER, "ABC10O")); // ambiguous characters are excluded
    await assertFails(code(MEMBER, "ABC238", { createdBy: OWNER }));
    await assertSucceeds(code(MEMBER, "ABC239"));
    await assertFails(updateDoc(doc(db(RUNNER), "pairings/ABC239"), { claimedBy: RUNNER }));
  });
});
