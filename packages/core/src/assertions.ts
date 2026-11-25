import type { Assert, CheckResult, Scalar } from "./contracts.js";
import { readPath } from "./path.js";

/** Evaluate one deterministic assertion against the parsed output. Never throws. */
export function evaluateAssert(a: Assert, output: unknown, index = 0): CheckResult {
  const id = `assert:${index}:${a.kind}`;
  let read;
  try {
    read = readPath(output, a.path);
  } catch (e) {
    return { id, pass: false, detail: (e as Error).message };
  }
  const value = read.found ? read.value : undefined;

  switch (a.kind) {
    case "equals": {
      const pass = read.found && scalarEquals(value, a.value);
      return {
        id,
        pass,
        ...(pass ? {} : { detail: `expected ${show(a.value)}, got ${show(value)}` }),
      };
    }
    case "one_of": {
      const pass = read.found && a.values.some((x) => scalarEquals(value, x));
      return {
        id,
        pass,
        ...(pass
          ? {}
          : { detail: `got ${show(value)}, expected one of ${a.values.map(show).join(", ")}` }),
      };
    }
    case "not_null": {
      const pass = read.found && value !== null && value !== undefined && value !== "";
      return { id, pass, ...(pass ? {} : { detail: "value is missing, null or empty" }) };
    }
    case "regex": {
      if (typeof value !== "string")
        return { id, pass: false, detail: `expected string, got ${show(value)}` };
      let re: RegExp;
      try {
        re = new RegExp(a.pattern, a.flags ?? "");
      } catch (e) {
        return { id, pass: false, detail: `bad pattern: ${(e as Error).message}` };
      }
      const hit = re.test(value);
      const pass = a.negate ? !hit : hit;
      return {
        id,
        pass,
        ...(pass
          ? {}
          : { detail: a.negate ? `must not match /${a.pattern}/` : `must match /${a.pattern}/` }),
      };
    }
    case "length": {
      if (typeof value !== "string")
        return { id, pass: false, detail: `expected string, got ${show(value)}` };
      const len = a.unit === "words" ? countWords(value) : [...value].length;
      const okMin = a.min === undefined || len >= a.min;
      const okMax = a.max === undefined || len <= a.max;
      const pass = okMin && okMax;
      return {
        id,
        pass,
        ...(pass
          ? {}
          : { detail: `${len} ${a.unit ?? "chars"}, expected ${a.min ?? 0}–${a.max ?? "∞"}` }),
      };
    }
    case "contains": {
      if (typeof value !== "string")
        return { id, pass: false, detail: `expected string, got ${show(value)}` };
      const hay = a.caseSensitive ? value : value.toLowerCase();
      const needle = a.caseSensitive ? a.substring : a.substring.toLowerCase();
      const hit = hay.includes(needle);
      const pass = a.negate ? !hit : hit;
      return {
        id,
        pass,
        ...(pass
          ? {}
          : {
              detail: a.negate
                ? `must not contain "${a.substring}"`
                : `must contain "${a.substring}"`,
            }),
      };
    }
  }
}

function scalarEquals(v: unknown, expected: Scalar): boolean {
  if (typeof expected === "string" && typeof v === "string") return v.trim() === expected;
  return v === expected;
}

export function countWords(s: string): number {
  const t = s.trim();
  return t === "" ? 0 : t.split(/\s+/u).length;
}

function show(v: unknown): string {
  if (v === undefined) return "(missing)";
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
