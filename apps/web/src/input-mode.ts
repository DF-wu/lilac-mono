import type { NativeInput } from "@stanley2058/lilac-client-protocol";

export function inputDeliveryOptions(
  active: boolean,
  requestedMode: "steer" | "followup",
  modelId: string | undefined,
  customCommand: boolean,
): Pick<NativeInput, "mode" | "modelId"> {
  if (!active) return { mode: "prompt", modelId };
  if (customCommand || requestedMode === "followup") return { mode: "followup", modelId };
  return { mode: "steer", modelId: undefined };
}
