import type { SurfaceAdapter } from "../adapter";
import type {
  SurfaceRelayDescriptor,
  SurfaceRequestIngress,
  SurfaceRuntimeDescriptor,
  SurfaceWorkflowProgressPort,
} from "../runtime-descriptor";

export function createGithubSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly requestIngress?: SurfaceRequestIngress;
  readonly relay?: SurfaceRelayDescriptor<"github">;
  readonly workflowProgress?: SurfaceWorkflowProgressPort<"github">;
}): SurfaceRuntimeDescriptor<"github"> {
  return {
    platform: "github",
    adapter: input.adapter,
    ...(input.requestIngress ? { requestIngress: input.requestIngress } : {}),
    ...(input.relay ? { relay: input.relay } : {}),
    ...(input.workflowProgress ? { workflowProgress: input.workflowProgress } : {}),
  };
}

type GithubSurfaceRuntimeCompositionLogger = {
  info(message: string, context: Readonly<Record<string, string>>): void;
  warn(message: string, context: Readonly<Record<string, string>>): void;
};

export function createConfiguredGithubSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly webhookSecret: string | undefined;
  readonly appCredentialsAvailable: boolean;
  readonly requestIngress: SurfaceRequestIngress;
  readonly relay: SurfaceRelayDescriptor<"github">;
  readonly workflowProgress?: SurfaceWorkflowProgressPort<"github">;
  readonly logger: GithubSurfaceRuntimeCompositionLogger;
}): SurfaceRuntimeDescriptor<"github"> {
  const requestIngressAvailable = Boolean(input.webhookSecret) && input.appCredentialsAvailable;
  if (!requestIngressAvailable) {
    input.logger.warn("GitHub webhook ingress unavailable", {
      subsystem: "request-ingress",
      reason: input.webhookSecret ? "app-credentials-missing" : "webhook-secret-missing",
    });
  }
  if (!input.appCredentialsAvailable) {
    input.logger.info("GitHub output relay unavailable", {
      subsystem: "output-relay",
      reason: "app-credentials-missing",
    });
  }
  return createGithubSurfaceRuntimeDescriptor({
    adapter: input.adapter,
    ...(requestIngressAvailable ? { requestIngress: input.requestIngress } : {}),
    ...(input.appCredentialsAvailable ? { relay: input.relay } : {}),
    ...(input.workflowProgress ? { workflowProgress: input.workflowProgress } : {}),
  });
}
