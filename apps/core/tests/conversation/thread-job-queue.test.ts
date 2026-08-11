import { describe, expect, it } from "bun:test";

import { createSerialJobQueue } from "../../src/conversation/thread-job-queue";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("conversation thread serial job queue", () => {
  it("runs queued jobs one at a time in FIFO order", async () => {
    const starts = new Map([1, 2, 3].map((job) => [job, deferred()]));
    const releases = new Map([1, 2, 3].map((job) => [job, deferred()]));
    const idle = deferred();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const queue = createSerialJobQueue<number>({
      async run(job) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${job}`);
        starts.get(job)?.resolve();
        await releases.get(job)?.promise;
        events.push(`end:${job}`);
        active -= 1;
      },
      onIdle: idle.resolve,
    });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    await starts.get(1)?.promise;
    expect(events).toEqual(["start:1"]);
    expect(queue.running).toBe(true);

    releases.get(1)?.resolve();
    await starts.get(2)?.promise;
    expect(events).toEqual(["start:1", "end:1", "start:2"]);

    releases.get(2)?.resolve();
    await starts.get(3)?.promise;
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3"]);

    releases.get(3)?.resolve();
    await idle.promise;
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);
    expect(maxActive).toBe(1);
    expect(queue.running).toBe(false);
  });
});
