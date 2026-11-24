import type { OutputSchema } from "./contracts.js";

/**
 * Validator for the OutputSchema subset (contracts/output-schema.schema.json).
 *
 * This is the "verified" half of verified fallback: the runtime SDK runs it on every on-device
 * answer before accepting it. It is intentionally small and dependency-free so the Kotlin and Swift
 * ports stay line-for-line equivalent. Semantics follow the Gemini Schema:
 *  - properties not listed in `required` are optional;
 *  - `nullable: true` admits null;
 *  - additional properties are rejected (on-device models invent keys; we treat that as a failure).
 */

export interface SchemaIssue {
  path: string;
  message: string;
}

const MAX_ISSUES = 20;

export function validateOutput(schema: OutputSchema, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  walk(schema, value, "", issues);
  return issues;
}

function push(issues: SchemaIssue[], path: string, message: string): void {
  if (issues.length < MAX_ISSUES) issues.push({ path: path || "$", message });
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function walk(s: OutputSchema, v: unknown, path: string, issues: SchemaIssue[]): void {
  if (v === null) {
    if (!s.nullable) push(issues, path, "null is not allowed");
    return;
  }
  switch (s.type) {
    case "object": {
      if (typeOf(v) !== "object") return push(issues, path, `expected object, got ${typeOf(v)}`);
      const obj = v as Record<string, unknown>;
      const props = s.properties ?? {};
      for (const key of s.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) push(issues, join(path, key), "missing required property");
      }
      for (const [key, child] of Object.entries(obj)) {
        const ps = props[key];
        if (!ps) push(issues, join(path, key), "unexpected property");
        else walk(ps, child, join(path, key), issues);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(v)) return push(issues, path, `expected array, got ${typeOf(v)}`);
      if (s.minItems !== undefined && v.length < s.minItems) push(issues, path, `expected ≥ ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) push(issues, path, `expected ≤ ${s.maxItems} items`);
      if (s.items) v.forEach((item, i) => walk(s.items as OutputSchema, item, `${path}[${i}]`, issues));
      return;
    }
    case "string": {
      if (typeof v !== "string") return push(issues, path, `expected string, got ${typeOf(v)}`);
      if (s.enum && !s.enum.includes(v)) push(issues, path, `"${truncate(v)}" is not one of ${s.enum.join("|")}`);
      const len = [...v].length;
      if (s.minLength !== undefined && len < s.minLength) push(issues, path, `shorter than ${s.minLength}`);
      if (s.maxLength !== undefined && len > s.maxLength) push(issues, path, `longer than ${s.maxLength}`);
      return;
    }
    case "number":
    case "integer": {
      if (typeof v !== "number" || !Number.isFinite(v)) return push(issues, path, `expected ${s.type}, got ${typeOf(v)}`);
      if (s.type === "integer" && !Number.isInteger(v)) push(issues, path, "expected integer");
      if (s.minimum !== undefined && v < s.minimum) push(issues, path, `below minimum ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) push(issues, path, `above maximum ${s.maximum}`);
      return;
    }
    case "boolean": {
      if (typeof v !== "boolean") push(issues, path, `expected boolean, got ${typeOf(v)}`);
      return;
    }
  }
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function truncate(s: string): string {
  return s.length > 40 ? `${s.slice(0, 37)}…` : s;
}

/**
 * Parse raw model text into a value for the feature's output kind.
 * On-device models often wrap JSON in ``` fences or add a sentence; we accept a single fenced
 * block, but never "repair" content — anything else is a parse failure.
 */
export type ParseOutcome = { ok: true; value: unknown } | { ok: false; error: string };

export function parseOutput(kind: "json" | "enum" | "text", raw: string): ParseOutcome {
  if (kind === "text") return { ok: true, value: raw };
  const trimmed = stripFence(raw.trim());
  if (kind === "enum") {
    const unquoted = trimmed.replace(/^"(.*)"$/s, "$1").trim();
    return unquoted.length > 0 ? { ok: true, value: unquoted } : { ok: false, error: "empty enum output" };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message.slice(0, 120)}` };
  }
}

function stripFence(s: string): string {
  const m = /^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```$/.exec(s);
  return m ? (m[1] as string).trim() : s;
}
