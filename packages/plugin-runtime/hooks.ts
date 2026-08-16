import { Result, type Result as ResultType } from "better-result";

import {
  decodeBooleanHookResult,
  decodeLevel1ToolSpec,
  decodeLevel1ToolFailureSummary,
  decodeServerTool,
  decodeServerToolListResult,
  decodeStringArrayHookResult,
  decodeStringHookResult,
  decodeVoidHookResult,
  getLevel1ToolSpecCapabilitySnapshot,
  getServerToolCapabilitySnapshot,
  isPluginPanic,
  opaquePluginExceptionMessage,
  safePluginExceptionCause,
  type Level1ToolSpecCapabilitySnapshot,
  type ServerToolCapabilitySnapshot,
  type ToolPluginCapabilitySnapshot,
  type ToolPluginInstanceCapabilitySnapshot,
} from "./capabilities";
import {
  ToolPluginHookError,
  ToolPluginSkipError,
  ToolPluginSkipped,
  ToolPluginCapabilityError,
  type ToolPluginHookName,
} from "./errors";
import type {
  Level1ToolBuildContext,
  Level1ToolFailureSummary,
  Level1ToolRunContext,
  Level1ToolSpec,
  PluginSource,
  ServerTool,
  ServerToolListResult,
  ToolPluginCreateContext,
  ToolPluginInstance,
} from "./types";

export type ToolPluginInvocationError = ToolPluginHookError | ToolPluginSkipped;

export type HookContext = {
  readonly pluginId: string;
  readonly source: PluginSource;
  readonly hook: ToolPluginHookName;
  readonly itemId?: string;
};

export function mapPluginHookException(
  context: HookContext,
  cause: Error,
  skipReason?: string,
): ToolPluginInvocationError {
  if (skipReason !== undefined) {
    return new ToolPluginSkipped({
      pluginId: context.pluginId,
      source: context.source,
      reason: skipReason,
      message: `Plugin '${context.pluginId}' skipped: ${skipReason}`,
    });
  }
  return new ToolPluginHookError({
    ...context,
    cause,
    message: `Plugin '${context.pluginId}' ${context.hook} failed: ${cause.message}`,
  });
}

function resolveLevel1Capability<TRuntimeContext>(params: {
  pluginId: string;
  spec: Level1ToolSpec<TRuntimeContext>;
  capability?: Level1ToolSpecCapabilitySnapshot<TRuntimeContext>;
}): ResultType<Level1ToolSpecCapabilitySnapshot<TRuntimeContext>, ToolPluginCapabilityError> {
  if (params.capability && Object.is(params.capability.spec, params.spec)) {
    return Result.ok(params.capability);
  }
  const captured = getLevel1ToolSpecCapabilitySnapshot(params.spec);
  if (captured) return Result.ok(captured);
  return decodeLevel1ToolSpec(params.pluginId, params.spec);
}

function resolveServerToolCapability(params: {
  pluginId: string;
  tool: ServerTool;
  capability?: ServerToolCapabilitySnapshot;
}): ResultType<ServerToolCapabilitySnapshot, ToolPluginCapabilityError> {
  if (params.capability && Object.is(params.capability.tool, params.tool)) {
    return Result.ok(params.capability);
  }
  const captured = getServerToolCapabilitySnapshot(params.tool);
  if (captured) return Result.ok(captured);
  return decodeServerTool(params.pluginId, params.tool);
}

function captureSyncHook<T>(
  context: HookContext,
  run: () => T,
): ResultType<T, ToolPluginInvocationError>;
function captureSyncHook<TInput, TOutput, E>(
  context: HookContext,
  run: () => TInput,
  decode: (value: TInput) => ResultType<TOutput, E>,
): ResultType<TOutput, ToolPluginInvocationError | E>;
function captureSyncHook<TInput, TOutput = TInput, E = never>(
  context: HookContext,
  run: () => TInput,
  decode?: (value: TInput) => ResultType<TOutput, E>,
): ResultType<TInput | TOutput, ToolPluginInvocationError | E> {
  try {
    const value = run();
    return decode ? decode(value) : Result.ok(value);
  } catch (cause) {
    if (isPluginPanic(cause)) throw cause;
    let skipReason: string | undefined;
    try {
      if (cause instanceof ToolPluginSkipError) skipReason = opaquePluginExceptionMessage(cause);
    } catch {
      skipReason = undefined;
    }
    return Result.err(mapPluginHookException(context, safePluginExceptionCause(cause), skipReason));
  }
}

