import { Result } from "better-result";
import {
  serverToolFailure,
  type ServerToolResult,
  type ServerToolFailure,
} from "@stanley2058/lilac-plugin-runtime";
import type { RequestContext } from "../../tool-server/types";
import type { NativeSearchService } from "./search";
import type { NativeStoreError, NativeStoreResult } from "./store";

function failureKind(code: string): ServerToolFailure["kind"] {
  switch (code) {
    case "forbidden":
      return "denied";
    case "not-found":
      return "not_found";
    case "invalid":
      return "usage";
    default:
      return "internal";
  }
}

function searchFailure(error: NativeStoreError) {
  if (error._tag !== "NativeStoreFailure")
    return serverToolFailure({
      kind: "internal",
      code: "native_search_storage",
      message: "Conversation storage is unavailable",
      retryable: false,
    });
  const kind = failureKind(error.code);
  return serverToolFailure({
    kind,
    code: `native_search_${error.code}`,
    message: error.message,
    retryable: false,
  });
}

export function nativeSearchTool<T>(
  service: NativeSearchService | undefined,
  context: RequestContext | undefined,
  run: (service: NativeSearchService, userId: string) => NativeStoreResult<T>,
): ServerToolResult<T> {
  if (!service)
    return Result.err(
      serverToolFailure({
        kind: "unavailable",
        code: "native_search_unavailable",
        message: "Native conversation search is unavailable",
        retryable: true,
      }),
    );
  return service
    .principal(context)
    .andThen((userId) => run(service, userId))
    .mapError(searchFailure);
}

export function isNativeSearchContext(context?: RequestContext): boolean {
  return context?.requestClient === "native" || context?.requestInitiator?.platform === "native";
}

export async function nativeSearchToolAsync<T>(
  service: NativeSearchService | undefined,
  context: RequestContext | undefined,
  run: (service: NativeSearchService, userId: string) => Promise<NativeStoreResult<T>>,
): Promise<ServerToolResult<T>> {
  if (!service)
    return Result.err(
      serverToolFailure({
        kind: "unavailable",
        code: "native_search_unavailable",
        message: "Native conversation search is unavailable",
        retryable: true,
      }),
    );
  return (
    await Result.gen(async function* () {
      const userId = yield* service.principal(context);
      const value = yield* Result.await(run(service, userId));
      return Result.ok(value);
    })
  ).mapError(searchFailure);
}
