import type { AdapterPlatform, LilacMessageForTopic } from "@stanley2058/lilac-event-bus";
import { isRecord } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { parseRequestId } from "./bridge/request-ids";
import type {
  AuthenticatedSurfaceOrigin,
  MsgRef,
  MsgRefFor,
  RegisteredSurfacePlatform,
  SessionRefFor,
} from "./types";

type AuthenticationMetadataKind =
  | "absent"
  | "actor"
  | "origin"
  | "actor-origin"
  | "github-trigger"
  | "actor-github-trigger"
  | "origin-github-trigger"
  | "actor-origin-github-trigger";

type GithubTriggerProjection = {
  readonly kind: "comment" | "issue";
  readonly repoFullName?: string;
  readonly issueNumber?: number;
  readonly messageId: string;
};

export type AuthenticatedRequestProjection = {
  readonly requestId: string;
  readonly requestClient: AdapterPlatform;
  readonly sessionId: string;
  readonly source: "external" | "internal-delegated";
  readonly platform?: RegisteredSurfacePlatform;
  readonly sessionRef?: SessionRefFor<RegisteredSurfacePlatform>;
  readonly messageRef?: MsgRefFor<RegisteredSurfacePlatform>;
  readonly authenticatedOrigin?: AuthenticatedSurfaceOrigin;
  readonly authenticationMetadataKind: AuthenticationMetadataKind;
  readonly githubTrigger?: GithubTriggerProjection;
  readonly verifiedIngress: boolean;
};

export class AuthenticatedRequestProjectionInvalid extends TaggedError(
  "AuthenticatedRequestProjectionInvalid",
)<{
  readonly messageType: string;
  readonly message: string;
}> {}

export class AuthenticatedRequestIdentityConflict extends TaggedError(
  "AuthenticatedRequestIdentityConflict",
)<{
  readonly messageType: string;
  readonly message: string;
}> {}

const requestRawSchema = z
  .object({
    authenticatedActor: z
      .object({
        platform: z.enum(["discord", "github"]),
        userId: z.string().trim().min(1).optional(),
      })
      .optional(),
    authenticatedOrigin: z
      .object({
        platform: z.enum(["discord", "github"]),
        userId: z.string().trim().min(1),
        messageRef: z.object({
          platform: z.enum(["discord", "github"]),
          channelId: z.string().trim().min(1),
          messageId: z.string().trim().min(1),
        }),
      })
      .optional(),
    github: z
      .object({
        repoFullName: z.string().trim().min(1).optional(),
        issueNumber: z.number().int().positive().optional(),
        prNumber: z.number().int().positive().optional(),
        trigger: z.union([
          z.object({ kind: z.literal("comment"), commentId: z.number().int().positive() }),
          z.object({ kind: z.literal("issue"), issueNumber: z.number().int().positive() }),
        ]),
      })
      .optional(),
  })
  .passthrough();

function metadataKind(input: {
  readonly actor: boolean;
  readonly origin: boolean;
  readonly githubTrigger: boolean;
}): AuthenticationMetadataKind {
  if (input.actor && input.origin && input.githubTrigger) return "actor-origin-github-trigger";
  if (input.actor && input.githubTrigger) return "actor-github-trigger";
  if (input.origin && input.githubTrigger) return "origin-github-trigger";
  if (input.githubTrigger) return "github-trigger";
  if (input.actor && input.origin) return "actor-origin";
  if (input.actor) return "actor";
  if (input.origin) return "origin";
  return "absent";
}

