import { discordSurfaceProtocol } from "./discord/discord-surface-protocol";
import { githubSurfaceProtocol } from "./github/github-surface-protocol";
import {
  SurfaceReplyTargetInvalid,
  type ReplyTargetResolution,
  type SurfaceProtocolRouting,
  type SurfaceToolRequestTarget,
} from "./protocol";
import type { MsgRefFor, RegisteredSurfacePlatform, SessionRefFor } from "./types";

export const BUILTIN_SURFACE_PROTOCOLS = {
  discord: discordSurfaceProtocol,
  github: githubSurfaceProtocol,
} satisfies {
  [P in RegisteredSurfacePlatform]: SurfaceProtocolRouting<P>;
};

type CatalogPlatform = keyof typeof BUILTIN_SURFACE_PROTOCOLS;
type CatalogAndRefPlatformsEqual = [CatalogPlatform] extends [RegisteredSurfacePlatform]
  ? [RegisteredSurfacePlatform] extends [CatalogPlatform]
    ? true
    : false
  : false;
type AssertCatalogAndRefPlatformsEqual<T extends true> = T;
export type BuiltinSurfaceProtocolKeysExactlyEqualRefPlatforms =
  AssertCatalogAndRefPlatformsEqual<CatalogAndRefPlatformsEqual>;

export function getBuiltinSurfaceProtocol<P extends RegisteredSurfacePlatform>(
  platform: P,
): SurfaceProtocolRouting<P>;
export function getBuiltinSurfaceProtocol(
  platform: string,
): SurfaceProtocolRouting<RegisteredSurfacePlatform> | undefined;
export function getBuiltinSurfaceProtocol(
  platform: string,
): SurfaceProtocolRouting<RegisteredSurfacePlatform> | undefined {
  if (!Object.hasOwn(BUILTIN_SURFACE_PROTOCOLS, platform)) return undefined;
  return BUILTIN_SURFACE_PROTOCOLS[platform as RegisteredSurfacePlatform];
}

export function resolveBuiltinSurfaceRequestMessageRef<P extends RegisteredSurfacePlatform>(input: {
  readonly protocol: SurfaceProtocolRouting<P>;
  readonly requestId: string;
  readonly sessionRef: SessionRefFor<P>;
}): ReplyTargetResolution<MsgRefFor<P>> {
  const resolved = input.protocol.refs.resolveRequestMessageRef({
    requestId: input.requestId,
    sessionRef: input.sessionRef,
  });
  if (resolved.kind !== "none") return resolved;

  const owner = Object.values(BUILTIN_SURFACE_PROTOCOLS).find(
    (candidate) =>
      candidate.platform !== input.protocol.platform && candidate.ownsRequestId(input.requestId),
  );
  return owner
    ? {
        kind: "invalid",
        error: new SurfaceReplyTargetInvalid({
          reason: "platform-mismatch",
          expectedPlatform: input.protocol.platform,
          expectedSessionId: input.sessionRef.channelId,
          message: `${owner.displayName} request ID cannot target ${input.protocol.displayName} output`,
        }),
      }
    : resolved;
}

export function inferBuiltinSurfaceToolRequestTarget(
  requestId: string | undefined,
): SurfaceToolRequestTarget | null {
  for (const protocol of Object.values(BUILTIN_SURFACE_PROTOCOLS)) {
    const inferred = protocol.toolTargets?.inferRequestTarget(requestId);
    if (inferred) return inferred;
  }
  return null;
}

export function resolveAuthenticatedRequestSafetyMode(input: {
  readonly projection: {
    readonly requestClient: string;
    readonly source: "external" | "internal-delegated";
    readonly verifiedIngress: boolean;
  };
  readonly assertedSafetyMode: "trusted" | "restricted";
  readonly correlatedAuthority: boolean;
}): "trusted" | "restricted" {
  if (!input.correlatedAuthority) return "restricted";
  if (input.projection.source === "internal-delegated") return input.assertedSafetyMode;
  const protocol = getBuiltinSurfaceProtocol(input.projection.requestClient);
  if (!protocol) return "restricted";
  return resolveBuiltinSurfaceProtocolSafetyMode({
    protocol,
    verifiedIngress: input.projection.verifiedIngress,
    assertedSafetyMode: input.assertedSafetyMode,
  });
}

export function resolveBuiltinSurfaceProtocolSafetyMode<
  P extends RegisteredSurfacePlatform,
>(input: {
  readonly protocol: SurfaceProtocolRouting<P>;
  readonly verifiedIngress: boolean;
  readonly assertedSafetyMode: "trusted" | "restricted";
}): "trusted" | "restricted" {
  return (
    input.protocol.requestProjection?.resolveExternalSafetyMode?.({
      verifiedIngress: input.verifiedIngress,
      assertedSafetyMode: input.assertedSafetyMode,
    }) ?? input.assertedSafetyMode
  );
}
