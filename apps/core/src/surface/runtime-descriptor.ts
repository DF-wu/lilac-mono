import type { AdapterPlatform, SurfaceMsgRef } from "@stanley2058/lilac-event-bus";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { SurfaceAdapter } from "./adapter";
import type { SurfaceOperationError } from "./adapter";
import type { ContentOpts, MsgRefFor, RegisteredSurfacePlatform, SessionRefFor } from "./types";
import type { BusToAdapterRelaySnapshot } from "./bridge/subscribe-from-bus";
import {
  createDescriptorBoundSurfaceAdapter,
  createDescriptorBoundWorkflowProgressPort,
} from "./produced-ref-guard";

export type { MsgRefFor, RegisteredSurfacePlatform, SessionRefFor } from "./types";

export interface SurfaceLifecycleHandle {
  stop(): Promise<void>;
}

export interface SurfaceLifecyclePort<H extends SurfaceLifecycleHandle> {
  start(): Promise<H>;
}

export type SurfaceAdapterIngressHandle<P extends RegisteredSurfacePlatform> =
  SurfaceLifecycleHandle & {
    readonly platform: P;
  };

export interface SurfaceAdapterIngress<
  P extends RegisteredSurfacePlatform,
> extends SurfaceLifecyclePort<SurfaceAdapterIngressHandle<P>> {}

export type SurfaceRequestIngressHandle = SurfaceLifecycleHandle;

export interface SurfaceRequestIngress extends SurfaceLifecyclePort<SurfaceRequestIngressHandle> {}

export type SurfaceRelaySnapshotFor<P extends RegisteredSurfacePlatform> = Omit<
  BusToAdapterRelaySnapshot,
  "platform"
> & {
  readonly platform: P;
};

export class SurfaceRelayRestoreApplyFailed extends TaggedError("SurfaceRelayRestoreApplyFailed")<{
  readonly platform: RegisteredSurfacePlatform;
  readonly requestId: string;
  readonly message: string;
}> {}

export class SurfaceRelayRestoreRollbackFailed extends TaggedError(
  "SurfaceRelayRestoreRollbackFailed",
)<{
  readonly platform: RegisteredSurfacePlatform;
  readonly message: string;
}> {}

export type SurfaceRelayRestoreAttempt<P extends RegisteredSurfacePlatform> = {
  readonly platform: P;
  apply(): Promise<ResultType<void, SurfaceRelayRestoreApplyFailed>>;
  rollback(): Promise<ResultType<void, SurfaceRelayRestoreRollbackFailed>>;
  activate(): void;
};

export interface SurfaceRelayHandle<
  P extends RegisteredSurfacePlatform,
> extends SurfaceLifecycleHandle {
  readonly platform: P;
  beginDrain(options: { readonly deadlineMs: number }): Promise<void>;
  snapshotRelays(): SurfaceRelaySnapshotFor<P>[];
  prepareRestoreRelays(
    snapshots: readonly SurfaceRelaySnapshotFor<P>[],
  ): ResultType<SurfaceRelayRestoreAttempt<P>, SurfaceRelayRestoreApplyFailed>;
  restoreRelays(snapshots: readonly SurfaceRelaySnapshotFor<P>[]): Promise<void>;
}

export interface SurfaceRelayLifecyclePort<
  P extends RegisteredSurfacePlatform,
> extends SurfaceLifecyclePort<SurfaceRelayHandle<P>> {
  readonly platform: P;
}

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

export type SurfaceRelayRefs<P extends RegisteredSurfacePlatform> = {
  createSessionRef(sessionId: string): SessionRefFor<P>;
  resolveInitialReplyTarget(input: {
    readonly requestId: string;
    readonly sessionId: string;
  }): ReplyTargetResolution<MsgRefFor<P>>;
  decodeReanchorTarget(input: {
    readonly ref: SurfaceMsgRef;
    readonly expectedSessionId: string;
  }): ResultType<MsgRefFor<P>, SurfaceRefInvalid>;
};

export class SurfaceIngressAcknowledgementCleanupFailed extends TaggedError(
  "SurfaceIngressAcknowledgementCleanupFailed",
)<{
  readonly cause: {
    readonly errorTag: string;
    readonly errorMessage: string;
  };
  readonly message: string;
}> {}

export type SurfaceRelayFinalization<P extends RegisteredSurfacePlatform> = {
  isFinalResponseSuperseded?(input: {
    readonly requestId: string;
    readonly sessionId: string;
  }): boolean;
  clearIngressAcknowledgement?(input: {
    readonly requestId: string;
    readonly sessionId: string;
  }): Promise<ResultType<void, SurfaceIngressAcknowledgementCleanupFailed>>;
  cleanupSkippedOutput?(input: { readonly ref: MsgRefFor<P> }): Promise<void>;
};

export type SurfaceRestoredOutputChain<P extends RegisteredSurfacePlatform> = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly createdOutputRefs: readonly MsgRefFor<P>[];
  readonly activeOutputRefs?: readonly MsgRefFor<P>[];
};

