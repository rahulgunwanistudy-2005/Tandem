/**
 * Firebase adapters. Every API used here was checked against the installed typings
 * (firebase 13.4.0: @firebase/ai 3.1.0, @firebase/remote-config 0.10.0, @firebase/firestore 4.20.0)
 * and recorded in docs/PLATFORM_NOTES.md.
 */
import type { FirebaseApp } from "firebase/app";
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode as SdkMode,
  InferenceSource as SdkSource,
  type AI,
  type GenerationConfig,
  type GenerativeModel,
  type LanguageModelCreateOptions,
  type SchemaRequest,
} from "firebase/ai";
import {
  activate,
  fetchAndActivate,
  getRemoteConfig,
  getValue,
  onConfigUpdate,
  setCustomSignals,
  type RemoteConfig,
} from "firebase/remote-config";
import { doc, Timestamp, writeBatch, type Firestore } from "firebase/firestore";
import type {
  Backend,
  ModelId,
  OutputKind,
  OutputSchema,
  Policy,
  TelemetryEvent,
} from "@tandem/core";
import { chromeAvailability, detectModelId, toJsonSchema, type JsonSchema } from "./device.js";
import { DEFAULT_CLOUD_MODEL, TandemEngine, type GenerateResult, type Route } from "./engine.js";
import { policyKey, PolicyStore, type PolicyChange } from "./policy.js";
import { TelemetryQueue, type TelemetryQueueOptions } from "./telemetry.js";
import type {
  DeviceAvailability,
  InferenceBackend,
  InferenceRequest,
  InferenceResponse,
  TelemetrySink,
} from "./types.js";

/** SDK `inferenceSource` ("on_device" | "in_cloud") → contract backend. */
export function toBackend(source: string | undefined, target: "device" | "cloud"): Backend {
  if (source === SdkSource.ON_DEVICE) return "ON_DEVICE";
  if (source === SdkSource.IN_CLOUD) return "IN_CLOUD";
  // A cloud-only call cannot have run on the device; an unlabeled device call is not trusted.
  return target === "cloud" ? "IN_CLOUD" : "UNKNOWN";
}

export function cloudGenerationConfig(
  kind: OutputKind,
  schema: OutputSchema | undefined,
): GenerationConfig | undefined {
  if (kind === "enum" && schema?.enum)
    return {
      responseMimeType: "text/x.enum",
      responseSchema: { type: "string", format: "enum", enum: [...schema.enum] } as SchemaRequest,
    };
  if (kind === "json")
    return {
      responseMimeType: "application/json",
      ...(schema ? { responseSchema: schema as unknown as SchemaRequest } : {}),
    };
  return undefined;
}

export function deviceConstraint(
  kind: OutputKind,
  schema: OutputSchema | undefined,
): JsonSchema | undefined {
  if (kind === "text" || !schema) return undefined;
  if (kind === "enum")
    return { type: "string", ...(schema.enum ? { enum: [...schema.enum] } : {}) };
  return toJsonSchema(schema);
}

const MODEL_CACHE = 32;

/** Firebase AI Logic hybrid inference with the target pinned per call (ONLY_ON_DEVICE / ONLY_IN_CLOUD). */
export class FirebaseAIBackend implements InferenceBackend {
  private readonly models = new Map<string, GenerativeModel>();

  constructor(
    private readonly ai: AI,
    private readonly languages: string[] = ["en"],
  ) {}

  createOptions(systemInstruction?: string): LanguageModelCreateOptions {
    return {
      expectedInputs: [{ type: "text", languages: this.languages }],
      expectedOutputs: [{ type: "text", languages: this.languages }],
      // Chrome ignores `systemInstruction`; on device it must be the session's system prompt.
      ...(systemInstruction
        ? {
            initialPrompts: [
              { role: "system", content: [{ type: "text", value: systemInstruction }] },
            ],
          }
        : {}),
    };
  }

  availability(): Promise<DeviceAvailability> {
    return chromeAvailability(this.createOptions());
  }

  /** Start (or join) the Gemini Nano download. Must be called from a user gesture. */
  async prepare(onProgress?: (fraction: number) => void): Promise<void> {
    const model = getGenerativeModel(this.ai, {
      mode: SdkMode.PREFER_ON_DEVICE,
      inCloudParams: { model: DEFAULT_CLOUD_MODEL },
      onDeviceParams: { createOptions: this.createOptions() },
    });
    await model.initializeDeviceModel(onProgress);
  }

  async generate(req: InferenceRequest): Promise<InferenceResponse> {
    const result = await this.model(req).generateContent(req.prompt);
    return {
      text: result.response.text(),
      backend: toBackend(result.response.inferenceSource, req.target),
    };
  }

  private model(req: InferenceRequest): GenerativeModel {
    const key = JSON.stringify([
      req.target,
      req.cloudModel,
      req.systemInstruction,
      req.outputKind,
      req.outputSchema ?? null,
    ]);
    const hit = this.models.get(key);
    if (hit) return hit;
    const generationConfig = cloudGenerationConfig(req.outputKind, req.outputSchema);
    const responseConstraint = deviceConstraint(req.outputKind, req.outputSchema);
    const model = getGenerativeModel(this.ai, {
      mode: req.target === "device" ? SdkMode.ONLY_ON_DEVICE : SdkMode.ONLY_IN_CLOUD,
      inCloudParams: {
        model: req.cloudModel,
        systemInstruction: req.systemInstruction,
        ...(generationConfig ? { generationConfig } : {}),
      },
      onDeviceParams: {
        createOptions: this.createOptions(req.systemInstruction),
        ...(responseConstraint ? { promptOptions: { responseConstraint } } : {}),
      },
    });
    if (this.models.size >= MODEL_CACHE) {
      const oldest = this.models.keys().next().value;
      if (oldest !== undefined) this.models.delete(oldest);
    }
    this.models.set(key, model);
    return model;
  }
}

