import type { TelemetryEvent } from "@tandem/core";
import type { TelemetryRecorder, TelemetrySink } from "./types.js";

/**
 * The exact field allowlist of `contracts/telemetry.schema.json` (and of the Firestore rule for
 * `telemetry_raw`). Anything else is dropped before it leaves the device — prompts and outputs
 * cannot be sent even by a caller that builds events by hand.
 */
export const TELEMETRY_FIELDS = [
  "eventId",
  "featureId",
  "modelId",
  "platform",
  "policyVersion",
  "variantId",
  "mode",
  "backend",
  "latencyMs",
  "validation",
  "escalated",
  "errorCode",
  "ts",
  "sdk",
] as const satisfies ReadonlyArray<keyof TelemetryEvent>;

const REQUIRED = TELEMETRY_FIELDS.filter((k) => k !== "variantId" && k !== "errorCode");

export function contentFree(event: TelemetryEvent): TelemetryEvent {
  const src = event as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of TELEMETRY_FIELDS) if (src[k] !== undefined) out[k] = src[k];
  for (const k of REQUIRED)
    if (out[k] === undefined) throw new TypeError(`telemetry event missing "${k}"`);
  return out as unknown as TelemetryEvent;
}

export interface TelemetryQueueOptions {
  /** Events per write. Firestore batches allow 500; small batches keep each write cheap. */
  maxBatch?: number;
  flushIntervalMs?: number;
  /** Oldest events are dropped beyond this, so an offline app cannot grow without bound. */
  maxQueue?: number;
  onError?: (e: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Batches telemetry and writes it in the background; failures re-queue, never throw. */
export class TelemetryQueue implements TelemetryRecorder {
  private queue: TelemetryEvent[] = [];
  private timer: unknown;
  private inFlight: Promise<void> | undefined;
  private readonly o: Required<Omit<TelemetryQueueOptions, "onError">> &
    Pick<TelemetryQueueOptions, "onError">;
  /** Events dropped because the queue was full (shown in the console's debug panel). */
  dropped = 0;

  constructor(
    private readonly sink: TelemetrySink,
    options: TelemetryQueueOptions = {},
  ) {
    this.o = {
      maxBatch: 20,
      flushIntervalMs: 10_000,
      maxQueue: 500,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  get size(): number {
    return this.queue.length;
  }

  record(event: TelemetryEvent): void {
    this.queue.push(contentFree(event));
    const over = this.queue.length - this.o.maxQueue;
    if (over > 0) {
      this.queue.splice(0, over);
      this.dropped += over;
    }
    if (this.queue.length >= this.o.maxBatch) void this.flush();
    else this.schedule();
  }

  /** Write everything queued. Concurrent callers share one in-flight flush. */
  flush(): Promise<void> {
    this.inFlight ??= this.drain().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  dispose(): void {
    if (this.timer !== undefined) this.o.clearTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = this.o.setTimer(() => {
      this.timer = undefined;
      void this.flush();
    }, this.o.flushIntervalMs);
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.o.maxBatch);
      try {
        await this.sink.write(batch);
      } catch (e) {
        this.queue.unshift(...batch);
        this.o.onError?.(e);
        this.schedule();
        return;
      }
    }
  }
}
