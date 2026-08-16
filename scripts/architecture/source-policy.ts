import path from "node:path";

function normalizedPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function isProductionFileName(fileName: string, workspaceRoot: string): boolean {
  const relative = normalizedPath(path.relative(workspaceRoot, fileName));
  if (relative.startsWith("../")) return false;
  if (relative === "src/ssh/remote-js/remote-runner.cjs") return false;
  return !(
    /(?:^|\/)(?:__tests__|tests?|fixtures|generated|dist|vendor)(?:\/|$)/u.test(relative) ||
    /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(relative)
  );
}
