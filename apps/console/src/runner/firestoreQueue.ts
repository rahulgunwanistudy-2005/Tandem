import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";
import type { ModelId } from "@tandem/core";
import { clean, Repo, type Run } from "../data/repo.js";
import type { Execution } from "./execute.js";
import type { JobQueue, QueuedJob } from "./loop.js";

/**
 * Lease queue over `projects/{pid}/runs/{rid}/jobs`. The state machine (claim → heartbeat →
 * complete, target must equal the caller's device model) is enforced by firestore.rules; this
 * class only speaks it. Only runs with status "running" are polled.
 */
export class FirestoreJobQueue implements JobQueue {
  private runs: Run[] = [];
  private readonly unsubscribe: Unsubscribe;

  constructor(
    private readonly db: Firestore,
    private readonly pid: string,
    onError?: (e: Error) => void,
  ) {
    this.unsubscribe = new Repo(db).watchActiveRuns(pid, (r) => (this.runs = r), onError);
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Targets with queued work right now (for the UI). */
  activeTargets(): ModelId[] {
    return [...new Set(this.runs.flatMap((r) => r.targets))];
  }

  async next(accept: (target: ModelId) => boolean): Promise<QueuedJob | undefined> {
    for (const run of this.runs) {
      const targets = run.targets.filter(accept).slice(0, 30); // `in` takes ≤ 30 values
      if (targets.length === 0) continue;
      const snap = await getDocs(
        query(
          collection(this.db, "projects", this.pid, "runs", run.id, "jobs"),
          where("target", "in", targets),
          where("state", "==", "queued"),
          orderBy("createdAt"),
          limit(1),
        ),
      );
      const d = snap.docs[0];
      if (!d) continue;
      const j = d.data();
      return {
        path: d.ref.path,
        featureId: run.featureId,
        job: {
          id: d.id,
          runId: run.id,
          caseId: j.caseId as string,
          variantId: j.variantId as string,
          target: j.target as ModelId,
          attempt: j.attempt as number,
        },
      };
    }
    return undefined;
  }

  async claim(q: QueuedJob, owner: string, leaseMs: number): Promise<boolean> {
    const ref = doc(this.db, q.path);
    try {
      return await runTransaction(this.db, async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists() || s.data().state !== "queued") return false;
        tx.update(ref, {
          state: "leased",
          leaseOwner: owner,
          leaseExpiresAt: Timestamp.fromMillis(Date.now() + leaseMs),
          attempt: (s.data().attempt as number) + 1,
        });
        return true;
      });
    } catch {
      return false; // contention or a rules denial: someone else has it
    }
  }

  async heartbeat(q: QueuedJob, leaseMs: number): Promise<void> {
    await updateDoc(doc(this.db, q.path), {
      leaseExpiresAt: Timestamp.fromMillis(Date.now() + leaseMs),
    });
  }

  async complete(q: QueuedJob, e: Execution): Promise<void> {
    await updateDoc(doc(this.db, q.path), {
      state: "done",
      result: clean(e.result),
      checks: clean(e.checks),
      verdict: e.verdict,
      completedAt: serverTimestamp(),
    });
  }
}
