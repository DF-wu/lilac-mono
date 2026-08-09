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
