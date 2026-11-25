import { describe, expect, it, vi } from "vitest";
import { parsePolicy, policyKey, PolicyStore } from "../src/policy.js";
import { fixturePolicy, policyWith } from "./helpers.js";

const raw = (v: unknown) => JSON.stringify(v);

describe("parsePolicy", () => {
  it("accepts the golden fixture and test policies", () => {
    expect(parsePolicy(raw(fixturePolicy()), "triage")).toMatchObject({ ok: true });
    expect(parsePolicy(raw(policyWith("PREFER_ON_DEVICE")), "triage").ok).toBe(true);
  });

  it.each<[string, (p: Record<string, unknown>) => unknown, string]>([
    ["non-JSON", () => "{", "not JSON"],
    ["arrays", () => [], "not an object"],
    ["other schema versions", (p) => ({ ...p, schemaVersion: 2 }), "unsupported schemaVersion"],
    ["another feature's policy", (p) => ({ ...p, featureId: "reply" }), 'expected "triage"'],
    ["version 0", (p) => ({ ...p, version: 0 }), "positive integer"],
    ["missing variants", (p) => ({ ...p, variants: undefined }), "variants missing"],
    ["malformed variants", (p) => ({ ...p, variants: { v1: { promptTemplate: 1 } } }), "malformed"],
    [
      "a bad default mode",
      (p) => ({ ...p, default: { mode: "SOMETIMES", variantId: "v1" } }),
      "mode",
    ],
    [
      "a default without variant",
      (p) => ({ ...p, default: { mode: "ONLY_IN_CLOUD" } }),
      "variantId",
    ],
    ["a non-object default", (p) => ({ ...p, default: 3 }), "not an object"],
    ["missing rules", (p) => ({ ...p, rules: null }), "rules missing"],
    ["bad rule keys", (p) => ({ ...p, rules: { safari: p.default } }), "not a model id"],
    [
      "rules pointing at missing variants",
      (p) => ({ ...p, rules: { "chrome:1": { mode: "ONLY_IN_CLOUD", variantId: "v9" } } }),
      'unknown variant "v9"',
    ],
  ])("rejects %s", (_, mutate, msg) => {
    const p = policyWith("PREFER_ON_DEVICE") as unknown as Record<string, unknown>;
    const v = mutate(p);
    const r = parsePolicy(typeof v === "string" ? v : raw(v), "triage");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(msg);
  });
});

describe("PolicyStore", () => {
  it("serves bundled defaults until a remote value arrives", () => {
    const s = new PolicyStore({ triage: fixturePolicy() });
    expect(s.get("triage")?.version).toBe(3);
    expect(s.features()).toEqual(["triage"]);
    expect(s.applyRaw("triage", "")).toBe(false);
    expect(s.applyRaw("triage", raw(policyWith("PREFER_ON_DEVICE")))).toBe(true);
    expect(s.get("triage")?.version).toBe(4);
    expect(policyKey("triage")).toBe("tandem_policy_triage");
  });

  it("keeps the last good policy on a bad or older publish, and notifies on real changes", () => {
    const s = new PolicyStore();
    const seen = vi.fn();
    const off = s.subscribe(seen);
    s.subscribe(() => {
      throw new Error("listener bug");
    });
    expect(s.applyRaw("triage", raw(policyWith("PREFER_ON_DEVICE")))).toBe(true);
    expect(seen).toHaveBeenLastCalledWith({
      featureId: "triage",
      policy: expect.objectContaining({ version: 4 }),
    });

    expect(s.applyRaw("triage", "{oops")).toBe(false);
    expect(s.rejections.get("triage")).toBe("not JSON");
    expect(s.get("triage")?.version).toBe(4);

    expect(s.applyRaw("triage", raw({ ...policyWith("ONLY_IN_CLOUD"), version: 2 }))).toBe(false);
    expect(s.applyRaw("triage", raw(policyWith("PREFER_ON_DEVICE")))).toBe(false); // identical
    expect(s.rejections.has("triage")).toBe(false);

    const rolledBack = { ...policyWith("ONLY_IN_CLOUD"), version: 5 };
    expect(s.applyRaw("triage", raw(rolledBack))).toBe(true);
    expect(seen).toHaveBeenLastCalledWith(
      expect.objectContaining({
        previous: expect.objectContaining({ version: 4 }),
        policy: expect.objectContaining({ version: 5 }),
      }),
    );
    off();
    s.applyRaw("triage", raw({ ...rolledBack, version: 6 }));
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
