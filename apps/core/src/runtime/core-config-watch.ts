import fs from "node:fs/promises";

import { errorCode, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import type { Logger } from "@stanley2058/simple-module-logger";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

type WatchReason = "watch";

export type CoreConfigWatchState = {
  lastContent: string;
};

type ReadFileFn = (path: string, encoding: BufferEncoding) => Promise<string>;

export type HandleCoreConfigWatchEventParams = {
  configPath: string;
  configFileName: string;
  eventType: string;
  filename: string | Buffer | null;
  state: CoreConfigWatchState;
  logger: Logger;
  scheduleValidation: (reason: WatchReason) => void;
  readFile?: ReadFileFn;
};

export class CoreConfigWatchReadFailed extends TaggedError("CoreConfigWatchReadFailed")<{
  readonly configPath: string;
  readonly code?: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

function normalizeWatchFilename(filename: string | Buffer | null, fallback: string): string {
  if (typeof filename === "string") return filename;
  if (filename instanceof Buffer) return filename.toString("utf8");
  return fallback;
}

async function captureCoreConfigWatchRead(
  configPath: string,
  read: () => Promise<string>,
): Promise<ResultType<string, CoreConfigWatchReadFailed>> {
  try {
    return Result.ok(await read());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new CoreConfigWatchReadFailed({
        configPath,
        code: errorCode(cause),
        cause,
        message: "Core config watcher read failed",
      }),
    );
  }
}

export async function handleCoreConfigWatchEvent(
  params: HandleCoreConfigWatchEventParams,
): Promise<void> {
  const readFile = params.readFile ?? fs.readFile;
  const changed = normalizeWatchFilename(params.filename, params.configFileName);

  const read = await captureCoreConfigWatchRead(params.configPath, () =>
    readFile(params.configPath, "utf8"),
  );
  read.match({
    ok: (current) => {
      if (current === params.state.lastContent) return;

      params.state.lastContent = current;
      params.logger.debug("core-config file change detected", {
        eventType: params.eventType,
        changed,
        path: params.configPath,
      });
      params.scheduleValidation("watch");
    },
    err: (error) => {
      if (error.code === "ENOENT") {
        params.logger.debug("core-config file temporarily unavailable during watch update", {
          eventType: params.eventType,
          changed,
          path: params.configPath,
        });
        params.scheduleValidation("watch");
        return;
      }

      params.logger.warn("core-config watcher read failed", {
        eventType: params.eventType,
        changed,
        path: params.configPath,
        ...formatTaggedErrorForLog(error),
      });
      params.scheduleValidation("watch");
    },
  });
}