async function captureAsyncHook<T>(
  context: HookContext,
  run: () => Promise<T> | T,
): Promise<ResultType<T, ToolPluginInvocationError>>;
async function captureAsyncHook<TInput, TOutput, E>(
  context: HookContext,
  run: () => Promise<TInput> | TInput,
  decode: (value: Awaited<TInput>) => ResultType<TOutput, E>,
): Promise<ResultType<TOutput, ToolPluginInvocationError | E>>;
async function captureAsyncHook<TInput, TOutput = Awaited<TInput>, E = never>(
  context: HookContext,
  run: () => Promise<TInput> | TInput,
  decode?: (value: Awaited<TInput>) => ResultType<TOutput, E>,
): Promise<ResultType<Awaited<TInput> | TOutput, ToolPluginInvocationError | E>> {
  try {
    const value = await run();
    return decode ? decode(value) : Result.ok(value);
  } catch (cause) {
    if (isPluginPanic(cause)) throw cause;
    let skipReason: string | undefined;
    try {
      if (cause instanceof ToolPluginSkipError) skipReason = opaquePluginExceptionMessage(cause);
    } catch {
      skipReason = undefined;
    }
    return Result.err(mapPluginHookException(context, safePluginExceptionCause(cause), skipReason));
  }
}

export async function invokeToolPluginCreate<TRuntimeContext>(params: {
  capability: ToolPluginCapabilitySnapshot<TRuntimeContext>;
  context: ToolPluginCreateContext<TRuntimeContext>;
  source: PluginSource;
}): Promise<
  ResultType<
    ToolPluginInstance<Level1ToolSpec<TRuntimeContext>, ServerTool>,
    ToolPluginInvocationError
  >
> {
  const pluginId = params.capability.meta.id;
  const hookContext = {
    pluginId,
    source: params.source,
    hook: "plugin.create",
  } satisfies HookContext;
  return captureAsyncHook(hookContext, () =>
    params.capability.create.call(params.capability.plugin, params.context),
  );
}

export async function invokeToolPluginInstanceInit<TRuntimeContext>(params: {
  pluginId: string;
  source: PluginSource;
  capability: ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>;
}): Promise<ResultType<void, ToolPluginInvocationError | ToolPluginCapabilityError>> {
  if (params.capability.init === undefined) return Result.ok();
  const context = {
    pluginId: params.pluginId,
    source: params.source,
    hook: "instance.init",
  } satisfies HookContext;
  return captureAsyncHook(
    context,
    () => params.capability.init!.call(params.capability.instance),
    (value) => decodeVoidHookResult(params.pluginId, value),
  );
}

export async function invokeToolPluginInstanceDestroy<TRuntimeContext>(params: {
  pluginId: string;
  source: PluginSource;
  capability: ToolPluginInstanceCapabilitySnapshot<TRuntimeContext>;
}): Promise<ResultType<void, ToolPluginInvocationError | ToolPluginCapabilityError>> {
  if (params.capability.destroy === undefined) return Result.ok();
  const context = {
    pluginId: params.pluginId,
    source: params.source,
    hook: "instance.destroy",
  } satisfies HookContext;
  return captureAsyncHook(
    context,
    () => params.capability.destroy!.call(params.capability.instance),
    (value) => decodeVoidHookResult(params.pluginId, value),
  );
}

export function invokeLevel1CreateTool<TRuntimeContext>(params: {
  pluginId: string;
  source: PluginSource;
  spec: Level1ToolSpec<TRuntimeContext>;
  capability?: Level1ToolSpecCapabilitySnapshot<TRuntimeContext>;
  context: Level1ToolBuildContext<TRuntimeContext>;
}): ResultType<unknown, ToolPluginInvocationError | ToolPluginCapabilityError> {
  const capability = resolveLevel1Capability(params);
  const invoke = capability.match<
    () => ResultType<unknown, ToolPluginInvocationError | ToolPluginCapabilityError>
  >({
    err: (error) => () => Result.err(error),
    ok: (value) => () =>
      captureSyncHook(
        {
          pluginId: params.pluginId,
          source: params.source,
          hook: "level1.createTool",
          itemId: value.name,
        },
        () => value.createTool.call(params.spec, params.context),
      ),
  });
  return invoke();
}

