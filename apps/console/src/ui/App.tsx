import { useEffect, useState } from "react";
import type { Feature } from "@tandem/core";
import type { Project } from "../data/repo.js";
import { GoogleAuthProvider, signInAnonymously, signInWithPopup, signOut, type User } from "firebase/auth";
import { cloudAvailable, emulated, firebase, projectId } from "../firebase.js";
import { counterDemo } from "../data/seed.js";
import { go, href, useLive, useRepo, useRoute, useUser } from "./hooks.js";
import { loadModelConfig } from "./models.js";
import { RunnerProvider, useRunner } from "./runner.js";
import { FeaturePage } from "./FeaturePage.js";
import { RunPage } from "./RunPage.js";
import { DevicesPage } from "./DevicesPage.js";
import { ObservePage } from "./ObservePage.js";

export function App() {
  const user = useUser();
  useEffect(() => void loadModelConfig(), []);
  if (user === undefined) return <div className="page muted">Loading…</div>;
  if (user === null) return <SignIn />;
  return <Signed user={user} />;
}

function Mark() {
  return (
    <span className="brand-mark" aria-hidden>
      <i />
      <i />
    </span>
  );
}

function SignIn() {
  const [err, setErr] = useState<string>();
  const { auth } = firebase();
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <div className="card" style={{ width: 420, padding: 32 }}>
        <div className="brand" style={{ padding: 0, marginBottom: 12 }}>
          <Mark /> Tandem
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Run your prompts on the real on-device models, let a cloud model judge the failures, and
          publish per-model routing through Remote Config.
        </p>
        <div className="stack" style={{ marginTop: 20 }}>
          <button className="btn primary" onClick={() => signInWithPopup(auth, new GoogleAuthProvider()).catch((e: Error) => setErr(e.message))}>
            Continue with Google
          </button>
          <button className="btn" onClick={() => signInAnonymously(auth).catch((e: Error) => setErr(e.message))}>
            Continue as guest
          </button>
          {err && <p className="small error-text">{err}</p>}
          <p className="small faint">
            {emulated ? `Local emulators · project ${projectId}` : `Firebase project ${projectId}`}
          </p>
        </div>
      </div>
    </div>
  );
}

function Signed({ user }: { user: User }) {
  const route = useRoute();
  const repo = useRepo();
  const projects = useLive<Project[]>((cb) => repo.watchProjects(user.uid, cb), [user.uid]);
  const pid = route[0] === "p" ? route[1] : undefined;

  useEffect(() => {
    if (!pid && projects && projects.length > 0) {
      const last = localStorage.getItem("tandem:lastProject");
      const target = projects.find((p) => p.id === last) ?? projects[0];
      if (target) go("p", target.id);
    }
  }, [pid, projects]);

  if (projects === undefined) return <div className="page muted">Loading projects…</div>;
  if (!pid) return <Onboarding uid={user.uid} />;
  localStorage.setItem("tandem:lastProject", pid);
  return (
    <RunnerProvider key={pid} pid={pid} uid={user.uid}>
      <Shell pid={pid} route={route} user={user} projects={projects} />
    </RunnerProvider>
  );
}

