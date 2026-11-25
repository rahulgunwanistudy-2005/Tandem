import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  addDoc,
  limit,
  type DocumentData,
  type Firestore,
  type Query,
  type Unsubscribe,
} from "firebase/firestore";
import type { Case, Feature, Job, ModelId, Policy, Variant } from "@tandem/core";
import type { JudgeCache, JudgeVerdict } from "../judge.js";
import type { Catalog } from "../runner/loop.js";
import { planJobs, type RunPlan } from "./plan.js";
import type { SeedFeature } from "./seed.js";

export interface ProjectSettings {
  tau: number;
  minN: number;
}

export interface Project {
  id: string;
  name: string;
  ownerUid: string;
  memberUids: string[];
  runnerUids: string[];
  settings: ProjectSettings;
}

export interface Run {
  id: string;
  featureId: string;
  variantIds: string[];
  targets: ModelId[];
  samples: number;
  caseCount: number;
  status: "running" | "complete" | "cancelled";
  createdBy: string;
  createdAt?: Timestamp;
  label?: string;
}

export interface Device {
  id: string;
  platform: "chrome" | "android" | "ios";
  modelId: ModelId;
  osVersion?: string;
  availability: string;
  label?: string;
  lastSeen?: Timestamp;
  runnerUid: string;
}

export interface PublishedPolicy {
  id: string;
  featureId: string;
  version: number;
  policy: Policy;
  publishedAt?: Timestamp;
  publishedBy?: string;
  reason?: string;
}

export const DEFAULT_SETTINGS: ProjectSettings = { tau: 0.85, minN: 30 };

/** Firestore rejects `undefined`; documents are plain JSON. */
export const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const withId = <T>(id: string, data: DocumentData): T => ({ ...data, id }) as T;

function watch<T>(q: Query, cb: (rows: T[]) => void, onError?: (e: Error) => void): Unsubscribe {
  return onSnapshot(
    q,
    (s) => cb(s.docs.map((d) => withId<T>(d.id, d.data()))),
    (e) => onError?.(e),
  );
}

/**
 * A listener that survives errors: Firestore ends a listener on its first error (a rules denial
 * while a just-created project is still committing, a dropped connection), so resubscribe.
 */
function resilient(subscribe: (onError: (e: Error) => void) => Unsubscribe, onError?: (e: Error) => void, retryMs = 3000): Unsubscribe {
  let current: Unsubscribe | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const start = () => {
    current = subscribe((e) => {
      onError?.(e);
      if (!stopped) timer = setTimeout(start, retryMs);
    });
  };
  start();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    current?.();
  };
}

export class Repo {
  constructor(readonly db: Firestore) {}

  private p(pid: string, ...rest: string[]) {
    return ["projects", pid, ...rest] as const;
  }

  // ---------- projects ----------
  /** Only committed projects: a project still being created must not be opened yet. */
  watchProjects(uid: string, cb: (p: Project[]) => void, onError?: (e: Error) => void) {
    return onSnapshot(
      query(collection(this.db, "projects"), where("memberUids", "array-contains", uid)),
      (s) => cb(s.docs.filter((d) => !d.metadata.hasPendingWrites).map((d) => withId<Project>(d.id, d.data()))),
      (e) => onError?.(e),
    );
  }

  watchProject(pid: string, cb: (p: Project | undefined) => void, onError?: (e: Error) => void) {
    return onSnapshot(
      doc(this.db, "projects", pid),
      (s) => cb(s.exists() ? withId<Project>(s.id, s.data()) : undefined),
      (e) => onError?.(e),
    );
  }

  async createProject(name: string, uid: string): Promise<string> {
    const ref = await addDoc(collection(this.db, "projects"), {
      name,
      ownerUid: uid,
      memberUids: [uid],
      runnerUids: [],
      settings: DEFAULT_SETTINGS,
      createdAt: serverTimestamp(),
    });
    return ref.id;
  }

  updateSettings(pid: string, settings: ProjectSettings) {
    return updateDoc(doc(this.db, "projects", pid), { settings });
  }

