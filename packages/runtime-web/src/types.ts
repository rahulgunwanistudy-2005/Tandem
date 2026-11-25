import type { Backend, OutputKind, OutputSchema, Policy, TelemetryEvent } from "@tandem/core";

/** Chrome Prompt API availability, as returned by `LanguageModel.availability()`. */
export type DeviceAvailability = "available" | "downloadable" | "downloading" | "unavailable";

/** One inference on one explicit target. The engine owns fallback; backends never fall back. */
export interface InferenceRequest {
  target: "device" | "cloud";
  systemInstruction: string;
  prompt: string;
  outputKind: OutputKind;
  outputSchema?: OutputSchema;
  cloudModel: string;
}

export interface InferenceResponse {
  text: string;
  /** Where the answer really came from, as reported by the SDK. */
  backend: Backend;
}

/** Thin seam over Firebase AI Logic so routing, verification and telemetry are testable. */
export interface InferenceBackend {
  availability(): Promise<DeviceAvailability>;
  generate(req: InferenceRequest): Promise<InferenceResponse>;
}

export interface PolicySource {
  get(featureId: string): Policy | undefined;
}

export interface TelemetryRecorder {
  record(event: TelemetryEvent): void;
}

export interface TelemetrySink {
  write(events: readonly TelemetryEvent[]): Promise<void>;
}
