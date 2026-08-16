import type { SurfaceMsgRef } from "@stanley2058/lilac-event-bus";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import { TaggedError, type Result } from "better-result";

import type { SurfaceAdapter } from "./adapter";
import type {
  AuthenticatedRequestProjectionFor,
  AuthenticatedRequestProjectionInvalid,
} from "./authenticated-request";
import type { MsgRefFor, RegisteredSurfacePlatform, SessionRefFor } from "./types";

export class SurfaceReplyTargetInvalid extends TaggedError("SurfaceReplyTargetInvalid")<{
  readonly reason: "malformed" | "platform-mismatch" | "session-mismatch";
  readonly expectedPlatform: RegisteredSurfacePlatform;
  readonly expectedSessionId: string;
  readonly message: string;
}> {}

export class SurfaceRefInvalid extends TaggedError("SurfaceRefInvalid")<{
  readonly reason: "platform-mismatch" | "session-mismatch";
  readonly expectedPlatform: RegisteredSurfacePlatform;
  readonly expectedSessionId: string;
  readonly message: string;
}> {}

export type ReplyTargetResolution<T> =
  | { readonly kind: "none" }
  | { readonly kind: "target"; readonly ref: T }
  | { readonly kind: "invalid"; readonly error: SurfaceReplyTargetInvalid };

export type SurfaceRefRouting<P extends RegisteredSurfacePlatform> = {
  createSessionRef(sessionId: string): SessionRefFor<P>;
  createMessageRef(sessionRef: SessionRefFor<P>, messageId: string): MsgRefFor<P>;
  resolveRequestMessageRef(input: {
    readonly requestId: string;
    readonly sessionRef: SessionRefFor<P>;
  }): ReplyTargetResolution<MsgRefFor<P>>;
  decodeMessageRef(input: {
    readonly ref: SurfaceMsgRef;
    readonly expectedSessionId: string;
  }): Result<MsgRefFor<P>, SurfaceRefInvalid>;
};

export class SurfaceToolTargetInvalid extends TaggedError("SurfaceToolTargetInvalid")<{
  readonly message: string;
}> {}

export type SurfaceToolRequestTarget = {
  readonly sessionId: string;
  readonly messageId: string;
};

export type SurfaceSessionIdHelp<P extends RegisteredSurfacePlatform> = {
  readonly client: P;
  readonly accepted: readonly {
    readonly format: string;
    readonly meaning: string;
  }[];
  readonly notes: readonly string[];
};

export type SurfaceToolTargetRouting<P extends RegisteredSurfacePlatform> = {
  readonly helpFallbackPriority: number;
  inferRequestTarget(requestId: string | undefined): SurfaceToolRequestTarget | null;
  describeSessionIds(input: {
    readonly contextSessionId: string | null;
    readonly config: CoreConfig;
  }): {
    readonly sessionIdFormats: SurfaceSessionIdHelp<P>;
    readonly contextAlias?: string;
  };
  resolveSession(input: {
    readonly selector: string;
    readonly adapter: SurfaceAdapter;
    readonly getConfig: () => Promise<CoreConfig>;
  }): Promise<
    Result<
      {
        readonly sessionRef: SessionRefFor<P>;
        readonly config?: CoreConfig;
      },
      SurfaceToolTargetInvalid
    >
  >;
};

export type GithubTriggerProjection = {
  readonly kind: "comment" | "issue";
  readonly targetKind?: "issue" | "pull-request";
  readonly repoFullName?: string;
  readonly issueNumber?: number;
  readonly messageId: string;
};

export type GithubNormalizedRequestMetadata = {
  readonly repoFullName?: string;
  readonly issueNumber?: number;
  readonly prNumber?: number;
  readonly trigger:
    | { readonly kind: "comment"; readonly commentId: number }
    | { readonly kind: "issue"; readonly issueNumber: number };
};

export type CorrelatedSurfaceRequestMetadata<P extends RegisteredSurfacePlatform> = {
  readonly actor?: { readonly platform: P; readonly userId: string };
  readonly origin?: {
    readonly platform: P;
    readonly userId: string;
    readonly messageId: string;
  };
  readonly github?: GithubNormalizedRequestMetadata;
};

export type SurfaceProtocolRequestMetadata = {
  readonly inferredMessageId?: string;
  readonly githubTrigger?: GithubTriggerProjection;
  readonly verifiedIngress?: boolean;
};

export type SurfaceRequestProjectionRouting<P extends RegisteredSurfacePlatform> = {
  readonly inferRequestMessageRef: boolean;
  readonly acceptsGithubMetadata?: boolean;
  projectProtocolMetadata?(input: {
    readonly requestId: string;
    readonly sessionRef: SessionRefFor<P>;
    readonly common: CorrelatedSurfaceRequestMetadata<P>;
    readonly messageType: string;
    readonly invalidProjection: (
      message: string,
    ) => Result<never, AuthenticatedRequestProjectionInvalid>;
  }): Result<SurfaceProtocolRequestMetadata, AuthenticatedRequestProjectionInvalid>;
  isProtocolProjectionValid?(projection: AuthenticatedRequestProjectionFor<P>): boolean;
  hasDurableProtocolProof?(projection: AuthenticatedRequestProjectionFor<P>): boolean;
  resolveExternalSafetyMode?(input: {
    readonly verifiedIngress: boolean;
    readonly assertedSafetyMode: "trusted" | "restricted";
  }): "trusted" | "restricted";
};

export type SurfaceProtocolRouting<P extends RegisteredSurfacePlatform> = {
  readonly platform: P;
  readonly displayName: string;
  ownsRequestId(requestId: string): boolean;
  readonly refs: SurfaceRefRouting<P>;
  readonly toolTargets?: SurfaceToolTargetRouting<P>;
  readonly requestProjection?: SurfaceRequestProjectionRouting<P>;
};
