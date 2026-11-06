import path from "node:path";

import { Result, TaggedError, type Result as ResultType } from "better-result";

import { env } from "../env";

import type { CoreConfig } from "./types";

/**
 * Fork-owned Telegram runtime helpers over a parsed `CoreConfig`. Separate from
 * `telegram-surface.ts` because these need `env`, which the schema modules must
 * not load.
 */

export function resolveTelegramDbPath(cfg: CoreConfig): string {
  return cfg.surface.telegram.dbPath ?? path.join(env.dataDir, "telegram-surface.db");
}

export function resolveTelegramToken(cfg: CoreConfig): string {
  return adaptTelegramTokenResultToHost(resolveTelegramTokenResult(cfg));
}

function adaptTelegramTokenResultToHost(result: ResultType<string, TelegramTokenMissing>): string {
  const resolved = result.match<
    { readonly value: string } | { readonly error: TelegramTokenMissing }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}

export class TelegramTokenMissing extends TaggedError("TelegramTokenMissing")<{
  readonly message: string;
}> {}

export function resolveTelegramTokenResult(
  cfg: CoreConfig,
): ResultType<string, TelegramTokenMissing> {
  const value = cfg.surface.telegram.token;
  if (!value) {
    return Result.err(
      new TelegramTokenMissing({
        message: "Telegram token missing: set surface.telegram.token in core-config.yaml",
      }),
    );
  }
  return Result.ok(value);
}

export function isTelegramSurfaceUsable(cfg: CoreConfig): boolean {
  return cfg.surface.telegram.enabled && Boolean(cfg.surface.telegram.token);
}
