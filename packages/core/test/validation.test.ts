import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parsePath, readPath } from "../src/path.js";
import { parseOutput, validateOutput } from "../src/schema.js";
import { countWords, evaluateAssert } from "../src/assertions.js";
import type { OutputSchema } from "../src/contracts.js";

const triage: OutputSchema = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["order_status", "damaged_item", "other"] },
    urgency: { type: "string", enum: ["low", "normal", "high"] },
    orderId: { type: "string", nullable: true },
    tags: { type: "array", items: { type: "string", maxLength: 10 }, minItems: 0, maxItems: 2 },
    score: { type: "integer", minimum: 0, maximum: 5 },
    ratio: { type: "number" },
    ok: { type: "boolean" },
  },
  required: ["intent", "urgency", "orderId"],
};

describe("path", () => {
  it("parses dots and indexes", () => {
    expect(parsePath("")).toEqual([]);
    expect(parsePath("a.b[0][2].c")).toEqual(["a", "b", 0, 2, "c"]);
    expect(() => parsePath("a..b")).toThrow(SyntaxError);
    expect(() => parsePath("a[x]")).toThrow(SyntaxError);
  });
  it("reads values and reports missing ones", () => {
    const v = { a: { b: [1, { c: "x" }] }, n: null };
    expect(readPath(v, "a.b[1].c")).toEqual({ found: true, value: "x" });
    expect(readPath(v, "n")).toEqual({ found: true, value: null });
    expect(readPath(v, "")).toEqual({ found: true, value: v });
    expect(readPath(v, "a.b[5]")).toEqual({ found: false });
    expect(readPath(v, "a.zz")).toEqual({ found: false });
    expect(readPath(v, "a.b.c")).toEqual({ found: false });
    expect(readPath([1], "x")).toEqual({ found: false });
    expect(readPath({ x: 1 }, "x[0]")).toEqual({ found: false });
    expect(readPath({}, "toString")).toEqual({ found: false });
  });
});

describe("validateOutput", () => {
  it("accepts a valid object", () => {
    expect(validateOutput(triage, { intent: "other", urgency: "low", orderId: null, tags: ["a"], score: 3, ratio: 0.5, ok: true })).toEqual([]);
  });
  it("reports every class of violation", () => {
    const issues = validateOutput(triage, {
      intent: "refund",
      orderId: 5,
      extra: 1,
      tags: ["abcdefghijkl", "b", "c"],
      score: 2.5,
      ratio: "x",
      ok: "yes",
    });
    const msgs = issues.map((i) => `${i.path}: ${i.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("urgency: missing required"),
        expect.stringContaining("intent: \"refund\" is not one of"),
        expect.stringContaining("orderId: expected string"),
        expect.stringContaining("extra: unexpected property"),
        expect.stringContaining("tags: expected ≤ 2 items"),
        expect.stringContaining("tags[0]: longer than 10"),
        expect.stringContaining("score: expected integer"),
        expect.stringContaining("ratio: expected number"),
        expect.stringContaining("ok: expected boolean"),
      ]),
    );
  });
  it("handles nulls, wrong roots, bounds and enum-only schemas", () => {
    expect(validateOutput(triage, null)[0]?.message).toBe("null is not allowed");
    expect(validateOutput(triage, [])[0]?.message).toBe("expected object, got array");
    expect(validateOutput({ type: "array", minItems: 1 }, [])[0]?.message).toContain("≥ 1");
    expect(validateOutput({ type: "array" }, "x")[0]?.message).toContain("expected array");
    expect(validateOutput({ type: "string", minLength: 2 }, "a")[0]?.message).toContain("shorter");
    expect(validateOutput({ type: "string" }, 1)[0]?.message).toContain("expected string");
    expect(validateOutput({ type: "number", minimum: 1 }, 0)[0]?.message).toContain("below");
    expect(validateOutput({ type: "number", maximum: 1 }, 2)[0]?.message).toContain("above");
    expect(validateOutput({ type: "number" }, Number.NaN)[0]?.message).toContain("expected number");
    expect(validateOutput({ type: "string", enum: ["a"] }, "b")).toHaveLength(1);
    expect(validateOutput({ type: "string", enum: ["a"] }, "a".repeat(50) )[0]?.message).toContain("…");
  });
  it("caps the number of issues", () => {
    const s: OutputSchema = { type: "array", items: { type: "string" } };
    expect(validateOutput(s, Array.from({ length: 100 }, () => 1))).toHaveLength(20);
  });
  it("property: values generated from the schema always validate", () => {
    const arb = fc.record({
      intent: fc.constantFrom("order_status", "damaged_item", "other"),
      urgency: fc.constantFrom("low", "normal", "high"),
      orderId: fc.option(fc.string({ maxLength: 12 }), { nil: null }),
    });
    fc.assert(fc.property(arb, (v) => validateOutput(triage, v).length === 0));
  });
});

describe("parseOutput", () => {
  it("parses JSON, fenced JSON and rejects prose", () => {
    expect(parseOutput("json", '{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseOutput("json", '```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseOutput("json", '```\n{"a":1}```')).toEqual({ ok: true, value: { a: 1 } });
    const bad = parseOutput("json", 'Sure! {"a":1}');
    expect(bad.ok).toBe(false);
  });
  it("parses enums and text", () => {
    expect(parseOutput("enum", ' "high" ')).toEqual({ ok: true, value: "high" });
    expect(parseOutput("enum", "  ")).toEqual({ ok: false, error: "empty enum output" });
    expect(parseOutput("text", " hi ")).toEqual({ ok: true, value: " hi " });
  });
});