function Onboarding({ uid }: { uid: string }) {
  const repo = useRepo();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const create = async (demo: boolean) => {
    setBusy(true);
    try {
      const pid = await repo.createProject(demo ? "Counter" : "My app", uid);
      if (demo) await repo.seed(pid, await counterDemo());
      go("p", pid);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <div className="card" style={{ width: 520, padding: 32 }}>
        <div className="brand" style={{ padding: 0 }}>
          <Mark /> Create a project
        </div>
        <p className="muted">
          A project holds your app's AI features, their test cases and prompt variants, the devices
          that run them, and the routing policy Tandem publishes.
        </p>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" disabled={busy} onClick={() => create(true)}>
            Start with the Counter demo
          </button>
          <button className="btn" disabled={busy} onClick={() => create(false)}>
            Empty project
          </button>
        </div>
        <p className="small faint" style={{ marginTop: 16 }}>
          Counter is a homeware shop's support inbox: a triage classifier (40 cases) and a reply
          drafter (16 cases with rubrics).
        </p>
        {err && <p className="small error-text">{err}</p>}
      </div>
    </div>
  );
}

function Shell({ pid, route, user, projects }: { pid: string; route: string[]; user: User; projects: { id: string; name: string }[] }) {
  const repo = useRepo();
  const features = useLive<Feature[]>((cb) => repo.watchFeatures(pid, cb), [pid]);
  const runner = useRunner();
  const fid = route[2] === "f" ? route[3] : undefined;
  const rid = route[4] === "r" ? route[5] : undefined;
  const section = route[2];
  const project = projects.find((p) => p.id === pid);

  let page;
  if (fid && rid) page = <RunPage pid={pid} fid={fid} rid={rid} />;
  else if (fid) page = <FeaturePage pid={pid} fid={fid} uid={user.uid} tab={route[4]} />;
  else if (section === "devices") page = <DevicesPage pid={pid} uid={user.uid} />;
  else if (section === "observe") page = <ObservePage pid={pid} />;
  else page = <Overview pid={pid} name={project?.name ?? ""} features={features} />;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <Mark /> Tandem
        </div>
        <select
          aria-label="Project"
          value={pid}
          onChange={(e) => (e.target.value === "__new" ? go() : go("p", e.target.value))}
          style={{ marginBottom: 8 }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <a className={`nav-item ${!section ? "active" : ""}`} href={href("p", pid)}>
          Overview
        </a>
        <a className={`nav-item ${section === "devices" ? "active" : ""}`} href={href("p", pid, "devices")}>
          Devices & runner
          <span className={`dot ${runner.deviceOn ? "device live" : ""}`} />
        </a>
        <a className={`nav-item ${section === "observe" ? "active" : ""}`} href={href("p", pid, "observe")}>
          Observe
        </a>
        <h6>Features</h6>
        {(features ?? []).map((f) => (
          <a key={f.id} className={`nav-item ${fid === f.id ? "active" : ""}`} href={href("p", pid, "f", f.id)}>
            {f.name}
            <span className="faint small mono">{f.outputKind}</span>
          </a>
        ))}
        <div className="side-foot">
          <span>
            <span className={`dot ${runner.deviceOn ? "device live" : ""}`} /> Device runner {runner.deviceOn ? "on" : "off"} ·{" "}
            <span className="mono">{runner.modelId}</span>
          </span>
          <span>
            <span className={`dot ${runner.cloudOn ? "cloud live" : ""}`} /> Cloud reference {runner.cloudOn ? "on" : "off"}
          </span>
          <span className="faint">
            {emulated ? "emulators" : projectId} · {user.isAnonymous ? "guest" : user.email}
          </span>
          <button className="btn ghost sm" style={{ justifySelf: "start", padding: 0 }} onClick={() => signOut(firebase().auth)}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">{page}</main>
    </div>
  );
}

function Overview({ pid, name, features }: { pid: string; name: string; features: { id: string; name: string; description?: string; outputKind: string; latencyBudgetMs: number }[] | undefined }) {
  const runner = useRunner();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{name}</h1>
          <p className="sub">
            Pick a feature, run its cases on this browser's Gemini Nano and on the cloud reference, then
            publish the routing that the evidence supports.
          </p>
        </div>
      </div>
      {!cloudAvailable && (
        <div className="banner" style={{ marginBottom: 16 }}>
          <b>Local mode.</b> On-device runs use the real Gemini Nano in this Chrome; the cloud
          reference, judge and publishing need a Firebase project with AI Logic.
        </div>
      )}
      {runner.isChrome && runner.availability !== "available" && runner.availability !== "checking" && (
        <div className="banner" style={{ marginBottom: 16 }}>
          <span className="dot" />
          Gemini Nano is <b>{runner.availability}</b> in this browser.{" "}
          <a className="btn sm" href={href("p", pid, "devices")}>
            Set up the device runner
          </a>
        </div>
      )}
      <div className="grid-2">
        {(features ?? []).map((f) => (
          <a key={f.id} className="card" href={href("p", pid, "f", f.id)}>
            <div className="card-head">
              <h2>{f.name}</h2>
              <span className="chip mono">{f.outputKind}</span>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              {f.description}
            </p>
            <p className="faint small" style={{ marginBottom: 0 }}>
              latency budget {f.latencyBudgetMs / 1000}s
            </p>
          </a>
        ))}
        {features && features.length === 0 && <div className="empty">No features yet.</div>}
      </div>
    </div>
  );
}
