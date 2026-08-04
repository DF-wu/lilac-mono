import fs from "node:fs/promises";

import { BufferedFileSink } from "@stanley2058/lilac-coding-tools/buffered-file-sink";

import { requireConfiguredSshHost } from "./ssh-config";

const DEFAULT_CONNECT_TIMEOUT_SECS = 10;
const DEFAULT_SSH_STDIN_MODE: SshBashStdinMode = "error";

export type SshBashStdinMode = "error" | "eof";

export type SshExecOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Maximum stdout/stderr characters to capture per stream.
   * If output exceeds this cap, it is truncated and `capped=true`.
   */
  maxOutputChars: number;
  overflowOutputPath?: string;
};

export type SshExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  capped: { stdout: boolean; stderr: boolean };
  overflowPaths: { stdout?: string; stderr?: string };
};

type StreamTextResult = {
  text: string;
  totalChars: number;
  capped: boolean;
  overflowFilePath?: string;
};

function isResponseBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === "string" ||
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ReadableStream
  );
}

export async function readStreamTextCapped(
  stream: unknown,
  maxChars: number,
  options?: { overflowFilePath?: string; onActivity?: () => void },
): Promise<StreamTextResult> {
  if (!stream || typeof stream === "number") {
    return { text: "", totalChars: 0, capped: false };
  }

  const maybeReadable = stream as { getReader?: unknown };
  if (typeof maybeReadable.getReader === "function") {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    let text = "";
    let totalChars = 0;
    let capped = false;
    let overflowWriteFailed = false;
    let overflowFilePath: string | undefined;
    let overflowSink: BufferedFileSink | undefined;
    let overflowFileCreated = false;
    const bufferedRawChunks: Buffer[] | undefined = options?.overflowFilePath ? [] : undefined;

    const failOverflow = async () => {
      overflowWriteFailed = true;
      overflowFilePath = undefined;
      const sink = overflowSink;
      overflowSink = undefined;
      await sink?.abort();
      if (overflowFileCreated && options?.overflowFilePath) {
        await fs.rm(options.overflowFilePath, { force: true }).catch(() => undefined);
      }
      overflowFileCreated = false;
      if (bufferedRawChunks) bufferedRawChunks.length = 0;
    };

    const writeOverflowChunk = async (chunk: Uint8Array) => {
      if (chunk.byteLength === 0) return;
      if (overflowWriteFailed) return;
      const target = options?.overflowFilePath;
      if (!target) return;

      try {
        if (!overflowSink) {
          overflowSink = await BufferedFileSink.open(target, { flags: "wx", mode: 0o600 });
          overflowFileCreated = true;
        }
        await overflowSink.write(chunk);
        overflowFilePath = target;
      } catch {
        await failOverflow();
      }
    };

    const activateOverflow = async () => {
      if (!bufferedRawChunks) return;
      for (const chunk of bufferedRawChunks) await writeOverflowChunk(chunk);
      bufferedRawChunks.length = 0;
    };

    const consumeChunkText = async (chunkText: string) => {
      if (chunkText.length === 0) return;

      totalChars += chunkText.length;

      if (capped) return;

      const previousText = text;
      const nextLen = previousText.length + chunkText.length;
      if (nextLen <= maxChars) {
        text = previousText + chunkText;
        return;
      }

      capped = true;
      const remaining = Math.max(0, maxChars - previousText.length);
      text = previousText + chunkText.slice(0, remaining);
      await activateOverflow();
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        options?.onActivity?.();
        if (capped) await writeOverflowChunk(value);
        else if (bufferedRawChunks) bufferedRawChunks.push(Buffer.from(value));
        const chunkText = decoder.decode(value, { stream: true });
        await consumeChunkText(chunkText);
      }

      const tail = decoder.decode();
      if (tail.length > 0) {
        await consumeChunkText(tail);
      }
      if (overflowSink) {
        try {
          await overflowSink.close();
        } catch {
          await failOverflow();
        }
      }
    } catch (error) {
      await failOverflow();
      throw error;
    } finally {
      reader.releaseLock();
    }

    return { text, totalChars, capped, overflowFilePath };
  }

  const response = new Response(isResponseBodyInit(stream) ? stream : String(stream));
  const fullBytes = Buffer.from(await response.arrayBuffer());
  const full = new TextDecoder().decode(fullBytes);
  const capped = full.length > maxChars;
  let overflowFilePath: string | undefined;
  if (capped && options?.overflowFilePath) {
    let sink: BufferedFileSink | undefined;
    let overflowFileCreated = false;
    try {
      sink = await BufferedFileSink.open(options.overflowFilePath, { flags: "wx", mode: 0o600 });
      overflowFileCreated = true;
      await sink.write(fullBytes);
      await sink.close();
      overflowFilePath = options.overflowFilePath;
    } catch {
      await sink?.abort();
      if (overflowFileCreated) {
        await fs.rm(options.overflowFilePath, { force: true }).catch(() => undefined);
      }
    }
  }

  return {
    text: full.length > maxChars ? full.slice(0, maxChars) : full,
    totalChars: full.length,
    capped,
    overflowFilePath,
  };
}

