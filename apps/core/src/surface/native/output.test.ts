import { describe, expect, test } from "bun:test";
import { Result } from "better-result";

import {
  createNativeOutputPublisher,
  NativeOutputPublishFailed,
  type NativeOutputEvent,
  type NativeOutputPublication,
  type NativeOutputSink,
} from "./output";

function fixture(mode: "paragraph" | "complete", sink?: NativeOutputSink) {
  const events: NativeOutputEvent[] = [];
  const publisher = createNativeOutputPublisher({
    threadId: "thread",
    turnId: "turn",
    generation: 1,
    requestId: "request",
    attemptId: "attempt-1",
    mode,
    now: () => 123,
    publish:
      sink ??
      (async (event) => {
        events.push(event);
        return Result.ok(undefined);
      }),
  });
  return { events, publisher };
}

function texts(events: readonly NativeOutputEvent[]) {
  return events.flatMap((event) => (event.payload.type === "text" ? [event.payload] : []));
}

describe("native semantic output", () => {
  test("paragraph delimiters and CRLF survive every provider split", async () => {
    const input = "first\r\n\r\n```ts\r\n\r\ncode\r\n```\r\ntail\r";
    const expected = ["first\n\n", "```ts\n\n", "code\n```\ntail\r"];
    for (let split = 0; split <= input.length; split += 1) {
      const { events, publisher } = fixture("paragraph");
      publisher.textStart({ partId: "part", stepId: "step" });
      publisher.textDelta("part", input.slice(0, split));
      publisher.textDelta("part", input.slice(split));
      publisher.textEnd("part");
      await publisher.captureBarrier();
      expect(texts(events).map((part) => part.text)).toEqual(expected);
      expect(texts(events).every((part) => part.phase === "unspecified")).toBe(true);
    }
  });

  test("ordinary deltas do not publish until a whole paragraph or part end", async () => {
    const { events, publisher } = fixture("paragraph");
    publisher.textStart({ partId: "part", stepId: "step", phase: "commentary" });
    publisher.textDelta("part", "one\n");
    await publisher.captureBarrier();
    expect(events).toHaveLength(0);
    publisher.textDelta("part", "\ntwo");
    await publisher.captureBarrier();
    expect(texts(events).map((part) => part.text)).toEqual(["one\n\n"]);
    publisher.textEnd("part");
    await publisher.captureBarrier();
    expect(texts(events).map((part) => part.text)).toEqual(["one\n\n", "two"]);
  });

  test("complete mode preserves phase and timeline position through independent activity", async () => {
    const { events, publisher } = fixture("complete");
    publisher.textStart({ partId: "comment", stepId: "step", phase: "commentary" });
    publisher.textDelta("comment", "Working\n\n");
    publisher.textEnd("comment");
    publisher.activity({
      activityId: "tool",
      stepId: "step",
      kind: "tool",
      state: "start",
      label: "Search",
    });
    await publisher.captureBarrier();
    expect(events.map((event) => event.payload.type)).toEqual(["activity"]);
    publisher.textStart({ partId: "final", stepId: "step", phase: "final_answer" });
    publisher.textDelta("final", "Answer");
    publisher.textEnd("final");
    publisher.stepEnd("tool-calls");
    await publisher.captureBarrier();
    expect(texts(events).map((part) => [part.text, part.position, part.phase])).toEqual([
      ["Working\n\n", 1, "commentary"],
      ["Answer", 3, "final_answer"],
    ]);
    expect(events.some((event) => event.payload.type === "terminal")).toBe(false);
  });

  test("abnormal termination flushes remainder once and fences subsequent text", async () => {
    for (const mode of ["paragraph", "complete"] as const) {
      const { events, publisher } = fixture(mode);
      publisher.textStart({ partId: "part", stepId: "step" });
      publisher.textDelta("part", "unfinished\r");
      await publisher.terminal("canceled");
      publisher.textDelta("part", "late");
      await publisher.terminal("canceled");
      expect(texts(events).map((part) => [part.text, part.incomplete])).toEqual([
        ["unfinished\r", true],
      ]);
      expect(events.filter((event) => event.payload.type === "terminal")).toHaveLength(1);
    }
  });

  test("length ends incomplete but normal model stop finishes complete", async () => {
    const { events, publisher } = fixture("complete");
    publisher.textStart({ partId: "part", stepId: "step-1" });
    publisher.textDelta("part", "cut");
    publisher.stepEnd("length");
    publisher.textStart({ partId: "part-2", stepId: "step-2" });
    publisher.textDelta("part-2", "done");
    publisher.stepEnd("stop");
    await publisher.captureBarrier();
    expect(texts(events).map((part) => part.incomplete)).toEqual([true, false]);
  });

  test("attempt reset discards unpublished text and identifies abandoned projection", async () => {
    const { events, publisher } = fixture("paragraph");
    publisher.textStart({ partId: "part", stepId: "step" });
    publisher.textDelta("part", "abandoned\n\npartial");
    publisher.reset("attempt-2");
    publisher.textStart({ partId: "part", stepId: "step" });
    publisher.textDelta("part", "replacement");
    await publisher.terminal("complete");
    expect(events[1]?.payload).toEqual({ type: "reset", previousAttemptId: "attempt-1" });
    expect(texts(events).map((part) => part.text)).toEqual(["abandoned\n\n", "replacement"]);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
    expect(events[0]?.attemptId).toBe("attempt-1");
    expect(events[1]?.attemptId).toBe("attempt-2");
  });

  test("activity and compaction states keep stable position without reasoning content", async () => {
    const { events, publisher } = fixture("paragraph");
    publisher.activity({
      activityId: "thinking",
      stepId: "step",
      kind: "thinking",
      state: "start",
    });
    publisher.compaction({
      compactionId: "compact",
      state: "start",
      beforeCount: 10,
      boundary: "turn-1",
    });
    publisher.activity({
      activityId: "thinking",
      stepId: "step",
      kind: "thinking",
      state: "complete",
    });
    publisher.compaction({
      compactionId: "compact",
      state: "complete",
      beforeCount: 10,
      afterCount: 4,
      boundary: "turn-1",
    });
    await publisher.captureBarrier();
    expect(
      events.map((event) => ("position" in event.payload ? event.payload.position : null)),
    ).toEqual([1, 2, 1, 2]);
    expect(JSON.stringify(events)).not.toContain('"delta"');
  });
});

