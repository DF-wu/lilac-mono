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
  type CapturedInstallFailure =
    | { readonly kind: "panic"; readonly panic: Panic }
    | { readonly kind: "failure"; readonly error: LocalInstallOperationFailed };
  function captureInstallFailure<Cause>(cause: Cause): CapturedInstallFailure {
    return Panic.is(cause)
      ? { kind: "panic", panic: cause }
      : {
          kind: "failure",
          error: new LocalInstallOperationFailed({
            operation,
            cause,
            message: `Local installation failed while attempting to ${operation}`,
          }),
        };
  }
  const attempted = await Result.tryPromise({ try: run, catch: captureInstallFailure });
  const settlement = attempted.match<
    { readonly kind: "success"; readonly value: T } | CapturedInstallFailure
  >({
    ok: (value) => ({ kind: "success", value }),
    err: (failure) => failure,
  });
  if (settlement.kind === "success") return Result.ok(settlement.value);
  if (settlement.kind === "panic") throw settlement.panic;
  return Result.err(settlement.error);
}

export async function decodeNpmPackOutput(
  output: string,
): Promise<ResultType<string, LocalInstallOperationFailed | NpmPackOutputInvalid>> {
  return Result.gen(async function* () {
    const parsedJson = yield* Result.await(
      captureInstallOperation("parse npm pack output", async () => {
        const value: unknown = JSON.parse(output);
        return value;
      }),
    );

    const parsed = npmPackOutputSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return Result.err(
        new NpmPackOutputInvalid({ message: `Invalid npm pack output: ${parsed.error.message}` }),
      );
    }
    return Result.ok(parsed.data[0].filename);
  });
}

async function run(command: readonly string[]): Promise<ResultType<void, LocalInstallError>> {
  return Result.gen(async function* () {
    const exitCode = yield* Result.await(
      captureInstallOperation(`run ${command.join(" ")}`, async () => {
        const child = Bun.spawn([...command], {
          cwd: import.meta.dir,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        return child.exited;
      }),
    );
    if (exitCode !== 0) {
      return Result.err(
        new LocalInstallCommandFailed({
          command,
          exitCode,
          message: `Command failed (${exitCode}): ${command.join(" ")}`,
        }),
      );
    }
    return Result.ok(undefined);
  });
}

export async function installLocalPackage(): Promise<ResultType<void, LocalInstallError>> {
  const bun = Bun.which("bun") ?? "bun";
  return Result.gen(async function* () {
    yield* Result.await(run([bun, "run", "build"]));

    const packed = yield* Result.await(
      captureInstallOperation("run npm pack", async () => {
        const pack = Bun.spawn(["npm", "pack", "--workspaces=false", "./dist", "--json"], {
          cwd: import.meta.dir,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "inherit",
        });
        const [output, exitCode] = await Promise.all([
          new Response(pack.stdout).text(),
          pack.exited,
        ]);
        return { output, exitCode };
      }),
    );
    if (packed.exitCode !== 0) {
      return Result.err(
        new NpmPackFailed({
          exitCode: packed.exitCode,
          message: `npm pack failed with exit code ${packed.exitCode}`,
        }),
      );
    }

    const filename = yield* Result.await(decodeNpmPackOutput(packed.output));
    yield* Result.await(run([bun, "remove", "--global", PACKAGE_NAME]));
    yield* Result.await(run([bun, "add", "--global", path.resolve(import.meta.dir, filename)]));
    return Result.ok(undefined);
  });
}

export function signalLocalInstallFailure(error: LocalInstallError): never {
  throw error;
}

if (import.meta.main) {
  const result = await installLocalPackage();
  result.match({ ok: () => undefined, err: (error) => () => signalLocalInstallFailure(error) })?.();
}
