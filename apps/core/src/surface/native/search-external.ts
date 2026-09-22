import { Buffer } from "node:buffer";
import { Result, type Result as ResultType } from "better-result";
import type { DisplayMessage } from "@stanley2058/lilac-client-protocol";
import type { SurfaceAdapterResolver } from "../runtime-descriptor";
import type { SurfaceSession } from "../types";
import type { NativeClerkAuthenticator } from "./auth-clerk";
import type { NativeUser } from "./codec";
import { nativeFailure } from "./errors";
import type { NativeStoreError } from "./store";

export type ExternalThreadDisplay = {
  id: string;
  sourceUrl?: string;
  title: string;
  surface: "discord" | "github";
  retrievedAt: number;
  updatedAt?: number;
};
type UserLookup = (userId: string) => ResultType<NativeUser, NativeStoreError>;

export function externalThreadId(platform: "discord" | "github", sessionId: string): string {
  return `${platform}_${Buffer.from(sessionId).toString("base64url")}`;
}

function parseExternalThreadId(
  id: string,
): ResultType<{ platform: "discord" | "github"; sessionId: string }, NativeStoreError> {
  const match = /^(discord|github)_([A-Za-z0-9_-]+)$/.exec(id);
  if (!match) return Result.err(nativeFailure("invalid", "Invalid external thread identifier"));
  const platform = match[1] === "discord" ? "discord" : "github";
  const sessionId = Buffer.from(match[2]!, "base64url").toString("utf8");
  if (!sessionId || externalThreadId(platform, sessionId) !== id)
    return Result.err(nativeFailure("invalid", "Invalid external thread identifier"));
  return Result.ok({ platform, sessionId });
}

function owner(getUser: UserLookup, userId: string): ResultType<void, NativeStoreError> {
  return getUser(userId).andThen((user) =>
    user.role === "owner"
      ? Result.ok()
      : Result.err(nativeFailure("forbidden", "Only the owner can read external threads")),
  );
}

function displaySession(
  session: SurfaceSession,
  retrievedAt: number,
): ExternalThreadDisplay | undefined {
  if (session.ref.platform !== "discord" && session.ref.platform !== "github") return undefined;
  const id = externalThreadId(session.ref.platform, session.ref.channelId);
  if (id.length > 128) return undefined;
  return {
    id,
    title: (session.title ?? "Untitled conversation").slice(0, 512),
    updatedAt: session.updatedAt,
    surface: session.ref.platform,
    retrievedAt,
    sourceUrl: externalSourceUrl(session.ref),
  };
}

function externalSourceUrl(ref: SurfaceSession["ref"]): string | undefined {
  if (ref.platform !== "discord") return undefined;
  return `https://discord.com/channels/${ref.guildId ?? "@me"}/${ref.channelId}`;
}

export class NativeExternalThreads {
  constructor(
    private readonly params: {
      getUser: UserLookup;
      profileProvider?: Pick<NativeClerkAuthenticator, "lookupUser">;
      adapters: SurfaceAdapterResolver;
      now?: () => number;
      knownSessions?: () => readonly SurfaceSession[];
    },
  ) {}

