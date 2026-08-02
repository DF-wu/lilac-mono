import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Panic } from "better-result";

import {
  normalizeConversationThreadWorkerPanic,
  startConversationThreadSummarizationWorker,
  type ConversationThreadWorkerFatalReporter,
  type ConversationThreadSummarizationWorkerTransport,
} from "../../src/conversation/thread-worker";
import type {
  ThreadSummarizationResult,
  ThreadSummarizationWorkerRequest,
} from "../../src/conversation/thread-summarization-worker-protocol";

class FakeWorker implements ConversationThreadSummarizationWorkerTransport {
  readonly requests: ThreadSummarizationWorkerRequest[] = [];
  terminated = false;
  postFailure: unknown;
  private messageListener: (event: MessageEvent<unknown>) => void = () => {};
  private errorListener: (panic: Panic) => void = () => {};

  postMessage(request: ThreadSummarizationWorkerRequest): void {
    this.requests.push(request);
    if (this.postFailure !== undefined) throw this.postFailure;
  }

  terminate(): void {
    this.terminated = true;
  }

  onMessage(listener: (event: MessageEvent<unknown>) => void): void {
    this.messageListener = listener;
  }

  onError(listener: (panic: Panic) => void): void {
    this.errorListener = listener;
  }

  emitMessage(data: unknown): void {
    this.messageListener(new MessageEvent("message", { data }));
  }

  emitError(panic: Panic): void {
    this.errorListener(panic);
  }

  lastRequest(): ThreadSummarizationWorkerRequest {
    const request = this.requests.at(-1);
    if (!request) throw new Error("Expected the fake worker to receive a request");
    return request;
  }
}

function resultFixture(): ThreadSummarizationResult {
  return {
    dryRun: false,
    refreshed: { channels: 1, threads: 2, messages: 3 },
    eligible: 1,
    eligibleTotal: 1,
    eligibility: { summary: 1, embeddingOnly: 0, reasons: { "never-summarized": 1 } },
    cleared: 0,
    summarized: 1,
    failed: 0,
    failures: [],
    threadIds: ["thread-1"],
  };
}

function startClient(
  worker: FakeWorker,
  reportFatalPanic: ConversationThreadWorkerFatalReporter = () => {},
) {
  return startConversationThreadSummarizationWorker({
    searchDbPath: "/data/search.sqlite",
    surfaceDbPath: "/data/surface.sqlite",
    createWorker: () => worker,
    reportFatalPanic,
  });
}

afterEach(() => {
  spyOn(console, "error").mockRestore();
  spyOn(console, "warn").mockRestore();
});

