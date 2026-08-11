import { expandTilde } from "@stanley2058/lilac-fs";
import {
  createLogger,
  errorCode,
  formatTaggedErrorForLog,
  opaqueErrorMessage,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import path from "node:path";
import { posix as posixPath } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { Result, TaggedError, type Panic, type Result as ResultType } from "better-result";

import {
  Bash,
  decodeBytesToUtf8,
  defineCommand,
  InMemoryFs,
  MountableFs,
  OverlayFs,
  ReadWriteFs,
  unsafeBytesFromLatin1,
  type CommandContext,
  type ExecResult,
  type FsStat,
  type IFileSystem,
} from "just-bash";

import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import { projectRuntimeError } from "../runtime/error-format";
import { resolveRestrictedSessionTmpDir } from "../shared/attachment-utils";
import { parseSshCwdTarget } from "../ssh/ssh-cwd";
import {
  withLimitedBashOutput,
  type BashExecutionError,
  type BashToolInput,
  type BashToolOutput,
} from "./bash-impl";
import { sanitizeBashOutputText } from "./bash-output-sanitizer";
import { adaptToolResultToHost, preserveToolPanic } from "./tool-result-adapters";

const WORKSPACE_MOUNT = "/workspace";
const TMP_MOUNT = "/tmp";
export const RESTRICTED_BASH_WALL_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_RESTRICTED_FILE_READ_BYTES = 10 * 1024 * 1024;
const TOOL_SERVER_BACKEND_URL = process.env.TOOL_SERVER_BACKEND_URL || "http://localhost:8080";
const logger = createLogger({ module: "restricted-bash" });

class RestrictedBashOperationError extends TaggedError("RestrictedBashOperationError")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

async function captureRestrictedBashOperation<T>(params: {
  readonly operation: string;
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, RestrictedBashOperationError>> {
  const captured = await Result.tryPromise({
    try: params.run,
    catch: projectRuntimeError(`Opaque restricted Bash ${params.operation} failure`),
  });
  if (captured.status === "error") {
    const cause = preserveToolPanic(captured.error);
    return Result.err(
      new RestrictedBashOperationError({
        operation: params.operation,
        cause,
        message: opaqueErrorMessage(cause, `Restricted Bash failed while ${params.operation}`),
      }),
    );
  }
  return Result.ok(captured.value);
}

function captureRestrictedBashSync<T>(params: {
  readonly operation: string;
  readonly run: () => Awaited<T>;
}): ResultType<T, RestrictedBashOperationError> {
  const captured = Result.try({
    try: params.run,
    catch: projectRuntimeError(`Opaque restricted Bash ${params.operation} failure`),
  });
  if (captured.status === "error") {
    const cause = preserveToolPanic(captured.error);
    return Result.err(
      new RestrictedBashOperationError({
        operation: params.operation,
        cause,
        message: opaqueErrorMessage(cause, `Restricted Bash failed while ${params.operation}`),
      }),
    );
  }
  return Result.ok(captured.value);
}

function signalRestrictedBashFailure(operation: string, message: string): never {
  return adaptToolResultToHost(
    Result.err(
      new RestrictedBashOperationError({
        operation,
        cause: new Error(message),
        message,
      }),
    ),
  );
}

function captureRestrictedHostPromise<T>(
  run: () => Promise<T>,
): Promise<ResultType<T, Error | Panic>> {
  return Result.tryPromise({
    try: run,
    catch: projectRuntimeError("Opaque restricted host operation failure"),
  });
}

function restrictedHostErrorCode(cause: Error): string | undefined {
  return errorCode(cause);
}

type RestrictedBashTermination = "wall_clock" | "aborted";

function toRestrictedTerminationError(
  termination: RestrictedBashTermination | undefined,
  timeoutMs: number,
): BashExecutionError | undefined {
  switch (termination) {
    case "wall_clock":
      return {
        type: "timeout",
        timeoutMs,
        timeoutKind: "wall_clock",
        signal: "ABORT",
      };
    case "aborted":
      return {
        type: "aborted",
        signal: "ABORT",
      };
    case undefined:
      return undefined;
  }
}

type RestrictedBashContext = {
  requestId?: string;
  sessionId?: string;
  requestClient?: string;
  controlCapability?: string;
  currentTurnUserId?: string;
  toolCallId?: string;
  workspaceWritable?: boolean;
  subagentProfile?: "explore" | "general" | "self";
};

type RestrictedBashFsCacheEntry = {
  bash: Bash;
  lastAccess: number;
};

const restrictedBashByRequest = new Map<string, RestrictedBashFsCacheEntry>();
const RESTRICTED_BASH_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

function pruneRestrictedBashCache(now: number): void {
  for (const [key, entry] of restrictedBashByRequest) {
    if (now - entry.lastAccess > RESTRICTED_BASH_CACHE_TTL_MS) {
      restrictedBashByRequest.delete(key);
    }
  }
}

function normalizeVirtualPath(p: string): string {
  const prefixed = p.startsWith("/") ? p : `/${p}`;
  return posixPath.normalize(prefixed);
}

function accessDenied(pathName: string): Error {
  const err = new Error(`Access denied in restricted mode: ${pathName}`);
  return Object.assign(err, { code: "EACCES" });
}

class RestrictedReadFs implements IFileSystem {
  constructor(
    private readonly inner: IFileSystem,
    private readonly denyOutsideMount = false,
    private readonly hostRoot?: string,
  ) {}

  private async assertReadable(pathName: string): Promise<void> {
    if (this.denyOutsideMount && normalizeVirtualPath(pathName) !== "/") {
      signalRestrictedBashFailure("authorize_read", accessDenied(pathName).message);
    }
    if (!this.hostRoot) return;
    const virtual = normalizeVirtualPath(pathName);
    const relative = virtual.startsWith(`${WORKSPACE_MOUNT}/`)
      ? virtual.slice(WORKSPACE_MOUNT.length + 1)
      : virtual.slice(1);
    const candidate = path.resolve(this.hostRoot, relative);
    if (candidate !== this.hostRoot && !candidate.startsWith(`${this.hostRoot}${path.sep}`)) {
      signalRestrictedBashFailure("authorize_read", accessDenied(pathName).message);
    }
    const inspected = await captureRestrictedHostPromise(() => fs.lstat(candidate));
    if (inspected.status === "error") {
      const cause = preserveToolPanic(inspected.error);
      if (restrictedHostErrorCode(cause) === "ENOENT") return;
      signalRestrictedBashFailure(
        "inspect_read_target",
        opaqueErrorMessage(cause, "Failed to inspect restricted read target"),
      );
    }
    if (inspected.value.isFile() && inspected.value.nlink > 1) {
      signalRestrictedBashFailure("authorize_read", accessDenied(pathName).message);
    }
  }

  private async assertWritable(pathName: string): Promise<void> {
    if (this.denyOutsideMount || normalizeVirtualPath(pathName) === "/") {
      signalRestrictedBashFailure("authorize_write", accessDenied(pathName).message);
    }
    if (!this.hostRoot) return;
    const virtual = normalizeVirtualPath(pathName);
    const relative = virtual.startsWith(`${WORKSPACE_MOUNT}/`)
      ? virtual.slice(WORKSPACE_MOUNT.length + 1)
      : virtual.slice(1);
    const candidate = path.resolve(this.hostRoot, relative);
    if (candidate !== this.hostRoot && !candidate.startsWith(`${this.hostRoot}${path.sep}`)) {
      signalRestrictedBashFailure("authorize_write", accessDenied(pathName).message);
    }
    const inspected = await captureRestrictedHostPromise(() => fs.lstat(candidate));
    if (inspected.status === "error") {
      const cause = preserveToolPanic(inspected.error);
      if (restrictedHostErrorCode(cause) === "ENOENT") return;
      signalRestrictedBashFailure(
        "inspect_write_target",
        opaqueErrorMessage(cause, "Failed to inspect restricted write target"),
      );
    }
    if (inspected.value.isFile() && inspected.value.nlink > 1) {
      signalRestrictedBashFailure("authorize_write", accessDenied(pathName).message);
    }
  }

  async readFile(pathName: string, options?: Parameters<IFileSystem["readFile"]>[1]) {
    await this.assertReadable(pathName);
    return await this.inner.readFile(pathName, options);
  }

  async readFileBytes(pathName: string) {
    await this.assertReadable(pathName);
    if (this.inner.readFileBytes) return await this.inner.readFileBytes(pathName);
    const buffer = await this.inner.readFileBuffer(pathName);
    return unsafeBytesFromLatin1(Buffer.from(buffer).toString("latin1"));
  }

  async readFileBuffer(pathName: string) {
    await this.assertReadable(pathName);
    return await this.inner.readFileBuffer(pathName);
  }

  async writeFile(
    pathName: string,
    content: Parameters<IFileSystem["writeFile"]>[1],
    options?: Parameters<IFileSystem["writeFile"]>[2],
  ) {
    await this.assertWritable(pathName);
    return await this.inner.writeFile(pathName, content, options);
  }

  async appendFile(
    pathName: string,
    content: Parameters<IFileSystem["appendFile"]>[1],
    options?: Parameters<IFileSystem["appendFile"]>[2],
  ) {
    await this.assertWritable(pathName);
    return await this.inner.appendFile(pathName, content, options);
  }

  async exists(pathName: string) {
    if (this.denyOutsideMount && normalizeVirtualPath(pathName) !== "/") return false;
    const readable = await captureRestrictedHostPromise(() => this.assertReadable(pathName));
    if (readable.status === "error") {
      const cause = preserveToolPanic(readable.error);
      const message = opaqueErrorMessage(cause, "Restricted path is unavailable");
      if (message.startsWith("Access denied in restricted mode:")) return false;
      signalRestrictedBashFailure("authorize_exists", message);
    }
    return await this.inner.exists(pathName);
  }

  async stat(pathName: string): Promise<FsStat> {
    await this.assertReadable(pathName);
    return await this.inner.stat(pathName);
  }

  async mkdir(pathName: string, options?: Parameters<IFileSystem["mkdir"]>[1]) {
    await this.assertWritable(pathName);
    return await this.inner.mkdir(pathName, options);
  }

  async readdir(pathName: string) {
    await this.assertReadable(pathName);
    return await this.inner.readdir(pathName);
  }

  async readdirWithFileTypes(pathName: string) {
    await this.assertReadable(pathName);
    const entries = await this.inner.readdirWithFileTypes?.(pathName);
    if (entries) return entries;
    return [];
  }

  async rm(pathName: string, options?: Parameters<IFileSystem["rm"]>[1]) {
    await this.assertWritable(pathName);
    return await this.inner.rm(pathName, options);
  }

  async cp(src: string, dest: string, options?: Parameters<IFileSystem["cp"]>[2]) {
    await this.assertReadable(src);
    await this.assertWritable(dest);
    return await this.inner.cp(src, dest, options);
  }

  async mv(src: string, dest: string) {
    await this.assertWritable(src);
    await this.assertWritable(dest);
    return await this.inner.mv(src, dest);
  }

  resolvePath(base: string, pathName: string) {
    return this.inner.resolvePath(base, pathName);
  }

  getAllPaths() {
    if (this.denyOutsideMount) return [];
    return this.inner.getAllPaths();
  }

  async chmod(pathName: string, mode: number) {
    await this.assertWritable(pathName);
    return await this.inner.chmod(pathName, mode);
  }

  async symlink(target: string, linkPath: string) {
    await this.assertWritable(linkPath);
    signalRestrictedBashFailure("create_symlink", accessDenied(`${linkPath} -> ${target}`).message);
  }

  async link(existingPath: string, newPath: string) {
    await this.assertReadable(existingPath);
    await this.assertWritable(newPath);
    signalRestrictedBashFailure(
      "create_hard_link",
      accessDenied(`${newPath} -> ${existingPath}`).message,
    );
  }

  async readlink(pathName: string) {
    await this.assertReadable(pathName);
    return await this.inner.readlink(pathName);
  }

  async lstat(pathName: string): Promise<FsStat> {
    await this.assertReadable(pathName);
    return await this.inner.lstat(pathName);
  }

  async realpath(pathName: string) {
    await this.assertReadable(pathName);
    return await this.inner.realpath(pathName);
  }

  async utimes(pathName: string, atime: Date, mtime: Date) {
    await this.assertWritable(pathName);
    return await this.inner.utimes(pathName, atime, mtime);
  }
}

function kebabToCamelCase(input: string): string {
  return input.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function parseBooleanLike(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

async function readJsonSource(source: string, ctx: CommandContext): Promise<unknown> {
  if (source === "@-") {
    return adaptToolResultToHost(decodeRestrictedJson(decodeBytesToUtf8(ctx.stdin)));
  }
  if (source.startsWith("@")) {
    const rawPath = source.slice(1);
    const resolved = ctx.fs.resolvePath(ctx.cwd, rawPath);
    return adaptToolResultToHost(decodeRestrictedJson(await ctx.fs.readFile(resolved)));
  }
  return adaptToolResultToHost(decodeRestrictedJson(source));
}

function decodeRestrictedJson(source: string): ResultType<unknown, RestrictedBashOperationError> {
  const decoded = Result.try({
    try: () => JSON.parse(source),
    catch: projectRuntimeError("Opaque restricted Bash JSON parse failure"),
  });
  if (decoded.status === "error") {
    const cause = preserveToolPanic(decoded.error);
    return Result.err(
      new RestrictedBashOperationError({
        operation: "parse_json",
        cause,
        message: opaqueErrorMessage(cause, "Invalid JSON input"),
      }),
    );
  }
  return Result.ok(decoded.value);
}

function decodeNestedToolInput(
  value: unknown,
): ResultType<Record<string, unknown>, RestrictedBashOperationError> {
  const decoded = z.record(z.string(), z.unknown()).safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new RestrictedBashOperationError({
      operation: "decode_tool_input",
      cause: decoded.error,
      message: "Tool input must be a JSON object",
    }),
  );
}

function formatToolOutput(value: unknown): string {
  if (typeof value === "string") return value.endsWith("\n") ? value : `${value}\n`;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildToolServerHeaders(
  context: RestrictedBashContext,
  cwd: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-lilac-safety-mode": "restricted",
  };
  if (context.requestId) headers["x-lilac-request-id"] = context.requestId;
  if (context.sessionId) headers["x-lilac-session-id"] = context.sessionId;
  if (context.requestClient) headers["x-lilac-request-client"] = context.requestClient;
  if (context.controlCapability) {
    headers["x-lilac-control-capability"] = context.controlCapability;
  }
  if (context.currentTurnUserId) {
    headers["x-lilac-current-turn-user-id"] = context.currentTurnUserId;
  }
  if (context.toolCallId) headers["x-lilac-tool-call-id"] = context.toolCallId;
  if (context.subagentProfile) headers["x-lilac-subagent-profile"] = context.subagentProfile;
  headers["x-lilac-cwd"] = cwd;
  return headers;
}

async function readHttpErrorMessage(res: Response): Promise<string> {
  const read = await captureRestrictedBashOperation({
    operation: "read_http_error",
    run: () => res.text(),
  });
  const body = read.status === "ok" ? read.value : "";
  if (body.trim().length === 0) return `${res.status} ${res.statusText}`.trim();
  const parsed = decodeRestrictedJson(body);
  if (parsed.status === "ok") {
    const decoded = z
      .object({ message: z.string().optional(), output: z.string().optional() })
      .passthrough()
      .safeParse(parsed.value);
    if (decoded.success) {
      if (decoded.data.message) return decoded.data.message;
      if (decoded.data.output) return decoded.data.output;
    }
  }
  return body;
}

async function fetchToolHelp(callableId: string, headers: Record<string, string>) {
  const res = await fetch(`${TOOL_SERVER_BACKEND_URL}/help/${encodeURIComponent(callableId)}`, {
    headers,
  });
  if (!res.ok) {
    signalRestrictedBashFailure("fetch_tool_help", await readHttpErrorMessage(res));
  }
  const body = await res.json();
  const decoded = z
    .object({
      primaryPositional: z
        .object({ field: z.string(), variadic: z.boolean().optional() })
        .optional(),
    })
    .safeParse(body);
  if (!decoded.success) {
    signalRestrictedBashFailure("decode_tool_help", "Tool help response is invalid");
  }
  return decoded.data;
}

async function buildNestedToolInput(params: {
  callableId: string;
  args: readonly string[];
  ctx: CommandContext;
  headers: Record<string, string>;
}): Promise<Record<string, unknown>> {
  let input: Record<string, unknown> = {};
  const positionals: string[] = [];
  const bareBooleanFlags: string[] = [];

  for (let i = 0; i < params.args.length; i++) {
    const arg = params.args[i] ?? "";
    if (arg === "--stdin" || arg.startsWith("--stdin=")) {
      const value = arg === "--stdin" ? true : parseBooleanLike(arg.slice("--stdin=".length));
      if (value === false) continue;
      input = adaptToolResultToHost(
        decodeNestedToolInput(
          adaptToolResultToHost(decodeRestrictedJson(decodeBytesToUtf8(params.ctx.stdin))),
        ),
      );
      continue;
    }
    if (arg === "--input") {
      signalRestrictedBashFailure(
        "parse_tool_input",
        "--input requires a value: --input=@file.json, --input=@-, or --input='<json>'",
      );
    }
    if (arg.startsWith("--input=")) {
      const value = arg.slice("--input=".length);
      input = adaptToolResultToHost(decodeNestedToolInput(await readJsonSource(value, params.ctx)));
      continue;
    }
    if (arg === "--") {
      positionals.push(...params.args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const rawKey = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    const rawValue = eq === -1 ? "" : arg.slice(eq + 1);
    if (rawKey.length === 0) continue;

    const isJson = rawKey.endsWith(":json");
    const field = kebabToCamelCase(isJson ? rawKey.slice(0, -":json".length) : rawKey);
    if (isJson) {
      if (eq === -1) {
        signalRestrictedBashFailure("parse_tool_input", `--${field}:json requires a value`);
      }
      input[field] = await readJsonSource(rawValue, params.ctx);
      continue;
    }

    if (eq === -1) {
      bareBooleanFlags.push(rawKey);
      input[field] = true;
    } else {
      input[field] = parseBooleanLike(rawValue) ?? rawValue;
    }
  }

  if (positionals.length > 0) {
    const help = await fetchToolHelp(params.callableId, params.headers);
    const primaryPositional = help.primaryPositional;
    if (!primaryPositional) {
      const bareFlag = bareBooleanFlags[0];
      const flagHint = bareFlag
        ? ` Bare --${bareFlag} was parsed as boolean true; if you meant to pass a value, use --${bareFlag}=<value>.`
        : " If you meant to pass a flag value, use --field=<value>.";
      signalRestrictedBashFailure(
        "parse_tool_input",
        `Tool '${params.callableId}' does not support positional input.${flagHint} Space-separated flag values are not supported; use --input JSON or stdin for structured input.`,
      );
    }
    if (Object.hasOwn(input, primaryPositional.field)) {
      signalRestrictedBashFailure(
        "parse_tool_input",
        `Primary positional conflicts with an existing '${primaryPositional.field}' value from flags or JSON input`,
      );
    }
    if (primaryPositional.variadic === true) {
      input[primaryPositional.field] = positionals;
      return input;
    }

    if (positionals.length > 1) {
      signalRestrictedBashFailure(
        "parse_tool_input",
        `Tool '${params.callableId}' accepts at most one positional argument`,
      );
    }
    input[primaryPositional.field] = positionals[0] ?? "";
  }

  return input;
}

function createToolsCommand(context: RestrictedBashContext) {
  return defineCommand("tools", async (args, ctx): Promise<ExecResult> => {
    const headers = buildToolServerHeaders(context, ctx.cwd);
    const [first, ...rest] = args;

    const runToolsCommand = async (): Promise<ExecResult> => {
      if (!first || first === "--list") {
        const res = await fetch(`${TOOL_SERVER_BACKEND_URL}/list`, { headers });
        if (!res.ok) {
          signalRestrictedBashFailure("list_tools", await readHttpErrorMessage(res));
        }
        return { stdout: formatToolOutput(await res.json()), stderr: "", exitCode: 0 };
      }

      if (first === "--help") {
        const callableId = rest[0];
        if (!callableId) {
          return {
            stdout: "Usage: tools [--list] [--help <callableId>] <callableId> [args...]\n",
            stderr: "",
            exitCode: 0,
          };
        }
        const help = await fetchToolHelp(callableId, headers);
        return { stdout: formatToolOutput(help), stderr: "", exitCode: 0 };
      }

      const callableId = first;
      const input = await buildNestedToolInput({ callableId, args: rest, ctx, headers });
      const res = await fetch(`${TOOL_SERVER_BACKEND_URL}/call`, {
        method: "POST",
        headers,
        body: JSON.stringify({ callableId, input }),
      });
      if (!res.ok) {
        signalRestrictedBashFailure("call_tool", await readHttpErrorMessage(res));
      }
      const decoded = z
        .object({ isError: z.boolean(), output: z.unknown() })
        .safeParse(await res.json());
      if (!decoded.success) {
        signalRestrictedBashFailure("decode_tool_result", "Tool call response is invalid");
      }
      const payload = decoded.data;
      if (payload.isError) {
        return { stdout: "", stderr: formatToolOutput(payload.output), exitCode: 1 };
      }
      return { stdout: formatToolOutput(payload.output), stderr: "", exitCode: 0 };
    };
    const executed = await captureRestrictedBashOperation({
      operation: "run_tools_command",
      run: runToolsCommand,
    });
    if (executed.status === "ok") return executed.value;
    return { stdout: "", stderr: `${executed.error.message}\n`, exitCode: 1 };
  });
}

function resolveRestrictedCwd(input: {
  cwd?: string;
  workspaceRoot: string;
  sessionTmpDir: string;
}): string {
  if (!input.cwd) return WORKSPACE_MOUNT;
  const parsed = parseSshCwdTarget(input.cwd);
  if (parsed.kind === "ssh") {
    signalRestrictedBashFailure("resolve_cwd", "Restricted bash does not allow SSH cwd targets");
  }

  const expanded = path.resolve(expandTilde(parsed.cwd ?? input.cwd));
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const sessionTmpDir = path.resolve(input.sessionTmpDir);

  if (expanded === workspaceRoot) return WORKSPACE_MOUNT;
  if (expanded.startsWith(`${workspaceRoot}${path.sep}`)) {
    return posixPath.join(
      WORKSPACE_MOUNT,
      path.relative(workspaceRoot, expanded).split(path.sep).join("/"),
    );
  }
  if (expanded === sessionTmpDir) return TMP_MOUNT;
  if (expanded.startsWith(`${sessionTmpDir}${path.sep}`)) {
    return posixPath.join(
      TMP_MOUNT,
      path.relative(sessionTmpDir, expanded).split(path.sep).join("/"),
    );
  }
  if (input.cwd === TMP_MOUNT || input.cwd.startsWith(`${TMP_MOUNT}/`)) return input.cwd;
  if (input.cwd === WORKSPACE_MOUNT || input.cwd.startsWith(`${WORKSPACE_MOUNT}/`))
    return input.cwd;

  signalRestrictedBashFailure(
    "resolve_cwd",
    "Restricted bash cwd is outside the approved workspace and session temp roots",
  );
}

async function createRestrictedBash(params: {
  workspaceRoot: string;
  sessionTmpDir: string;
  context: RestrictedBashContext;
}): Promise<Bash> {
  await fs.mkdir(params.sessionTmpDir, { recursive: true, mode: 0o700 });
  if (params.context.workspaceWritable) {
    const workspaceStats = await fs.lstat(params.workspaceRoot);
    if (
      workspaceStats.isSymbolicLink() ||
      !workspaceStats.isDirectory() ||
      (await fs.realpath(params.workspaceRoot)) !== params.workspaceRoot
    ) {
      signalRestrictedBashFailure(
        "create_runtime",
        "Restricted writable workspace must be a canonical real directory",
      );
    }
  }

  const workspaceFs = new RestrictedReadFs(
    params.context.workspaceWritable
      ? new ReadWriteFs({
          root: params.workspaceRoot,
          maxFileReadSize: MAX_RESTRICTED_FILE_READ_BYTES,
          allowSymlinks: false,
        })
      : new OverlayFs({
          root: params.workspaceRoot,
          mountPoint: "/",
          maxFileReadSize: MAX_RESTRICTED_FILE_READ_BYTES,
          allowSymlinks: false,
        }),
    false,
    params.workspaceRoot,
  );

  const tmpFs = new ReadWriteFs({
    root: params.sessionTmpDir,
    maxFileReadSize: MAX_RESTRICTED_FILE_READ_BYTES,
    allowSymlinks: false,
  });

  const mountable = new MountableFs({
    base: new RestrictedReadFs(new InMemoryFs(), true),
    mounts: [
      { mountPoint: WORKSPACE_MOUNT, filesystem: workspaceFs },
      { mountPoint: TMP_MOUNT, filesystem: tmpFs },
    ],
  });

  return new Bash({
    fs: mountable,
    cwd: WORKSPACE_MOUNT,
    env: {
      HOME: "/home/user",
      TMPDIR: TMP_MOUNT,
      LILAC_RESTRICTED: "1",
      LILAC_RESTRICTED_TMP: TMP_MOUNT,
      ...(params.context.requestId ? { LILAC_REQUEST_ID: params.context.requestId } : {}),
      ...(params.context.sessionId ? { LILAC_SESSION_ID: params.context.sessionId } : {}),
      ...(params.context.requestClient
        ? { LILAC_REQUEST_CLIENT: params.context.requestClient }
        : {}),
      ...(params.context.currentTurnUserId
        ? { LILAC_CURRENT_TURN_USER_ID: params.context.currentTurnUserId }
        : {}),
    },
    customCommands: [createToolsCommand(params.context)],
    defenseInDepth: true,
    executionLimits: {
      maxCommandCount: 10000,
      maxLoopIterations: 10000,
      maxCallDepth: 100,
      maxAwkIterations: 10000,
      maxSedIterations: 10000,
      maxJqIterations: 10000,
      maxStringLength: 10 * 1024 * 1024,
      maxArrayElements: 100000,
      maxGlobOperations: 100000,
      maxSubstitutionDepth: 50,
      maxHeredocSize: 10 * 1024 * 1024,
    },
  });
}

async function getRestrictedBash(params: {
  requestId?: string;
  workspaceRoot: string;
  sessionTmpDir: string;
  context: RestrictedBashContext;
}): Promise<Bash> {
  const now = Date.now();
  pruneRestrictedBashCache(now);

  if (!params.requestId) {
    return await createRestrictedBash(params);
  }
  const cacheKey = JSON.stringify([
    params.context.sessionId ?? "",
    params.requestId,
    params.workspaceRoot,
    params.context.toolCallId ?? "",
    params.context.currentTurnUserId ?? "",
    params.context.workspaceWritable ? "write" : "read",
  ]);

  const cached = restrictedBashByRequest.get(cacheKey);
  if (cached) {
    cached.lastAccess = now;
    return cached.bash;
  }

  const bash = await createRestrictedBash(params);
  restrictedBashByRequest.set(cacheKey, { bash, lastAccess: now });
  return bash;
}

export async function executeRestrictedBash(
  { command, cwd, timeoutMs, stdinMode }: BashToolInput,
  options: {
    workspaceRoot?: string;
    context?: RestrictedBashContext;
    abortSignal?: AbortSignal;
    toolCallId?: string;
    artifacts?: ToolResultArtifactStore;
    outputConfig?: CoreConfig["tools"]["output"];
  } = {},
): Promise<BashToolOutput> {
  if (stdinMode === "eof") {
    // just-bash commands see empty stdin by default; keep accepting this compatibility flag.
  }

  const context = { ...options.context, toolCallId: options.toolCallId };
  const workspaceRoot = path.resolve(expandTilde(options.workspaceRoot ?? process.cwd()));
  const sessionTmpDir = resolveRestrictedSessionTmpDir(context.sessionId);

  const resolvedCwd = captureRestrictedBashSync({
    operation: "resolve_cwd",
    run: () => resolveRestrictedCwd({ cwd, workspaceRoot, sessionTmpDir }),
  });
  if (resolvedCwd.status === "error") {
    return {
      stdout: "",
      stderr: resolvedCwd.error.message,
      exitCode: -1,
      executionError: {
        type: "blocked",
        reason: "restricted_bash_cwd",
      },
    };
  }
  const restrictedCwd = resolvedCwd.value;

  const wallClockTimeoutMs = Math.min(
    timeoutMs ?? RESTRICTED_BASH_WALL_TIMEOUT_MS,
    RESTRICTED_BASH_WALL_TIMEOUT_MS,
  );
  const controller = new AbortController();
  let termination: RestrictedBashTermination | undefined;
  const terminate = (reason: RestrictedBashTermination) => {
    if (termination) return;
    termination = reason;
    controller.abort();
  };
  const timeout = setTimeout(() => {
    terminate("wall_clock");
  }, wallClockTimeoutMs);
  timeout.unref?.();

  const abortListener = () => terminate("aborted");
  if (options.abortSignal) {
    if (options.abortSignal.aborted) abortListener();
    else options.abortSignal.addEventListener("abort", abortListener, { once: true });
  }

  const runRestrictedExecution = async (): Promise<BashToolOutput> => {
    // just-bash temporarily locks down dynamic constructors while executing a script.
    // Initialize the Result adapter before entering that host-controlled section.
    await captureRestrictedBashOperation({
      operation: "initialize_result_adapter",
      run: () => Promise.resolve(),
    });
    const bash = await getRestrictedBash({
      requestId: context.requestId,
      workspaceRoot,
      sessionTmpDir,
      context,
    });
    const result = await bash.exec(command, {
      cwd: restrictedCwd,
      replaceEnv: false,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", abortListener);
    const executionError = toRestrictedTerminationError(termination, wallClockTimeoutMs);
    const output: BashToolOutput = {
      stdout: sanitizeBashOutputText(result.stdout),
      stderr: sanitizeBashOutputText(result.stderr),
      exitCode: result.exitCode,
      ...(executionError ? { executionError } : {}),
    };
    const outputConfig = options.outputConfig ?? {
      maxPreviewBytes: 40 * 1024,
      artifactTtlMs: 7 * 24 * 60 * 60 * 1000,
      artifactMaxBytesPerSession: 50 * 1024 * 1024,
    };
    const isTruncated =
      Buffer.byteLength(output.stdout, "utf8") + Buffer.byteLength(output.stderr, "utf8") >
      outputConfig.maxPreviewBytes;
    let artifactUri: string | undefined;
    if (
      isTruncated &&
      options.artifacts &&
      context.sessionId &&
      context.requestId &&
      options.toolCallId
    ) {
      const artifacts = options.artifacts;
      const sessionId = context.sessionId;
      const requestId = context.requestId;
      const toolCallId = options.toolCallId;
      const created = await captureRestrictedBashOperation({
        operation: "persist_artifact",
        run: () =>
          artifacts.createFromStream({
            sessionId,
            requestId,
            toolCallId,
            toolName: "bash",
            source: Readable.from([
              "--- stdout ---\n",
              output.stdout,
              "\n\n--- stderr ---\n",
              output.stderr,
              "\n",
            ]),
            ttlMs: outputConfig.artifactTtlMs,
            maxBytesPerSession: outputConfig.artifactMaxBytesPerSession,
          }),
      });
      if (created.status === "error") {
        logger.warn("tool.artifact.write_failed", {
          toolName: "bash",
          ...formatTaggedErrorForLog(created.error),
        });
      } else {
        const artifact = created.value;
        if (artifact.status === "ok") artifactUri = artifact.value.uri;
        else {
          logger.warn("tool.artifact.write_failed", {
            toolName: "bash",
            ...formatTaggedErrorForLog(artifact.error),
          });
        }
      }
    }
    return withLimitedBashOutput(output, {
      maxOutputBytes: outputConfig.maxPreviewBytes,
      truncated: isTruncated,
      artifactUri,
      originalStdoutBytes: Buffer.byteLength(output.stdout, "utf8"),
      originalStderrBytes: Buffer.byteLength(output.stderr, "utf8"),
    });
  };
  let executed: ResultType<BashToolOutput, RestrictedBashOperationError>;
  try {
    executed = await captureRestrictedBashOperation({
      operation: "execute",
      run: runRestrictedExecution,
    });
  } finally {
    clearTimeout(timeout);
    options.abortSignal?.removeEventListener("abort", abortListener);
  }
  if (executed.status === "error") {
    const executionError = toRestrictedTerminationError(termination, wallClockTimeoutMs) ?? {
      type: "exception" as const,
      phase: "unknown" as const,
      message: executed.error.message,
    };
    return {
      stdout: "",
      stderr: executed.error.message,
      exitCode: -1,
      executionError,
    };
  }
  return executed.value;
}
