import type { AdapterPlatform, LilacMessageForTopic } from "@stanley2058/lilac-event-bus";
import { isRecord } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { parseRequestId } from "./bridge/request-ids";
import { parseGithubRequestId } from "../github/github-ids";
import type {
  AuthenticatedSurfaceOrigin,
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

type AuthenticationMetadataPresence = {
  readonly actor: boolean;
  readonly origin: boolean;
  readonly githubTrigger: boolean;
};

type GithubTriggerProjection = {
  readonly kind: "comment" | "issue";
  readonly targetKind?: "issue" | "pull-request";
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
  readonly authenticatedActor?: {
    readonly platform: RegisteredSurfacePlatform;
    readonly userId: string;
  };
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
        userId: z.string().trim().min(1),
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
  .loose();

type RequestRaw = z.output<typeof requestRawSchema>;
type RequestMessage = Extract<LilacMessageForTopic<"cmd.request">, { type: "cmd.request.message" }>;

type RequestRoute =
  | {
      readonly kind: "uncorrelated";
      readonly requestClient: AdapterPlatform;
    }
  | {
      readonly kind: "unregistered";
      readonly requestId: string;
      readonly requestClient: Exclude<AdapterPlatform, RegisteredSurfacePlatform>;
      readonly sessionId: string;
    }
  | {
      readonly kind: "discord";
      readonly requestId: string;
      readonly requestClient: "discord";
      readonly sessionId: string;
    }
  | {
      readonly kind: "github";
      readonly requestId: string;
      readonly requestClient: "github";
      readonly sessionId: string;
    };

type GithubProjectionContext = {
  readonly triggerMessageId?: string;
  readonly githubTrigger?: GithubTriggerProjection;
  readonly verifiedIngress: boolean;
};

function invalidProjection(
  messageType: string,
  message: string,
): ResultType<never, AuthenticatedRequestProjectionInvalid> {
  return Result.err(new AuthenticatedRequestProjectionInvalid({ messageType, message }));
}

function metadataPresence(kind: AuthenticationMetadataKind): AuthenticationMetadataPresence {
  switch (kind) {
    case "absent":
      return { actor: false, origin: false, githubTrigger: false };
    case "actor":
      return { actor: true, origin: false, githubTrigger: false };
    case "origin":
      return { actor: false, origin: true, githubTrigger: false };
    case "actor-origin":
      return { actor: true, origin: true, githubTrigger: false };
    case "github-trigger":
      return { actor: false, origin: false, githubTrigger: true };
    case "actor-github-trigger":
      return { actor: true, origin: false, githubTrigger: true };
    case "origin-github-trigger":
      return { actor: false, origin: true, githubTrigger: true };
    case "actor-origin-github-trigger":
      return { actor: true, origin: true, githubTrigger: true };
  }
}

function metadataKind(input: AuthenticationMetadataPresence): AuthenticationMetadataKind {
  if (input.actor && input.origin && input.githubTrigger) return "actor-origin-github-trigger";
  if (input.actor && input.githubTrigger) return "actor-github-trigger";
  if (input.origin && input.githubTrigger) return "origin-github-trigger";
  if (input.githubTrigger) return "github-trigger";
  if (input.actor && input.origin) return "actor-origin";
  if (input.actor) return "actor";
  if (input.origin) return "origin";
  return "absent";
}

function nonempty(value: string): boolean {
  return value.trim().length > 0;
}

function resolveRequestRoute(message: RequestMessage): RequestRoute {
  const requestId = message.headers?.request_id;
  const sessionId = message.headers?.session_id;
  const requestClient = message.headers?.request_client ?? "unknown";
  if (!requestId || !sessionId) return { kind: "uncorrelated", requestClient };

  switch (requestClient) {
    case "discord":
      return { kind: "discord", requestId, requestClient, sessionId };
    case "github":
      return { kind: "github", requestId, requestClient, sessionId };
    case "slack":
    case "telegram":
    case "unknown":
    case "web":
    case "whatsapp":
      return { kind: "unregistered", requestId, requestClient, sessionId };
  }
}

function validateSurfaceClaims(
  platform: RegisteredSurfacePlatform,
  sessionId: string,
  raw: RequestRaw,
  messageType: string,
): ResultType<void, AuthenticatedRequestProjectionInvalid> {
  const actor = raw.authenticatedActor;
  const origin = raw.authenticatedOrigin;
  if (actor && actor.platform !== platform) {
    return invalidProjection(
      messageType,
      "authenticated actor platform does not match request headers",
    );
  }
  if (
    origin &&
    (origin.platform !== platform ||
      origin.messageRef.platform !== platform ||
      origin.messageRef.channelId !== sessionId)
  ) {
    return invalidProjection(
      messageType,
      "authenticated origin does not match request headers and session",
    );
  }
  if (actor && origin && actor.userId !== origin.userId) {
    return invalidProjection(messageType, "authenticated actor and origin user IDs conflict");
  }
  return Result.ok(undefined);
}

function projectUnregisteredRequest(
  route: Extract<RequestRoute, { kind: "unregistered" }>,
): AuthenticatedRequestProjection {
  return {
    requestId: route.requestId,
    requestClient: route.requestClient,
    sessionId: route.sessionId,
    source: "external",
    authenticationMetadataKind: "absent",
    verifiedIngress: false,
  };
}

function projectDiscordRequest(
  route: Extract<RequestRoute, { kind: "discord" }>,
  raw: RequestRaw,
  messageType: string,
): ResultType<AuthenticatedRequestProjection, AuthenticatedRequestProjectionInvalid> {
  const claimsValid = validateSurfaceClaims("discord", route.sessionId, raw, messageType);
  if (claimsValid.status === "error") return Result.err(claimsValid.error);
  if (raw.github?.trigger) {
    return invalidProjection(
      messageType,
      "GitHub trigger metadata does not match the request platform",
    );
  }

  const actor = raw.authenticatedActor;
  const origin = raw.authenticatedOrigin;
  let messageRef: MsgRefFor<"discord"> | undefined;
  if (origin) {
    messageRef = {
      platform: "discord",
      channelId: origin.messageRef.channelId,
      messageId: origin.messageRef.messageId,
    };
  } else {
    const parsedRequest = parseRequestId(route.requestId);
    if (parsedRequest?.kind === "discord_message" && parsedRequest.channelId === route.sessionId) {
      messageRef = {
        platform: "discord",
        channelId: route.sessionId,
        messageId: parsedRequest.messageId,
      };
    }
  }

  const sessionRef = { platform: "discord", channelId: route.sessionId } as const;
  const userId = origin?.userId ?? actor?.userId;
  let authenticatedOrigin: Extract<AuthenticatedSurfaceOrigin, { platform: "discord" }> | undefined;
  if (userId) {
    authenticatedOrigin = messageRef
      ? { platform: "discord", userId, sessionRef, messageRef }
      : { platform: "discord", userId, sessionRef };
  }
  return Result.ok({
    requestId: route.requestId,
    requestClient: route.requestClient,
    sessionId: route.sessionId,
    source: "external",
    platform: "discord",
    sessionRef,
    ...(messageRef ? { messageRef } : {}),
    ...(actor
      ? { authenticatedActor: { platform: "discord" as const, userId: actor.userId } }
      : {}),
    ...(authenticatedOrigin ? { authenticatedOrigin } : {}),
    authenticationMetadataKind: metadataKind({
      actor: actor !== undefined,
      origin: origin !== undefined,
      githubTrigger: false,
    }),
    verifiedIngress: actor !== undefined || origin !== undefined,
  });
}

function resolveGithubProjectionContext(
  route: Extract<RequestRoute, { kind: "github" }>,
  raw: RequestRaw,
  messageType: string,
): ResultType<GithubProjectionContext, AuthenticatedRequestProjectionInvalid> {
  const github = raw.github;
  const trigger = github?.trigger;
  if (github?.issueNumber !== undefined && github.prNumber !== undefined) {
    return invalidProjection(
      messageType,
      "GitHub trigger metadata declares both issue and pull-request targets",
    );
  }

  let triggerMessageId: string | undefined;
  if (trigger?.kind === "comment") triggerMessageId = String(trigger.commentId);
  if (trigger?.kind === "issue") triggerMessageId = String(trigger.issueNumber);

  const sessionMatch = /^(.+)#([1-9]\d*)$/u.exec(route.sessionId);
  const sessionRepoFullName = sessionMatch?.[1];
  const sessionIssueNumber = sessionMatch?.[2] ? Number(sessionMatch[2]) : undefined;
  if (trigger && (!sessionRepoFullName || !sessionIssueNumber)) {
    return invalidProjection(
      messageType,
      "GitHub trigger metadata does not match the request session",
    );
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
    return invalidProjection(
      messageType,
      "GitHub trigger metadata conflicts with the request session identity",
    );
  }
  if (github?.repoFullName && github.repoFullName !== sessionRepoFullName) {
    return invalidProjection(
      messageType,
      "GitHub repository metadata conflicts with the request session identity",
    );
  }
  if (
    raw.authenticatedOrigin &&
    triggerMessageId &&
    raw.authenticatedOrigin.messageRef.messageId !== triggerMessageId
  ) {
    return invalidProjection(
      messageType,
      "GitHub trigger metadata conflicts with authenticated message identity",
    );
  }

  let targetKind: GithubTriggerProjection["targetKind"];
  if (github?.prNumber !== undefined) targetKind = "pull-request";
  else if (github?.issueNumber !== undefined) targetKind = "issue";
  const githubTrigger = triggerMessageId
    ? {
        kind: trigger?.kind ?? "comment",
        ...(targetKind ? { targetKind } : {}),
        ...(github?.repoFullName ? { repoFullName: github.repoFullName } : {}),
        ...(sessionIssueNumber ? { issueNumber: sessionIssueNumber } : {}),
        messageId: triggerMessageId,
      }
    : undefined;
  const verifiedIngress =
    trigger !== undefined &&
    github?.repoFullName === sessionRepoFullName &&
    (github?.issueNumber !== undefined || github?.prNumber !== undefined) &&
    declaredIssueNumbers.length > 0 &&
    declaredIssueNumbers.every((value) => value === sessionIssueNumber);
  return Result.ok({
    triggerMessageId,
    githubTrigger,
    verifiedIngress,
  });
}

function projectGithubRequest(
  route: Extract<RequestRoute, { kind: "github" }>,
  raw: RequestRaw,
  messageType: string,
): ResultType<AuthenticatedRequestProjection, AuthenticatedRequestProjectionInvalid> {
  const claimsValid = validateSurfaceClaims("github", route.sessionId, raw, messageType);
  if (claimsValid.status === "error") return Result.err(claimsValid.error);
  const context = resolveGithubProjectionContext(route, raw, messageType);
  if (context.status === "error") return Result.err(context.error);

  const actor = raw.authenticatedActor;
  const origin = raw.authenticatedOrigin;
  let messageRef: MsgRefFor<"github"> | undefined;
  if (origin) {
    messageRef = {
      platform: "github",
      channelId: origin.messageRef.channelId,
      messageId: origin.messageRef.messageId,
    };
  } else if (context.value.triggerMessageId) {
    messageRef = {
      platform: "github",
      channelId: route.sessionId,
      messageId: context.value.triggerMessageId,
    };
  }

  const sessionRef = { platform: "github", channelId: route.sessionId } as const;
  const userId = origin?.userId ?? actor?.userId;
  let authenticatedOrigin: Extract<AuthenticatedSurfaceOrigin, { platform: "github" }> | undefined;
  if (userId) {
    authenticatedOrigin = messageRef
      ? { platform: "github", userId, sessionRef, messageRef }
      : { platform: "github", userId, sessionRef };
  }
  return Result.ok({
    requestId: route.requestId,
    requestClient: route.requestClient,
    sessionId: route.sessionId,
    source: "external",
    platform: "github",
    sessionRef,
    ...(messageRef ? { messageRef } : {}),
    ...(actor ? { authenticatedActor: { platform: "github" as const, userId: actor.userId } } : {}),
    ...(authenticatedOrigin ? { authenticatedOrigin } : {}),
    authenticationMetadataKind: metadataKind({
      actor: actor !== undefined,
      origin: origin !== undefined,
      githubTrigger: context.value.githubTrigger !== undefined,
    }),
    ...(context.value.githubTrigger ? { githubTrigger: context.value.githubTrigger } : {}),
    verifiedIngress: context.value.verifiedIngress,
  });
}

function hasConsistentMetadataState(projection: AuthenticatedRequestProjection): boolean {
  const expected = metadataPresence(projection.authenticationMetadataKind);
  const actor = projection.authenticatedActor;
  const origin = projection.authenticatedOrigin;
  if (expected.actor !== (actor !== undefined)) return false;
  if (expected.githubTrigger !== (projection.githubTrigger !== undefined)) return false;
  if (expected.actor && origin === undefined) return false;
  if (expected.origin && origin === undefined) return false;
  return expected.actor || expected.origin || origin === undefined;
}

function isInternalDelegatedProjectionValid(projection: AuthenticatedRequestProjection): boolean {
  const origin = projection.authenticatedOrigin;
  if (
    projection.requestClient !== "unknown" ||
    projection.platform !== undefined ||
    projection.sessionRef !== undefined ||
    projection.messageRef !== undefined ||
    projection.authenticatedActor !== undefined ||
    projection.githubTrigger !== undefined ||
    metadataPresence(projection.authenticationMetadataKind).actor ||
    projection.verifiedIngress
  ) {
    return false;
  }
  if (!origin) return true;
  return (
    nonempty(origin.userId) &&
    nonempty(origin.sessionRef.channelId) &&
    origin.sessionRef.platform === origin.platform
  );
}

function isUnregisteredExternalProjectionValid(
  projection: AuthenticatedRequestProjection,
): boolean {
  return (
    projection.authenticationMetadataKind === "absent" &&
    projection.platform === undefined &&
    projection.sessionRef === undefined &&
    projection.messageRef === undefined &&
    projection.authenticatedActor === undefined &&
    projection.authenticatedOrigin === undefined &&
    projection.githubTrigger === undefined &&
    !projection.verifiedIngress
  );
}

function hasValidRegisteredRoute(
  projection: AuthenticatedRequestProjection,
  platform: RegisteredSurfacePlatform,
): boolean {
  const sessionRef = projection.sessionRef;
  const messageRef = projection.messageRef;
  if (
    projection.platform !== platform ||
    sessionRef?.platform !== platform ||
    sessionRef.channelId !== projection.sessionId ||
    !nonempty(sessionRef.channelId)
  ) {
    return false;
  }
  return (
    messageRef === undefined ||
    (messageRef.platform === platform &&
      messageRef.channelId === projection.sessionId &&
      nonempty(messageRef.messageId))
  );
}

function hasValidRegisteredIdentity(
  projection: AuthenticatedRequestProjection,
  platform: RegisteredSurfacePlatform,
): boolean {
  const expected = metadataPresence(projection.authenticationMetadataKind);
  const actor = projection.authenticatedActor;
  const origin = projection.authenticatedOrigin;
  if (
    actor &&
    (actor.platform !== platform || !nonempty(actor.userId) || actor.userId !== origin?.userId)
  ) {
    return false;
  }
  if (expected.origin && origin?.messageRef === undefined) return false;
  if (!origin) return true;
  if (
    origin.platform !== platform ||
    origin.sessionRef.platform !== origin.platform ||
    origin.sessionRef.channelId !== projection.sessionId ||
    !nonempty(origin.userId)
  ) {
    return false;
  }
  const originMessageRef = origin.messageRef;
  if (!originMessageRef) return true;
  return (
    originMessageRef.platform === platform &&
    originMessageRef.channelId === projection.sessionId &&
    originMessageRef.messageId === projection.messageRef?.messageId
  );
}

function isDiscordProjectionValid(projection: AuthenticatedRequestProjection): boolean {
  const expected = metadataPresence(projection.authenticationMetadataKind);
  if (projection.githubTrigger !== undefined || expected.githubTrigger) return false;
  const expectedVerified =
    expected.origin || (expected.actor && projection.authenticatedOrigin !== undefined);
  const restrictedActorWithoutMessageProof =
    expected.actor &&
    !expected.origin &&
    projection.messageRef === undefined &&
    projection.authenticatedOrigin?.messageRef === undefined &&
    !projection.verifiedIngress;
  return restrictedActorWithoutMessageProof || projection.verifiedIngress === expectedVerified;
}

function isGithubProjectionValid(projection: AuthenticatedRequestProjection): boolean {
  const trigger = projection.githubTrigger;
  if (!trigger) return !projection.verifiedIngress;
  const session = /^(.+)#([1-9]\d*)$/u.exec(projection.sessionId);
  if (
    !session ||
    trigger.messageId !== projection.messageRef?.messageId ||
    !/^[1-9]\d*$/u.test(trigger.messageId) ||
    (trigger.repoFullName !== undefined && trigger.repoFullName !== session[1]) ||
    (trigger.issueNumber !== undefined && trigger.issueNumber !== Number(session[2])) ||
    (trigger.kind === "issue" && trigger.messageId !== String(trigger.issueNumber))
  ) {
    return false;
  }
  const completeTrigger =
    trigger.repoFullName !== undefined &&
    trigger.issueNumber !== undefined &&
    trigger.targetKind !== undefined &&
    nonempty(trigger.repoFullName) &&
    nonempty(trigger.messageId);
  if (completeTrigger) {
    const request = parseGithubRequestId({ requestId: projection.requestId });
    if (request?.sessionId !== projection.sessionId || request.triggerId !== trigger.messageId) {
      return false;
    }
  }
  return projection.verifiedIngress === completeTrigger;
}

function isRegisteredExternalProjectionValid(
  projection: AuthenticatedRequestProjection,
  platform: RegisteredSurfacePlatform,
): boolean {
  if (!hasValidRegisteredRoute(projection, platform)) return false;
  if (!hasValidRegisteredIdentity(projection, platform)) return false;
  switch (platform) {
    case "discord":
      return isDiscordProjectionValid(projection);
    case "github":
      return isGithubProjectionValid(projection);
  }
}

export function isAuthenticatedRequestProjectionSemanticallyValid(
  projection: AuthenticatedRequestProjection,
): boolean {
  if (!nonempty(projection.requestId) || !nonempty(projection.sessionId)) return false;
  if (!hasConsistentMetadataState(projection)) return false;
  if (projection.source === "internal-delegated") {
    return isInternalDelegatedProjectionValid(projection);
  }
  switch (projection.requestClient) {
    case "discord":
      return isRegisteredExternalProjectionValid(projection, "discord");
    case "github":
      return isRegisteredExternalProjectionValid(projection, "github");
    case "slack":
    case "telegram":
    case "unknown":
    case "web":
    case "whatsapp":
      return isUnregisteredExternalProjectionValid(projection);
  }
}

function hasDurableDiscordMessageProof(projection: AuthenticatedRequestProjection): boolean {
  const messageRef = projection.messageRef;
  const originMessageRef = projection.authenticatedOrigin?.messageRef;
  if (!messageRef && !originMessageRef) return true;
  if (!messageRef) return false;
  const request = parseRequestId(projection.requestId);
  if (
    request?.kind !== "discord_message" ||
    request.channelId !== projection.sessionId ||
    request.channelId !== messageRef.channelId ||
    request.messageId !== messageRef.messageId
  ) {
    return false;
  }
  return (
    originMessageRef === undefined ||
    (originMessageRef.channelId === request.channelId &&
      originMessageRef.messageId === request.messageId)
  );
}

function hasDurableGithubTriggerProof(projection: AuthenticatedRequestProjection): boolean {
  const trigger = projection.githubTrigger;
  if (!trigger) return true;
  const request = parseGithubRequestId({ requestId: projection.requestId });
  return (
    request?.sessionId === projection.sessionId &&
    request.triggerId === trigger.messageId &&
    request.triggerId === projection.messageRef?.messageId &&
    (projection.authenticatedOrigin?.messageRef === undefined ||
      projection.authenticatedOrigin.messageRef.messageId === request.triggerId)
  );
}

export function isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid(
  projection: AuthenticatedRequestProjection,
): boolean {
  if (!isAuthenticatedRequestProjectionSemanticallyValid(projection)) return false;
  if (projection.source === "internal-delegated") return true;
  switch (projection.requestClient) {
    case "discord":
      return hasDurableDiscordMessageProof(projection);
    case "github":
      return hasDurableGithubTriggerProof(projection);
    case "slack":
    case "telegram":
    case "unknown":
    case "web":
    case "whatsapp":
      return true;
  }
}

function requireSemanticallyValidProjection(
  projected: ResultType<AuthenticatedRequestProjection, AuthenticatedRequestProjectionInvalid>,
  messageType: string,
): ResultType<AuthenticatedRequestProjection, AuthenticatedRequestProjectionInvalid> {
  if (projected.status === "error") return Result.err(projected.error);
  if (isAuthenticatedRequestProjectionSemanticallyValid(projected.value)) return projected;
  return invalidProjection(
    messageType,
    "cmd.request.message authentication projection is semantically inconsistent",
  );
}

export function projectAuthenticatedRequest(
  message: RequestMessage,
): ResultType<AuthenticatedRequestProjection | undefined, AuthenticatedRequestProjectionInvalid> {
  const raw = message.data.raw;
  const metadataClaimed =
    isRecord(raw) &&
    (Object.hasOwn(raw, "authenticatedActor") ||
      Object.hasOwn(raw, "authenticatedOrigin") ||
      Object.hasOwn(raw, "github"));
  const route = resolveRequestRoute(message);
  if (route.kind === "uncorrelated") {
    if (!metadataClaimed) return Result.ok(undefined);
    return invalidProjection(
      message.type,
      "cmd.request.message authentication metadata requires correlated surface headers",
    );
  }
  if (route.kind === "unregistered") {
    if (metadataClaimed) {
      return invalidProjection(
        message.type,
        "surface authentication metadata requires a registered request platform",
      );
    }
    return requireSemanticallyValidProjection(
      Result.ok(projectUnregisteredRequest(route)),
      message.type,
    );
  }

  const decoded = requestRawSchema.safeParse(raw);
  if (!decoded.success && metadataClaimed) {
    return invalidProjection(
      message.type,
      "cmd.request.message contains invalid authentication metadata",
    );
  }
  const metadata = decoded.success ? decoded.data : {};

  switch (route.kind) {
    case "discord":
      return requireSemanticallyValidProjection(
        projectDiscordRequest(route, metadata, message.type),
        message.type,
      );
    case "github":
      return requireSemanticallyValidProjection(
        projectGithubRequest(route, metadata, message.type),
        message.type,
      );
  }
}

function sameGithubTrigger(
  left: GithubTriggerProjection | undefined,
  right: GithubTriggerProjection | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.kind === right.kind &&
    left.targetKind === right.targetKind &&
    left.repoFullName === right.repoFullName &&
    left.issueNumber === right.issueNumber &&
    left.messageId === right.messageId
  );
}

function hasUnprovenGithubOriginMessageReplacement(
  previous: AuthenticatedRequestProjection,
  next: AuthenticatedRequestProjection,
): boolean {
  if (previous.requestClient !== "github" || next.requestClient !== "github") return false;
  const previousMessageRef = previous.authenticatedOrigin?.messageRef;
  const nextMessageRef = next.authenticatedOrigin?.messageRef;
  if (!previousMessageRef || !nextMessageRef) return false;
  if (previousMessageRef.messageId === nextMessageRef.messageId) return false;
  return next.githubTrigger?.messageId !== nextMessageRef.messageId;
}

type LatchConflictReason =
  | "request-changed"
  | "client-changed"
  | "session-changed"
  | "origin-introduced"
  | "verification-upgraded"
  | "github-origin-message-replaced"
  | "github-trigger-changed";

function latchConflictReason(
  previous: AuthenticatedRequestProjection,
  next: AuthenticatedRequestProjection,
): LatchConflictReason | undefined {
  if (previous.requestId !== next.requestId) return "request-changed";
  if (previous.requestClient !== next.requestClient) return "client-changed";
  if (previous.sessionId !== next.sessionId) return "session-changed";
  if (!previous.authenticatedOrigin && next.authenticatedOrigin) return "origin-introduced";
  if (!previous.verifiedIngress && next.verifiedIngress) return "verification-upgraded";
  if (hasUnprovenGithubOriginMessageReplacement(previous, next)) {
    return "github-origin-message-replaced";
  }
  if (
    previous.verifiedIngress &&
    next.githubTrigger !== undefined &&
    !sameGithubTrigger(previous.githubTrigger, next.githubTrigger)
  ) {
    return "github-trigger-changed";
  }
  return undefined;
}

export function latchAuthenticatedRequest(
  previous: AuthenticatedRequestProjection | undefined,
  next: AuthenticatedRequestProjection,
  messageType: string,
): ResultType<AuthenticatedRequestProjection, AuthenticatedRequestIdentityConflict> {
  if (!previous) return Result.ok(next);
  if (latchConflictReason(previous, next)) {
    return Result.err(
      new AuthenticatedRequestIdentityConflict({
        messageType,
        message: "request follow-up conflicts with its first accepted authentication state",
      }),
    );
  }
  return Result.ok(previous);
}
