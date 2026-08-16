import type { SurfaceMsgRef } from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";

import { parseGithubRequestId } from "../../github/github-ids";
import type {
  AuthenticatedRequestProjectionFor,
  AuthenticatedRequestProjectionInvalid,
} from "../authenticated-request";
import {
  type CorrelatedSurfaceRequestMetadata,
  type GithubTriggerProjection,
  SurfaceRefInvalid,
  SurfaceReplyTargetInvalid,
  type SurfaceProtocolRouting,
} from "../protocol";
import { githubToolTargetRouting } from "./github-tool-targets";

function projectGithubMetadata(input: {
  readonly sessionId: string;
  readonly common: CorrelatedSurfaceRequestMetadata<"github">;
  readonly invalidProjection: (
    message: string,
  ) => import("better-result").Result<never, AuthenticatedRequestProjectionInvalid>;
}) {
  const github = input.common.github;
  const trigger = github?.trigger;
  if (github?.issueNumber !== undefined && github.prNumber !== undefined) {
    return input.invalidProjection(
      "GitHub trigger metadata declares both issue and pull-request targets",
    );
  }

  let triggerMessageId: string | undefined;
  if (trigger?.kind === "comment") triggerMessageId = String(trigger.commentId);
  if (trigger?.kind === "issue") triggerMessageId = String(trigger.issueNumber);

  const sessionMatch = /^(.+)#([1-9]\d*)$/u.exec(input.sessionId);
  const sessionRepoFullName = sessionMatch?.[1];
  const sessionIssueNumber = sessionMatch?.[2] ? Number(sessionMatch[2]) : undefined;
  if (trigger && (!sessionRepoFullName || !sessionIssueNumber)) {
    return input.invalidProjection("GitHub trigger metadata does not match the request session");
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
    return input.invalidProjection(
      "GitHub trigger metadata conflicts with the request session identity",
    );
  }
  if (github?.repoFullName && github.repoFullName !== sessionRepoFullName) {
    return input.invalidProjection(
      "GitHub repository metadata conflicts with the request session identity",
    );
  }
  if (
    input.common.origin &&
    triggerMessageId &&
    input.common.origin.messageId !== triggerMessageId
  ) {
    return input.invalidProjection(
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
    ...(triggerMessageId ? { inferredMessageId: triggerMessageId } : {}),
    ...(githubTrigger ? { githubTrigger } : {}),
    verifiedIngress,
  });
}

function isGithubProjectionValid(projection: AuthenticatedRequestProjectionFor<"github">) {
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
    trigger.repoFullName.trim().length > 0 &&
    trigger.messageId.trim().length > 0;
  if (completeTrigger) {
    const request = parseGithubRequestId({ requestId: projection.requestId });
    if (request?.sessionId !== projection.sessionId || request.triggerId !== trigger.messageId) {
      return false;
    }
  }
  return projection.verifiedIngress === completeTrigger;
}

function hasDurableGithubTriggerProof(projection: AuthenticatedRequestProjectionFor<"github">) {
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

function invalidRequestMessageTarget(input: {
  readonly reason: SurfaceReplyTargetInvalid["reason"];
  readonly sessionId: string;
  readonly message: string;
}) {
  return {
    kind: "invalid" as const,
    error: new SurfaceReplyTargetInvalid({
      reason: input.reason,
      expectedPlatform: "github",
      expectedSessionId: input.sessionId,
      message: input.message,
    }),
  };
}

function decodeGithubMessageRef(input: {
  readonly ref: SurfaceMsgRef;
  readonly expectedSessionId: string;
}) {
  if (input.ref.platform !== "github") {
    return Result.err(
      new SurfaceRefInvalid({
        reason: "platform-mismatch",
        expectedPlatform: "github",
        expectedSessionId: input.expectedSessionId,
        message: `Expected a GitHub reply target, received '${input.ref.platform}'`,
      }),
    );
  }
  if (input.ref.channelId !== input.expectedSessionId) {
    return Result.err(
      new SurfaceRefInvalid({
        reason: "session-mismatch",
        expectedPlatform: "github",
        expectedSessionId: input.expectedSessionId,
        message: `GitHub reply target belongs to session '${input.ref.channelId}'`,
      }),
    );
  }
  return Result.ok({
    platform: "github" as const,
    channelId: input.ref.channelId,
    messageId: input.ref.messageId,
  });
}

export const githubSurfaceProtocol = {
  platform: "github",
  displayName: "GitHub",
  ownsRequestId: (requestId) => requestId.startsWith("github:"),
  toolTargets: githubToolTargetRouting,
  requestProjection: {
    inferRequestMessageRef: false,
    acceptsGithubMetadata: true,
    projectProtocolMetadata: ({ sessionRef, common, invalidProjection }) =>
      projectGithubMetadata({
        sessionId: sessionRef.channelId,
        common,
        invalidProjection,
      }),
    isProtocolProjectionValid: isGithubProjectionValid,
    hasDurableProtocolProof: hasDurableGithubTriggerProof,
    resolveExternalSafetyMode: ({ verifiedIngress }) =>
      verifiedIngress ? "trusted" : "restricted",
  },
  refs: {
    createSessionRef: (sessionId) => ({ platform: "github", channelId: sessionId }),
    createMessageRef: (sessionRef, messageId) => ({
      platform: "github",
      channelId: sessionRef.channelId,
      messageId,
    }),
    resolveRequestMessageRef: ({ requestId, sessionRef }) => {
      const parsed = parseGithubRequestId({ requestId });
      if (parsed) {
        if (parsed.sessionId !== sessionRef.channelId) {
          return invalidRequestMessageTarget({
            reason: "session-mismatch",
            sessionId: sessionRef.channelId,
            message: `GitHub request belongs to session '${parsed.sessionId}'`,
          });
        }
        return {
          kind: "target",
          ref: {
            platform: "github",
            channelId: sessionRef.channelId,
            messageId: parsed.triggerId,
          },
        };
      }
      if (requestId.startsWith("github:")) {
        return invalidRequestMessageTarget({
          reason: "malformed",
          sessionId: sessionRef.channelId,
          message: `Malformed GitHub request ID '${requestId}'`,
        });
      }
      return { kind: "none" };
    },
    decodeMessageRef: decodeGithubMessageRef,
  },
} satisfies SurfaceProtocolRouting<"github">;
