import { errorMessage } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  createCoreRuntime,
  type CoreRuntime,
  type CoreRuntimeCreateFailed,
  type CoreRuntimeCreateOutcome,
  type CoreRuntimeOptions,
  type CoreRuntimeStartFailed,
} from "./create-core-runtime";

export class CoreRuntimeInvocationFailed extends TaggedError("CoreRuntimeInvocationFailed")<{
  readonly operation: "create" | "start";
  readonly cause: unknown;
  readonly message: string;
}> {}

export type CoreRuntimeStartupError =
  | CoreRuntimeCreateFailed
  | CoreRuntimeStartFailed
  | CoreRuntimeInvocationFailed;

type CoreRuntimeFactory = (options: CoreRuntimeOptions) => Promise<CoreRuntimeCreateOutcome>;

export async function startCoreRuntime(options: {
  readonly reportFatalError: CoreRuntimeOptions["reportFatalError"];
  readonly onUnhealthy: NonNullable<CoreRuntimeOptions["onUnhealthy"]>;
  readonly createRuntime?: CoreRuntimeFactory;
}): Promise<ResultType<CoreRuntime, CoreRuntimeStartupError>> {
  const factory = options.createRuntime ?? createCoreRuntime;
  const created = await Result.tryPromise({
    try: () =>
      factory({
        reportFatalError: options.reportFatalError,
        onUnhealthy: options.onUnhealthy,
      }),
    catch: (cause) =>
      new CoreRuntimeInvocationFailed({
        operation: "create",
        cause,
        message: errorMessage(cause),
      }),
  });
  const runtime = created.andThen((operationResult) => {
    if (operationResult.kind === "panic") {
      return Result.err(
        new CoreRuntimeInvocationFailed({
          operation: "create",
          cause: operationResult.panic,
          message: errorMessage(operationResult.panic),
        }),
      );
    }
    return operationResult.result;
  });
  if (runtime.isErr()) return runtime;
  const started = await Result.tryPromise({
    try: () => runtime.value.start(),
    catch: (cause) =>
      new CoreRuntimeInvocationFailed({
        operation: "start",
        cause,
        message: errorMessage(cause),
      }),
  });
  return started.andThen((operationResult) => {
    if (operationResult.kind === "panic") {
      return Result.err(
        new CoreRuntimeInvocationFailed({
          operation: "start",
          cause: operationResult.panic,
          message: errorMessage(operationResult.panic),
        }),
      );
    }
    return operationResult.result.map(() => runtime.value);
  });
}
