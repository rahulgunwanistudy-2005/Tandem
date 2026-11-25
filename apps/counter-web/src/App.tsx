import { useEffect, useMemo, useRef, useState } from "react";
import type { DeviceAvailability, GenerateResult, Route, Tandem } from "@tandem/runtime";
import { boot, FEATURES, local, tandemProject } from "./tandem.js";

/** Sample inbound messages (demo content). Nothing below is precomputed: every label is a live call. */
const INBOX = [
  { id: "m1", from: "Priya S.", text: "Hi, my order CT-48213 arrived with the mug smashed. I need a replacement before Friday, it's a gift." },
  { id: "m2", from: "Tomás R.", text: "Hola, mi pedido CT-81234 todavía no ha llegado. ¿Me pueden decir dónde está?" },
  { id: "m3", from: "Claire D.", text: "Bonjour, est-ce que je peux changer l'adresse de livraison de CT-48802 ?" },
  { id: "m4", from: "Jonas W.", text: "Hallo, wann wird meine Bestellung CT-36621 verschickt?" },
  { id: "m5", from: "Sam K.", text: "I was charged twice for the same order (CT-55031). Please fix this today." },
  { id: "m6", from: "Ana P.", text: "Do the linen napkins shrink in the wash?" },
  { id: "m7", from: "Ravi M.", text: "Please cancel my order CT-60918, I ordered the wrong colour." },
];

interface Triage {
  intent: string;
  urgency: "low" | "normal" | "high";
  orderId: string | null;
  language: string;
}

type Outcome<T> = { result: GenerateResult<T> } | { error: string };

const errorText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return local && /API key not valid|API_KEY_INVALID/.test(m) ? "The cloud route needs a Firebase project — local mode has none." : m;
};

export function App() {
  const [tandem, setTandem] = useState<Tandem>();
  const [bootError, setBootError] = useState<string>();
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    let t: Tandem | undefined;
    let dead = false;
    boot((e) => setErrors((x) => [...x.slice(-4), e instanceof Error ? e.message : String(e)]))
      .then((x) => {
        if (dead) x.dispose();
        else setTandem((t = x));
      })
      .catch((e) => setBootError(String(e)));
    return () => {
      dead = true;
      t?.dispose();
    };
  }, []);

  if (bootError) return <div className="center error">Could not start: {bootError}</div>;
  if (!tandem) return <div className="center muted">Starting…</div>;
  return <Inbox tandem={tandem} errors={errors} />;
}

function Inbox({ tandem, errors }: { tandem: Tandem; errors: string[] }) {
  const [selected, setSelected] = useState(INBOX[0]!.id);
  const [draft, setDraft] = useState("");
  const [custom, setCustom] = useState<{ id: string; from: string; text: string }[]>([]);
  const messages = useMemo(() => [...custom, ...INBOX], [custom]);
  const msg = messages.find((m) => m.id === selected) ?? messages[0]!;
  const routes = useRoutes(tandem);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo">C</span> Counter <span className="faint">support</span>
        </div>
        <StatusBar tandem={tandem} routes={routes} />
      </header>
      {local && (
        <div className="banner">
          Local mode: Remote Config has no emulator, so Counter keeps its bundled policy (v0 — every model on the cloud) and cloud calls need a Firebase project. Point <span className="mono">VITE_FIREBASE_*</span> at a project to see live routing.
        </div>
      )}
      <div className="body">
        <aside className="list">
          <form
            className="compose"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.trim()) return;
              const m = { id: `c${Date.now()}`, from: "You", text: draft.trim() };
              setCustom((c) => [m, ...c]);
              setSelected(m.id);
              setDraft("");
            }}
          >
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Paste a customer message…" rows={2} />
            <button className="btn" disabled={!draft.trim()}>Add</button>
          </form>
          {messages.map((m) => (
            <button key={m.id} className={`item ${m.id === msg.id ? "active" : ""}`} onClick={() => setSelected(m.id)}>
              <b>{m.from}</b>
              <span className="snippet">{m.text}</span>
            </button>
          ))}
        </aside>
        <main className="detail">
          <Message key={msg.id} tandem={tandem} text={msg.text} from={msg.from} />
          {errors.length > 0 && (
            <details className="errors">
              <summary>{errors.length} SDK notice{errors.length > 1 ? "s" : ""}</summary>
              {errors.map((e, i) => <div key={i} className="mono small">{e}</div>)}
            </details>
          )}
        </main>
      </div>
    </div>
  );
}

function useRoutes(tandem: Tandem) {
  const [routes, setRoutes] = useState<Route[]>(() => FEATURES.map((f) => tandem.route(f)));
  const [flash, setFlash] = useState<string>();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = tandem.onPolicyChange((c) => {
      setRoutes(FEATURES.map((f) => tandem.route(f)));
      setFlash(`${c.featureId} policy v${c.policy.version} applied — no release`);
      clearTimeout(timer);
      timer = setTimeout(() => setFlash(undefined), 6000);
    });
    void tandem.ready.then(() => setRoutes(FEATURES.map((f) => tandem.route(f))));
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [tandem]);
  return { routes, flash };
}

