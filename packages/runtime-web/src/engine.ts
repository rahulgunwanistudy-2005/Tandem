import {
  backoffMs,
  checkBudget,
  classifyWebError,
  familyOf,
  parseModelId,
  parseOutput,
  renderPrompt,
  resolveRule,
  TandemError,
  validateOutput,
  type Backend,
  type ErrorCode,
  type InferenceMode,
  type ModelId,
  type OutputKind,
  type OutputSchema,
  type Policy,
  type PolicyRule,
  type TelemetryEvent,
} from "@tandem/core";
import type {
  InferenceBackend,
  InferenceRequest,
  PolicySource,
  TelemetryRecorder,
} from "./types.js";

export const SDK_VERSION = "0.1.0";
export const DEFAULT_CLOUD_MODEL = "gemini-3.5-flash-lite";

export interface EngineOptions {
  /** This client's model id, e.g. `chrome:158` (see `detectModelId`). */
  modelId: ModelId;
  backend: InferenceBackend;
  policies: PolicySource;
  telemetry?: TelemetryRecorder;
  /** Cloud model when the policy does not name one. */
  defaultCloudModel?: string;
  /** Output tokens reserved when checking the on-device context budget. */
  reservedOutputTokens?: number;
  /** Retries on BUSY (exponential backoff with full jitter) before escalating. */
  busyRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  newId?: () => string;
  rand?: () => number;
}

export interface GenerateResult<T = unknown> {
  /** Parsed, schema-validated output (the raw string for text features). */
  value: T;
  text: string;
  /** Where the returned answer was produced. */
  backend: Backend;
  /** True when the route's first choice failed and another target answered. */
  escalated: boolean;
  /** Why the first choice failed, when escalated. */
  escalationReason?: ErrorCode;
  featureId: string;
  modelId: ModelId;
  variantId: string;
  policyVersion: number;
  mode: InferenceMode;
  matchedBy: "exact" | "wildcard" | "default";
  latencyMs: number;
}

export interface Route {
  featureId: string;
  modelId: ModelId;
  policyVersion: number;
  rule: PolicyRule;
  variantId: string;
  matchedBy: "exact" | "wildcard" | "default";
  /** The order the engine will try targets in. */
  order: ReadonlyArray<"device" | "cloud">;
}

type Attempt =
  | { ok: true; text: string; value: unknown; backend: Backend; validation: "pass" | "skipped" }
  | {
      ok: false;
      code: ErrorCode;
      message: string;
      backend: Backend;
      validation: "fail" | "skipped";
    };

export function orderFor(mode: InferenceMode): ReadonlyArray<"device" | "cloud"> {
  switch (mode) {
    case "ONLY_ON_DEVICE":
      return ["device"];
    case "PREFER_ON_DEVICE":
      return ["device", "cloud"];
    case "PREFER_IN_CLOUD":
      return ["cloud", "device"];
    case "ONLY_IN_CLOUD":
      return ["cloud"];
  }
}

export function outputKindOf(policy: Policy): OutputKind {
  return policy.outputKind ?? (policy.outputSchema ? "json" : "text");
}

/**
 * Parse and validate a model answer. A device answer is only trusted after this passes, which is
 * what makes the fallback *verified* rather than blind.
 */
export function verifyOutput(
  kind: OutputKind,
  schema: OutputSchema | undefined,
  text: string,
): { ok: true; value: unknown; checked: boolean } | { ok: false; message: string } {
  const parsed = parseOutput(kind, text);
  if (!parsed.ok) return { ok: false, message: parsed.error };
  if (!schema || kind === "text")
    return { ok: true, value: parsed.value, checked: kind !== "text" };
  const issues = validateOutput(schema, parsed.value);
  if (issues.length > 0) {
    const first = issues[0];
    return {
      ok: false,
      message: `${issues.length} schema issue(s); first: ${first ? `${first.path || "$"}: ${first.message}` : "?"}`,
    };
  }
  return { ok: true, value: parsed.value, checked: true };
}

/**
 * The runtime decision loop shared by every web app:
 * resolve the published rule for this model → try targets in rule order → on the device, check
 * availability and the context budget first, retry BUSY, reject any answer that did not really
 * come from the device (integrity), validate the output → escalate on any failure the rule allows
 * → record one content-free telemetry event.
 */
export class TandemEngine {
  private readonly o: Required<Omit<EngineOptions, "telemetry">> & {
    telemetry?: TelemetryRecorder;
  };

  constructor(options: EngineOptions) {
    parseModelId(options.modelId); // throws on a malformed id
    this.o = {
      defaultCloudModel: DEFAULT_CLOUD_MODEL,
      reservedOutputTokens: 256,
      busyRetries: 2,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      newId: () => globalThis.crypto.randomUUID(),
      rand: Math.random,
      ...options,
    };
  }

  get modelId(): ModelId {
    return this.o.modelId;
  }

  /** What would happen for this feature on this client, without calling a model. */
  route(featureId: string): Route {
    const policy = this.policy(featureId);
    const { rule, matchedBy } = resolveRule(policy, this.o.modelId);
    return {
      featureId,
      modelId: this.o.modelId,
      policyVersion: policy.version,
      rule,
      variantId: rule.variantId,
      matchedBy,
      order: this.isDeviceClient() ? orderFor(rule.mode) : ["cloud"],
    };
  }

