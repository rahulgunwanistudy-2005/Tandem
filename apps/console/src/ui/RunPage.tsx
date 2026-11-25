import { useEffect, useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import {
  compilePolicy,
  decide,
  DEFAULT_SETTINGS,
  diffPolicies,
  isDeviceTarget,
  wilsonInterval,
  type Case,
  type Evidence,
  type Feature,
  type Variant,
  type Job,
  type ModelId,
  type Policy,
  type PolicyVariant,
} from "@tandem/core";
import { cloudAvailable, firebase } from "../firebase.js";
import type { Project, PublishedPolicy, Run } from "../data/repo.js";
import { cellKey, evidenceOf, matrix, orderTargets, progressOf, type Cell } from "../data/plan.js";
import { go, href, ms, pct, useLive, useRepo } from "./hooks.js";

export function RunPage({ pid, fid, rid }: { pid: string; fid: string; rid: string }) {
  const repo = useRepo();
  const run = useLive<Run | undefined>((cb) => repo.watchRun(pid, rid, cb), [pid, rid]);
  const jobs = useLive<Job[]>((cb) => repo.watchJobs(pid, rid, cb), [pid, rid]);
  const cases = useLive<Case[]>((cb) => repo.watchCases(pid, fid, cb), [pid, fid]);
  const features = useLive<Feature[]>((cb) => repo.watchFeatures(pid, cb), [pid]);
  const variants = useLive<Variant[]>((cb) => repo.watchVariants(pid, fid, cb), [pid, fid]);
  const project = useLive<Project | undefined>((cb) => repo.watchProject(pid, cb), [pid]);
  const feature = features?.find((f) => f.id === fid);
  const [open, setOpen] = useState<Cell>();

  const progress = useMemo(() => progressOf(jobs ?? []), [jobs]);
  const cells = useMemo(() => matrix(jobs ?? []), [jobs]);
  const evidence = useMemo(() => evidenceOf(jobs ?? []), [jobs]);
  const targets = useMemo(() => orderTargets(run?.targets ?? []), [run]);

  const finished = progress.total > 0 && progress.queued + progress.leased === 0 && progress.pendingJudge === 0;
  useEffect(() => {
    if (run?.status === "running" && finished) void repo.finishRun(pid, rid, "complete");
  }, [run?.status, finished, repo, pid, rid]);

  if (!run || !jobs || !cases || !feature) return <div className="page muted">Loading run…</div>;
  const byId = new Map(cases.map((c) => [c.id, c]));
  const caseIds = [...new Set(jobs.map((j) => j.caseId))].sort();
  const columns = targets.flatMap((t) => run.variantIds.map((v) => ({ target: t, variantId: v })));
  const settings = { ...DEFAULT_SETTINGS, ...(project?.settings ?? {}), latencyBudgetMs: feature.latencyBudgetMs };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="crumbs">
            <a href={href("p", pid)}>Overview</a> / <a href={href("p", pid, "f", fid)}>{feature.name}</a> / <span className="mono">{rid.slice(0, 8)}</span>
          </div>
          <h1>Run · {feature.name}</h1>
          <p className="sub">
            {run.caseCount} cases × {run.samples} sample{run.samples > 1 ? "s" : ""} × {run.variantIds.length} variant{run.variantIds.length > 1 ? "s" : ""} on {targets.length} target{targets.length > 1 ? "s" : ""}.
          </p>
        </div>
        <div className="row">
          {run.status === "running" ? (
            <button className="btn" onClick={() => repo.cancelRun(pid, rid)}>Cancel run</button>
          ) : (
            <span className="chip">{run.status}</span>
          )}
        </div>
      </div>

      <Progress jobs={jobs} targets={targets} />

      <div className="card" style={{ margin: "16px 0" }}>
        <div className="card-head">
          <h2>Evidence</h2>
          <span className="faint small">
            Route to device only if n ≥ {settings.minN}, no integrity failures, Wilson 95% lower bound ≥ τ = {settings.tau}, p95 ≤ {settings.latencyBudgetMs / 1000}s
          </span>
        </div>
        <EvidenceTable evidence={evidence} settings={settings} />
      </div>

      <div className="card-head" style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Matrix</h2>
        <Legend />
      </div>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>Case</th>
              {columns.map((c) => (
                <th key={c.target + c.variantId} className="target">
                  <span className={`chip ${isDeviceTarget(c.target) ? "device" : "cloud"} mono`}>{c.target}</span>
                  {run.variantIds.length > 1 && <div className="mono faint small">{c.variantId}</div>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {caseIds.map((cid) => {
              const c = byId.get(cid);
              return (
                <tr key={cid}>
                  <td className="case">
                    <div className="row" style={{ gap: 6 }}>
                      <span className="mono small">{cid}</span>
                      {c && <span className="faint small">{c.split}</span>}
                    </div>
                    <div className="case-text" title={c?.input.text}>{c?.input.text ?? "(deleted case)"}</div>
                  </td>
                  {columns.map((col) => {
                    const cell = cells.get(cellKey(cid, col.variantId, col.target));
                    return (
                      <td key={col.target + col.variantId} className="cell" onClick={() => cell && setOpen(cell)}>
                        {cell ? <Samples cell={cell} /> : <span className="faint">—</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Publish pid={pid} fid={fid} rid={rid} feature={feature} evidence={evidence} variants={variants ?? []} settings={settings} finished={finished} />

      {open && <CellDrawer cell={open} testCase={byId.get(open.caseId)} jobs={jobs} onClose={() => setOpen(undefined)} />}
    </div>
  );
}

function Progress({ jobs, targets }: { jobs: Job[]; targets: ModelId[] }) {
  return (
    <div className="grid-3">
      {targets.map((t) => {
        const js = jobs.filter((j) => j.target === t);
        const p = progressOf(js);
        const kind = isDeviceTarget(t) ? "device" : "cloud";
        return (
          <div key={t} className="card" style={{ padding: 14 }}>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
              <span className="mono small">{t}</span>
              <span className="small faint">
                {p.done}/{p.total}
                {p.leased > 0 && <> · <span className={`dot ${kind} live`} /> running</>}
                {p.pendingJudge > 0 && <> · {p.pendingJudge} judging</>}
              </span>
            </div>
            <div className="bar">
              <i className={kind} style={{ width: `${(p.done / Math.max(1, p.total)) * 100}%` }} />
              <i className="neutral" style={{ width: `${(p.failed / Math.max(1, p.total)) * 100}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span><i className="s pass device" /> pass on device</span>
      <span><i className="s pass cloud" /> pass in cloud</span>
      <span><i className="s fail" /> fail</span>
      <span><i className="s integrity">!</i> answer not from device</span>
      <span><i className="s error">×</i> error</span>
      <span><i className="s judge" /> awaiting judge</span>
      <span><i className="s queued" /> queued</span>
    </div>
  );
}

function sampleClass(j: Job): [string, string] {
  if (j.state === "queued") return ["queued", ""];
  if (j.state === "leased") return ["leased", ""];
  if (j.state === "failed") return ["error", "–"];
  switch (j.verdict) {
    case "pass":
      return [`pass ${isDeviceTarget(j.target) ? "device" : "cloud"}`, ""];
    case "fail":
      return ["fail", ""];
    case "integrity_fail":
      return ["integrity", "!"];
    case "pending_judge":
      return ["judge", ""];
    default:
      return ["error", "×"];
  }
}

function Samples({ cell }: { cell: Cell }) {
  return (
    <span className="samples" title={`${cell.passes}/${cell.decided} passed`}>
      {cell.jobs.map((j) => {
        const [cls, glyph] = sampleClass(j);
        return (
          <i key={j.id} className={`s ${cls}`}>
            {glyph}
          </i>
        );
      })}
    </span>
  );
}

type Settings = typeof DEFAULT_SETTINGS & { latencyBudgetMs: number };

const REASON_TEXT: Record<string, string> = {
  PASSED: "Route to device",
  INSUFFICIENT_EVIDENCE: "Not enough samples",
  LB_BELOW_TAU: "Lower bound below τ",
  LATENCY_OVER_BUDGET: "p95 over budget",
  INTEGRITY_FAILURES: "Integrity failures",
};

function EvidenceTable({ evidence, settings }: { evidence: Evidence[]; settings: Settings }) {
  if (evidence.length === 0) return <p className="faint small">No finished samples yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Target</th>
          <th>Variant</th>
          <th className="num">Passes</th>
          <th className="num">Pass rate (95% CI)</th>
          <th className="num">Wilson LB</th>
          <th className="num">p50 / p95</th>
          <th className="num">Flaky</th>
          <th className="num">Integrity</th>
          <th>Decision</th>
        </tr>
      </thead>
      <tbody>
        {evidence.map((e) => {
          const device = isDeviceTarget(e.target);
          const d = decide(e, settings);
          const ci = wilsonInterval(e.passes, e.n);
          return (
            <tr key={e.target + e.variantId}>
              <td><span className={`chip ${device ? "device" : "cloud"} mono`}>{e.target}</span></td>
              <td className="mono">{e.variantId}</td>
              <td className="num">{e.passes}/{e.n}{e.pending > 0 && <span className="faint"> +{e.pending}</span>}</td>
              <td className="num">{pct(e.passRate, 1)} <span className="faint small">({pct(ci.lower, 0)}–{pct(ci.upper, 0)})</span></td>
              <td className="num"><b>{e.lb.toFixed(3)}</b></td>
              <td className="num">{ms(e.p50LatencyMs)} / {ms(e.p95LatencyMs)}</td>
              <td className="num">{pct(e.flakiness)}</td>
              <td className="num">{e.integrityFailures}</td>
              <td>
                {device ? (
                  <span className={`chip ${d.routeToDevice ? "device" : ""}`}>{REASON_TEXT[d.reason] ?? d.reason}</span>
                ) : (
                  <span className="faint small">reference</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Publish({ pid, fid, rid, feature, evidence, variants, settings, finished }: { pid: string; fid: string; rid: string; feature: { id: string; outputKind: "json" | "enum" | "text"; outputSchema: Policy["outputSchema"] & object; cloudModel: string; latencyBudgetMs: number; defaultVariantId?: string }; evidence: Evidence[]; variants: { id: string; systemInstruction: string; promptTemplate: string; sha256: string }[]; settings: Settings; finished: boolean }) {
  const repo = useRepo();
  const published = useLive<PublishedPolicy[]>((cb) => repo.watchPolicies(pid, fid, cb), [pid, fid]);
  const [state, setState] = useState<{ busy?: boolean; err?: string; ok?: string }>({});
  const live = published?.[0];

  const compiled = useMemo(() => {
    const vs: Record<string, PolicyVariant> = {};
    for (const v of variants) vs[v.id] = { systemInstruction: v.systemInstruction, promptTemplate: v.promptTemplate, sha256: v.sha256 };
    try {
      return compilePolicy({
        feature,
        defaultVariantId: feature.defaultVariantId ?? "v1",
        variants: vs,
        evidence,
        settings,
        version: (live?.version ?? 0) + 1,
        sourceRunIds: [rid],
      });
    } catch {
      return undefined;
    }
  }, [feature, variants, evidence, settings, live?.version, rid]);

  if (!compiled) return null;
  const changes = diffPolicies(live?.policy, compiled);
  const publish = async () => {
    setState({ busy: true });
    try {
      const fn = httpsCallable<{ pid: string; featureId: string; policy: Policy; expectedVersion: number }, { version: number }>(firebase().functions, "publishPolicy");
      const r = await fn({ pid, featureId: fid, policy: compiled, expectedVersion: live?.version ?? 0 });
      setState({ ok: `Published v${r.data.version}. Apps pick it up through Remote Config real-time updates.` });
    } catch (e) {
      setState({ err: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <h2>Compiled policy · v{compiled.version}</h2>
        <div className="row">
          <a className="btn ghost sm" href={href("p", pid, "f", fid, "policy")}>Live policy</a>
          <button className="btn primary" disabled={!finished || state.busy || changes.every((c) => c.kind === "unchanged")} onClick={publish}>
            Publish to Remote Config
          </button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Change</th>
            <th>Now</th>
            <th>After publish</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.target}>
              <td className="mono">{c.target}</td>
              <td className="small">{c.kind}</td>
              <td className="small">{c.before ? `${c.before.mode} · ${c.before.variantId}` : "default (cloud)"}</td>
              <td>
                {c.after ? (
                  <span className={`chip ${c.after.mode.includes("DEVICE") ? "device" : "cloud"}`}>{c.after.mode} · {c.after.variantId} · {c.after.reason}</span>
                ) : (
                  "default (cloud)"
                )}
              </td>
            </tr>
          ))}
          {changes.length === 0 && (
            <tr>
              <td colSpan={4} className="faint small">No device targets in this run: every model stays on the cloud default.</td>
            </tr>
          )}
        </tbody>
      </table>
      {!finished && <p className="small faint">Publishing unlocks when every job is finished and judged.</p>}
      {!cloudAvailable && <p className="small faint">Publishing needs the publishPolicy function (emulator or deployed project).</p>}
      {state.err && <p className="small error-text">{state.err}</p>}
      {state.ok && <p className="small">{state.ok} <a className="btn ghost sm" onClick={() => go("p", pid, "f", fid, "policy")}>View</a></p>}
    </div>
  );
}

function CellDrawer({ cell, testCase, onClose }: { cell: Cell; testCase: Case | undefined; jobs: Job[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const j = cell.jobs[Math.min(i, cell.jobs.length - 1)];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!j) return null;
  const pretty = (() => {
    try {
      return JSON.stringify(JSON.parse(j.result?.outputText ?? ""), null, 2);
    } catch {
      return j.result?.outputText;
    }
  })();
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Sample detail">
        <div className="card-head">
          <h2 style={{ margin: 0 }}>
            <span className="mono">{cell.caseId}</span> on <span className={`chip ${isDeviceTarget(cell.target) ? "device" : "cloud"} mono`}>{cell.target}</span>
          </h2>
          <button className="btn ghost sm" onClick={onClose}>Close</button>
        </div>
        {cell.jobs.length > 1 && (
          <div className="row">
            {cell.jobs.map((s, k) => (
              <button key={s.id} className={`btn sm ${k === i ? "primary" : ""}`} onClick={() => setI(k)}>
                sample {s.sample + 1}
              </button>
            ))}
          </div>
        )}
        <div>
          <div className="small faint">Input</div>
          <pre className="codebox">{testCase?.input.text}</pre>
        </div>
        <dl className="kv">
          <dt>State</dt>
          <dd>{j.state}{j.verdict ? ` · ${j.verdict}` : ""}</dd>
          <dt>Answered by</dt>
          <dd><b>{j.result?.backend ?? "—"}</b> {j.result && isDeviceTarget(cell.target) && j.result.backend !== "ON_DEVICE" && j.result.outputText !== undefined && <span className="small"> · not counted as on-device</span>}</dd>
          <dt>Latency</dt>
          <dd>{ms(j.result?.latencyMs)}</dd>
          <dt>Variant</dt>
          <dd className="mono">{j.variantId}</dd>
          <dt>Attempt</dt>
          <dd>{j.attempt}</dd>
          {j.result?.errorCode && (
            <>
              <dt>Error</dt>
              <dd className="mono">{j.result.errorCode}{j.result.errorMessage ? ` — ${j.result.errorMessage}` : ""}</dd>
            </>
          )}
        </dl>
        {pretty !== undefined && (
          <div>
            <div className="small faint">Output</div>
            <pre className="codebox">{pretty}</pre>
          </div>
        )}
        {j.checks && (
          <div>
            <div className="small faint" style={{ marginBottom: 6 }}>Checks</div>
            <div className="check-list">
              {j.checks.map((c) => (
                <div key={c.id}>
                  <span className={c.pass ? "ok" : "error-text"}>{c.pass ? "✓" : "✗"}</span>
                  <span className="mono">{c.id}</span>
                  {c.detail && <span className="muted">{c.detail}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        {testCase?.rubric && (
          <div>
            <div className="small faint">Rubric</div>
            <p className="muted" style={{ margin: 0 }}>{testCase.rubric}</p>
          </div>
        )}
      </aside>
    </>
  );
}