export const TELEMETRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Writes to `projects/{projectId}/telemetry_raw/{eventId}`; the rules enforce the allowlist. */
export class FirestoreTelemetrySink implements TelemetrySink {
  constructor(
    private readonly db: Firestore,
    private readonly projectId: string,
  ) {}

  async write(events: readonly TelemetryEvent[]): Promise<void> {
    const batch = writeBatch(this.db);
    for (const e of events)
      batch.set(doc(this.db, "projects", this.projectId, "telemetry_raw", e.eventId), {
        ...e,
        expireAt: Timestamp.fromMillis(e.ts + TELEMETRY_TTL_MS),
      });
    await batch.commit();
  }
}

export interface CreateTandemOptions {
  app: FirebaseApp;
  /** Features this app calls; their policies are read from `tandem_policy_<featureId>`. */
  features: string[];
  /** Bundled policies used until Remote Config answers (ship them so first launch works offline). */
  defaults?: Record<string, Policy>;
  /** Content-free runtime telemetry into the Tandem project. Requires a signed-in user. */
  telemetry?: ({ firestore: Firestore; projectId: string } & TelemetryQueueOptions) | false;
  modelId?: ModelId;
  languages?: string[];
  ai?: AI;
  remoteConfig?: RemoteConfig;
  /** Apply published policies as they change (Remote Config real-time). Default true. */
  realtime?: boolean;
  minimumFetchIntervalMillis?: number;
  onError?: (e: unknown) => void;
}

export interface Tandem {
  readonly modelId: ModelId;
  readonly policies: PolicyStore;
  /** Resolves once the first Remote Config fetch has been applied (or failed). */
  readonly ready: Promise<void>;
  generate<T = unknown>(featureId: string, input: string): Promise<GenerateResult<T>>;
  route(featureId: string): Route;
  deviceAvailability(): Promise<DeviceAvailability>;
  prepareDevice(onProgress?: (fraction: number) => void): Promise<void>;
  onPolicyChange(listener: (c: PolicyChange) => void): () => void;
  flushTelemetry(): Promise<void>;
  dispose(): void;
}

/** One call to wire Tandem into a web app. */
export function createTandem(o: CreateTandemOptions): Tandem {
  const modelId = o.modelId ?? detectModelId();
  const policies = new PolicyStore(o.defaults);
  const backend = new FirebaseAIBackend(
    o.ai ?? getAI(o.app, { backend: new GoogleAIBackend() }),
    o.languages,
  );
  const queue =
    o.telemetry === undefined || o.telemetry === false
      ? undefined
      : new TelemetryQueue(
          new FirestoreTelemetrySink(o.telemetry.firestore, o.telemetry.projectId),
          {
            ...o.telemetry,
            ...(o.onError ? { onError: o.onError } : {}),
          },
        );
  const engine = new TandemEngine({
    modelId,
    backend,
    policies,
    ...(queue ? { telemetry: queue } : {}),
  });

  const rc = o.remoteConfig ?? getRemoteConfig(o.app);
  rc.settings.minimumFetchIntervalMillis = o.minimumFetchIntervalMillis ?? 60 * 60 * 1000;
  const load = (keys?: Set<string>) => {
    for (const f of o.features)
      if (!keys || keys.has(policyKey(f)))
        policies.applyRaw(f, getValue(rc, policyKey(f)).asString());
  };
  const report = (e: unknown) => o.onError?.(e);

  const ready = (async () => {
    // Lets the Remote Config console target conditions at a model (canary); not needed for routing.
    await setCustomSignals(rc, { tandem_model_id: modelId }).catch(report);
    await fetchAndActivate(rc).catch(report); // offline: keep the last activated values
    load();
  })();

  const unsubscribe =
    o.realtime === false
      ? undefined
      : onConfigUpdate(rc, {
          next: (update) => {
            activate(rc)
              .then(() => load(update.getUpdatedKeys()))
              .catch(report);
          },
          error: report,
          complete: () => undefined,
        });

  const onHide = () => {
    if (globalThis.document?.visibilityState === "hidden") void queue?.flush();
  };
  globalThis.addEventListener?.("visibilitychange", onHide);

  return {
    modelId,
    policies,
    ready,
    generate: <T>(featureId: string, input: string) => engine.generate<T>(featureId, input),
    route: (featureId) => engine.route(featureId),
    deviceAvailability: () => backend.availability(),
    prepareDevice: (onProgress) => backend.prepare(onProgress),
    onPolicyChange: (l) => policies.subscribe(l),
    flushTelemetry: () => queue?.flush() ?? Promise.resolve(),
    dispose: () => {
      unsubscribe?.();
      queue?.dispose();
      globalThis.removeEventListener?.("visibilitychange", onHide);
    },
  };
}
