import fs from "node:fs";
import path from "node:path";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

export class WorkspaceRootAccessFailed extends TaggedError("WorkspaceRootAccessFailed")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class WorkspaceRootNotFound extends TaggedError("WorkspaceRootNotFound")<{
  readonly startDir: string;
  readonly message: string;
}> {}

export function hasWorkspacesFieldResult(
  pkgJsonPath: string,
): ResultType<boolean, WorkspaceRootAccessFailed> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return Result.ok(false);
    return Result.ok(Reflect.get(raw, "workspaces") != null);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new WorkspaceRootAccessFailed({
        path: pkgJsonPath,
        cause,
        message: `Failed to inspect workspace manifest at ${pkgJsonPath}`,
      }),
    );
  }
}

export function hasWorkspacesField(pkgJsonPath: string): boolean {
  return hasWorkspacesFieldResult(pkgJsonPath).match({
    ok: (value) => value,
    err: () => false,
  });
}

export function findWorkspaceRootResult(
  startDir = process.cwd(),
): ResultType<string, WorkspaceRootNotFound> {
  let dir = path.resolve(startDir);

  while (true) {
    const pkgJsonPath = path.join(dir, "package.json");

    if (fs.existsSync(pkgJsonPath)) {
      const inspected = hasWorkspacesFieldResult(pkgJsonPath);
      const hasWorkspaces = inspected.match({
        ok: (value) => value,
        err: () => false,
      });
      if (hasWorkspaces) return Result.ok(dir);
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return Result.err(
        new WorkspaceRootNotFound({
          startDir,
          message: `Workspace root not found from: ${startDir} (no package.json with workspaces)`,
        }),
      );
    }

    dir = parent;
  }
}

export function findWorkspaceRoot(startDir = process.cwd()): string {
  const result = findWorkspaceRootResult(startDir);
  const resolved = result.match<
    { readonly value: string } | { readonly error: WorkspaceRootNotFound }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw new Error(resolved.error.message);
  return resolved.value;
}
