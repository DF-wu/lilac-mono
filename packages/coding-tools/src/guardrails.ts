import fs from "node:fs/promises";
import path from "node:path";

import {
  captureFilesystemOperation,
  expandTilde,
  type FileSystemOperationFailed,
} from "@stanley2058/lilac-fs";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { adaptCodingToolResultToHost } from "./host-compatibility";

export class CodingToolGuardrailViolation extends TaggedError("CodingToolGuardrailViolation")<{
  readonly message: string;
}> {}

export type CanonicalPathError = CodingToolGuardrailViolation | FileSystemOperationFailed;

function isPathWithin(candidatePath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function guardrailBypassAllowed(
  dangerouslyAllow: boolean | undefined,
  allowGuardrailBypass: boolean,
): ResultType<void, CodingToolGuardrailViolation> {
  if (!dangerouslyAllow || allowGuardrailBypass) return Result.ok(undefined);
  return Result.err(
    new CodingToolGuardrailViolation({
      message:
        "dangerouslyAllow is disabled for this toolset; set allowGuardrailBypass=true when constructing it",
    }),
  );
}

export function assertGuardrailBypassAllowed(
  dangerouslyAllow: boolean | undefined,
  allowGuardrailBypass: boolean,
): void {
  adaptCodingToolResultToHost(guardrailBypassAllowed(dangerouslyAllow, allowGuardrailBypass));
}

export function validateLocalCwd(cwd: string): ResultType<void, CodingToolGuardrailViolation> {
  const trimmed = cwd.trim();
  const isWindowsDrivePath = /^[A-Za-z]:[\\/]/u.test(trimmed);
  if (!isWindowsDrivePath && /^[A-Za-z0-9_.@-]+:/u.test(trimmed)) {
    return Result.err(
      new CodingToolGuardrailViolation({
        message: `The local coding-tools adapter does not support SSH cwd target '${cwd}'`,
      }),
    );
  }
  return Result.ok(undefined);
}

export function assertLocalCwd(cwd: string): void {
  adaptCodingToolResultToHost(validateLocalCwd(cwd));
}

export async function canonicalizeAsFarAsExistsResult(
  inputPath: string,
): Promise<ResultType<string, FileSystemOperationFailed>> {
  let current = path.resolve(expandTilde(inputPath));
  const missingSegments: string[] = [];

  while (true) {
    const existing = await captureFilesystemOperation("canonicalize path", () =>
      fs.realpath(current),
    );
    if (existing.status === "ok") {
      return Result.ok(path.resolve(existing.value, ...missingSegments));
    }
    if (existing.error.code !== "ENOENT" && existing.error.code !== "ENOTDIR") {
      return Result.err(existing.error);
    }

    const stats = await captureFilesystemOperation("inspect unresolved path", () =>
      fs.lstat(current),
    );
    if (stats.status === "ok" && stats.value.isSymbolicLink()) {
      const linkTarget = await captureFilesystemOperation("read symbolic link", () =>
        fs.readlink(current),
      );
      if (linkTarget.status === "error") return Result.err(linkTarget.error);
      current = path.isAbsolute(linkTarget.value)
        ? path.resolve(linkTarget.value)
        : path.resolve(path.dirname(current), linkTarget.value);
      continue;
    }
    if (
      stats.status === "error" &&
      stats.error.code !== "ENOENT" &&
      stats.error.code !== "ENOTDIR"
    ) {
      return Result.err(stats.error);
    }

    const parent = path.dirname(current);
    if (parent === current) return Result.ok(path.resolve(current, ...missingSegments));
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
}

export async function canonicalizeAsFarAsExists(inputPath: string): Promise<string> {
  return adaptCodingToolResultToHost(await canonicalizeAsFarAsExistsResult(inputPath));
}

export async function canonicalPathAllowed(params: {
  targetPath: string;
  denyPaths: readonly string[];
  operation: string;
  dangerouslyAllow?: boolean;
}): Promise<ResultType<void, CanonicalPathError>> {
  if (params.dangerouslyAllow) return Result.ok(undefined);
  const canonicalTarget = await canonicalizeAsFarAsExistsResult(params.targetPath);
  if (canonicalTarget.status === "error") return Result.err(canonicalTarget.error);
  for (const denyPath of params.denyPaths) {
    const canonicalDenyPath = await canonicalizeAsFarAsExistsResult(denyPath);
    if (canonicalDenyPath.status === "error") return Result.err(canonicalDenyPath.error);
    if (isPathWithin(canonicalTarget.value, canonicalDenyPath.value)) {
      return Result.err(
        new CodingToolGuardrailViolation({
          message: `Access denied: '${params.targetPath}' resolves into protected path '${canonicalDenyPath.value}' for ${params.operation}`,
        }),
      );
    }
  }
  return Result.ok(undefined);
}

export async function assertCanonicalPathAllowed(
  targetPath: string,
  denyPaths: readonly string[],
  operation: string,
  dangerouslyAllow = false,
): Promise<void> {
  adaptCodingToolResultToHost(
    await canonicalPathAllowed({ targetPath, denyPaths, operation, dangerouslyAllow }),
  );
}
