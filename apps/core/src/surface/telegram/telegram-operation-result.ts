import { Panic, Result } from "better-result";

import {
  SurfaceInvalidInput,
  SurfaceMessageNotFound,
  SurfaceOperationUnsupported,
  SurfacePermissionDenied,
  SurfacePlatformMismatch,
  SurfaceRateLimited,
  SurfaceSessionMismatch,
  SurfaceUnavailable,
  type SurfaceOperation,
  type SurfaceOperationError,
  type SurfaceOperationResult,
  type SurfaceSendPreparationInput,
} from "../adapter";
import type { MsgRef, SendOpts, SessionRef, TelegramMsgRef, TelegramSessionRef } from "../types";
import { captureError } from "../../shared/error-capture";
import {
  projectTelegramError,
  TelegramAdapterUnavailable,
  type TelegramErrorProjection,
} from "./telegram-error-projection";

export { TelegramAdapterUnavailable };

export function classifyTelegramSurfaceError(
  operation: SurfaceOperation,
  cause: TelegramErrorProjection,
): SurfaceOperationError | null {
  if (cause.kind === "adapter-unavailable" || cause.kind === "http") {
    return new SurfaceUnavailable({ platform: "telegram", operation, message: cause.message });
  }
  if (cause.message.startsWith("telegram: invalid")) {
    return new SurfaceInvalidInput({
      platform: "telegram",
      operation,
      field: cause.message.includes("message id") ? "messageId" : "sessionRef.channelId",
      message: cause.message,
    });
  }

  const { errorCode, retryAfterSeconds, normalizedText } = cause;
  if (
    normalizedText.includes("message to edit not found") ||
    normalizedText.includes("message to delete not found") ||
    normalizedText.includes("message not found") ||
    normalizedText.includes("message can't be edited") ||
    normalizedText.includes("message identifier is not specified")
  ) {
    return new SurfaceMessageNotFound({ platform: "telegram", operation, message: cause.message });
  }
  if (errorCode === 401 || errorCode === 403) {
    return new SurfacePermissionDenied({ platform: "telegram", operation, message: cause.message });
  }
  if (errorCode === 429 || retryAfterSeconds !== undefined) {
    return new SurfaceRateLimited({
      platform: "telegram",
      operation,
      ...(retryAfterSeconds === undefined
        ? {}
        : { retryAfterMs: Math.ceil(retryAfterSeconds * 1000) }),
      message: cause.message,
    });
  }
  if (errorCode === 400) {
    return new SurfaceInvalidInput({
      platform: "telegram",
      operation,
      field: "request",
      message: cause.message,
    });
  }
  if (errorCode !== undefined && errorCode >= 500) {
    return new SurfaceUnavailable({ platform: "telegram", operation, message: cause.message });
  }
  return null;
}

export async function captureTelegramOperation<T>(
  operation: SurfaceOperation,
  effect: () => Promise<T>,
): Promise<SurfaceOperationResult<T>> {
  const captured = await Result.tryPromise({
    try: effect,
    catch: (cause) => captureError(cause, "Telegram operation failed"),
  });
  if (captured.isErr()) {
    const cause = captured.error.cause;
    if (Panic.is(cause)) throw cause;
    const projected = projectTelegramError(cause, "Telegram operation failed");
    const classified = classifyTelegramSurfaceError(operation, projected);
    if (classified) return Result.err(classified);
    throw cause;
  }
  return Result.ok(captured.value);
}

export function telegramSessionRefResult(
  operation: SurfaceOperation,
  sessionRef: SessionRef,
  refRole = "sessionRef",
): SurfaceOperationResult<TelegramSessionRef> {
  if (sessionRef.platform === "telegram") return Result.ok(sessionRef);
  return Result.err(
    new SurfacePlatformMismatch({
      operation,
      refRole,
      expectedPlatform: "telegram",
      receivedPlatform: sessionRef.platform,
      message: `Expected Telegram ${refRole}`,
    }),
  );
}

export function telegramMsgRefResult(
  operation: SurfaceOperation,
  msgRef: MsgRef,
  refRole = "msgRef",
): SurfaceOperationResult<TelegramMsgRef> {
  if (msgRef.platform === "telegram") return Result.ok(msgRef);
  return Result.err(
    new SurfacePlatformMismatch({
      operation,
      refRole,
      expectedPlatform: "telegram",
      receivedPlatform: msgRef.platform,
      message: `Expected Telegram ${refRole}`,
    }),
  );
}

export function telegramNestedMsgRefResult(input: {
  readonly operation: SurfaceOperation;
  readonly sessionRef: TelegramSessionRef;
  readonly msgRef: MsgRef;
  readonly refRole: string;
}): SurfaceOperationResult<TelegramMsgRef> {
  return telegramMsgRefResult(input.operation, input.msgRef, input.refRole).andThen((ref) =>
    ref.channelId === input.sessionRef.channelId
      ? Result.ok(ref)
      : Result.err(
          new SurfaceSessionMismatch({
            operation: input.operation,
            refRole: input.refRole,
            expectedSessionId: input.sessionRef.channelId,
            receivedSessionId: ref.channelId,
            message: `Expected ${input.refRole} in Telegram session ${input.sessionRef.channelId}`,
          }),
        ),
  );
}

export function telegramInvalidInput(
  operation: SurfaceOperation,
  field: string,
  message: string,
): SurfaceInvalidInput {
  return new SurfaceInvalidInput({ platform: "telegram", operation, field, message });
}

export function prepareTelegramSendResult(
  sessionRef: SessionRef,
  input: SurfaceSendPreparationInput,
  opts?: SendOpts,
): SurfaceOperationResult<TelegramSessionRef> {
  return telegramSessionRefResult("send-message", sessionRef).andThen((ref) => {
    if (!input.text?.trim()) {
      return Result.err(
        telegramInvalidInput(
          "send-message",
          "content.text",
          "Telegram messages require non-empty text",
        ),
      );
    }
    if (input.attachmentCount > 0) {
      return Result.err(
        telegramUnsupported(
          "send-message",
          "Telegram direct sends do not support attachments; use an output stream",
        ),
      );
    }
    if (!opts?.replyTo) return Result.ok(ref);
    return telegramNestedMsgRefResult({
      operation: "send-message",
      sessionRef: ref,
      msgRef: opts.replyTo,
      refRole: "replyTo",
    }).map(() => ref);
  });
}

export function telegramUnsupported(
  operation: SurfaceOperation,
  message: string,
): SurfaceOperationUnsupported {
  return new SurfaceOperationUnsupported({ platform: "telegram", operation, message });
}
