import type { Logger } from "@stanley2058/simple-module-logger";
import { Result, TaggedError } from "better-result";
import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils";

import { projectRuntimeError, safeRuntimeErrorText } from "./error-format";

export type ProcessSignal = "SIGINT" | "SIGTERM";

type ProcessExitFn = (code: number) => never;

export type ProcessHandlerParams = {
  logger: Logger;
  stop: (fatalError?: Error) => Promise<void>;
  recordUnhandledRejection?: (reason: Error, promise: Promise<unknown>) => void;
  getExitCode?: () => number | undefined;
  setExitCode?: (code: number) => void;
  exit?: ProcessExitFn;
  exitTimeoutMs?: number;
};

export type ProcessHandlers = {
  handleSignal(signal: ProcessSignal): Promise<void>;
  reportFatalError(error: Error): void;
  handleUncaughtException(error: Error): void;
  handleUnhandledRejection(reason: Error, promise: Promise<unknown>): void;
};

const DEFAULT_EXIT_TIMEOUT_MS = 5_000;

class ProcessShutdownFailed extends TaggedError("ProcessShutdownFailed")<{
  readonly cause: Error;
  readonly message: string;
}> {}

export function createProcessHandlers(params: ProcessHandlerParams): ProcessHandlers {
  const exit = params.exit ?? ((code: number) => process.exit(code));
  const getExitCode = params.getExitCode ?? (() => process.exitCode);
  const setExitCode =
    params.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const exitTimeoutMs = params.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;

  let shuttingDown = false;
  let fatalShutdownStarted = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

  function clearForceExitTimer() {
    if (!forceExitTimer) return;
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  }

  function scheduleForceExit(trigger: string) {
    if (forceExitTimer) return;
    forceExitTimer = setTimeout(() => {
      params.logger.error("Process force exit after fatal error", {
        trigger,
        timeoutMs: exitTimeoutMs,
      });
      exit(1);
    }, exitTimeoutMs);
    forceExitTimer.unref?.();
  }

  async function handleSignal(signal: ProcessSignal, fatalError?: Error): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    params.logger.info(`Received ${signal}, shutting down...`);
    const stopped = await Result.tryPromise({
      try: () => params.stop(fatalError),
      catch: projectRuntimeError("Opaque shutdown failure"),
    });
    if (stopped.status === "error") {
      const failure = new ProcessShutdownFailed({
        cause: stopped.error,
        message: "Process shutdown failed",
      });
      params.logger.error("Shutdown failed", {
        ...formatTaggedErrorForLog(failure),
      });
      setExitCode(1);
    }
    clearForceExitTimer();
    const currentExitCode = getExitCode();
    const exitCode = typeof currentExitCode === "number" ? currentExitCode : 0;
    exit(exitCode);
  }

  async function handleFatal(trigger: string, error: Error): Promise<void> {
    const errorMessage = safeRuntimeErrorText(error, "Opaque fatal process error");
    setExitCode(1);
    if (fatalShutdownStarted || shuttingDown) {
      params.logger.error("Fatal process error during shutdown; exiting immediately", {
        trigger,
        error: errorMessage,
      });
      clearForceExitTimer();
      exit(1);
    }

    fatalShutdownStarted = true;
    params.logger.error("Fatal process error", { trigger, error: errorMessage });
    scheduleForceExit(trigger);

    try {
      await handleSignal("SIGTERM", error);
    } catch (cause) {
      params.logger.error("Fatal shutdown handler failed", {
        trigger,
        error: safeRuntimeErrorText(cause, "Opaque fatal shutdown failure"),
      });
      clearForceExitTimer();
      exit(1);
    }
  }

  async function superviseFatal(trigger: string, error: Error): Promise<void> {
    const handled = await Result.tryPromise({
      try: () => handleFatal(trigger, error),
      catch: (cause) => new Error(safeRuntimeErrorText(cause, "Opaque fatal shutdown rejection")),
    });
    if (handled.status === "ok") return;
    params.logger.error("Fatal shutdown promise rejected", {
      trigger,
      error: handled.error.message,
    });
    clearForceExitTimer();
    exit(1);
  }

  return {
    async handleSignal(signal: ProcessSignal) {
      await handleSignal(signal);
    },
    reportFatalError(error: Error) {
      void handleFatal("fatalReporter", error);
    },
    handleUncaughtException(error: Error) {
      void superviseFatal("uncaughtException", error);
    },
    handleUnhandledRejection(reason: Error, promise: Promise<unknown>) {
      params.logger.error("Unhandled promise rejection", {
        error: safeRuntimeErrorText(reason, "Opaque unhandled rejection"),
      });
      params.recordUnhandledRejection?.(reason, promise);
    },
  };
}