describe("native durability barrier", () => {
  test("checkpoint cannot pass captured output, later output does not delay its barrier", async () => {
    const first = Promise.withResolvers<NativeOutputPublication>();
    const second = Promise.withResolvers<NativeOutputPublication>();
    const enteredFirst = Promise.withResolvers<void>();
    const enteredSecond = Promise.withResolvers<void>();
    let calls = 0;
    const { publisher } = fixture("paragraph", async () => {
      calls += 1;
      if (calls === 1) {
        enteredFirst.resolve();
        return first.promise;
      }
      enteredSecond.resolve();
      return second.promise;
    });
    publisher.textStart({ partId: "part", stepId: "step" });
    publisher.textDelta("part", "one\n\n");
    const checkpointBarrier = publisher.captureBarrier();
    publisher.textDelta("part", "two\n\n");
    await enteredFirst.promise;
    let checkpointWritten = false;
    const checkpoint = checkpointBarrier.then((result) =>
      result.map(() => {
        checkpointWritten = true;
      }),
    );
    expect(checkpointWritten).toBe(false);
    first.resolve(Result.ok(undefined));
    await checkpoint;
    await enteredSecond.promise;
    expect(checkpointWritten).toBe(true);
    second.resolve(Result.ok(undefined));
    await publisher.captureBarrier();
  });

  test("failed publication prevents WAL success and successful terminalization", async () => {
    const failure = new NativeOutputPublishFailed({ message: "transport unavailable" });
    const attempted: NativeOutputEvent[] = [];
    const { publisher } = fixture("paragraph", async (event) => {
      attempted.push(event);
      return Result.err(failure);
    });
    publisher.textStart({ partId: "part", stepId: "step" });
    publisher.textDelta("part", "one\n\n");
    const checkpoint = await publisher.captureBarrier();
    let writes = 0;
    checkpoint.map(() => {
      writes += 1;
    });
    const terminal = await publisher.terminal("complete");
    terminal.map(() => {
      writes += 1;
    });
    expect(writes).toBe(0);
    expect(terminal.isErr()).toBe(true);
    expect(attempted.map((event) => event.payload.type)).toEqual(["text"]);
  });
});

test("recovery publishes a suffix reset and resumes checkpoint ordinals and display ordering", async () => {
  const old = fixture("paragraph");
  old.publisher.textStart({ partId: "safe", stepId: "step-1" });
  old.publisher.textDelta("safe", "retained\n\n");
  old.publisher.textEnd("safe");
  const checkpoint = old.publisher.captureCheckpoint();
  old.publisher.textStart({ partId: "discard", stepId: "step-2" });
  old.publisher.textDelta("discard", "abandoned\n\n");
  await old.publisher.captureBarrier();
  const recoveredEvents: NativeOutputEvent[] = [];
  const recovered = createNativeOutputPublisher({
    threadId: "thread",
    turnId: "turn",
    generation: 1,
    requestId: "request",
    attemptId: "attempt-2",
    previousAttemptId: "attempt-1",
    recoveryFrontier: checkpoint.frontier,
    mode: "paragraph",
    publish: async (event) => {
      recoveredEvents.push(event);
      return Result.ok(undefined);
    },
  });
  recovered.textStart({ partId: "new", stepId: "step-3" });
  recovered.textDelta("new", "recovered\n\n");
  await recovered.captureBarrier();
  expect(recoveredEvents[0]?.payload).toEqual({
    type: "reset",
    previousAttemptId: "attempt-1",
    retainThroughOrdinal: checkpoint.frontier.ordinal,
  });
  expect(recoveredEvents[0]?.ordinal).toBe(checkpoint.frontier.ordinal + 1);
  expect(texts(recoveredEvents)[0]?.position).toBe(checkpoint.frontier.position + 1);
  expect(recovered.captureCheckpoint().frontier.ordinal).toBe(checkpoint.frontier.ordinal + 2);
});
