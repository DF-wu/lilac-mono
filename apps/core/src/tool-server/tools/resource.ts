import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { resolve } from "node:path";

import {
  RESOURCE_MATERIALIZE_CALL_MAX_BYTES,
  RESOURCE_MATERIALIZE_MAX_COUNT,
  bindTransientResourceAccess,
  isCoreToolResultResourceUri,
  ResourceNotFound,
  type MaterializedResource,
  type ResourceAccess,
  type ResourceAccessError,
  type ResourceMaterializeOptions,
  type ScopedTransientResourceAccess,
} from "../../resource";
import type { ToolResultArtifactStore } from "../../artifacts/tool-result-artifact-store";
import { captureError } from "../../shared/error-capture";
import { preserveToolPanic } from "../../tools/tool-result-adapters";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import { Panic, Result, type Result as ResultType } from "better-result";
import { z } from "zod/v4";

import {
  formatToolPathForRequestContext,
  resolveToolPathForRequestContextResult,
} from "../../shared/attachment-utils";
import {
  defineServerTool,
  type RequestContext,
  type ServerTool,
  type ServerToolCallOptions,
} from "../types";
import { requestInvocationCwd } from "../request-invocation-cwd";

type ResourceMaterializeErrorCode =
  | "invalid_uri"
  | "not_found"
  | "origin_unavailable"
  | "too_large"
  | "batch_limit"
  | "cache_unavailable"
  | "already_exists"
  | "write_failed"
  | "cancelled";

type ResourceMaterializeItemError = {
  readonly code: ResourceMaterializeErrorCode;
  readonly message: string;
  readonly retryable: boolean;
};

type ResourceMaterializeItem =
  | ({ readonly status: "ok" } & MaterializedResource)
  | {
      readonly uri: string;
      readonly status: "error";
      readonly error: ResourceMaterializeItemError;
    };

export type ResourceMaterializeOutput = {
  readonly results: readonly ResourceMaterializeItem[];
};

type ResourceToolLimits = {
  readonly materializeCallMaxBytes: number;
  readonly materializeMaxCount: number;
};

const resourceMaterializeInputSchema = z.object({
  uris: z
    .array(z.string().min(1))
    .min(1)
    .max(RESOURCE_MATERIALIZE_MAX_COUNT)
    .describe("Resource URIs to materialize in input order"),
});

function resourceToolFailure(
  kind: ServerToolFailure["kind"],
  code: string,
  message: string,
): ServerToolFailure {
  return serverToolFailure({ kind, code, message, retryable: false });
}

function resourceError(error: ResourceAccessError): ResourceMaterializeItemError {
  switch (error._tag) {
    case "ResourceInvalidUri":
      return { code: "invalid_uri", message: error.message, retryable: false };
    case "ResourceNotFound":
      return { code: "not_found", message: error.message, retryable: false };
    case "ResourceOriginUnavailable":
      return {
        code: "origin_unavailable",
        message: error.message,
        retryable: error.retryable,
      };
    case "ResourceTooLarge":
      return {
        code: error.limitKind === "operation" ? "batch_limit" : "too_large",
        message: error.message,
        retryable: false,
      };
    case "ResourceCacheUnavailable":
      return { code: "cache_unavailable", message: error.message, retryable: error.retryable };
    case "ResourceAlreadyExists":
      return { code: "already_exists", message: error.message, retryable: false };
    case "ResourceWriteFailed":
      return { code: "write_failed", message: error.message, retryable: true };
    case "ResourceCancelled":
      return { code: "cancelled", message: error.message, retryable: false };
    case "ResourceIntegrityFailure":
    case "ResourceUnsupportedClassification":
      return { code: "cache_unavailable", message: error.message, retryable: false };
  }
}

function cancelledItem(uri: string): ResourceMaterializeItem {
  return {
    uri,
    status: "error",
    error: {
      code: "cancelled",
      message: `Resource materialization cancelled: ${uri}`,
      retryable: false,
    },
  };
}

async function materializeSelectedResource(input: {
  readonly uri: string;
  readonly options: ResourceMaterializeOptions;
  readonly retainedAccess: ResourceAccess;
  readonly transientAccess?: ScopedTransientResourceAccess;
}): Promise<ResultType<MaterializedResource, ResourceAccessError>> {
  if (!isCoreToolResultResourceUri(input.uri)) {
    return input.retainedAccess.materialize(input.uri, input.options);
  }
  if (!input.transientAccess) {
    return Result.err(
      new ResourceNotFound({
        uri: input.uri,
        message: "Transient resource is unavailable without a session scope",
      }),
    );
  }
  return input.transientAccess.materialize(input.uri, input.options);
}

