import type { Split } from "./contracts.js";

/**
 * Deterministic stratified train/holdout split.
 * Within each stratum, cases are ordered by a seeded FNV-1a hash of their id and the first
 * round(n × holdoutShare) go to holdout. Same ids + seed ⇒ same split on every machine, so the
 * holdout cannot silently drift between runs (which would leak it into repair).
 */
export function stratifiedSplit<T extends { id: string }>(
  items: readonly T[],
  stratum: (item: T) => string,
  holdoutShare = 0.3,
  seed = "tandem",
): Map<string, Split> {
  if (!(holdoutShare >= 0 && holdoutShare <= 1))
    throw new RangeError("holdoutShare must be in [0, 1]");
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = stratum(it);
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }
  const out = new Map<string, Split>();
  for (const g of groups.values()) {
    const ordered = [...g].sort(
      (a, b) => fnv1a(seed + a.id) - fnv1a(seed + b.id) || a.id.localeCompare(b.id),
    );
    const h = Math.round(ordered.length * holdoutShare);
    ordered.forEach((it, i) => out.set(it.id, i < h ? "holdout" : "train"));
  }
  return out;
}

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
