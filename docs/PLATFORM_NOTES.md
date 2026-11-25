# Platform notes

Verified against firebase.google.com docs on **2026-11-25** (pages last updated 2026-11-18 UTC).
Rule: if behaviour disagrees with these notes, trust behaviour, update this file, and design around it.

## Differences from the original brief

| Topic                   | Brief said                              | Docs say (Nov 25)                                                                                                                                    |
| ----------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android on-device SDK   | `firebase-ai-ondevice:16.0.0-beta01`    | `firebase-ai:18.2.0` + `firebase-ai-ondevice:16.0.0-beta08` + `firebase-appcheck-debug:20.1.0`; on-device SDK is **not in the BoM**                  |
| Android model download  | app must handle DOWNLOADABLE            | confirmed, via `FirebaseAIOnDevice.checkStatus()` / `FirebaseAIOnDevice.download(): Flow<DownloadStatus>`                                            |
| Android model variant   | `getBaseModelName()`                    | `OnDeviceConfig(modelOption = OnDeviceModelOption.STABLE / PREVIEW / PREVIEW_FAST)`; base model name still via ML Kit (verify on device)             |
| iOS API                 | `hybridModel(primary:, secondary:)`     | `ai.generativeModelSession(model: .hybridModel(primary:, secondary:))`; ONLY_ON_DEVICE = session with `FirebaseAI.SystemLanguageModel.default` alone |
| iOS "which backend"     | unknown                                 | `response.rawResponse.modelVersion`; on-device value is `apple-foundation-models-system-language-model`                                              |
| iOS tools               | "coming soon, do not use"               | page now says custom function calling **is** supported on-device. Still not used (not needed).                                                       |
| iOS structured output   | docs thin                               | still "docs are coming soon" — test on hardware before relying on it                                                                                 |
| Web on-device init      | not mentioned                           | `model.initializeDeviceModel(progressCb)` **must** be called on/after a user gesture before the first request                                        |
| Web default cloud model | —                                       | JS SDK ≥ 13.0.0 defaults the hybrid cloud model to `gemini-3.5-flash-lite`                                                                           |
| Current models          | gemini-3.5-flash-lite, gemini-3.8-flash | also `gemini-4-hydrogen` (newest/strongest — use for repair). Gemini 2.5 rerouted from Dec 1.                                                        |

## Web (Chrome desktop) — `firebase` JS SDK (npm latest: 13.4.0)

- Chrome **139+ desktop**. Flag: `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` → Enabled.
- Hardware gate (Chrome docs): ≥ 22 GB free on the profile volume; GPU > 4 GB VRAM, or CPU with
  ≥ 16 GB RAM and ≥ 4 cores. Check `chrome://on-device-internals`.
- Raw Prompt API (used for the model-check UI): `LanguageModel.availability()` →
  `"unavailable" | "downloadable" | "downloading" | "available"`; `LanguageModel.create({ monitor })`
  with `downloadprogress` events (`e.loaded` 0..1).

```ts
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } from "firebase/ai";
const ai = getAI(app, { backend: new GoogleAIBackend() });
const model = getGenerativeModel(ai, {
  mode: InferenceMode.ONLY_ON_DEVICE,            // PREFER_ON_DEVICE | ONLY_ON_DEVICE | PREFER_IN_CLOUD | ONLY_IN_CLOUD
  inCloudParams: { model: "gemini-3.5-flash-lite",
                   generationConfig: { responseMimeType: "application/json", responseSchema: schema } },
  onDeviceParams: { createOptions: { expectedInputs: [{ type: "text", languages: ["en"] }],
                                     initialPrompts: [{ role: "system", content: [{ type: "text", value: sys }] }] },
                    promptOptions: { responseConstraint: schema } },
});
await model.initializeDeviceModel((p) => …);     // on a user gesture; p is 0..1
const result = await model.generateContent(prompt);
result.response.inferenceSource;                  // "on_device" | "in_cloud" (lowercase values!)
result.response.text();
```

### Verified in the installed SDK (firebase 13.4.0 → @firebase/ai 3.1.0), 2026-11-25

Read from `dist/ai-public.d.ts` and `dist/esm/index.esm.js`, not from memory:

- Enum **values are lowercase**: `InferenceMode.ONLY_ON_DEVICE === "only_on_device"`,
  `InferenceSource.ON_DEVICE === "on_device"`. Contracts use the uppercase names; the runtime maps
  (`toBackend` in `packages/runtime-web/src/firebase.ts`).
- `ONLY_ON_DEVICE` with availability `downloadable`/`downloading` makes the SDK **await the download
  promise** before calling the model, and the download can only start from a user gesture. Tandem
  therefore checks `LanguageModel.availability()` itself and skips the device unless it is
  `available` (escalating with `MODEL_UNAVAILABLE` / `MODEL_DOWNLOADING`).
- `ONLY_ON_DEVICE` + `unavailable` throws `AIError("api-not-enabled")`; a non-available model at call
  time throws `AIError("unsupported", "...ONLY_ON_DEVICE, but an on-device model is not available.")`.
- The Chrome adapter **creates a new session per call** (and destroys the previous one), so calls are
  single-turn with no history leakage.
- `systemInstruction` is **not** forwarded to Chrome; it must be an `initialPrompts` system message
  in `onDeviceParams.createOptions`. Tandem sets both.
- `LanguageModelCreateCoreOptions` = `{ expectedInputs?, expectedOutputs?, monitor? }`;
  `LanguageModelCreateOptions` adds `{ signal?, initialPrompts? }`; `promptOptions = { responseConstraint?: object }`.
