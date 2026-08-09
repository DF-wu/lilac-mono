import type { SurfaceAdapter } from "../adapter";
import type {
  SurfaceAdapterIngress,
  SurfaceRelayDescriptor,
  SurfaceRuntimeDescriptor,
  SurfaceWorkflowProgressPort,
} from "../runtime-descriptor";

export function createDiscordSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly adapterIngress: SurfaceAdapterIngress<"discord">;
  readonly relay: SurfaceRelayDescriptor<"discord">;
  readonly workflowProgress?: SurfaceWorkflowProgressPort<"discord">;
}): SurfaceRuntimeDescriptor<"discord"> {
  return {
    platform: "discord",
    adapter: input.adapter,
    adapterIngress: input.adapterIngress,
    relay: input.relay,
    ...(input.workflowProgress ? { workflowProgress: input.workflowProgress } : {}),
  };
}