  async list(
    userId: string,
    input: { cursor?: string; limit?: number },
  ): Promise<
    ResultType<{ items: ExternalThreadDisplay[]; nextCursor?: string }, NativeStoreError>
  > {
    return Result.gen(async function* () {
      yield* owner(this.params.getUser, userId);
      const now = this.params.now?.() ?? Date.now();
      const items: ExternalThreadDisplay[] = [];
      for (const session of this.params.knownSessions?.() ?? []) {
        const display = displaySession(session, now);
        if (display) items.push(display);
      }
      for (const platform of ["discord", "github"] as const) {
        const resolved = this.params.adapters.resolve(platform);
        if (!resolved) continue;
        const sessions = yield* Result.await(
          resolved.adapter
            .listSessions({ limit: Number.MAX_SAFE_INTEGER })
            .then((result) =>
              result.tryRecover((error) =>
                error._tag === "SurfaceOperationUnsupported"
                  ? Result.ok([])
                  : Result.err(nativeFailure("invalid", error.message)),
              ),
            ),
        );
        for (const session of sessions) {
          const display = displaySession(session, now);
          if (display) items.push(display);
        }
      }
      const byId = new Map<string, ExternalThreadDisplay>();
      for (const item of items) {
        const previous = byId.get(item.id);
        byId.set(item.id, {
          ...item,
          updatedAt: Math.max(previous?.updatedAt ?? 0, item.updatedAt ?? 0),
        });
      }
      const unique = [...byId.values()];
      unique.sort(
        (left, right) =>
          (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || left.id.localeCompare(right.id),
      );
      const limit = Math.min(100, Math.max(1, input.limit ?? 30));
      const cursorIndex = input.cursor ? unique.findIndex((item) => item.id === input.cursor) : -1;
      if (input.cursor && cursorIndex === -1) return Result.ok({ items: [] });
      const start = cursorIndex + 1;
      const page = unique.slice(start, start + limit);
      return Result.ok({
        items: page,
        ...(start + limit < unique.length ? { nextCursor: page.at(-1)!.id } : {}),
      });
    }, this);
  }

  private async linkedDiscordIds(
    userId: string,
    platform: "discord" | "github",
  ): Promise<ResultType<readonly string[], NativeStoreError>> {
    return Result.gen(async function* () {
      if (platform !== "discord" || !this.params.profileProvider) return Result.ok([]);
      const viewer = yield* this.params.getUser(userId);
      const profile = await this.params.profileProvider.lookupUser(viewer.providerId);
      return Result.ok(
        profile.match({
          ok: (user) =>
            user.providerUserId === viewer.providerId ? (user.discordUserIds ?? []) : [],
          err: () => [],
        }),
      );
    }, this);
  }

  async read(
    userId: string,
    input: { threadId: string; cursor?: string },
  ): Promise<
    ResultType<
      { thread: ExternalThreadDisplay; messages: DisplayMessage[]; nextCursor?: string },
      NativeStoreError
    >
  > {
    return Result.gen(async function* () {
      yield* owner(this.params.getUser, userId);
      const ref = yield* parseExternalThreadId(input.threadId);
      const resolved = this.params.adapters.resolve(ref.platform);
      if (!resolved)
        return Result.err(nativeFailure("not-found", "External surface is unavailable"));
      const page = input.cursor ? Number(input.cursor) : 1;
      if (ref.platform === "github" && (!Number.isSafeInteger(page) || page < 1))
        return Result.err(nativeFailure("invalid", "Invalid external page"));
      const messages = yield* Result.await(
        resolved.adapter
          .listMsg(
            { platform: ref.platform, channelId: ref.sessionId },
            ref.platform === "github"
              ? { limit: 50, page }
              : { limit: 50, beforeMessageId: input.cursor },
          )
          .then((result) => result.mapError((error) => nativeFailure("invalid", error.message))),
      );
      const linkedDiscordIds = yield* Result.await(this.linkedDiscordIds(userId, ref.platform));
      const visible = messages.filter((message) => !message.deleted);
      const display: DisplayMessage[] = visible.map((message) => ({
        id: Buffer.from(message.ref.messageId).toString("base64url"),
        role: "user",
        metadata: {
          createdAt: message.ts,
          ...(linkedDiscordIds.includes(message.userId) ? { authorId: userId } : {}),
          authorDisplayName: `${(message.userName ?? message.userId).slice(0, 240)} (${ref.platform === "discord" ? "Discord" : "GitHub"})`,
        },
        parts: [
          {
            type: "text",
            text: message.text.slice(0, 65_536),
          },
        ],
      }));
      const sessions = yield* Result.await(
        resolved.adapter
          .listSessions({ limit: Number.MAX_SAFE_INTEGER })
          .then((result) =>
            result.tryRecover((error) =>
              error._tag === "SurfaceOperationUnsupported"
                ? Result.ok([])
                : Result.err(nativeFailure("invalid", error.message)),
            ),
          ),
      );
      const session = sessions.find((item) => item.ref.channelId === ref.sessionId);
      const now = this.params.now?.() ?? Date.now();
      return Result.ok({
        thread: {
          id: input.threadId,
          title: (session?.title ?? "Untitled conversation").slice(0, 512),
          updatedAt: session?.updatedAt,
          surface: ref.platform,
          retrievedAt: now,
          sourceUrl: externalSourceUrl(
            session?.ref ?? { platform: ref.platform, channelId: ref.sessionId },
          ),
        },
        messages: display,
        ...(messages.length === 50
          ? {
              nextCursor:
                ref.platform === "github"
                  ? String(page + 1)
                  : [...messages].sort((a, b) => a.ts - b.ts)[0]!.ref.messageId,
            }
          : {}),
      });
    }, this);
  }
}
