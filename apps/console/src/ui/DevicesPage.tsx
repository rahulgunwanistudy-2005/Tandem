import { useState } from "react";
import type { Device } from "../data/repo.js";
import { cloudAvailable } from "../firebase.js";
import { timeAgo, useLive, useRepo } from "./hooks.js";
import { referenceModel } from "./models.js";
import { useRunner } from "./runner.js";

export function DevicesPage({ pid, uid }: { pid: string; uid: string }) {
  const repo = useRepo();
  const runner = useRunner();
  const devices = useLive<Device[]>((cb) => repo.watchDevices(pid, cb), [pid]);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: Date }>();
  const [err, setErr] = useState<string>();

  const ready = runner.availability === "available";
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Devices & runner</h1>
          <p className="sub">
            Each device runs only the jobs addressed to its own model. Answers that did not come from
            the device are recorded as integrity failures, never as passes.
          </p>
        </div>
      </div>

      <div className="grid-2">
        <div className="card stack">
          <div className="card-head">
            <h2>
              <span className={`dot ${runner.deviceOn ? "device live" : "device"}`} /> This browser
            </h2>
            <span className="chip device mono">{runner.modelId}</span>
          </div>
          {!runner.isChrome ? (
            <p className="muted">
              This browser has no on-device model Tandem can use. Open the console in desktop Chrome
              139+ to run on Gemini Nano.
            </p>
          ) : (
            <>
              <dl className="kv">
                <dt>Gemini Nano</dt>
                <dd>
                  <b>{runner.availability}</b>{" "}
                  <button className="btn ghost sm" onClick={runner.refresh}>
                    recheck
                  </button>
                </dd>
                <dt>Jobs completed</dt>
                <dd className="mono">{runner.done.device}</dd>
              </dl>
              {runner.availability === "downloadable" && (
                <button className="btn device" onClick={runner.enableModel}>
                  Download Gemini Nano
                </button>
              )}
              {runner.downloadProgress !== undefined && (
                <div>
                  <div className="bar">
                    <i className="device" style={{ width: `${runner.downloadProgress * 100}%` }} />
                  </div>
                  <p className="small faint">Downloading… {Math.round(runner.downloadProgress * 100)}%</p>
                </div>
              )}
              {runner.availability === "unavailable" && (
                <p className="small muted">
                  Chrome reports the model as unavailable. Check <span className="mono">chrome://on-device-internals</span>{" "}
                  (≥ 22 GB free disk; GPU with &gt; 4 GB VRAM or 16 GB RAM).
                </p>
              )}
              <div className="row">
                <button
                  className={`btn ${runner.deviceOn ? "" : "device"}`}
                  disabled={!ready && !runner.deviceOn}
                  onClick={() => runner.setDevice(!runner.deviceOn)}
                >
                  {runner.deviceOn ? "Stop device runner" : "Start device runner"}
                </button>
                <span className="small faint">Keep this tab in the foreground while it runs.</span>
              </div>
            </>
          )}
        </div>

        <div className="card stack">
          <div className="card-head">
            <h2>
              <span className={`dot ${runner.cloudOn ? "cloud live" : "cloud"}`} /> Cloud reference & judge
            </h2>
            <span className="chip cloud mono">cloud:{referenceModel()}</span>
          </div>
          {!cloudAvailable ? (
            <p className="muted">Needs a Firebase project with AI Logic (local mode has no cloud).</p>
          ) : (
            <>
              <p className="small muted" style={{ margin: 0 }}>
                Runs the reference jobs <b>ONLY_IN_CLOUD</b> through Firebase AI Logic, and grades rubric
                cases with the judge model (each verdict cached by output hash).
              </p>
              <dl className="kv">
                <dt>Reference jobs</dt>
                <dd className="mono">{runner.done.cloud}</dd>
                <dt>Judged</dt>
                <dd className="mono">{runner.done.judge}</dd>
              </dl>
              <div className="row">
                <button className={`btn ${runner.cloudOn ? "" : "cloud"}`} onClick={() => runner.setCloud(!runner.cloudOn)}>
                  {runner.cloudOn ? "Stop reference runner" : "Start reference runner"}
                </button>
                <button className="btn" onClick={() => runner.setJudge(!runner.judgeOn)}>
                  {runner.judgeOn ? "Stop judge" : "Start judge"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>Registered devices</h2>
          <div className="row">
            {pairing && (
              <span className="chip">
                Pair code <b className="mono">{pairing.code}</b> · expires {pairing.expiresAt.toLocaleTimeString()}
              </span>
            )}
            <button
              className="btn sm"
              onClick={() => repo.createPairing(pid, uid).then(setPairing, (e: Error) => setErr(e.message))}
            >
              Pair a phone
            </button>
          </div>
        </div>
        {err && <p className="small error-text">{err}</p>}
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Model</th>
              <th>Availability</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {(devices ?? []).map((d) => (
              <tr key={d.id}>
                <td>{d.label ?? d.platform}</td>
                <td className="mono">{d.modelId}</td>
                <td>{d.availability}</td>
                <td className="faint">{timeAgo(d.lastSeen?.toMillis())}</td>
              </tr>
            ))}
            {devices && devices.length === 0 && (
              <tr>
                <td colSpan={4} className="faint">
                  No devices yet. Start the device runner above, or pair the Android runner app.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Runner log</h2>
        {runner.error && <p className="small error-text">{runner.error}</p>}
        <div className="log">
          {runner.log.length === 0 && <span className="faint">Nothing yet.</span>}
          {runner.log.map((l, i) => (
            <div key={i}>
              <span className={`dot ${l.kind === "device" ? "device" : l.kind === "cloud" ? "cloud" : ""}`} />{" "}
              <span className="faint">{new Date(l.at).toLocaleTimeString()}</span> {l.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
