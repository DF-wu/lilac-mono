import { z } from "zod";
import path from "node:path";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import { defineServerTool, type ServerTool, type ServerToolCallOptions } from "../types";

import { readConfiguredSshHosts, requireConfiguredSshHostResult } from "../../ssh/ssh-config";
import { preserveToolPanic } from "../../tools/tool-result-adapters";

function captureSshFailure(cause: unknown): { readonly cause: Error | Panic } {
  if (Panic.is(cause)) return { cause };
  if (cause instanceof Error) return { cause };
  return { cause: new Error("SSH operation failed", { cause }) };
}

function settleCapturedError<T, E>(
  result: ResultType<T, { readonly cause: Error | Panic }>,
  resolve: (cause: Error | Panic) => E,
): ResultType<T, E> {
  return result.mapError(({ cause }) => resolve(cause));
}

async function settleCapturedPromise<T, E>(
  result: Promise<ResultType<T, { readonly cause: Error | Panic }>>,
  resolve: (cause: Error | Panic) => E,
): Promise<ResultType<T, E>> {
  return settleCapturedError(await result, resolve);
}

const DEFAULT_SSH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_CONNECT_TIMEOUT_SECS = 10;
const MAX_OUTPUT_CHARS = 200_000;

function sshFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `ssh_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

async function requireSshHost(host: string): Promise<ResultType<void, ServerToolFailure>> {
  return (await requireConfiguredSshHostResult(host)).mapError((error) =>
    sshFailure(error._tag === "SshConfigReadError" ? "unavailable" : "not_found", error.message),
  );
}

const sshProbeOutputSchema = z.strictObject({
  ok: z.literal(true),
  system: z.strictObject({
    uname: z.strictObject({ s: z.string(), m: z.string(), r: z.string() }),
    osRelease: z.strictObject({ id: z.string(), versionId: z.string() }),
    user: z.string(),
    home: z.string(),
    shell: z.string(),
    pwd: z.string(),
  }),
  cwd: z.strictObject({ attempted: z.string(), used: z.string() }),
  git: z.strictObject({
    isRepo: z.boolean(),
    topLevel: z.string(),
    head: z.string(),
    branch: z.string(),
    statusPorcelain: z.string(),
  }),
  expectedTools: z.array(z.string()),
  tools: z.record(
    z.string(),
    z.strictObject({ present: z.boolean(), path: z.string(), version: z.string() }),
  ),
});

export type SshProbeOutput = z.output<typeof sshProbeOutputSchema>;

export class SshProbeOutputInvalid extends TaggedError("SshProbeOutputInvalid")<{
  readonly message: string;
}> {}

export function decodeSshProbeOutput(
  text: string,
): ResultType<SshProbeOutput, SshProbeOutputInvalid> {
  const parsedResult = Result.try({
    try: (): unknown => JSON.parse(text),
    catch: () => new SshProbeOutputInvalid({ message: "SSH probe returned invalid JSON" }),
  });
  const parsedOutcome = parsedResult.match<
    | { readonly kind: "success"; readonly parsed: unknown }
    | { readonly kind: "failure"; readonly error: SshProbeOutputInvalid }
  >({
    ok: (parsed) => ({ kind: "success", parsed }),
    err: (error) => ({ kind: "failure", error }),
  });
  if (parsedOutcome.kind === "failure") return Result.err(parsedOutcome.error);
  const { parsed } = parsedOutcome;
  const decoded = sshProbeOutputSchema.safeParse(parsed);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new SshProbeOutputInvalid({ message: "SSH probe returned an invalid response contract" }),
  );
}

const emptyInputSchema = z.object({});

const runInputSchema = z.object({
  host: z
    .string()
    .min(1)
    .describe("SSH host alias from ~/.ssh/config (or a valid ssh destination like user@host)."),
  cmd: z.string().min(1).describe("Command to execute on the remote host."),
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory on the remote host. If provided, the command runs after `cd`.",
    ),
  timeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional()
    .describe("Timeout in ms (default: 10 minutes)."),
});

type RunInput = z.infer<typeof runInputSchema>;

const probeInputSchema = z.object({
  host: z
    .string()
    .min(1)
    .describe("SSH host alias from ~/.ssh/config. Use ssh.hosts to list configured aliases."),
  cwd: z
    .string()
    .optional()
    .describe(
      "Optional working directory to probe (used for git context). Defaults to the remote default directory.",
    ),
  timeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60 * 1000)
    .optional()
    .describe("Timeout in ms (default: 10 minutes)."),
});

type ProbeInput = z.infer<typeof probeInputSchema>;

let cachedProbeScript: string | null = null;
async function loadProbeScript(): Promise<string> {
  if (cachedProbeScript) return cachedProbeScript;
  const p = path.join(import.meta.dir, "ssh-probe.sh");
  cachedProbeScript = await Bun.file(p).text();
  return cachedProbeScript;
}

function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) return { text, truncated: false as const };
  return { text: text.slice(0, maxChars), truncated: true as const };
}

async function readStreamText(stream: unknown): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  const body: BodyInit = stream instanceof ReadableStream ? stream : String(stream);
  return await new Response(body).text();
}

function preserveSshSettledPanics(results: readonly PromiseSettledResult<unknown>[]): void {
  for (const result of results) {
    if (result.status === "rejected" && Panic.is(result.reason)) {
      preserveToolPanic(result.reason);
    }
  }
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

function buildRemoteScript(input: RunInput) {
  const cwd = input.cwd ?? "";
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
${input.cmd}
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
bash --noprofile --norc "$TMP_CMD"

# Explicitly exit so bash -s doesn't wait for more stdin.
exit 0
`;
}