export type SurfaceRecoveryGeneration = {
  readonly generation: symbol;
};

export type SurfaceRelayRecovery<P extends RegisteredSurfacePlatform> = {
  activateRestoredOutputChains(
    generation: SurfaceRecoveryGeneration,
    chains: readonly SurfaceRestoredOutputChain<P>[],
  ): void;
};

export type SurfaceRelayPolicy<P extends RegisteredSurfacePlatform> = {
  readonly refs: SurfaceRelayRefs<P>;
  readonly finalization?: SurfaceRelayFinalization<P>;
  readonly recovery?: SurfaceRelayRecovery<P>;
};

export type SurfaceRelayDescriptor<P extends RegisteredSurfacePlatform> = {
  readonly lifecycle: SurfaceRelayLifecyclePort<P>;
} & SurfaceRelayPolicy<P>;

type WorkflowProgressOperationFailureBase = {
  readonly operation: "check-message" | "send" | "edit";
  readonly message: string;
};

export type WorkflowProgressOperationFailureFields = WorkflowProgressOperationFailureBase &
  (
    | {
        readonly disposition: "permanent";
        readonly reason:
          | "unsupported"
          | "invalid-input"
          | "platform-mismatch"
          | "session-mismatch"
          | "not-found"
          | "partial-outcome";
        readonly retryAfterMs?: never;
      }
    | {
        readonly disposition: "retryable";
        readonly reason: "rate-limited";
        readonly retryAfterMs?: number;
      }
    | {
        readonly disposition: "retryable";
        readonly reason: "permission-denied" | "unavailable";
        readonly retryAfterMs?: never;
      }
  );

class WorkflowProgressPermanentOperationFailed extends TaggedError(
  "WorkflowProgressOperationFailed",
)<Extract<WorkflowProgressOperationFailureFields, { readonly disposition: "permanent" }>> {}

class WorkflowProgressRateLimitedOperationFailed extends TaggedError(
  "WorkflowProgressOperationFailed",
)<Extract<WorkflowProgressOperationFailureFields, { readonly reason: "rate-limited" }>> {}

class WorkflowProgressRetryableOperationFailed extends TaggedError(
  "WorkflowProgressOperationFailed",
)<
  Extract<
    WorkflowProgressOperationFailureFields,
    { readonly reason: "permission-denied" | "unavailable" }
  >
> {}

export type WorkflowProgressOperationFailed =
  | WorkflowProgressPermanentOperationFailed
  | WorkflowProgressRateLimitedOperationFailed
  | WorkflowProgressRetryableOperationFailed;

export function workflowProgressOperationFailure(
  operation: WorkflowProgressOperationFailed["operation"],
  error: SurfaceOperationError,
): WorkflowProgressOperationFailed {
  switch (error._tag) {
    case "SurfaceOperationUnsupported":
      return new WorkflowProgressPermanentOperationFailed({
        operation,
        disposition: "permanent",
        reason: "unsupported",
        message: error.message,
      });
    case "SurfaceInvalidInput":
      return new WorkflowProgressPermanentOperationFailed({
        operation,
        disposition: "permanent",
        reason: "invalid-input",
        message: error.message,
      });
    case "SurfacePlatformMismatch":
      return new WorkflowProgressPermanentOperationFailed({
        operation,
        disposition: "permanent",
        reason: "platform-mismatch",
        message: error.message,
      });
    case "SurfaceSessionMismatch":
      return new WorkflowProgressPermanentOperationFailed({
        operation,
        disposition: "permanent",
        reason: "session-mismatch",
        message: error.message,
      });
    case "SurfaceMessageNotFound":
      return new WorkflowProgressPermanentOperationFailed({
        operation,
        disposition: "permanent",
        reason: "not-found",
        message: error.message,
      });
    case "SurfacePermissionDenied":
      return new WorkflowProgressRetryableOperationFailed({
        operation,
        disposition: "retryable",
        reason: "permission-denied",
        message: error.message,
      });
    case "SurfaceRateLimited":
      return new WorkflowProgressRateLimitedOperationFailed({
        operation,
        disposition: "retryable",
        reason: "rate-limited",
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        message: error.message,
      });
    case "SurfaceUnavailable":
      return new WorkflowProgressRetryableOperationFailed({
        operation,
        disposition: "retryable",
        reason: "unavailable",
        message: error.message,
      });
    case "SurfaceOperationPartiallyCompleted":
      return new WorkflowProgressPermanentOperationFailed({
        operation,
        disposition: "permanent",
        reason: "partial-outcome",
        message: error.message,
      });
  }
}

export type WorkflowProgressCheckFailure = {
  readonly kind: "failed";
  readonly error: WorkflowProgressOperationFailed;
};

export type WorkflowProgressSendFailure<P extends RegisteredSurfacePlatform> =
  | { readonly kind: "created"; readonly ref: MsgRefFor<P> }
  | { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed };

export type WorkflowProgressEditFailure =
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed };

export type WorkflowProgressMessageTarget = {
  readonly channelId: string;
  readonly messageId: string;
};

