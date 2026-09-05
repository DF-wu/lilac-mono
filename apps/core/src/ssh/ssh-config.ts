import { captureError } from "../shared/error-capture.js";
import { homedir } from "node:os";
import path from "node:path";

import { isPanic, opaqueErrorCause, opaqueErrorMessage } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { preserveToolPanic } from "../tools/tool-result-adapters";

/**
 * Shared SSH config helpers used by both:
 * - Level 2 tool server SSH tools (ssh.run/ssh.probe)
 * - Level 1 tools that route operations via SSH when cwd looks like <host>:<path>
 */

function stripComment(line: string): string {
  const idx = line.indexOf("#");
  if (idx === -1) return line;
  return line.slice(0, idx);
}

export type ConfiguredSshHosts = {
  readonly configPath: string;
  readonly hosts: string[];
  readonly exists: boolean;
};

export type SshConfigReadDependencies = {
  readonly exists: (configPath: string) => Promise<boolean>;
  readonly readText: (configPath: string) => Promise<string>;
};

const DEFAULT_SSH_CONFIG_READ_DEPENDENCIES: SshConfigReadDependencies = {
  exists: (configPath) => Bun.file(configPath).exists(),
  readText: (configPath) => Bun.file(configPath).text(),
};

export class SshConfigReadError extends TaggedError("SshConfigReadError")<{
  readonly configPath: string;
  readonly exists: boolean;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SshHostsMissingError extends TaggedError("SshHostsMissingError")<{
  readonly configPath: string;
  readonly message: string;
}> {}

export class SshHostUnknownError extends TaggedError("SshHostUnknownError")<{
  readonly configPath: string;
  readonly host: string;
  readonly message: string;
}> {}

export type SshHostRequirementError =
  | SshConfigReadError
  | SshHostsMissingError
  | SshHostUnknownError;

export function resolveSshConfigPath(): string {
  const fromEnv = process.env.LILAC_SSH_CONFIG_PATH;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return path.join(homedir(), ".ssh", "config");
}

export function parseSshHostsFromConfigText(text: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();

  const lines = text.split(/\r?\n/g);
  for (const raw of lines) {
    const noComment = stripComment(raw).trim();
    if (!noComment) continue;

    const match = /^Host\s+(.+)$/i.exec(noComment);
    if (!match) continue;

    const rest = match[1] ?? "";
    const tokens = rest.split(/\s+/g).filter(Boolean);
    for (const t of tokens) {
      if (t.startsWith("!")) continue;
      if (t.includes("*") || t.includes("?")) continue;
      // Avoid advertising the global wildcard entry.
      if (t === "*") continue;
      if (!seen.has(t)) {
        seen.add(t);
        hosts.push(t);
      }
    }
  }

  return hosts;
}

export async function readConfiguredSshHostsResult(
  dependencies: SshConfigReadDependencies = DEFAULT_SSH_CONFIG_READ_DEPENDENCIES,
): Promise<ResultType<ConfiguredSshHosts, SshConfigReadError>> {
  const configPath = resolveSshConfigPath();
  let exists = false;
  {
    const captured = await Result.tryPromise({
      try: async () => {
        exists = await dependencies.exists(configPath);
        if (!exists) return Result.ok({ configPath, hosts: [], exists: false });
        const text = await dependencies.readText(configPath);
        return Result.ok({ configPath, hosts: parseSshHostsFromConfigText(text), exists: true });
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const caught = captured.error.cause;
      if (isPanic(caught)) preserveToolPanic(caught);
      const cause = opaqueErrorCause(caught, "Opaque SSH config read failure");
      return Result.err(
        new SshConfigReadError({
          configPath,
          exists,
          cause,
          message: opaqueErrorMessage(cause, "Failed to read SSH config"),
        }),
      );
    }
    return captured.value;
  }
}

export async function readConfiguredSshHosts(
  dependencies: SshConfigReadDependencies = DEFAULT_SSH_CONFIG_READ_DEPENDENCIES,
): Promise<{
  configPath: string;
  hosts: string[];
  exists: boolean;
  readError?: string;
}> {
  const read = await readConfiguredSshHostsResult(dependencies);
  return read.match({
    ok: (value) => value,
    err: (error) => ({
      configPath: error.configPath,
      hosts: [],
      exists: error.exists,
      readError: error.message,
    }),
  });
}

export async function requireConfiguredSshHostResult(
  host: string,
  dependencies: SshConfigReadDependencies = DEFAULT_SSH_CONFIG_READ_DEPENDENCIES,
): Promise<ResultType<void, SshHostRequirementError>> {
  const configured = await readConfiguredSshHostsResult(dependencies);
  return configured.andThen((value) => {
    if (value.hosts.length === 0) {
      return Result.err(
        new SshHostsMissingError({
          configPath: value.configPath,
          message: `No SSH hosts are configured. Add host aliases to ${value.configPath} (and ensure known_hosts + keys are configured), then retry.`,
        }),
      );
    }

    if (!value.hosts.includes(host)) {
      return Result.err(
        new SshHostUnknownError({
          configPath: value.configPath,
          host,
          message: `Unknown SSH host alias '${host}'. Add a Host entry to ${value.configPath} or use ssh.hosts to see configured aliases.`,
        }),
      );
    }
    return Result.ok(undefined);
  });
}

export async function requireConfiguredSshHost(
  host: string,
  dependencies: SshConfigReadDependencies = DEFAULT_SSH_CONFIG_READ_DEPENDENCIES,
): Promise<void> {
  const required = await requireConfiguredSshHostResult(host, dependencies);
  required.match({
    ok: () => () => undefined,
    err: (error) => () => {
      throw error;
    },
  })();
}
