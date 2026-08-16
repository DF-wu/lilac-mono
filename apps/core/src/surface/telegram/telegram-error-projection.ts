import { Panic } from "better-result";
import { GrammyError, HttpError, type BotError, type Context } from "grammy";
import { z } from "zod";

const telegramApiErrorSchema = z
  .object({
    error_code: z.number().optional(),
    description: z.string().optional(),
    parameters: z.object({ retry_after: z.number().finite().nonnegative().optional() }).optional(),
  })
  .refine(
    (value) =>
      value.error_code !== undefined ||
      value.description !== undefined ||
      value.parameters !== undefined,
  );

export class TelegramAdapterUnavailable extends Error {
  override readonly name = "TelegramAdapterUnavailable";
}

export type TelegramErrorProjection = {
  readonly kind: "adapter-unavailable" | "grammy" | "http" | "error" | "response" | "opaque";
  readonly error: Error;
  readonly message: string;
  readonly normalizedText: string;
  readonly errorCode?: number;
  readonly retryAfterSeconds?: number;
};

export function projectTelegramError(fallback: string): (cause: unknown) => TelegramErrorProjection;
export function projectTelegramError(cause: unknown, fallback: string): TelegramErrorProjection;
export function projectTelegramError(
  causeOrFallback: unknown,
  fallback?: string,
): TelegramErrorProjection | ((cause: unknown) => TelegramErrorProjection) {
  if (fallback === undefined) {
    const projectedFallback =
      typeof causeOrFallback === "string" ? causeOrFallback : "Telegram operation failed";
    return (cause) => projectTelegramError(cause, projectedFallback);
  }
  if (Panic.is(causeOrFallback)) throw causeOrFallback;

  const parsed = telegramApiErrorSchema.safeParse(causeOrFallback);
  const description = parsed.success ? parsed.data.description : undefined;
  const message =
    description ?? (causeOrFallback instanceof Error ? causeOrFallback.message : fallback);
  const error = causeOrFallback instanceof Error ? causeOrFallback : new Error(message);
  const normalizedText = `${description ?? ""} ${error.message}`.toLowerCase();
  const apiFields = parsed.success
    ? {
        ...(parsed.data.error_code === undefined ? {} : { errorCode: parsed.data.error_code }),
        ...(parsed.data.parameters?.retry_after === undefined
          ? {}
          : { retryAfterSeconds: parsed.data.parameters.retry_after }),
      }
    : {};

  if (causeOrFallback instanceof TelegramAdapterUnavailable) {
    return { kind: "adapter-unavailable", error, message, normalizedText, ...apiFields };
  }
  if (causeOrFallback instanceof GrammyError) {
    return { kind: "grammy", error, message, normalizedText, ...apiFields };
  }
  if (causeOrFallback instanceof HttpError) {
    return { kind: "http", error, message, normalizedText, ...apiFields };
  }
  if (causeOrFallback instanceof Error) {
    return { kind: "error", error, message, normalizedText, ...apiFields };
  }
  if (parsed.success) {
    return { kind: "response", error, message, normalizedText, ...apiFields };
  }
  return { kind: "opaque", error, message, normalizedText };
}

export function projectTelegramBotFailure(failure: BotError<Context>): {
  readonly updateId: number;
  readonly error: TelegramErrorProjection;
} {
  return {
    updateId: failure.ctx.update.update_id,
    error: projectTelegramError(failure.error, "Telegram update handler failed"),
  };
}
