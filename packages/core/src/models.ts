import type { ModelId, Platform } from "./contracts.js";

const MODEL_ID = /^(chrome|android|ios|cloud):([A-Za-z0-9._-]+|\*)$/;

export function isModelId(s: string): s is ModelId {
  return MODEL_ID.test(s);
}

export function parseModelId(id: string): { platform: Platform; model: string } {
  const m = MODEL_ID.exec(id);
  if (!m) throw new SyntaxError(`invalid modelId "${id}"`);
  return { platform: m[1] as Platform, model: m[2] as string };
}

export function platformOf(id: ModelId): Platform {
  return parseModelId(id).platform;
}

export function isDeviceTarget(id: ModelId): boolean {
  return platformOf(id) !== "cloud";
}

export function wildcardFor(id: ModelId): ModelId {
  return `${platformOf(id)}:*`;
}

/** Model family used by the token-budget estimator. */
export type ModelFamily = "chrome-nano" | "android-nano" | "apple-fm" | "gemini-cloud";

export function familyOf(id: ModelId): ModelFamily {
  switch (platformOf(id)) {
    case "chrome":
      return "chrome-nano";
    case "android":
      return "android-nano";
    case "ios":
      return "apple-fm";
    case "cloud":
      return "gemini-cloud";
  }
}

/** Fill `{{input}}` in a template. Only the one placeholder is supported, by design. */
export function renderPrompt(template: string, input: string): string {
  return template.split("{{input}}").join(input);
}
