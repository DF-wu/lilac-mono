import type { ToolProjection } from "./stage5-tools.ts";

export interface RenderModel {
  readonly lines: readonly string[];
  readonly labels: ReadonlyMap<string, readonly string[]>;
}

export function renderToolProjection(projection: ToolProjection): string {
  switch (projection.kind) {
    case "bash":
      return projection.command;
    case "read":
      return projection.path;
    case "malformed-known-tool":
    case "unknown-tool":
      return projection.preview;
  }
}

export function buildRenderModel(lines: readonly string[]): RenderModel {
  const labels = new Map<string, readonly string[]>();
  labels.set("output", lines);
  return { lines, labels };
}
