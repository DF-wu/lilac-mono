import { describe, expect, it } from "bun:test";

import {
  decodeThreadMaterializerWorkerRequest,
  decodeThreadMaterializerWorkerResponse,
  type ThreadMaterializerWorkerRequest,
} from "../../src/conversation/thread-materializer-worker-protocol";
import {
  startConversationThreadMaterializer,
  type ThreadMaterializerWorkerHost,
} from "../../src/conversation/thread-materializer-worker";

class FakeMaterializerWorker implements ThreadMaterializerWorkerHost {
  readonly requests: ThreadMaterializerWorkerRequest[] = [];
  terminated = false;
  private messageHandler: ((event: MessageEvent<unknown>) => void) | null = null;
  private readonly requestWaiters = new Map<
    number,
    (request: ThreadMaterializerWorkerRequest) => void
  >();

  setMessageHandler(handler: (event: MessageEvent<unknown>) => void): void {
    this.messageHandler = handler;
  }

  setErrorHandler(handler: (event: ErrorEvent) => void): void {
    void handler;
  }

  postMessage(request: Parameters<ThreadMaterializerWorkerHost["postMessage"]>[0]): void {
    this.requests.push(request);
    this.requestWaiters.get(this.requests.length - 1)?.(request);
    this.requestWaiters.delete(this.requests.length - 1);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    this.messageHandler?.(new MessageEvent("message", { data }));
  }

  waitForRequest(index: number): Promise<ThreadMaterializerWorkerRequest> {
    const request = this.requests[index];
    if (request) return Promise.resolve(request);
    return new Promise((resolve) => this.requestWaiters.set(index, resolve));
  }
}

async function expectWorkerRestart(response: (requestId: string) => unknown): Promise<void> {
  const workers: FakeMaterializerWorker[] = [];
  const materializer = startConversationThreadMaterializer({
    searchDbPath: "/tmp/search.db",
    workerFactory: () => {
      const worker = new FakeMaterializerWorker();
      workers.push(worker);
      return worker;
    },
  });
  const first = workers[0];
  if (!first) throw new Error("Initial materializer worker was not created");
  const firstRequest = first.requests[0];
  if (!firstRequest) throw new Error("Initial list request was not posted");

  first.emitMessage(response(firstRequest.id));
  expect(first.terminated).toBe(true);
  expect(workers).toHaveLength(2);

  const replacement = workers[1];
  const replacementRequest = replacement?.requests[0];
  if (!replacement || !replacementRequest)
    throw new Error("Replacement list request was not posted");
  replacement.emitMessage({
    id: replacementRequest.id,
    ok: true,
    type: "list-channels",
    channelIds: [],
  });
  await materializer.flush();
  await materializer.stop();
}

