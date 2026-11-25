import { useMemo, useState } from "react";
import { DEFAULT_ROLLBACK, isDeviceTarget } from "@tandem/core";
import { summarize, type HourAggregate, type Incident, type ModelSummary } from "../data/observe.js";
import { href, ms, pct, timeAgo, useLive, useRepo } from "./hooks.js";

const HOUR = 3_600_000;

/** Field behaviour of published policies: content-free runtime telemetry, rolled up hourly. */
export function ObservePage({ pid }: { pid: string }) {
  const repo = useRepo();
  const [since] = useState(() => Math.floor(Date.now() / HOUR) * HOUR - 23 * HOUR);
  const aggs = useLive<HourAggregate[]>((cb) => repo.watchTelemetry(pid, since, cb), [pid, since]);
  const incidents = useLive<Incident[]>((cb) => repo.watchIncidents(pid, cb), [pid]);
  const rows = useMemo(() => summarize(aggs ?? []), [aggs]);
  const t = DEFAULT_ROLLBACK;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Observe</h1>
          <p className="sub">
            Last 24 hours of runtime telemetry from apps on <span className="mono">@tandem/runtime</span>. Events carry no prompt or output text — only route, backend, latency, validation and error code.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>Routes in the field</h2>
          <span className="faint small">
            Auto-rollback demotes an on-device rule when the Wilson lower bound of its escalation rate exceeds {pct(t.maxEscalationRate)} or of its error rate exceeds {pct(t.maxErrorRate)}, over ≥ {t.minAttempts} attempts in the last hour.
          </span>
        </div>
        {aggs === undefined ? (
          <p className="faint small">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="faint small">No telemetry yet. It appears here within five minutes of an app calling tandem.generate() with telemetry on.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Feature</th>
                <th>Model</th>
                <th className="num">Calls</th>
                <th>By hour</th>
                <th className="num">On device</th>
                <th className="num">Escalated (LB)</th>
                <th className="num">Errors (LB)</th>
                <th className="num">Worst p95</th>
                <th>Policy</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.featureId + r.modelId} r={r} pid={pid} since={since} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Incidents</h2>
          <span className="faint small">Every automatic demotion, with the evidence that triggered it.</span>
        </div>
        {!incidents?.length ? (
          <p className="faint small">None. No live on-device rule has been demoted.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Feature</th>
                <th>Model</th>
                <th>Metric</th>
                <th className="num">Observed</th>
                <th className="num">Lower bound</th>
                <th className="num">Window</th>
                <th>Policy</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.id}>
                  <td className="small">{timeAgo(i.at?.toMillis())}</td>
                  <td><a href={href("p", pid, "f", i.featureId, "policy")}>{i.featureId}</a></td>
                  <td><span className="chip device mono">{i.target}</span></td>
                  <td className="small">{i.metric.replace("_", " ")}</td>
                  <td className="num">{pct(i.observed, 1)}</td>
                  <td className="num"><b>{i.lowerBound.toFixed(3)}</b> <span className="faint small">&gt; {i.threshold}</span></td>
                  <td className="num small">{i.window.attempts} calls / {Math.round(i.window.ms / 60000)} min</td>
                  <td className="small">v{i.fromVersion} → v{i.toVersion} <span className="chip cloud">cloud</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Row({ r, pid, since }: { r: ModelSummary; pid: string; since: number }) {
  const max = Math.max(1, ...r.hours.map(([, a, b]) => a + b));
  const byHour = new Map(r.hours.map(([h, a, b]) => [h, [a, b] as const]));
  return (
    <tr>
      <td><a href={href("p", pid, "f", r.featureId)}>{r.featureId}</a></td>
      <td><span className={`chip ${isDeviceTarget(r.modelId) ? "device" : "cloud"} mono`}>{r.modelId}</span></td>
      <td className="num">{r.calls}</td>
      <td>
        <span className="spark" title="calls per hour: device / other">
          {Array.from({ length: 24 }, (_, i) => {
            const [d, o] = byHour.get(since + i * HOUR) ?? [0, 0];
            return (
              <span key={i} className="spark-col">
                <i className="device" style={{ height: `${(d / max) * 100}%` }} />
                <i className="cloud" style={{ height: `${(o / max) * 100}%` }} />
              </span>
            );
          })}
        </span>
      </td>
      <td className="num">{pct(r.onDeviceShare)}</td>
      <td className="num">{r.deviceAttempts ? <>{pct(r.escalationRate, 1)} <span className="faint small">({r.escalationLb.toFixed(2)})</span></> : <span className="faint">—</span>}</td>
      <td className="num">{r.deviceAttempts ? <>{pct(r.errorRate, 1)} <span className="faint small">({r.errorLb.toFixed(2)})</span></> : <span className="faint">—</span>}{r.topError && <div className="faint small mono">{r.topError}</div>}</td>
      <td className="num">{ms(r.worstP95Ms ?? undefined)}</td>
      <td className="small">
        v{r.versions.join(", v")}
        {r.atRisk && <span className="chip" style={{ marginLeft: 6 }}>at rollback threshold</span>}
      </td>
    </tr>
  );
}
