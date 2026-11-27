import { describe, expect, it, mock } from "bun:test";

import { startMemorySampler } from "../../src/runtime/memory-sampler";
import type { IsolateMemoryRound } from "../../src/shared/isolate-memory";

const MiB = 1024 * 1024;

function memory(rssMiB: number, heapTotalMiB: number) {
  return {
    rss: rssMiB * MiB,
    heapUsed: 100 * MiB,
    heapTotal: heapTotalMiB * MiB,
    external: 10 * MiB,
    arrayBuffers: 1 * MiB,
  };
}

function createSampler(round: IsolateMemoryRound, readings: ReturnType<typeof memory>[]) {
  const info = mock((_message: string, _details: Record<string, unknown>) => undefined);
  const warn = mock((_message: string, _details: Record<string, unknown>) => undefined);
  let current = readings[0]!;
  const sampler = startMemorySampler({
    logger: { info, warn },
    collector: { collect: async () => round },
    activeLevel1WorkCount: () => 2,
    sampleIntervalMs: 60 * 60_000,
    peakIntervalMs: 60 * 60_000,
    readProcessMemory: () => current,
  });
  return {
    sampler,
    info,
    warn,
    setMemory: (index: number) => {
      current = readings[index]!;
    },
  };
}

describe("memory sampler", () => {
  it("logs process, main isolate, workers, and peaks since the previous sample", async () => {
    const round: IsolateMemoryRound = {
      workers: [
        {
          role: "thread-search",
          isolateId: "search-1",
          heapUsed: 40 * MiB,
          heapTotal: 90 * MiB,
          external: 0,
          arrayBuffers: 0,
        },
      ],
      unresponsive: [{ role: "thread-summarization", isolateId: "summary-1", missedRounds: 1 }],
    };
    const { sampler, info, setMemory } = createSampler(round, [
      memory(2_000, 300),
      memory(3_500, 1_300),
      memory(2_400, 1_200),
    ]);

    sampler.observePeak();
    setMemory(1);
    sampler.observePeak();
    setMemory(2);
    await sampler.sample();

    expect(info).toHaveBeenCalledTimes(1);
    const [message, details] = info.mock.calls[0]!;
    expect(message).toBe("runtime.memory.sample");
    expect(details).toEqual({
      rss: 2_400 * MiB,
      main: { heapUsed: 100 * MiB, heapTotal: 1_200 * MiB, external: 10 * MiB, arrayBuffers: MiB },
      peakSinceLastSample: { rss: 3_500 * MiB, mainHeapTotal: 1_300 * MiB },
      activeLevel1Work: 2,
      workers: round.workers,
      unresponsiveWorkers: round.unresponsive,
    });

    await sampler.sample();
    expect(info.mock.calls[1]![1]).toMatchObject({
      peakSinceLastSample: { rss: 2_400 * MiB, mainHeapTotal: 1_200 * MiB },
    });
    expect(info.mock.calls[1]![1]).toHaveProperty("unresponsiveWorkers");
    sampler.stop();
  });

  it("omits unresponsive workers when every worker answered", async () => {
    const { sampler, info } = createSampler({ workers: [], unresponsive: [] }, [
      memory(1_000, 200),
    ]);
    await sampler.sample();
    expect(info.mock.calls[0]![1]).not.toHaveProperty("unresponsiveWorkers");
    sampler.stop();
  });

  it("warns instead of throwing when collection fails, and shares one in-flight sample", async () => {
    const info = mock((_message: string, _details: Record<string, unknown>) => undefined);
    const warn = mock((_message: string, _details: Record<string, unknown>) => undefined);
    const collect = mock(async (): Promise<IsolateMemoryRound> => {
      throw new Error("channel closed");
    });
    const sampler = startMemorySampler({
      logger: { info, warn },
      collector: { collect },
      activeLevel1WorkCount: () => 0,
      sampleIntervalMs: 60 * 60_000,
      peakIntervalMs: 60 * 60_000,
      readProcessMemory: () => memory(1_000, 200),
    });

    await Promise.all([sampler.sample(), sampler.sample()]);

    expect(collect).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([
      ["runtime memory sample failed", { error: "channel closed" }],
    ]);
    sampler.stop();
  });
});
