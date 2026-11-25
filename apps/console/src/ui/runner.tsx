import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Job, ModelId } from "@tandem/core";
import { detectModelId, FirebaseAIBackend, type DeviceAvailability } from "@tandem/runtime";
import { cloudAvailable, firebase } from "../firebase.js";
import { Judge } from "../judge.js";
import { FirestoreJobQueue } from "../runner/firestoreQueue.js";
import { judgeJob } from "../runner/judgeWorker.js";
import { RunnerLoop, type RunnerEvent } from "../runner/loop.js";
import { useRepo } from "./hooks.js";
import { judgeModel } from "./models.js";

export interface LogLine {
  at: number;
  kind: "device" | "cloud" | "judge";
  text: string;
}

interface RunnerState {
  modelId: ModelId;
  isChrome: boolean;
  availability: DeviceAvailability | "checking";
  downloadProgress?: number;
  deviceOn: boolean;
  cloudOn: boolean;
  judgeOn: boolean;
  done: { device: number; cloud: number; judge: number };
  log: LogLine[];
  error?: string;
  refresh(): void;
  enableModel(): Promise<void>;
  setDevice(on: boolean): void;
  setCloud(on: boolean): void;
  setJudge(on: boolean): void;
}

const Ctx = createContext<RunnerState | undefined>(undefined);
export const useRunner = (): RunnerState => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useRunner outside RunnerProvider");
  return c;
};

const CLOUD_WORKERS = 3;
const label = (j: { job: Pick<Job, "caseId" | "variantId" | "target"> }) =>
  `${j.job.caseId} · ${j.job.variantId} · ${j.job.target}`;

/**
 * Runs inside the console tab for the active project:
 *  - device runner: this Chrome's Gemini Nano, leasing jobs whose target is this browser's modelId;
 *  - cloud runner: the reference jobs (cloud:<model>), ONLY_IN_CLOUD through AI Logic;
 *  - judge: grades rubric cases, cached by output hash.
 */
