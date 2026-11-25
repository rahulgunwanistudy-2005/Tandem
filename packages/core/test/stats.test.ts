import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  flakiness,
  newcombeDifference,
  percentile,
  wilsonInterval,
  wilsonLowerBound,
} from "../src/stats.js";

describe("wilsonInterval", () => {
  // Reference values: Newcombe (1998), Statistics in Medicine 17:857–872, Table I, method 3.
  it.each([
    [81, 263, 0.2553, 0.3662],
    [15, 148, 0.0624, 0.1605],
    [0, 20, 0.0, 0.1611],
    [1, 29, 0.0061, 0.1718],
  ])("%i/%i → [%f, %f]", (s, n, lo, hi) => {
    const { lower, upper } = wilsonInterval(s, n);
    expect(lower).toBeCloseTo(lo, 4);
    expect(upper).toBeCloseTo(hi, 4);
  });

  it("is exact at the edges", () => {
    expect(wilsonInterval(0, 50).lower).toBe(0);
    expect(wilsonInterval(50, 50).upper).toBe(1);
  });

  it("returns [0, 1] with no data", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
  });

  it("rejects invalid counts and z", () => {
    expect(() => wilsonInterval(-1, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(11, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 10)).toThrow(RangeError);
    expect(() => wilsonInterval(1, -2)).toThrow(RangeError);
    expect(() => wilsonInterval(1, 10, 0)).toThrow(RangeError);
    expect(() => wilsonInterval(1, 10, Number.NaN)).toThrow(RangeError);
  });

  it("30/30 is the smallest perfect run that clears τ = 0.85 at minN = 30", () => {
    expect(wilsonLowerBound(30, 30)).toBeGreaterThanOrEqual(0.85);
    expect(wilsonLowerBound(29, 29)).toBeLessThan(0.9);
    // and a perfect 20/20 does NOT clear τ — this is why minimum evidence exists
    expect(wilsonLowerBound(20, 20)).toBeLessThan(0.85);
  });

  const counts = fc
    .integer({ min: 1, max: 2000 })
    .chain((n) => fc.tuple(fc.integer({ min: 0, max: n }), fc.constant(n)));

  it("property: 0 ≤ lower ≤ p̂ ≤ upper ≤ 1", () => {
    fc.assert(
      fc.property(counts, ([s, n]) => {
        const { lower, upper } = wilsonInterval(s, n);
        const p = s / n;
        return lower >= 0 && lower <= p + 1e-12 && p <= upper + 1e-12 && upper <= 1;
      }),
    );
  });

  it("property: lower bound is monotone in successes", () => {
    fc.assert(
      fc.property(
        counts,
        ([s, n]) => s === n || wilsonLowerBound(s, n) <= wilsonLowerBound(s + 1, n) + 1e-12,
      ),
    );
  });

  it("property: more evidence at the same rate tightens the lower bound", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 2, max: 10 }),
        (a, b, k) => {
          const n = a + b;
          return wilsonLowerBound(a, n) <= wilsonLowerBound(a * k, n * k) + 1e-12;
        },
      ),
    );
  });

  it("property: symmetric — lower(s, n) = 1 − upper(n − s, n)", () => {
    fc.assert(
      fc.property(
        counts,
        ([s, n]) =>
          Math.abs(wilsonInterval(s, n).lower - (1 - wilsonInterval(n - s, n).upper)) < 1e-9,
      ),
    );
  });
});

describe("newcombeDifference", () => {
  // Newcombe (1998), Statistics in Medicine 17:873–890, Table II, method 10.
  it.each([
    [56, 70, 48, 80, 0.0524, 0.3339],
    [9, 10, 3, 10, 0.1705, 0.809],
  ])("%i/%i − %i/%i → [%f, %f]", (s1, n1, s2, n2, lo, hi) => {
    const d = newcombeDifference(s1, n1, s2, n2);
    expect(d.lower).toBeCloseTo(lo, 3);
    expect(d.upper).toBeCloseTo(hi, 3);
  });

  it("property: contains the observed difference and stays in [−1, 1]", () => {
    const arm = fc
      .integer({ min: 1, max: 400 })
      .chain((n) => fc.tuple(fc.integer({ min: 0, max: n }), fc.constant(n)));
    fc.assert(
      fc.property(arm, arm, ([s1, n1], [s2, n2]) => {
        const d = newcombeDifference(s1, n1, s2, n2);
        const obs = s1 / n1 - s2 / n2;
        return d.lower <= obs + 1e-12 && obs <= d.upper + 1e-12 && d.lower >= -1 && d.upper <= 1;
      }),
    );
  });

  it("property: antisymmetric when the arms are swapped", () => {
    const arm = fc
      .integer({ min: 1, max: 300 })
      .chain((n) => fc.tuple(fc.integer({ min: 0, max: n }), fc.constant(n)));
    fc.assert(
      fc.property(arm, arm, ([s1, n1], [s2, n2]) => {
        const a = newcombeDifference(s1, n1, s2, n2);
        const b = newcombeDifference(s2, n2, s1, n1);
        return Math.abs(a.lower + b.upper) < 1e-9 && Math.abs(a.upper + b.lower) < 1e-9;
      }),
    );
  });
});

describe("percentile", () => {
  it("uses nearest rank and returns an observed value", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile(v, 100)).toBe(10);
    expect(percentile(v, 10)).toBe(1);
    expect(percentile([42], 95)).toBe(42);
  });
  it("ignores non-finite values and handles empty input", () => {
    expect(percentile([], 95)).toBeUndefined();
    expect(percentile([Number.NaN, Infinity], 95)).toBeUndefined();
    expect(percentile([3, Number.NaN, 1, 2], 50)).toBe(2);
  });
  it("rejects q outside (0, 100]", () => {
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });
  it("property: result is a member and is monotone in q", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1e5, noNaN: true }), { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 1, max: 99 }),
        (v, q) => {
          const a = percentile(v, q) as number;
          const b = percentile(v, q + 1) as number;
          return v.includes(a) && a <= b;
        },
      ),
    );
  });
});

describe("flakiness", () => {
  it("counts cases whose samples disagree", () => {
    const m = new Map<string, boolean[]>([
      ["a", [true, true, true]],
      ["b", [true, false, true]],
      ["c", [false, false, false]],
      ["d", [true]],
    ]);
    expect(flakiness(m)).toBeCloseTo(0.25);
  });
  it("is 0 with no cases and skips empty sample lists", () => {
    expect(flakiness(new Map())).toBe(0);
    expect(flakiness(new Map([["a", []]]))).toBe(0);
  });
});
