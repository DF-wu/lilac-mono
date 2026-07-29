import { describe, expect, it } from "bun:test";

import { BufferedFileSink } from "../src";

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
};

function deferred(): Deferred {
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createControlledSink(controls: readonly Deferred[]): {
  sink: BufferedFileSink;
  writes: string[];
  started: readonly Deferred[];
  state: { closeCalls: number };
} {
  const started = controls.map(() => deferred());
  const writes: string[] = [];
  const state = { closeCalls: 0 };
  let writeIndex = 0;
  const handle = {
    async write(buffer: Buffer, offset: number, length: number) {
      const index = writeIndex;
      writeIndex += 1;
      writes.push(buffer.subarray(offset, offset + length).toString("utf8"));
      started[index]?.resolve();
      await controls[index]?.promise;
      return { bytesWritten: length, buffer };
    },
    async close() {
      state.closeCalls += 1;
    },
  };
  const sink = Reflect.construct(BufferedFileSink, [handle, 3]) as BufferedFileSink;
  return { sink, writes, started, state };
}

describe("BufferedFileSink", () => {
  it("serializes overlapping writes in call order and closes after all accepted writes", async () => {
    const first = deferred();
    const second = deferred();
    const { sink, writes, started, state } = createControlledSink([first, second]);

    const firstWrite = sink.write("one");
    const secondWrite = sink.write("two");
    const close = sink.close();
    await started[0]?.promise;

    expect(writes).toEqual(["one"]);
    expect(state.closeCalls).toBe(0);
    await expect(sink.write("late")).rejects.toThrow("closed buffered file sink");

    first.resolve();
    await started[1]?.promise;
    expect(writes).toEqual(["one", "two"]);
    expect(state.closeCalls).toBe(0);

    second.resolve();
    await Promise.all([firstWrite, secondWrite, close]);
    expect(state.closeCalls).toBe(1);
  });

  it("preserves a write rejection while later writes and close still complete", async () => {
    const first = deferred();
    const second = deferred();
    const { sink, writes, started, state } = createControlledSink([first, second]);

    const firstWrite = sink.write("one");
    const firstOutcome = firstWrite.then(
      () => undefined,
      (error: unknown) => error,
    );
    const secondWrite = sink.write("two");
    const close = sink.close();
    await started[0]?.promise;

    first.reject(new Error("controlled write failure"));
    await started[1]?.promise;
    const firstError = await firstOutcome;
    expect(firstError).toBeInstanceOf(Error);
    expect(firstError).toHaveProperty("message", "controlled write failure");
    expect(writes).toEqual(["one", "two"]);
    expect(state.closeCalls).toBe(0);

    second.resolve();
    await Promise.all([secondWrite, close]);
    expect(state.closeCalls).toBe(1);
  });

  it("waits for an in-flight write before abort closes the handle", async () => {
    const writeControl = deferred();
    const { sink, started, state } = createControlledSink([writeControl]);

    const write = sink.write("one");
    const abort = sink.abort();
    await started[0]?.promise;
    expect(state.closeCalls).toBe(0);

    writeControl.resolve();
    await Promise.all([write, abort]);
    expect(state.closeCalls).toBe(1);
    await expect(sink.write("late")).rejects.toThrow("closed buffered file sink");
  });
});