async function buildProbeScript(input: ProbeInput): Promise<string> {
  const base = await loadProbeScript();
  const cwd = input.cwd ?? "";
  return base.replace("__LILAC_CWD_VALUE__", cwd);
}

export class SSH implements ServerTool {
  id = "ssh";
  private readonly tool: ServerTool;

  constructor() {
    const catalog = async () => {
      const { hosts, readError } = await readConfiguredSshHosts();
      return { hidden: hosts.length === 0 && readError === undefined };
    };

    this.tool = defineServerTool({
      id: this.id,
      callables: ({ callable }) => ({
        "ssh.hosts": callable({
          name: "SSH Hosts",
          description: "List SSH host aliases discovered from ~/.ssh/config on this server.",
          inputSchema: emptyInputSchema,
          validation: "zod",
          catalog,
          run: async () => {
            const { configPath, hosts, exists, readError } = await readConfiguredSshHosts();
            return Result.ok({
              configPath,
              exists,
              hosts,
              readError,
            });
          },
        }),
        "ssh.run": callable({
          name: "SSH Run",
          description:
            "Run a command on a remote host over SSH (StrictHostKeyChecking=yes, BatchMode=yes, bash --noprofile --norc).",
          inputSchema: runInputSchema,
          validation: "zod",
          catalog,
          run: (input, opts) => this.callRun(input, opts?.signal),
        }),
        "ssh.probe": callable({
          name: "SSH Probe",
          description:
            "Probe remote host capabilities (expected tools + basic system and git context).",
          inputSchema: probeInputSchema,
          validation: "zod",
          primaryPositional: "host",
          catalog,
          run: (input, opts) => this.callProbe(input, opts?.signal),
        }),
      }),
    });
  }

  async init(): Promise<void> {
    await this.tool.init();
  }

  async destroy(): Promise<void> {
    await this.tool.destroy();
  }

  async list() {
    return await this.tool.list();
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return await this.tool.call(callableId, input, opts);
  }

  private async callRun(
    input: RunInput,
    signal: AbortSignal | undefined,
  ): Promise<ServerToolResult> {
    const required = await requireSshHost(input.host);
    const requirementFailure = required.match({
      ok: () => undefined,
      err: (failure) => failure,
    });
    if (requirementFailure) return Result.err(requirementFailure);
    if (signal?.aborted) {
      return Result.err(sshFailure("cancelled", "SSH command was cancelled"));
    }

    const effectiveTimeoutMs = input.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;

    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeoutMs);