export type WorkflowProgressSendInput = {
  readonly channelId: string;
  readonly content: ContentOpts;
  readonly replyToMessageId?: string;
  readonly silent?: boolean;
};

export type SurfaceWorkflowProgressPort<P extends RegisteredSurfacePlatform> = {
  readonly configurationRevision: string;
  checkMessage(
    target: WorkflowProgressMessageTarget,
  ): Promise<ResultType<"found" | "missing", WorkflowProgressCheckFailure>>;
  send(
    input: WorkflowProgressSendInput,
  ): Promise<ResultType<MsgRefFor<P>, WorkflowProgressSendFailure<P>>>;
  edit(
    target: WorkflowProgressMessageTarget,
    content: ContentOpts,
  ): Promise<ResultType<void, WorkflowProgressEditFailure>>;
};

export type RegisteredSurfaceWorkflowProgressPort =
  SurfaceWorkflowProgressPort<RegisteredSurfacePlatform>;

export type SurfaceRuntimeDescriptor<P extends RegisteredSurfacePlatform> = {
  readonly platform: P;
  readonly adapter: SurfaceAdapter;
  readonly adapterIngress?: SurfaceAdapterIngress<P>;
  readonly requestIngress?: SurfaceRequestIngress;
  readonly relay?: SurfaceRelayDescriptor<P>;
  readonly workflowProgress?: SurfaceWorkflowProgressPort<P>;
};

export type RegisteredSurfaceRuntimeDescriptor = {
  [P in RegisteredSurfacePlatform]: SurfaceRuntimeDescriptor<P>;
}[RegisteredSurfacePlatform];

export type ResolvedSurfaceAdapter = {
  [P in RegisteredSurfacePlatform]: {
    readonly platform: P;
    readonly adapter: SurfaceAdapter;
  };
}[RegisteredSurfacePlatform];

export type SurfaceAdapterResolver = {
  registeredPlatforms(): readonly RegisteredSurfacePlatform[];
  resolve(platform: AdapterPlatform): ResolvedSurfaceAdapter | null;
};

export class SurfaceRuntimeRegistrationDuplicate extends TaggedError(
  "SurfaceRuntimeRegistrationDuplicate",
)<{
  readonly platform: RegisteredSurfacePlatform;
  readonly message: string;
}> {}

function guardRuntimeDescriptor(
  descriptor: RegisteredSurfaceRuntimeDescriptor,
): RegisteredSurfaceRuntimeDescriptor {
  switch (descriptor.platform) {
    case "discord": {
      const adapter = createDescriptorBoundSurfaceAdapter("discord", descriptor.adapter);
      return {
        ...descriptor,
        adapter,
        ...(descriptor.workflowProgress
          ? {
              workflowProgress: createDescriptorBoundWorkflowProgressPort(
                "discord",
                descriptor.workflowProgress,
              ),
            }
          : {}),
      };
    }
    case "github": {
      const adapter = createDescriptorBoundSurfaceAdapter("github", descriptor.adapter);
      return {
        ...descriptor,
        adapter,
        ...(descriptor.workflowProgress
          ? {
              workflowProgress: createDescriptorBoundWorkflowProgressPort(
                "github",
                descriptor.workflowProgress,
              ),
            }
          : {}),
      };
    }
  }
}

export class SurfaceRuntimeRegistry {
  readonly #descriptors: readonly RegisteredSurfaceRuntimeDescriptor[];

  private constructor(descriptors: readonly RegisteredSurfaceRuntimeDescriptor[]) {
    this.#descriptors = descriptors;
  }

  static create(
    descriptors: readonly RegisteredSurfaceRuntimeDescriptor[],
  ): ResultType<SurfaceRuntimeRegistry, SurfaceRuntimeRegistrationDuplicate> {
    const platforms = new Set<RegisteredSurfacePlatform>();
    for (const descriptor of descriptors) {
      if (platforms.has(descriptor.platform)) {
        return Result.err(
          new SurfaceRuntimeRegistrationDuplicate({
            platform: descriptor.platform,
            message: `Surface runtime already registered for platform '${descriptor.platform}'`,
          }),
        );
      }
      platforms.add(descriptor.platform);
    }
    return Result.ok(new SurfaceRuntimeRegistry(descriptors.map(guardRuntimeDescriptor)));
  }

  entries(): readonly RegisteredSurfaceRuntimeDescriptor[] {
    return this.#descriptors;
  }

  adapterResolver(): SurfaceAdapterResolver {
    const adapters = new Map(
      this.#descriptors.map((descriptor) => [descriptor.platform, descriptor.adapter] as const),
    );
    const registeredPlatforms = this.#descriptors.map((descriptor) => descriptor.platform);
    return {
      registeredPlatforms: () => registeredPlatforms,
      resolve: (platform) => {
        if (platform !== "discord" && platform !== "github") return null;
        const adapter = adapters.get(platform);
        return adapter ? { platform, adapter } : null;
      },
    };
  }

  async validateAdapterPlatforms(): Promise<void> {
    for (const descriptor of this.#descriptors) {
      await descriptor.adapter.getSelf();
    }
  }
}
