import path from "node:path";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

const PACKAGE_NAME = "@stanley2058/mini-lilac";

const npmPackOutputSchema = z.tuple([
  z.object({
    filename: z.string().min(1),
  }),
]);

export class LocalInstallOperationFailed extends TaggedError("LocalInstallOperationFailed")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class LocalInstallCommandFailed extends TaggedError("LocalInstallCommandFailed")<{
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly message: string;
}> {}

export class NpmPackFailed extends TaggedError("NpmPackFailed")<{
  readonly exitCode: number;
  readonly message: string;
}> {}

export class NpmPackOutputInvalid extends TaggedError("NpmPackOutputInvalid")<{
  readonly message: string;
}> {}

export type LocalInstallError =
  | LocalInstallOperationFailed
  | LocalInstallCommandFailed
  | NpmPackFailed
  | NpmPackOutputInvalid;

async function captureInstallOperation<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<ResultType<T, LocalInstallOperationFailed>> {
  try {
    return Result.ok(await run());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new LocalInstallOperationFailed({
        operation,
        cause,
        message: `Local installation failed while attempting to ${operation}`,
      }),
    );
  }
}

export async function decodeNpmPackOutput(
  output: string,
): Promise<ResultType<string, LocalInstallOperationFailed | NpmPackOutputInvalid>> {
  const parsedJson = await captureInstallOperation("parse npm pack output", async () => {
    const value: unknown = JSON.parse(output);
    return value;
  });
  if (parsedJson.status === "error") return Result.err(parsedJson.error);

  const parsed = npmPackOutputSchema.safeParse(parsedJson.value);
  if (!parsed.success) {
    return Result.err(
      new NpmPackOutputInvalid({ message: `Invalid npm pack output: ${parsed.error.message}` }),
    );
  }
  return Result.ok(parsed.data[0].filename);
}

async function run(command: readonly string[]): Promise<ResultType<void, LocalInstallError>> {
  const executed = await captureInstallOperation(`run ${command.join(" ")}`, async () => {
    const child = Bun.spawn([...command], {
      cwd: import.meta.dir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exited;
  });
  if (executed.status === "error") return Result.err(executed.error);
  if (executed.value !== 0) {
    return Result.err(
      new LocalInstallCommandFailed({
        command,
        exitCode: executed.value,
        message: `Command failed (${executed.value}): ${command.join(" ")}`,
      }),
    );
  }
  return Result.ok(undefined);
}

export async function installLocalPackage(): Promise<ResultType<void, LocalInstallError>> {
  const bun = Bun.which("bun") ?? "bun";
  const built = await run([bun, "run", "build"]);
  if (built.status === "error") return Result.err(built.error);

  const packed = await captureInstallOperation("run npm pack", async () => {
    const pack = Bun.spawn(["npm", "pack", "--workspaces=false", "./dist", "--json"], {
      cwd: import.meta.dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    const [output, exitCode] = await Promise.all([new Response(pack.stdout).text(), pack.exited]);
    return { output, exitCode };
  });
  if (packed.status === "error") return Result.err(packed.error);
  if (packed.value.exitCode !== 0) {
    return Result.err(
      new NpmPackFailed({
        exitCode: packed.value.exitCode,
        message: `npm pack failed with exit code ${packed.value.exitCode}`,
      }),
    );
  }

  const filename = await decodeNpmPackOutput(packed.value.output);
  if (filename.status === "error") return Result.err(filename.error);
  const removed = await run([bun, "remove", "--global", PACKAGE_NAME]);
  if (removed.status === "error") return Result.err(removed.error);
  return run([bun, "add", "--global", path.resolve(import.meta.dir, filename.value)]);
}

export function signalLocalInstallFailure(error: LocalInstallError): never {
  const options = error._tag === "LocalInstallOperationFailed" ? { cause: error.cause } : undefined;
  throw new Error(error.message, options);
}

if (import.meta.main) {
  const result = await installLocalPackage();
  if (result.status === "error") signalLocalInstallFailure(result.error);
}
