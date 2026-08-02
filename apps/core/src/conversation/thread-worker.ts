import {
  createLogger,
  formatTaggedErrorForLog,
  isPanic,
  opaqueErrorMessage,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  decodeThreadSummarizationWorkerResponse,
  ThreadSummarizationWorkerResponseDecodeError,
  type ThreadSummarizationResult,
  type ThreadSummarizationWorkerRequest,
} from "./thread-summarization-worker-protocol";
import type { ConversationThreadRunSummarizationInput } from "./thread-service";

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 10_000;

export type ConversationThreadWorkerScheduler = (
  task: () => void | Promise<void>,
  delayMs: number,
) => () => void;

export type ConversationThreadWorkerFatalReporter = (panic: Panic) => void;

const fatalReportOwners = new WeakSet<Panic>();

function reportConversationThreadWorkerPanicOnce(
  panic: Panic,
  reportFatalPanic: ConversationThreadWorkerFatalReporter,
): void {
  if (fatalReportOwners.has(panic)) return;
  fatalReportOwners.add(panic);
  reportFatalPanic(panic);
}

function defaultScheduler(task: () => void | Promise<void>, delayMs: number): () => void {
  const timer = setTimeout(task, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function signalConversationThreadWorkerPanicToProcess(panic: Panic): void {
  queueMicrotask(() => {
    throw panic;
  });
}

export type ConversationThreadSummarizationRunner = {
  runSummarization(
    input?: ConversationThreadRunSummarizationInput,
  ): Promise<ResultType<ThreadSummarizationResult, ConversationThreadSummarizationError>>;
};

export class ConversationThreadSummarizationRemoteError extends TaggedError(
  "ConversationThreadSummarizationRemoteError",
)<{
  readonly jobId: string;
  readonly remoteMessage: string;
  readonly message: string;
}> {}

export type ConversationThreadSummarizationTransportOperation = "post-message" | "stopped";

export class ConversationThreadSummarizationTransportError extends TaggedError(
  "ConversationThreadSummarizationTransportError",
)<{
  readonly operation: ConversationThreadSummarizationTransportOperation;
  readonly cause?: unknown;
  readonly message: string;
}> {}

export type ConversationThreadSummarizationRuntimeOperation =
  | "materializer-flush"
  | "configuration"
  | "in-process";

export class ConversationThreadSummarizationRuntimeError extends TaggedError(
  "ConversationThreadSummarizationRuntimeError",
)<{
  readonly operation: ConversationThreadSummarizationRuntimeOperation;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type ConversationThreadSummarizationWorkerError =
  | ThreadSummarizationWorkerResponseDecodeError
  | ConversationThreadSummarizationRemoteError
  | ConversationThreadSummarizationTransportError;

export type ConversationThreadSummarizationError =
  | ConversationThreadSummarizationWorkerError
  | ConversationThreadSummarizationRuntimeError;

export type ConversationThreadSummarizationWorkerTransport = {
  postMessage(request: ThreadSummarizationWorkerRequest): void;
  terminate(): void;
  onMessage(listener: (event: MessageEvent<unknown>) => void): void;
  onError(listener: (panic: Panic) => void): void;
};

export function rethrowConversationThreadWorkerPanic(
  cause: unknown,
  beforeRethrow?: (panic: Panic) => void,
): void {
  if (!isPanic(cause)) return;
  beforeRethrow?.(cause);
  throw cause;
}

export function normalizeConversationThreadWorkerPanic(cause: unknown): Panic {
  if (isPanic(cause)) return cause;
  const message = opaqueErrorMessage(
    cause,
    "Conversation thread summarization worker failed with an opaque error",
  );
  return new Panic({ message: message || "Conversation thread summarization worker failed" });
}

function createSummarizationWorkerTransport(): ConversationThreadSummarizationWorkerTransport {
  const worker = new Worker(new URL("./thread-summarization-worker.ts", import.meta.url), {
    type: "module",
  });
  return {
    postMessage(request) {
      worker.postMessage(request);
    },
    terminate() {
      worker.terminate();
    },
    onMessage(listener) {
      worker.onmessage = listener;
    },
    onError(listener) {
      worker.onerror = (event) => {
        const cause = event.error ?? event.message;
        listener(normalizeConversationThreadWorkerPanic(cause));
      };
    },
  };
}

function queuedResult(jobId: string): ThreadSummarizationResult {
  return {
    dryRun: false,
    refreshed: { channels: 0, threads: 0, messages: 0 },
    eligible: 0,
    eligibleTotal: 0,
    eligibility: { summary: 0, embeddingOnly: 0, reasons: {} },
    cleared: 0,
    summarized: 0,
    failed: 0,
    failures: [],
    threadIds: [],
    jobId,
    status: "queued",
  };
}

export function startConversationThreadSummarizationWorker(params: {
  searchDbPath: string;
  surfaceDbPath?: string;
  createWorker?: () => ConversationThreadSummarizationWorkerTransport;
  reportFatalPanic?: ConversationThreadWorkerFatalReporter;
}): ConversationThreadSummarizationRunner & { stop(): Promise<void> } {
  const logger = createLogger({ module: "conversation-thread-worker-client" });
  const worker = params.createWorker?.() ?? createSummarizationWorkerTransport();
  const reportFatalPanic = params.reportFatalPanic ?? signalConversationThreadWorkerPanicToProcess;
  logger.debug("conversation thread summarization worker client started");
  const pending = new Map<
    string,
    {
      resolve: (
        result: ResultType<ThreadSummarizationResult, ConversationThreadSummarizationWorkerError>,
      ) => void;
      reject: (panic: Panic) => void;
    }
  >();
  const jobs = new Map<
    string,
    {
      startedAt: number;
      wait: boolean;
      dryRun: boolean;
      clear: boolean;
      threadId?: string;
    }
  >();
  let stopped = false;
  let terminated = false;
  let terminalFailure: ThreadSummarizationWorkerResponseDecodeError | null = null;
  let terminalPanic: Panic | null = null;

  const terminateWorker = () => {
    if (terminated) return;
    terminated = true;
    worker.terminate();
  };

  const settlePending = (error: ConversationThreadSummarizationWorkerError) => {
    const waiters = [...pending.values()];
    pending.clear();
    jobs.clear();
    for (const waiter of waiters) waiter.resolve(Result.err(error));
  };

  const rejectPending = (panic: Panic) => {
    const waiters = [...pending.values()];
    pending.clear();
    jobs.clear();
    for (const waiter of waiters) waiter.reject(panic);
  };

  worker.onMessage((event) => {
    if (stopped || terminalFailure || terminalPanic) return;
    const decoded = decodeThreadSummarizationWorkerResponse(event.data);
    if (decoded.status === "error") {
      terminalFailure = decoded.error;
      settlePending(terminalFailure);
      logger.warn(
        "conversation thread worker sent invalid response",
        formatTaggedErrorForLog(terminalFailure),
      );
      terminateWorker();
      return;
    }

    const response = decoded.value;
    const waiter = pending.get(response.id);
    const job = jobs.get(response.id);
    if (!waiter && !job) {
      logger.warn("conversation thread worker response had no pending job", {
        jobId: response.id,
      });
      return;
    }

    pending.delete(response.id);
    jobs.delete(response.id);
    const durationMs = job ? Date.now() - job.startedAt : undefined;

    if (response.ok) {
      logger.debug("conversation thread summarization job completed", {
        jobId: response.id,
        wait: job?.wait,
        dryRun: job?.dryRun,
        threadId: job?.threadId,
        durationMs,
        eligible: response.result.eligible,
        summarized: response.result.summarized,
        failed: response.result.failed,
      });
      waiter?.resolve(
        Result.ok({ ...response.result, jobId: response.id, status: "completed" as const }),
      );
      return;
    }

    const error = new ConversationThreadSummarizationRemoteError({
      jobId: response.id,
      remoteMessage: response.error,
      message: response.error,
    });
    logger.error("conversation thread summarization job failed", {
      jobId: response.id,
      wait: job?.wait,
      dryRun: job?.dryRun,
      threadId: job?.threadId,
      durationMs,
    });
    waiter?.resolve(Result.err(error));
  });

  const handleWorkerPanic = (panic: Panic) => {
    if (stopped || terminalFailure || terminalPanic) return;
    terminalPanic = panic;
    rejectPending(terminalPanic);
    terminateWorker();
    reportConversationThreadWorkerPanicOnce(terminalPanic, reportFatalPanic);
    logger.error("conversation thread worker defect", formatTaggedErrorForLog(terminalPanic));
  };
  worker.onError(handleWorkerPanic);

  const postRequest = (request: ThreadSummarizationWorkerRequest) => {
    try {
      worker.postMessage(request);
      return Result.ok(undefined);
    } catch (cause) {
      pending.delete(request.id);
      jobs.delete(request.id);
      rethrowConversationThreadWorkerPanic(cause);
      return Result.err(
        new ConversationThreadSummarizationTransportError({
          operation: "post-message",
          cause,
          message: "Could not post conversation thread summarization worker request",
        }),
      );
    }
  };

  return {
    async runSummarization(input = {}) {
      rethrowConversationThreadWorkerPanic(terminalPanic);
      if (terminalFailure) return Result.err(terminalFailure);
      if (stopped) {
        return Result.err(
          new ConversationThreadSummarizationTransportError({
            operation: "stopped",
            message: "Conversation thread summarization worker is stopped",
          }),
        );
      }
      const jobId = crypto.randomUUID();
      const wait = input.wait === true;
      jobs.set(jobId, {
        startedAt: Date.now(),
        wait,
        dryRun: input.dryRun === true,
        clear: input.clear === true,
        threadId: input.threadId,
      });
      logger.debug("conversation thread summarization job queued", {
        jobId,
        wait,
        dryRun: input.dryRun === true,
        clear: input.clear === true,
        threadId: input.threadId,
        beforeTs: input.beforeTs,
        afterTs: input.afterTs,
        limit: input.limit,
        trigger: input.trigger ?? "manual",
      });
      const request = {
        id: jobId,
        input,
        searchDbPath: params.searchDbPath,
        surfaceDbPath: params.surfaceDbPath,
      } satisfies ThreadSummarizationWorkerRequest;
      if (wait) {
        return await new Promise<
          ResultType<ThreadSummarizationResult, ConversationThreadSummarizationWorkerError>
        >((resolve, reject) => {
          pending.set(jobId, { resolve, reject });
          const posted = postRequest(request);
          if (posted.status === "error") resolve(Result.err(posted.error));
        });
      }

      const posted = postRequest(request);
      if (posted.status === "error") return Result.err(posted.error);
      return Result.ok(queuedResult(jobId));
    },
    async stop() {
      logger.debug("conversation thread summarization worker client stopping");
      stopped = true;
      settlePending(
        new ConversationThreadSummarizationTransportError({
          operation: "stopped",
          message: "Conversation thread summarization worker is stopped",
        }),
      );
      terminateWorker();
      logger.debug("conversation thread summarization worker client stopped");
    },
  };
}

export function startConversationThreadWorker(params: {
  runner: ConversationThreadSummarizationRunner;
  getConfig: () => Promise<CoreConfig>;
  schedule?: ConversationThreadWorkerScheduler;
  checkIntervalMs?: number;
  initialCheckDelayMs?: number;
  reportFatalPanic?: ConversationThreadWorkerFatalReporter;
}): { stop(): Promise<void> } {
  const logger = createLogger({ module: "conversation-thread-worker" });
  const scheduler = params.schedule ?? defaultScheduler;
  const checkIntervalMs = params.checkIntervalMs ?? CHECK_INTERVAL_MS;
  const reportFatalPanic = params.reportFatalPanic ?? signalConversationThreadWorkerPanicToProcess;
  logger.debug("conversation thread periodic worker started", {
    checkIntervalMs,
  });
  let stopped = false;
  let running = false;
  let cancelScheduledTick: (() => void) | null = null;
  let tickPromise: Promise<void> | null = null;
  let terminalPanic: Panic | null = null;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    cancelScheduledTick = scheduler(() => {
      cancelScheduledTick = null;
      const current = tick();
      tickPromise = current;
      return current;
    }, delayMs);
  };

  const tick = async () => {
    if (stopped) return;
    if (running) {
      logger.debug("conversation thread summarization tick skipped: previous tick still running");
      schedule(checkIntervalMs);
      return;
    }

    running = true;
    try {
      const cfg = await params.getConfig();
      if (cfg.conversation.thread.summarization.enabled !== true) {
        logger.debug("conversation thread summarization disabled");
        return;
      }

      logger.debug("conversation thread summarization tick started");
      const run = await params.runner.runSummarization({
        wait: true,
        limit: cfg.conversation.thread.summarization.batchSize,
        trigger: "periodic",
      });
      if (run.status === "error") {
        logger.error(
          "conversation thread summarization tick failed",
          formatTaggedErrorForLog(run.error),
        );
        return;
      }
      const result = run.value;
      logger.debug("conversation thread summarization tick completed", {
        eligible: result.eligible,
        eligibleTotal: result.eligibleTotal,
        summarized: result.summarized,
        failed: result.failed,
        refreshed: result.refreshed,
      });
    } catch (error) {
      if (isPanic(error)) {
        terminalPanic = error;
        reportConversationThreadWorkerPanicOnce(error, reportFatalPanic);
        logger.error(
          "conversation thread summarization tick panicked",
          formatTaggedErrorForLog(error),
        );
      } else {
        logger.error("conversation thread summarization tick failed", {
          error: opaqueErrorMessage(error, "Opaque conversation thread worker failure"),
        });
      }
    } finally {
      running = false;
      if (!terminalPanic) schedule(checkIntervalMs);
    }
  };

  schedule(params.initialCheckDelayMs ?? INITIAL_CHECK_DELAY_MS);

  return {
    async stop() {
      logger.debug("conversation thread periodic worker stopping");
      stopped = true;
      cancelScheduledTick?.();
      cancelScheduledTick = null;
      await tickPromise;
      rethrowConversationThreadWorkerPanic(terminalPanic);
      logger.debug("conversation thread periodic worker stopped");
    },
  };
}
