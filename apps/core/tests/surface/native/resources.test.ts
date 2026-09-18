import { nativeFailure } from "../../../src/surface/native/errors";
import { describe, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createMemoryBlobStore } from "@stanley2058/lilac-blob-storage";
import { Result, type Result as ResultType } from "better-result";
import { NativeStore } from "../../../src/surface/native/store";
import {
  NativeResourceService,
  NativeUploadSettlementFailed,
} from "../../../src/surface/native/resources";
import { SqliteTranscriptStore } from "../../../src/transcript/transcript-store";
import { CoreResourceService, consumeVerifiedResourceRead } from "../../../src/resource/service";
import { ResourceOriginAdapterRegistry } from "../../../src/resource/origin";

function value<T, E>(result: ResultType<T, E>): T {
  return result.match({
    ok: (item) => item,
    err: (error) => {
      throw error;
    },
  });
}

async function fixture() {
  const native = new NativeStore(new Database(":memory:"));
  value(native.initialize());
  for (const [id, role] of [
    ["owner", "owner"],
    ["alice", "participant"],
    ["bob", "participant"],
  ] as const)
    value(native.upsertUser({ id, role, providerId: id, displayName: id, toolMode: "full" }));
  const thread = value(native.createThread("alice", { commandId: "thread" }));
  value(native.shareThread("owner", { threadId: thread.id, userId: "bob", grant: "read" }));
  const resources = new SqliteTranscriptStore(":memory:");
  const blobs = value(await createMemoryBlobStore());
  const access = new CoreResourceService({
    store: resources,
    blobStore: blobs,
    originAdapters: new ResourceOriginAdapterRegistry([]),
  });
  let clock = Date.now();
  const progress: number[] = [];
  const service = new NativeResourceService({
    native,
    resources,
    access,
    blobs,
    now: () => clock++,
    onProgress: (event) => progress.push(event.transferred),
  });
  const bytes = new TextEncoder().encode("hello world");
  const reserve = () =>
    value(
      service.reserve("alice", {
        threadId: thread.id,
        filename: "notes.txt",
        mediaType: "text/plain",
        size: bytes.byteLength,
      }),
    );
  const source = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  const publish = (id: string) =>
    value(
      native.acceptInput("alice", {
        threadId: thread.id,
        commandId: crypto.randomUUID(),
        historyGeneration: 0,
        mode: "prompt",
        text: "inspect",
        attachmentIds: [id],
        skillIds: [],
      }),
    );
  return {
    native,
    thread,
    resources,
    blobs,
    access,
    service,
    reserve,
    source,
    bytes,
    publish,
    progress,
  };
}

