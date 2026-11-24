/**
 * Minimal dot-path reader shared by assertions on every platform.
 * Grammar: `""` (root) | segment ("." segment)*, segment = name ("[" index "]")*.
 * Kotlin and Swift runtimes implement exactly this grammar.
 */

export type PathResult = { found: true; value: unknown } | { found: false };

const SEGMENT = /^([A-Za-z_$][A-Za-z0-9_$-]*)((?:\[\d+\])*)$/;

export function parsePath(path: string): Array<string | number> {
  if (path === "") return [];
  const out: Array<string | number> = [];
  for (const raw of path.split(".")) {
    const m = SEGMENT.exec(raw);
    if (!m) throw new SyntaxError(`invalid path segment "${raw}" in "${path}"`);
    out.push(m[1] as string);
    const idx = m[2] ?? "";
    for (const im of idx.matchAll(/\[(\d+)\]/g)) out.push(Number(im[1]));
  }
  return out;
}

export function readPath(root: unknown, path: string): PathResult {
  let cur: unknown = root;
  for (const key of parsePath(path)) {
    if (typeof key === "number") {
      if (!Array.isArray(cur) || key >= cur.length) return { found: false };
      cur = cur[key];
    } else {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return { found: false };
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return { found: false };
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  return { found: true, value: cur };
}
