import { useMemo, useState } from "react";
import { isDeviceTarget, variantHash, type Case, type Feature, type ModelId, type Variant } from "@tandem/core";
import { cloudAvailable } from "../firebase.js";
import { MAX_JOBS_PER_RUN } from "../data/plan.js";
import type { Device, PublishedPolicy, Run } from "../data/repo.js";
import { go, href, timeAgo, useLive, useRepo } from "./hooks.js";
import { referenceModel } from "./models.js";
import { useRunner } from "./runner.js";

const TABS = ["runs", "cases", "variants", "policy"] as const;
type Tab = (typeof TABS)[number];

export function FeaturePage({ pid, fid, uid, tab }: { pid: string; fid: string; uid: string; tab?: string }) {
  const repo = useRepo();
  const features = useLive<Feature[]>((cb) => repo.watchFeatures(pid, cb), [pid]);
  const feature = features?.find((f) => f.id === fid);
  const cases = useLive<Case[]>((cb) => repo.watchCases(pid, fid, cb), [pid, fid]);
  const variants = useLive<Variant[]>((cb) => repo.watchVariants(pid, fid, cb), [pid, fid]);
  const runs = useLive<Run[]>((cb) => repo.watchRuns(pid, fid, cb), [pid, fid]);
  const active: Tab = (TABS as readonly string[]).includes(tab ?? "") ? (tab as Tab) : "runs";

  if (!feature) return <div className="page muted">{features ? "Feature not found." : "Loading…"}</div>;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="crumbs">
            <a href={href("p", pid)}>Overview</a> / <span>{feature.name}</span>
          </div>
          <h1>{feature.name}</h1>
          <p className="sub">{feature.description}</p>
        </div>
        <div className="row">
          <span className="chip mono">{feature.outputKind}</span>
          <span className="chip">budget {feature.latencyBudgetMs / 1000}s</span>
          <span className="chip">{cases?.length ?? "…"} cases</span>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <a key={t} role="tab" className={`tab ${active === t ? "active" : ""}`} href={href("p", pid, "f", fid, t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </a>
        ))}
      </div>
      {active === "runs" && <Runs pid={pid} feature={feature} uid={uid} cases={cases ?? []} variants={variants ?? []} runs={runs} />}
      {active === "cases" && <Cases pid={pid} feature={feature} cases={cases} />}
      {active === "variants" && <Variants pid={pid} feature={feature} variants={variants} />}
      {active === "policy" && <PolicyTab pid={pid} fid={fid} />}
    </div>
  );
}

