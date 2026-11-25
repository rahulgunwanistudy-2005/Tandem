/**
 * Firebase wiring for the console. APIs checked against the installed typings (firebase 13.4.0:
 * @firebase/auth 1.13.11, @firebase/app-check 0.13.2, @firebase/firestore 4.20.0,
 * @firebase/functions 0.14.0, @firebase/ai 3.1.0) — see docs/PLATFORM_NOTES.md.
 *
 * With no VITE_FIREBASE_PROJECT_ID the console runs against the local emulators (demo-tandem).
 * On-device runs still go to the real Gemini Nano in Chrome; cloud calls need a real project.
 */
import { initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, type Functions } from "firebase/functions";
import { getAI, GoogleAIBackend, type AI } from "firebase/ai";
import { getRemoteConfig, type RemoteConfig } from "firebase/remote-config";

const env = import.meta.env;

export const DEMO_PROJECT = "demo-tandem";
export const projectId: string = env.VITE_FIREBASE_PROJECT_ID || DEMO_PROJECT;
export const emulated: boolean = projectId === DEMO_PROJECT || env.VITE_USE_EMULATORS === "1";
/** Cloud inference (reference, judge, repair) needs a real project with AI Logic enabled. */
export const cloudAvailable: boolean = projectId !== DEMO_PROJECT;

export interface Services {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
  ai: AI;
  remoteConfig: RemoteConfig | undefined;
}

let services: Services | undefined;

export function firebase(): Services {
  if (services) return services;
  const app = initializeApp({
    apiKey: env.VITE_FIREBASE_API_KEY || "demo-api-key",
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
    projectId,
    appId: env.VITE_FIREBASE_APP_ID || "1:000000000000:web:0000000000000000",
    ...(env.VITE_FIREBASE_STORAGE_BUCKET ? { storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET } : {}),
    ...(env.VITE_FIREBASE_MESSAGING_SENDER_ID
      ? { messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID }
      : {}),
  });

  // App Check is enforced for AI Logic (since Nov 2, 2026). The debug token must be set before
  // initializeAppCheck; it is only ever read from a local, untracked .env file.
  const siteKey = env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY;
  if (siteKey) {
    if (env.DEV && env.VITE_APPCHECK_DEBUG_TOKEN) {
      (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
        env.VITE_APPCHECK_DEBUG_TOKEN;
    }
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }

  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app);
  if (emulated) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  }
  services = {
    app,
    auth,
    db,
    functions,
    ai: getAI(app, { backend: new GoogleAIBackend() }),
    // Remote Config is not emulated; model names fall back to the bundled defaults.
    remoteConfig: cloudAvailable ? getRemoteConfig(app) : undefined,
  };
  return services;
}