function inferTransportError(
  stderr: string,
): { type: "hostkey" | "auth" | "connect" | "unknown"; message: string } | undefined {
  const s = stderr.toLowerCase();
  if (s.includes("host key verification failed")) {
    return { type: "hostkey", message: "Host key verification failed" };
  }
  if (s.includes("permission denied")) {
    return { type: "auth", message: "Permission denied" };
  }
  if (
    s.includes("connection refused") ||
    s.includes("timed out") ||
    s.includes("could not resolve hostname")
  ) {
    return { type: "connect", message: "Failed to connect" };
  }
  return undefined;
}

function buildRemoteScript(params: { cmd: string; cwd?: string; stdinMode?: SshBashStdinMode }) {
  const stdinMode = params.stdinMode ?? DEFAULT_SSH_STDIN_MODE;
  const cwd = params.cwd ?? "";
  const runCommandSnippet =
    stdinMode === "error"
      ? 'bash --noprofile --norc "$TMP_CMD" </dev/null'
      : 'bash --noprofile --norc "$TMP_CMD"';
  return `#!/usr/bin/env bash
set -euo pipefail

CWD=$(cat <<'__LILAC_CWD__'
${cwd}
__LILAC_CWD__
)

TMP_CMD=""
cleanup() {
  if [ -n "$TMP_CMD" ]; then
    rm -f "$TMP_CMD" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if command -v mktemp >/dev/null 2>&1; then
  TMP_CMD=$(mktemp -t lilac-ssh-cmd.XXXXXX)
else
  TMP_CMD="/tmp/lilac-ssh-cmd.$$"
fi

cat >"$TMP_CMD" <<'__LILAC_CMD__'
${params.cmd}
__LILAC_CMD__

if [ -n "$CWD" ]; then
  if [ "$CWD" = "~" ]; then
    CWD="$HOME"
  elif [[ "$CWD" == "~/"* ]]; then
    CWD="$HOME/\${CWD:2}"
  fi
  cd "$CWD"
fi

# Run under a clean bash to avoid remote environment surprises (rc/profile).
${runCommandSnippet}

exit 0
`;
}

function buildSshChildEnv(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };

  delete childEnv.FORCE_COLOR;
  childEnv.NO_COLOR = "1";

  return childEnv;
}

export async function sshExecBash(params: {
  host: string;
  cmd: string;
  cwd?: string;
  stdinMode?: SshBashStdinMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputChars: number;
  overflowOutputPath?: string;
  onActivity?: () => void;
}): Promise<
  SshExecResult & {
    transportError?: { type: "hostkey" | "auth" | "connect" | "unknown"; message: string };
  }
