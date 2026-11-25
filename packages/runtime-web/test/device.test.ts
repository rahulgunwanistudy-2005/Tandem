import { describe, expect, it } from "vitest";
import { chromeAvailability, detectModelId, toJsonSchema } from "../src/device.js";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";

describe("detectModelId", () => {
  it.each<[string, Parameters<typeof detectModelId>[0], string]>([
    [
      "UA-CH brand",
      { userAgentData: { brands: [{ brand: "Google Chrome", version: "158" }] } },
      "chrome:158",
    ],
    ["UA string fallback", { userAgent: CHROME_MAC }, "chrome:158"],
    ["mobile Chrome", { userAgentData: { mobile: true, brands: [] } }, "cloud:web"],
    ["Edge", { userAgent: `${CHROME_MAC} Edg/158.0.0.0` }, "cloud:web"],
    [
      "Android WebView",
      { userAgent: CHROME_MAC.replace("Macintosh", "Linux; Android 16") },
      "cloud:web",
    ],
    [
      "Safari",
      { userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/26.1 Safari/605" },
      "cloud:web",
    ],
    ["no UA at all", {}, "cloud:web"],
    ["no navigator", undefined, "cloud:web"],
  ])("%s", (_, nav, id) => {
    expect(detectModelId(nav === undefined ? (null as never) : nav)).toBe(id);
  });
  it("reads the global navigator by default", () => {
    expect(detectModelId()).toMatch(/^(chrome:\d+|cloud:web)$/);
  });
});

describe("chromeAvailability", () => {
  it("maps the Prompt API's answer and defaults to unavailable", async () => {
    const g = (a: string) => ({ LanguageModel: { availability: async () => a } });
    expect(await chromeAvailability({}, g("available"))).toBe("available");
    expect(await chromeAvailability({}, g("downloadable"))).toBe("downloadable");
    expect(await chromeAvailability({}, g("downloading"))).toBe("downloading");
    expect(await chromeAvailability({}, g("no"))).toBe("unavailable");
    expect(await chromeAvailability({}, {})).toBe("unavailable");
    expect(await chromeAvailability({})).toBe("unavailable"); // Node has no LanguageModel
  });
});

describe("toJsonSchema", () => {
  it("closes objects and turns nullable into a type union", () => {
    expect(
      toJsonSchema({
        type: "object",
        description: "ticket",
        properties: {
          intent: { type: "string", enum: ["a", "b"] },
          orderId: { type: "string", nullable: true },
          tier: { type: "string", enum: ["x"], nullable: true },
          tags: {
            type: "array",
            items: { type: "string", maxLength: 10 },
            minItems: 0,
            maxItems: 2,
          },
          score: { type: "integer", minimum: 0, maximum: 5 },
        },
        required: ["intent"],
      }),
    ).toEqual({
      type: "object",
      description: "ticket",
      properties: {
        intent: { type: "string", enum: ["a", "b"] },
        orderId: { type: ["string", "null"] },
        tier: { type: ["string", "null"], enum: ["x", null] },
        tags: { type: "array", items: { type: "string", maxLength: 10 }, minItems: 0, maxItems: 2 },
        score: { type: "integer", minimum: 0, maximum: 5 },
      },
      additionalProperties: false,
      required: ["intent"],
    });
  });
});