- `AIError extends FirebaseError` with `code: AIErrorCode` (`"error" | "request-error" | "response-error"
| "fetch-error" | "api-not-enabled" | "unsupported" | ...`).
- `generationConfig.responseSchema: TypedSchema | SchemaRequest` (plain objects are accepted).

- Enum output: cloud `responseMimeType: "text/x.enum"`, schema `Schema.enumString({ enum: [...] })`.
- Not supported on-device: multi-turn chat, tools, non-JPEG/PNG images, file URLs.
- Not supported in hybrid at all: Live API, server prompt templates, reliable `countTokens`.
- AI Monitoring in the console shows **nothing** for on-device calls.

## Android — Kotlin

```kotlin
implementation("com.google.firebase:firebase-ai:18.2.0")
implementation("com.google.firebase:firebase-ai-ondevice:16.0.0-beta08")
implementation("com.google.firebase:firebase-appcheck-debug:20.1.0")

@OptIn(PublicPreviewAPI::class)
val model = Firebase.ai(backend = GenerativeBackend.googleAI()).generativeModel(
  modelName = "gemini-3.5-flash-lite",
  generationConfig = generationConfig { responseMimeType = "application/json"; responseSchema = … },
  onDeviceConfig = OnDeviceConfig(mode = InferenceMode.ONLY_ON_DEVICE, maxOutputTokens = 256,
                                  modelOption = OnDeviceModelOption.STABLE),
)
val r = model.generateContent(prompt); r.inferenceSource  // ON_DEVICE | IN_CLOUD
FirebaseAIOnDevice.checkStatus()   // OnDeviceModelStatus.UNAVAILABLE | DOWNLOADABLE | DOWNLOADING | AVAILABLE
FirebaseAIOnDevice.download().collect { DownloadStarted | DownloadInProgress | DownloadCompleted | DownloadFailed }
onDeviceExtension?.warmUp()
```

- SDK ≥ 17.10.0 (BoM 34.10.0). Supported devices: ML Kit GenAI device list.
- Foreground only. English + Korean validated. **4000-token** total request limit; avoid outputs
  > 256 tokens. `ErrorCode.BUSY` on bursts (exponential backoff);
  > `ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED` for long-window quota.
- SDK does **not** trigger the download; the app must.
- Multi-turn on-device concatenates history and does not fall back → Tandem is single-turn only.
- TODO (on hardware): confirm exception class names that carry `ErrorCode`; confirm whether on-device
  honours `responseSchema` (docs page `hybrid/android/generate-structured-output`).

## iOS — Swift (Firebase iOS SDK ≥ 12.13.0, SPM only; products `FirebaseAILogic`, `FirebaseAppCheck`)

```swift
let ai = FirebaseAI.firebaseAI(backend: .googleAI())
let system = FirebaseAI.SystemLanguageModel.default
let deviceOnly = ai.generativeModelSession(model: system)                 // ONLY_ON_DEVICE
let hybrid = ai.generativeModelSession(model: .hybridModel(primary: system,
                                       secondary: ai.geminiModel(name: "gemini-3.5-flash-lite")))
let r = try await deviceOnly.respond(to: prompt)
r.content; r.rawResponse.modelVersion  // "apple-foundation-models-system-language-model" when on-device
switch system.availability { case .available, .unavailable(.deviceNotEligible),
  .unavailable(.appleIntelligenceNotEnabled), .unavailable(.modelNotReady), .unavailable(_) }
// options: .hybrid(gemini: GenerationConfig(...), foundationModels: FirebaseAI.GenerationOptions(temperature:))
```

- Text only on-device. 4096 tokens shared by input + output. Foreground only. Apple Intelligence
  must be enabled. Sessions keep history → Tandem creates a **fresh session per job**.
- App Check debug: `AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())` **before**
  `FirebaseApp.configure()`.

## App Check

Enforced for AI Logic in all projects since **Nov 2, 2026**. Debug providers:
web `self.FIREBASE_APPCHECK_DEBUG_TOKEN = true` before `initializeAppCheck`; Android
`DebugAppCheckProviderFactory.getInstance()`; iOS `AppCheckDebugProviderFactory()`. Tokens are
registered in Console → Security → App Check → Apps → ⋮ → Manage debug tokens.

## Remote Config

- **Web, verified** in `@firebase/remote-config` 0.10.0 typings: `getRemoteConfig(app)`,
  `rc.settings.{minimumFetchIntervalMillis, fetchTimeoutMillis}`, `fetchAndActivate(rc)`,
  `activate(rc)`, `getValue(rc, key).asString()`, `setCustomSignals(rc, { [k]: string | number | null })`,
  `onConfigUpdate(rc, { next(update), error(e), complete() }) → Unsubscribe` where
  `update.getUpdatedKeys(): Set<string>`. Real-time updates are **fetched but not active** until
  `activate(rc)` is called — the runtime activates, then reloads only the updated keys.
- Android (`setCustomSignals { put(...) }`, `addOnConfigUpdateListener`) and iOS
  (`setCustomSignals`, `addOnConfigUpdateListener`): still to verify from installed artifacts.
- Firestore (4.20.0): `writeBatch(db)`, `doc(db, ...path)`, `Timestamp.fromMillis(ms)` — verified.
- Tandem resolves the policy JSON on the client by `modelId`, so it works without conditions;
  custom-signal conditions are only a canary optimisation.
