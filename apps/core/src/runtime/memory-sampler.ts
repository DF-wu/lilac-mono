import type { Logger } from "@stanley2058/simple-module-logger";
import { Result } from "better-result";

import { captureError } from "../shared/error-capture";
import type { IsolateMemoryCollector } from "../shared/isolate-memory";

const DEFAULT_SAMPLE_INTERVAL_MS = 10 * 60_000;
const DEFAULT_PEAK_INTERVAL_MS = 30_000;

type ProcessMemory = {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
  readonly arrayBuffers: number;
};

export type MemorySamplerOptions = {
  readonly logger: Pick<Logger, "info" | "warn">;
  readonly collector: Pick<IsolateMemoryCollector, "collect">;
  readonly activeLevel1WorkCount: () => number;
  readonly sampleIntervalMs?: number;
  readonly peakIntervalMs?: number;
  readonly readProcessMemory?: () => ProcessMemory;
};

export type MemorySampler = {
  /** Logs one `runtime.memory.sample`. Exposed for tests; the interval timer calls it. */
  sample(): Promise<void>;
  /** Folds current process memory into the peaks the next sample reports. */
  observePeak(): void;
  stop(): void;
};

function readProcessMemory(): ProcessMemory {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

/**
 * Periodically logs process RSS, the main isolate's heap, every worker isolate's heap, and the
 * RSS and main `heapTotal` peaks since the previous sample. A `heapTotal` that stays far above
 * `heapUsed` long after work ends points at fragmentation rather than temporary GC headroom.
 */
export function startMemorySampler(options: MemorySamplerOptions): MemorySampler {
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const peakIntervalMs = options.peakIntervalMs ?? DEFAULT_PEAK_INTERVAL_MS;
  const read = options.readProcessMemory ?? readProcessMemory;
  let peakRss = 0;
  let peakMainHeapTotal = 0;
  let sampleInFlight: Promise<void> | null = null;

  function observePeak(memory: ProcessMemory = read()): void {
    peakRss = Math.max(peakRss, memory.rss);
    peakMainHeapTotal = Math.max(peakMainHeapTotal, memory.heapTotal);
  }

  function takePeaks(memory: ProcessMemory) {
    observePeak(memory);
    const peaks = { rss: peakRss, mainHeapTotal: peakMainHeapTotal };
    peakRss = 0;
    peakMainHeapTotal = 0;
    return peaks;
  }

  async function logSample(): Promise<void> {
    const memory = read();
    const round = await options.collector.collect();
    options.logger.info("runtime.memory.sample", {
      rss: memory.rss,
      main: {
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      peakSinceLastSample: takePeaks(memory),
      activeLevel1Work: options.activeLevel1WorkCount(),
      workers: round.workers,
      ...(round.unresponsive.length > 0 ? { unresponsiveWorkers: round.unresponsive } : {}),
    });
  }

  async function runSample(): Promise<void> {
    const attempt = await Result.tryPromise({ try: logSample, catch: captureError });
    if (attempt.isErr()) {
      options.logger.warn("runtime memory sample failed", { error: attempt.error.cause.message });
    }
    sampleInFlight = null;
  }

  function sample(): Promise<void> {
    sampleInFlight ??= runSample();
    return sampleInFlight;
  }

  const sampleTimer = setInterval(() => void sample(), sampleIntervalMs);
  sampleTimer.unref();
  const peakTimer = setInterval(() => observePeak(), peakIntervalMs);
  peakTimer.unref();

  return {
    sample,
    observePeak: () => observePeak(),
    stop: () => {
      clearInterval(sampleTimer);
      clearInterval(peakTimer);
    },
  };
}