> {
  await requireConfiguredSshHost(params.host);

  const controller = new AbortController();
  let termination: "timeout" | "aborted" | undefined;

  let child: ReturnType<typeof Bun.spawn> | null = null;

  const killProcessGroupBestEffort = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-pid, signal);
    } catch {
      // ignore
    }
    try {
      process.kill(pid, signal);
    } catch {
      // ignore
    }
  };

  const HARD_KILL_DELAY_MS = 2000;
  let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleHardKill = () => {
    if (hardKillTimer) return;
    hardKillTimer = setTimeout(() => {
      const pid = (child as { pid?: unknown } | null)?.pid;
      if (typeof pid === "number" && pid > 0) {
        killProcessGroupBestEffort(pid, "SIGKILL");
      }
    }, HARD_KILL_DELAY_MS);
    hardKillTimer.unref?.();
  };

  const terminate = (reason: "timeout" | "aborted") => {
    if (termination) return;
    termination = reason;
    controller.abort();
    const pid = child?.pid;
    if (pid) {
      killProcessGroupBestEffort(pid, "SIGTERM");
      scheduleHardKill();
    }
  };

  let abortListener: (() => void) | null = null;
  if (params.signal) {
    const onAbort = () => terminate("aborted");
    if (params.signal.aborted) {
      onAbort();
    } else {
      params.signal.addEventListener("abort", onAbort, { once: true });
      abortListener = () => params.signal?.removeEventListener("abort", onAbort);
    }
  }

  const timeout =
    params.timeoutMs === undefined
      ? undefined
      : setTimeout(() => terminate("timeout"), params.timeoutMs);
  const stopWatchingExecution = () => {
    if (timeout) clearTimeout(timeout);
    abortListener?.();
    abortListener = null;
    if (hardKillTimer && !termination) {
      clearTimeout(hardKillTimer);
      hardKillTimer = null;
    }
  };

  const startedAt = Date.now();
  try {
    const sshArgs = [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      `ConnectTimeout=${DEFAULT_CONNECT_TIMEOUT_SECS}`,
      "-o",
      "LogLevel=ERROR",
      params.host,
      "bash",
      "--noprofile",
      "--norc",
      "-s",
    ];

    const script = buildRemoteScript({
      cmd: params.cmd,
      cwd: params.cwd,
      stdinMode: params.stdinMode,
    });

    child = Bun.spawn(["ssh", ...sshArgs], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([script]),
      signal: controller.signal,
      killSignal: "SIGTERM",
      detached: true,
      env: buildSshChildEnv(),
    });

    const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
      readStreamTextCapped(child.stdout, params.maxOutputChars, {
        overflowFilePath: params.overflowOutputPath
          ? `${params.overflowOutputPath}.stdout.part`
          : undefined,
        onActivity: params.onActivity,
      }),
      readStreamTextCapped(child.stderr, params.maxOutputChars, {
        overflowFilePath: params.overflowOutputPath
          ? `${params.overflowOutputPath}.stderr.part`
          : undefined,
        onActivity: params.onActivity,
      }),
      child.exited,
    ]);
    stopWatchingExecution();

    const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value.text : "";
    const stderr = stderrResult.status === "fulfilled" ? stderrResult.value.text : "";
    const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;

    const transportError = exitCode === 255 ? inferTransportError(stderr) : undefined;

    return {
      stdout,
      stderr,
      exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: termination === "timeout",
      aborted: termination === "aborted",
      capped: {
        stdout: stdoutResult.status === "fulfilled" ? stdoutResult.value.capped : false,
        stderr: stderrResult.status === "fulfilled" ? stderrResult.value.capped : false,
      },
      overflowPaths: {
        stdout:
          stdoutResult.status === "fulfilled" ? stdoutResult.value.overflowFilePath : undefined,
        stderr:
          stderrResult.status === "fulfilled" ? stderrResult.value.overflowFilePath : undefined,
      },
      transportError,
    };
  } finally {
    stopWatchingExecution();
  }
}

export async function sshExecScriptJson<T>(params: {
  host: string;
  cwd: string;
  js: string;
  input: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputChars: number;
}): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const inputJson = JSON.stringify(params.input);

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

TMP_JS=""
cleanup() {
  if [ -n "$TMP_JS" ]; then
    rm -f "$TMP_JS" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if command -v mktemp >/dev/null 2>&1; then
  TMP_JS=$(mktemp -t lilac-remote-tool.XXXXXX)
else
  TMP_JS="/tmp/lilac-remote-tool.$$"
fi

cat >"$TMP_JS" <<'__LILAC_JS__'
${params.js}
__LILAC_JS__

if command -v bun >/dev/null 2>&1; then
  cat <<'__LILAC_INPUT__' | bun "$TMP_JS"
${inputJson}
__LILAC_INPUT__
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  cat <<'__LILAC_INPUT__' | node "$TMP_JS"
${inputJson}
__LILAC_INPUT__
  exit 0
fi

echo '{"ok":false,"error":"Remote host has neither bun nor node in PATH"}'
exit 0
`;

  const res = await sshExecBash({
    host: params.host,
    cmd: script,
    cwd: undefined,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    maxOutputChars: params.maxOutputChars,
  });

  if (res.aborted) return { ok: false, error: "aborted" };
  if (res.timedOut) return { ok: false, error: `timeout:${params.timeoutMs}` };
  if (res.capped.stdout || res.capped.stderr) {
    return { ok: false, error: "remote output capped (response too large)" };
  }

  const stdoutTrim = res.stdout.trim();
  try {
    const parsed = JSON.parse(stdoutTrim) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "ok" in parsed &&
      (parsed as { ok?: unknown }).ok === true &&
      "value" in parsed
    ) {
      return { ok: true, value: (parsed as { value: T }).value };
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "ok" in parsed &&
      (parsed as { ok?: unknown }).ok === false
    ) {
      const err =
        (parsed as { error?: unknown }).error !== undefined
          ? String((parsed as { error?: unknown }).error)
          : "remote script error";
      return { ok: false, error: err };
    }
    return { ok: false, error: "remote returned unexpected JSON" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const detail = res.stderr.trim().length > 0 ? `\n${res.stderr.trim()}` : "";
    return { ok: false, error: `failed to parse remote JSON: ${msg}${detail}` };
  }
}
