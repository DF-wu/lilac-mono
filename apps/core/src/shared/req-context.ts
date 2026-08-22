import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import { isRecord } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { isAdapterPlatform } from "./is-adapter-platform";

export type RequiredRequestContext = {
  requestId: string;
  requestDeliveryId?: string;
  sessionId: string;
  requestClient: AdapterPlatform;
};

export class RequestContextInvalidError extends TaggedError("RequestContextInvalidError")<{
  readonly label: string;
  readonly message: string;
}> {}

export function decodeRequiredRequestContext(
  ctx: unknown,
  label: string,
): ResultType<RequiredRequestContext, RequestContextInvalidError> {
  if (isRecord(ctx)) {
    const requestId = ctx["requestId"];
    const requestDeliveryId = ctx["requestDeliveryId"];
    const sessionId = ctx["sessionId"];
    const requestClient = ctx["requestClient"];
    if (
      typeof requestId === "string" &&
      typeof sessionId === "string" &&
      isAdapterPlatform(requestClient)
    ) {
      return Result.ok({
        requestId,
        ...(typeof requestDeliveryId === "string" ? { requestDeliveryId } : {}),
        sessionId,
        requestClient,
      });
    }
  }

  return Result.err(
    new RequestContextInvalidError({
      label,
      message: `${label} requires context { requestId, sessionId, requestClient }`,
    }),
  );
}

export function requireRequestContext(ctx: unknown, label: string): RequiredRequestContext {
  const outcome = decodeRequiredRequestContext(ctx, label).match<
    | { readonly kind: "ok"; readonly value: RequiredRequestContext }
    | { readonly kind: "error"; readonly error: RequestContextInvalidError }
  >({
    ok: (value) => ({ kind: "ok", value }),
    err: (error) => ({ kind: "error", error }),
  });
  if (outcome.kind === "ok") return outcome.value;
  throw outcome.error;
}