describe("evaluateAssert", () => {
  const out = { intent: "damaged_item", orderId: " CT-1 ", n: 3, reply: "Hola, lo siento mucho por el pedido CT-9.", nil: null };
  it("equals / one_of / not_null", () => {
    expect(evaluateAssert({ kind: "equals", path: "intent", value: "damaged_item" }, out).pass).toBe(true);
    expect(evaluateAssert({ kind: "equals", path: "orderId", value: "CT-1" }, out).pass).toBe(true);
    expect(evaluateAssert({ kind: "equals", path: "n", value: 3 }, out).pass).toBe(true);
    const miss = evaluateAssert({ kind: "equals", path: "missing", value: "x" }, out, 4);
    expect(miss).toMatchObject({ id: "assert:4:equals", pass: false, detail: expect.stringContaining("(missing)") });
    expect(evaluateAssert({ kind: "one_of", path: "intent", values: ["a", "damaged_item"] }, out).pass).toBe(true);
    expect(evaluateAssert({ kind: "one_of", path: "intent", values: ["a"] }, out).pass).toBe(false);
    expect(evaluateAssert({ kind: "not_null", path: "nil" }, out).pass).toBe(false);
    expect(evaluateAssert({ kind: "not_null", path: "intent" }, out).pass).toBe(true);
  });
  it("regex with flags, negation and bad patterns", () => {
    expect(evaluateAssert({ kind: "regex", path: "reply", pattern: "^hola", flags: "i" }, out).pass).toBe(true);
    expect(evaluateAssert({ kind: "regex", path: "reply", pattern: "refund", negate: true }, out).pass).toBe(true);
    expect(evaluateAssert({ kind: "regex", path: "reply", pattern: "lo siento", negate: true }, out).pass).toBe(false);
    expect(evaluateAssert({ kind: "regex", path: "reply", pattern: "^x" }, out).detail).toContain("must match");
    expect(evaluateAssert({ kind: "regex", path: "reply", pattern: "(" }, out).detail).toContain("bad pattern");
    expect(evaluateAssert({ kind: "regex", path: "n", pattern: "3" }, out).pass).toBe(false);
  });
  it("length in chars and words", () => {
    expect(evaluateAssert({ kind: "length", path: "reply", min: 10, max: 100 }, out).pass).toBe(true);
    expect(evaluateAssert({ kind: "length", path: "reply", max: 5, unit: "words" }, out).pass).toBe(false);
    expect(evaluateAssert({ kind: "length", path: "reply", min: 1 }, out).pass).toBe(true);
    expect(evaluateAssert({ kind: "length", path: "n", min: 1 }, out).pass).toBe(false);
    expect(countWords("  ")).toBe(0);
    expect(countWords("a  b\nc")).toBe(3);
  });
  it("contains with case handling and negation", () => {
    expect(evaluateAssert({ kind: "contains", path: "reply", substring: "ct-9" }, out).pass).toBe(true);
    expect(evaluateAssert({ kind: "contains", path: "reply", substring: "ct-9", caseSensitive: true }, out).pass).toBe(false);
    expect(evaluateAssert({ kind: "contains", path: "reply", substring: "refund", negate: true }, out).pass).toBe(true);
    expect(evaluateAssert({ kind: "contains", path: "reply", substring: "Hola", negate: true }, out).detail).toContain("must not");
    expect(evaluateAssert({ kind: "contains", path: "n", substring: "3" }, out).pass).toBe(false);
  });
  it("never throws on malformed paths", () => {
    expect(evaluateAssert({ kind: "equals", path: "a..b", value: 1 }, out).pass).toBe(false);
  });
});
