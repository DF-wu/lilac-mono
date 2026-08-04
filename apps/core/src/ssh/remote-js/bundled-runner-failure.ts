import { Panic, Result, type Panic as PanicType } from "better-result";

import { adaptToolResultToHost } from "../../tools/tool-result-adapters";

export function rethrowBundledRemoteRunnerPanic(error: Error | PanicType): Error {
  if (Panic.is(error)) return adaptToolResultToHost(Result.err(error));
  return error;
}

export function bundledRemoteRunnerErrorMessage(error: Error): string {
  return error.message;
}
