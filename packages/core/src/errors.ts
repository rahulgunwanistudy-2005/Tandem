import { ERROR_CODES, type ErrorCode } from "./contracts.js";

/** Typed error carried through every Tandem layer; the same codes exist in Kotlin and Swift. */
export class TandemError extends Error {
  override readonly name = "TandemError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean = RETRYABLE.has(code),
  ) {
    super(message);
  }
}

const RETRYABLE = new Set<ErrorCode>(["BUSY", "MODEL_DOWNLOADING", "OFFLINE"]);

export function isErrorCode(s: unknown): s is ErrorCode {
  return typeof s === "string" && (ERROR_CODES as readonly string[]).includes(s);
}

/**
 * Classify an error thrown by the web SDK / Chrome Prompt API into the taxonomy.
 * Matching is on stable names first (DOMException names from the Prompt API), then on message
 * fragments. Anything unrecognised is UNKNOWN — never guessed into a "nicer" bucket.
 */
export function classifyWebError(e: unknown): ErrorCode {
  if (e instanceof TandemError) return e.code;
  const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
  const msg = (e instanceof Error ? e.message : typeof e === "string" ? e : "").toLowerCase();

  if (name === "QuotaExceededError" || /input.*too (long|large)|exceeds.*(token|quota)|too many tokens/.test(msg)) return "INPUT_TOO_LONG";
  if (name === "NotSupportedError" && /language|output/.test(msg)) return "MODEL_UNAVAILABLE";
  if (/download/.test(msg) && /(progress|in progress|downloading|not (yet )?ready)/.test(msg)) return "MODEL_DOWNLOADING";
  if (/on-device model is not available|unavailable|not supported|no on-device/.test(msg) || name === "NotSupportedError") return "MODEL_UNAVAILABLE";
  if (/safety|blocked|guardrail|harmful|refus/.test(msg)) return "GUARDRAIL";
  if (/rate|429|resource[_ ]exhausted|quota/.test(msg)) return "QUOTA";
  if (/busy|too many requests/.test(msg)) return "BUSY";
  if (/network|offline|failed to fetch|fetch failed/.test(msg) || name === "NetworkError") return "OFFLINE";
  return "UNKNOWN";
}

/**
 * Bounded exponential backoff with full jitter (AWS architecture blog), used for BUSY.
 * attempt is 0-based. rand is injectable for tests.
 */
export function backoffMs(attempt: number, baseMs = 250, capMs = 4000, rand: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(rand() * ceiling);
}