  /** Writes the demo features, their human variants and cases. Idempotent (fixed ids). */
  async seed(pid: string, features: SeedFeature[]): Promise<void> {
    const batch = writeBatch(this.db);
    for (const { feature, variants, cases } of features) {
      batch.set(doc(this.db, ...this.p(pid, "features", feature.id)), clean(feature));
      for (const v of variants)
        batch.set(doc(this.db, ...this.p(pid, "features", feature.id, "variants", v.id)), {
          ...clean(v),
          createdAt: serverTimestamp(),
        });
      for (const c of cases)
        batch.set(doc(this.db, ...this.p(pid, "features", feature.id, "cases", c.id)), clean(c));
    }
    await batch.commit();
  }

  // ---------- authoring ----------
  watchFeatures(pid: string, cb: (f: Feature[]) => void) {
    return watch<Feature>(collection(this.db, ...this.p(pid, "features")), cb);
  }
  watchVariants(pid: string, fid: string, cb: (v: Variant[]) => void) {
    return watch<Variant>(collection(this.db, ...this.p(pid, "features", fid, "variants")), cb);
  }
  watchCases(pid: string, fid: string, cb: (c: Case[]) => void) {
    return watch<Case>(collection(this.db, ...this.p(pid, "features", fid, "cases")), cb);
  }
  saveCase(pid: string, fid: string, c: Case) {
    return setDoc(doc(this.db, ...this.p(pid, "features", fid, "cases", c.id)), clean(c));
  }
  async addVariant(pid: string, v: Variant) {
    await setDoc(doc(this.db, ...this.p(pid, "features", v.featureId, "variants", v.id)), {
      ...clean(v),
      createdAt: serverTimestamp(),
    });
  }

  /** Read-through cache for the runner: features, variants and cases are fetched once. */
  catalog(pid: string): Catalog {
    const cache = new Map<string, Promise<unknown>>();
    const get = <T>(path: string[]): Promise<T> => {
      const k = path.join("/");
      let hit = cache.get(k) as Promise<T> | undefined;
      if (!hit) {
        hit = getDoc(doc(this.db, path.join("/"))).then((s) => {
          if (!s.exists()) throw new Error(`${k} not found`);
          return withId<T>(s.id, s.data());
        });
        hit.catch(() => cache.delete(k));
        cache.set(k, hit);
      }
      return hit;
    };
    return {
      load: async (fid, vid, cid) => {
        const [feature, variant, testCase] = await Promise.all([
          get<Feature>([...this.p(pid, "features", fid)]),
          get<Variant>([...this.p(pid, "features", fid, "variants", vid)]),
          get<Case>([...this.p(pid, "features", fid, "cases", cid)]),
        ]);
        return { feature, variant, testCase };
      },
    };
  }

  // ---------- runs ----------
  async createRun(pid: string, plan: Omit<RunPlan, "runId">, uid: string, label?: string): Promise<string> {
    const runRef = doc(collection(this.db, ...this.p(pid, "runs")));
    const jobs = planJobs({ ...plan, runId: runRef.id });
    const run: Omit<Run, "id" | "createdAt"> = {
      featureId: plan.featureId,
      variantIds: plan.variantIds,
      targets: plan.targets,
      samples: plan.samples,
      caseCount: plan.cases.length,
      status: "running",
      createdBy: uid,
      ...(label ? { label } : {}),
    };
    await setDoc(runRef, { ...run, createdAt: serverTimestamp() });
    // Firestore batches hold 500 writes; jobs keep plan order through createdAt + a sequence.
    const base = Date.now();
    for (let i = 0; i < jobs.length; i += 450) {
      const batch = writeBatch(this.db);
      jobs.slice(i, i + 450).forEach((j, k) =>
        batch.set(doc(runRef, "jobs", j.id), {
          ...clean(j),
          createdAt: Timestamp.fromMillis(base + i + k),
        }),
      );
      await batch.commit();
    }
    return runRef.id;
  }

