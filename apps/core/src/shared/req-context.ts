import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import { isRecord } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { isAdapterPlatform } from "./is-adapter-platform";

export type RequiredRequestContext = {
  requestId: string;
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
    const sessionId = ctx["sessionId"];
    const requestClient = ctx["requestClient"];
    if (
      typeof requestId === "string" &&
      typeof sessionId === "string" &&
      isAdapterPlatform(requestClient)
    ) {
      return Result.ok({ requestId, sessionId, requestClient });
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
  const decoded = decodeRequiredRequestContext(ctx, label);
  if (decoded.status === "ok") return decoded.value;
  throw decoded.error;
}
