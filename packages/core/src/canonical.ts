/**
 * Canonical JSON (sorted keys, no whitespace) and SHA-256, used for:
 *  - variant hashes: sha256(systemInstruction + "\u0000" + promptTemplate)
 *  - the judge cache key: sha256(canonical([featureId, variantId, caseId, canonicalOutput]))
 * so that a rerun never pays the judge twice for an identical output.
 * Uses Web Crypto (browsers and Node ≥ 20), no dependencies.
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const child = (v as Record<string, unknown>)[k];
      if (child !== undefined) out[k] = sortKeys(child);
    }
    return out;
  }
  return v;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function variantHash(systemInstruction: string, promptTemplate: string): Promise<string> {
  return sha256Hex(`${systemInstruction}\u0000${promptTemplate}`);
}

/**
 * Judge cache key. `output` is the parsed output when parsing succeeded (so whitespace and key
 * order differences hit the cache), otherwise the raw text.
 */
export function judgeCacheKey(
  featureId: string,
  variantId: string,
  caseId: string,
  output: unknown,
): Promise<string> {
  return sha256Hex(canonicalJson([featureId, variantId, caseId, output]));
}
