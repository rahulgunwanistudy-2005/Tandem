/**
 * Counter's whole Tandem integration. The app never decides where a prompt runs: it calls
 * tandem.generate() and the published policy (Remote Config `tandem_policy_<feature>`) decides,
 * per model, with a verified fallback to the cloud.
 *
 * With no VITE_FIREBASE_PROJECT_ID it runs against the local emulators. Remote Config has no
 * emulator, so locally the app keeps its bundled policy (every model on the cloud default).
 */
import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { connectAuthEmulator, getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { compilePolicy, DEFAULT_SETTINGS, type Policy } from "@tandem/core";
import { createTandem, type Tandem } from "@tandem/runtime";
import { counterDemo } from "../../console/src/data/seed.js";

const env = import.meta.env;
const DEMO_PROJECT = "demo-tandem";
export const projectId: string = env.VITE_FIREBASE_PROJECT_ID || DEMO_PROJECT;
export const local = projectId === DEMO_PROJECT;
/** The Tandem project (console) this app reports telemetry to. */
export const tandemProject: string | undefined =
  new URLSearchParams(location.search).get("pid") ?? (env.VITE_TANDEM_PROJECT || undefined);

export const FEATURES = ["triage", "reply"] as const;

/**
 * What the app ships with: version 0 of each policy, compiled with no evidence, so every model
 * starts on the cloud default until a published policy arrives. Tandem never guesses a device route.
 */
async function bundledPolicies(): Promise<Record<string, Policy>> {
  const out: Record<string, Policy> = {};
  for (const { feature, variants } of await counterDemo()) {
    out[feature.id] = compilePolicy({
      feature,
      defaultVariantId: "v1",
      variants: Object.fromEntries(variants.map((v) => [v.id, { systemInstruction: v.systemInstruction, promptTemplate: v.promptTemplate, sha256: v.sha256 }])),
      evidence: [],
      settings: DEFAULT_SETTINGS,
      version: 0,
      sourceRunIds: [],
      now: new Date(0),
    });
  }
  return out;
}

export async function boot(onError: (e: unknown) => void): Promise<Tandem> {
  const app = initializeApp({
    apiKey: env.VITE_FIREBASE_API_KEY || "demo-api-key",
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
    projectId,
    appId: env.VITE_FIREBASE_APP_ID || "1:000000000000:web:0000000000000000",
  });
  const siteKey = env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;
  if (siteKey) {
    if (env.DEV && env.VITE_APPCHECK_DEBUG_TOKEN)
      (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = env.VITE_APPCHECK_DEBUG_TOKEN;
    initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(siteKey), isTokenAutoRefreshEnabled: true });
  }
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  if (local) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
  }
  // Telemetry writes need a signed-in user; an anonymous one is enough.
  await new Promise<void>((resolve) => {
    const off = onAuthStateChanged(auth, (u) => {
      if (u) {
        off();
        resolve();
      } else signInAnonymously(auth).catch((e) => {
        onError(e);
        off();
        resolve();
      });
    });
  });

  return createTandem({
    app,
    features: [...FEATURES],
    defaults: await bundledPolicies(),
    telemetry: tandemProject ? { firestore, projectId: tandemProject } : false,
    realtime: !local,
    // Short in this demo so a fresh publish shows up on reload too; real-time updates arrive anyway.
    minimumFetchIntervalMillis: local ? 12 * 60 * 60 * 1000 : 60 * 1000,
    onError,
  });
}
