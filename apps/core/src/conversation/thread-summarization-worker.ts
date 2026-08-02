import {
  createLogger,
  formatTaggedErrorForLog,
  getCoreConfig,
  isPanic,
  opaqueErrorMessage,
} from "@stanley2058/lilac-utils";
import type { Panic } from "better-result";

import { createConversationThreadEmbeddingAdapterResolver } from "./thread-embedding";
import { createSerialJobQueue } from "./thread-job-queue";
import {
  decodeThreadSummarizationWorkerRequest,
  type ThreadSummarizationWorkerRequest,
  type ThreadSummarizationWorkerResponse,
} from "./thread-summarization-worker-protocol";
import { ConversationThreadService } from "./thread-service";
import { ConversationThreadStore } from "./thread-store";
import { createDiscordEntityMapper } from "../entity/entity-mapper";
import { DiscordSurfaceStore } from "../surface/store/discord-surface-store";

const logger = createLogger({ module: "conversation-thread-worker-isolate" });
logger.debug("conversation thread summarization worker isolate booted");

export type ThreadSummarizationWorkerCleanup = {
  readonly label: "thread-store" | "surface-store";
  readonly close: () => void;
};

export type ThreadSummarizationWorkerCleanupFailure =
  | {
      readonly cleanup: ThreadSummarizationWorkerCleanup;
      readonly kind: "ordinary";
      readonly message: string;
    }
  | {
      readonly cleanup: ThreadSummarizationWorkerCleanup;
      readonly kind: "panic";
      readonly panic: Panic;
    };

export async function runThreadSummarizationWorkerOperation(params: {
  readonly run: () => Promise<void>;
  readonly cleanups: readonly ThreadSummarizationWorkerCleanup[];
  readonly onCleanupFailure: (failure: ThreadSummarizationWorkerCleanupFailure) => void;
}): Promise<void> {
  let operation: { readonly status: "ok" } | { readonly status: "error"; readonly cause: unknown };
  try {
    await params.run();
    operation = { status: "ok" };
  } catch (cause) {
    operation = { status: "error", cause };
  }
  const operationPanic =
    operation.status === "error" && isPanic(operation.cause) ? operation.cause : null;
  let cleanupPanic: Panic | null = null;

  for (const cleanup of params.cleanups) {
    try {
      cleanup.close();
    } catch (cause) {
      if (isPanic(cause)) {
        cleanupPanic ??= cause;
        params.onCleanupFailure({ cleanup, kind: "panic", panic: cause });
      } else {
        params.onCleanupFailure({
          cleanup,
          kind: "ordinary",
          message: opaqueErrorMessage(cause, "Opaque worker cleanup failure"),
        });
      }
    }
  }

  if (operationPanic) throw operationPanic;
  if (cleanupPanic) throw cleanupPanic;
  if (operation.status === "error") throw operation.cause;
}

function respond(response: ThreadSummarizationWorkerResponse): void {
  postMessage(response);
}

async function runJob(request: ThreadSummarizationWorkerRequest): Promise<void> {
  const startedAt = Date.now();
  let store: ConversationThreadStore | null = null;
  let surfaceStore: DiscordSurfaceStore | null = null;
  try {
    await runThreadSummarizationWorkerOperation({
      async run() {
        logger.debug("conversation thread summarization worker job started", {
          jobId: request.id,
          dryRun: request.input.dryRun === true,
          force: request.input.force === true,
          clear: request.input.clear === true,
          threadId: request.input.threadId,
          beforeTs: request.input.beforeTs,
          afterTs: request.input.afterTs,
          queuedJobs: jobQueue.depth,
        });
        const cfg = await getCoreConfig({ forceReload: true });
        const getEmbeddingAdapter = createConversationThreadEmbeddingAdapterResolver(() =>
          getCoreConfig(),
        );

        store = new ConversationThreadStore(request.searchDbPath, {
          surfaceDbPath: request.surfaceDbPath,
          mainAgentUserNames: [cfg.surface.discord.botName],
        });
        const entityMapper = request.surfaceDbPath
          ? (() => {
              surfaceStore = new DiscordSurfaceStore(request.surfaceDbPath);
              return createDiscordEntityMapper({ cfg, store: surfaceStore });
            })()
          : undefined;
        const service = new ConversationThreadService({
          store,
          getConfig: () => getCoreConfig(),
          getEmbeddingAdapter,
          entityMapper,
        });
        const result = await service.runSummarization({ ...request.input, jobId: request.id });
        logger.debug("conversation thread summarization worker job completed", {
          jobId: request.id,
          durationMs: Date.now() - startedAt,
          eligible: result.eligible,
          cleared: result.cleared,
          summarized: result.summarized,
          failed: result.failed,
        });
        respond({ id: request.id, ok: true, result });
      },
      cleanups: [
        { label: "thread-store", close: () => store?.close() },
        { label: "surface-store", close: () => surfaceStore?.close() },
      ],
      onCleanupFailure(failure) {
        if (failure.kind === "panic") {
          logger.error("conversation thread summarization worker cleanup panicked", {
            jobId: request.id,
            cleanup: failure.cleanup.label,
            ...formatTaggedErrorForLog(failure.panic),
          });
          return;
        }
        logger.error("conversation thread summarization worker cleanup failed", {
          jobId: request.id,
          cleanup: failure.cleanup.label,
          errorMessage: failure.message,
        });
      },
    });
  } catch (error) {
    if (isPanic(error)) throw error;
    const message = opaqueErrorMessage(error, "Opaque worker operation failure");
    logger.error(
      "conversation thread summarization worker job failed",
      { jobId: request.id, durationMs: Date.now() - startedAt },
      error,
    );
    respond({ id: request.id, ok: false, error: message });
  }
}

const jobQueue = createSerialJobQueue<ThreadSummarizationWorkerRequest>({
  run: runJob,
  onIdle() {
    logger.debug("conversation thread summarization worker queue idle");
  },
});

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const decoded = decodeThreadSummarizationWorkerRequest(event.data);
  if (decoded.status === "error") {
    respond({ id: "unknown", ok: false, error: "invalid worker request" });
    return;
  }

  const request = decoded.value;
  jobQueue.enqueue(request);
  logger.debug("conversation thread summarization worker job enqueued", {
    jobId: request.id,
    queueDepth: jobQueue.depth,
    running: jobQueue.running,
  });
});