export function RunnerProvider({ pid, uid, children }: { pid: string; uid: string; children: ReactNode }) {
  const repo = useRepo();
  const { db, ai } = firebase();
  const backend = useMemo(() => new FirebaseAIBackend(ai), [ai]);
  const modelId = useMemo(() => detectModelId(), []);
  const isChrome = modelId.startsWith("chrome:");
  const [availability, setAvailability] = useState<RunnerState["availability"]>("checking");
  const [downloadProgress, setDownloadProgress] = useState<number>();
  const [deviceOn, setDeviceOn] = useState(false);
  const [cloudOn, setCloudOn] = useState(false);
  const [judgeOn, setJudgeOn] = useState(false);
  const [done, setDone] = useState({ device: 0, cloud: 0, judge: 0 });
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string>();

  const push = useCallback((kind: LogLine["kind"], text: string) => {
    setLog((l) => [{ at: Date.now(), kind, text }, ...l].slice(0, 80));
  }, []);

  // Created in an effect (not useMemo) so StrictMode's mount → cleanup → mount cannot leave a
  // disposed queue in use.
  const [queue, setQueue] = useState<FirestoreJobQueue>();
  useEffect(() => {
    const q = new FirestoreJobQueue(db, pid, (e) => setError(e.message));
    setQueue(q);
    return () => q.dispose();
  }, [db, pid]);
  const catalog = useMemo(() => repo.catalog(pid), [repo, pid]);

  const refresh = useCallback(() => {
    setAvailability("checking");
    backend.availability().then(setAvailability, () => setAvailability("unavailable"));
  }, [backend]);
  useEffect(refresh, [refresh]);

  const onEvent = useCallback(
    (kind: "device" | "cloud") => (e: RunnerEvent) => {
      if (e.type === "done") {
        setDone((d) => ({ ...d, [kind]: d[kind] + 1 }));
        const r = e.execution.result;
        push(kind, `${e.execution.verdict.padEnd(14)} ${Math.round(r.latencyMs)} ms  ${r.backend}  ${label(e.job)}`);
      } else if (e.type === "lost") push(kind, `lease lost   ${label(e.job)}`);
      else if (e.type === "error") push(kind, `error  ${e.error instanceof Error ? e.error.message : String(e.error)}`);
    },
    [push],
  );

  // ---------- device runner ----------
  const registerDevice = useCallback(
    (a: DeviceAvailability) =>
      repo.registerDevice(pid, uid, {
        platform: "chrome",
        modelId,
        osVersion: navigator.platform || "unknown",
        availability: a,
        label: `Chrome ${modelId.split(":")[1]} · Gemini Nano`,
      }),
    [repo, pid, uid, modelId],
  );

  useEffect(() => {
    if (!deviceOn || !isChrome || !queue) return;
    let cancelled = false;
    const loop = new RunnerLoop({
      owner: uid,
      accept: (t) => t === modelId,
      queue,
      catalog,
      backend,
      onEvent: onEvent("device"),
    });
    registerDevice(availability === "checking" ? "unavailable" : availability)
      .then(() => {
        if (!cancelled) {
          push("device", `runner on · ${modelId}`);
          loop.start();
        }
      })
      .catch((e: Error) => setError(`device registration: ${e.message}`));
    const beat = setInterval(() => void backend.availability().then(registerDevice).catch(() => undefined), 30_000);
    return () => {
      cancelled = true;
      clearInterval(beat);
      void loop.stop();
      push("device", "runner off");
    };
    // availability is read once at start; the 30 s heartbeat refreshes it.
  }, [deviceOn, isChrome, uid, modelId, queue, catalog, backend, onEvent, registerDevice, push]);

  const enableModel = useCallback(async () => {
    // Must run inside the click handler: Chrome only starts the download on a user gesture.
    setDownloadProgress(0);
    try {
      await backend.prepare((p) => setDownloadProgress(p));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadProgress(undefined);
      refresh();
    }
  }, [backend, refresh]);

  // ---------- cloud runner ----------
  useEffect(() => {
    if (!cloudOn || !cloudAvailable || !queue) return;
    const loops = Array.from(
      { length: CLOUD_WORKERS },
      () =>
        new RunnerLoop({
          owner: uid,
          accept: (t) => t.startsWith("cloud:"),
          queue,
          catalog,
          backend,
          onEvent: onEvent("cloud"),
          idleMs: 2000,
        }),
    );
    loops.forEach((l) => l.start());
    push("cloud", `reference runner on · ${CLOUD_WORKERS} workers`);
    return () => {
      loops.forEach((l) => void l.stop());
      push("cloud", "reference runner off");
    };
  }, [cloudOn, uid, queue, catalog, backend, onEvent, push]);

  // ---------- judge ----------
  const judging = useRef(false);
  useEffect(() => {
    if (!judgeOn || !cloudAvailable) return;
    const judge = new Judge(backend, repo.judgeCache(pid), judgeModel);
    const pending = new Map<string, { runId: string; featureId: string; job: Job }>();
    const subs = new Map<string, () => void>();
    const offRuns = repo.watchActiveRuns(pid, (runs) => {
      for (const r of runs)
        if (!subs.has(r.id))
          subs.set(
            r.id,
            repo.pendingJudge(pid, r.id, (jobs) => {
              for (const [k, v] of pending) if (v.runId === r.id) pending.delete(k);
              for (const job of jobs) pending.set(`${r.id}/${job.id}`, { runId: r.id, featureId: r.featureId, job });
            }),
          );
    });
    const sink = {
      attach: (t: { pid: string; runId: string }, job: Job, patch: Pick<Job, "judge" | "verdict" | "checks">) =>
        repo.attachJudge(t.pid, t.runId, job.id, patch),
    };
    let stop = false;
    void (async () => {
      push("judge", "judge on");
      while (!stop) {
        const next = pending.entries().next().value;
        if (!next || judging.current) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        const [key, item] = next;
        pending.delete(key);
        judging.current = true;
        try {
          await judgeJob({ pid, runId: item.runId, featureId: item.featureId }, item.job, judge, catalog, sink);
          setDone((d) => ({ ...d, judge: d.judge + 1 }));
          push("judge", `judged ${item.job.caseId} · ${item.job.target} (${judge.hits} cached / ${judge.calls} calls)`);
        } catch (e) {
          push("judge", `judge error ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          judging.current = false;
        }
      }
    })();
    return () => {
      stop = true;
      offRuns();
      subs.forEach((u) => u());
      push("judge", "judge off");
    };
  }, [judgeOn, backend, repo, pid, catalog, push]);

  const value: RunnerState = {
    modelId,
    isChrome,
    availability,
    ...(downloadProgress !== undefined ? { downloadProgress } : {}),
    deviceOn,
    cloudOn,
    judgeOn,
    done,
    log,
    ...(error ? { error } : {}),
    refresh,
    enableModel,
    setDevice: setDeviceOn,
    setCloud: setCloudOn,
    setJudge: setJudgeOn,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
