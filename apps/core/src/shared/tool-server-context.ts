import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { RequestContext } from "../tool-server/types";
import { isAdapterPlatform } from "./is-adapter-platform";

export type RequiredToolServerHeaders = {
  request_id: string;
  request_delivery_id?: string;
  session_id: string;
  request_client: AdapterPlatform;
};

export class ToolServerContextInvalidError extends TaggedError("ToolServerContextInvalidError")<{
  readonly label: string;
  readonly message: string;
}> {}

export function decodeToolServerHeaders(
  ctx: RequestContext | undefined,
  label: string,
): ResultType<RequiredToolServerHeaders, ToolServerContextInvalidError> {
  const requestId = ctx?.requestId;
  const sessionId = ctx?.sessionId;
  const requestClient = ctx?.requestClient;

  if (!requestId || !sessionId || !requestClient) {
    return Result.err(
      new ToolServerContextInvalidError({
        label,
        message: `${label} tool requires request context (requestId/sessionId/requestClient)`,
      }),
    );
  }

  if (!isAdapterPlatform(requestClient)) {
    return Result.err(
      new ToolServerContextInvalidError({
        label,
        message: `Invalid requestClient '${requestClient}'`,
      }),
    );
  }

  return Result.ok({
    request_id: requestId,
    ...(ctx.requestDeliveryId ? { request_delivery_id: ctx.requestDeliveryId } : {}),
    session_id: sessionId,
    request_client: requestClient,
  });
}

export function requireToolServerHeaders(
  ctx: RequestContext | undefined,
  label: string,
): RequiredToolServerHeaders {
  const outcome = decodeToolServerHeaders(ctx, label).match<
    | { readonly kind: "ok"; readonly value: RequiredToolServerHeaders }
    | { readonly kind: "error"; readonly error: ToolServerContextInvalidError }
  >({
    ok: (value) => ({ kind: "ok", value }),
    err: (error) => ({ kind: "error", error }),
  });
  if (outcome.kind === "ok") return outcome.value;
  throw outcome.error;
}
