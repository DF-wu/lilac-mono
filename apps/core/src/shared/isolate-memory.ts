import { BroadcastChannel } from "node:worker_threads";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

// Worker isolates share the Core process, so process-wide RSS cannot say which isolate holds memory.
// Each worker answers on this channel with its own heap counters; the main isolate collects them.
export const ISOLATE_MEMORY_CHANNEL = "lilac:isolate-memory";

const isolateHeapSchema = z.strictObject({
  heapUsed: z.number().nonnegative(),
  heapTotal: z.number().nonnegative(),
  external: z.number().nonnegative(),
  arrayBuffers: z.number().nonnegative(),
});

const isolateMemoryRequestSchema = z.strictObject({
  type: z.literal("isolate-memory.request"),
  id: z.string().min(1),
});

const isolateMemoryReportSchema = z.strictObject({
  type: z.literal("isolate-memory.report"),
  id: z.string().min(1),
  isolateId: z.string().min(1),
  role: z.string().min(1),
  heap: isolateHeapSchema,
});

const isolateMemoryMessageSchema = z.discriminatedUnion("type", [
  isolateMemoryRequestSchema,
  isolateMemoryReportSchema,
]);

export type IsolateHeap = z.infer<typeof isolateHeapSchema>;
export type IsolateMemoryRequest = z.infer<typeof isolateMemoryRequestSchema>;
export type IsolateMemoryReport = z.infer<typeof isolateMemoryReportSchema>;
export type IsolateMemoryMessage = z.infer<typeof isolateMemoryMessageSchema>;

export class IsolateMemoryMessageDecodeError extends TaggedError(
  "IsolateMemoryMessageDecodeError",
)<{ readonly message: string }> {}

export function decodeIsolateMemoryMessage(
  input: unknown,
): ResultType<IsolateMemoryMessage, IsolateMemoryMessageDecodeError> {
  const decoded = isolateMemoryMessageSchema.safeParse(input);
  return decoded.success
    ? Result.ok(decoded.data)
    : Result.err(new IsolateMemoryMessageDecodeError({ message: "Not an isolate memory message" }));
}

/**
 * Heap counters of the calling isolate. In a Worker these describe that Worker's own heap;
 * `rss` is omitted because it is process-wide. `heapUsed` is as of the isolate's last collection.
 */
export function readIsolateHeap(): IsolateHeap {
  const memory = process.memoryUsage();
  return {
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

export interface IsolateMemoryChannel {
  postMessage(message: IsolateMemoryMessage): void;
  /** Receives decoded messages; anything else on the channel is ignored. */
  onMessage(listener: (message: IsolateMemoryMessage) => void): void;
  close(): void;
}

export function openIsolateMemoryChannel(): IsolateMemoryChannel {
  const channel = new BroadcastChannel(ISOLATE_MEMORY_CHANNEL);
  // The channel must not keep a worker or Core alive on its own.
  channel.unref();
  return {
    postMessage: (message) => channel.postMessage(message),
    onMessage: (listener) => {
      channel.onmessage = (event: { readonly data: unknown }) =>
        decodeIsolateMemoryMessage(event.data).match({ ok: listener, err: () => undefined });
    },
    close: () => channel.close(),
  };
}

/** Installs the worker side: answer each request with this isolate's heap counters. */
export function installIsolateMemoryResponder(
  role: string,
  channel: IsolateMemoryChannel = openIsolateMemoryChannel(),
  isolateId: string = crypto.randomUUID(),
): void {
  channel.onMessage((message) => {
    if (message.type !== "isolate-memory.request") return;
    channel.postMessage({
      type: "isolate-memory.report",
      id: message.id,
      isolateId,
      role,
      heap: readIsolateHeap(),
    });
  });
}

export type WorkerIsolateMemory = IsolateHeap & {
  readonly role: string;
  readonly isolateId: string;
};

export type UnresponsiveWorkerIsolate = {
  readonly role: string;
  readonly isolateId: string;
  readonly missedRounds: number;
};

export type IsolateMemoryRound = {
  readonly workers: readonly WorkerIsolateMemory[];
  readonly unresponsive: readonly UnresponsiveWorkerIsolate[];
};

export interface IsolateMemoryCollector {
  /** Asks every worker isolate for its heap; resolves when all known workers answer or on timeout. */
  collect(): Promise<IsolateMemoryRound>;
  close(): void;
}

type PendingRound = {
  readonly reports: Map<string, IsolateMemoryReport>;
  readonly finish: () => void;
};

type KnownWorker = { role: string; missedRounds: number };

// A busy worker answers after its current synchronous task, so the round waits briefly for it.
const DEFAULT_TIMEOUT_MS = 1_000;
// A worker that misses this many consecutive rounds is assumed gone (terminated or replaced).
const DEFAULT_MAX_MISSED_ROUNDS = 3;

export function createIsolateMemoryCollector(
  options: {
    readonly channel?: IsolateMemoryChannel;
    readonly timeoutMs?: number;
    readonly maxMissedRounds?: number;
  } = {},
): IsolateMemoryCollector {
  const channel = options.channel ?? openIsolateMemoryChannel();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxMissedRounds = options.maxMissedRounds ?? DEFAULT_MAX_MISSED_ROUNDS;
  const known = new Map<string, KnownWorker>();
  const pending = new Map<string, PendingRound>();
  let closed = false;

  function allKnownAnswered(reports: ReadonlyMap<string, IsolateMemoryReport>): boolean {
    if (known.size === 0) return false;
    return [...known.keys()].every((isolateId) => reports.has(isolateId));
  }

  channel.onMessage((message) => {
    if (message.type !== "isolate-memory.report") return;
    const round = pending.get(message.id);
    if (!round) return;
    round.reports.set(message.isolateId, message);
    if (allKnownAnswered(round.reports)) round.finish();
  });

  function settleRound(reports: ReadonlyMap<string, IsolateMemoryReport>): IsolateMemoryRound {
    const unresponsive: UnresponsiveWorkerIsolate[] = [];
    for (const [isolateId, worker] of known) {
      if (reports.has(isolateId)) continue;
      worker.missedRounds += 1;
      if (worker.missedRounds >= maxMissedRounds) {
        known.delete(isolateId);
        continue;
      }
      unresponsive.push({ role: worker.role, isolateId, missedRounds: worker.missedRounds });
    }
    const workers = [...reports.values()].map((report) => {
      known.set(report.isolateId, { role: report.role, missedRounds: 0 });
      return { role: report.role, isolateId: report.isolateId, ...report.heap };
    });
    workers.sort((a, b) => a.role.localeCompare(b.role) || a.isolateId.localeCompare(b.isolateId));
    return { workers, unresponsive };
  }

  function collect(): Promise<IsolateMemoryRound> {
    if (closed) return Promise.resolve({ workers: [], unresponsive: [] });
    const id = crypto.randomUUID();
    const reports = new Map<string, IsolateMemoryReport>();
    const { promise, resolve } = Promise.withResolvers<IsolateMemoryRound>();
    const finish = () => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      resolve(settleRound(reports));
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    pending.set(id, { reports, finish });
    channel.postMessage({ type: "isolate-memory.request", id });
    return promise;
  }

  return {
    collect,
    close: () => {
      if (closed) return;
      closed = true;
      for (const round of pending.values()) round.finish();
      channel.close();
    },
  };
}
