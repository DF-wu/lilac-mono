import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import path, { posix as posixPath } from "node:path";
import type { RequestContext } from "@stanley2058/lilac-plugin-runtime";
import { CustomMediaError } from "./errors";

const RESTRICTED_TMP_ROOT = "/tmp/lilac-restricted";
const RESTRICTED_TMP_MOUNT = "/tmp";

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function expandTilde(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
  return input;
}

export function restrictedSessionToken(sessionId: string | undefined): string {
  const raw = sessionId?.trim() || "unknown-session";
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export function restrictedSessionRoot(sessionId: string | undefined): string {
  return path.resolve(RESTRICTED_TMP_ROOT, restrictedSessionToken(sessionId));
}

export function resolveToolPath(params: {
  cwd: string;
  inputPath: string;
  context?: RequestContext;
}): string {
  if (params.inputPath.includes("\0")) {
    throw new CustomMediaError("UNSAFE_PATH", "File paths must not contain NUL bytes.");
  }
  if (params.context?.safetyMode !== "restricted") {
    const expanded = expandTilde(params.inputPath);
    return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(params.cwd, expanded));
  }
  if (!params.context.sessionId) {
    throw new CustomMediaError("UNSAFE_PATH", "Restricted mode file paths require a session id.");
  }
  if (params.inputPath.startsWith("~")) {
    throw new CustomMediaError("UNSAFE_PATH", "Restricted mode only allows paths under /tmp.");
  }

  const cwd = params.cwd.startsWith("/") ? params.cwd : `/${params.cwd}`;
  const base = posixPath.normalize(cwd);
  const virtualPath = posixPath.normalize(
    params.inputPath.startsWith("/") ? params.inputPath : posixPath.join(base, params.inputPath),
  );
  if (virtualPath !== RESTRICTED_TMP_MOUNT && !virtualPath.startsWith("/tmp/")) {
    throw new CustomMediaError("UNSAFE_PATH", "Restricted mode only allows paths under /tmp.");
  }

  const root = restrictedSessionRoot(params.context.sessionId);
  const relativeToTmp = virtualPath === "/tmp" ? "" : virtualPath.slice(5);
  const resolved = path.resolve(root, relativeToTmp.split("/").join(path.sep));
  if (!isInside(root, resolved)) {
    throw new CustomMediaError("UNSAFE_PATH", "Restricted mode only allows paths under /tmp.");
  }
  return resolved;
}

export function formatToolPath(filePath: string, context?: RequestContext): string {
  if (context?.safetyMode !== "restricted") return filePath;
  const root = restrictedSessionRoot(context.sessionId);
  const resolved = path.resolve(filePath);
  if (!isInside(root, resolved)) return "/tmp";
  const relative = path.relative(root, resolved);
  return relative ? `/tmp/${relative.split(path.sep).join("/")}` : "/tmp";
}

export async function assertSafeInputFile(
  filePath: string,
  context?: RequestContext,
): Promise<{ realPath: string; size: number }> {
  let realPath: string;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    realPath = await fs.realpath(filePath);
    stat = await fs.stat(realPath);
  } catch {
    throw new CustomMediaError(
      "UNSAFE_PATH",
      `Input file '${formatToolPath(filePath, context)}' is not readable.`,
    );
  }
  if (!stat.isFile()) {
    throw new CustomMediaError(
      "UNSAFE_PATH",
      `Input path '${formatToolPath(filePath, context)}' is not a file.`,
    );
  }
  if (context?.safetyMode === "restricted") {
    const root = restrictedSessionRoot(context.sessionId);
    if (!isInside(root, realPath)) {
      throw new CustomMediaError(
        "UNSAFE_PATH",
        "Restricted input symlinks must remain under /tmp.",
      );
    }
  }
  return { realPath, size: stat.size };
}

export async function prepareOutputDirectory(
  directory: string,
  context?: RequestContext,
): Promise<string> {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const realDirectory = await fs.realpath(directory);
    if (context?.safetyMode === "restricted") {
      const root = restrictedSessionRoot(context.sessionId);
      const realRoot = await fs.realpath(root);
      if (!isInside(realRoot, realDirectory)) {
        throw new CustomMediaError(
          "UNSAFE_PATH",
          "Restricted output symlinks must remain under /tmp.",
        );
      }
    }
    return realDirectory;
  } catch (error) {
    if (error instanceof CustomMediaError) throw error;
    throw new CustomMediaError(
      "IO_ERROR",
      `Could not prepare output directory '${formatToolPath(directory, context)}'.`,
    );
  }
}

export async function reserveUniqueFile(targetPath: string): Promise<{
  path: string;
  handle: FileHandle;
}> {
  const extension = path.extname(targetPath);
  const base = extension ? targetPath.slice(0, -extension.length) : targetPath;
  for (let index = 0; index < 10_000; index++) {
    const candidate = index === 0 ? targetPath : `${base} (${index})${extension}`;
    try {
      const handle = await fs.open(candidate, "wx", 0o600);
      return { path: candidate, handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new CustomMediaError("IO_ERROR", "Could not create an exclusive output file.");
    }
  }
  throw new CustomMediaError("IO_ERROR", "Could not find an unused output filename.");
}

export async function writeUniqueFile(targetPath: string, bytes: Uint8Array): Promise<string> {
  const reserved = await reserveUniqueFile(targetPath);
  try {
    await reserved.handle.writeFile(bytes);
    await reserved.handle.close();
    return reserved.path;
  } catch {
    await reserved.handle.close().catch(() => undefined);
    await fs.unlink(reserved.path).catch(() => undefined);
    throw new CustomMediaError("IO_ERROR", "Could not write the output file.");
  }
}