    const startedAt = Date.now();
    const outcome = await (async () => {
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
        input.host,
        "bash",
        "--noprofile",
        "--norc",
        "-s",
      ];

      const script = buildRemoteScript(input);

      // Important: provide stdin as a finite blob so the remote `bash -s`
      // reliably receives EOF and exits. In some environments, streaming
      // stdin can leave the channel open and hang after producing output.
      const spawned = settleCapturedError(
        Result.try({
          try: () =>
            Bun.spawn(["ssh", ...sshArgs], {
              stdout: "pipe",
              stderr: "pipe",
              stdin: new Blob([script]),
              signal: controller.signal,
              killSignal: "SIGTERM",
              env: {
                ...process.env,
              },
            }),
          catch: captureSshFailure,
        }),
        (cause) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return sshFailure(controller.signal.aborted ? "cancelled" : "unavailable", cause.message);
        },
      );
      const spawnOutcome = spawned.match<
        | { readonly child: Bun.Subprocess<Blob, "pipe", "pipe"> }
        | { readonly failure: ServerToolFailure }
      >({
        ok: (child) => ({ child }),
        err: (failure) => ({ failure }),
      });
      if ("failure" in spawnOutcome)
        return { status: "return", value: Result.err(spawnOutcome.failure) } as const;
      const child = spawnOutcome.child;

