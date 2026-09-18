import type { NativeRPC } from "@stanley2058/lilac-client";
import type { AppProps, Attachment } from "./types";
import { attempt } from "./components/ui";

const empty: readonly Attachment[] = [];
export class UploadPool {
  private readonly threads = new Map<string, readonly Attachment[]>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly lifetime = new AbortController();
  private readonly transfers = new Map<string, AbortController>();
  private readonly released = new Set<string>();
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }
  constructor(
    private readonly client: {
      readonly rpc: { resources: Pick<NativeRPC["resources"], "reserve"> } | undefined;
    },
    private readonly upload: AppProps["upload"],
  ) {}
  get(threadId: string): readonly Attachment[] {
    return this.threads.get(threadId) ?? empty;
  }
  subscribe(threadId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
    };
  }
  private update(threadId: string, key: string, change: Partial<Attachment>) {
    if (this.signal.aborted || !this.get(threadId).some((item) => item.key === key)) return;
    this.threads.set(
      threadId,
      this.get(threadId).map((item) => (item.key === key ? { ...item, ...change } : item)),
    );
    for (const listener of this.listeners.get(threadId) ?? []) listener();
  }
  add(threadId: string, file: File): string {
    const key = crypto.randomUUID();
    if (this.signal.aborted) return key;
    this.transfers.set(key, new AbortController());
    const pending = Promise.withResolvers<string | undefined>();
    const attachment: Attachment = {
      key,
      file,
      reservation: pending.promise,
      progress: 0,
      state: "reserving",
      ...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}),
    };
    this.threads.set(threadId, [...this.get(threadId), attachment]);
    for (const listener of this.listeners.get(threadId) ?? []) listener();
    void this.reserve(threadId, attachment, pending.resolve);
    return key;
  }
  private async reserve(
    threadId: string,
    attachment: Attachment,
    resolve: (id: string | undefined) => void,
  ) {
    const signal = this.attachmentSignal(attachment.key);
    const rpc = this.client.rpc;
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    if (!rpc) {
      this.update(threadId, attachment.key, {
        state: "failed",
        error: "Connect to upload this file",
      });
      resolve(undefined);
      return;
    }
    const resource = await attempt(
      () =>
        rpc.resources.reserve(
          {
            threadId,
            commandId: attachment.key,
            name: attachment.file.name,
            size: attachment.file.size,
            mediaType: attachment.file.type || "application/octet-stream",
          },
          { signal },
        ),
      (error) => this.update(threadId, attachment.key, { state: "failed", error }),
    );
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    resolve(resource?.id);
    if (!resource) return;
    this.update(threadId, attachment.key, { resourceId: resource.id, state: "uploading" });
    await this.transfer(threadId, attachment.key, resource.id, attachment.file);
  }
  private async transfer(threadId: string, key: string, resourceId: string, file: File) {
    const signal = this.attachmentSignal(key);
    if (signal.aborted) return;
    const outcome = await attempt(
      async () => {
        await this.upload(
          resourceId,
          file,
          (progress) => this.update(threadId, key, { progress }),
          signal,
        );
        return true;
      },
      (error) => this.update(threadId, key, { state: "failed", error }),
    );
    if (outcome) this.update(threadId, key, { state: "ready", progress: 1, error: undefined });
    if (this.released.has(key)) this.remove(threadId, key);
  }
  retry(threadId: string, key: string) {
    const item = this.get(threadId).find((entry) => entry.key === key);
    if (!item || item.state !== "failed" || this.signal.aborted) return;
    this.update(threadId, key, {
      state: item.resourceId ? "uploading" : "reserving",
      error: undefined,
    });
    if (item.resourceId) {
      void this.transfer(threadId, key, item.resourceId, item.file);
      return;
    }
    const pending = Promise.withResolvers<string | undefined>();
    this.update(threadId, key, { reservation: pending.promise });
    void this.reserve(threadId, item, pending.resolve);
  }
  private attachmentSignal(key: string): AbortSignal {
    const controller = this.transfers.get(key);
    return controller ? AbortSignal.any([this.signal, controller.signal]) : AbortSignal.abort();
  }
  release(threadId: string, key: string) {
    const item = this.get(threadId).find((entry) => entry.key === key);
    if (!item) return;
    if (item.state === "ready" || item.state === "failed") {
      this.remove(threadId, key);
      return;
    }
    this.released.add(key);
  }
  remove(threadId: string, key: string) {
    const entries = this.get(threadId);
    const item = entries.find((entry) => entry.key === key);
    this.transfers.get(key)?.abort();
    this.transfers.delete(key);
    this.released.delete(key);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    const remaining = entries.filter((entry) => entry.key !== key);
    if (remaining.length) this.threads.set(threadId, remaining);
    else this.threads.delete(threadId);
    for (const listener of this.listeners.get(threadId) ?? []) listener();
  }
  dispose() {
    this.lifetime.abort();
    this.transfers.clear();
    this.released.clear();
    for (const entries of this.threads.values())
      for (const item of entries) if (item.preview) URL.revokeObjectURL(item.preview);
    this.threads.clear();
    this.listeners.clear();
  }
}

export async function resolveAttachmentIds(
  pool: Pick<UploadPool, "get" | "retry">,
  threadId: string,
  attachments: readonly Attachment[],
  retryFailed: boolean,
): Promise<(string | undefined)[]> {
  if (retryFailed) {
    for (const attachment of attachments) {
      const current = pool.get(threadId).find((item) => item.key === attachment.key);
      if (current?.state === "failed") pool.retry(threadId, current.key);
    }
  }
  return Promise.all(
    attachments.map(
      (attachment) =>
        (pool.get(threadId).find((current) => current.key === attachment.key) ?? attachment)
          .reservation,
    ),
  );
}