describe("native resources", () => {
  test("physical thread cleanup releases orphaned native resource ownership", async () => {
    const f = await fixture();
    const ready = value(await f.service.upload("alice", f.reserve().id, f.source()));
    f.publish(ready.id);
    const deletion = value(
      f.native.deleteThread("alice", { threadId: f.thread.id, commandId: "delete-upload-origin" }),
    );
    value(f.native.finishMutation(f.thread.id, deletion.historyGeneration!));
    expect(f.native.getUpload(ready.id).status).toBe("error");
    expect(value(f.service.reconcileReferences())).toBe(1);
    expect(value(f.resources.listNativeResourceReferences())).toEqual([]);
    expect(value(await f.access.maintain({ limit: 10 })).deleted).toBe(1);
  });

  test("reports both upload and failed-state persistence errors", async () => {
    const f = await fixture();
    const upload = f.reserve();
    const storageFailure = nativeFailure("sqlite", "Failed-state write failed");
    const settle = spyOn(f.native, "settleUpload").mockReturnValue(Result.err(storageFailure));
    const short = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const result = await f.service.upload("alice", upload.id, short);
    settle.mockRestore();
    const error = result.match({ ok: () => null, err: (failure) => failure });
    expect(error).toBeInstanceOf(NativeUploadSettlementFailed);
    if (!(error instanceof NativeUploadSettlementFailed))
      throw new Error("Expected settlement failure");
    expect(error.uploadFailure).toMatchObject({ code: "invalid" });
    expect(error.settlementFailure).toBe(storageFailure);
  });

  test("shutdown aborts transfers and waits for cancellation and state persistence", async () => {
    const f = await fixture();
    const upload = f.reserve();
    const cancelStarted = Promise.withResolvers<void>();
    const releaseCancel = Promise.withResolvers<void>();
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted.resolve();
        return releaseCancel.promise;
      },
    });
    const uploading = f.service.upload("alice", upload.id, source);
    let stopped = false;
    const stopping = f.service.stop().then((result) => {
      stopped = true;
      return result;
    });
    await cancelStarted.promise;
    expect(stopped).toBe(false);
    releaseCancel.resolve();
    value(await stopping);
    expect((await uploading).status).toBe("error");
    expect(value(f.native.getUpload(upload.id)).state).toBe("failed");
    expect((await f.service.upload("alice", upload.id, f.source())).status).toBe("error");
  });

  test("shutdown propagates failed-state persistence failures", async () => {
    const f = await fixture();
    const upload = f.reserve();
    const settle = spyOn(f.native, "settleUpload").mockReturnValue(
      Result.err(nativeFailure("sqlite", "State unavailable")),
    );
    const uploading = f.service.upload("alice", upload.id, new ReadableStream<Uint8Array>());
    const result = await f.service.stop();
    expect(result.match({ ok: () => null, err: (error) => error._tag })).toBe(
      "NativeUploadSettlementFailed",
    );
    expect((await uploading).status).toBe("error");
    settle.mockRestore();
  });

  test("thread deletion fences an in-flight upload before bytes can be published", async () => {
    const f = await fixture();
    const upload = f.reserve();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const source = new ReadableStream<Uint8Array>({
      async start(controller) {
        started.resolve();
        await finish.promise;
        controller.enqueue(f.bytes);
        controller.close();
      },
    });
    const pending = f.service.upload("alice", upload.id, source);
    await started.promise;
    value(f.native.deleteThread("alice", { threadId: f.thread.id, commandId: "delete" }));
    finish.resolve();
    expect((await pending).status).toBe("error");
    expect(value(f.resources.listNativeResourceReferences())).toEqual([]);
    expect(value(f.native.getUpload(upload.id)).resourceUri).toBeUndefined();
  });

  test("completed PUT retries return the same resource without replacing bytes", async () => {
    const f = await fixture();
    const upload = f.reserve();
    const first = value(await f.service.upload("alice", upload.id, f.source()));
    const second = value(await f.service.upload("alice", upload.id, f.source()));
    expect(second.resourceUri).toBe(first.resourceUri);
    expect(value(f.resources.listNativeResourceReferences())).toHaveLength(1);
  });

  test("upload verifies bytes and preserves origin authority before and after publication", async () => {
    const f = await fixture();
    const reserved = f.reserve();
    expect(f.service.get("bob", reserved.id).status).toBe("error");
    const ready = value(await f.service.upload("alice", reserved.id, f.source()));
    expect(ready.state).toBe("ready");
    expect(f.service.authorize("bob", ready.resourceUri!).status).toBe("error");
    expect(value(f.service.authorize("owner", ready.resourceUri!)).origin).toMatchObject({
      threadId: f.thread.id,
      uploaderId: "alice",
    });
    f.publish(ready.id);
    expect(
      new TextDecoder().decode(
        value(
          await consumeVerifiedResourceRead(value(await f.service.open("bob", ready.resourceUri!))),
        ),
      ),
    ).toBe("hello world");
    value(f.native.shareThread("owner", { threadId: f.thread.id, userId: "bob", grant: null }));
    expect(
      (await f.service.scopedAccess("bob").open(ready.resourceUri!, { maxBytes: 100 })).status,
    ).toBe("error");
    expect(f.progress).toEqual([11]);
    expect(value(f.resources.listUnretained({ limit: 100 }))).toEqual([]);
  });

  test("sending while uploading publishes pending state and does not admit partial bytes", async () => {
    const f = await fixture();
    const reserved = f.reserve();
    const receipt = f.publish(reserved.id);
    expect(receipt.state).toBe("uploading");
    expect(value(f.native.prepareInput(receipt.inputId))).toBeNull();
    const ready = value(await f.service.upload("alice", reserved.id, f.source()));
    expect(ready.state).toBe("ready");
    expect(value(f.native.prepareInput(receipt.inputId))?.state).toBe("queued");
  });

  test("rejects foreign handle, oversize and truncated content without resource publication", async () => {
    const f = await fixture();
    const reserved = f.reserve();
    expect((await f.service.upload("bob", reserved.id, f.source())).status).toBe("error");
    const short = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
        controller.close();
      },
    });
    expect((await f.service.upload("alice", reserved.id, short)).status).toBe("error");
    expect(value(f.native.getUpload(reserved.id)).state).toBe("failed");
    expect(value(await f.service.upload("alice", reserved.id, f.source())).state).toBe("ready");
    const huge = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(12));
        controller.close();
      },
    });
    expect((await f.service.upload("alice", f.reserve().id, huge)).status).toBe("error");
  });

  test("HTTP preview supports bounded ranges and forces unsafe media to download", async () => {
    const f = await fixture();
    const reserved = f.reserve();
    value(await f.service.upload("alice", reserved.id, f.source()));
    f.publish(reserved.id);
    const response = (await f.service.handle(
      new Request(`http://local/api/resources/${reserved.id}`, { headers: { range: "bytes=1-4" } }),
      "bob",
    ))!;
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-4/11");
    expect(await response.text()).toBe("ello");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const invalid = (await f.service.handle(
      new Request(`http://local/api/resources/${reserved.id}`, { headers: { range: "bytes=99-" } }),
      "bob",
    ))!;
    expect(invalid.status).toBe(416);
  });

  test("native ownership cannot reparent resources and release permits existing maintenance", async () => {
    const f = await fixture();
    const upload = value(await f.service.upload("alice", f.reserve().id, f.source()));
    const record = value(f.service.authorize("alice", upload.resourceUri!));
    expect(
      f.resources.retainNativeResource({
        uploadId: upload.id,
        threadId: "different",
        resourceId: record.resourceId,
      }).status,
    ).toBe("error");
    value(f.resources.releaseNativeResource(upload.id));
    expect(value(f.resources.getRetained(record.resourceId))).toBeNull();
    expect(value(await f.access.maintain({ limit: 10 })).deleted).toBe(1);
  });
});
