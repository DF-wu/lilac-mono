import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import type { ConversationThreadRepairKind } from "./thread-store";

const DEFAULT_DEBOUNCE_MS = 100;

export type ThreadMaterializerScheduler = (task: () => void, delayMs: number) => () => void;

export type ThreadMaterializerErrorContext =
  | { operation: "list-channels" }
  | {
      operation: "repair-channel";
      channelId: string;
      kind: ConversationThreadRepairKind;
    };

export class ThreadMaterializerOperationFailed extends TaggedError(
  "ThreadMaterializerOperationFailed",
)<{
  readonly operation: "list-channels" | "repair-channel" | "worker-protocol" | "worker-stopped";
  readonly message: string;
}> {}

export type ThreadMaterializer = {
  markDirty(
    input:
      | { channelId: string; kind: "topology" }
      | { channelId: string; kind: "content"; messageId: string },
  ): void;
  markAllDirty(): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
};

type DirtyChannel = {
  kind: ConversationThreadRepairKind;
  messageIds: ReadonlySet<string>;
};

function defaultScheduler(task: () => void, delayMs: number): () => void {
  const timer = setTimeout(task, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

async function captureMaterializerOperation<T>(
  run: () => Promise<T>,
): Promise<ResultType<T, ThreadMaterializerOperationFailed>> {
  const [settled] = await Promise.allSettled([run()]);
  if (settled.status === "fulfilled") return Result.ok(settled.value);
  if (ThreadMaterializerOperationFailed.is(settled.reason)) return Result.err(settled.reason);
  if (settled.reason instanceof Error) return adaptToolResultToHost(Result.err(settled.reason));
  return adaptToolResultToHost(
    Result.err(
      new Panic({ message: "Conversation thread materializer defect", cause: settled.reason }),
    ),
  );
}

export function createThreadMaterializer(params: {
  repairChannel: (
    input:
      | { channelId: string; kind: "topology" }
      | { channelId: string; kind: "content"; messageIds: readonly string[] },
  ) => Promise<void>;
  listChannelIds: () => Promise<readonly string[]>;
  debounceMs?: number;
  schedule?: ThreadMaterializerScheduler;
  onError?: (error: Error, context: ThreadMaterializerErrorContext) => void;
}): ThreadMaterializer {
  const debounceMs = params.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const schedule = params.schedule ?? defaultScheduler;
  const dirtyChannels = new Map<string, DirtyChannel>();
  const listingTasks = new Set<Promise<void>>();
  let accepting = true;
  let cancelScheduledDrain: (() => void) | null = null;
  let drainPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const reportError = (error: Error, context: ThreadMaterializerErrorContext) => {
    params.onError?.(error, context);
  };

  const cancelDebounce = () => {
    cancelScheduledDrain?.();
    cancelScheduledDrain = null;
  };

  const drain = async () => {
    while (dirtyChannels.size > 0) {
      const first = dirtyChannels.entries().next();
      if (first.done) return;

      const [channelId, repair] = first.value;
      dirtyChannels.delete(channelId);
      const repaired = await captureMaterializerOperation(() =>
        params.repairChannel(
          repair.kind === "topology"
            ? { channelId, kind: "topology" }
            : { channelId, kind: "content", messageIds: [...repair.messageIds] },
        ),
      );
      if (repaired.status === "error") {
        reportError(repaired.error, {
          operation: "repair-channel",
          channelId,
          kind: repair.kind,
        });
      }
    }
  };

  const startDrain = (): Promise<void> => {
    cancelDebounce();
    if (drainPromise) return drainPromise;

    const running = drain();
    drainPromise = running;
    void Promise.allSettled([running]).then(([settled]) => {
      if (settled?.status === "fulfilled") {
        if (drainPromise !== running) return;
        drainPromise = null;
        if (dirtyChannels.size > 0) scheduleDrain();
      }
    });
    return running;
  };

  function scheduleDrain(): void {
    if (drainPromise) return;
    cancelDebounce();
    cancelScheduledDrain = schedule(() => {
      cancelScheduledDrain = null;
      void startDrain();
    }, debounceMs);
  }

  const enqueueDirty = (
    input:
      | { channelId: string; kind: "topology" }
      | { channelId: string; kind: "content"; messageId: string },
  ) => {
    const channelId = input.channelId.trim();
    if (!channelId) return;

    const current = dirtyChannels.get(channelId);
    const kind = current?.kind === "topology" || input.kind === "topology" ? "topology" : "content";
    const messageIds = new Set(kind === "content" ? current?.messageIds : []);
    if (kind === "content" && input.kind === "content") {
      const messageId = input.messageId.trim();
      if (!messageId) return;
      messageIds.add(messageId);
    }
    dirtyChannels.set(channelId, {
      kind,
      messageIds,
    });
    scheduleDrain();
  };

  const flush = async () => {
    cancelDebounce();
    while (true) {
      const currentListings = [...listingTasks];
      if (currentListings.length > 0) await Promise.all(currentListings);
      await startDrain();
      if (listingTasks.size === 0 && dirtyChannels.size === 0) return;
    }
  };

  return {
    markDirty(input) {
      if (!accepting) return;
      enqueueDirty(input);
    },
    markAllDirty() {
      if (!accepting) return;

      let listingTask: Promise<void>;
      listingTask = (async () => {
        const listed = await captureMaterializerOperation(params.listChannelIds);
        if (listed.status === "error") {
          reportError(listed.error, { operation: "list-channels" });
          return;
        }
        for (const channelId of listed.value) {
          enqueueDirty({ channelId, kind: "topology" });
        }
      })().finally(() => {
        listingTasks.delete(listingTask);
      });
      listingTasks.add(listingTask);
    },
    flush,
    stop() {
      if (stopPromise) return stopPromise;
      accepting = false;
      stopPromise = flush();
      return stopPromise;
    },
  };
}
