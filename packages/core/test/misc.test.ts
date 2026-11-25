import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalJson, judgeCacheKey, sha256Hex, variantHash } from "../src/canonical.js";
import { backoffMs, classifyWebError, isErrorCode, TandemError } from "../src/errors.js";
import {
  familyOf,
  isDeviceTarget,
  isModelId,
  parseModelId,
  renderPrompt,
  wildcardFor,
} from "../src/models.js";
import { fnv1a, stratifiedSplit } from "../src/split.js";

describe("canonical + hashing", () => {
  it("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
  it("hashes like sha256sum", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await variantHash("s", "t")).toBe(await sha256Hex("s\u0000t"));
  });
  it("judge cache key ignores key order and whitespace of parsed output", async () => {
    const a = await judgeCacheKey("f", "v", "c", JSON.parse('{ "x": 1, "y": 2 }'));
    const b = await judgeCacheKey("f", "v", "c", JSON.parse('{"y":2,"x":1}'));
    expect(a).toBe(b);
    expect(a).not.toBe(await judgeCacheKey("f", "v2", "c", { x: 1, y: 2 }));
  });
  it("property: canonicalJson is idempotent through parse", () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        (v) => canonicalJson(JSON.parse(canonicalJson(v))) === canonicalJson(v),
      ),
    );
  });
});

describe("errors", () => {
  it.each([
    [Object.assign(new Error("x"), { name: "QuotaExceededError" }), "INPUT_TOO_LONG"],
    [new Error("The input is too long for the model"), "INPUT_TOO_LONG"],
    [
      Object.assign(new Error("unsupported output language"), { name: "NotSupportedError" }),
      "MODEL_UNAVAILABLE",
    ],
    [new Error("Model download in progress"), "MODEL_DOWNLOADING"],
    [new Error("On-device model is not available"), "MODEL_UNAVAILABLE"],
    [new Error("Response was blocked due to SAFETY"), "GUARDRAIL"],
    [new Error("429 RESOURCE_EXHAUSTED"), "QUOTA"],
    [new Error("service busy"), "BUSY"],
    [new Error("Failed to fetch"), "OFFLINE"],
    [Object.assign(new Error("?"), { name: "NetworkError" }), "OFFLINE"],
    ["something odd", "UNKNOWN"],
    [42, "UNKNOWN"],
    [new TandemError("SCHEMA_INVALID", "bad"), "SCHEMA_INVALID"],
  ])("classifies %s", (e, code) => {
    expect(classifyWebError(e)).toBe(code);
  });
  it("marks retryable codes and validates codes", () => {
    expect(new TandemError("BUSY", "x").retryable).toBe(true);
    expect(new TandemError("GUARDRAIL", "x").retryable).toBe(false);
    expect(new TandemError("GUARDRAIL", "x").name).toBe("TandemError");
    expect(isErrorCode("QUOTA")).toBe(true);
    expect(isErrorCode("NOPE")).toBe(false);
    expect(isErrorCode(3)).toBe(false);
  });
  it("backs off exponentially with full jitter up to a cap", () => {
    expect(backoffMs(0, 250, 4000, () => 0.999)).toBe(249);
    expect(backoffMs(3, 250, 4000, () => 0.5)).toBe(1000);
    expect(backoffMs(10, 250, 4000, () => 0.999)).toBe(3996);
    expect(backoffMs(-1, 250, 4000, () => 0)).toBe(0);
    expect(backoffMs(2)).toBeLessThan(1000);
  });
});

describe("models", () => {
  it("parses and classifies model ids", () => {
    expect(isModelId("android:nano-v4")).toBe(true);
    expect(isModelId("android:*")).toBe(true);
    expect(isModelId("windows:x")).toBe(false);
    expect(parseModelId("cloud:gemini-3.5-flash-lite")).toEqual({
      platform: "cloud",
      model: "gemini-3.5-flash-lite",
    });
    expect(() => parseModelId("nope")).toThrow(SyntaxError);
    expect(isDeviceTarget("ios:26.1")).toBe(true);
    expect(isDeviceTarget("cloud:x")).toBe(false);
    expect(wildcardFor("chrome:158")).toBe("chrome:*");
    expect(["chrome:1", "android:1", "ios:1", "cloud:1"].map((m) => familyOf(m as never))).toEqual([
      "chrome-nano",
      "android-nano",
      "apple-fm",
      "gemini-cloud",
    ]);
  });
  it("renders every {{input}} placeholder", () => {
    expect(renderPrompt("A {{input}} B {{input}}", "x")).toBe("A x B x");
  });
});

describe("stratifiedSplit", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({
    id: `c${String(i).padStart(3, "0")}`,
    tag: i % 3 === 0 ? "es" : "en",
  }));
  it("holds out ~30% in every stratum, deterministically", () => {
    const s = stratifiedSplit(items, (i) => i.tag);
    for (const tag of ["es", "en"]) {
      const group = items.filter((i) => i.tag === tag);
      const held = group.filter((i) => s.get(i.id) === "holdout").length;
      expect(held).toBe(Math.round(group.length * 0.3));
    }
    expect(stratifiedSplit(items, (i) => i.tag)).toEqual(s);
    expect(stratifiedSplit(items, (i) => i.tag, 0.3, "other-seed")).not.toEqual(s);
  });
  it("validates the share and hashes stably", () => {
    expect(() => stratifiedSplit(items, () => "x", 1.5)).toThrow(RangeError);
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
  });
});