export function invokeLevel1IsEnabled<TRuntimeContext>(params: {
  pluginId: string;
  source: PluginSource;
  spec: Level1ToolSpec<TRuntimeContext>;
  capability?: Level1ToolSpecCapabilitySnapshot<TRuntimeContext>;
  context: Level1ToolRunContext<TRuntimeContext>;
}): ResultType<boolean, ToolPluginInvocationError | ToolPluginCapabilityError> {
  const capability = resolveLevel1Capability(params);
  const invoke = capability.match<
    () => ResultType<boolean, ToolPluginInvocationError | ToolPluginCapabilityError>
  >({
    err: (error) => () => Result.err(error),
    ok: (value) => () =>
      captureSyncHook(
        {
          pluginId: params.pluginId,
          source: params.source,
          hook: "level1.isEnabled",
          itemId: value.name,
        },
        () => value.isEnabled.call(params.spec, params.context),
        (enabled) => decodeBooleanHookResult(params.pluginId, enabled),
      ),
  });
  return invoke();
}

export async function invokeLevel1EditTargets<TArgs>(params: {
  pluginId: string;
  source: PluginSource;
  spec: Level1ToolSpec<unknown>;
  capability?: Level1ToolSpecCapabilitySnapshot<unknown>;
  args: TArgs;
  cwd: string;
}): Promise<
  ResultType<readonly string[] | undefined, ToolPluginInvocationError | ToolPluginCapabilityError>
> {
  const capability = resolveLevel1Capability(params);
  const invoke = capability.match<
    () => Promise<
      ResultType<
        readonly string[] | undefined,
        ToolPluginInvocationError | ToolPluginCapabilityError
      >
    >
  >({
    err: (error) => async () => Result.err(error),
    ok: (value) => async () => {
      if (value.editTargets === undefined) return Result.ok(undefined);
      const context = {
        pluginId: params.pluginId,
        source: params.source,
        hook: "level1.editTargets",
        itemId: value.name,
      } satisfies HookContext;
      return captureAsyncHook(
        context,
        () => value.editTargets!.call(params.spec, params.args, { cwd: params.cwd }),
        (targets) =>
          captureSyncHook(
            context,
            () => Array.from(targets),
            (collected) => decodeStringArrayHookResult(params.pluginId, collected),
          ),
      );
    },
  });
  return invoke();
}

export function invokeLevel1FormatArgs<TArgs>(params: {
  pluginId: string;
  source: PluginSource;
  spec: Level1ToolSpec<unknown>;
  capability?: Level1ToolSpecCapabilitySnapshot<unknown>;
  args: TArgs;
}): ResultType<string | undefined, ToolPluginInvocationError | ToolPluginCapabilityError> {
  const capability = resolveLevel1Capability(params);
  const invoke = capability.match<
    () => ResultType<string | undefined, ToolPluginInvocationError | ToolPluginCapabilityError>
  >({
    err: (error) => () => Result.err(error),
    ok: (value) => () => {
      if (value.formatArgs === undefined) return Result.ok(undefined);
      return captureSyncHook(
        {
          pluginId: params.pluginId,
          source: params.source,
          hook: "level1.formatArgs",
          itemId: value.name,
        },
        () => value.formatArgs!.call(params.spec, params.args),
        (formatted) => decodeStringHookResult(params.pluginId, formatted),
      );
    },
  });
  return invoke();
}

export function invokeLevel1SummarizeFailure(params: {
  pluginId: string;
  source: PluginSource;
  spec: Level1ToolSpec<unknown>;
  capability?: Level1ToolSpecCapabilitySnapshot<unknown>;
  value: { isError: boolean; result: unknown };
}): ResultType<
  Level1ToolFailureSummary | undefined,
  ToolPluginInvocationError | ToolPluginCapabilityError
