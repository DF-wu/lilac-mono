import path from "node:path";

import { isPanic, opaqueErrorCause } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

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
    catch: (caught) => {
      if (isPanic(caught)) throw caught;
      const cause = opaqueErrorCause(caught, "Opaque bundled remote runner read failure");
      return new RemoteRunnerSourceReadError({
        filePath,
        cause,
        message: `Failed to read bundled remote runner: ${filePath}`,
      });
    },
  });
  if (loaded.status === "error") return Result.err(loaded.error);
  cached = loaded.value;
  return Result.ok(loaded.value);
}