export function projectAuthenticatedRequest(
  msg: Extract<LilacMessageForTopic<"cmd.request">, { type: "cmd.request.message" }>,
): ResultType<AuthenticatedRequestProjection | undefined, AuthenticatedRequestProjectionInvalid> {
  const requestId = msg.headers?.request_id;
  const sessionId = msg.headers?.session_id;
  const requestClient = msg.headers?.request_client ?? "unknown";
  const rawData = msg.data.raw;
  const hasAuthenticationMetadata =
    isRecord(rawData) &&
    (Object.hasOwn(rawData, "authenticatedActor") ||
      Object.hasOwn(rawData, "authenticatedOrigin") ||
      Object.hasOwn(rawData, "github"));
  const invalid = (message: string) =>
    Result.err(
      new AuthenticatedRequestProjectionInvalid({
        messageType: msg.type,
        message,
      }),
    );

  if (!requestId || !sessionId) {
    if (!hasAuthenticationMetadata) return Result.ok(undefined);
    return invalid(
      "cmd.request.message authentication metadata requires correlated surface headers",
    );
  }
  if (requestClient !== "discord" && requestClient !== "github") {
    if (hasAuthenticationMetadata) {
      return invalid("surface authentication metadata requires a registered request platform");
    }
    return Result.ok({
      requestId,
      requestClient,
      sessionId,
      source: "external",
      authenticationMetadataKind: "absent",
      verifiedIngress: false,
    });
  }
  const platform = requestClient;

  const raw = requestRawSchema.safeParse(rawData);
  if (!raw.success && hasAuthenticationMetadata) {
    return invalid("cmd.request.message contains invalid authentication metadata");
  }
  const actor = raw.success ? raw.data.authenticatedActor : undefined;
  const origin = raw.success ? raw.data.authenticatedOrigin : undefined;
  const github = raw.success ? raw.data.github : undefined;
  const trigger = github?.trigger;

  if (actor && actor.platform !== platform) {
    return invalid("authenticated actor platform does not match request headers");
  }
  if (
    origin &&
    (origin.platform !== platform ||
      origin.messageRef.platform !== platform ||
      origin.messageRef.channelId !== sessionId)
  ) {
    return invalid("authenticated origin does not match request headers and session");
  }
  if (actor?.userId && origin && actor.userId !== origin.userId) {
    return invalid("authenticated actor and origin user IDs conflict");
  }
  if (platform !== "github" && trigger) {
    return invalid("GitHub trigger metadata does not match the request platform");
  }

  let triggerMessageId: string | undefined;
  if (trigger?.kind === "comment") triggerMessageId = String(trigger.commentId);
  if (trigger?.kind === "issue") triggerMessageId = String(trigger.issueNumber);
  const sessionMatch = /^(.+)#([1-9]\d*)$/u.exec(sessionId);
  const sessionRepoFullName = sessionMatch?.[1];
  const sessionIssueNumber = sessionMatch?.[2] ? Number(sessionMatch[2]) : undefined;
  if (trigger && (!sessionRepoFullName || !sessionIssueNumber)) {
    return invalid("GitHub trigger metadata does not match the request session");
  }
  const declaredIssueNumbers = trigger
    ? [
        github?.issueNumber,
        github?.prNumber,
        trigger.kind === "issue" ? trigger.issueNumber : undefined,
      ].filter((value): value is number => value !== undefined)
    : [];
  if (
    sessionIssueNumber !== undefined &&
    declaredIssueNumbers.some((value) => value !== sessionIssueNumber)
  ) {
    return invalid("GitHub trigger metadata conflicts with the request session identity");
  }
  if (github?.repoFullName && github.repoFullName !== sessionRepoFullName) {
    return invalid("GitHub repository metadata conflicts with the request session identity");
  }
  if (origin && triggerMessageId && origin.messageRef.messageId !== triggerMessageId) {
    return invalid("GitHub trigger metadata conflicts with authenticated message identity");
  }

  let messageRef: MsgRef | undefined;
  if (origin) {
    messageRef = {
      platform,
      channelId: origin.messageRef.channelId,
      messageId: origin.messageRef.messageId,
    };
  } else if (platform === "discord") {
    const parsed = parseRequestId(requestId);
    if (parsed?.kind === "discord_message" && parsed.channelId === sessionId) {
      messageRef = { platform, channelId: sessionId, messageId: parsed.messageId };
    }
  } else if (triggerMessageId) {
    messageRef = { platform, channelId: sessionId, messageId: triggerMessageId };
  }

  const userId = origin?.userId ?? actor?.userId;
  const authenticationMetadataKind = metadataKind({
    actor: actor !== undefined,
    origin: origin !== undefined,
    githubTrigger: trigger !== undefined,
  });
  const githubTrigger = triggerMessageId
    ? {
        kind: trigger?.kind ?? "comment",
        ...(github?.repoFullName ? { repoFullName: github.repoFullName } : {}),
        ...(sessionIssueNumber ? { issueNumber: sessionIssueNumber } : {}),
        messageId: triggerMessageId,
      }
    : undefined;
  const verifiedGithubIngress =
    platform === "github" &&
    trigger !== undefined &&
    github?.repoFullName === sessionRepoFullName &&
    declaredIssueNumbers.length > 0 &&
    declaredIssueNumbers.every((value) => value === sessionIssueNumber);

  if (platform === "discord") {
    const sessionRef = { platform, channelId: sessionId };
    const discordMessageRef = messageRef?.platform === "discord" ? messageRef : undefined;
    let authenticatedOrigin:
      | Extract<AuthenticatedSurfaceOrigin, { platform: "discord" }>
      | undefined;
    if (userId) {
      authenticatedOrigin = discordMessageRef
        ? { platform, userId, sessionRef, messageRef: discordMessageRef }
        : { platform, userId, sessionRef };
    }
    return Result.ok({
      requestId,
      requestClient,
      sessionId,
      source: "external",
      platform,
      sessionRef,
      ...(discordMessageRef ? { messageRef: discordMessageRef } : {}),
      ...(authenticatedOrigin ? { authenticatedOrigin } : {}),
      authenticationMetadataKind,
      verifiedIngress: actor !== undefined || origin !== undefined,
    });
  }

  const sessionRef = { platform, channelId: sessionId };
  const githubMessageRef = messageRef?.platform === "github" ? messageRef : undefined;
  let authenticatedOrigin: Extract<AuthenticatedSurfaceOrigin, { platform: "github" }> | undefined;
  if (userId) {
    authenticatedOrigin = githubMessageRef
      ? { platform, userId, sessionRef, messageRef: githubMessageRef }
      : { platform, userId, sessionRef };
  }
  return Result.ok({
    requestId,
    requestClient,
    sessionId,
    source: "external",
    platform,
    sessionRef,
    ...(githubMessageRef ? { messageRef: githubMessageRef } : {}),
    ...(authenticatedOrigin ? { authenticatedOrigin } : {}),
    authenticationMetadataKind,
    ...(githubTrigger ? { githubTrigger } : {}),
    verifiedIngress: verifiedGithubIngress,
  });
}

