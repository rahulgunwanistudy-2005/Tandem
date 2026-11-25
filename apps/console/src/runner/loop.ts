import type { Case, Feature, Job, ModelId, Variant } from "@tandem/core";
import type { InferenceBackend } from "@tandem/runtime";
import { executeJob, type Execution } from "./execute.js";

/** A queued job as the runner sees it. `path` is opaque to the loop. */
export interface QueuedJob {
  path: string;
  featureId: string;
  job: Pick<Job, "id" | "runId" | "caseId" | "variantId" | "target" | "attempt">;
}

/** Lease operations; the Firestore implementation enforces the state machine in the rules. */
export interface JobQueue {
  /** Oldest queued job whose target this runner accepts, if any. */
  next(accept: (target: ModelId) => boolean): Promise<QueuedJob | undefined>;
  /** Claim in a transaction. false when someone else got it first. */
  claim(q: QueuedJob, owner: string, leaseMs: number): Promise<boolean>;
  heartbeat(q: QueuedJob, leaseMs: number): Promise<void>;
  complete(q: QueuedJob, e: Execution): Promise<void>;
}

export interface Catalog {
  load(
    featureId: string,
    variantId: string,
    caseId: string,
  ): Promise<{ feature: Feature; variant: Variant; testCase: Case }>;
}

export type RunnerEvent =
  | { type: "claimed"; job: QueuedJob }
  | { type: "done"; job: QueuedJob; execution: Execution }
  | { type: "lost"; job: QueuedJob }
  | { type: "error"; job?: QueuedJob; error: unknown };

export interface RunnerOptions {
  owner: string;
  accept: (target: ModelId) => boolean;
  queue: JobQueue;
  catalog: Catalog;
  backend: InferenceBackend;
  leaseMs?: number;
  heartbeatMs?: number;
  idleMs?: number;
  onEvent?: (e: RunnerEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  execute?: typeof executeJob;
}

/**
 * One sequential worker (ADR 0004): claim → heartbeat while running → complete.
 * Several loops may share a queue (the cloud runner does); the claim transaction decides.
 */
export class RunnerLoop {
  private running = false;
  private stopped: Promise<void> = Promise.resolve();
  readonly leaseMs: number;

  constructor(private readonly o: RunnerOptions) {
    this.leaseMs = o.leaseMs ?? 60_000;
  }

  get active(): boolean {
    return this.running;
  }

  /** Process at most one job. Returns true if a job was claimed. */
  async tick(): Promise<boolean> {
    const { queue, owner } = this.o;
    let q: QueuedJob | undefined;
    try {
      q = await queue.next(this.o.accept);
      if (!q) return false;
      if (!(await queue.claim(q, owner, this.leaseMs))) return false;
    } catch (error) {
      this.emit({ type: "error", ...(q ? { job: q } : {}), error });
      return false;
    }
    this.emit({ type: "claimed", job: q });

    const beat = setInterval(
      () => void queue.heartbeat(q, this.leaseMs).catch((error) => this.emit({ type: "error", job: q, error })),
      this.o.heartbeatMs ?? Math.floor(this.leaseMs / 3),
    );
    try {
      const { feature, variant, testCase } = await this.o.catalog.load(
        q.featureId,
        q.job.variantId,
        q.job.caseId,
      );
      const execution = await (this.o.execute ?? executeJob)({
        target: q.job.target,
        feature,
        variant,
        testCase,
        backend: this.o.backend,
      });
      clearInterval(beat);
      try {
        await queue.complete(q, execution);
        this.emit({ type: "done", job: q, execution });
      } catch (error) {
        // Lease expired and was reaped, or the run was cancelled: the result is dropped.
        this.emit({ type: "lost", job: q });
        this.emit({ type: "error", job: q, error });
      }
    } catch (error) {
      clearInterval(beat);
      this.emit({ type: "error", job: q, error });
    }
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.stopped = (async () => {
      while (this.running) {
        const worked = await this.tick();
        if (!worked && this.running) await sleep(this.o.idleMs ?? 1500);
      }
    })();
  }

  /** Stop after the current job; resolves when the loop has exited. */
  stop(): Promise<void> {
    this.running = false;
    return this.stopped;
  }

  private emit(e: RunnerEvent): void {
    try {
      this.o.onEvent?.(e);
    } catch {
      // a UI listener must never stop the runner
    }
  }
}
