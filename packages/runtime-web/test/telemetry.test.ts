import { describe, expect, it, vi } from "vitest";
import type { TelemetryEvent } from "@tandem/core";
import { contentFree, TELEMETRY_FIELDS, TelemetryQueue } from "../src/telemetry.js";
import { telemetryErrors } from "./helpers.js";

const event = (i: number): TelemetryEvent => ({
  eventId: `evt_${String(i).padStart(4, "0")}`,
  featureId: "triage",
  modelId: "chrome:158",
  platform: "chrome",
  policyVersion: 4,
  mode: "PREFER_ON_DEVICE",
  backend: "ON_DEVICE",
  latencyMs: 812,
  validation: "pass",
  escalated: false,
  ts: 1_764_000_000_000 + i,
  sdk: "web/0.1.0",
});

describe("contentFree", () => {
  it("drops every field outside the allowlist", () => {
    const leaky = { ...event(1), prompt: "my address is…", outputText: "…", extra: 1 };
    const clean = contentFree(leaky as TelemetryEvent);
    expect(Object.keys(clean).sort()).toEqual(Object.keys(event(1)).sort());
    expect(telemetryErrors(clean)).toEqual([]);
    expect(telemetryErrors(leaky)).not.toEqual([]); // the schema would reject it anyway
  });
  it("matches the schema's property list exactly", async () => {
    const { readFileSync } = await import("node:fs");
    const schema = JSON.parse(
      readFileSync(new URL("../../../contracts/telemetry.schema.json", import.meta.url), "utf8"),
    ) as { properties: Record<string, unknown> };
    expect([...TELEMETRY_FIELDS].sort()).toEqual(Object.keys(schema.properties).sort());
  });
  it("refuses incomplete events", () => {
    const { sdk: _sdk, ...rest } = event(1);
    expect(() => contentFree(rest as TelemetryEvent)).toThrow('missing "sdk"');
  });
});

function harness(write: (b: readonly TelemetryEvent[]) => Promise<void>, max = 3) {
  const timers: Array<() => void> = [];
  const onError = vi.fn();
  const sink = { write: vi.fn(write) };
  const q = new TelemetryQueue(sink, {
    maxBatch: 2,
    maxQueue: max,
    flushIntervalMs: 5000,
    onError,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => undefined,
  });
  return { q, sink, timers, onError };
}

describe("TelemetryQueue", () => {
  it("flushes a full batch immediately and the rest on the timer", async () => {
    const { q, sink, timers } = harness(async () => undefined, 10);
    q.record(event(1));
    expect(timers).toHaveLength(1);
    q.record(event(2)); // batch full
    await q.flush();
    expect(sink.write).toHaveBeenCalledTimes(1);
    expect(sink.write.mock.calls[0]?.[0]).toHaveLength(2);
    q.record(event(3));
    q.record(event(4));
    q.record(event(5));
    await q.flush();
    expect(sink.write.mock.calls.flatMap((c) => c[0].map((e) => e.eventId))).toEqual(
      [1, 2, 3, 4, 5].map((i) => event(i).eventId),
    );
    expect(q.size).toBe(0);
    timers[0]?.();
    await q.flush();
  });

  it("re-queues a failed batch, reports the error and retries later", async () => {
    let fail = true;
    const { q, sink, onError, timers } = harness(async () => {
      if (fail) throw new Error("offline");
    }, 10);
    q.record(event(1));
    await q.flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(q.size).toBe(1);
    fail = false;
    timers.at(-1)?.();
    await q.flush();
    expect(q.size).toBe(0);
    expect(sink.write).toHaveBeenCalledTimes(2);
  });

  it("caps the queue by dropping the oldest events", () => {
    const { q } = harness(() => new Promise(() => undefined), 3);
    for (let i = 0; i < 6; i++) q.record(event(i));
    expect(q.dropped).toBeGreaterThan(0);
    expect(q.size).toBeLessThanOrEqual(3);
  });

  it("concurrent flushes share one write; default timers work", async () => {
    const sink = { write: vi.fn(async () => undefined) };
    const q = new TelemetryQueue(sink, { flushIntervalMs: 1 });
    q.record(event(1));
    const [a, b] = [q.flush(), q.flush()];
    expect(a).toBe(b);
    await a;
    expect(sink.write).toHaveBeenCalledOnce();
    q.record(event(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(sink.write).toHaveBeenCalledTimes(2);
    q.record(event(3));
    q.dispose();
    q.dispose();
  });
});