async function establishTargetDirectory(
  ctx: RequestContext | undefined,
): Promise<ResultType<string, ServerToolFailure>> {
  if (!ctx?.cwd) {
    return Result.err(
      resourceToolFailure(
        "usage",
        "resource_context_missing",
        "resource.materialize requires request context with a working directory",
      ),
    );
  }

  const invocationCwd = requestInvocationCwd(ctx) ?? ctx.cwd;

  const targetResult: ResultType<string, ServerToolFailure> =
    ctx.safetyMode !== "restricted"
      ? Result.ok(resolve(invocationCwd))
      : resolveToolPathForRequestContextResult({
          cwd: invocationCwd,
          inputPath: ".",
          context: ctx,
        }).mapError((error) =>
          resourceToolFailure("denied", "resource_target_denied", error.message),
        );
  const targetOutcome = targetResult.match<
    { readonly targetDirectory: string } | { readonly failure: ServerToolFailure }
  >({
    ok: (targetDirectory) => ({ targetDirectory }),
    err: (failure) => ({ failure }),
  });
  if ("failure" in targetOutcome) return Result.err(targetOutcome.failure);

  const targetDirectory = targetOutcome.targetDirectory;
  const prepared = await Result.tryPromise({
    try: async () => {
      if (ctx.safetyMode === "restricted") {
        await fs.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      } else {
        const stat = await fs.stat(targetDirectory);
        if (!stat.isDirectory()) throw new Error("Request cwd is not a directory");
      }
      await fs.access(targetDirectory, fsConstants.W_OK);
    },
    catch: (cause) => captureError(cause, "Resource target preparation failed"),
  });
  const preparationFailure = prepared.match<Error | null>({
    ok: () => null,
    err: ({ cause }) => cause,
  });
  if (preparationFailure === null) return Result.ok(targetDirectory);
  if (Panic.is(preparationFailure)) preserveToolPanic(preparationFailure);
  return Result.err(
    resourceToolFailure(
      "denied",
      "resource_target_unavailable",
      "The request working directory is unavailable for resource materialization",
    ),
  );
}

export class Resource implements ServerTool {
  id = "resource";
  private readonly tool: ServerTool;
  private readonly limits: ResourceToolLimits;

  constructor(
    private readonly params: {
      access: ResourceAccess;
      toolResultArtifacts?: ToolResultArtifactStore;
      limits?: Partial<ResourceToolLimits>;
    },
  ) {
    this.limits = {
      materializeCallMaxBytes:
        params.limits?.materializeCallMaxBytes ?? RESOURCE_MATERIALIZE_CALL_MAX_BYTES,
      materializeMaxCount: params.limits?.materializeMaxCount ?? RESOURCE_MATERIALIZE_MAX_COUNT,
    };
    this.tool = defineServerTool({
      id: this.id,
      callables: ({ callable }) => ({
        "resource.materialize": callable({
          name: "Resource Materialize",
          description:
            "Write retained or transient resources into the invoking tools CLI working directory.",
          inputSchema: resourceMaterializeInputSchema,
          primaryPositional: {
            field: "uris",
            variadic: true,
          },
          run: (input, opts) => this.callMaterialize(input, opts?.context, opts?.signal),
        }),
      }),
    });
  }

  async init(): Promise<void> {
    await this.tool.init();
  }

  async destroy(): Promise<void> {
    await this.tool.destroy();
  }

  async list() {
    return await this.tool.list();
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return await this.tool.call(callableId, input, opts);
  }

  private async callMaterialize(
    input: z.output<typeof resourceMaterializeInputSchema>,
    ctx: RequestContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ServerToolResult<ResourceMaterializeOutput>> {
    if (input.uris.length > this.limits.materializeMaxCount) {
      return Result.err(
        resourceToolFailure(
          "usage",
          "invalid_input",
          `Expected at most ${this.limits.materializeMaxCount} resource URIs`,
        ),
      );
    }

    const targetResult = await establishTargetDirectory(ctx);
    const targetOutcome = targetResult.match<
      { readonly targetDirectory: string } | { readonly failure: ServerToolFailure }
    >({
      ok: (targetDirectory) => ({ targetDirectory }),
      err: (failure) => ({ failure }),
    });
    if ("failure" in targetOutcome) return Result.err(targetOutcome.failure);

    const transientAccess =
      this.params.toolResultArtifacts && ctx?.sessionId
        ? bindTransientResourceAccess(this.params.toolResultArtifacts, ctx.sessionId)
        : undefined;

    const results: ResourceMaterializeItem[] = [];
    let materializedBytes = 0;

    for (let index = 0; index < input.uris.length; index += 1) {
      const uri = input.uris[index]!;
      if (signal?.aborted) {
        for (const remainingUri of input.uris.slice(index)) {
          results.push(cancelledItem(remainingUri));
        }
        break;
      }

      const remainingBytes = this.limits.materializeCallMaxBytes - materializedBytes;
      if (remainingBytes <= 0) {
        results.push({
          uri,
          status: "error",
          error: {
            code: "batch_limit",
            message: `Resource materialization call exceeds ${this.limits.materializeCallMaxBytes} bytes`,
            retryable: false,
          },
        });
        continue;
      }

      const materializeOptions = {
        targetDirectory: targetOutcome.targetDirectory,
        maxBytes: remainingBytes,
        signal,
      };
      const materialized = await materializeSelectedResource({
        uri,
        options: materializeOptions,
        retainedAccess: this.params.access,
        ...(transientAccess ? { transientAccess } : {}),
      });
      const outcome = materialized.match<
        { readonly materialized: MaterializedResource } | { readonly failure: ResourceAccessError }
      >({
        ok: (value) => ({ materialized: value }),
        err: (failure) => ({ failure }),
      });
      if ("failure" in outcome) {
        const failure = signal?.aborted
          ? cancelledItem(uri)
          : { uri, status: "error" as const, error: resourceError(outcome.failure) };
        results.push(failure);
        if (signal?.aborted) {
          for (const remainingUri of input.uris.slice(index + 1)) {
            results.push(cancelledItem(remainingUri));
          }
          break;
        }
        continue;
      }

      materializedBytes += outcome.materialized.bytes;
      results.push({
        ...outcome.materialized,
        path: formatToolPathForRequestContext({
          path: outcome.materialized.path,
          context: ctx,
        }),
        status: "ok",
      });
    }

    return Result.ok({ results });
  }
}
