import { isModelId, type Policy } from "@tandem/core";
import type { PolicySource } from "./types.js";

/** Remote Config parameter that carries a feature's compiled policy. */
export const policyKey = (featureId: string): string => `tandem_policy_${featureId}`;

const MODES = new Set(["PREFER_ON_DEVICE", "ONLY_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"]);

export type PolicyParse = { ok: true; policy: Policy } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function checkRule(r: unknown, where: string, variants: Record<string, unknown>): string | null {
  if (!isObj(r)) return `${where} is not an object`;
  if (typeof r.mode !== "string" || !MODES.has(r.mode)) return `${where}.mode is invalid`;
  if (typeof r.variantId !== "string") return `${where}.variantId is missing`;
  if (!(r.variantId in variants)) return `${where} references unknown variant "${r.variantId}"`;
  return null;
}

/**
 * Structural check of a policy coming off the wire. Deliberately strict about what routing needs
 * and lenient about the rest: a bad publish is rejected as a whole and the last good policy stays
 * live, so a broken config degrades to "no change", never to an exception inside the app.
 */
export function parsePolicy(raw: string, featureId: string): PolicyParse {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (!isObj(v)) return { ok: false, error: "not an object" };
  if (v.schemaVersion !== 1) return { ok: false, error: "unsupported schemaVersion" };
  if (v.featureId !== featureId)
    return { ok: false, error: `featureId is "${String(v.featureId)}", expected "${featureId}"` };
  if (!Number.isInteger(v.version) || (v.version as number) < 1)
    return { ok: false, error: "version must be a positive integer" };
  if (!isObj(v.variants)) return { ok: false, error: "variants missing" };
  for (const [id, variant] of Object.entries(v.variants)) {
    if (
      !isObj(variant) ||
      typeof variant.systemInstruction !== "string" ||
      typeof variant.promptTemplate !== "string"
    )
      return { ok: false, error: `variant "${id}" is malformed` };
  }
  const d = checkRule(v.default, "default", v.variants);
  if (d) return { ok: false, error: d };
  if (!isObj(v.rules)) return { ok: false, error: "rules missing" };
  for (const [model, rule] of Object.entries(v.rules)) {
    if (!isModelId(model)) return { ok: false, error: `rule key "${model}" is not a model id` };
    const e = checkRule(rule, `rules["${model}"]`, v.variants);
    if (e) return { ok: false, error: e };
  }
  return { ok: true, policy: v as unknown as Policy };
}

export interface PolicyChange {
  featureId: string;
  previous?: Policy;
  policy: Policy;
}

/**
 * Holds the live policy per feature. Bundled defaults are used until a remote value arrives; a
 * remote value only replaces the current one if it parses and is not older.
 */
export class PolicyStore implements PolicySource {
  private readonly live = new Map<string, Policy>();
  private readonly listeners = new Set<(c: PolicyChange) => void>();
  /** Last rejection per feature, for the debug panel. */
  readonly rejections = new Map<string, string>();

  constructor(defaults: Record<string, Policy> = {}) {
    for (const [id, p] of Object.entries(defaults)) this.live.set(id, p);
  }

  get(featureId: string): Policy | undefined {
    return this.live.get(featureId);
  }

  features(): string[] {
    return [...this.live.keys()];
  }

  /** Apply a raw remote value. Returns true when the live policy changed. */
  applyRaw(featureId: string, raw: string): boolean {
    if (raw.trim() === "") return false; // parameter not set remotely
    const parsed = parsePolicy(raw, featureId);
    if (!parsed.ok) {
      this.rejections.set(featureId, parsed.error);
      return false;
    }
    this.rejections.delete(featureId);
    const previous = this.live.get(featureId);
    if (previous && parsed.policy.version < previous.version) return false;
    if (previous && JSON.stringify(previous) === JSON.stringify(parsed.policy)) return false;
    this.live.set(featureId, parsed.policy);
    const change: PolicyChange = {
      featureId,
      policy: parsed.policy,
      ...(previous ? { previous } : {}),
    };
    for (const l of this.listeners) {
      try {
        l(change);
      } catch {
        // a listener bug must not stop policy updates
      }
    }
    return true;
  }

  subscribe(listener: (c: PolicyChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
