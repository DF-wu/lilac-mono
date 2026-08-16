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
  return accessed.map(() => true);
}

async function resolveCommand(
  command: string,
): Promise<ResultType<string | null, ExternalOperationFailed>> {
  if (command.includes(path.sep)) {
    const executable = await isExecutable(command);
    return executable.map((value) => (value ? command : null));
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
      const resolution = executable.match<ResultType<
        string | null,
        ExternalOperationFailed
      > | null>({
        ok: (value) => (value ? Result.ok(fullPath) : null),
        err: (error) =>
          error.code === "ENOENT" || error.code === "EACCES" ? null : Result.err(error),
      });
      if (resolution !== null) return resolution;
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
    const resolutionError = resolvedCommand.match({ ok: () => undefined, err: (error) => error });
    if (resolutionError !== undefined) return Result.err(resolutionError);
    const command = resolvedCommand.match({ ok: (value) => value, err: () => null });
    if (!command) continue;
    return Result.ok({
      descriptor,
      command,
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
    const resolutionError = resolved.match({ ok: () => undefined, err: (error) => error });
    if (resolutionError !== undefined) return Result.err(resolutionError);
    const harness = resolved.match({ ok: (value) => value, err: () => null });
    if (harness) {
      results.push({
        descriptor,
        launchable: true,
        command: harness.command,
        args: harness.args,
        source: harness.source,
      });
      continue;
    }
    results.push({ descriptor, launchable: false });
  }

  return Result.ok(results);
}
