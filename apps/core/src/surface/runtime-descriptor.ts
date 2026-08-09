import type { AdapterPlatform, SurfaceMsgRef } from "@stanley2058/lilac-event-bus";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { SurfaceAdapter } from "./adapter";
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

export interface SurfaceRelayHandle<
  P extends RegisteredSurfacePlatform,
> extends SurfaceLifecycleHandle {
  readonly platform: P;
  beginDrain(options: { readonly deadlineMs: number }): Promise<void>;
  snapshotRelays(): SurfaceRelaySnapshotFor<P>[];
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

export type SurfaceRelayPolicy<P extends RegisteredSurfacePlatform> = {
  readonly refs: SurfaceRelayRefs<P>;
  readonly finalization?: SurfaceRelayFinalization<P>;
};

export type SurfaceRelayDescriptor<P extends RegisteredSurfacePlatform> = {
  readonly lifecycle: SurfaceRelayLifecyclePort<P>;
} & SurfaceRelayPolicy<P>;

export class WorkflowProgressOperationFailed extends TaggedError(
  "WorkflowProgressOperationFailed",
)<{
  readonly operation: "check-message" | "send" | "edit";
  readonly message: string;
}> {}

export type WorkflowProgressCheckFailure = {
  readonly kind: "failed";
  readonly error: WorkflowProgressOperationFailed;
};

export type WorkflowProgressSendFailure<P extends RegisteredSurfacePlatform> =
  | (P extends "github" ? { readonly kind: "created"; readonly ref: MsgRefFor<P> } : never)
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