describe("conversation thread summarization worker client", () => {
  it("returns queued and completed successes without changing the wire request", async () => {
    const worker = new FakeWorker();
    const client = startClient(worker);

    const queued = await client.runSummarization({ limit: 4 });
    expect(queued.status).toBe("ok");
    const queuedRequest = worker.lastRequest();
    expect(queuedRequest).toEqual({
      id: queuedRequest.id,
      input: { limit: 4 },
      searchDbPath: "/data/search.sqlite",
      surfaceDbPath: "/data/surface.sqlite",
    });
    if (queued.status === "ok") {
      expect(queued.value).toMatchObject({ jobId: queuedRequest.id, status: "queued" });
    }

    const completedOperation = client.runSummarization({ wait: true, threadId: "thread-1" });
    const completedRequest = worker.lastRequest();
    worker.emitMessage({ id: completedRequest.id, ok: true, result: resultFixture() });
    const completed = await completedOperation;

    expect(completed.status).toBe("ok");
    if (completed.status === "ok") {
      expect(completed.value).toEqual({
        ...resultFixture(),
        jobId: completedRequest.id,
        status: "completed",
      });
    }
    await client.stop();
  });

  it("returns an owned remote failure", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const worker = new FakeWorker();
    const client = startClient(worker);
    const operation = client.runSummarization({ wait: true });
    const request = worker.lastRequest();

    worker.emitMessage({ id: request.id, ok: false, error: "provider unavailable" });
    const result = await operation;

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("ConversationThreadSummarizationRemoteError");
      if (result.error._tag === "ConversationThreadSummarizationRemoteError") {
        expect(result.error.jobId).toBe(request.id);
        expect(result.error.remoteMessage).toBe("provider unavailable");
      }
    }
    await client.stop();
  });

  it("settles all pending jobs when any response is malformed", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    const worker = new FakeWorker();
    const client = startClient(worker);
    const first = client.runSummarization({ wait: true, threadId: "thread-1" });
    const second = client.runSummarization({ wait: true, threadId: "thread-2" });

    worker.emitMessage({ id: worker.lastRequest().id, ok: true, result: { eligible: "one" } });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe("error");
    expect(secondResult.status).toBe("error");
    if (firstResult.status === "error" && secondResult.status === "error") {
      expect(firstResult.error._tag).toBe("ThreadSummarizationWorkerResponseDecodeError");
      expect(secondResult.error._tag).toBe("ThreadSummarizationWorkerResponseDecodeError");
    }
    const requestCount = worker.requests.length;
    const futureResult = await client.runSummarization({ wait: true });
    expect(worker.terminated).toBe(true);
    expect(worker.requests).toHaveLength(requestCount);
    expect(futureResult.status).toBe("error");
    if (firstResult.status === "error" && futureResult.status === "error") {
      expect(futureResult.error._tag).toBe("ThreadSummarizationWorkerResponseDecodeError");
      expect(futureResult.error).toBe(firstResult.error);
    }
    await client.stop();
  });

  it("ignores valid responses with unknown IDs", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    const worker = new FakeWorker();
    const client = startClient(worker);
    const operation = client.runSummarization({ wait: true });
    const request = worker.lastRequest();

    worker.emitMessage({ id: "unknown-job", ok: true, result: resultFixture() });
    worker.emitMessage({ id: request.id, ok: true, result: resultFixture() });
    const result = await operation;

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value.jobId).toBe(request.id);
    await client.stop();
  });

  it("rejects pending and future operations with Panic after a worker defect", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const worker = new FakeWorker();
    const client = startClient(worker);
    const first = client.runSummarization({ wait: true });
    const second = client.runSummarization({ wait: true });

    worker.emitError(new Panic({ message: "worker crashed" }));
    const [firstPanic, secondPanic] = await Promise.all([
      first.then(
        () => null,
        (error: unknown) => error,
      ),
      second.then(
        () => null,
        (error: unknown) => error,
      ),
    ]);

    expect(Panic.is(firstPanic)).toBe(true);
    expect(firstPanic).toBe(secondPanic);
    await expect(client.runSummarization({ wait: true })).rejects.toBe(firstPanic);
    expect(worker.terminated).toBe(true);
    expect(worker.requests).toHaveLength(2);
    await client.stop();
  });

  it("reports a worker Panic immediately when no jobs are waiting", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const worker = new FakeWorker();
    const panic = new Panic({ message: "idle worker invariant failed" });
    const reported: Panic[] = [];
    const client = startClient(worker, (fatalPanic) => reported.push(fatalPanic));

    worker.emitError(panic);

    expect(reported).toEqual([panic]);
    expect(worker.terminated).toBe(true);
    await client.stop();
  });

  it("normalizes and reports a revoked worker error without masking it", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const worker = new FakeWorker();
    const reported: Panic[] = [];
    const client = startClient(worker, (fatalPanic) => reported.push(fatalPanic));
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const normalized = normalizeConversationThreadWorkerPanic(proxy);
    worker.emitError(normalized);

    expect(normalized.message).toBe(
      "Conversation thread summarization worker failed with an opaque error",
    );
    expect(reported).toEqual([normalized]);
    expect(worker.terminated).toBe(true);
    await client.stop();
  });

  it("reports a worker Panic immediately for a wait:false job", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const worker = new FakeWorker();
    const panic = new Panic({ message: "queued worker invariant failed" });
    const reported: Panic[] = [];
    const client = startClient(worker, (fatalPanic) => reported.push(fatalPanic));
    const queued = await client.runSummarization({ wait: false });

    expect(queued.status).toBe("ok");
    worker.emitError(panic);

    expect(reported).toEqual([panic]);
    expect(worker.terminated).toBe(true);
    await client.stop();
  });

  it("returns postMessage failures and remains usable after bookkeeping is removed", async () => {
    const worker = new FakeWorker();
    const client = startClient(worker);
    const postFailure = new Error("structured clone failed");
    worker.postFailure = postFailure;

    const failed = await client.runSummarization({ wait: true });

    expect(failed.status).toBe("error");
    if (
      failed.status === "error" &&
      failed.error._tag === "ConversationThreadSummarizationTransportError"
    ) {
      expect(failed.error.operation).toBe("post-message");
      expect(failed.error.cause).toBe(postFailure);
    }

    const failedRequest = worker.lastRequest();
    worker.postFailure = undefined;
    worker.emitMessage({ id: failedRequest.id, ok: true, result: resultFixture() });
    const recoveredOperation = client.runSummarization({ wait: true });
    const recoveredRequest = worker.lastRequest();
    worker.emitMessage({ id: recoveredRequest.id, ok: true, result: resultFixture() });
    expect((await recoveredOperation).status).toBe("ok");
    await client.stop();
  });

  it("settles pending operations on stop and returns stopped Results for later runs", async () => {
    const worker = new FakeWorker();
    const client = startClient(worker);
    const pending = client.runSummarization({ wait: true });

    await client.stop();
    const pendingResult = await pending;
    const stoppedResult = await client.runSummarization();

    expect(worker.terminated).toBe(true);
    for (const result of [pendingResult, stoppedResult]) {
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error._tag).toBe("ConversationThreadSummarizationTransportError");
      }
      if (
        result.status === "error" &&
        result.error._tag === "ConversationThreadSummarizationTransportError"
      ) {
        expect(result.error.operation).toBe("stopped");
      }
    }
  });

  it("preserves Panic thrown by postMessage and removes its bookkeeping", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    const worker = new FakeWorker();
    const client = startClient(worker);
    const panic = new Panic({ message: "worker transport invariant failed" });
    worker.postFailure = panic;

    await expect(client.runSummarization({ wait: true })).rejects.toBe(panic);

    const failedRequest = worker.lastRequest();
    worker.postFailure = undefined;
    worker.emitMessage({ id: failedRequest.id, ok: true, result: resultFixture() });
    const recoveredOperation = client.runSummarization({ wait: true });
    const recoveredRequest = worker.lastRequest();
    worker.emitMessage({ id: recoveredRequest.id, ok: true, result: resultFixture() });
    expect((await recoveredOperation).status).toBe("ok");
    await client.stop();
  });
});
