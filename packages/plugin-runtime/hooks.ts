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
  type ToolPluginCapabilityError,
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
  cause: unknown,
): ToolPluginInvocationError {
  if (isPluginPanic(cause)) throw cause;
  let isSkip = false;
  try {
    isSkip = cause instanceof ToolPluginSkipError;
  } catch {
    isSkip = false;
  }
  if (isSkip) {
    const reason = opaquePluginExceptionMessage(cause);
    return new ToolPluginSkipped({
      pluginId: context.pluginId,
      source: context.source,
      reason,
      message: `Plugin '${context.pluginId}' skipped: ${reason}`,
    });
  }
  return new ToolPluginHookError({
    ...context,
    cause: safePluginExceptionCause(cause),
    message: `Plugin '${context.pluginId}' ${context.hook} failed: ${opaquePluginExceptionMessage(cause)}`,
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

function captureSyncHook(
  context: HookContext,
  run: () => unknown,
): ResultType<unknown, ToolPluginInvocationError> {
  try {
    return Result.ok(run());
  } catch (cause) {
    if (isPluginPanic(cause)) throw cause;
    return Result.err(mapPluginHookException(context, cause));
  }
}

async function captureAsyncHook<T>(
  context: HookContext,
  run: () => Promise<T> | T,
): Promise<ResultType<T, ToolPluginInvocationError>> {
  try {
    return Result.ok(await run());
  } catch (cause) {
    if (isPluginPanic(cause)) throw cause;
    return Result.err(mapPluginHookException(context, cause));
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
    Reflect.apply(params.capability.create, params.capability.plugin, [params.context]),
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
  const invoked = await captureAsyncHook(context, () =>
    Reflect.apply(params.capability.init!, params.capability.instance, []),
  );
  if (invoked.status === "error") return invoked;
  return decodeVoidHookResult(params.pluginId, invoked.value);
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
  const invoked = await captureAsyncHook(context, () =>
    Reflect.apply(params.capability.destroy!, params.capability.instance, []),
  );
  if (invoked.status === "error") return invoked;
  return decodeVoidHookResult(params.pluginId, invoked.value);
}

export function invokeLevel1CreateTool<TRuntimeContext>(params: {
  pluginId: string;
  source: PluginSource;
  spec: Level1ToolSpec<TRuntimeContext>;
  capability?: Level1ToolSpecCapabilitySnapshot<TRuntimeContext>;
  context: Level1ToolBuildContext<TRuntimeContext>;
}): ResultType<unknown, ToolPluginInvocationError | ToolPluginCapabilityError> {
  const capability = resolveLevel1Capability(params);
  if (capability.status === "error") return capability;
  return captureSyncHook(
    {
      pluginId: params.pluginId,
      source: params.source,
      hook: "level1.createTool",
      itemId: capability.value.name,
    },
    () => Reflect.apply(capability.value.createTool, params.spec, [params.context]),
  );
}

export function invokeLevel1IsEnabled<TRuntimeContext>(params: {
  pluginId: string;
  source: PluginSource;
  spec: Level1ToolSpec<TRuntimeContext>;
  capability?: Level1ToolSpecCapabilitySnapshot<TRuntimeContext>;
  context: Level1ToolRunContext<TRuntimeContext>;
}): ResultType<boolean, ToolPluginInvocationError | ToolPluginCapabilityError> {
  const capability = resolveLevel1Capability(params);
  if (capability.status === "error") return capability;
  const invoked = captureSyncHook(
    {
      pluginId: params.pluginId,
      source: params.source,
      hook: "level1.isEnabled",
      itemId: capability.value.name,
    },
    () => Reflect.apply(capability.value.isEnabled, params.spec, [params.context]),
  );
  if (invoked.status === "error") return invoked;
  return decodeBooleanHookResult(params.pluginId, invoked.value);
}

export async function invokeLevel1EditTargets(params: {
  pluginId: string;
  source: PluginSource;
  spec: Level1ToolSpec<unknown>;
  capability?: Level1ToolSpecCapabilitySnapshot<unknown>;
  args: unknown;
  cwd: string;
}): Promise<
  ResultType<readonly string[] | undefined, ToolPluginInvocationError | ToolPluginCapabilityError>
> {
  const capability = resolveLevel1Capability(params);
  if (capability.status === "error") return capability;
  if (capability.value.editTargets === undefined) return Result.ok(undefined);
  const context = {
    pluginId: params.pluginId,
    source: params.source,
    hook: "level1.editTargets",
    itemId: capability.value.name,
  } satisfies HookContext;
  const invoked = await captureAsyncHook(context, () =>
    Reflect.apply(capability.value.editTargets!, params.spec, [params.args, { cwd: params.cwd }]),
  );
  if (invoked.status === "error") return invoked;
  const collected = captureSyncHook(context, () => Array.from(invoked.value));
  if (collected.status === "error") return collected;
  return decodeStringArrayHookResult(params.pluginId, collected.value);
}

export function invokeLevel1FormatArgs(params: {
  pluginId: string;
  source: PluginSource;
  spec: Level1ToolSpec<unknown>;
  capability?: Level1ToolSpecCapabilitySnapshot<unknown>;
  args: unknown;
}): ResultType<string | undefined, ToolPluginInvocationError | ToolPluginCapabilityError> {
  const capability = resolveLevel1Capability(params);
  if (capability.status === "error") return capability;
  if (capability.value.formatArgs === undefined) return Result.ok(undefined);
  const invoked = captureSyncHook(
    {
      pluginId: params.pluginId,
      source: params.source,
      hook: "level1.formatArgs",
      itemId: capability.value.name,
    },
    () => Reflect.apply(capability.value.formatArgs!, params.spec, [params.args]),
  );
  if (invoked.status === "error") return invoked;
  return decodeStringHookResult(params.pluginId, invoked.value);
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
  if (capability.status === "error") return capability;
  if (capability.value.summarizeFailure === undefined) return Result.ok(undefined);
  const invoked = captureSyncHook(
    {
      pluginId: params.pluginId,
      source: params.source,
      hook: "level1.summarizeFailure",
      itemId: capability.value.name,
    },
    () => Reflect.apply(capability.value.summarizeFailure!, params.spec, [params.value]),
  );
  if (invoked.status === "error") return invoked;
  return decodeLevel1ToolFailureSummary(params.pluginId, invoked.value);
}

async function invokeLevel2VoidHook(params: {
  pluginId: string;
  source: PluginSource;
  tool: ServerTool;
  capability?: ServerToolCapabilitySnapshot;
  hook: "level2.init" | "level2.destroy";
}): Promise<ResultType<void, ToolPluginInvocationError | ToolPluginCapabilityError>> {
  const capability = resolveServerToolCapability(params);
  if (capability.status === "error") return capability;
  const method = params.hook === "level2.init" ? capability.value.init : capability.value.destroy;
  const context = {
    pluginId: params.pluginId,
    source: params.source,
    hook: params.hook,
    itemId: capability.value.id,
  } satisfies HookContext;
  const invoked = await captureAsyncHook(context, () => Reflect.apply(method, params.tool, []));
  if (invoked.status === "error") return invoked;
  return decodeVoidHookResult(params.pluginId, invoked.value);
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
  if (capability.status === "error") return capability;
  const invoked = await captureAsyncHook(
    {
      pluginId: params.pluginId,
      source: params.source,
      hook: "level2.list",
      itemId: capability.value.id,
    },
    () => Reflect.apply(capability.value.list, params.tool, []),
  );
  if (invoked.status === "error") return invoked;
  return decodeServerToolListResult(params.pluginId, invoked.value);
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
  if (capability.status === "error") return Promise.resolve(capability);
  return captureAsyncHook(
    {
      pluginId: params.pluginId,
      source: params.source,
      hook: "level2.call",
      itemId: capability.value.id,
    },
    () =>
      Reflect.apply(capability.value.call, params.tool, [
        params.callableId,
        params.input,
        params.opts,
      ]),
  );
}