function sameAuthenticatedOrigin(
  left: AuthenticatedSurfaceOrigin | undefined,
  right: AuthenticatedSurfaceOrigin | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.platform === right.platform &&
    left.userId === right.userId &&
    left.sessionRef.channelId === right.sessionRef.channelId
  );
}

function sameGithubTrigger(
  left: GithubTriggerProjection | undefined,
  right: GithubTriggerProjection | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.kind === right.kind &&
    left.repoFullName === right.repoFullName &&
    left.issueNumber === right.issueNumber &&
    left.messageId === right.messageId
  );
}

export function latchAuthenticatedRequest(
  previous: AuthenticatedRequestProjection | undefined,
  next: AuthenticatedRequestProjection,
  messageType: string,
): ResultType<AuthenticatedRequestProjection, AuthenticatedRequestIdentityConflict> {
  if (!previous) return Result.ok(next);
  const conflicts =
    previous.requestId !== next.requestId ||
    previous.requestClient !== next.requestClient ||
    previous.sessionId !== next.sessionId ||
    (previous.authenticatedOrigin === undefined && next.authenticatedOrigin !== undefined) ||
    (previous.verifiedIngress === false && next.verifiedIngress === true) ||
    (previous.authenticatedOrigin !== undefined &&
      next.authenticatedOrigin !== undefined &&
      !sameAuthenticatedOrigin(previous.authenticatedOrigin, next.authenticatedOrigin)) ||
    (previous.verifiedIngress &&
      next.githubTrigger !== undefined &&
      !sameGithubTrigger(previous.githubTrigger, next.githubTrigger));
  if (conflicts) {
    return Result.err(
      new AuthenticatedRequestIdentityConflict({
        messageType,
        message: "request follow-up conflicts with its first accepted authentication state",
      }),
    );
  }
  return Result.ok(previous);
}
