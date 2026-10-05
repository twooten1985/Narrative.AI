export interface PollOptions<T> {
  poll: () => Promise<T>;
  isDone: (value: T) => boolean;
  /** Starting wait before the next attempt, after the first check. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  onUpdate?: (value: T, attempt: number) => void;
  /**
   * How many times to retry when the poll itself fails with a transient
   * localhost/network error (browser "Failed to fetch", Node "fetch failed").
   * Separate from AssemblyAI upload retries.
   */
  maxTransientRetries?: number;
  onTransientError?: (error: unknown, attempt: number, maxAttempts: number) => void;
  sleepImpl?: (ms: number) => Promise<void>;
}

const TRANSIENT_NET_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNABORTED",
  "ENETRESET",
]);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: any = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current.code) codes.push(String(current.code));
    current = current.cause;
  }
  return codes;
}

/** Browser and Node fetch failures talking to the local server, not HTTP error bodies. */
export function isTransientClientError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || "").trim().toLowerCase();
  if (
    message === "failed to fetch" ||
    message === "fetch failed" ||
    message === "load failed" ||
    message.includes("networkerror when attempting to fetch")
  ) {
    return true;
  }
  return errorCodes(error).some((code) => code.startsWith("UND_ERR_") || TRANSIENT_NET_CODES.has(code));
}

function lostContactError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "Failed to fetch";
  const code = errorCodes(error)[0];
  const wrapped = new Error(
    `Lost contact with the local Narrative AI server (${message}${code ? `, ${code}` : ""}). If an upload was running, use Retry. The recording is still on this computer.`
  );
  (wrapped as Error & { cause?: unknown }).cause = error;
  return wrapped;
}

/**
 * Poll until isDone, waiting longer after each attempt.
 * The first check runs immediately. Throws if timeoutMs elapses.
 * A few consecutive transient fetch failures are retried before giving up.
 */
export async function pollWithBackoff<T>(opts: PollOptions<T>): Promise<T> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 3 * 60 * 60 * 1000;
  let delay = opts.initialDelayMs ?? 2000;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const maxTransientRetries = opts.maxTransientRetries ?? 4;
  const wait = opts.sleepImpl ?? sleep;
  let attempt = 0;
  let transientStreak = 0;

  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    let value: T;
    try {
      value = await opts.poll();
    } catch (error) {
      if (isTransientClientError(error) && transientStreak < maxTransientRetries) {
        transientStreak += 1;
        opts.onTransientError?.(error, transientStreak, maxTransientRetries);
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) {
          throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
        }
        const transientDelay = Math.min(5_000, 400 * 2 ** (transientStreak - 1));
        await wait(Math.min(transientDelay, remaining));
        continue;
      }
      if (isTransientClientError(error)) throw lostContactError(error);
      throw error;
    }
    transientStreak = 0;
    attempt += 1;
    opts.onUpdate?.(value, attempt);
    if (opts.isDone(value)) return value;
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    await wait(Math.min(delay, remaining));
    delay = Math.min(maxDelay, Math.round(delay * 1.5));
  }
}