      const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
        readStreamText(child.stdout),
        readStreamText(child.stderr),
        child.exited,
      ]);
      preserveSshSettledPanics([stdoutResult, stderrResult, exitResult]);

      const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value : "";
      const stderr = stderrResult.status === "fulfilled" ? stderrResult.value : "";
      const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;

      const durationMs = Date.now() - startedAt;

      const outTrunc = truncateText(stdout, MAX_OUTPUT_CHARS);
      const errTrunc = truncateText(stderr, MAX_OUTPUT_CHARS);

      const transportError = exitCode === 255 ? inferTransportError(stderr) : undefined;
      const processReadFailed =
        stdoutResult.status === "rejected" ||
        stderrResult.status === "rejected" ||
        exitResult.status === "rejected";

      const report = {
        ok: exitCode === 0 && !timedOut && !processReadFailed,
        exitCode,
        durationMs,
        timedOut,
        target: {
          host: input.host,
          cwd: input.cwd,
          strictHostKeyChecking: true,
          batchMode: true,
        },
        stdout: outTrunc.text,
        stderr: errTrunc.text,
        truncated: {
          stdout: outTrunc.truncated,
          stderr: errTrunc.truncated,
        },
        transportError,
        errors: {
          stdoutRead: stdoutResult.status === "rejected" ? "stdout read failed" : undefined,
          stderrRead: stderrResult.status === "rejected" ? "stderr read failed" : undefined,
          exitRead: exitResult.status === "rejected" ? "exit status read failed" : undefined,
          stdinWrite: undefined,
        },
      };
      if (timedOut) {
        return {
          status: "return",
          value: Result.err(
            sshFailure("timeout", `SSH command timed out after ${effectiveTimeoutMs}ms`),
          ),
        } as const;
      }
      if (signal?.aborted) {
        return {
          status: "return",
          value: Result.err(sshFailure("cancelled", "SSH command was cancelled")),
        } as const;
      }
      return { status: "return", value: Result.ok(report) } as const;
    })().finally(() => {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onAbort);
    });
    return outcome.value;
  }

  private async callProbe(
    input: ProbeInput,
    signal: AbortSignal | undefined,
  ): Promise<ServerToolResult> {
    const required = await requireSshHost(input.host);
    const requirementFailure = required.match({
      ok: () => undefined,
      err: (failure) => failure,
    });
    if (requirementFailure) return Result.err(requirementFailure);
    if (signal?.aborted) {
      return Result.err(sshFailure("cancelled", "SSH probe was cancelled"));
    }

    const effectiveTimeoutMs = input.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;

    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeoutMs);

    const startedAt = Date.now();
    const outcome = await (async () => {
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
        input.host,
        "bash",
        "--noprofile",
        "--norc",
        "-s",
      ];

      const scriptResult = await settleCapturedPromise(
        Result.tryPromise({
          try: () => buildProbeScript(input),
          catch: captureSshFailure,
        }),
        (cause) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return sshFailure("unavailable", cause.message);
        },
      );
      const scriptOutcome = scriptResult.match<
        { readonly script: string } | { readonly failure: ServerToolFailure }
      >({
        ok: (script) => ({ script }),
        err: (failure) => ({ failure }),
      });
      if ("failure" in scriptOutcome)
        return { status: "return", value: Result.err(scriptOutcome.failure) } as const;

      const spawned = settleCapturedError(
        Result.try({
          try: () =>
            Bun.spawn(["ssh", ...sshArgs], {
              stdout: "pipe",
              stderr: "pipe",
              stdin: new Blob([scriptOutcome.script]),
              signal: controller.signal,
              killSignal: "SIGTERM",
              env: {
                ...process.env,
              },
            }),
          catch: captureSshFailure,
        }),
        (cause) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return sshFailure(controller.signal.aborted ? "cancelled" : "unavailable", cause.message);
        },
      );
      const spawnOutcome = spawned.match<
        | { readonly child: Bun.Subprocess<Blob, "pipe", "pipe"> }
        | { readonly failure: ServerToolFailure }
      >({
        ok: (child) => ({ child }),
        err: (failure) => ({ failure }),
      });
      if ("failure" in spawnOutcome)
        return { status: "return", value: Result.err(spawnOutcome.failure) } as const;
      const child = spawnOutcome.child;

      const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
        readStreamText(child.stdout),
        readStreamText(child.stderr),
        child.exited,
      ]);
      preserveSshSettledPanics([stdoutResult, stderrResult, exitResult]);

      const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value : "";
      const stderr = stderrResult.status === "fulfilled" ? stderrResult.value : "";
      const exitCode = exitResult.status === "fulfilled" ? exitResult.value : -1;

      const durationMs = Date.now() - startedAt;

      const outTrunc = truncateText(stdout, MAX_OUTPUT_CHARS);
      const errTrunc = truncateText(stderr, MAX_OUTPUT_CHARS);

      const transportError = exitCode === 255 ? inferTransportError(stderr) : undefined;
      const processReadFailed =
        stdoutResult.status === "rejected" ||
        stderrResult.status === "rejected" ||
        exitResult.status === "rejected";

      let probe: SshProbeOutput | undefined;
      let parseError: string | undefined;

      if (exitCode === 0 && !timedOut && stdoutResult.status === "fulfilled") {
        const decodedProbe = decodeSshProbeOutput(stdout.trim());
        decodedProbe.match({
          ok: (value) => {
            probe = value;
          },
          err: (error) => {
            parseError = error.message;
          },
        });
      }

      const report = {
        ok: exitCode === 0 && !timedOut && !processReadFailed,
        exitCode,
        durationMs,
        timedOut,
        target: {
          host: input.host,
          cwd: input.cwd,
          strictHostKeyChecking: true,
          batchMode: true,
        },
        probe,
        parseError,
        stdout: probe ? undefined : outTrunc.text,
        stderr: errTrunc.text,
        truncated: {
          stdout: outTrunc.truncated,
          stderr: errTrunc.truncated,
        },
        transportError,
        errors: {
          stdoutRead: stdoutResult.status === "rejected" ? String(stdoutResult.reason) : undefined,
          stderrRead: stderrResult.status === "rejected" ? String(stderrResult.reason) : undefined,
          exitRead: exitResult.status === "rejected" ? String(exitResult.reason) : undefined,
          stdinWrite: undefined,
        },
      };
      if (timedOut) {
        return {
          status: "return",
          value: Result.err(
            sshFailure("timeout", `SSH probe timed out after ${effectiveTimeoutMs}ms`),
          ),
        } as const;
      }
      if (signal?.aborted) {
        return {
          status: "return",
          value: Result.err(sshFailure("cancelled", "SSH probe was cancelled")),
        } as const;
      }
      if (parseError) {
        return {
          status: "return",
          value: Result.err(sshFailure("unavailable", parseError)),
        } as const;
      }
      return { status: "return", value: Result.ok(report) } as const;
    })().finally(() => {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", onAbort);
    });
    return outcome.value;
  }
}
