import { createLogger } from "@stanley2058/lilac-utils";

import {
  createThreadMaterializer,
  type ThreadMaterializer,
  type ThreadMaterializerErrorContext,
} from "./thread-materializer";
import {
  threadMaterializerWorkerResponseSchema,
  type ThreadMaterializerWorkerRequest,
} from "./thread-materializer-worker-protocol";

type PendingRequest =
  | {
      type: "list-channels";
      resolve: (channelIds: readonly string[]) => void;
      reject: (error: Error) => void;
    }
  | {
      type: "repair-channel";
      resolve: () => void;
      reject: (error: Error) => void;
    };

export type ConversationThreadMaterializer = ThreadMaterializer;

export function startConversationThreadMaterializer(params: {
  searchDbPath: string;
  surfaceDbPath?: string;
  debounceMs?: number;
}): ConversationThreadMaterializer {
  const logger = createLogger({ module: "conversation-thread-materializer-worker-client" });
  const createWorker = () =>
    new Worker(new URL("./thread-materializer-worker-isolate.ts", import.meta.url), {
      type: "module",
    });
  let worker = createWorker();
  const pending = new Map<string, PendingRequest>();
  let stopped = false;
  let coalescer: ThreadMaterializer | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  const restartWorker = (error: Error) => {
    rejectPending(error);
    if (stopped) return;
    worker.terminate();
    worker = createWorker();
    configureWorker(worker);
    coalescer?.markAllDirty();
  };

  const scheduleRecovery = () => {
    if (stopped || recoveryTimer) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      coalescer?.markAllDirty();
    }, 1_000);
    recoveryTimer.unref?.();
  };

  function configureWorker(target: Worker): void {
    target.onmessage = (event: MessageEvent<unknown>) => {
      if (target !== worker) return;
      const parsed = threadMaterializerWorkerResponseSchema.safeParse(event.data);
      if (!parsed.success) {
        const error = new Error("conversation thread materializer worker sent an invalid response");
        logger.error("conversation thread materializer worker protocol error", error);
        restartWorker(error);
        return;
      }

      const response = parsed.data;
      const request = pending.get(response.id);
      if (!request) {
        logger.warn("conversation thread materializer worker response had no pending request", {
          requestId: response.id,
        });
        return;
      }
      pending.delete(response.id);

      if (!response.ok) {
        request.reject(new Error(response.error));
        scheduleRecovery();
        return;
      }
      if (request.type === "list-channels" && response.type === "list-channels") {
        request.resolve(response.channelIds);
        return;
      }
      if (request.type === "repair-channel" && response.type === "repair-channel") {
        request.resolve();
        return;
      }

      request.reject(new Error("conversation thread materializer worker response type mismatch"));
    };

    target.onerror = (event) => {
      if (target !== worker) return;
      const error = new Error(event.message || "conversation thread materializer worker failed");
      logger.error("conversation thread materializer worker error", error);
      restartWorker(error);
    };
  }
  configureWorker(worker);

  const postRequest = (
    request: ThreadMaterializerWorkerRequest,
    pendingRequest: PendingRequest,
  ) => {
    if (stopped) {
      pendingRequest.reject(new Error("conversation thread materializer worker stopped"));
      return;
    }
    pending.set(request.id, pendingRequest);
    try {
      worker.postMessage(request);
    } catch (error) {
      pending.delete(request.id);
      pendingRequest.reject(error instanceof Error ? error : new Error(String(error)));
      scheduleRecovery();
    }
  };

  const listChannelIds = () =>
    new Promise<readonly string[]>((resolve, reject) => {
      const request = {
        id: crypto.randomUUID(),
        type: "list-channels",
        searchDbPath: params.searchDbPath,
        surfaceDbPath: params.surfaceDbPath,
      } satisfies ThreadMaterializerWorkerRequest;
      postRequest(request, { type: request.type, resolve, reject });
    });

  const repairChannel = (
    input:
      | { channelId: string; kind: "topology" }
      | { channelId: string; kind: "content"; messageIds: readonly string[] },
  ) =>
    new Promise<void>((resolve, reject) => {
      const request = {
        id: crypto.randomUUID(),
        type: "repair-channel",
        searchDbPath: params.searchDbPath,
        surfaceDbPath: params.surfaceDbPath,
        channelId: input.channelId,
        kind: input.kind,
        ...(input.kind === "content" ? { messageIds: [...input.messageIds] } : {}),
      } satisfies ThreadMaterializerWorkerRequest;
      postRequest(request, { type: request.type, resolve, reject });
    });

  const onError = (error: unknown, context: ThreadMaterializerErrorContext) => {
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.error("conversation thread materialization failed", context, cause);
  };

  const startedCoalescer = createThreadMaterializer({
    repairChannel,
    listChannelIds,
    debounceMs: params.debounceMs,
    onError,
  });
  coalescer = startedCoalescer;
  startedCoalescer.markAllDirty();

  let stopPromise: Promise<void> | null = null;
  return {
    markDirty: (input) => startedCoalescer.markDirty(input),
    markAllDirty: () => startedCoalescer.markAllDirty(),
    flush: () => startedCoalescer.flush(),
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        try {
          await startedCoalescer.stop();
        } finally {
          stopped = true;
          if (recoveryTimer) clearTimeout(recoveryTimer);
          recoveryTimer = null;
          worker.terminate();
          rejectPending(new Error("conversation thread materializer worker stopped"));
          logger.debug("conversation thread materializer worker stopped");
        }
      })();
      return stopPromise;
    },
  };
}
