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

function captureBuildOperation<T>(
  operation: RemoteRunnerBuildError["operation"],
  effect: () => Promise<T>,
): Promise<ResultType<T, RemoteRunnerBuildError>> {
  return Result.tryPromise({
    try: effect,
    catch: (caught) => {
      if (isPanic(caught)) throw caught;
      return new RemoteRunnerBuildError({
        operation,
        cause: opaqueErrorCause(caught, "Opaque remote runner build failure"),
        message: `Remote runner ${operation} failed`,
      });
    },
  });
}

export async function buildRemoteRunner(): Promise<ResultType<void, RemoteRunnerBuildError>> {
  const prepared = await captureBuildOperation("prepare", async () => {
    await mkdir(outdir, { recursive: true });
  });
  if (prepared.status === "error") return prepared;

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
  if (built.status === "error") return built;

  if (!built.value.success) {
    for (const log of built.value.logs) console.error(log);
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
  if (replaced.status === "error") return replaced;
  return Result.ok(undefined);
}

if (import.meta.main) {
  const built = await buildRemoteRunner();
  if (built.status === "error") {
    console.error(built.error.message);
    process.exitCode = 1;
  }
}
