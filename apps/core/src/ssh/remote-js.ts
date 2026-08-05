import path from "node:path";

import { Result, TaggedError, type Result as ResultType } from "better-result";

import { projectRuntimeError } from "../runtime/error-format";
import { preserveToolPanic } from "../tools/tool-result-adapters";

let cached: string | null = null;

export class RemoteRunnerSourceReadError extends TaggedError("RemoteRunnerSourceReadError")<{
  readonly filePath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export async function getRemoteRunnerJsText(): Promise<
  ResultType<string, RemoteRunnerSourceReadError>
> {
  if (cached) return Result.ok(cached);

  const filePath = path.resolve(import.meta.dir, "remote-js", "remote-runner.cjs");
  const loaded = await Result.tryPromise({
    try: () => Bun.file(filePath).text(),
    catch: projectRuntimeError("Opaque bundled remote runner read failure"),
  });
  if (loaded.status === "error") {
    const cause = preserveToolPanic(loaded.error);
    return Result.err(
      new RemoteRunnerSourceReadError({
        filePath,
        cause,
        message: `Failed to read bundled remote runner: ${filePath}`,
      }),
    );
  }
  cached = loaded.value;
  return Result.ok(loaded.value);
}