  async generate<T = unknown>(featureId: string, input: string): Promise<GenerateResult<T>> {
    const t0 = this.o.now();
    const policy = this.policy(featureId);
    const { rule, variant, matchedBy } = resolveRule(policy, this.o.modelId);
    const kind = outputKindOf(policy);
    const req: Omit<InferenceRequest, "target"> = {
      systemInstruction: variant.systemInstruction,
      prompt: renderPrompt(variant.promptTemplate, input),
      outputKind: kind,
      ...(policy.outputSchema ? { outputSchema: policy.outputSchema } : {}),
      cloudModel: policy.cloudModel ?? this.o.defaultCloudModel,
    };
    const order = this.isDeviceClient() ? orderFor(rule.mode) : (["cloud"] as const);

    let firstFailure: ErrorCode | undefined;
    let last: Attempt | undefined;
    for (const [i, target] of order.entries()) {
      last = target === "device" ? await this.tryDevice(req) : await this.call({ ...req, target });
      if (last.ok) {
        const latencyMs = this.o.now() - t0;
        const escalated = i > 0;
        this.emit({
          featureId,
          policy,
          variantId: rule.variantId,
          mode: rule.mode,
          backend: last.backend,
          latencyMs,
          validation: last.validation,
          escalated,
          ...(escalated && firstFailure ? { errorCode: firstFailure } : {}),
        });
        return {
          value: last.value as T,
          text: last.text,
          backend: last.backend,
          escalated,
          ...(escalated && firstFailure ? { escalationReason: firstFailure } : {}),
          featureId,
          modelId: this.o.modelId,
          variantId: rule.variantId,
          policyVersion: policy.version,
          mode: rule.mode,
          matchedBy,
          latencyMs,
        };
      }
      firstFailure ??= last.code;
    }

    // Every allowed target failed. `last` is always set: order is never empty.
    const fail = last as Extract<Attempt, { ok: false }>;
    this.emit({
      featureId,
      policy,
      variantId: rule.variantId,
      mode: rule.mode,
      backend: fail.backend,
      latencyMs: this.o.now() - t0,
      validation: fail.validation,
      escalated: order.length > 1,
      errorCode: fail.code,
    });
    throw new TandemError(fail.code, fail.message);
  }

  private policy(featureId: string): Policy {
    const p = this.o.policies.get(featureId);
    if (!p) throw new TandemError("UNKNOWN", `no routing policy for feature "${featureId}"`);
    return p;
  }

  /** Only Chrome clients have a device model on the web. */
  private isDeviceClient(): boolean {
    return parseModelId(this.o.modelId).platform === "chrome";
  }

  private async tryDevice(req: Omit<InferenceRequest, "target">): Promise<Attempt> {
    let availability;
    try {
      availability = await this.o.backend.availability();
    } catch (e) {
      return fail(classifyWebError(e), errorMessage(e));
    }
    if (availability === "downloading")
      return fail("MODEL_DOWNLOADING", "on-device model is still downloading");
    if (availability !== "available")
      return fail(
        "MODEL_UNAVAILABLE",
        availability === "downloadable"
          ? "on-device model not downloaded; call prepareDevice() from a user gesture"
          : "on-device model unavailable on this client",
      );

    const budget = checkBudget(
      `${req.systemInstruction}\n${req.prompt}`,
      familyOf(this.o.modelId),
      this.o.reservedOutputTokens,
    );
    if (!budget.fits) return fail("INPUT_TOO_LONG", budget.reason ?? "input over device budget");

    const attempt = await this.call({ ...req, target: "device" });
    if (attempt.ok && attempt.backend !== "ON_DEVICE")
      // The SDK reported a non-device answer for a device-only call. Never count or serve it as
      // on-device: escalate so the cloud call is explicit and visible in telemetry.
      return {
        ok: false,
        code: "INTEGRITY_CLOUD_ANSWER",
        message: `device call answered by ${attempt.backend}`,
        backend: attempt.backend,
        validation: "skipped",
      };
    return attempt;
  }

  private async call(req: InferenceRequest): Promise<Attempt> {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.o.backend.generate(req);
      } catch (e) {
        const code = classifyWebError(e);
        if (code === "BUSY" && attempt < this.o.busyRetries) {
          await this.o.sleep(backoffMs(attempt, 250, 4000, this.o.rand));
          continue;
        }
        return fail(code, errorMessage(e));
      }
      // A call that was not sent to the device can never be reported as an on-device answer.
      const backend: Backend =
        req.target === "cloud" && res.backend === "ON_DEVICE" ? "UNKNOWN" : res.backend;
      const v = verifyOutput(req.outputKind, req.outputSchema, res.text);
      if (!v.ok)
        return {
          ok: false,
          code: "SCHEMA_INVALID",
          message: v.message,
          backend,
          validation: "fail",
        };
      return {
        ok: true,
        text: res.text,
        value: v.value,
        backend,
        validation: v.checked ? "pass" : "skipped",
      };
    }
  }

  private emit(e: {
    featureId: string;
    policy: Policy;
    variantId: string;
    mode: InferenceMode;
    backend: Backend;
    latencyMs: number;
    validation: TelemetryEvent["validation"];
    escalated: boolean;
    errorCode?: ErrorCode;
  }): void {
    if (!this.o.telemetry) return;
    const event: TelemetryEvent = {
      eventId: this.o.newId(),
      featureId: e.featureId,
      modelId: this.o.modelId,
      platform: parseModelId(this.o.modelId).platform,
      policyVersion: e.policy.version,
      variantId: e.variantId,
      mode: e.mode,
      backend: e.backend,
      latencyMs: Math.max(0, Math.round(e.latencyMs)),
      validation: e.validation,
      escalated: e.escalated,
      ...(e.errorCode ? { errorCode: e.errorCode } : {}),
      ts: Math.round(this.o.now()),
      sdk: `web/${SDK_VERSION}`,
    };
    try {
      this.o.telemetry.record(event);
    } catch {
      // Telemetry must never break an app's inference call.
    }
  }
}

function fail(code: ErrorCode, message: string): Attempt {
  return { ok: false, code, message, backend: "UNKNOWN", validation: "skipped" };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
