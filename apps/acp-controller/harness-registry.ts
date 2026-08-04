import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { Result, type Result as ResultType } from "better-result";

import { captureExternal } from "./external-adapters.ts";
import type { ExternalOperationFailed } from "./failures.ts";
import type { HarnessDescriptor, ResolvedHarness } from "./types.ts";

const BUILTIN_HARNESSES: readonly HarnessDescriptor[] = [
  {
    id: "opencode",
    title: "OpenCode",
    description: "OpenCode ACP harness",
    launchCandidates: [{ command: "opencode", args: ["acp"], source: "path" }],
    installHint: "Install OpenCode so `opencode acp` is available on PATH.",
  },
  {
    id: "codex-acp",
    title: "Codex ACP",
    description: "Codex ACP harness",
    launchCandidates: [{ command: "codex-acp", args: [], source: "path" }],
    installHint: "Install `codex-acp` on PATH or run `npx @zed-industries/codex-acp` manually.",
  },
  {
    id: "claude-acp",
    title: "Claude ACP",
    description: "Claude ACP harness",
    launchCandidates: [{ command: "claude-agent-acp", args: [], source: "path" }],
    installHint:
      "Install `claude-agent-acp` on PATH or run `npx @zed-industries/claude-agent-acp` manually.",
  },
  {
    id: "cursor",
    title: "Cursor",
    description: "Cursor ACP harness",
    launchCandidates: [{ command: "cursor-agent", args: ["acp"], source: "path" }],
    installHint: "Install Cursor Agent so `cursor-agent acp` is available on PATH.",
  },
];

function pathEntries(): string[] {
  const raw = process.env.PATH ?? "";
  return raw.split(path.delimiter).filter((entry) => entry.length > 0);
}

async function isExecutable(
  filePath: string,
): Promise<ResultType<boolean, ExternalOperationFailed>> {
  const accessed = await captureExternal("access-harness", () =>
    fs.access(filePath, constants.X_OK),
  );
  return accessed.status === "ok" ? Result.ok(true) : Result.err(accessed.error);
}

async function resolveCommand(
  command: string,
): Promise<ResultType<string | null, ExternalOperationFailed>> {
  if (command.includes(path.sep)) {
    const executable = await isExecutable(command);
    if (executable.status === "error") return Result.err(executable.error);
    return Result.ok(executable.value ? command : null);
  }

  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter((entry) => entry.length > 0)
      : [""];

  for (const entry of pathEntries()) {
    for (const extension of extensions) {
      const fullPath = path.join(
        entry,
        process.platform === "win32" ? `${command}${extension}` : command,
      );
      const executable = await isExecutable(fullPath);
      if (executable.status === "error") {
        if (executable.error.code === "ENOENT" || executable.error.code === "EACCES") continue;
        return Result.err(executable.error);
      }
      if (executable.value) return Result.ok(fullPath);
    }
  }

  return Result.ok(null);
}

export function listBuiltinHarnesses(): readonly HarnessDescriptor[] {
  return BUILTIN_HARNESSES;
}

export function getHarnessDescriptor(harnessId: string): HarnessDescriptor | null {
  return BUILTIN_HARNESSES.find((entry) => entry.id === harnessId) ?? null;
}

export async function resolveHarness(
  harnessId: string,
): Promise<ResultType<ResolvedHarness | null, ExternalOperationFailed>> {
  const descriptor = getHarnessDescriptor(harnessId);
  if (!descriptor) return Result.ok(null);

  for (const candidate of descriptor.launchCandidates) {
    const resolvedCommand = await resolveCommand(candidate.command);
    if (resolvedCommand.status === "error") return Result.err(resolvedCommand.error);
    if (!resolvedCommand.value) continue;
    return Result.ok({
      descriptor,
      command: resolvedCommand.value,
      args: candidate.args,
      source: candidate.source,
    });
  }

  return Result.ok(null);
}

export async function listResolvedHarnesses(): Promise<
  ResultType<
    Array<{
      descriptor: HarnessDescriptor;
      launchable: boolean;
      command?: string;
      args?: readonly string[];
      source?: "path" | "fallback";
    }>,
    ExternalOperationFailed
  >
> {
  const results: Array<{
    descriptor: HarnessDescriptor;
    launchable: boolean;
    command?: string;
    args?: readonly string[];
    source?: "path" | "fallback";
  }> = [];

  for (const descriptor of BUILTIN_HARNESSES) {
    const resolved = await resolveHarness(descriptor.id);
    if (resolved.status === "error") return Result.err(resolved.error);
    if (resolved.value) {
      results.push({
        descriptor,
        launchable: true,
        command: resolved.value.command,
        args: resolved.value.args,
        source: resolved.value.source,
      });
      continue;
    }
    results.push({ descriptor, launchable: false });
  }

  return Result.ok(results);
}
