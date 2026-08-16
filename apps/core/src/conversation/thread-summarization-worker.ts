import {
  createLogger,
  formatTaggedErrorForLog,
  getCoreConfig,
  isPanic,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { createConversationThreadEmbeddingAdapterResolver } from "./thread-embedding";
import { createSerialJobQueue } from "./thread-job-queue";
import {
  decodeThreadSummarizationParentMessage,
  type ThreadSummarizationHydrationResponse,
  type ThreadSummarizationWorkerMessage,
  type ThreadSummarizationWorkerRequest,
} from "./thread-summarization-worker-protocol";
import {
  ConversationThreadOperationFailed,
  ConversationThreadService,
  type ConversationThreadAttachmentHydrator,
} from "./thread-service";
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

export class ThreadSummarizationWorkerOperationFailed extends TaggedError(
  "ThreadSummarizationWorkerOperationFailed",
)<{ readonly message: string }> {}

export function captureThreadSummarizationWorkerOperationFailure(
  cause: unknown,
): ThreadSummarizationWorkerOperationFailed | Panic {
  if (isPanic(cause)) return cause;
  if (ThreadSummarizationWorkerOperationFailed.is(cause)) return cause;
  return new Panic({
    message: "Conversation thread summarization worker defect",
    cause,
  });
}

export function captureThreadSummarizationWorkerCleanupFailure(
  cause: unknown,
): ThreadSummarizationWorkerOperationFailed | Panic {
  if (isPanic(cause)) return cause;
  return new ThreadSummarizationWorkerOperationFailed({
    message: "Conversation thread summarization worker cleanup failed",
  });
}

export async function runThreadSummarizationWorkerOperation(params: {
  readonly run: () => Promise<void>;
  readonly cleanups: readonly ThreadSummarizationWorkerCleanup[];
  readonly onCleanupFailure: (failure: ThreadSummarizationWorkerCleanupFailure) => void;
}): Promise<ResultType<void, ThreadSummarizationWorkerOperationFailed | Panic>> {
  const operation = await Result.tryPromise({
    try: params.run,
    catch: captureThreadSummarizationWorkerOperationFailure,
  });
  const operationError = operation.match({ ok: () => null, err: (error) => error });
  let cleanupPanic: Panic | null = null;

  for (const cleanup of params.cleanups) {
    const closed = Result.try({
      try: cleanup.close,
      catch: captureThreadSummarizationWorkerCleanupFailure,
    });
    const reportCleanup = closed.match<() => void>({
      ok: () => () => undefined,
      err: (error) => () => {
        if (Panic.is(error)) {
          cleanupPanic ??= error;
          params.onCleanupFailure({ cleanup, kind: "panic", panic: error });
        } else {
          params.onCleanupFailure({ cleanup, kind: "ordinary", message: error.message });
        }
      },
    });
    reportCleanup();
  }

  if (operationError) return Result.err(operationError);
  if (cleanupPanic) return Result.err(cleanupPanic);
  return Result.ok(undefined);
}

function respond(response: ThreadSummarizationWorkerMessage): void {
  postMessage(response);
}

const pendingHydrations = new Map<
  string,
  {
    refs: readonly { channelId: string; messageId: string }[];
    resolve: (response: ThreadSummarizationHydrationResponse) => void;
  }
>();

const hydrateAttachments: ConversationThreadAttachmentHydrator = async ({ refs }) => {
  const id = crypto.randomUUID();
  const response = await new Promise<ThreadSummarizationHydrationResponse>((resolve) => {
    pendingHydrations.set(id, { refs, resolve });
    respond({ type: "hydrate-discord-attachments", id, refs: [...refs] });
  });
  const pendingRefs = refs;
  if (response.results.length !== pendingRefs.length) {
    return Result.err(
      new ConversationThreadOperationFailed({
        operation: "summarize-thread",
        message: "Attachment hydration returned an unexpected result count",
      }),
    );
  }
  const hydrated: Array<{
    ref: { channelId: string; messageId: string };
    attachments: Array<{
      id?: string;
      url: string;
      filename?: string;
      mimeType?: string;
      size?: number;
    }>;
  }> = [];
  for (let index = 0; index < response.results.length; index += 1) {
    const result = response.results[index]!;
    const expected = pendingRefs[index]!;
    if (
      result.ref.channelId !== expected.channelId ||
      result.ref.messageId !== expected.messageId
    ) {
      return Result.err(
        new ConversationThreadOperationFailed({
          operation: "summarize-thread",
          message: "Attachment hydration returned mismatched message references",
        }),
      );
    }
    if (!result.ok) {
      return Result.err(
        new ConversationThreadOperationFailed({
          operation: "summarize-thread",
          message: result.error,
        }),
      );
    }
    hydrated.push({ ref: result.ref, attachments: result.attachments });
  }
  return Result.ok(hydrated);
};

async function runJob(request: ThreadSummarizationWorkerRequest): Promise<void> {
  const startedAt = Date.now();
  let store: ConversationThreadStore | null = null;
  let surfaceStore: DiscordSurfaceStore | null = null;
  const operation = await runThreadSummarizationWorkerOperation({
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
        attachmentHydrator: hydrateAttachments,
      });
      const result = await service.runSummarization({ ...request.input, jobId: request.id });
      logger.debug("conversation thread summarization worker job completed", {
        jobId: request.id,
        durationMs: Date.now() - startedAt,
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
  operation.match({
    ok: () => () => undefined,
    err: (error) => () => {
      if (Panic.is(error)) throw error;
      logger.error("conversation thread summarization worker job failed", {
        jobId: request.id,
        durationMs: Date.now() - startedAt,
        ...formatTaggedErrorForLog(error),
      });
      respond({ id: request.id, ok: false, error: error.message });
    },
  })();
}

const jobQueue = createSerialJobQueue<ThreadSummarizationWorkerRequest>({
  run: runJob,
  onIdle() {
    logger.debug("conversation thread summarization worker queue idle");
  },
});

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const decoded = decodeThreadSummarizationParentMessage(event.data);
  decoded.match({
    err: () => {
      respond({ id: "unknown", ok: false, error: "invalid worker request" });
    },
    ok: (request) => {
      if ("type" in request) {
        const pending = pendingHydrations.get(request.id);
        if (!pending) {
          logger.warn("conversation thread hydration response had no pending request", {
            hydrationId: request.id,
          });
          return;
        }
        pendingHydrations.delete(request.id);
        pending.resolve(request);
        return;
      }
      jobQueue.enqueue(request);
      logger.debug("conversation thread summarization worker job enqueued", {
        jobId: request.id,
        queueDepth: jobQueue.depth,
        running: jobQueue.running,
      });
    },
  });
});
