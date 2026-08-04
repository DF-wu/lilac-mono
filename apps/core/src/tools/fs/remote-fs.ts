import type {
  BundledRemoteRunnerRequest,
  FileEdit,
  FsBackend,
  HashlineEdit,
  ReadFileStart,
  RemoteFsRequest,
  RemoteEditResponse as ProtocolRemoteEditResponse,
  RemoteFuzzySearchResponse as ProtocolRemoteFuzzySearchResponse,
  RemoteGlobResponse as ProtocolRemoteGlobResponse,
  RemoteGrepResponse as ProtocolRemoteGrepResponse,
  RemoteReadBytesResponse as ProtocolRemoteReadBytesResponse,
  RemoteReadTextResponse as ProtocolRemoteReadTextResponse,
  RemoteRunnerResponseDecodeError,
} from "@stanley2058/lilac-fs";
import {
  decodeRemoteEditResponseJson,
  decodeRemoteFuzzySearchResponseJson,
  decodeRemoteGlobResponseJson,
  decodeRemoteGrepResponseJson,
  decodeRemoteReadBytesResponseJson,
  decodeRemoteReadTextResponseJson,
} from "@stanley2058/lilac-fs";
import { createRequire } from "node:module";
import path from "node:path";

import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { projectRuntimeError } from "../../runtime/error-format";
import {
  SshExecutionAdapterError,
  SshExecutionCancelledError,
  SshExecutionOutputCappedError,
  SshExecutionTimedOutError,
  SshExecutionTransportError,
  type SshJsonExecutionError,
  SshSubprocessExitError,
  serializeRemoteRunnerRequestJson,
  sshExecBash,
  sshExecScriptJson,
} from "../../ssh/ssh-exec";
import { getRemoteRunnerJsText, type RemoteRunnerSourceReadError } from "../../ssh/remote-js";
import { preserveToolPanic } from "../tool-result-adapters";

const requirePackageJson = createRequire(import.meta.url);

export type RemoteReadTextInput = {
  path: string;
  start?: ReadFileStart;
  maxLines?: number;
  maxCharacters?: number;
  maxBytes?: number;
  format?: "raw" | "numbered" | "hashline";
};

export type RemoteReadTextOutput = ProtocolRemoteReadTextResponse;
export type RemoteReadBytesResult = ProtocolRemoteReadBytesResponse;
export type RemoteGlobEntry = Extract<
  ProtocolRemoteGlobResponse,
  { mode: "detailed" }
>["entries"][number];
export type RemoteGlobOutput = ProtocolRemoteGlobResponse;
export type RemoteGrepMatch = Extract<
  ProtocolRemoteGrepResponse,
  { mode: "detailed" }
>["results"][number];
export type RemoteGrepOutput = ProtocolRemoteGrepResponse;
export type RemoteFuzzySearchOutput = ProtocolRemoteFuzzySearchResponse;

export type RemoteEditInput =
  | {
      path: string;
      edits: FileEdit[];
      expectedHash?: string;
      mode?: "legacy";
    }
  | {
      path: string;
      edits: readonly HashlineEdit[];
      mode: "hashline";
      expectedHash?: string;
    };

