import { useState } from "react";
import { decide, DEFAULT_GATES, isDeviceTarget, type Case, type Evidence, type Feature, type Job, type ModelId, type Variant } from "@tandem/core";
import { FirebaseAIBackend } from "@tandem/runtime";
import { cloudAvailable, firebase } from "../firebase.js";
import type { Run } from "../data/repo.js";
import { proposeRepair, trainFailures, type CandidateVerdict } from "../repair.js";
import { go, pct, useRepo } from "./hooks.js";
import { repairModel } from "./models.js";
import { useRunner } from "./runner.js";
import type { Settings } from "./RunPage.js";

/** Gate results for every candidate variant measured beside its parent in this run. */
export function GatesPanel({ verdicts }: { verdicts: CandidateVerdict[] }) {
  if (verdicts.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h2>Repair gates</h2>
        <span className="faint small">
          Train LB ≥ τ · holdout LB ≥ τ − {DEFAULT_GATES.holdoutSlack}, no overfit · non-inferior on every other target (margin {DEFAULT_GATES.regressionMargin}). Only accepted candidates reach the compiled policy.
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Candidate</th>
            <th>For</th>
            <th>Train</th>
            <th>Holdout</th>
            <th>Regression</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {verdicts.map((v) => {
            const cell = (name: string) => {
              const r = v.evaluation.gates.find((x) => x.gate === name);
              if (!r) return <span className="faint small">not reached</span>;
              return (
                <span className="small">
                  <span className={r.pass ? "ok" : "error-text"}>{r.pass ? "✓" : "✗"}</span> {r.detail}
                </span>
              );
            };
            return (
              <tr key={v.candidate + v.target}>
                <td className="mono">
                  {v.candidate} <span className="faint">← {v.parent}</span>
                </td>
                <td>
                  <span className="chip device mono">{v.target}</span>
                </td>
                <td>{cell("train")}</td>
                <td>{cell("holdout")}</td>
                <td>{cell("regression")}</td>
                <td>
                  <span className={`chip ${v.evaluation.accepted ? "device" : ""}`}>
                    {v.evaluation.accepted ? "Accepted" : `Rejected at ${v.evaluation.failedAt}`}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Offer a cloud repair for every device model the parent variant failed on. The repair model sees
 * train failures only; the candidate then runs beside the parent on every target of this run.
 */
export function RepairCard(o: {
  pid: string;
  uid: string;
  run: Run;
  feature: Feature;
  variants: Variant[];
  cases: Case[];
  jobs: Job[];
  evidence: Evidence[];
  settings: Settings;
  finished: boolean;
}) {
  const repo = useRepo();
  const runner = useRunner();
  const [busy, setBusy] = useState<ModelId>();
  const [error, setError] = useState<string>();
  const parentId = o.feature.defaultVariantId ?? "v1";
  const failing = o.evidence.filter((e) => e.variantId === parentId && isDeviceTarget(e.target) && !decide(e, o.settings).routeToDevice);
  if (failing.length === 0) return null;

  const repair = async (target: ModelId) => {
    setBusy(target);
    setError(undefined);
    try {
      const parent = o.variants.find((v) => v.id === parentId);
      if (!parent) throw new Error(`parent variant ${parentId} not found`);
      const candidate = await proposeRepair({
        backend: new FirebaseAIBackend(firebase().ai),
        model: repairModel(),
        feature: o.feature,
        parent,
        target,
        failures: trainFailures(o.jobs, new Map(o.cases.map((c) => [c.id, c])), parentId, target),
        existingIds: o.variants.map((v) => v.id),
      });
      await repo.addVariant(o.pid, candidate);
      const rid = await repo.createRun(
        o.pid,
        {
          featureId: o.feature.id,
          variantIds: [parentId, candidate.id],
          targets: o.run.targets,
          samples: o.run.samples,
          cases: o.cases.map((c) => ({ id: c.id, split: c.split })),
        },
        o.uid,
        `repair ${candidate.id} for ${target}`,
      );
      runner.setDevice(true);
      runner.setCloud(true);
      go("p", o.pid, "f", o.feature.id, "r", rid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h2>Repair</h2>
        <span className="faint small">
          {repairModel()} rewrites the prompt from train failures only — holdout cases stay unseen — then the candidate runs beside {parentId} on every target.
        </span>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        {failing.map((e) => (
          <div key={e.target} className="row" style={{ justifyContent: "space-between" }}>
            <span className="small">
              <span className="chip device mono">{e.target}</span> {parentId} passes {pct(e.passRate)} (LB {e.lb.toFixed(3)} &lt; τ {o.settings.tau})
            </span>
            <button className="btn" disabled={!cloudAvailable || !o.finished || busy !== undefined} onClick={() => repair(e.target)}>
              {busy === e.target ? "Proposing…" : `Repair for ${e.target}`}
            </button>
          </div>
        ))}
      </div>
      {!cloudAvailable && <p className="small faint">Repair calls a cloud model through Firebase AI Logic, so it needs a real Firebase project (not local mode).</p>}
      {error && <p className="small error-text">{error}</p>}
    </div>
  );
}