  watchRuns(pid: string, fid: string, cb: (r: Run[]) => void) {
    return watch<Run>(
      query(collection(this.db, ...this.p(pid, "runs")), where("featureId", "==", fid)),
      (rows) => cb(rows.sort((a, b) => (b.createdAt?.toMillis() ?? Infinity) - (a.createdAt?.toMillis() ?? Infinity))),
    );
  }
  watchActiveRuns(pid: string, cb: (r: Run[]) => void, onError?: (e: Error) => void) {
    return resilient(
      (err) => watch<Run>(query(collection(this.db, ...this.p(pid, "runs")), where("status", "==", "running")), cb, err),
      onError,
    );
  }
  watchRun(pid: string, rid: string, cb: (r: Run | undefined) => void) {
    return onSnapshot(doc(this.db, ...this.p(pid, "runs", rid)), (s) =>
      cb(s.exists() ? withId<Run>(s.id, s.data()) : undefined),
    );
  }
  watchJobs(pid: string, rid: string, cb: (j: Job[]) => void) {
    return watch<Job>(collection(this.db, ...this.p(pid, "runs", rid, "jobs")), cb);
  }
  async finishRun(pid: string, rid: string, status: "complete" | "cancelled") {
    await updateDoc(doc(this.db, ...this.p(pid, "runs", rid)), { status });
  }
  async cancelRun(pid: string, rid: string) {
    const open = await getDocs(
      query(collection(this.db, ...this.p(pid, "runs", rid, "jobs")), where("state", "==", "queued")),
    );
    for (let i = 0; i < open.docs.length; i += 450) {
      const batch = writeBatch(this.db);
      open.docs.slice(i, i + 450).forEach((d) => batch.update(d.ref, { state: "failed" }));
      await batch.commit();
    }
    await this.finishRun(pid, rid, "cancelled");
  }
  pendingJudge(pid: string, rid: string, cb: (j: Job[]) => void) {
    return resilient((err) =>
      watch<Job>(
        query(
          collection(this.db, ...this.p(pid, "runs", rid, "jobs")),
          where("verdict", "==", "pending_judge"),
          limit(50),
        ),
        cb,
        err,
      ),
    );
  }
  attachJudge(pid: string, rid: string, jid: string, patch: Pick<Job, "judge" | "verdict" | "checks">) {
    return updateDoc(doc(this.db, ...this.p(pid, "runs", rid, "jobs", jid)), clean(patch));
  }

  // ---------- devices ----------
  watchDevices(pid: string, cb: (d: Device[]) => void) {
    return watch<Device>(collection(this.db, ...this.p(pid, "devices")), cb);
  }
  registerDevice(pid: string, uid: string, d: Omit<Device, "id" | "runnerUid" | "lastSeen">) {
    return setDoc(doc(this.db, ...this.p(pid, "devices", uid)), {
      ...clean(d),
      runnerUid: uid,
      lastSeen: serverTimestamp(),
    });
  }

  // ---------- pairing ----------
  async createPairing(pid: string, uid: string): Promise<{ code: string; expiresAt: Date }> {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    const expiresAt = new Date(Date.now() + 290_000);
    await setDoc(doc(this.db, "pairings", code), {
      pid,
      createdBy: uid,
      expiresAt: Timestamp.fromDate(expiresAt),
      createdAt: serverTimestamp(),
    });
    return { code, expiresAt };
  }

  // ---------- policies (written by publishPolicy) ----------
  watchPolicies(pid: string, fid: string, cb: (p: PublishedPolicy[]) => void) {
    return watch<PublishedPolicy>(
      query(collection(this.db, ...this.p(pid, "policies")), where("featureId", "==", fid)),
      (rows) => cb(rows.sort((a, b) => b.version - a.version)),
    );
  }

  // ---------- judge cache ----------
  judgeCache(pid: string): JudgeCache {
    return {
      get: async (key) => {
        const s = await getDoc(doc(this.db, ...this.p(pid, "judge_cache", key)));
        return s.exists() ? (s.data() as JudgeVerdict & { model?: string }) : undefined;
      },
      put: async (key, v) => {
        await setDoc(doc(this.db, ...this.p(pid, "judge_cache", key)), {
          ...clean(v),
          createdAt: serverTimestamp(),
        });
      },
    };
  }
}