> {
  const capability = resolveLevel1Capability(params);
  const invoke = capability.match<
    () => ResultType<
      Level1ToolFailureSummary | undefined,
      ToolPluginInvocationError | ToolPluginCapabilityError
    >
  >({
    err: (error) => () => Result.err(error),
    ok: (value) => () => {
      if (value.summarizeFailure === undefined) return Result.ok(undefined);
      return captureSyncHook(
        {
          pluginId: params.pluginId,
          source: params.source,
          hook: "level1.summarizeFailure",
          itemId: value.name,
        },
        () => value.summarizeFailure!.call(params.spec, params.value),
        (summary) => decodeLevel1ToolFailureSummary(params.pluginId, summary),
      );
    },
  });
  return invoke();
}

async function invokeLevel2VoidHook(params: {
  pluginId: string;
  source: PluginSource;
  tool: ServerTool;
  capability?: ServerToolCapabilitySnapshot;
  hook: "level2.init" | "level2.destroy";
}): Promise<ResultType<void, ToolPluginInvocationError | ToolPluginCapabilityError>> {
  const capability = resolveServerToolCapability(params);
  const capabilityValue = capability.match<
    ServerToolCapabilitySnapshot | ToolPluginCapabilityError
  >({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ToolPluginCapabilityError.is(capabilityValue)) return Result.err(capabilityValue);
  const method = params.hook === "level2.init" ? capabilityValue.init : capabilityValue.destroy;
  const context = {
    pluginId: params.pluginId,
    source: params.source,
    hook: params.hook,
    itemId: capabilityValue.id,
  } satisfies HookContext;
  return captureAsyncHook(
    context,
    () => method.call(params.tool),
    (value) => decodeVoidHookResult(params.pluginId, value),
  );
}

export function invokeLevel2Init(params: {
  pluginId: string;
  source: PluginSource;
  tool: ServerTool;
  capability?: ServerToolCapabilitySnapshot;
}): Promise<ResultType<void, ToolPluginInvocationError | ToolPluginCapabilityError>> {
  return invokeLevel2VoidHook({ ...params, hook: "level2.init" });
}

export function invokeLevel2Destroy(params: {
  pluginId: string;
  source: PluginSource;
  tool: ServerTool;
  capability?: ServerToolCapabilitySnapshot;
}): Promise<ResultType<void, ToolPluginInvocationError | ToolPluginCapabilityError>> {
  return invokeLevel2VoidHook({ ...params, hook: "level2.destroy" });
}

export async function invokeLevel2List(params: {
  pluginId: string;
  source: PluginSource;
  tool: ServerTool;
  capability?: ServerToolCapabilitySnapshot;
}): Promise<
  ResultType<ServerToolListResult, ToolPluginInvocationError | ToolPluginCapabilityError>
> {
  const capability = resolveServerToolCapability(params);
  const capabilityValue = capability.match<
    ServerToolCapabilitySnapshot | ToolPluginCapabilityError
  >({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ToolPluginCapabilityError.is(capabilityValue)) return Result.err(capabilityValue);
  return captureAsyncHook(
    {
      pluginId: params.pluginId,
      source: params.source,
      hook: "level2.list",
      itemId: capabilityValue.id,
    },
    () => capabilityValue.list.call(params.tool),
    (value) => decodeServerToolListResult(params.pluginId, value),
  );
}

export function invokeLevel2Call(params: {
  pluginId: string;
  source: PluginSource;
  tool: ServerTool;
  capability?: ServerToolCapabilitySnapshot;
  callableId: string;
  input: Record<string, unknown>;
  opts?: Parameters<ServerTool["call"]>[2];
}): Promise<ResultType<unknown, ToolPluginInvocationError | ToolPluginCapabilityError>> {
  const capability = resolveServerToolCapability(params);
  const invoke = capability.match<
    () => Promise<ResultType<unknown, ToolPluginInvocationError | ToolPluginCapabilityError>>
  >({
    err: (error) => async () => Result.err(error),
    ok: (value) => () =>
      captureAsyncHook(
        {
          pluginId: params.pluginId,
          source: params.source,
          hook: "level2.call",
          itemId: value.id,
        },
        () => value.call.call(params.tool, params.callableId, params.input, params.opts),
      ),
  });
  return invoke();
}