export type RemoteEditOutput = ProtocolRemoteEditResponse;
export class RemoteFsRunnerSetupError extends TaggedError("RemoteFsRunnerSetupError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type RemoteFsExecutionError =
  | SshJsonExecutionError
  | RemoteRunnerResponseDecodeError
  | RemoteRunnerSourceReadError
  | RemoteFsRunnerSetupError;

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHARS = 500_000;
const remoteFsRunnerPackageSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

function toMutableHashlineLines(
  lines: HashlineEdit["lines"],
): string | string[] | null | undefined {
  if (typeof lines === "string" || lines === null || lines === undefined) return lines;
  return [...lines];
}

function toBundledRemoteEditRequest(
  input: RemoteEditInput,
  denyPaths: readonly string[],
): Extract<BundledRemoteRunnerRequest, { op: "fs.edit" }> {
  if (input.mode === "hashline") {
    return {
      op: "fs.edit",
      denyPaths: [...denyPaths],
      input: {
        ...input,
        edits: input.edits.map((edit) => ({
          ...edit,
          lines: toMutableHashlineLines(edit.lines),
        })),
      },
    };
  }
  if (input.mode === "legacy") {
    return {
      op: "fs.edit",
      denyPaths: [...denyPaths],
      input: {
        path: input.path,
        edits: [...input.edits],
        expectedHash: input.expectedHash,
        mode: "legacy",
      },
    };
  }
  return {
    op: "fs.edit",
    denyPaths: [...denyPaths],
    input: {
      path: input.path,
      edits: [...input.edits],
      expectedHash: input.expectedHash,
    },
  };
}

function decodeRemoteFsRunnerPackageSpec(): ResultType<string, RemoteFsRunnerSetupError> {
  const loaded = Result.try({
    try: (): unknown => requirePackageJson("@stanley2058/lilac-remote-fs-runner/package.json"),
    catch: projectRuntimeError("Opaque remote fs runner setup failure"),
  });
  if (loaded.status === "error") {
    const cause = preserveToolPanic(loaded.error);
    return Result.err(
      new RemoteFsRunnerSetupError({
        cause,
        message: "remote fs runner package.json could not be loaded",
      }),
    );
  }
  const packageJson = remoteFsRunnerPackageSchema.safeParse(loaded.value);
  if (!packageJson.success) {
    return Result.err(
      new RemoteFsRunnerSetupError({
        cause: packageJson.error,
        message: "remote fs runner package.json is invalid",
      }),
    );
  }
  return Result.ok(`${packageJson.data.name}@${packageJson.data.version}`);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function splitRemoteGrepTarget(cwd: string): {
  launchCwd: string;
  baseDir: string;
  reportedFilePath: string;
} {
  const target = cwd.length > 1 ? cwd.replace(/\/+$/u, "") : cwd;
  return {
    launchCwd: path.posix.dirname(target),
    baseDir: path.posix.basename(target) || target,
    reportedFilePath: cwd,
  };
}

function buildRemoteFsRunnerCommand(): ResultType<string, RemoteFsRunnerSetupError> {
  const override = process.env.LILAC_REMOTE_FS_RUNNER_COMMAND;
  if (override && override.trim().length > 0) return Result.ok(override);

  let packageSpecValue = process.env.LILAC_REMOTE_FS_RUNNER_PACKAGE;
  if (!packageSpecValue) {
    const decoded = decodeRemoteFsRunnerPackageSpec();
    if (decoded.status === "error") return Result.err(decoded.error);
    packageSpecValue = decoded.value;
  }
  const packageSpec = shellSingleQuote(packageSpecValue);
  return Result.ok(`if command -v bunx >/dev/null 2>&1; then
  bunx ${packageSpec} request
elif command -v npx >/dev/null 2>&1; then
  npx --no-workspaces -y ${packageSpec} request
else
  echo '{"ok":false,"error":"Remote host has neither npx nor bunx in PATH"}'
fi`);
}

async function sshExecRemoteFsRunnerJson<T>(params: {
  host: string;
  cwd: string;
  input: RemoteFsRequest;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
  decodeResponse: (text: string) => ResultType<T, RemoteRunnerResponseDecodeError>;
}): Promise<ResultType<T, RemoteFsExecutionError>> {
  const serializedInput = serializeRemoteRunnerRequestJson(params.input);
  if (serializedInput.status === "error") return Result.err(serializedInput.error);
  const inputJson = serializedInput.value;
  const runnerCommandResult = buildRemoteFsRunnerCommand();
  if (runnerCommandResult.status === "error") return Result.err(runnerCommandResult.error);
  const runnerCommand = runnerCommandResult.value;

  const script = `#!/usr/bin/env bash
set -euo pipefail

REMOTE_CWD=$(cat <<'__LILAC_REMOTE_CWD__'
${params.cwd}
__LILAC_REMOTE_CWD__
)

if [ -n "$REMOTE_CWD" ]; then
  if [ "$REMOTE_CWD" = "~" ]; then
    REMOTE_CWD="$HOME"
  elif [[ "$REMOTE_CWD" == "~/"* ]]; then
    REMOTE_CWD="$HOME/\${REMOTE_CWD:2}"
  fi

  if [ ! -d "$REMOTE_CWD" ]; then
    echo '{"ok":false,"error":"Remote cwd does not exist or is not a directory"}'
    exit 0
  fi

  if ! cd "$REMOTE_CWD"; then
    echo '{"ok":false,"error":"Remote cwd is not accessible"}'
    exit 0
  fi
fi

run_remote_fs_runner() {
${runnerCommand}
}

run_remote_fs_runner <<'__LILAC_INPUT__'
${inputJson}
__LILAC_INPUT__
`;

  const executed = await Result.tryPromise({
    try: () =>
      sshExecBash({
        host: params.host,
        cmd: script,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        maxOutputChars: params.maxOutputChars,
      }),
    catch: projectRuntimeError("Opaque remote fs SSH adapter failure"),
  });
  if (executed.status === "error") {
    const cause = preserveToolPanic(executed.error);
    return Result.err(
      new SshExecutionAdapterError({
        cause,
        message: "remote fs runner SSH execution adapter failed",
      }),
    );
  }
  const res = executed.value;

  if (res.aborted) return Result.err(new SshExecutionCancelledError({ message: "aborted" }));
  if (res.timedOut) {
    return Result.err(
      new SshExecutionTimedOutError({
        timeoutMs: params.timeoutMs,
        message: `timeout:${params.timeoutMs}`,
      }),
    );
  }
  if (res.capped.stdout || res.capped.stderr) {
    return Result.err(
      new SshExecutionOutputCappedError({
        message: "remote fs runner output capped (response too large)",
      }),
    );
  }
  if (res.transportError) {
    return Result.err(
      new SshExecutionTransportError({
        transportType: res.transportError.type,
        message: res.transportError.message,
      }),
    );
  }
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim().length > 0 ? `: ${res.stderr.trim()}` : "";
    return Result.err(
      new SshSubprocessExitError({
        exitCode: res.exitCode,
        stderr: res.stderr,
        message: `remote fs runner exited with code ${res.exitCode}${detail}`,
      }),
    );
  }

  return params.decodeResponse(res.stdout.trim());
}

export async function remoteReadTextFile(params: {
  host: string;
  cwd: string;
  input: RemoteReadTextInput;
  denyPaths: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResultType<RemoteReadTextOutput, RemoteFsExecutionError>> {
  const source = await getRemoteRunnerJsText();
  if (source.status === "error") return Result.err(source.error);
  const res = await sshExecScriptJson({
    host: params.host,
    cwd: params.cwd,
    js: source.value,
    input: {
      op: "fs.read_text",
      denyPaths: [...params.denyPaths],
      input: params.input,
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: params.signal,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    decodeResponse: decodeRemoteReadTextResponseJson,
  });

  return res;
}

export async function remoteReadFileBytes(params: {
  host: string;
  cwd: string;
  filePath: string;
  denyPaths: readonly string[];
  maxBytes: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResultType<RemoteReadBytesResult, RemoteFsExecutionError>> {
  // Base64 output can be large (1.33x bytes). Keep a generous cap.
  const maxOutputChars = Math.max(500_000, Math.ceil(params.maxBytes * 1.5) + 10_000);

  const source = await getRemoteRunnerJsText();
  if (source.status === "error") return Result.err(source.error);
  const res = await sshExecScriptJson({
    host: params.host,
    cwd: params.cwd,
    js: source.value,
    input: {
      op: "fs.read_bytes",
      denyPaths: [...params.denyPaths],
      input: { path: params.filePath, maxBytes: params.maxBytes },
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: params.signal,
    maxOutputChars,
    decodeResponse: decodeRemoteReadBytesResponseJson,
  });

  return res;
}

export async function remoteGlob(params: {
  host: string;
  cwd: string;
  patterns: readonly string[];
  maxEntries?: number;
  mode?: "default" | "detailed";
  denyPaths: readonly string[];
  fsBackend?: FsBackend;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResultType<RemoteGlobOutput, RemoteFsExecutionError>> {
  const mode = params.mode ?? "default";
  const input: RemoteFsRequest = {
    op: "fs.glob",
    denyPaths: [...params.denyPaths],
    input: {
      patterns: [...params.patterns],
      maxEntries: params.maxEntries,
      mode,
    },
  };

  if (params.fsBackend === "fff") {
    const runnerRes = await sshExecRemoteFsRunnerJson({
      host: params.host,
      cwd: params.cwd,
      input,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
      signal: params.signal,
      decodeResponse: decodeRemoteGlobResponseJson,
    });
    if (runnerRes.status === "ok") return runnerRes;
    if (runnerRes.error._tag === "SshExecutionCancelledError") return runnerRes;
  }

  const source = await getRemoteRunnerJsText();
  if (source.status === "error") return Result.err(source.error);
  const res = await sshExecScriptJson({
    host: params.host,
    cwd: params.cwd,
    js: source.value,
    input,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: params.signal,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    decodeResponse: decodeRemoteGlobResponseJson,
  });

  return res;
}

export async function remoteGrep(params: {
  host: string;
  cwd: string;
  input: {
    pattern: string;
    regex?: boolean;
    maxResults?: number;
    fileExtensions?: readonly string[];
    includeContextLines?: number;
    mode?: "default" | "detailed" | "hashline";
  };
  denyPaths: readonly string[];
  fsBackend?: FsBackend;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResultType<RemoteGrepOutput, RemoteFsExecutionError>> {
  const mode = params.input.mode ?? "default";
  const target = splitRemoteGrepTarget(params.cwd);
  const input: RemoteFsRequest = {
    op: "fs.grep",
    denyPaths: [...params.denyPaths],
    input: {
      pattern: params.input.pattern,
      regex: params.input.regex,
      maxResults: params.input.maxResults,
      fileExtensions: params.input.fileExtensions ? [...params.input.fileExtensions] : undefined,
      includeContextLines: params.input.includeContextLines,
      mode,
      baseDir: target.baseDir,
      reportedFilePath: target.reportedFilePath,
    },
  };

  if (params.fsBackend === "fff") {
    const runnerRes = await sshExecRemoteFsRunnerJson({
      host: params.host,
      cwd: target.launchCwd,
      input,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
      signal: params.signal,
      decodeResponse: decodeRemoteGrepResponseJson,
    });
    if (runnerRes.status === "ok") return runnerRes;
    if (runnerRes.error._tag === "SshExecutionCancelledError") return runnerRes;
  }

  const source = await getRemoteRunnerJsText();
  if (source.status === "error") return Result.err(source.error);
  const res = await sshExecScriptJson({
    host: params.host,
    cwd: target.launchCwd,
    js: source.value,
    input,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: params.signal,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    decodeResponse: decodeRemoteGrepResponseJson,
  });

  return res;
}

export async function remoteFuzzySearch(params: {
  host: string;
  cwd: string;
  input: {
    query: string;
    maxResults?: number;
  };
  denyPaths: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResultType<RemoteFuzzySearchOutput, RemoteFsExecutionError>> {
  const input: RemoteFsRequest = {
    op: "fs.fuzzy_search",
    denyPaths: [...params.denyPaths],
    input: {
      query: params.input.query,
      maxResults: params.input.maxResults,
    },
  };

  const runnerRes = await sshExecRemoteFsRunnerJson({
    host: params.host,
    cwd: params.cwd,
    input,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    signal: params.signal,
    decodeResponse: decodeRemoteFuzzySearchResponseJson,
  });
  return runnerRes;
}

export async function remoteEditFile(params: {
  host: string;
  cwd: string;
  input: RemoteEditInput;
  denyPaths: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ResultType<RemoteEditOutput, RemoteFsExecutionError>> {
  const source = await getRemoteRunnerJsText();
  if (source.status === "error") return Result.err(source.error);
  const res = await sshExecScriptJson({
    host: params.host,
    cwd: params.cwd,
    js: source.value,
    input: toBundledRemoteEditRequest(params.input, params.denyPaths),
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: params.signal,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    decodeResponse: decodeRemoteEditResponseJson,
  });

  return res;
}

// For unit tests and future callsites.
export function toRemoteDebugPath(host: string, resolvedPath: string): string {
  if (resolvedPath.startsWith("ssh://")) return resolvedPath;
  const p = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`;
  return `ssh://${host}${p}`;
}
