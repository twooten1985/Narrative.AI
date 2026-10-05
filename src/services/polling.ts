export interface PollOptions<T> {
  poll: () => Promise<T>;
  isDone: (value: T) => boolean;
  /** Starting wait before the next attempt, after the first check. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  onUpdate?: (value: T, attempt: number) => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until isDone, waiting longer after each attempt.
 * The first check runs immediately. Throws if timeoutMs elapses.
 */
export async function pollWithBackoff<T>(opts: PollOptions<T>): Promise<T> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 3 * 60 * 60 * 1000;
  let delay = opts.initialDelayMs ?? 2000;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  let attempt = 0;

  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    const value = await opts.poll();
    attempt += 1;
    opts.onUpdate?.(value, attempt);
    if (opts.isDone(value)) return value;
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    await sleep(Math.min(delay, remaining));
    delay = Math.min(maxDelay, Math.round(delay * 1.5));
  }
}
