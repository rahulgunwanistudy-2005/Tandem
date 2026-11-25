import type { ModelId, OutputSchema } from "@tandem/core";
import type { DeviceAvailability } from "./types.js";

interface NavigatorLike {
  userAgent?: string;
  userAgentData?: { brands?: ReadonlyArray<{ brand: string; version: string }>; mobile?: boolean };
}

/**
 * This client's model id. Chrome desktop ships Gemini Nano tied to the browser build, so the
 * major version identifies the on-device model (`chrome:158`); the console's runner records
 * results under the same id. Every other browser is `cloud:web` and always routes to the cloud.
 */
export function detectModelId(nav: NavigatorLike | undefined = globalThis.navigator): ModelId {
  if (!nav) return "cloud:web";
  if (nav.userAgentData?.mobile) return "cloud:web";
  const brand = nav.userAgentData?.brands?.find((b) => b.brand === "Google Chrome");
  if (brand && /^\d+$/.test(brand.version)) return `chrome:${brand.version}`;
  const ua = nav.userAgent ?? "";
  if (/Edg\/|OPR\/|SamsungBrowser|Mobile|Android/.test(ua)) return "cloud:web";
  const m = /Chrome\/(\d+)\./.exec(ua);
  return m ? `chrome:${m[1]}` : "cloud:web";
}

interface LanguageModelGlobal {
  availability(options?: unknown): Promise<string>;
}

/** Chrome's own answer for this exact create-options shape (languages matter). */
export async function chromeAvailability(
  createOptions: unknown,
  g: { LanguageModel?: LanguageModelGlobal } = globalThis as never,
): Promise<DeviceAvailability> {
  if (!g.LanguageModel) return "unavailable";
  const a = await g.LanguageModel.availability(createOptions);
  return a === "available" || a === "downloadable" || a === "downloading" ? a : "unavailable";
}

export type JsonSchema = { [k: string]: unknown };

/**
 * Tandem's output schema (an OpenAPI subset shared with Gemini) → JSON Schema for Chrome's
 * `responseConstraint`. `nullable` becomes a type union; objects are closed so the device model
 * cannot invent keys the cloud schema would never return.
 */
export function toJsonSchema(s: OutputSchema): JsonSchema {
  const out: JsonSchema = { type: s.nullable ? [s.type, "null"] : s.type };
  if (s.description !== undefined) out.description = s.description;
  if (s.enum) out.enum = s.nullable ? [...s.enum, null] : [...s.enum];
  if (s.properties) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]),
    );
    out.additionalProperties = false;
  }
  if (s.required) out.required = [...s.required];
  if (s.items) out.items = toJsonSchema(s.items);
  for (const k of ["minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum"] as const)
    if (s[k] !== undefined) out[k] = s[k];
  return out;
}
