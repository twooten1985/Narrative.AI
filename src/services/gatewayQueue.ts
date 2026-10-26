/**
 * One app-wide queue for summary-model calls. Mass Processing, report jobs and the
 * case timeline all go through it, so two people-sized bursts cannot add up to a
 * rate-limit error. A call keeps its slot while it waits out a 429, because the
 * account is already saturated.
 */
export interface QueueRunOptions {
  signal?: AbortSignal;
  /** Called when the call has to wait behind others, with how many are ahead of it. */
  onWait?: (ahead: number) => void;
}

interface Waiter {
  start: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class CallQueue {
  private active = 0;
  private waiting: Waiter[] = [];

  constructor(private getLimit: () => number) {}

  get running(): number { return this.active; }
  get queued(): number { return this.waiting.length; }

  private limit(): number {
    const value = Math.floor(Number(this.getLimit()));
    return Number.isFinite(value) && value >= 1 ? Math.min(value, 4) : 1;
  }

  private pump() {
    while (this.active < this.limit() && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      this.active += 1;
      next.start();
    }
  }

  async run<T>(fn: () => Promise<T>, opts: QueueRunOptions = {}): Promise<T> {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (this.active >= this.limit()) {
      opts.onWait?.(this.waiting.length + 1);
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { start: resolve, reject, signal: opts.signal };
        if (opts.signal) {
          waiter.onAbort = () => {
            const index = this.waiting.indexOf(waiter);
            if (index >= 0) this.waiting.splice(index, 1);
            reject(new DOMException("Aborted", "AbortError"));
          };
          opts.signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        this.waiting.push(waiter);
      });
    } else {
      this.active += 1;
    }
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.pump();
    }
  }
}
