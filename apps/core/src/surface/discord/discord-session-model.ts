import { Result, TaggedError, type Result as ResultType } from "better-result";

export class DiscordSurfaceEditUnsupported extends TaggedError("DiscordSurfaceEditUnsupported")<{
  readonly reason: "not-author" | "multiple-embeds";
  readonly message: string;
}> {}

export function resolveDiscordSurfaceEditTargetResult(input: {
  authorId?: string | null;
  selfUserId: string;
  embedCount: number;
  content?: string | null;
}): ResultType<"content" | "embed_description", DiscordSurfaceEditUnsupported> {
  if (input.authorId !== input.selfUserId) {
    return Result.err(
      new DiscordSurfaceEditUnsupported({
        reason: "not-author",
        message: "surface.messages.edit only supports messages authored by the Lilac Discord bot",
      }),
    );
  }

  if (typeof input.content === "string" && input.content.trim().length > 0) {
    return Result.ok("content");
  }
  if (input.embedCount <= 0) return Result.ok("content");
  if (input.embedCount === 1) return Result.ok("embed_description");

  return Result.err(
    new DiscordSurfaceEditUnsupported({
      reason: "multiple-embeds",
      message:
        "surface.messages.edit only supports Discord messages with plain content or a single embed",
    }),
  );
}

export function resolveEffectiveSessionModelOverride(input: {
  sessionId: string;
  parentChannelId?: string | null;
  overrides: ReadonlyMap<string, string>;
}): string | undefined {
  const threadOverride = input.overrides.get(input.sessionId);
  if (threadOverride) return threadOverride;

  const parentChannelId = input.parentChannelId?.trim();
  if (!parentChannelId) return undefined;
  return input.overrides.get(parentChannelId);
}
