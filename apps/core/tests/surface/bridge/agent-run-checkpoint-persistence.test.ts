import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelMessage } from "ai";
import { createMemoryBlobStore, type BlobRefV1 } from "@stanley2058/lilac-blob-storage";
import type { StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";

import { persistBlobBackedAgentRunCheckpoint } from "../../../src/surface/bridge/agent-run-checkpoint-persistence";
import {
  AgentRunJournalConflict,
  SqliteAgentRunJournal,
} from "../../../src/surface/bridge/agent-run-journal";
import {
  createStoredMessageIdentityProjectionV1,
  materializeStoredMessagesV1,
} from "../../../src/transcript/stored-message-materialization";
import {
  CoreOwnedBlobIntegrityError,
  SqliteTranscriptStore,
} from "../../../src/transcript/transcript-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

function localImageRead(input: {
  readonly toolCallId: string;
  readonly path: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly toolName?: string;
}): ModelMessage[] {
  const toolName = input.toolName ?? "read";
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: input.toolCallId,
          toolName,
          input: { path: input.path },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: input.toolCallId,
          toolName,
          output: {
            type: "content",
            value: [
              { type: "text", text: `Attached file from read: ${input.filename}` },
              {
                type: "file",
                data: { type: "data", data: Buffer.from(input.bytes).toString("base64") },
                mediaType: "image/png",
                filename: input.filename,
              },
            ],
          },
        },
      ],
    },
  ];
}

function storedBlobs(messages: readonly StoredMessageV1[]): BlobRefV1[] {
  return messages.flatMap((message) => {
    if (typeof message.content === "string") return [];
    return message.content.flatMap((part) => {
      if (part.type === "blob") return [part.blob];
      if (part.type !== "tool-result" || part.output.type !== "content") return [];
      return part.output.value.flatMap((output) => (output.type === "blob" ? [output.blob] : []));
    });
  });
}

async function checkpointFixture() {
  const directory = await mkdtemp(join(tmpdir(), "lilac-agent-run-checkpoint-blobs-"));
  directories.push(directory);
  const transcriptDbPath = join(directory, "transcripts.db");
  const journalDbPath = join(directory, "request-delivery.db");
  const blobStore = resultValue(await createMemoryBlobStore());
  const transcriptStore = new SqliteTranscriptStore(transcriptDbPath);
  const owner = {
    requestDeliveryId: "11111111-1111-4111-8111-111111111111",
    requestId: "request-1",
    sessionId: "session-1",
  };
  const requestDeliveryDatabase = new Database(journalDbPath);
  requestDeliveryDatabase.run(`
    CREATE TABLE request_delivery_records (
      request_delivery_id TEXT PRIMARY KEY NOT NULL,
      request_id TEXT NOT NULL,
      state TEXT NOT NULL
    ) STRICT
  `);
  requestDeliveryDatabase.run(
    `INSERT INTO request_delivery_records (request_delivery_id, request_id, state)
     VALUES (?, ?, 'accepted')`,
    [owner.requestDeliveryId, owner.requestId],
  );
  requestDeliveryDatabase.close();
  const journal = new SqliteAgentRunJournal({ dbPath: journalDbPath });
  return {
    transcriptDbPath,
    blobStore,
    transcriptStore,
    owner,
    journal,
    identityProjection: createStoredMessageIdentityProjectionV1(),
  };
}