describe("thread materializer worker protocol", () => {
  it("decodes complete request and response envelopes", () => {
    expect(
      decodeThreadMaterializerWorkerRequest({
        id: "request",
        type: "repair-channel",
        searchDbPath: "/tmp/search.db",
        channelId: "channel",
        kind: "content",
        messageIds: ["message"],
      }).status,
    ).toBe("ok");
    expect(
      decodeThreadMaterializerWorkerRequest({
        id: "topology-request",
        type: "repair-channel",
        searchDbPath: "/tmp/search.db",
        channelId: "channel",
        kind: "topology",
      }).status,
    ).toBe("ok");
    expect(
      decodeThreadMaterializerWorkerResponse({
        id: "request",
        ok: true,
        type: "repair-channel",
      }).status,
    ).toBe("ok");
  });

  it("rejects corrupt wire payloads without admitting partial envelopes", () => {
    const request = decodeThreadMaterializerWorkerRequest({
      id: "request",
      type: "repair-channel",
      searchDbPath: "/tmp/search.db",
      kind: "content",
    });
    const response = decodeThreadMaterializerWorkerResponse({
      id: "request",
      ok: true,
      type: "list-channels",
      channelIds: [1],
    });

    expect(request.status).toBe("error");
    expect(response.status).toBe("error");
  });

  it("rejects unknown fields and empty response values", () => {
    const requests = [
      {
        id: "request",
        type: "list-channels",
        searchDbPath: "/tmp/search.db",
        extra: true,
      },
      {
        id: "request",
        type: "repair-channel",
        searchDbPath: "/tmp/search.db",
        channelId: "channel",
        kind: "topology",
        extra: true,
      },
    ];
    const responses = [
      { id: "request", ok: false, error: "" },
      { id: "request", ok: false, error: "failed", extra: true },
      { id: "request", ok: true, type: "list-channels", channelIds: [""] },
      { id: "request", ok: true, type: "repair-channel", extra: true },
    ];

    for (const request of requests) {
      expect(decodeThreadMaterializerWorkerRequest(request).status).toBe("error");
    }
    for (const response of responses) {
      expect(decodeThreadMaterializerWorkerResponse(response).status).toBe("error");
    }
  });

  it("requires content message ids and forbids them for topology repair", () => {
    const invalidRequests = [
      {
        id: "missing-content-message-ids",
        type: "repair-channel",
        searchDbPath: "/tmp/search.db",
        channelId: "channel",
        kind: "content",
      },
      {
        id: "empty-content-message-ids",
        type: "repair-channel",
        searchDbPath: "/tmp/search.db",
        channelId: "channel",
        kind: "content",
        messageIds: [],
      },
      {
        id: "topology-message-ids",
        type: "repair-channel",
        searchDbPath: "/tmp/search.db",
        channelId: "channel",
        kind: "topology",
        messageIds: ["message"],
      },
    ];

    for (const request of invalidRequests) {
      expect(decodeThreadMaterializerWorkerRequest(request).status).toBe("error");
    }
  });

  it("restarts and settles pending work after a malformed response", async () => {
    await expectWorkerRestart((requestId) => ({
      id: requestId,
      ok: true,
      type: "list-channels",
      channelIds: [],
      unexpected: true,
    }));
  });

  it("restarts and settles pending work after an unknown response id", async () => {
    await expectWorkerRestart(() => ({
      id: "unknown-request",
      ok: true,
      type: "list-channels",
      channelIds: [],
    }));
  });

  it("requeues a repair after a correlated wrong response type", async () => {
    const workers: FakeMaterializerWorker[] = [];
    const materializer = startConversationThreadMaterializer({
      searchDbPath: "/tmp/search.db",
      workerFactory: () => {
        const worker = new FakeMaterializerWorker();
        workers.push(worker);
        return worker;
      },
    });
    const first = workers[0];
    if (!first) throw new Error("Initial materializer worker was not created");
    const initialList = await first.waitForRequest(0);
    first.emitMessage({
      id: initialList.id,
      ok: true,
      type: "list-channels",
      channelIds: [],
    });
    await materializer.flush();

    materializer.markDirty({ channelId: "channel-a", kind: "content", messageId: "message-a" });
    const flushed = materializer.flush();
    const firstRepair = await first.waitForRequest(1);
    expect(firstRepair).toMatchObject({
      type: "repair-channel",
      channelId: "channel-a",
      kind: "content",
      messageIds: ["message-a"],
    });
    first.emitMessage({
      id: firstRepair.id,
      ok: true,
      type: "list-channels",
      channelIds: [],
    });

    expect(first.terminated).toBe(true);
    const replacement = workers[1];
    if (!replacement) throw new Error("Replacement materializer worker was not created");
    const recoveryList = await replacement.waitForRequest(0);
    replacement.emitMessage({
      id: recoveryList.id,
      ok: true,
      type: "list-channels",
      channelIds: ["channel-a"],
    });
    const retriedRepair = await replacement.waitForRequest(1);
    expect(retriedRepair).toEqual({
      id: retriedRepair.id,
      type: "repair-channel",
      searchDbPath: "/tmp/search.db",
      channelId: "channel-a",
      kind: "topology",
    });
    replacement.emitMessage({ id: retriedRepair.id, ok: true, type: "repair-channel" });

    await flushed;
    await materializer.stop();
  });
});
