import { describe, expect, test } from "bun:test";
import {
  BlobIntegrityFailure,
  BlobResolveTimeout,
  BlobUploadFailed,
  createMemoryBlobStore,
  materializeBlobRead,
  type BlobHandleV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type PublishMessage,
  type PublishOptions,
  type RawBus,
  type RawDeliveryHandler,
  type RawMessageDecodeOutcome,
  type RawOutputStreamExpiry,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";

import {
  REQUEST_DELIVERY_RESOLVE_TIMEOUT_MS,
  RequestDeliveryCoordinator,
  SqliteRequestDeliveryStore,
  collectCoreRequestInputHandles,
  coreRequestDeliveryCodecs,
  createCoreRequestDeliveryAdmission,
  createCoreRequestOutputReplayRecovery,
  createDurableCoreRequestBus,
  createLilacBusRequestDeliveryPublisher,
  type CorePreparedRequestEnvelope,
  type CoreRequestOutputMetadata,
  type CoreAcceptedRequestWork,
  type RequestDeliveryPublisher,
} from "../../../src/surface/bridge/request-delivery";

function value<T, E extends Error>(result: ResultType<T, E>): T {
  return result.match({
    ok: (resultValue) => resultValue,
    err: (error) => {
      throw error;
    },
  });
}

async function resultValue<T, E extends Error>(result: Promise<ResultType<T, E>>): Promise<T> {
  return value(await result);
}

async function memoryBlobStore(): Promise<BlobStore> {
  return resultValue(createMemoryBlobStore());
}

function createStore() {
  return new SqliteRequestDeliveryStore<
    CorePreparedRequestEnvelope,
    CoreAcceptedRequestWork,
    CoreRequestOutputMetadata
  >({
    dbPath: ":memory:",
    codecs: coreRequestDeliveryCodecs,
  });
}

function envelope(input: {
  requestDeliveryId: string;
  requestId: string;
  handle?: BlobHandleV1;
}): CorePreparedRequestEnvelope {
  return {
    headers: {
      request_id: input.requestId,
      session_id: "session-1",
      request_client: "discord",
    },
    data: {
      requestDeliveryId: input.requestDeliveryId,
      queue: "prompt",
      messages: [
        {
          role: "user",
          content: input.handle
            ? [
                { type: "text", text: "inspect" },
                {
                  type: "blob",
                  blob: input.handle,
                  mediaType: "text/plain",
                  filename: "input.txt",
                },
              ]
            : "hello",
        },
      ],
    },
  };
}

function coordinator(input: {
  store: ReturnType<typeof createStore>;
  blobStore: Pick<BlobStore, "resolve" | "open" | "delete">;
  now?: () => number;
  logger?: {
    debug(message: string, context: Readonly<Record<string, string | number | boolean>>): void;
    error(message: string, context: Readonly<Record<string, string | number | boolean>>): void;
  };
}) {
  return new RequestDeliveryCoordinator({
    store: input.store,
    blobStore: input.blobStore,
    admission: createCoreRequestDeliveryAdmission(input.blobStore),
    ...(input.now ? { now: input.now } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
  });
}

function publicationClaimMethods() {
  return {
    async acquire(input: { readonly requestDeliveryId: string }) {
      return Result.ok({
        status: "acquired" as const,
        claim: {
          requestDeliveryId: input.requestDeliveryId,
          token: crypto.randomUUID(),
        },
      });
    },
    async confirm() {
      return Result.ok("confirmed" as const);
    },
    async abandon() {
      return Result.ok("abandoned" as const);
    },
  };
}

function outputReplayBus(input: {
  readonly requestId: string;
  readonly terminalRequestDeliveryId: string;
  readonly terminalOutput: boolean;
  readonly fetchFailure?: Error;
  readonly expiry?: RawOutputStreamExpiry;
  readonly expiryFailure?: Error;
}) {
  const topic = `out.req.${input.requestId}` as const;
  const raw: RawBus = {
    async publish() {
      return { id: "1-0", cursor: "1-0" };
    },
    async subscribe() {
      return Result.ok({
        done: Promise.resolve(Result.ok(undefined)),
        stop: async () => Result.ok(undefined),
      });
    },
    async fetch() {
      if (input.fetchFailure) throw input.fetchFailure;
      return {
        messages: input.terminalOutput
          ? [
              {
                cursor: "1-0",
                msg: {
                  topic,
                  id: "1-0",
                  type: lilacEventTypes.EvtAgentOutputResponseText,
                  ts: 1,
                  key: input.requestId,
                  headers: {
                    request_id: input.requestId,
                    request_delivery_id: input.terminalRequestDeliveryId,
                  },
                  data: { finalText: "finished" },
                },
              },
            ]
          : [],
      };
    },
    async readOutputStreamExpiry() {
      if (input.expiryFailure) throw input.expiryFailure;
      return input.expiry ?? { kind: "absent" };
    },
    async close() {},
  };
  return createLilacBus(raw);
}

async function acceptRequestWithOutput(input: {
  readonly store: ReturnType<typeof createStore>;
  readonly blobs: BlobStore;
  readonly requestDeliveryId: string;
  readonly requestId: string;
}) {
  const preparedEnvelope = envelope(input);
  value(
    input.store.prepare({
      ...input,
      envelope: preparedEnvelope,
      inputHandles: [],
      createdAt: 1,
    }),
  );
  const delivery = coordinator({
    store: input.store,
    blobStore: input.blobs,
    now: () => 2,
  });
  value(await delivery.handleDelivery(input.requestDeliveryId));
  const upload = await resultValue(
    input.blobs.startUpload({
      source: new TextEncoder().encode("recovered output"),
      retention: { kind: "durable" },
    }),
  );
  value(
    delivery.registerOutputHandle({
      requestDeliveryId: input.requestDeliveryId,
      handle: upload.handle,
      metadata: { mimeType: "text/plain" },
    }),
  );
  const reference = await resultValue(upload.completion);
  value(
    delivery.recordOutputReference({
      requestDeliveryId: input.requestDeliveryId,
      reference,
    }),
  );
  return { delivery, reference };
}

describe("durable request delivery", () => {
  test("routes every cmd.request on the Core bus through a prepared record", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const delivery = coordinator({ store, blobStore: blobs, now: () => 100 });
    const requestDeliveryId = crypto.randomUUID();
    let observedPrepared = false;
    let publishedCount = 0;
    const raw: RawBus = {
      async publish<TData>(_message: PublishMessage<TData>, _options: PublishOptions) {
        return { id: "ordinary-1", cursor: "ordinary-1" };
      },
      async acquireRequestPublicationClaim(requestDeliveryId) {
        return {
          status: "acquired",
          claim: { requestDeliveryId, token: crypto.randomUUID() },
        };
      },
      async publishClaimedRequest() {
        publishedCount += 1;
        observedPrepared = value(store.load(requestDeliveryId)).state === "prepared";
        return {
          status: "published",
          receipt: { id: "100-0", cursor: "100-0" },
        };
      },
      async confirmRequestPublication() {
        return "confirmed";
      },
      async abandonRequestPublicationClaim() {
        return "abandoned";
      },
      async subscribe(_topic: string, _options: SubscriptionOptions, _handler: RawDeliveryHandler) {
        return Result.ok({
          done: Promise.resolve(Result.ok(undefined)),
          stop: async () => Result.ok(undefined),
        });
      },
      async fetch(
        _topic: string,
        _options: FetchOptions,
      ): Promise<{
        messages: Array<{ msg: RawMessageDecodeOutcome; cursor: string }>;
        next?: string;
      }> {
        return { messages: [] };
      },
      async close() {},
    };
    const transportBus = createLilacBus(raw);
    const durableBus = createDurableCoreRequestBus({
      transportBus,
      coordinator: delivery,
      publisher: createLilacBusRequestDeliveryPublisher(transportBus),
    });

    const published = value(
      await durableBus.publish(
        lilacEventTypes.CmdRequestMessage,
        envelope({ requestDeliveryId, requestId: "request-proxy" }).data,
        {
          headers: {
            request_id: "request-proxy",
            session_id: "session-1",
            request_client: "discord",
          },
        },
      ),
    );

    expect(observedPrepared).toBe(true);
    expect(published).toMatchObject({ id: "100-0", topic: "cmd.request" });
    expect(value(store.load(requestDeliveryId)).publication?.streamId).toBe("100-0");
    await durableBus.publish(
      lilacEventTypes.CmdRequestMessage,
      envelope({ requestDeliveryId, requestId: "request-proxy" }).data,
      {
        headers: {
          request_id: "request-proxy",
          session_id: "session-1",
          request_client: "discord",
        },
      },
    );
    expect(publishedCount).toBe(1);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("publishes active cancel, steer, interrupt, and workflow controls with one request ID", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const delivery = coordinator({ store, blobStore: blobs, now: () => 100 });
    let publishedCount = 0;
    const raw: RawBus = {
      async publish() {
        return { id: "ordinary-1", cursor: "ordinary-1" };
      },
      async acquireRequestPublicationClaim(requestDeliveryId) {
        return {
          status: "acquired",
          claim: { requestDeliveryId, token: crypto.randomUUID() },
        };
      },
      async publishClaimedRequest() {
        publishedCount += 1;
        const id = `${publishedCount}-0`;
        return { status: "published", receipt: { id, cursor: id } };
      },
      async confirmRequestPublication() {
        return "confirmed";
      },
      async abandonRequestPublicationClaim() {
        return "abandoned";
      },
      async subscribe() {
        return Result.ok({
          done: Promise.resolve(Result.ok(undefined)),
          stop: async () => Result.ok(undefined),
        });
      },
      async fetch() {
        return { messages: [] };
      },
      async close() {},
    };
    const transportBus = createLilacBus(raw);
    const durableBus = createDurableCoreRequestBus({
      transportBus,
      coordinator: delivery,
      publisher: createLilacBusRequestDeliveryPublisher(transportBus),
    });
    const requestId = "discord:active-control-session:request";
    const deliveries = [
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "prompt" as const,
        messages: [{ role: "user" as const, content: "start" }],
        requestClient: "discord" as const,
      },
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "interrupt" as const,
        messages: [],
        raw: { cancel: true, requiresActive: true },
        requestClient: "discord" as const,
      },
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "steer" as const,
        messages: [{ role: "user" as const, content: "change direction" }],
        requestClient: "discord" as const,
      },
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "interrupt" as const,
        messages: [{ role: "user" as const, content: "replace active work" }],
        requestClient: "discord" as const,
      },
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "interrupt" as const,
        messages: [],
        raw: { cancel: true, cancelQueued: true, requiresActive: false },
        requestClient: "unknown" as const,
      },
    ];

    for (const command of deliveries) {
      const published = await durableBus.publish(
        lilacEventTypes.CmdRequestMessage,
        {
          requestDeliveryId: command.requestDeliveryId,
          queue: command.queue,
          messages: command.messages,
          ...("raw" in command ? { raw: command.raw } : {}),
        },
        {
          headers: {
            request_id: requestId,
            session_id: "active-control-session",
            request_client: command.requestClient,
          },
        },
      );
      expect(published.status).toBe("ok");
    }

    expect(publishedCount).toBe(deliveries.length);
    for (const command of deliveries) {
      expect(value(store.load(command.requestDeliveryId))).toMatchObject({
        state: "prepared",
        requestDeliveryId: command.requestDeliveryId,
        requestId,
      });
    }
    for (const command of deliveries) {
      expect(value(await delivery.handleDelivery(command.requestDeliveryId)).disposition).toBe(
        "accepted",
      );
    }
    const output = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("active request output"),
        retention: { kind: "durable" },
      }),
    );
    expect(
      value(
        delivery.registerOutputHandle({
          requestDeliveryId: deliveries[0]!.requestDeliveryId,
          handle: output.handle,
          metadata: { mimeType: "text/plain" },
        }),
      ).requestDeliveryId,
    ).toBe(deliveries[0]!.requestDeliveryId);
    await resultValue(output.completion);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("prepares before publication and recovers an ambiguous publication idempotently", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const delivery = coordinator({ store, blobStore: blobs, now: () => 100 });
    const requestDeliveryId = crypto.randomUUID();
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-1",
    });
    let attempts = 0;
    const publisher: RequestDeliveryPublisher<CorePreparedRequestEnvelope> = {
      ...publicationClaimMethods(),
      async publish() {
        attempts += 1;
        return attempts === 1
          ? Result.err(new Error("connection outcome unknown"))
          : Result.ok({ streamId: "100-0" });
      },
      classifyFailure: () => ({ certainty: "ambiguous", code: "transport" }),
    };

    const first = value(
      await delivery.prepareAndPublish(
        {
          requestDeliveryId,
          requestId: "request-1",
          envelope: preparedEnvelope,
          inputHandles: [],
        },
        publisher,
      ),
    );
    expect(first.status).toBe("ambiguous");
    expect(value(store.load(requestDeliveryId)).state).toBe("prepared");

    const recovered = value(await delivery.recoverPreparedPublications(publisher));
    expect(recovered.published).toBe(1);
    const durable = value(store.load(requestDeliveryId));
    expect(durable.state).toBe("prepared");
    expect(durable.publication?.streamId).toBe("100-0");
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("reconciles a publication receipt after delivery wins the accept or terminal race", async () => {
    for (const terminalBeforeReceipt of [false, true]) {
      const store = createStore();
      const blobs = await memoryBlobStore();
      const requestDeliveryId = crypto.randomUUID();
      const requestId = `request-publication-race-${terminalBeforeReceipt}`;
      const preparedEnvelope = envelope({ requestDeliveryId, requestId });
      const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
      let publications = 0;
      const confirmations: Array<{ requestDeliveryId: string; streamId: string }> = [];
      const streamId = `race:${terminalBeforeReceipt}`;
      const outcome = value(
        await delivery.prepareAndPublish(
          {
            requestDeliveryId,
            requestId,
            envelope: preparedEnvelope,
            inputHandles: [],
          },
          {
            ...publicationClaimMethods(),
            publish: async () => {
              publications += 1;
              expect(value(await delivery.handleDelivery(requestDeliveryId)).disposition).toBe(
                "accepted",
              );
              value(delivery.observeTransportCommit(requestDeliveryId, streamId));
              if (terminalBeforeReceipt) {
                value(
                  await delivery.terminalize({
                    requestDeliveryId,
                    outcome: {
                      kind: "completed",
                      code: "finished-before-publish-receipt",
                    },
                  }),
                );
              }
              return Result.ok({ streamId });
            },
            classifyFailure: () => ({
              certainty: "ambiguous",
              code: "unexpected",
            }),
            confirm: async ({ claim, streamId }) => {
              confirmations.push({
                requestDeliveryId: claim.requestDeliveryId,
                streamId,
              });
              return Result.ok("confirmed");
            },
          },
        ),
      );

      expect(outcome).toMatchObject({
        status: "published",
        record: {
          state: terminalBeforeReceipt ? "terminal" : "accepted",
          requestDeliveryId,
          publication: { streamId },
        },
      });
      expect(publications).toBe(1);
      expect(confirmations).toEqual([{ requestDeliveryId, streamId }]);
      expect(value(await delivery.handleDelivery(requestDeliveryId))).toMatchObject({
        disposition: "commit",
        reason: terminalBeforeReceipt ? "already-terminal" : "already-accepted",
      });
      expect(
        store.recordPublication({
          requestDeliveryId,
          streamId: "different-stream",
          recordedAt: 3,
        }).status,
      ).toBe("error");
      store.close();
      await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
    }
  });

  test("fails closed on confirmation mismatch and reconciles an absent marker under a fresh claim", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "request-confirmation-mismatch";
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    const confirmations = ["mismatch", "absent"] as const;
    let confirmationIndex = 0;
    let publications = 0;
    const publisher: RequestDeliveryPublisher<CorePreparedRequestEnvelope> = {
      ...publicationClaimMethods(),
      publish: async () => {
        publications += 1;
        return Result.ok({ streamId: "confirmation:1" });
      },
      classifyFailure: () => ({ certainty: "ambiguous", code: "unexpected" }),
      confirm: async () => Result.ok(confirmations[confirmationIndex++] ?? "fenced"),
    };

    const first = value(
      await delivery.prepareAndPublish(
        {
          requestDeliveryId,
          requestId,
          envelope: envelope({ requestDeliveryId, requestId }),
          inputHandles: [],
        },
        publisher,
      ),
    );
    expect(first).toMatchObject({
      status: "ambiguous",
      publicationError: { name: "RequestDeliveryPublicationFenceRejected" },
    });
    expect(publications).toBe(1);
    expect(value(store.load(requestDeliveryId)).publication?.streamId).toBe("confirmation:1");

    const reconciled = value(
      await delivery.prepareAndPublish(
        {
          requestDeliveryId,
          requestId,
          envelope: envelope({ requestDeliveryId, requestId }),
          inputHandles: [],
        },
        publisher,
      ),
    );
    expect(reconciled.status).toBe("already-published");
    expect(publications).toBe(1);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("retains live input ownership when the same delivery retries after acceptance", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const upload = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("accepted retry input"),
        retention: { kind: "durable" },
      }),
    );
    const reference = await resultValue(upload.completion);
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "request-accepted-producer-retry";
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId,
      handle: upload.handle,
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId,
        envelope: preparedEnvelope,
        inputHandles: [upload.handle],
        createdAt: 1,
      }),
    );
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    expect(value(await delivery.handleDelivery(requestDeliveryId)).disposition).toBe("accepted");
    let publications = 0;
    const retried = await delivery.prepareAndPublish(
      {
        requestDeliveryId,
        requestId,
        envelope: preparedEnvelope,
        inputHandles: [upload.handle],
      },
      {
        ...publicationClaimMethods(),
        publish: async () => {
          publications += 1;
          return Result.ok({ streamId: "must-not-publish" });
        },
        classifyFailure: () => ({ certainty: "ambiguous", code: "unexpected" }),
      },
    );
    expect(retried.status).toBe("error");
    expect(publications).toBe(0);
    const read = value(await blobs.open(reference));
    expect(new TextDecoder().decode(value(await materializeBlobRead(read)))).toBe(
      "accepted retry input",
    );
    expect(value(store.load(requestDeliveryId))).toMatchObject({
      state: "accepted",
      inputReferences: [reference],
    });
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("deletes durable input handles when the prepared-record write fails", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const upload = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("unowned after prepare failure"),
        retention: { kind: "durable" },
      }),
    );
    await resultValue(upload.completion);
    const delivery = coordinator({ store, blobStore: blobs, now: () => -1 });
    const requestDeliveryId = crypto.randomUUID();
    let publishCalls = 0;
    const publisher: RequestDeliveryPublisher<CorePreparedRequestEnvelope> = {
      ...publicationClaimMethods(),
      async publish() {
        publishCalls += 1;
        return Result.ok({ streamId: "unexpected" });
      },
      classifyFailure: () => ({ certainty: "ambiguous", code: "unused" }),
    };

    const prepared = await delivery.prepareAndPublish(
      {
        requestDeliveryId,
        requestId: "request-prepare-write-failure",
        envelope: envelope({
          requestDeliveryId,
          requestId: "request-prepare-write-failure",
          handle: upload.handle,
        }),
        inputHandles: [upload.handle],
      },
      publisher,
    );

    expect(prepared.status).toBe("error");
    expect(publishCalls).toBe(0);
    expect((await blobs.resolve(upload.handle, { timeoutMs: 1_000 })).status).toBe("error");
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("resolves handles before validation and commits accepted redelivery before blob access", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const upload = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("durable input"),
        retention: { kind: "durable" },
      }),
    );
    const reference = await resultValue(upload.completion);
    const requestDeliveryId = crypto.randomUUID();
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-2",
      handle: upload.handle,
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-2",
        envelope: preparedEnvelope,
        inputHandles: collectCoreRequestInputHandles(preparedEnvelope),
        createdAt: 1,
      }),
    );

    let resolveCalls = 0;
    let openCalls = 0;
    const countingBlobs: Pick<BlobStore, "resolve" | "open" | "delete"> = {
      resolve: async (handle, options) => {
        resolveCalls += 1;
        expect(options.timeoutMs).toBe(REQUEST_DELIVERY_RESOLVE_TIMEOUT_MS);
        return blobs.resolve(handle, options);
      },
      open: async (blob) => {
        openCalls += 1;
        return blobs.open(blob);
      },
      delete: (target) => blobs.delete(target),
    };
    const delivery = coordinator({
      store,
      blobStore: countingBlobs,
      now: () => 2,
    });
    const accepted = value(await delivery.handleDelivery(requestDeliveryId));
    expect(accepted.disposition).toBe("accepted");
    if (accepted.disposition === "accepted") {
      expect(accepted.record.inputReferences).toEqual([reference]);
      const file = accepted.record.work.data.messages[0]?.content;
      expect(file).toEqual([
        { type: "text", text: "inspect" },
        {
          type: "blob",
          blob: reference,
          mediaType: "text/plain",
          filename: "input.txt",
        },
      ]);
    }

    const redelivery = value(await delivery.handleDelivery(requestDeliveryId));
    expect(redelivery).toMatchObject({
      disposition: "commit",
      reason: "already-accepted",
    });
    expect(resolveCalls).toBe(1);
    expect(openCalls).toBe(1);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("terminalizes instead of accepting when a resolved blob fails its verified read", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const upload = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("corrupt input"),
        retention: { kind: "durable" },
      }),
    );
    await resultValue(upload.completion);
    const requestDeliveryId = crypto.randomUUID();
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-corrupt-input",
      handle: upload.handle,
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-corrupt-input",
        envelope: preparedEnvelope,
        inputHandles: collectCoreRequestInputHandles(preparedEnvelope),
        createdAt: 1,
      }),
    );

    let openCalls = 0;
    const corruptBlobs: Pick<BlobStore, "resolve" | "open" | "delete"> = {
      resolve: (handle, options) => blobs.resolve(handle, options),
      async open(reference) {
        openCalls += 1;
        return Result.ok({
          ref: reference,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("tampered input"));
              controller.close();
            },
          }),
          completion: Promise.resolve(
            Result.err(
              new BlobIntegrityFailure({
                objectId: reference.objectId,
                reason: "sha256-mismatch",
                message: "Controlled corrupt request blob",
              }),
            ),
          ),
        });
      },
      delete: (target) => blobs.delete(target),
    };
    const delivery = coordinator({
      store,
      blobStore: corruptBlobs,
      now: () => 2,
    });

    expect(value(await delivery.handleDelivery(requestDeliveryId))).toEqual({
      disposition: "commit",
      reason: "terminalized",
    });
    expect(openCalls).toBe(1);
    const terminal = value(store.load(requestDeliveryId));
    expect(terminal.state).toBe("terminal");
    if (terminal.state === "terminal") {
      expect(terminal.outcome).toEqual({
        kind: "failed",
        code: "resolved-reference-unreadable",
      });
    }

    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("uses one 60 second resolve budget and terminalizes a timed-out delivery", async () => {
    const store = createStore();
    const requestDeliveryId = crypto.randomUUID();
    const handle = {
      version: 1,
      objectId: "b1_11111111111111111111111111111111",
    } as const;
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-3",
      handle,
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-3",
        envelope: preparedEnvelope,
        inputHandles: [handle],
        createdAt: 1,
      }),
    );
    let observedTimeout = 0;
    const blobPort: Pick<BlobStore, "resolve" | "open" | "delete"> = {
      async resolve(target, options) {
        observedTimeout = options.timeoutMs;
        return Result.err(
          new BlobResolveTimeout({
            objectId: target.objectId,
            timeoutMs: options.timeoutMs,
            message: "controlled timeout",
          }),
        );
      },
      async delete() {
        return Result.ok("deleted");
      },
      open: (reference) => {
        throw new Error(`Unexpected open for ${reference.objectId}`);
      },
    };
    const errors: Array<{ message: string; context: Record<string, unknown> }> = [];
    const delivery = coordinator({
      store,
      blobStore: blobPort,
      now: () => 2,
      logger: {
        debug: () => undefined,
        error: (message, context) => errors.push({ message, context }),
      },
    });
    const outcome = value(await delivery.handleDelivery(requestDeliveryId));
    expect(outcome).toEqual({ disposition: "commit", reason: "terminalized" });
    expect(observedTimeout).toBe(60_000);
    const terminal = value(store.load(requestDeliveryId));
    expect(terminal.state).toBe("terminal");
    if (terminal.state === "terminal") {
      expect(terminal.outcome.kind).toBe("upload-timeout");
      expect(terminal.inputCleanupPending).toEqual([]);
    }
    expect(errors).toEqual([
      {
        message: "request canceled after input blob upload failed",
        context: {
          requestDeliveryId,
          requestId: "request-3",
          objectId: handle.objectId,
          outcome: "upload-timeout",
          errorClass: "BlobResolveTimeout",
          errorMessage: "controlled timeout",
        },
      },
    ]);
    store.close();
  });

  test("logs an error when upload failure cancels a request", async () => {
    const store = createStore();
    const requestDeliveryId = crypto.randomUUID();
    const handle = {
      version: 1,
      objectId: "b1_22222222222222222222222222222222",
    } as const;
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-upload-failed",
      handle,
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-upload-failed",
        envelope: preparedEnvelope,
        inputHandles: [handle],
        createdAt: 1,
      }),
    );
    const errors: Array<{ message: string; context: Record<string, unknown> }> = [];
    const delivery = coordinator({
      store,
      blobStore: {
        resolve: async () =>
          Result.err(
            new BlobUploadFailed({
              objectId: handle.objectId,
              reason: "expected_byte_length",
              message: "controlled upload failure",
            }),
          ),
        delete: async () => Result.ok("deleted"),
        open: (reference) => {
          throw new Error(`Unexpected open for ${reference.objectId}`);
        },
      },
      now: () => 2,
      logger: {
        debug: () => undefined,
        error: (message, context) => errors.push({ message, context }),
      },
    });

    expect(value(await delivery.handleDelivery(requestDeliveryId))).toEqual({
      disposition: "commit",
      reason: "terminalized",
    });
    const terminal = value(store.load(requestDeliveryId));
    expect(terminal).toMatchObject({
      state: "terminal",
      outcome: { kind: "upload-failed", code: "BlobUploadFailed" },
    });
    expect(errors).toEqual([
      {
        message: "request canceled after input blob upload failed",
        context: {
          requestDeliveryId,
          requestId: "request-upload-failed",
          objectId: handle.objectId,
          outcome: "upload-failed",
          errorClass: "BlobUploadFailed",
          errorMessage: "controlled upload failure",
        },
      },
    ]);
    store.close();
  });

  test("keeps terminal tombstones until transport commit is observed", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-4",
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-4",
        envelope: preparedEnvelope,
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    value(await delivery.handleDelivery(requestDeliveryId));
    value(
      await delivery.terminalize({
        requestDeliveryId,
        outcome: { kind: "completed" },
        transportCommitRequired: true,
      }),
    );

    const beforeCommit = value(await delivery.maintain({ now: 10 }));
    expect(beforeCommit.tombstonesDeleted).toBe(0);
    expect(value(store.load(requestDeliveryId)).state).toBe("terminal");

    value(delivery.observeTransportCommit(requestDeliveryId, "transport:request-4"));
    const afterCommit = value(await delivery.maintain({ now: 10 }));
    expect(afterCommit.tombstonesDeleted).toBe(1);
    expect(store.load(requestDeliveryId).match({ ok: () => false, err: () => true })).toBe(true);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("exhausts recovery pages without a published prefix starving later work", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    const preparedIds = Array.from({ length: 105 }, () => crypto.randomUUID()).toSorted();
    for (const [index, requestDeliveryId] of preparedIds.entries()) {
      value(
        store.prepare({
          requestDeliveryId,
          requestId: `prepared-${index}`,
          envelope: envelope({
            requestDeliveryId,
            requestId: `prepared-${index}`,
          }),
          inputHandles: [],
          createdAt: 1,
        }),
      );
    }
    for (const requestDeliveryId of preparedIds.slice(0, 12)) {
      value(
        store.recordPublication({
          requestDeliveryId,
          streamId: `published:${requestDeliveryId}`,
          recordedAt: 1,
        }),
      );
    }
    const published: string[] = [];
    const preparedSummary = value(
      await delivery.recoverPreparedPublications(
        {
          ...publicationClaimMethods(),
          publish: async ({ requestDeliveryId }) => {
            published.push(requestDeliveryId);
            return Result.ok({ streamId: `recovered:${requestDeliveryId}` });
          },
          classifyFailure: () => ({
            certainty: "ambiguous",
            code: "unexpected",
          }),
        },
        { limit: 10 },
      ),
    );
    expect(preparedSummary).toMatchObject({
      published: 93,
      alreadyPublished: 12,
    });
    expect(published).toHaveLength(93);

    const acceptedIds = Array.from({ length: 105 }, () => crypto.randomUUID()).toSorted();
    for (const [index, requestDeliveryId] of acceptedIds.entries()) {
      value(
        store.prepare({
          requestDeliveryId,
          requestId: `accepted-${index}`,
          envelope: envelope({
            requestDeliveryId,
            requestId: `accepted-${index}`,
          }),
          inputHandles: [],
          createdAt: 1,
        }),
      );
      value(await delivery.handleDelivery(requestDeliveryId));
    }
    const resumed: string[] = [];
    const acceptedSummary = value(
      await delivery.recoverAccepted(
        async (record) => {
          resumed.push(record.requestDeliveryId);
          return Result.ok(undefined);
        },
        { limit: 10 },
      ),
    );
    expect(acceptedSummary.resumed).toBe(105);
    expect(resumed.toSorted()).toEqual(acceptedIds);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("atomically replaces an accepted alias identity for work, outputs, and recovery", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const originalRequestId = "request-model-control";
    const aliasRequestId = "request-model-control:projected-run";
    value(
      store.prepare({
        requestDeliveryId,
        requestId: originalRequestId,
        envelope: envelope({ requestDeliveryId, requestId: originalRequestId }),
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    const accepted = value(await delivery.handleDelivery(requestDeliveryId));
    if (accepted.disposition !== "accepted") throw new Error("expected accepted work");
    const outputUpload = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("alias output"),
        retention: { kind: "durable" },
      }),
    );
    value(
      delivery.registerOutputHandle({
        requestDeliveryId,
        handle: outputUpload.handle,
        metadata: { mimeType: "text/plain" },
      }),
    );

    const replacedWork: CoreAcceptedRequestWork = {
      ...accepted.record.work,
      requestId: aliasRequestId,
      headers: {
        ...accepted.record.work.headers,
        request_id: aliasRequestId,
      },
      data: { ...accepted.record.work.data, queue: "prompt" },
    };
    const replaced = value(
      delivery.replaceAcceptedWork({
        requestDeliveryId,
        requestId: aliasRequestId,
        work: replacedWork,
      }),
    );
    expect(replaced).toMatchObject({
      requestId: aliasRequestId,
      work: replacedWork,
    });
    expect(
      value(
        delivery.registerOutputHandle({
          requestDeliveryId,
          handle: outputUpload.handle,
          metadata: { mimeType: "text/plain" },
        }),
      ).requestId,
    ).toBe(aliasRequestId);
    const resumed: string[] = [];
    value(
      await delivery.recoverAccepted(async (record) => {
        expect(record.work.requestId).toBe(record.requestId);
        resumed.push(record.requestId);
        return Result.ok(undefined);
      }),
    );
    expect(resumed).toEqual([aliasRequestId]);
    await resultValue(outputUpload.completion);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("keeps output durable through the final Redis replay deadline", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const preparedEnvelope = envelope({
      requestDeliveryId,
      requestId: "request-5",
    });
    value(
      store.prepare({
        requestDeliveryId,
        requestId: "request-5",
        envelope: preparedEnvelope,
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    value(await delivery.handleDelivery(requestDeliveryId));

    const outputUpload = await resultValue(
      blobs.startUpload({
        source: new TextEncoder().encode("generated output"),
        retention: { kind: "durable" },
      }),
    );
    value(
      delivery.registerOutputHandle({
        requestDeliveryId,
        handle: outputUpload.handle,
        metadata: { mimeType: "text/plain", filename: "output.txt" },
      }),
    );
    const outputReference = await resultValue(outputUpload.completion);
    value(
      delivery.recordOutputReference({
        requestDeliveryId,
        reference: outputReference,
      }),
    );
    value(delivery.observeTransportCommit(requestDeliveryId, "transport:request-5"));
    value(
      await delivery.terminalize({
        requestDeliveryId,
        outcome: { kind: "completed" },
        finalReplayDeadline: 1_000,
      }),
    );

    const early = value(await delivery.maintain({ now: 999 }));
    expect(early.outputObjectsDeleted).toBe(0);
    const earlyRead = value(await blobs.open(outputReference));
    expect(new TextDecoder().decode(value(await materializeBlobRead(earlyRead)))).toBe(
      "generated output",
    );

    const due = value(await delivery.maintain({ now: 1_000 }));
    expect(due.outputObjectsDeleted).toBe(1);
    expect(due.tombstonesDeleted).toBe(1);
    expect(
      (await blobs.open(outputReference)).match({
        ok: () => false,
        err: () => true,
      }),
    ).toBe(true);
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("recovers a crash after final output XADD from the authoritative replay expiry", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "request-final-output-recovery";
    const { delivery } = await acceptRequestWithOutput({
      store,
      blobs,
      requestDeliveryId,
      requestId,
    });
    value(delivery.observeTransportCommit(requestDeliveryId, "transport:final-output"));
    let resumes = 0;
    const recovered = value(
      await delivery.recoverAccepted(
        async () => {
          resumes += 1;
          return Result.ok(undefined);
        },
        {
          outputReplay: createCoreRequestOutputReplayRecovery(
            outputReplayBus({
              requestId,
              terminalRequestDeliveryId: requestDeliveryId,
              terminalOutput: true,
              expiry: { kind: "present", expiresAt: 5_000 },
            }),
          ),
          isOutputReplayEligible: () => true,
        },
      ),
    );

    expect(recovered).toMatchObject({
      resumed: 0,
      terminalized: 1,
      uncertainties: [],
    });
    expect(resumes).toBe(0);
    const terminal = value(store.load(requestDeliveryId));
    expect(terminal).toMatchObject({
      state: "terminal",
      outcome: { kind: "completed", code: "recovered-final-output" },
      finalReplayDeadline: 5_000,
    });
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("recovers terminal prompt work without outputs but never mistakes a control for that run", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestId = "request-shared-terminal-output";
    const promptDeliveryId = crypto.randomUUID();
    const controlDeliveryIds = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ] as const;
    for (const [requestDeliveryId, queue] of [
      [promptDeliveryId, "prompt"],
      [controlDeliveryIds[0], "steer"],
      [controlDeliveryIds[1], "followUp"],
      [controlDeliveryIds[2], "interrupt"],
    ] as const) {
      const preparedEnvelope = envelope({ requestDeliveryId, requestId });
      preparedEnvelope.data.queue = queue;
      value(
        store.prepare({
          requestDeliveryId,
          requestId,
          envelope: preparedEnvelope,
          inputHandles: [],
          createdAt: 1,
        }),
      );
    }
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    value(await delivery.handleDelivery(promptDeliveryId));
    for (const controlDeliveryId of controlDeliveryIds) {
      value(await delivery.handleDelivery(controlDeliveryId));
    }
    const resumed: string[] = [];
    const recovered = value(
      await delivery.recoverAccepted(
        async (record) => {
          resumed.push(record.requestDeliveryId);
          return Result.ok(undefined);
        },
        {
          outputReplay: createCoreRequestOutputReplayRecovery(
            outputReplayBus({
              requestId,
              terminalRequestDeliveryId: promptDeliveryId,
              terminalOutput: true,
              expiry: { kind: "present", expiresAt: 5_000 },
            }),
          ),
          isOutputReplayEligible: (record) => record.work.data.queue === "prompt",
        },
      ),
    );

    expect(recovered).toMatchObject({ resumed: 3, terminalized: 1 });
    expect(resumed.toSorted()).toEqual(controlDeliveryIds.toSorted());
    expect(value(store.load(promptDeliveryId)).state).toBe("terminal");
    for (const controlDeliveryId of controlDeliveryIds) {
      expect(value(store.load(controlDeliveryId)).state).toBe("accepted");
    }
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("does not terminalize newer accepted work from an older shared-request response", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestId = "request-follow-up-after-old-response";
    const oldDeliveryId = crypto.randomUUID();
    const currentDeliveryId = crypto.randomUUID();
    value(
      store.prepare({
        requestDeliveryId: currentDeliveryId,
        requestId,
        envelope: envelope({ requestDeliveryId: currentDeliveryId, requestId }),
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const delivery = coordinator({ store, blobStore: blobs, now: () => 2 });
    value(await delivery.handleDelivery(currentDeliveryId));
    const resumed: string[] = [];
    const recovered = value(
      await delivery.recoverAccepted(
        async (record) => {
          resumed.push(record.requestDeliveryId);
          return Result.ok(undefined);
        },
        {
          outputReplay: createCoreRequestOutputReplayRecovery(
            outputReplayBus({
              requestId,
              terminalRequestDeliveryId: oldDeliveryId,
              terminalOutput: true,
              expiry: { kind: "present", expiresAt: 5_000 },
            }),
          ),
          isOutputReplayEligible: () => true,
        },
      ),
    );
    expect(recovered).toMatchObject({ resumed: 1, terminalized: 0 });
    expect(resumed).toEqual([currentDeliveryId]);
    expect(value(store.load(currentDeliveryId)).state).toBe("accepted");
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("resumes without terminal output and immediately expires proven terminal output", async () => {
    for (const terminalOutput of [false, true]) {
      const store = createStore();
      const blobs = await memoryBlobStore();
      const requestDeliveryId = crypto.randomUUID();
      const requestId = `request-safe-resume-${terminalOutput}`;
      const { delivery, reference } = await acceptRequestWithOutput({
        store,
        blobs,
        requestDeliveryId,
        requestId,
      });
      let resumes = 0;
      const recovered = value(
        await delivery.recoverAccepted(
          async () => {
            resumes += 1;
            return Result.ok(undefined);
          },
          {
            outputReplay: createCoreRequestOutputReplayRecovery(
              outputReplayBus({
                requestId,
                terminalRequestDeliveryId: requestDeliveryId,
                terminalOutput,
                expiry: { kind: "absent" },
              }),
            ),
            isOutputReplayEligible: () => true,
          },
        ),
      );

      if (!terminalOutput) {
        expect(recovered).toMatchObject({
          resumed: 1,
          terminalized: 0,
          uncertainties: [],
        });
        expect(resumes).toBe(1);
        expect(value(store.load(requestDeliveryId)).state).toBe("accepted");
        expect((await blobs.open(reference)).status).toBe("ok");
      } else {
        expect(recovered).toMatchObject({
          resumed: 0,
          terminalized: 1,
          uncertainties: [],
        });
        expect(resumes).toBe(0);
        expect(value(store.load(requestDeliveryId))).toMatchObject({
          state: "terminal",
          finalReplayDeadline: 0,
        });
        expect(value(await delivery.maintain({ now: 2 })).outputObjectsDeleted).toBe(1);
        expect((await blobs.open(reference)).status).toBe("error");
      }
      store.close();
      await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
    }
  });

  test("retains terminal output without resuming accepted work when Redis expiry is uncertain", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "request-uncertain-expiry";
    const { delivery, reference } = await acceptRequestWithOutput({
      store,
      blobs,
      requestDeliveryId,
      requestId,
    });
    let resumes = 0;
    const recovered = value(
      await delivery.recoverAccepted(
        async () => {
          resumes += 1;
          return Result.ok(undefined);
        },
        {
          outputReplay: createCoreRequestOutputReplayRecovery(
            outputReplayBus({
              requestId,
              terminalRequestDeliveryId: requestDeliveryId,
              terminalOutput: true,
              expiryFailure: new Error("Redis unavailable"),
            }),
          ),
          isOutputReplayEligible: () => true,
        },
      ),
    );

    expect(recovered.resumed).toBe(0);
    expect(recovered.terminalized).toBe(0);
    expect(recovered.uncertainties).toHaveLength(1);
    expect(resumes).toBe(0);
    expect(value(store.load(requestDeliveryId)).state).toBe("accepted");
    expect((await blobs.open(reference)).status).toBe("ok");
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  test("does not resume accepted work when terminal output inspection is uncertain", async () => {
    const store = createStore();
    const blobs = await memoryBlobStore();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "request-uncertain-output-inspection";
    const { delivery, reference } = await acceptRequestWithOutput({
      store,
      blobs,
      requestDeliveryId,
      requestId,
    });
    let resumes = 0;
    const recovered = value(
      await delivery.recoverAccepted(
        async () => {
          resumes += 1;
          return Result.ok(undefined);
        },
        {
          outputReplay: createCoreRequestOutputReplayRecovery(
            outputReplayBus({
              requestId,
              terminalRequestDeliveryId: requestDeliveryId,
              terminalOutput: false,
              fetchFailure: new Error("Redis unavailable"),
            }),
          ),
          isOutputReplayEligible: () => true,
        },
      ),
    );

    expect(recovered).toMatchObject({ resumed: 0, terminalized: 0 });
    expect(recovered.uncertainties).toHaveLength(1);
    expect(resumes).toBe(0);
    expect(value(store.load(requestDeliveryId)).state).toBe("accepted");
    expect((await blobs.open(reference)).status).toBe("ok");
    store.close();
    await blobs.close({ deadlineAtMs: Date.now() + 1_000 });
  });
});