describe("blob-backed agent run checkpoints", () => {
  it("uploads local reads and keeps every blob reachable from the cumulative checkpoint", async () => {
    const { transcriptDbPath, blobStore, transcriptStore, owner, journal, identityProjection } =
      await checkpointFixture();
    let handle = resultValue(journal.openRun(owner));
    const image1Bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1]);
    const image1 = localImageRead({
      toolCallId: "read-image-1",
      path: "/tmp/image1.png",
      filename: "image1.png",
      bytes: image1Bytes,
    });
    const first = resultValue(
      await persistBlobBackedAgentRunCheckpoint({
        handle,
        journal,
        messages: structuredClone(image1),
        identityProjection,
        blobStore,
        transcriptStore,
        retainedRequestDeliveries: [],
      }),
    );
    handle = first.handle;

    const image2Bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 2]);
    const image2 = localImageRead({
      toolCallId: "read-image-2",
      path: "/tmp/image2.png",
      filename: "image2.png",
      bytes: image2Bytes,
    });
    const second = resultValue(
      await persistBlobBackedAgentRunCheckpoint({
        handle,
        journal,
        messages: structuredClone([...image1, ...image2]),
        previousCheckpoint: {
          providerMessages: image1,
          storedMessages: first.messages,
        },
        identityProjection,
        blobStore,
        transcriptStore,
        retainedRequestDeliveries: [],
      }),
    );
    expect(second.cleanupError).toBeUndefined();
    expect(second.advanced).toBe(true);
    expect(second.messages.slice(0, image1.length)).toEqual([...first.messages]);

    const repeated = resultValue(
      await persistBlobBackedAgentRunCheckpoint({
        handle: second.handle,
        journal,
        messages: structuredClone([...image1, ...image2]),
        previousCheckpoint: {
          providerMessages: [...image1, ...image2],
          storedMessages: second.messages,
        },
        retainedPredecessorMessages: first.messages,
        identityProjection,
        blobStore,
        transcriptStore,
        retainedRequestDeliveries: [],
      }),
    );
    expect(repeated.advanced).toBe(false);

    const loaded = resultValue(journal.loadRecoveryHeads());
    expect(loaded.heads).toHaveLength(1);
    const checkpoint = loaded.heads[0]?.checkpoint;
    expect(checkpoint).toBeDefined();
    expect([...(loaded.heads[0]?.previousCheckpoint?.messages ?? [])]).toEqual([...first.messages]);
    expect(JSON.stringify(checkpoint)).not.toContain(Buffer.from(image1Bytes).toString("base64"));
    expect(JSON.stringify(checkpoint)).not.toContain(Buffer.from(image2Bytes).toString("base64"));
    const replayed = resultValue(
      await materializeStoredMessagesV1({
        messages: checkpoint!.messages,
        blobStore,
      }),
    );
    expect(replayed).toEqual([...image1, ...image2]);

    const latestBlobs = storedBlobs(checkpoint!.messages);
    const previousBlobs = new Set(
      storedBlobs(loaded.heads[0]?.previousCheckpoint?.messages ?? []).map((blob) => blob.objectId),
    );
    const latestOnlyBlob = latestBlobs.find((blob) => !previousBlobs.has(blob.objectId));
    expect(latestOnlyBlob).toBeDefined();
    resultValue(await blobStore.delete(latestOnlyBlob!));
    expect(
      (
        await materializeStoredMessagesV1({
          messages: checkpoint!.messages,
          blobStore,
        })
      ).match({ ok: () => "ok", err: () => "error" }),
    ).toBe("error");
    expect(
      resultValue(
        await materializeStoredMessagesV1({
          messages: loaded.heads[0]!.previousCheckpoint!.messages,
          blobStore,
        }),
      ),
    ).toEqual(image1);

    const inspection = new Database(transcriptDbPath);
    expect(
      inspection
        .query(
          `SELECT request_delivery_id, blob_owner_id
           FROM core_agent_run_checkpoint_blobs
           ORDER BY blob_owner_id`,
        )
        .all(),
    ).toHaveLength(2);
    inspection.close();

    journal.close();
    transcriptStore.close();
    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });

  it("keeps the previous checkpoint across projection, pin, write, and cleanup failures", async () => {
    const { transcriptDbPath, blobStore, transcriptStore, owner, journal, identityProjection } =
      await checkpointFixture();
    let handle = resultValue(journal.openRun(owner));
    const image1 = localImageRead({
      toolCallId: "read-image-1",
      path: "/tmp/image1.png",
      filename: "image1.png",
      bytes: Uint8Array.from([1]),
    });
    const first = resultValue(
      await persistBlobBackedAgentRunCheckpoint({
        handle,
        journal,
        messages: image1,
        identityProjection,
        blobStore,
        transcriptStore,
        retainedRequestDeliveries: [],
      }),
    );
    handle = first.handle;

    const nonReadBinary = localImageRead({
      toolCallId: "download-image",
      toolName: "download",
      path: "/tmp/download.png",
      filename: "download.png",
      bytes: Uint8Array.from([2]),
    });
    const rejectedProjection = await persistBlobBackedAgentRunCheckpoint({
      handle,
      journal,
      messages: [...image1, ...nonReadBinary],
      previousCheckpoint: { providerMessages: image1, storedMessages: first.messages },
      identityProjection,
      blobStore,
      transcriptStore,
      retainedRequestDeliveries: [],
    });
    expect(rejectedProjection.match({ ok: () => null, err: (error) => error._tag })).toBe(
      "AgentRunCheckpointPreparationFailed",
    );
    expect(resultValue(journal.loadRecoveryHeads()).heads[0]?.checkpoint?.messages).toEqual([
      ...first.messages,
    ]);

    const image2 = localImageRead({
      toolCallId: "read-image-2",
      path: "/tmp/image2.png",
      filename: "image2.png",
      bytes: Uint8Array.from([3]),
    });
    const originalRetain = transcriptStore.retainAgentRunCheckpointBlobs;
    transcriptStore.retainAgentRunCheckpointBlobs = () =>
      Result.err(new CoreOwnedBlobIntegrityError("checkpoint pin failed"));
    const rejectedPin = await persistBlobBackedAgentRunCheckpoint({
      handle,
      journal,
      messages: [...image1, ...image2],
      previousCheckpoint: { providerMessages: image1, storedMessages: first.messages },
      identityProjection,
      blobStore,
      transcriptStore,
      retainedRequestDeliveries: [],
    });
    transcriptStore.retainAgentRunCheckpointBlobs = originalRetain;
    expect(rejectedPin.match({ ok: () => null, err: (error) => error._tag })).toBe(
      "AgentRunCheckpointPreparationFailed",
    );
    expect(resultValue(journal.loadRecoveryHeads()).heads[0]?.handle).toEqual(handle);

    const rejectedWrite = await persistBlobBackedAgentRunCheckpoint({
      handle,
      journal: {
        writeCheckpoint: () =>
          Result.err(
            new AgentRunJournalConflict({
              runId: owner.requestDeliveryId,
              message: "controlled checkpoint conflict",
            }),
          ),
      },
      messages: [...image1, ...image2],
      previousCheckpoint: { providerMessages: image1, storedMessages: first.messages },
      identityProjection,
      blobStore,
      transcriptStore,
      retainedRequestDeliveries: [],
    });
    expect(rejectedWrite.match({ ok: () => null, err: (error) => error._tag })).toBe(
      "AgentRunJournalConflict",
    );
    expect(resultValue(journal.loadRecoveryHeads()).heads[0]?.handle).toEqual(handle);
    const inspection = new Database(transcriptDbPath, { readonly: true });
    expect(
      inspection
        .query(
          `SELECT blob_owner_id
           FROM core_agent_run_checkpoint_blobs
           WHERE request_delivery_id = ?
           ORDER BY blob_owner_id`,
        )
        .all(owner.requestDeliveryId),
    ).toEqual(storedBlobs(first.messages).map((blob) => ({ blob_owner_id: blob.objectId })));
    inspection.close();

    const originalReplace = transcriptStore.replaceAgentRunCheckpointBlobs;
    transcriptStore.replaceAgentRunCheckpointBlobs = () =>
      Result.err(new CoreOwnedBlobIntegrityError("checkpoint cleanup failed"));
    const rejectedWriteAndRollback = await persistBlobBackedAgentRunCheckpoint({
      handle,
      journal: {
        writeCheckpoint: () =>
          Result.err(
            new AgentRunJournalConflict({
              runId: owner.requestDeliveryId,
              message: "controlled checkpoint conflict",
            }),
          ),
      },
      messages: [...image1, ...image2],
      previousCheckpoint: { providerMessages: image1, storedMessages: first.messages },
      identityProjection,
      blobStore,
      transcriptStore,
      retainedRequestDeliveries: [],
    });
    expect(rejectedWriteAndRollback.match({ ok: () => null, err: (error) => error._tag })).toBe(
      "AgentRunCheckpointOwnershipRollbackFailed",
    );
    const cleanupDeferred = resultValue(
      await persistBlobBackedAgentRunCheckpoint({
        handle,
        journal,
        messages: [...image1, ...image2],
        previousCheckpoint: { providerMessages: image1, storedMessages: first.messages },
        identityProjection,
        blobStore,
        transcriptStore,
        retainedRequestDeliveries: [],
      }),
    );
    transcriptStore.replaceAgentRunCheckpointBlobs = originalReplace;
    expect(cleanupDeferred.cleanupError?.name).toBe("CoreOwnedBlobIntegrityError");
    const latest = resultValue(journal.loadRecoveryHeads()).heads[0]?.checkpoint;
    expect(latest).toBeDefined();
    expect(
      resultValue(await materializeStoredMessagesV1({ messages: latest!.messages, blobStore })),
    ).toEqual([...image1, ...image2]);

    journal.close();
    transcriptStore.close();
    resultValue(await blobStore.close({ deadlineAtMs: Date.now() + 1_000 }));
  });
});
