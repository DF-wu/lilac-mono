import { z } from "zod";

const stateSchema = z.object({
  type: z.literal("lilac-computer-state"),
  state: z.enum(["ready", "connected", "disconnected", "failed"]),
});
export function decodeComputerState(value: unknown) {
  const parsed = stateSchema.safeParse(value);
  return parsed.success ? parsed.data.state : null;
}

export function computerFrameUrl(url: string, parentOrigin: string) {
  const target = new URL(url);
  target.searchParams.set("parentOrigin", parentOrigin);
  return target.href;
}

export function clampComputerPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  return {
    x: Math.max(8, Math.min(x, viewportWidth - width - 8)),
    y: Math.max(8, Math.min(y, viewportHeight - height - 8)),
  };
}
