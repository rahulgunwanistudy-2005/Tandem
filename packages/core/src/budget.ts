import type { ModelFamily } from "./models.js";

/**
 * Token-budget estimator. Hybrid inference has no reliable token counting, so Tandem estimates
 * conservatively from characters and calibrates the estimate from real device rejections.
 *
 * Heuristic: CJK / Hangul / Kana / Thai characters cost ~1 token each; other characters cost
 * 1/charsPerToken. charsPerToken is deliberately low (3.0 vs the usual ~4 for English) so the
 * estimate over-counts: being refused for a too-long prompt in production is worse than leaving
 * a little budget unused.
 */

export interface FamilyBudget {
  /** total context for input + output, in tokens */
  totalTokens: number;
  /** recommended max output on-device */
  maxOutputTokens: number;
  charsPerToken: number;
  source: string;
}

export const BUDGETS: Record<ModelFamily, FamilyBudget> = {
  "chrome-nano": {
    totalTokens: 9216,
    maxOutputTokens: 1024,
    charsPerToken: 3,
    source: "Chrome Prompt API session quota",
  },
  "android-nano": {
    totalTokens: 4000,
    maxOutputTokens: 256,
    charsPerToken: 3,
    source: "Firebase AI Logic Android docs",
  },
  "apple-fm": {
    totalTokens: 4096,
    maxOutputTokens: 1024,
    charsPerToken: 3,
    source: "Firebase AI Logic iOS docs (shared in+out)",
  },
  "gemini-cloud": {
    totalTokens: 1_000_000,
    maxOutputTokens: 8192,
    charsPerToken: 4,
    source: "Gemini cloud models",
  },
};

export const SAFETY = 0.85;

const DENSE = /[぀-ヿ㐀-䶿一-鿿가-힯฀-๿豈-﫿]/u;

export function estimateTokens(text: string, family: ModelFamily): number {
  const cpt = BUDGETS[family].charsPerToken;
  let dense = 0;
  let other = 0;
  for (const ch of text) {
    if (DENSE.test(ch)) dense += 1;
    else other += 1;
  }
  return dense + Math.ceil(other / cpt);
}

/**
 * Calibration from real runs: when a device rejects an input of N chars as too long, the true
 * input limit is < N chars. Keep the tightest (smallest) rejected length per family.
 */
export interface Calibration {
  /** smallest input length (chars) a device rejected with INPUT_TOO_LONG */
  rejectedAtChars?: number;
  /** largest input length (chars) a device accepted */
  acceptedAtChars?: number;
}

export function calibrate(
  prev: Calibration,
  observation: { inputChars: number; rejected: boolean },
): Calibration {
  if (observation.rejected) {
    const r = prev.rejectedAtChars;
    return {
      ...prev,
      rejectedAtChars:
        r === undefined ? observation.inputChars : Math.min(r, observation.inputChars),
    };
  }
  const a = prev.acceptedAtChars;
  return {
    ...prev,
    acceptedAtChars: a === undefined ? observation.inputChars : Math.max(a, observation.inputChars),
  };
}

export interface BudgetCheck {
  fits: boolean;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  limitTokens: number;
  /** share of the safe budget used, 0..∞ (≤ 1 fits) */
  usage: number;
  reason?: string;
}

/**
 * Does `promptText` plus the reserved output fit `budget × SAFETY` for the family?
 * If calibration shows the device rejected a shorter input, that is enforced too.
 */
export function checkBudget(
  promptText: string,
  family: ModelFamily,
  reservedOutputTokens: number,
  calibration: Calibration = {},
): BudgetCheck {
  const b = BUDGETS[family];
  const est = estimateTokens(promptText, family);
  const out = Math.min(reservedOutputTokens, b.maxOutputTokens);
  const limit = Math.floor(b.totalTokens * SAFETY);
  const usage = (est + out) / limit;
  const chars = [...promptText].length;
  if (
    calibration.rejectedAtChars !== undefined &&
    chars >= Math.floor(calibration.rejectedAtChars * SAFETY)
  ) {
    return {
      fits: false,
      estimatedInputTokens: est,
      reservedOutputTokens: out,
      limitTokens: limit,
      usage,
      reason: `a device rejected ${calibration.rejectedAtChars} chars`,
    };
  }
  const fits = usage <= 1;
  return {
    fits,
    estimatedInputTokens: est,
    reservedOutputTokens: out,
    limitTokens: limit,
    usage,
    ...(fits ? {} : { reason: `~${est + out} tokens > ${limit} (85% of ${b.totalTokens})` }),
  };
}