function Runs({ pid, feature, uid, cases, variants, runs }: { pid: string; feature: Feature; uid: string; cases: Case[]; variants: Variant[]; runs: Run[] | undefined }) {
  const repo = useRepo();
  const runner = useRunner();
  const devices = useLive<Device[]>((cb) => repo.watchDevices(pid, cb), [pid]);
  const cloudTarget = `cloud:${referenceModel()}` as ModelId;
  const targetOptions = useMemo(() => {
    const t = new Set<ModelId>((devices ?? []).map((d) => d.modelId));
    if (runner.isChrome) t.add(runner.modelId);
    t.add(cloudTarget);
    return [...t];
  }, [devices, runner.isChrome, runner.modelId, cloudTarget]);

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [vPicked, setVPicked] = useState<Set<string>>(new Set());
  const [samples, setSamples] = useState(1);
  const [split, setSplit] = useState<"all" | "train" | "holdout">("all");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const targets = targetOptions.filter((t) => picked.has(t) || (picked.size === 0 && (t === runner.modelId || t === cloudTarget)));
  const vids = variants.map((v) => v.id).filter((v) => vPicked.has(v) || (vPicked.size === 0 && v === (feature.defaultVariantId ?? "v1")));
  const chosen = cases.filter((c) => split === "all" || c.split === split);
  const total = chosen.length * vids.length * targets.length * samples;
  const toggle = (s: Set<string>, set: (s: Set<string>) => void, v: string, defaults: string[]) => {
    const n = new Set(s.size ? s : defaults);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    set(n);
  };

  const start = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const rid = await repo.createRun(pid, { featureId: feature.id, variantIds: vids, targets, samples, cases: chosen.map((c) => ({ id: c.id, split: c.split })) }, uid);
      if (targets.some((t) => t === runner.modelId) && runner.availability === "available") runner.setDevice(true);
      if (targets.some((t) => !isDeviceTarget(t)) && cloudAvailable) runner.setCloud(true);
      if (cloudAvailable && cases.some((c) => c.rubric)) runner.setJudge(true);
      go("p", pid, "f", feature.id, "r", rid);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>New run</h2>
          <span className="faint small">{total} jobs</span>
        </div>
        <div className="grid-3">
          <div className="stack" style={{ gap: 8 }}>
            <span className="small muted">Targets</span>
            {targetOptions.map((t) => (
              <label key={t} className="check">
                <input type="checkbox" checked={targets.includes(t)} onChange={() => toggle(picked, setPicked, t, targets)} />
                <span className={`dot ${isDeviceTarget(t) ? "device" : "cloud"}`} />
                <span className="mono">{t}</span>
              </label>
            ))}
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <span className="small muted">Variants</span>
            {variants.map((v) => (
              <label key={v.id} className="check">
                <input type="checkbox" checked={vids.includes(v.id)} onChange={() => toggle(vPicked, setVPicked, v.id, vids)} />
                <span className="mono">{v.id}</span>
                <span className="faint small">{v.origin}{v.targetModelId ? ` · ${v.targetModelId}` : ""}</span>
              </label>
            ))}
          </div>
          <div className="stack" style={{ gap: 12 }}>
            <label className="field">
              Cases
              <select value={split} onChange={(e) => setSplit(e.target.value as typeof split)}>
                <option value="all">All ({cases.length})</option>
                <option value="train">Train ({cases.filter((c) => c.split === "train").length})</option>
                <option value="holdout">Holdout ({cases.filter((c) => c.split === "holdout").length})</option>
              </select>
            </label>
            <label className="field">
              Samples per case
              <input type="number" min={1} max={5} value={samples} onChange={(e) => setSamples(Math.max(1, Math.min(5, Number(e.target.value) || 1)))} />
            </label>
            <button className="btn primary" disabled={busy || total === 0 || total > MAX_JOBS_PER_RUN} onClick={start}>
              Start run
            </button>
            {err && <span className="small error-text">{err}</span>}
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Runs</h2>
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Targets</th>
              <th>Variants</th>
              <th className="num">Cases × samples</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(runs ?? []).map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => go("p", pid, "f", feature.id, "r", r.id)}>
                <td>{timeAgo(r.createdAt?.toMillis())}</td>
                <td>
                  <div className="row">
                    {r.targets.map((t) => (
                      <span key={t} className={`chip ${isDeviceTarget(t) ? "device" : "cloud"} mono`}>{t}</span>
                    ))}
                  </div>
                </td>
                <td className="mono">{r.variantIds.join(", ")}</td>
                <td className="num">{r.caseCount} × {r.samples}</td>
                <td>{r.status === "running" ? <><span className="dot live" /> running</> : r.status}</td>
              </tr>
            ))}
            {runs && runs.length === 0 && (
              <tr>
                <td colSpan={5} className="faint">No runs yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cases({ pid, feature, cases }: { pid: string; feature: Feature; cases: Case[] | undefined }) {
  const repo = useRepo();
  const [text, setText] = useState("");
  const [asserts, setAsserts] = useState('[{"kind":"equals","path":"intent","value":"other"}]');
  const [rubric, setRubric] = useState("");
  const [err, setErr] = useState<string>();
  const add = async () => {
    try {
      const parsed = JSON.parse(asserts) as Case["asserts"];
      const id = `u${Date.now().toString(36)}`;
      await repo.saveCase(pid, feature.id, { id, input: { text }, asserts: parsed, split: "train", tags: ["custom"], ...(rubric.trim() ? { rubric } : {}) });
      setText("");
      setErr(undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="stack">
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Case</th>
              <th>Split</th>
              <th>Input</th>
              <th>Checks</th>
              <th>Tags</th>
            </tr>
          </thead>
          <tbody>
            {(cases ?? []).sort((a, b) => a.id.localeCompare(b.id)).map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.id}</td>
                <td><span className="chip">{c.split}</span></td>
                <td><div className="clip">{c.input.text}</div></td>
                <td className="small muted">
                  {c.asserts.length} asserts{c.rubric ? " + rubric" : ""}
                </td>
                <td className="small faint">{c.tags.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card stack">
        <h2>Add a case</h2>
        <label className="field">
          Input
          <textarea style={{ minHeight: 70, fontFamily: "var(--sans)" }} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="grid-2">
          <label className="field">
            Assertions (JSON)
            <textarea value={asserts} onChange={(e) => setAsserts(e.target.value)} />
          </label>
          <label className="field">
            Rubric for the judge (optional)
            <textarea style={{ fontFamily: "var(--sans)" }} value={rubric} onChange={(e) => setRubric(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <button className="btn primary" disabled={!text.trim()} onClick={add}>
            Add case
          </button>
          {err && <span className="small error-text">{err}</span>}
        </div>
      </div>
    </div>
  );
}

function Variants({ pid, feature, variants }: { pid: string; feature: Feature; variants: Variant[] | undefined }) {
  const repo = useRepo();
  const base = variants?.find((v) => v.id === (feature.defaultVariantId ?? "v1"));
  const [sys, setSys] = useState<string>();
  const [tpl, setTpl] = useState<string>();
  const [err, setErr] = useState<string>();
  const create = async () => {
    try {
      const systemInstruction = sys ?? base?.systemInstruction ?? "";
      const promptTemplate = tpl ?? base?.promptTemplate ?? "{{input}}";
      if (!promptTemplate.includes("{{input}}")) throw new Error("the template must contain {{input}}");
      const n = Math.max(0, ...(variants ?? []).map((v) => Number(v.id.replace(/\D/g, "")) || 0)) + 1;
      await repo.addVariant(pid, { id: `v${n}`, featureId: feature.id, systemInstruction, promptTemplate, sha256: await variantHash(systemInstruction, promptTemplate), origin: "human", ...(base ? { parentId: base.id } : {}) });
      setSys(undefined);
      setTpl(undefined);
      setErr(undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="stack">
      {(variants ?? []).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map((v) => (
        <div key={v.id} className="card">
          <div className="card-head">
            <h3 className="mono">{v.id}</h3>
            <div className="row">
              <span className="chip">{v.origin}</span>
              {v.targetModelId && <span className="chip device mono">{v.targetModelId}</span>}
              <span className="faint small mono">{v.sha256.slice(0, 12)}</span>
            </div>
          </div>
          {v.rationale && <p className="small muted">{v.rationale}</p>}
          <div className="grid-2">
            <div>
              <div className="small faint">System instruction</div>
              <pre className="codebox">{v.systemInstruction}</pre>
            </div>
            <div>
              <div className="small faint">Prompt template</div>
              <pre className="codebox">{v.promptTemplate}</pre>
            </div>
          </div>
        </div>
      ))}
      <div className="card stack">
        <h2>New variant</h2>
        <p className="small muted" style={{ margin: 0 }}>Variants are immutable; results reference them by id and hash.</p>
        <div className="grid-2">
          <label className="field">
            System instruction
            <textarea value={sys ?? base?.systemInstruction ?? ""} onChange={(e) => setSys(e.target.value)} />
          </label>
          <label className="field">
            Prompt template
            <textarea value={tpl ?? base?.promptTemplate ?? ""} onChange={(e) => setTpl(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <button className="btn primary" onClick={create}>Save as new variant</button>
          {err && <span className="small error-text">{err}</span>}
        </div>
      </div>
    </div>
  );
}

function PolicyTab({ pid, fid }: { pid: string; fid: string }) {
  const repo = useRepo();
  const policies = useLive<PublishedPolicy[]>((cb) => repo.watchPolicies(pid, fid, cb), [pid, fid]);
  const live = policies?.[0];
  return (
    <div className="stack">
      {!live && <div className="empty">Nothing published yet. Finish a run, then compile and publish from the run page.</div>}
      {live && (
        <div className="card">
          <div className="card-head">
            <h2>Live: version {live.version}</h2>
            <span className="faint small">published {timeAgo(live.publishedAt?.toMillis())} · Remote Config key <span className="mono">tandem_policy_{fid}</span></span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Mode</th>
                <th>Variant</th>
                <th>Reason</th>
                <th className="num">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(live.policy.rules).map(([t, r]) => (
                <tr key={t}>
                  <td className="mono">{t}</td>
                  <td><span className={`chip ${r.mode.includes("DEVICE") ? "device" : "cloud"}`}>{r.mode}</span></td>
                  <td className="mono">{r.variantId}</td>
                  <td className="small">{r.reason}</td>
                  <td className="num small mono">{r.evidence ? `${r.evidence.passes}/${r.evidence.n} · LB ${r.evidence.lb.toFixed(3)}` : "—"}</td>
                </tr>
              ))}
              <tr>
                <td className="mono faint">default</td>
                <td><span className="chip cloud">{live.policy.default.mode}</span></td>
                <td className="mono">{live.policy.default.variantId}</td>
                <td className="small">{live.policy.default.reason}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {policies && policies.length > 1 && (
        <div className="card">
          <h2>History</h2>
          <table>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td className="mono">v{p.version}</td>
                  <td className="small">{p.reason ?? "published"}</td>
                  <td className="faint small">{timeAgo(p.publishedAt?.toMillis())}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