function StatusBar({ tandem, routes }: { tandem: Tandem; routes: ReturnType<typeof useRoutes> }) {
  const [avail, setAvail] = useState<DeviceAvailability>();
  const [progress, setProgress] = useState<number>();
  useEffect(() => {
    void tandem.deviceAvailability().then(setAvail, () => setAvail("unavailable"));
  }, [tandem]);
  return (
    <div className="status">
      {routes.flash && <span className="flash">{routes.flash}</span>}
      <span className="pill mono" title="This browser's model id — the key policies route on">{tandem.modelId}</span>
      <span className="pill" title="Chrome's built-in model on this machine">
        Gemini Nano: {avail ?? "…"}
        {(avail === "downloadable" || avail === "downloading") && (
          <button
            className="link"
            onClick={() =>
              tandem.prepareDevice(setProgress).then(
                () => tandem.deviceAvailability().then(setAvail),
                () => setAvail("unavailable"),
              )
            }
          >
            {progress !== undefined ? ` ${Math.round(progress * 100)}%` : " enable"}
          </button>
        )}
      </span>
      {routes.routes.map((r) => (
        <span key={r.featureId} className="pill" title={`matched ${r.matchedBy}; reason ${r.rule.reason}`}>
          {r.featureId} v{r.policyVersion} → <RouteDot order={r.order} />
        </span>
      ))}
      <span className="pill faint" title="Content-free telemetry to the Tandem project">
        telemetry {tandemProject ? "on" : "off"}
      </span>
    </div>
  );
}

function RouteDot({ order }: { order: Route["order"] }) {
  const first = order[0] ?? "cloud";
  return (
    <span className={`route ${first}`}>
      <i /> {first === "device" ? "on device" : "cloud"}
    </span>
  );
}

function Message({ tandem, text, from }: { tandem: Tandem; text: string; from: string }) {
  const [triage, setTriage] = useState<Outcome<Triage>>();
  const [reply, setReply] = useState<Outcome<{ reply: string }>>();
  const [replyBusy, setReplyBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    tandem.generate<Triage>("triage", text).then(
      (result) => setTriage({ result }),
      (e) => setTriage({ error: errorText(e) }),
    );
  }, [tandem, text]);

  const draftReply = async () => {
    setReplyBusy(true);
    try {
      setReply({ result: await tandem.generate<{ reply: string }>("reply", text) });
    } catch (e) {
      setReply({ error: errorText(e) });
    } finally {
      setReplyBusy(false);
    }
  };

  return (
    <article className="message">
      <div className="from">{from}</div>
      <p className="text">{text}</p>

      <section className="card">
        <div className="card-head">
          <h3>Triage</h3>
          {triage && "result" in triage && <Provenance r={triage.result} />}
        </div>
        {!triage && <div className="muted small">Classifying…</div>}
        {triage && "error" in triage && <div className="error small">{triage.error}</div>}
        {triage && "result" in triage && (
          <div className="labels">
            <Label k="intent" v={triage.result.value.intent} />
            <Label k="urgency" v={triage.result.value.urgency} strong={triage.result.value.urgency === "high"} />
            <Label k="order" v={triage.result.value.orderId ?? "—"} mono />
            <Label k="language" v={triage.result.value.language} />
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Reply draft</h3>
          {reply && "result" in reply && <Provenance r={reply.result} />}
          {!reply && (
            <button className="btn" onClick={draftReply} disabled={replyBusy}>
              {replyBusy ? "Drafting…" : "Draft reply"}
            </button>
          )}
        </div>
        {reply && "error" in reply && <div className="error small">{reply.error}</div>}
        {reply && "result" in reply && <p className="reply">{reply.result.value.reply}</p>}
      </section>
    </article>
  );
}

function Label({ k, v, mono, strong }: { k: string; v: string; mono?: boolean; strong?: boolean }) {
  return (
    <div className="label">
      <span className="faint small">{k}</span>
      <span className={`${mono ? "mono" : ""} ${strong ? "strong" : ""}`}>{v}</span>
    </div>
  );
}

/** Where the answer came from, as reported by Firebase AI Logic — never assumed. */
function Provenance({ r }: { r: GenerateResult }) {
  const where = r.backend === "ON_DEVICE" ? "device" : "cloud";
  return (
    <span className="prov small">
      <span className={`route ${where}`}>
        <i /> {where === "device" ? "on device" : "cloud"}
      </span>
      <span className="faint">
        {r.variantId} · policy v{r.policyVersion} · {Math.round(r.latencyMs)} ms
        {r.escalated && ` · escalated (${r.escalationReason ?? "fallback"})`}
      </span>
    </span>
  );
}
