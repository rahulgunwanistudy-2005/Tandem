/**
 * Statistics behind every routing decision.
 *
 * Why Wilson: with n ≈ 30–150 samples per (feature, variant, model) and pass rates near 1, the
 * normal-approximation (Wald) interval collapses to zero width at p̂ = 1 and overshoots [0, 1].
 * The Wilson score interval stays inside [0, 1], is well-behaved at the boundaries and is cheap.
 * See docs/adr/0002-wilson-lower-bound.md.
 */

/** z for a two-sided 95% interval (one-sided 97.5%). */
export const Z_95 = 1.959963984540054;

export interface Interval {
  lower: number;
  upper: number;
}

function assertCounts(successes: number, n: number): void {
  if (!Number.isInteger(n) || n < 0)
    throw new RangeError(`n must be a non-negative integer, got ${n}`);
  if (!Number.isInteger(successes) || successes < 0 || successes > n) {
    throw new RangeError(`successes must be an integer in [0, n], got ${successes} of ${n}`);
  }
}

/** Wilson score interval. Returns [0, 1] when n = 0 (no information). */
export function wilsonInterval(successes: number, n: number, z: number = Z_95): Interval {
  assertCounts(successes, n);
  if (!(z > 0) || !Number.isFinite(z))
    throw new RangeError(`z must be a positive finite number, got ${z}`);
  if (n === 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Clamp float noise; exact bounds at the edges.
  const lower = successes === 0 ? 0 : Math.max(0, centre - half);
  const upper = successes === n ? 1 : Math.min(1, centre + half);
  return { lower, upper };
}

/** Lower bound of the 95% Wilson score interval. */
export function wilsonLowerBound(successes: number, n: number, z: number = Z_95): number {
  return wilsonInterval(successes, n, z).lower;
}

/**
 * Newcombe's hybrid score interval for the difference of two independent proportions
 * (p1 − p2), built from the two Wilson intervals (Newcombe 1998, method 10).
 * Used by the repair regression gate as a non-inferiority test.
 */
export function newcombeDifference(
  s1: number,
  n1: number,
  s2: number,
  n2: number,
  z: number = Z_95,
): Interval {
  const a = wilsonInterval(s1, n1, z);
  const b = wilsonInterval(s2, n2, z);
  const p1 = n1 === 0 ? 0 : s1 / n1;
  const p2 = n2 === 0 ? 0 : s2 / n2;
  const d = p1 - p2;
  const lower = d - Math.sqrt((p1 - a.lower) ** 2 + (b.upper - p2) ** 2);
  const upper = d + Math.sqrt((a.upper - p1) ** 2 + (p2 - b.lower) ** 2);
  return { lower: Math.max(-1, lower), upper: Math.min(1, upper) };
}

/**
 * Nearest-rank percentile (q in (0, 100]). Returns undefined for an empty list.
 * Nearest-rank is used (not interpolation) so p95 is always a latency that was actually observed.
 */
export function percentile(values: readonly number[], q: number): number | undefined {
  if (!(q > 0 && q <= 100)) throw new RangeError(`q must be in (0, 100], got ${q}`);
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return undefined;
  const sorted = [...finite].sort((x, y) => x - y);
  const rank = Math.ceil((q / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * Flakiness = share of cases whose k samples disagree (some pass, some fail).
 * Cases with a single sample cannot disagree and still count in the denominator.
 */
export function flakiness(outcomesByCase: ReadonlyMap<string, readonly boolean[]>): number {
  let cases = 0;
  let disagreeing = 0;
  for (const outcomes of outcomesByCase.values()) {
    if (outcomes.length === 0) continue;
    cases += 1;
    const passes = outcomes.filter(Boolean).length;
    if (passes > 0 && passes < outcomes.length) disagreeing += 1;
  }
  return cases === 0 ? 0 : disagreeing / cases;
}
