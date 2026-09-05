import { captureError } from "./src/shared/error-capture.js";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { isPanic, opaqueErrorCause } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

const outdir = "./src/ssh/remote-js";
const sourceEntrypoint = "./src/ssh/remote-js/remote-runner-entry.ts";
const generatedJsPath = `${outdir}/remote-runner-entry.js`;
const targetCjsPath = `${outdir}/remote-runner.cjs`;
const remoteRunnerUtilsPath = path.resolve(
  import.meta.dir,
  "src/ssh/remote-js/remote-runner-utils.ts",
);

export class RemoteRunnerBuildError extends TaggedError("RemoteRunnerBuildError")<{
  readonly operation: "prepare" | "build" | "replace";
  readonly cause: unknown;
  readonly message: string;
}> {}

async function captureBuildOperation<T>(
  operation: RemoteRunnerBuildError["operation"],
  effect: () => Promise<T>,
): Promise<ResultType<T, RemoteRunnerBuildError>> {
  const pending = Promise.resolve().then(effect);
  const captured = await Result.tryPromise({
    try: () => pending,
    catch: (cause) => captureError(cause, "Remote runner build failed"),
  });
  const outcome = captured.match<
    | { readonly kind: "success"; readonly value: T }
    | { readonly kind: "failure"; readonly cause: Error }
  >({
    ok: (value) => ({ kind: "success", value }),
    err: ({ cause }) => ({ kind: "failure", cause }),
  });
  if (outcome.kind === "success") return Result.ok(outcome.value);
  if (isPanic(outcome.cause)) {
    await pending;
    return Result.err(
      new RemoteRunnerBuildError({
        operation,
        cause: opaqueErrorCause(outcome.cause, "Opaque remote runner build failure"),
        message: `Remote runner ${operation} failed`,
      }),
    );
  }
  return Result.err(
    new RemoteRunnerBuildError({
      operation,
      cause: opaqueErrorCause(outcome.cause, "Opaque remote runner build failure"),
      message: `Remote runner ${operation} failed`,
    }),
  );
}

export async function buildRemoteRunner(): Promise<ResultType<void, RemoteRunnerBuildError>> {
  const prepared = await captureBuildOperation("prepare", async () => {
    await mkdir(outdir, { recursive: true });
  });
  const continuePrepared = prepared.match<() => Promise<ResultType<void, RemoteRunnerBuildError>>>({
    err: (error) => async () => Result.err(error),
    ok: () => async () => {
      const built = await captureBuildOperation("build", () =>
        Bun.build({
          entrypoints: [sourceEntrypoint],
          outdir,
          target: "node",
          format: "cjs",
          sourcemap: "none",
          minify: true,
          plugins: [
            {
              name: "remote-runner-utils",
              setup(build) {
                build.onResolve({ filter: /^@stanley2058\/lilac-utils$/u }, () => ({
                  path: remoteRunnerUtilsPath,
                }));
              },
            },
          ],
        }),
      );
      const continueBuilt = built.match<() => Promise<ResultType<void, RemoteRunnerBuildError>>>({
        err: (error) => async () => Result.err(error),
        ok: (output) => async () => {
          if (!output.success) {
            for (const log of output.logs) console.error(log);
            return Result.err(
              new RemoteRunnerBuildError({
                operation: "build",
                cause: new Error("Bun.build returned success=false"),
                message: "Remote runner build failed",
              }),
            );
          }
          const replaced = await captureBuildOperation("replace", async () => {
            await rm(targetCjsPath, { force: true });
            await rename(generatedJsPath, targetCjsPath);
          });
          const continueReplaced = replaced.match<() => ResultType<void, RemoteRunnerBuildError>>({
            err: (error) => () => Result.err(error),
            ok: () => () => Result.ok(undefined),
          });
          return continueReplaced();
        },
      });
      return await continueBuilt();
    },
  });
  return await continuePrepared();
}

if (import.meta.main) {
  const built = await buildRemoteRunner();
  built.match({
    ok: () => undefined,
    err: (error) => () => {
      console.error(error.message);
      process.exitCode = 1;
    },
  })?.();
}
