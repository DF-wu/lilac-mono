import { Result, TaggedError, type Result as ResultType } from "better-result";

export type FirecrawlPermitPolicy = {
  readonly maxConcurrency: number;
  readonly queueTtlMs: number;
};

export type FirecrawlPermit = {
  release(): void;
};

export class FirecrawlPermitQueueTimedOut extends TaggedError("FirecrawlPermitQueueTimedOut")<{
  readonly message: string;
}> {}

export class FirecrawlPermitQueueAborted extends TaggedError("FirecrawlPermitQueueAborted")<{
  readonly message: string;
}> {}

export type FirecrawlPermitFailure = FirecrawlPermitQueueTimedOut | FirecrawlPermitQueueAborted;
type FirecrawlPermitResult = ResultType<FirecrawlPermit, FirecrawlPermitFailure>;

type Waiter = {
  readonly signal?: AbortSignal;
  readonly queueTtlMs: number;
  readonly resolve: (result: FirecrawlPermitResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  settled: boolean;
};

export class FirecrawlPermitPool {
  private active = 0;
  private maxConcurrency = Number.POSITIVE_INFINITY;
  private queueTtlMs: number | null = null;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly lane: "fetch" | "search") {}

  configure(policy: FirecrawlPermitPolicy | undefined): void {
    this.maxConcurrency = policy?.maxConcurrency ?? Number.POSITIVE_INFINITY;
    this.queueTtlMs = policy?.queueTtlMs ?? null;
    this.drain();
  }

  acquire(signal?: AbortSignal): Promise<FirecrawlPermitResult> {
    if (signal?.aborted) {
      return Promise.resolve(Result.err(this.abortedError()));
    }

    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(Result.ok(this.createPermit()));
    }

    const queueTtlMs = this.queueTtlMs;
    if (queueTtlMs === null) {
      this.active += 1;
      return Promise.resolve(Result.ok(this.createPermit()));
    }

    return new Promise<FirecrawlPermitResult>((resolve) => {
      const waiter: Waiter = {
        signal,
        queueTtlMs,
        resolve,
        timer: null,
        onAbort: null,
        settled: false,
      };

      waiter.timer = setTimeout(() => {
        this.removeWaiter(waiter);
        this.settle(waiter, Result.err(this.timedOutError(waiter.queueTtlMs)));
      }, queueTtlMs);

      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waiter);
          this.settle(waiter, Result.err(this.abortedError()));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      this.waiters.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  private createPermit(): FirecrawlPermit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.active < this.maxConcurrency) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (waiter.settled) continue;
      if (waiter.signal?.aborted) {
        this.settle(waiter, Result.err(this.abortedError()));
        continue;
      }

      this.active += 1;
      this.settle(waiter, Result.ok(this.createPermit()));
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private settle(waiter: Waiter, result: FirecrawlPermitResult): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(result);
  }

  private timedOutError(queueTtlMs: number): FirecrawlPermitQueueTimedOut {
    return new FirecrawlPermitQueueTimedOut({
      message: `Firecrawl ${this.lane} queue timed out after ${queueTtlMs}ms.`,
    });
  }

  private abortedError(): FirecrawlPermitQueueAborted {
    return new FirecrawlPermitQueueAborted({
      message: `Firecrawl ${this.lane} request aborted while queued.`,
    });
  }
}
