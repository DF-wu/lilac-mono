import { describe, expect, it, spyOn } from "bun:test";

import { BlobInvalidReference, type BlobHandleV1 } from "@stanley2058/lilac-blob-storage";
import { Logger } from "@stanley2058/simple-module-logger";
import { Result } from "better-result";

import {
  DiscordRequestDeliveryFailed,
  DiscordRequestPublishAndCleanupFailed,
  publishBusRequest,
  type DiscordRequestDeliveryPort,
} from "../../../src/surface/discord/discord-request-router/publish";
import { getTestBlobStore } from "../../helpers/blob-store";

describe("Discord prepared request publication", () => {
  it("validates the envelope and derives pending input handles before delivery", async () => {
    const requestDeliveryId = crypto.randomUUID();
    const handle: BlobHandleV1 = {
      version: 1,
      objectId: "b1_0123456789abcdef0123456789abcdef",
    };
    const delivered = Promise.withResolvers<void>();
    const requestDelivery: DiscordRequestDeliveryPort = {
      async prepareAndPublish(input) {
        expect(input.requestDeliveryId).toBe(requestDeliveryId);
        expect(input.requestId).toBe("request-1");
        expect(input.envelope.data.requestDeliveryId).toBe(requestDeliveryId);
        expect(input.envelope.headers).toEqual({
          request_id: "request-1",
          session_id: "session-1",
          request_client: "discord",
        });
        expect(input.inputHandles).toEqual([handle]);
        delivered.resolve();
        return Result.ok(undefined);
      },
    };

    const published = await publishBusRequest({
      logger: new Logger({ module: "discord-request-publish-test" }),
      blobStore: await getTestBlobStore(),
      requestDelivery,
      input: {
        requestDeliveryId,
        requestId: "request-1",
        sessionId: "session-1",
        sessionConfigId: "config-1",
        queue: "prompt",
        triggerType: "mention",
        sessionMode: "mention",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "inspect" },
              {
                type: "blob",
                blob: handle,
                mediaType: "text/plain",
                filename: "input.txt",
              },
            ],
          },
        ],
        inputHandles: [handle],
        corePrimaryLineage: {
          state: "fresh-only",
          lineageVersion: 2,
          currentCanonicalStart: 0,
          reason: "test",
        },
        raw: {},
      },
    });

    expect(published.status).toBe("ok");
    await delivered.promise;
  });

  it("returns a typed failure when the prepared envelope is invalid", async () => {
    let called = false;
    const requestDelivery: DiscordRequestDeliveryPort = {
      async prepareAndPublish() {
        called = true;
        return Result.ok(undefined);
      },
    };

    const blobStore = await getTestBlobStore();
    const handle: BlobHandleV1 = {
      version: 1,
      objectId: "b1_fedcba9876543210fedcba9876543210",
    };
    const deleted: BlobHandleV1[] = [];
    const originalDelete = blobStore.delete.bind(blobStore);
    const deleteBlob = spyOn(blobStore, "delete").mockImplementation(async (target) => {
      if (!("sha256" in target)) deleted.push(target);
      return originalDelete(target);
    });

    const published = await publishBusRequest({
      logger: new Logger({ module: "discord-request-publish-test" }),
      blobStore,
      requestDelivery,
      input: {
        requestDeliveryId: "not-a-uuid",
        requestId: "request-1",
        sessionId: "session-1",
        sessionConfigId: "config-1",
        queue: "prompt",
        triggerType: "mention",
        sessionMode: "mention",
        messages: [
          {
            role: "user",
            content: [{ type: "blob", blob: handle, mediaType: "text/plain" }],
          },
        ],
        inputHandles: [handle],
        corePrimaryLineage: {
          state: "fresh-only",
          lineageVersion: 2,
          currentCanonicalStart: 0,
          reason: "test",
        },
        raw: {},
      },
    });

    expect(called).toBe(false);
    expect(deleted).toEqual([handle]);
    expect(published.status).toBe("error");
    if (published.status === "error") {
      expect(published.error).toBeInstanceOf(DiscordRequestDeliveryFailed);
    }
    deleteBlob.mockRestore();
  });

  it("reports both envelope validation and request-handle cleanup failures", async () => {
    const blobStore = await getTestBlobStore();
    const handle: BlobHandleV1 = {
      version: 1,
      objectId: "b1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const cleanupFailure = new BlobInvalidReference({
      issues: ["forced cleanup failure"],
      message: "forced cleanup failure",
    });
    const deleteBlob = spyOn(blobStore, "delete").mockResolvedValue(Result.err(cleanupFailure));

    const published = await publishBusRequest({
      logger: new Logger({ module: "discord-request-publish-test" }),
      blobStore,
      requestDelivery: {
        async prepareAndPublish() {
          return Result.ok(undefined);
        },
      },
      input: {
        requestDeliveryId: "not-a-uuid",
        requestId: "request-1",
        sessionId: "session-1",
        sessionConfigId: "config-1",
        queue: "prompt",
        triggerType: "mention",
        sessionMode: "mention",
        messages: [
          {
            role: "user",
            content: [{ type: "blob", blob: handle, mediaType: "text/plain" }],
          },
        ],
        inputHandles: [handle],
        corePrimaryLineage: {
          state: "fresh-only",
          lineageVersion: 2,
          currentCanonicalStart: 0,
          reason: "test",
        },
        raw: {},
      },
    });

    expect(published.status).toBe("error");
    if (published.status === "error") {
      expect(published.error).toBeInstanceOf(DiscordRequestPublishAndCleanupFailed);
      if (DiscordRequestPublishAndCleanupFailed.is(published.error)) {
        expect(published.error.primary).toBeInstanceOf(DiscordRequestDeliveryFailed);
        expect(published.error.cleanup.failures).toEqual([cleanupFailure]);
      }
    }
    deleteBlob.mockRestore();
  });

  it("preserves request handles when durable publication returns an ambiguous failure", async () => {
    const blobStore = await getTestBlobStore();
    const handle: BlobHandleV1 = {
      version: 1,
      objectId: "b1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const deleteBlob = spyOn(blobStore, "delete");
    const publicationFailure = new DiscordRequestDeliveryFailed({
      message: "durable publication outcome is ambiguous",
    });

    const published = await publishBusRequest({
      logger: new Logger({ module: "discord-request-publish-test" }),
      blobStore,
      requestDelivery: {
        async prepareAndPublish() {
          return Result.err(publicationFailure);
        },
      },
      input: {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "request-1",
        sessionId: "session-1",
        sessionConfigId: "config-1",
        queue: "prompt",
        triggerType: "mention",
        sessionMode: "mention",
        messages: [
          {
            role: "user",
            content: [{ type: "blob", blob: handle, mediaType: "text/plain" }],
          },
        ],
        inputHandles: [handle],
        corePrimaryLineage: {
          state: "fresh-only",
          lineageVersion: 2,
          currentCanonicalStart: 0,
          reason: "test",
        },
        raw: {},
      },
    });

    expect(published).toEqual(Result.err(publicationFailure));
    expect(deleteBlob).not.toHaveBeenCalled();
    deleteBlob.mockRestore();
  });
});
