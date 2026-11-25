import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Policy } from "@tandem/core";
import { checkPairing, checkPublish, MAX_LEASE_ATTEMPTS, policyKey, policyParameter, reap, Rejection } from "../src/logic.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../contracts/fixtures/policy.triage.json", import.meta.url), "utf8"),
) as Policy;
const v = (version: number): Policy => ({ ...fixture, version });

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof Rejection ? e.code : "other";
  }
  return "ok";
};

describe("checkPublish", () => {
  const ctx = { uid: "u1", memberUids: ["u1"], latestVersion: 2 };
  const req = { pid: "p", featureId: "triage", policy: v(3), expectedVersion: 2 };

  it("accepts the next version from a member", () => {
    expect(checkPublish(req, ctx).version).toBe(3);
    expect(checkPublish({ ...req, policy: v(1), expectedVersion: 0 }, { ...ctx, latestVersion: 0 }).version).toBe(1);
  });

  it.each([
    ["anonymous callers", req, { ...ctx, uid: undefined }, "permission-denied"],
    ["missing projects", req, { ...ctx, memberUids: undefined }, "not-found"],
    ["non-members", req, { ...ctx, uid: "u2" }, "permission-denied"],
    ["bad feature ids", { ...req, featureId: "../x" }, ctx, "invalid-argument"],
    ["another feature's policy", { ...req, featureId: "reply" }, ctx, "invalid-argument"],
    ["malformed policies", { ...req, policy: { ...v(3), default: { mode: "SOMETIMES" } } }, ctx, "invalid-argument"],
    ["stale screens", { ...req, expectedVersion: 1 }, ctx, "aborted"],
    ["skipped versions", { ...req, policy: v(5) }, ctx, "invalid-argument"],
  ] as const)("rejects %s", (_, r, c, expected) => {
    expect(code(() => checkPublish(r as never, c))).toBe(expected);
  });
});

describe("checkPairing", () => {
  const pairing = { pid: "p1", createdBy: "owner", expiresAtMs: 10_000 };
  const req = { code: "ABC234", device: { platform: "android" as const, modelId: "android:nano-v4", label: "Pixel 10" } };

  it("returns the project and a device doc for the caller", () => {
    expect(checkPairing(req, "runner", pairing, 5_000)).toEqual({
      pid: "p1",
      device: { platform: "android", modelId: "android:nano-v4", label: "Pixel 10", osVersion: "unknown", availability: "unknown", runnerUid: "runner" },
    });
  });

  it.each([
    ["anonymous", req, undefined, pairing, "permission-denied"],
    ["bad codes", { ...req, code: "abc" }, "r", pairing, "invalid-argument"],
    ["unknown codes", req, "r", undefined, "not-found"],
    ["used codes", req, "r", { ...pairing, claimedBy: "x" }, "failed-precondition"],
    ["expired codes", req, "r", { ...pairing, expiresAtMs: 4_000 }, "failed-precondition"],
    ["bad platforms", { ...req, device: { ...req.device, platform: "windows" } }, "r", pairing, "invalid-argument"],
    ["mismatched model ids", { ...req, device: { ...req.device, modelId: "ios:26.1" } }, "r", pairing, "invalid-argument"],
    ["wildcards", { ...req, device: { ...req.device, modelId: "android:*" } }, "r", pairing, "invalid-argument"],
  ] as const)("rejects %s", (_, r, uid, p, expected) => {
    expect(code(() => checkPairing(r as never, uid, p as never, 5_000))).toBe(expected);
  });
});

describe("reap and parameters", () => {
  it("requeues until the attempt cap, then fails the job", () => {
    expect(reap({ attempt: 1 })).toEqual({ state: "queued" });
    expect(reap({ attempt: MAX_LEASE_ATTEMPTS })).toEqual({ state: "failed", verdict: "error" });
  });

  it("publishes the policy as a JSON parameter under tandem_policy_<feature>", () => {
    const p = policyParameter(v(3));
    expect(policyKey("triage")).toBe("tandem_policy_triage");
    expect(p.valueType).toBe("JSON");
    expect(JSON.parse(p.defaultValue.value)).toEqual(v(3));
    expect(p.description).toContain("v3");
  });
});
