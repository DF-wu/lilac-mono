import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { PromptResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { Panic, Result, type Result as ResultType } from "better-result";

import { getBoolFlag, getIntFlag, getStringFlag, parseFlags, readStdinText } from "./cli-flags.ts";
import {
  AcpHarnessClient,
  isAuthRequiredError,
  isCancelledStopReason,
  type AcpClientError,
} from "./acp-harness-client.ts";
import {
  captureAcpFailure,
  captureExternal,
  recordAcpCleanupFailure,
  replaceExternalFailureMessage,
  signalAcpDefect,
  type CapturedAcpFailure,
} from "./external-adapters.ts";
import { getHarnessDescriptor, listResolvedHarnesses, resolveHarness } from "./harness-registry.ts";
import {
  loadRunRecord,
  loadSessionIndex,
  observeRunCancellation,
  requestRunCancellation,
  saveRunRecord,
  saveWorkerRunRecord,
  setLocalSessionTitle,
  upsertSessionIndexEntries,
  type RunCancellationObservation,
} from "./run-store.ts";
import { buildSnapshotRuns, SessionHistoryCollector } from "./session-history.ts";
import {
  ExternalOperationFailed,
  HarnessUnavailable,
  MonitorTerminationFailed,
  RunInvariantFailed,
  SessionSelectionFailed,
  WorkerLifecycleCleanupFailed,
  WorkAndMonitorFailed,
  WorkAndCleanupFailed,
  type RunStoreError,
  type SessionStoreError,
} from "./failures.ts";
import {
  createEmptyPermissionCounters,
  formatSessionRef,
  normalizeText,
  parseSessionRef,
  textPreview,
  type PromptRunRecord,
  type SessionPlanEntry,
  type SessionIndexEntry,
  type SessionSummary,
} from "./types.ts";

declare const PACKAGE_VERSION: string;

type OutputMode = "json" | "human";

type ListedSession = {
  harnessId: string;
  sessionId: string;
  sessionRef: string;
  title?: string;
  cwd: string;
  updatedAt?: string;
  capabilities: string[];
};

type HarnessOutputEntry = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly launchable: boolean;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly source?: "fallback" | "path";
  readonly installHint: string;
  readonly version: string;
};

type SnapshotRun = ReturnType<typeof buildSnapshotRuns>[number];

type ControllerOutput = {
  readonly ok: boolean;
  readonly error?: string;
  readonly help?: string;
  readonly version?: string;
  readonly harnesses?: readonly HarnessOutputEntry[];
  readonly sessions?: readonly ListedSession[];
  readonly warnings?: readonly string[];
  readonly candidates?: readonly ListedSession[];
  readonly harnessId?: string;
  readonly sessionId?: string;
  readonly sessionRef?: string;
  readonly session?: {
    readonly id?: string;
    readonly title?: string;
    readonly cwd: string;
    readonly updatedAt?: string;
  };
  readonly plan?: readonly SessionPlanEntry[];
  readonly recent?: { readonly runs: readonly SnapshotRun[] };
  readonly history?: PromptRunRecord["history"];
  readonly meta?: {
    readonly directory: string;
    readonly harnessId: string;
    readonly capabilities: readonly string[];
  };
  readonly runId?: string;
  readonly status?: PromptRunRecord["status"];
  readonly resultText?: string;
  readonly workerPid?: number;
  readonly signalled?: boolean;
  readonly run?: PromptRunRecord;
};

type OutputWriter = (value: ControllerOutput) => void;

function printJson(value: ControllerOutput): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printText(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function formatCommand(command: string | undefined, args: readonly string[]): string | undefined {
  if (!command) return undefined;
  return [command, ...args].join(" ");
}

function formatSessionEntries(sessions: readonly ListedSession[]): string[] {
  if (sessions.length === 0) return ["No sessions found."];

  const lines: string[] = [];
  for (const session of sessions) {
    lines.push(`- ${session.title ?? session.sessionRef}`);
    lines.push(`  session: ${session.sessionRef}`);
    lines.push(`  harness: ${session.harnessId}`);
    lines.push(`  cwd: ${session.cwd}`);
    if (session.updatedAt) lines.push(`  updated: ${session.updatedAt}`);
    if (session.capabilities.length > 0) {
      lines.push(`  capabilities: ${session.capabilities.join(", ")}`);
    }
  }
  return lines;
}

function formatWarnings(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  return ["Warnings:", ...warnings.map((warning) => `- ${warning}`)];
}

function formatCandidates(candidates: readonly ListedSession[] | undefined): string[] {
  if (!candidates) return [];
  if (candidates.length === 0) return [];
  return ["Candidates:", ...formatSessionEntries(candidates)];
}

function formatHarnessesOutput(harnesses: readonly HarnessOutputEntry[]): string {
  if (harnesses.length === 0) return "No harnesses found.";

  const lines = [`Harnesses (${harnesses.length})`];
  for (const harness of harnesses) {
    lines.push(
      `- ${harness.title} (${harness.id}) ${harness.launchable ? "[available]" : "[unavailable]"}`,
    );

    if (harness.description) lines.push(`  ${harness.description}`);

    const command = formatCommand(harness.command, harness.args ?? []);
    if (command) lines.push(`  command: ${command}`);

    if (harness.installHint && !harness.launchable) lines.push(`  install: ${harness.installHint}`);
  }
  return lines.join("\n");
}

function formatSessionsOutput(
  value: ControllerOutput & { readonly sessions: readonly ListedSession[] },
): string {
  const sessions = value.sessions;
  const warnings = value.warnings ?? [];

  const lines: string[] = [];
  if (!value.ok && value.error) lines.push(`Error: ${value.error}`, "");
  lines.push(`Sessions (${sessions.length})`, ...formatSessionEntries(sessions));

  const candidateLines = formatCandidates(value.candidates);
  if (candidateLines.length > 0) lines.push("", ...candidateLines);

  const warningLines = formatWarnings(warnings);
  if (warningLines.length > 0) lines.push("", ...warningLines);
  return lines.join("\n");
}

function formatSnapshotPlan(entries: readonly SessionPlanEntry[] | undefined): string[] {
  if (!entries) return ["Plan: none"];
  if (entries.length === 0) return ["Plan: none"];

  return [
    "Plan:",
    ...entries.map((entry) => `- [${entry.status}/${entry.priority}] ${entry.content}`),
  ];
}

function formatRecentRuns(recent: { readonly runs: readonly SnapshotRun[] } | undefined): string[] {
  if (!recent) return ["Recent turns: none"];
  const runs = recent.runs;
  if (runs.length === 0) return ["Recent turns: none"];

  const lines = ["Recent turns:"];
  for (const run of runs) {
    lines.push(`- User: ${run.user.text}`);
    lines.push(`  Assistant: ${run.assistant?.text ?? "(no assistant reply)"}`);
  }
  return lines;
}

function formatSnapshotOutput(value: ControllerOutput): string {
  const session = value.session;
  const meta = value.meta;
  const lines: string[] = [];

  if (!value.ok && value.error) {
    lines.push(`Error: ${value.error}`);
    if (value.sessionRef) lines.push(`Session: ${value.sessionRef}`);
    return lines.join("\n");
  }

  const title = session?.title;
  lines.push(title ? `Session snapshot: ${title}` : "Session snapshot");
  if (value.sessionRef) lines.push(`Session: ${value.sessionRef}`);
  else if (value.sessionId) lines.push(`Session ID: ${value.sessionId}`);

  const harnessId = value.harnessId ?? meta?.harnessId;
  if (harnessId) lines.push(`Harness: ${harnessId}`);

  if (session?.cwd) lines.push(`Directory: ${session.cwd}`);

  if (session?.updatedAt) lines.push(`Updated: ${session.updatedAt}`);

  const capabilities = meta?.capabilities ?? [];
  if (capabilities.length > 0) lines.push(`Capabilities: ${capabilities.join(", ")}`);

  lines.push("", ...formatSnapshotPlan(value.plan), "", ...formatRecentRuns(value.recent));
  return lines.join("\n");
}

function formatRunOutput(value: ControllerOutput & { readonly runId: string }): string {
  const runId = value.runId;
  const workerPid = value.workerPid ?? value.run?.workerPid;

  const lines: string[] = [];
  if (value.status) {
    lines.push(`Run ${runId}: ${value.status}`);
  } else {
    lines.push(`Run ${runId}`);
  }

  if (value.harnessId) lines.push(`Harness: ${value.harnessId}`);
  if (value.sessionRef) lines.push(`Session: ${value.sessionRef}`);
  if (workerPid !== undefined) lines.push(`Worker PID: ${workerPid}`);
  if (value.signalled !== undefined) lines.push(`Signal sent: ${value.signalled ? "yes" : "no"}`);
  if (value.error) lines.push(`Error: ${value.error}`);
  if (value.resultText) lines.push("", value.resultText);

  const candidateLines = formatCandidates(value.candidates);
  if (candidateLines.length > 0) lines.push("", ...candidateLines);

  return lines.join("\n").trim();
}

function formatHelpOutput(value: ControllerOutput & { readonly help: string }): string {
  const lines: string[] = [];
  if (value.error) lines.push(`Error: ${value.error}`, "");
  lines.push(value.help);
  if (value.version) lines.push("", `Version: ${value.version}`);
  return lines.join("\n");
}

function formatHumanOutput(value: ControllerOutput, commandName: string): string {
  if (value.help !== undefined) return formatHelpOutput({ ...value, help: value.help });
  if (value.harnesses !== undefined) return formatHarnessesOutput(value.harnesses);
  if (value.sessions !== undefined)
    return formatSessionsOutput({ ...value, sessions: value.sessions });
  if (value.session !== undefined && value.recent !== undefined) return formatSnapshotOutput(value);
  if (value.runId !== undefined) return formatRunOutput({ ...value, runId: value.runId });

  if (value.version && Object.keys(value).every((key) => key === "ok" || key === "version")) {
    return `${commandName} ${value.version}`;
  }

  if (value.error) {
    const lines = [`Error: ${value.error}`];
    const candidateLines = formatCandidates(value.candidates);
    if (candidateLines.length > 0) lines.push("", ...candidateLines);
    return lines.join("\n");
  }

  return JSON.stringify(value, null, 2);
}

function createOutputWriter(mode: OutputMode, commandName: string): OutputWriter {
  if (mode === "json") return printJson;
  return (value) => {
    printText(formatHumanOutput(value, commandName));
  };
}

function stripGlobalFlags(args: readonly string[]): string[] {
  const stripped: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--output") {
      index++;
      continue;
    }
    if (arg.startsWith("--output=")) {
      continue;
    }
    stripped.push(arg);
  }

  return stripped;
}

function compareUpdatedAtDesc(left?: string, right?: string): number {
  const leftValue = left ? Date.parse(left) : 0;
  const rightValue = right ? Date.parse(right) : 0;
  return rightValue - leftValue;
}

function sortSessions(sessions: ListedSession[]): ListedSession[] {
  return sessions.sort((left, right) => {
    const updatedComparison = compareUpdatedAtDesc(left.updatedAt, right.updatedAt);
    if (updatedComparison !== 0) return updatedComparison;
    return (left.title ?? left.sessionRef).localeCompare(right.title ?? right.sessionRef);
  });
}

function sessionMatchesSearch(session: ListedSession, search: string | undefined): boolean {
  if (!search) return true;
  const needle = normalizeText(search);
  return [session.title, session.cwd, session.sessionRef, session.sessionId]
    .filter((value): value is string => typeof value === "string")
    .some((value) => normalizeText(value).includes(needle));
}

function buildIndexEntry(session: ListedSession, localTitle?: string): SessionIndexEntry {
  return {
    sessionRef: session.sessionRef,
    harnessId: session.harnessId,
    remoteSessionId: session.sessionId,
    cwd: session.cwd,
    title: localTitle ?? session.title,
    updatedAt: session.updatedAt,
    capabilities: session.capabilities,
    lastSeenAt: Date.now(),
    ...(localTitle ? { localTitle } : {}),
  };
}

function mergeSessionWithIndex(
  live: ListedSession,
  indexed: SessionIndexEntry | undefined,
): ListedSession {
  return {
    ...live,
    title: indexed?.localTitle ?? live.title,
    updatedAt: live.updatedAt ?? indexed?.updatedAt,
    capabilities: live.capabilities.length > 0 ? live.capabilities : (indexed?.capabilities ?? []),
  };
}

function listedSessionFromIndex(entry: SessionIndexEntry): ListedSession {
  return {
    harnessId: entry.harnessId,
    sessionId: entry.remoteSessionId,
    sessionRef: entry.sessionRef,
    title: entry.localTitle ?? entry.title,
    cwd: entry.cwd,
    updatedAt: entry.updatedAt,
    capabilities: entry.capabilities,
  };
}

function capabilitiesFromSummary(summary: SessionSummary | undefined): string[] {
  return summary?.capabilities ?? [];
}

function isTerminalStatus(status: PromptRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

async function isProcessAlive(
  pid: number | undefined,
): Promise<ResultType<boolean, ExternalOperationFailed>> {
  if (!pid) return Result.ok(false);
  const probed = await captureExternal("probe-worker", async () => {
    process.kill(pid, 0);
  });
  // The historical probe treats every signal failure as a dead process.
  return Result.ok(probed.match({ ok: () => true, err: () => false }));
}

async function refreshRunStatus(
  run: PromptRunRecord,
): Promise<
  ResultType<
    PromptRunRecord,
    | RunStoreError
    | ExternalOperationFailed
    | RunInvariantFailed
    | WorkAndCleanupFailed<ExternalOperationFailed>
  >
> {
  if (isTerminalStatus(run.status)) return Result.ok(run);

  const alive = await isProcessAlive(run.workerPid);
  const aliveError = alive.match({ ok: () => undefined, err: (error) => error });
  if (aliveError !== undefined) return Result.err(aliveError);
  const processAlive = alive.match({ ok: (value) => value, err: () => false });
  if (run.status === "submitted" && !run.cancelRequestedAt && !processAlive) {
    const worker = await spawnWorker(run.id);
    const workerError = worker.match({ ok: () => undefined, err: (error) => error });
    if (workerError !== undefined) return Result.err(workerError);
    const spawned = worker.match({ ok: (value) => value, err: () => undefined });
    if (spawned === undefined) return worker.map(() => run);
    return persistSpawnedWorkerAdmission(run, spawned);
  }

  if (run.workerPid && processAlive) return Result.ok(run);
  const next: PromptRunRecord = {
    ...run,
    status: run.cancelRequestedAt ? "cancelled" : "failed",
    updatedAt: Date.now(),
    error:
      run.error ??
      (run.cancelRequestedAt
        ? "Prompt cancelled before the worker produced a terminal result."
        : "Background worker exited before producing a terminal result."),
  };
  const saved = await saveRunRecord(next);
  return saved.map(() => next);
}

type SessionCollectionError =
  | AcpClientError
  | ExternalOperationFailed
  | SessionStoreError
  | WorkAndCleanupFailed<{ readonly message: string }>;

async function collectSessionsForHarness(params: {
  harnessId: string;
  directory: string;
  version: string;
  search?: string;
}): Promise<
  ResultType<
    { sessions: ListedSession[]; warning?: string },
    SessionCollectionError | HarnessUnavailable
  >
> {
  const indexed = await loadSessionIndex();
  const indexError = indexed.match({ ok: () => undefined, err: (error) => error });
  if (indexError !== undefined) return Result.err(indexError);
  const index = indexed.match({ ok: (value) => value.value, err: () => undefined });
  if (index === undefined) return indexed.map(() => ({ sessions: [] }));
  const descriptor = getHarnessDescriptor(params.harnessId);
  if (!descriptor) {
    return Result.err(
      new HarnessUnavailable({
        harnessId: params.harnessId,
        message: `Unknown harness '${params.harnessId}'.`,
      }),
    );
  }

  const resolved = await resolveHarness(params.harnessId);
  const resolveError = resolved.match({ ok: () => undefined, err: (error) => error });
  if (resolveError !== undefined) return Result.err(resolveError);
  const harness = resolved.match({ ok: (value) => value, err: () => null });
  const cachedSessions = index.sessions
    .filter((entry) => entry.harnessId === params.harnessId && entry.cwd === params.directory)
    .map(listedSessionFromIndex);

  if (!harness) {
    return Result.ok({
      sessions: sortSessions(
        cachedSessions.filter((entry) => sessionMatchesSearch(entry, params.search)),
      ),
      warning: descriptor.installHint,
    });
  }

  const connected = await AcpHarnessClient.connect({
    harness,
    version: params.version,
    permissionBehavior: "reject",
    counters: createEmptyPermissionCounters(),
  });
  const connectError = connected.match({ ok: () => undefined, err: (error) => error });
  if (connectError !== undefined) return Result.err(connectError);
  const client = connected.match({ ok: (value) => value, err: () => undefined });
  if (client === undefined) return connected.map(() => ({ sessions: [] }));

  const listed = await client.listSessions(params.directory);
  let work: ResultType<
    { sessions: ListedSession[]; warning?: string },
    ExternalOperationFailed | HarnessUnavailable | SessionStoreError
  >;
  const listError = listed.match({ ok: () => undefined, err: (error) => error });
  if (listError !== undefined) {
    if (ExternalOperationFailed.is(listError) && isAuthRequiredError(listError)) {
      work = Result.err(
        replaceExternalFailureMessage(listError, client.authHint() ?? listError.message),
      );
    } else {
      work = Result.err(listError);
    }
  } else {
    const sessions = listed.match({ ok: (value) => value, err: () => [] });
    const liveSessions = sessions.map((session) => {
      const sessionRef = formatSessionRef(params.harnessId, session.sessionId);
      const cached = index.sessions.find((entry) => entry.sessionRef === sessionRef);
      return mergeSessionWithIndex(
        {
          harnessId: params.harnessId,
          sessionId: session.sessionId,
          sessionRef,
          title: session.title ?? undefined,
          cwd: session.cwd,
          updatedAt: session.updatedAt ?? undefined,
          capabilities: client.capabilities(),
        },
        cached,
      );
    });

    const saved = await upsertSessionIndexEntries(
      liveSessions.map((session) => buildIndexEntry(session)),
    );
    work = saved.map(() => ({
      sessions: sortSessions(
        liveSessions.filter((entry) => sessionMatchesSearch(entry, params.search)),
      ),
      ...(client.authHint() ? { warning: client.authHint() } : {}),
    }));
  }

  const cleanup = await client.close();
  const cleanupError = cleanup.match({ ok: () => undefined, err: (error) => error });
  if (cleanupError === undefined) return work;
  const workError = work.match({ ok: () => undefined, err: (error) => error });
  if (workError === undefined) return Result.err(cleanupError);
  return Result.err(
    new WorkAndCleanupFailed({
      primary: workError,
      cleanup: cleanupError,
      message: `${workError.message} Harness cleanup also failed.`,
    }),
  );
}

async function collectSessions(params: {
  harnessId?: string;
  directory: string;
  version: string;
  search?: string;
}): Promise<{ sessions: ListedSession[]; warnings: string[] }> {
  const warnings: string[] = [];
  const sessions: ListedSession[] = [];
  let harnessIds: string[];
  if (params.harnessId && params.harnessId !== "any") {
    harnessIds = [params.harnessId];
  } else {
    const resolved = await listResolvedHarnesses();
    const resolutionError = resolved.match({ ok: () => undefined, err: (error) => error });
    if (resolutionError !== undefined) return { sessions, warnings: [resolutionError.message] };
    harnessIds = resolved.match({
      ok: (value) => value.map((entry) => entry.descriptor.id),
      err: () => [],
    });
  }

  for (const harnessId of harnessIds) {
    const collected = await collectSessionsForHarness({
      harnessId,
      directory: params.directory,
      version: params.version,
      search: params.search,
    });
    const collectionError = collected.match({ ok: () => undefined, err: (error) => error });
    if (collectionError !== undefined) {
      warnings.push(`Harness '${harnessId}': ${collectionError.message}`);
      continue;
    }
    const collection = collected.match({ ok: (value) => value, err: () => undefined });
    if (collection === undefined) continue;
    sessions.push(...collection.sessions);
    if (collection.warning) warnings.push(collection.warning);
  }

  return { sessions: sortSessions(sessions), warnings };
}

async function resolveExistingSessionTarget(params: {
  sessionIdFlag?: string;
  title?: string;
  latest: boolean;
  harnessId?: string;
  directory: string;
  version: string;
}): Promise<
  ResultType<
    {
      harnessId: string;
      remoteSessionId?: string;
      sessionRef?: string;
      targetKind: "new" | "existing";
      requestedTitle?: string;
      candidates?: ListedSession[];
    },
    SessionSelectionFailed
  >
> {
  if (params.sessionIdFlag) {
    const parsed = parseSessionRef(params.sessionIdFlag);
    if (parsed) {
      if (params.harnessId && params.harnessId !== "any" && params.harnessId !== parsed.harnessId) {
        return Result.err(
          new SessionSelectionFailed({
            message: `--session-id points to harness '${parsed.harnessId}', not '${params.harnessId}'.`,
          }),
        );
      }
      return Result.ok({
        harnessId: parsed.harnessId,
        remoteSessionId: parsed.remoteSessionId,
        sessionRef: params.sessionIdFlag,
        targetKind: "existing",
      });
    }

    if (!params.harnessId || params.harnessId === "any") {
      return Result.err(
        new SessionSelectionFailed({ message: "Raw --session-id values require --harness." }),
      );
    }

    return Result.ok({
      harnessId: params.harnessId,
      remoteSessionId: params.sessionIdFlag,
      sessionRef: formatSessionRef(params.harnessId, params.sessionIdFlag),
      targetKind: "existing",
    });
  }

  if (params.latest) {
    if (!params.harnessId || params.harnessId === "any") {
      return Result.err(new SessionSelectionFailed({ message: "--latest requires --harness." }));
    }
    const collected = await collectSessions({
      harnessId: params.harnessId,
      directory: params.directory,
      version: params.version,
    });
    const latest = collected.sessions[0];
    if (!latest) {
      return Result.err(
        new SessionSelectionFailed({
          message: `No sessions found for harness '${params.harnessId}'.`,
        }),
      );
    }
    return Result.ok({
      harnessId: latest.harnessId,
      remoteSessionId: latest.sessionId,
      sessionRef: latest.sessionRef,
      targetKind: "existing",
    });
  }

  if (params.title) {
    if (params.harnessId && params.harnessId !== "any") {
      const collected = await collectSessions({
        harnessId: params.harnessId,
        directory: params.directory,
        version: params.version,
        search: params.title,
      });
      const exactMatch = collected.sessions.find((session) => session.title === params.title);
      if (exactMatch) {
        return Result.ok({
          harnessId: exactMatch.harnessId,
          remoteSessionId: exactMatch.sessionId,
          sessionRef: exactMatch.sessionRef,
          targetKind: "existing",
        });
      }
      return Result.ok({
        harnessId: params.harnessId,
        targetKind: "new",
        requestedTitle: params.title,
        candidates: collected.sessions,
      });
    }

    const collected = await collectSessions({
      directory: params.directory,
      version: params.version,
      search: params.title,
    });
    const exactMatches = collected.sessions.filter((session) => session.title === params.title);
    if (exactMatches.length === 1) {
      const [match] = exactMatches;
      if (!match) {
        return Result.err(new SessionSelectionFailed({ message: "Expected an exact match." }));
      }
      return Result.ok({
        harnessId: match.harnessId,
        remoteSessionId: match.sessionId,
        sessionRef: match.sessionRef,
        targetKind: "existing",
      });
    }

    if (exactMatches.length > 1) {
      return Result.ok({
        harnessId: "",
        targetKind: "existing",
        candidates: exactMatches,
      });
    }

    return Result.ok({
      harnessId: "",
      targetKind: "existing",
      candidates: collected.sessions,
    });
  }

  if (params.harnessId && params.harnessId !== "any") {
    return Result.ok({
      harnessId: params.harnessId,
      targetKind: "new",
    });
  }

  return Result.err(
    new SessionSelectionFailed({
      message: "No session selector matched. Use --harness to create a new session.",
    }),
  );
}

export type SpawnedWorker = {
  readonly pid: number;
  readonly detach: () => void;
  readonly terminate: () => Promise<ResultType<void, ExternalOperationFailed>>;
};

async function terminateChildProcess(
  child: ChildProcess,
): Promise<ResultType<void, ExternalOperationFailed>> {
  if (child.exitCode !== null || child.signalCode !== null) return Result.ok(undefined);
  let resolveExit: (() => void) | undefined;
  let rejectExit: ((cause: Error) => void) | undefined;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const onExit = () => resolveExit?.();
  const onError = (cause: Error) => rejectExit?.(cause);
  child.once("exit", onExit);
  child.once("error", onError);
  const signalled = await captureExternal("terminate-worker", async () => child.kill("SIGKILL"));
  const signalError = signalled.match({ ok: () => undefined, err: (error) => error });
  if (signalError !== undefined) {
    child.off("exit", onExit);
    child.off("error", onError);
    return Result.err(signalError);
  }
  const signalSent = signalled.match({ ok: (value) => value, err: () => false });
  if (!signalSent && child.exitCode === null && child.signalCode === null) {
    child.off("exit", onExit);
    child.off("error", onError);
    const cause = new Error("Failed to terminate uncommitted prompt worker.");
    return Result.err(
      new ExternalOperationFailed({
        operation: "terminate-worker",
        cause,
        message: cause.message,
      }),
    );
  }
  const settled = await captureExternal("terminate-worker", () => exited);
  child.off("exit", onExit);
  child.off("error", onError);
  return settled.map(() => undefined);
}

async function spawnWorker(
  runId: string,
): Promise<ResultType<SpawnedWorker, ExternalOperationFailed | RunInvariantFailed>> {
  const entryPoint = process.env.LILAC_ACP_ENTRYPOINT ?? process.argv[1];
  if (!entryPoint) {
    return Result.err(
      new RunInvariantFailed({
        runId,
        message: "Cannot determine the CLI entrypoint for worker spawning.",
      }),
    );
  }

  const spawned = await captureExternal("spawn-worker", async () => {
    return spawn(process.execPath, [entryPoint, "_worker", "run", "--run-id", runId], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        LILAC_ACP_ENTRYPOINT: entryPoint,
      },
    });
  });
  const child = spawned.match<ChildProcess | ExternalOperationFailed>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ExternalOperationFailed.is(child)) return Result.err(child);
  if (child.pid === undefined) {
    const terminated = await terminateChildProcess(child);
    const terminationError = terminated.match({ ok: () => undefined, err: (error) => error });
    if (terminationError !== undefined) return Result.err(terminationError);
    return Result.err(
      new RunInvariantFailed({
        runId,
        message: "Prompt worker started without a process ID.",
      }),
    );
  }
  return Result.ok({
    pid: child.pid,
    detach: () => child.unref(),
    terminate: () => terminateChildProcess(child),
  });
}

export async function persistSpawnedWorkerAdmission(
  run: PromptRunRecord,
  worker: SpawnedWorker,
  persist: (
    record: PromptRunRecord,
  ) => Promise<ResultType<void, ExternalOperationFailed>> = saveRunRecord,
): Promise<
  ResultType<
    PromptRunRecord,
    ExternalOperationFailed | WorkAndCleanupFailed<ExternalOperationFailed>
  >
> {
  const admitted: PromptRunRecord = {
    ...run,
    workerPid: worker.pid,
    updatedAt: Date.now(),
  };
  const persistence = await Result.tryPromise({
    try: () => persist(admitted),
    catch: captureAcpFailure,
  });
  const persistedSuccessfully = persistence.match({
    ok: (result) => result.match({ ok: () => true, err: () => false }),
    err: () => false,
  });
  if (persistedSuccessfully) {
    worker.detach();
    return Result.ok(admitted);
  }

  const termination = await Result.tryPromise({
    try: worker.terminate,
    catch: captureAcpFailure,
  });
  const persistenceCaptureFailure = persistence.match({
    ok: () => undefined,
    err: (failure) => failure,
  });
  const terminationCaptureFailure = termination.match({
    ok: () => undefined,
    err: (failure) => failure,
  });
  if (persistenceCaptureFailure !== undefined) {
    switch (persistenceCaptureFailure.kind) {
      case "panic": {
        if (terminationCaptureFailure === undefined) {
          const cleanupError = termination.match({
            ok: (result) => result.match({ ok: () => undefined, err: (error) => error }),
            err: () => undefined,
          });
          if (cleanupError !== undefined) {
            recordAcpCleanupFailure(persistenceCaptureFailure.panic, cleanupError);
          }
        } else {
          const cleanupFailure =
            terminationCaptureFailure.kind === "panic"
              ? terminationCaptureFailure.panic
              : capturedWorkerFailure("terminate-worker", terminationCaptureFailure);
          recordAcpCleanupFailure(persistenceCaptureFailure.panic, cleanupFailure);
        }
        return signalAcpDefect(persistenceCaptureFailure.panic);
      }
      case "ordinary": {
        const primary = capturedWorkerFailure("write-run", persistenceCaptureFailure);
        const cleanupError = termination.match<ExternalOperationFailed | Panic | undefined>({
          ok: (result) => result.match({ ok: () => undefined, err: (error) => error }),
          err: (failure) =>
            failure.kind === "panic"
              ? failure.panic
              : capturedWorkerFailure("terminate-worker", failure),
        });
        if (Panic.is(cleanupError)) return signalAcpDefect(cleanupError);
        if (cleanupError === undefined) return Result.err(primary);
        return Result.err(
          new WorkAndCleanupFailed({
            primary,
            cleanup: cleanupError,
            message: `${primary.message} Prompt worker termination also failed.`,
          }),
        );
      }
    }
  }
  const primary = persistence.match({
    ok: (result) => result.match({ ok: () => undefined, err: (error) => error }),
    err: () => undefined,
  });
  if (primary === undefined) return Result.ok(admitted);
  const cleanupError = termination.match<ExternalOperationFailed | Panic | undefined>({
    ok: (result) => result.match({ ok: () => undefined, err: (error) => error }),
    err: (failure) =>
      failure.kind === "panic" ? failure.panic : capturedWorkerFailure("terminate-worker", failure),
  });
  if (Panic.is(cleanupError)) return signalAcpDefect(cleanupError);
  if (cleanupError === undefined) return Result.err(primary);
  return Result.err(
    new WorkAndCleanupFailed({
      primary,
      cleanup: cleanupError,
      message: `${primary.message} Prompt worker termination also failed.`,
    }),
  );
}

function capturedWorkerFailure(
  operation:
    | "close-harness"
    | "close-run-cancellation-watch"
    | "remove-worker-signals"
    | "terminate-worker"
    | "watch-run-cancellation"
    | "worker-process"
    | "write-run",
  captured: Extract<CapturedAcpFailure, { readonly kind: "ordinary" }>,
): ExternalOperationFailed {
  return new ExternalOperationFailed({
    operation,
    cause: captured.cause,
    ...(captured.projection.code ? { code: captured.projection.code } : {}),
    message: captured.projection.message,
  });
}

function capturedCleanupResult(
  attempted: ResultType<ResultType<void, ExternalOperationFailed>, CapturedAcpFailure>,
  operation: "close-harness" | "close-run-cancellation-watch",
): ExternalOperationFailed | Panic | undefined {
  return attempted.match({
    ok: (result) => result.match({ ok: () => undefined, err: (error) => error }),
    err: (failure) =>
      failure.kind === "panic" ? failure.panic : capturedWorkerFailure(operation, failure),
  });
}

function help(commandName: string): string {
  return [
    `${commandName} (ACP harness controller)`,
    "",
    "Usage:",
    `  ${commandName} harnesses list`,
    `  ${commandName} sessions list [--directory <path>] [--harness <id|any>] [--search <term>] [--limit <n>]`,
    `  ${commandName} sessions snapshot [--directory <path>] [--harness <id>] [--session-id <ref> | --title <title> | --latest] [--runs <n>] [--max-chars <n>]`,
    `  ${commandName} prompt submit --text <msg> [--directory <path>] [--harness <id>] [--session-id <ref> | --title <title> | --latest] [--agent <mode>] [--model <model-id>] [--wait]`,
    `  ${commandName} prompt status --run-id <id>`,
    `  ${commandName} prompt result --run-id <id>`,
    `  ${commandName} prompt wait --run-id <id> [--timeout-ms <n>] [--poll-ms <n>]`,
    `  ${commandName} prompt cancel --run-id <id>`,
    "",
    "Global options:",
    "  --output <json|human>   Output format (default: json).",
    "",
    "Notes:",
    "  - --latest requires --harness.",
    "  - --title without --harness continues only when exactly one exact match exists.",
    "  - New sessions require --harness so the controller knows where to create them.",
  ].join("\n");
}

async function runHarnessesList(version: string, write: OutputWriter): Promise<number> {
  const harnesses = await listResolvedHarnesses();
  const harnessError = harnesses.match({ ok: () => undefined, err: (error) => error });
  if (harnessError !== undefined) {
    write({ ok: false, error: harnessError.message });
    return 1;
  }
  const entries = harnesses.match({ ok: (value) => value, err: () => [] });
  write({
    ok: true,
    harnesses: entries.map((entry) => ({
      id: entry.descriptor.id,
      title: entry.descriptor.title,
      description: entry.descriptor.description,
      launchable: entry.launchable,
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.args ? { args: entry.args } : {}),
      ...(entry.source ? { source: entry.source } : {}),
      installHint: entry.descriptor.installHint,
      version,
    })),
  });
  return 0;
}

async function runSessionsList(params: {
  directory: string;
  harnessId?: string;
  search?: string;
  limit: number;
  version: string;
  write: OutputWriter;
}): Promise<number> {
  const collected = await collectSessions({
    harnessId: params.harnessId,
    directory: params.directory,
    version: params.version,
    search: params.search,
  });
  const sessions =
    params.limit > 0 ? collected.sessions.slice(0, params.limit) : collected.sessions;
  params.write({
    ok: true,
    sessions,
    ...(collected.warnings.length > 0 ? { warnings: collected.warnings } : {}),
  });
  return 0;
}

async function runSessionsSnapshot(params: {
  directory: string;
  harnessId?: string;
  sessionIdFlag?: string;
  title?: string;
  latest: boolean;
  maxRuns: number;
  maxChars: number;
  version: string;
  write: OutputWriter;
}): Promise<number> {
  const selected = await resolveExistingSessionTarget({
    sessionIdFlag: params.sessionIdFlag,
    title: params.title,
    latest: params.latest,
    harnessId: params.harnessId,
    directory: params.directory,
    version: params.version,
  });
  const selectionError = selected.match({ ok: () => undefined, err: (error) => error });
  if (selectionError !== undefined) {
    params.write({ ok: false, error: selectionError.message });
    return 1;
  }
  const target = selected.match({ ok: (value) => value, err: () => undefined });
  if (target === undefined) return 1;

  if (!target.remoteSessionId || !target.sessionRef) {
    params.write({
      ok: false,
      error:
        params.title && !params.harnessId
          ? `No unique exact title match found for '${params.title}'.`
          : "sessions snapshot requires an existing session selector.",
      ...(target.candidates ? { candidates: target.candidates } : {}),
    });
    return 1;
  }

  const resolvedHarness = await resolveHarness(target.harnessId);
  const resolveError = resolvedHarness.match({ ok: () => undefined, err: (error) => error });
  if (resolveError !== undefined) {
    params.write({ ok: false, error: resolveError.message });
    return 1;
  }
  const harness = resolvedHarness.match({ ok: (value) => value, err: () => null });
  if (!harness) {
    const descriptor = getHarnessDescriptor(target.harnessId);
    params.write({
      ok: false,
      error: descriptor?.installHint ?? `Harness '${target.harnessId}' is not launchable.`,
    });
    return 1;
  }

  const collector = new SessionHistoryCollector();
  const connected = await AcpHarnessClient.connect({
    harness,
    version: params.version,
    permissionBehavior: "reject",
    counters: createEmptyPermissionCounters(),
    onUpdate: (notification) => collector.add(notification),
  });
  const connectError = connected.match({ ok: () => undefined, err: (error) => error });
  if (connectError !== undefined) {
    params.write({
      ok: false,
      error: connectError.message,
      harnessId: target.harnessId,
      sessionRef: target.sessionRef,
    });
    return 1;
  }
  const client = connected.match({ ok: (value) => value, err: () => undefined });
  if (client === undefined) return 1;
  const loaded = await client.loadSession(target.remoteSessionId, params.directory);
  const cleanup = await client.close();
  const loadError = loaded.match({ ok: () => undefined, err: (error) => error });
  const cleanupError = cleanup.match({ ok: () => undefined, err: (error) => error });
  if (loadError !== undefined || cleanupError !== undefined) {
    const failureMessage =
      loadError?.message ?? cleanupError?.message ?? "Harness operation failed.";
    params.write({
      ok: false,
      error: failureMessage,
      harnessId: target.harnessId,
      sessionRef: target.sessionRef,
    });
    return 1;
  }
  params.write({
    ok: true,
    harnessId: target.harnessId,
    sessionId: target.remoteSessionId,
    sessionRef: target.sessionRef,
    session: {
      id: target.remoteSessionId,
      title: collector.title,
      cwd: params.directory,
      updatedAt: collector.updatedAt,
    },
    ...(collector.plan ? { plan: collector.plan } : {}),
    recent: {
      runs: buildSnapshotRuns(collector.history, params.maxRuns, params.maxChars),
    },
    ...(collector.history.length > 0 ? { history: collector.history } : {}),
    meta: {
      directory: params.directory,
      harnessId: target.harnessId,
      capabilities: client.capabilities(),
    },
  });
  return 0;
}

async function runPromptSubmit(params: {
  directory: string;
  harnessId?: string;
  sessionIdFlag?: string;
  title?: string;
  latest: boolean;
  text: string;
  requestedMode?: string;
  requestedModel?: string;
  wait: boolean;
  timeoutMs: number;
  pollMs: number;
  version: string;
  write: OutputWriter;
}): Promise<number> {
  const selected = await resolveExistingSessionTarget({
    sessionIdFlag: params.sessionIdFlag,
    title: params.title,
    latest: params.latest,
    harnessId: params.harnessId,
    directory: params.directory,
    version: params.version,
  });
  const selectionError = selected.match({ ok: () => undefined, err: (error) => error });
  if (selectionError !== undefined) {
    params.write({ ok: false, error: selectionError.message });
    return 1;
  }
  const target = selected.match({ ok: (value) => value, err: () => undefined });
  if (target === undefined) return 1;

  if (!target.harnessId) {
    params.write({
      ok: false,
      error: params.title
        ? `Expected exactly one exact title match for '${params.title}'.`
        : "Unable to resolve a harness for prompt submission.",
      ...(target.candidates ? { candidates: target.candidates } : {}),
    });
    return 1;
  }

  const resolvedHarness = await resolveHarness(target.harnessId);
  const resolveError = resolvedHarness.match({ ok: () => undefined, err: (error) => error });
  if (resolveError !== undefined) {
    params.write({ ok: false, error: resolveError.message });
    return 1;
  }
  const harness = resolvedHarness.match({ ok: (value) => value, err: () => null });
  if (!harness) {
    const descriptor = getHarnessDescriptor(target.harnessId);
    params.write({
      ok: false,
      error: descriptor?.installHint ?? `Harness '${target.harnessId}' is not launchable.`,
    });
    return 1;
  }

  const runId = `run_${randomUUID()}`;
  const run: PromptRunRecord = {
    id: runId,
    status: "submitted",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    directory: params.directory,
    harnessId: target.harnessId,
    targetKind: target.targetKind,
    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    ...(target.sessionRef ? { sessionRef: target.sessionRef } : {}),
    ...(target.requestedTitle ? { requestedTitle: target.requestedTitle } : {}),
    promptText: params.text,
    textPreview: textPreview(params.text, 240),
    ...(params.requestedMode ? { requestedMode: params.requestedMode } : {}),
    ...(params.requestedModel ? { requestedModel: params.requestedModel } : {}),
    permissions: createEmptyPermissionCounters(),
  };

  const initialSave = await saveRunRecord(run);
  const initialSaveError = initialSave.match({ ok: () => undefined, err: (error) => error });
  if (initialSaveError !== undefined) {
    params.write({ ok: false, error: initialSaveError.message, runId });
    return 1;
  }
  const worker = await spawnWorker(runId);
  const workerError = worker.match({ ok: () => undefined, err: (error) => error });
  if (workerError !== undefined) {
    params.write({ ok: false, error: workerError.message, runId });
    return 1;
  }
  const spawnedWorker = worker.match({ ok: (value) => value, err: () => undefined });
  if (spawnedWorker === undefined) return 1;
  const admitted = await persistSpawnedWorkerAdmission(run, spawnedWorker);
  const admissionError = admitted.match({ ok: () => undefined, err: (error) => error });
  if (admissionError !== undefined) {
    params.write({ ok: false, error: admissionError.message, runId });
    return 1;
  }
  const withWorker = admitted.match({ ok: (value) => value, err: () => undefined });
  if (withWorker === undefined) return 1;

  if (params.wait) {
    return runPromptWait({
      runId,
      timeoutMs: params.timeoutMs,
      pollMs: params.pollMs,
      write: params.write,
    });
  }

  params.write({
    ok: true,
    runId,
    status: withWorker.status,
    harnessId: withWorker.harnessId,
    ...(withWorker.sessionRef ? { sessionRef: withWorker.sessionRef } : {}),
    ...(withWorker.workerPid ? { workerPid: withWorker.workerPid } : {}),
    run: withWorker,
  });
  return 0;
}

async function runPromptInspect(params: { runId: string; write: OutputWriter }): Promise<number> {
  const loaded = await loadRunRecord(params.runId);
  const loadError = loaded.match({ ok: () => undefined, err: (error) => error });
  if (loadError !== undefined) {
    params.write({ ok: false, error: loadError.message, runId: params.runId });
    return 1;
  }
  const loadedRun = loaded.match({ ok: (value) => value, err: () => undefined });
  if (loadedRun === undefined) return 1;
  const refreshed = await refreshRunStatus(loadedRun);
  const refreshError = refreshed.match({ ok: () => undefined, err: (error) => error });
  if (refreshError !== undefined) {
    params.write({ ok: false, error: refreshError.message, runId: params.runId });
    return 1;
  }
  const run = refreshed.match({ ok: (value) => value, err: () => undefined });
  if (run === undefined) return 1;
  params.write({
    ok: true,
    runId: run.id,
    status: run.status,
    harnessId: run.harnessId,
    ...(run.sessionRef ? { sessionRef: run.sessionRef } : {}),
    run,
  });
  return 0;
}

async function runPromptResult(params: { runId: string; write: OutputWriter }): Promise<number> {
  const loaded = await loadRunRecord(params.runId);
  const loadError = loaded.match({ ok: () => undefined, err: (error) => error });
  if (loadError !== undefined) {
    params.write({ ok: false, error: loadError.message, runId: params.runId });
    return 1;
  }
  const loadedRun = loaded.match({ ok: (value) => value, err: () => undefined });
  if (loadedRun === undefined) return 1;
  const refreshed = await refreshRunStatus(loadedRun);
  const refreshError = refreshed.match({ ok: () => undefined, err: (error) => error });
  if (refreshError !== undefined) {
    params.write({ ok: false, error: refreshError.message, runId: params.runId });
    return 1;
  }
  const run = refreshed.match({ ok: (value) => value, err: () => undefined });
  if (run === undefined) return 1;
  if (!isTerminalStatus(run.status)) {
    params.write({
      ok: false,
      error: `Run '${params.runId}' is not finished yet (status=${run.status}).`,
      runId: params.runId,
      status: run.status,
    });
    return 1;
  }
  params.write({
    ok: run.status === "completed",
    runId: run.id,
    status: run.status,
    harnessId: run.harnessId,
    ...(run.sessionRef ? { sessionRef: run.sessionRef } : {}),
    ...(run.resultText ? { resultText: run.resultText } : {}),
    ...(run.error ? { error: run.error } : {}),
    run,
  });
  return run.status === "completed" ? 0 : 1;
}

async function runPromptWait(params: {
  runId: string;
  timeoutMs: number;
  pollMs: number;
  write: OutputWriter;
}): Promise<number> {
  const startedAt = Date.now();

  while (true) {
    const loaded = await loadRunRecord(params.runId);
    const loadError = loaded.match({ ok: () => undefined, err: (error) => error });
    if (loadError !== undefined) {
      params.write({ ok: false, error: loadError.message, runId: params.runId });
      return 1;
    }
    const loadedRun = loaded.match({ ok: (value) => value, err: () => undefined });
    if (loadedRun === undefined) return 1;
    const refreshed = await refreshRunStatus(loadedRun);
    const refreshError = refreshed.match({ ok: () => undefined, err: (error) => error });
    if (refreshError !== undefined) {
      params.write({ ok: false, error: refreshError.message, runId: params.runId });
      return 1;
    }
    const run = refreshed.match({ ok: (value) => value, err: () => undefined });
    if (run === undefined) return 1;
    if (isTerminalStatus(run.status)) {
      params.write({
        ok: run.status === "completed",
        runId: run.id,
        status: run.status,
        harnessId: run.harnessId,
        ...(run.sessionRef ? { sessionRef: run.sessionRef } : {}),
        ...(run.resultText ? { resultText: run.resultText } : {}),
        ...(run.error ? { error: run.error } : {}),
        run,
      });
      return run.status === "completed" ? 0 : 1;
    }

    if (Date.now() - startedAt >= params.timeoutMs) {
      params.write({
        ok: false,
        runId: params.runId,
        error: `Timed out after ${params.timeoutMs}ms.`,
      });
      return 1;
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(50, params.pollMs)));
  }
}

async function runPromptCancel(params: { runId: string; write: OutputWriter }): Promise<number> {
  const cancellation = await requestRunCancellation(params.runId);
  const cancellationError = cancellation.match({ ok: () => undefined, err: (error) => error });
  if (cancellationError !== undefined) {
    params.write({ ok: false, error: cancellationError.message, runId: params.runId });
    return 1;
  }
  const cancellationResult = cancellation.match({ ok: (value) => value, err: () => undefined });
  if (cancellationResult === undefined) return 1;
  if (cancellationResult.kind === "already-terminal") {
    params.write({
      ok: false,
      runId: params.runId,
      error: `Run '${params.runId}' already finished with status '${cancellationResult.run.status}'.`,
    });
    return 1;
  }
  const run = cancellationResult.run;

  const alive = await isProcessAlive(run.workerPid);
  const aliveError = alive.match({ ok: () => undefined, err: (error) => error });
  if (aliveError !== undefined) {
    params.write({ ok: false, error: aliveError.message, runId: params.runId });
    return 1;
  }
  const processAlive = alive.match({ ok: (value) => value, err: () => false });
  if (!run.workerPid || !processAlive) {
    params.write({ ok: true, runId: params.runId, signalled: false });
    return 0;
  }
  const workerPid = run.workerPid;
  const signalled = await captureExternal("signal-worker", async () => {
    process.kill(workerPid, "SIGTERM");
  });
  const signalError = signalled.match({ ok: () => undefined, err: (error) => error });
  if (signalError !== undefined) {
    params.write({ ok: false, error: signalError.message, runId: params.runId });
    return 1;
  }
  params.write({
    ok: true,
    runId: params.runId,
    signalled: true,
    workerPid,
  });
  return 0;
}

type PersistRunFromCollector = (
  run: PromptRunRecord,
  collector: SessionHistoryCollector,
) => Promise<ResultType<void, RunStoreError>>;

export async function persistRunFromCollector(
  run: PromptRunRecord,
  collector: SessionHistoryCollector,
  persist: (record: PromptRunRecord) => Promise<ResultType<void, RunStoreError>> = async (
    record,
  ) => {
    const saved = await saveWorkerRunRecord(record);
    return saved.map((value) => {
      Object.assign(record, value);
    });
  },
): Promise<ResultType<void, RunStoreError>> {
  let sessionUpdate: Pick<PromptRunRecord, "session"> | Record<string, never> = {};
  if (run.session) {
    sessionUpdate = {
      session: {
        ...run.session,
        title: collector.title ?? run.session.title,
        updatedAt: collector.updatedAt ?? run.session.updatedAt,
      },
    };
  } else if (run.sessionRef) {
    sessionUpdate = {
      session: {
        title: collector.title ?? run.requestedTitle,
        cwd: run.directory,
        updatedAt: collector.updatedAt,
        capabilities: capabilitiesFromSummary(run.session),
      },
    };
  }
  const next: PromptRunRecord = {
    ...run,
    updatedAt: Date.now(),
    ...sessionUpdate,
    ...(collector.plan ? { plan: collector.plan.map((entry) => ({ ...entry })) } : {}),
    ...(collector.history.length > 0
      ? { history: collector.history.map((message) => ({ ...message })) }
      : {}),
    ...(collector.latestAssistantText() ? { resultText: collector.latestAssistantText() } : {}),
  };
  const saved = await persist(next);
  return saved.map(() => {
    Object.assign(run, next);
  });
}

export function createSessionUpdatePersistence(
  run: PromptRunRecord,
  collector: SessionHistoryCollector,
  persist: PersistRunFromCollector = persistRunFromCollector,
): {
  readonly onUpdate: (notification: SessionNotification) => Promise<void>;
  readonly persist: (record: PromptRunRecord) => Promise<ResultType<void, RunStoreError>>;
  readonly finalize: () => Promise<ResultType<void, RunStoreError>>;
} {
  let closed = false;
  let pending = Promise.resolve();
  let persistenceError: RunStoreError | undefined;
  let finalized: Promise<ResultType<void, RunStoreError>> | undefined;

  const enqueuePersistence = (record: PromptRunRecord) => {
    const persisted = pending.then(async () => {
      const result = await persist(record, collector);
      result.match({
        err: (error) => {
          persistenceError ??= error;
        },
        ok: () => {
          Object.assign(run, record);
        },
      });
      return result;
    });
    pending = persisted.then(() => undefined);
    return persisted;
  };

  return {
    onUpdate: (notification) => {
      if (closed) return Promise.resolve();
      const update = pending.then(async () => {
        collector.add(notification);
        const persisted = await persist(run, collector);
        persisted.match({
          ok: () => {},
          err: (error) => {
            persistenceError ??= error;
          },
        });
      });
      pending = update;
      return update;
    },
    persist: enqueuePersistence,
    finalize: () => {
      if (finalized) return finalized;
      closed = true;
      finalized = pending.then(() =>
        persistenceError ? Result.err(persistenceError) : Result.ok(undefined),
      );
      return finalized;
    },
  };
}

type AcpWorkerLifecycleError<WorkError> =
  | WorkError
  | ExternalOperationFailed
  | WorkerLifecycleCleanupFailed<WorkError | ExternalOperationFailed>;

export async function runAcpWorkerLifecycle<T, WorkError extends { readonly message: string }>(
  work: () => Promise<ResultType<T, WorkError>>,
  cleanup: () => Promise<ResultType<void, ExternalOperationFailed>>,
  removeSignals: () => void,
): Promise<ResultType<T, AcpWorkerLifecycleError<WorkError>>> {
  const attempted = await Result.tryPromise({ try: work, catch: captureAcpFailure });
  const removalAttempted = Result.try({ try: removeSignals, catch: captureAcpFailure });
  const cleanupAttempted = await Result.tryPromise({ try: cleanup, catch: captureAcpFailure });

  const workCaptureFailure = attempted.match({ ok: () => undefined, err: (failure) => failure });
  const removalCaptureFailure = removalAttempted.match({
    ok: () => undefined,
    err: (failure) => failure,
  });
  const cleanupCaptureFailure = cleanupAttempted.match({
    ok: () => undefined,
    err: (failure) => failure,
  });

  if (workCaptureFailure?.kind === "panic") {
    if (removalCaptureFailure !== undefined) {
      const removalFailure =
        removalCaptureFailure.kind === "panic"
          ? removalCaptureFailure.panic
          : capturedWorkerFailure("remove-worker-signals", removalCaptureFailure);
      recordAcpCleanupFailure(workCaptureFailure.panic, removalFailure);
    }
    if (cleanupCaptureFailure === undefined) {
      const cleanupError = cleanupAttempted.match({
        ok: (result) => result.match({ ok: () => undefined, err: (error) => error }),
        err: () => undefined,
      });
      if (cleanupError !== undefined)
        recordAcpCleanupFailure(workCaptureFailure.panic, cleanupError);
    } else {
      const cleanupFailure =
        cleanupCaptureFailure.kind === "panic"
          ? cleanupCaptureFailure.panic
          : capturedWorkerFailure("close-harness", cleanupCaptureFailure);
      recordAcpCleanupFailure(workCaptureFailure.panic, cleanupFailure);
    }
    return signalAcpDefect(workCaptureFailure.panic);
  }

  if (removalCaptureFailure?.kind === "panic") {
    if (cleanupCaptureFailure === undefined) {
      const cleanupError = cleanupAttempted.match({
        ok: (result) => result.match({ ok: () => undefined, err: (error) => error }),
        err: () => undefined,
      });
      if (cleanupError !== undefined) {
        recordAcpCleanupFailure(removalCaptureFailure.panic, cleanupError);
      }
    } else {
      const cleanupFailure =
        cleanupCaptureFailure.kind === "panic"
          ? cleanupCaptureFailure.panic
          : capturedWorkerFailure("close-harness", cleanupCaptureFailure);
      recordAcpCleanupFailure(removalCaptureFailure.panic, cleanupFailure);
    }
    return signalAcpDefect(removalCaptureFailure.panic);
  }

  if (cleanupCaptureFailure?.kind === "panic") {
    if (removalCaptureFailure?.kind === "ordinary") {
      recordAcpCleanupFailure(
        cleanupCaptureFailure.panic,
        capturedWorkerFailure("remove-worker-signals", removalCaptureFailure),
      );
    }
    return signalAcpDefect(cleanupCaptureFailure.panic);
  }

  const resultOrPanic = attempted.match<ResultType<T, WorkError | ExternalOperationFailed> | Panic>(
    {
      ok: (result) => result,
      err: (failure) =>
        failure.kind === "panic"
          ? failure.panic
          : Result.err(capturedWorkerFailure("worker-process", failure)),
    },
  );
  if (Panic.is(resultOrPanic)) return signalAcpDefect(resultOrPanic);
  const result = resultOrPanic;
  const removalFailure =
    removalCaptureFailure?.kind === "ordinary"
      ? capturedWorkerFailure("remove-worker-signals", removalCaptureFailure)
      : undefined;
  const cleanedOrPanic = cleanupAttempted.match<ResultType<void, ExternalOperationFailed> | Panic>({
    ok: (result) => result,
    err: (failure) =>
      failure.kind === "panic"
        ? failure.panic
        : Result.err(capturedWorkerFailure("close-harness", failure)),
  });
  if (Panic.is(cleanedOrPanic)) return signalAcpDefect(cleanedOrPanic);
  const harnessCleanup = cleanedOrPanic.match({ ok: () => undefined, err: (error) => error });
  if (!removalFailure && !harnessCleanup) return result;
  const resultError = result.match({ ok: () => undefined, err: (error) => error });
  if (resultError === undefined && removalFailure && !harnessCleanup) {
    return Result.err(removalFailure);
  }
  if (resultError === undefined && harnessCleanup && !removalFailure) {
    return Result.err(harnessCleanup);
  }
  return Result.err(
    new WorkerLifecycleCleanupFailed({
      ...(resultError !== undefined ? { primary: resultError } : {}),
      ...(removalFailure ? { signalCleanup: removalFailure } : {}),
      ...(harnessCleanup ? { harnessCleanup } : {}),
      message:
        resultError !== undefined
          ? `${resultError.message} Worker lifecycle cleanup also failed.`
          : "Worker lifecycle cleanup failed.",
    }),
  );
}

export async function runPromptWithCancellationMonitor(params: {
  readonly observe: () => Promise<ResultType<RunCancellationObservation, ExternalOperationFailed>>;
  readonly prompt: () => Promise<ResultType<PromptResponse, ExternalOperationFailed>>;
  readonly cancel: () => Promise<ResultType<void, ExternalOperationFailed>>;
  readonly terminate: () => Promise<ResultType<void, ExternalOperationFailed>>;
}): Promise<
  ResultType<
    PromptResponse,
    | RunStoreError
    | WorkerLifecycleCleanupFailed<ExternalOperationFailed>
    | MonitorTerminationFailed<RunStoreError>
    | WorkAndMonitorFailed<AcpWorkerLifecycleError<ExternalOperationFailed>, RunStoreError>
  >
> {
  const observed = await params.observe();
  const observation = observed.match<RunCancellationObservation | ExternalOperationFailed>({
    ok: (value) => value,
    err: (error) => error,
  });
  if (ExternalOperationFailed.is(observation)) return Result.err(observation);
  let promptActive = false;
  let signalPromptStarted: () => void = () => undefined;
  const promptStarted = new Promise<void>((resolve) => {
    signalPromptStarted = resolve;
  });
  const monitored = (async (): Promise<ResultType<void, RunStoreError>> => {
    const cancellation = await observation.result;
    const cancellationError = cancellation.match({ ok: () => undefined, err: (error) => error });
    if (cancellationError !== undefined) return Result.err(cancellationError);
    const cancellationState = cancellation.match({ ok: (value) => value, err: () => "stopped" });
    if (cancellationState === "stopped") return Result.ok(undefined);
    await promptStarted;
    if (!promptActive) return Result.ok(undefined);
    return params.cancel();
  })();

  const promptedAttemptedPromise = Result.tryPromise({
    try: () =>
      runAcpWorkerLifecycle(
        async () => {
          promptActive = true;
          signalPromptStarted();
          const prompt = params.prompt();
          const result = await prompt;
          promptActive = false;
          return result;
        },
        observation.close,
        () => undefined,
      ),
    catch: captureAcpFailure,
  });
  const monitorAttemptedPromise = Result.tryPromise({
    try: () => monitored,
    catch: captureAcpFailure,
  });
  const first = await Promise.race([
    promptedAttemptedPromise.then((attempted) => ({ kind: "prompt" as const, attempted })),
    monitorAttemptedPromise.then((attempted) => ({ kind: "monitor" as const, attempted })),
  ]);

  const firstMonitorFailed =
    first.kind === "monitor" &&
    first.attempted.match({
      ok: (result) => result.match({ ok: () => false, err: () => true }),
      err: () => true,
    });
  if (firstMonitorFailed && first.kind === "monitor") {
    promptActive = false;
    const watcherCleanupPromise = Result.tryPromise({
      try: observation.close,
      catch: captureAcpFailure,
    });
    const terminationPromise = Result.tryPromise({
      try: params.terminate,
      catch: captureAcpFailure,
    });
    const [watcherCleanup, termination] = await Promise.all([
      watcherCleanupPromise,
      terminationPromise,
    ]);
    void promptedAttemptedPromise.then(() => undefined);

    let monitorPanic: Panic | undefined;
    let monitorError: RunStoreError;
    const monitorCaptureFailure = first.attempted.match({
      ok: () => undefined,
      err: (failure) => failure,
    });
    if (monitorCaptureFailure === undefined) {
      const result = first.attempted.match({ ok: (value) => value, err: () => undefined });
      const error = result?.match({ ok: () => undefined, err: (failure) => failure });
      if (error === undefined) {
        return Result.err(
          new ExternalOperationFailed({
            operation: "watch-run-cancellation",
            cause: new Error("Cancellation monitor unexpectedly succeeded on its failure path."),
            message: "Cancellation monitor unexpectedly succeeded on its failure path.",
          }),
        );
      }
      monitorError = error;
    } else {
      switch (monitorCaptureFailure.kind) {
        case "panic":
          monitorPanic = monitorCaptureFailure.panic;
          monitorError = new ExternalOperationFailed({
            operation: "watch-run-cancellation",
            cause: monitorPanic,
            message: monitorPanic.message,
          });
          break;
        case "ordinary":
          monitorError = capturedWorkerFailure("watch-run-cancellation", monitorCaptureFailure);
          break;
      }
    }

    const watcherFailure = capturedCleanupResult(watcherCleanup, "close-run-cancellation-watch");
    const terminationFailure = capturedCleanupResult(termination, "close-harness");
    if (monitorPanic) {
      if (watcherFailure) recordAcpCleanupFailure(monitorPanic, watcherFailure);
      if (terminationFailure) recordAcpCleanupFailure(monitorPanic, terminationFailure);
      return signalAcpDefect(monitorPanic);
    }
    let cleanupPanic: Panic | undefined;
    if (Panic.is(watcherFailure)) cleanupPanic = watcherFailure;
    else if (Panic.is(terminationFailure)) cleanupPanic = terminationFailure;
    if (cleanupPanic) {
      const secondary = cleanupPanic === watcherFailure ? terminationFailure : watcherFailure;
      if (secondary) recordAcpCleanupFailure(cleanupPanic, secondary);
      return signalAcpDefect(cleanupPanic);
    }
    const watcherError =
      watcherFailure instanceof ExternalOperationFailed ? watcherFailure : undefined;
    const terminationError =
      terminationFailure instanceof ExternalOperationFailed ? terminationFailure : undefined;
    if (!watcherError && !terminationError) return Result.err(monitorError);
    return Result.err(
      new MonitorTerminationFailed({
        primary: monitorError,
        ...(watcherError ? { watcherCleanup: watcherError } : {}),
        ...(terminationError ? { termination: terminationError } : {}),
        message: `${monitorError.message} In-flight prompt termination also failed.`,
      }),
    );
  }

  const promptedAttempted =
    first.kind === "prompt" ? first.attempted : await promptedAttemptedPromise;
  const monitorAttempted =
    first.kind === "monitor" ? first.attempted : await monitorAttemptedPromise;
  const promptCaptureFailure = promptedAttempted.match({
    ok: () => undefined,
    err: (failure) => failure,
  });
  const monitorCaptureFailure = monitorAttempted.match({
    ok: () => undefined,
    err: (failure) => failure,
  });
  if (promptCaptureFailure?.kind === "panic") {
    if (monitorCaptureFailure !== undefined) {
      const secondary =
        monitorCaptureFailure.kind === "panic"
          ? monitorCaptureFailure.panic
          : capturedWorkerFailure("watch-run-cancellation", monitorCaptureFailure);
      recordAcpCleanupFailure(promptCaptureFailure.panic, secondary);
    } else {
      const monitorError = monitorAttempted.match({
        ok: (result) => result.match({ ok: () => undefined, err: (error) => error }),
        err: () => undefined,
      });
      if (monitorError !== undefined) {
        const secondary = ExternalOperationFailed.is(monitorError)
          ? monitorError
          : new ExternalOperationFailed({
              operation: "watch-run-cancellation",
              cause: monitorError,
              message: monitorError.message,
            });
        recordAcpCleanupFailure(promptCaptureFailure.panic, secondary);
      }
    }
    return signalAcpDefect(promptCaptureFailure.panic);
  }
  if (monitorCaptureFailure?.kind === "panic") {
    return signalAcpDefect(monitorCaptureFailure.panic);
  }
  const promptedOrPanic = promptedAttempted.match<
    ResultType<PromptResponse, AcpWorkerLifecycleError<ExternalOperationFailed>> | Panic
  >({
    ok: (result) => result,
    err: (failure) =>
      failure.kind === "panic"
        ? failure.panic
        : Result.err(capturedWorkerFailure("worker-process", failure)),
  });
  if (Panic.is(promptedOrPanic)) return signalAcpDefect(promptedOrPanic);
  const prompted = promptedOrPanic;
  const monitorOrPanic = monitorAttempted.match<ResultType<void, RunStoreError> | Panic>({
    ok: (result) => result,
    err: (failure) =>
      failure.kind === "panic"
        ? failure.panic
        : Result.err(capturedWorkerFailure("watch-run-cancellation", failure)),
  });
  if (Panic.is(monitorOrPanic)) return signalAcpDefect(monitorOrPanic);
  const monitorError = monitorOrPanic.match({ ok: () => undefined, err: (error) => error });
  if (monitorError === undefined) return prompted;
  const promptError = prompted.match({ ok: () => undefined, err: (error) => error });
  if (promptError === undefined) return Result.err(monitorError);
  return Result.err(
    new WorkAndMonitorFailed({
      primary: promptError,
      monitor: monitorError,
      message: `${promptError.message} Cancellation monitoring also failed.`,
    }),
  );
}

async function runWorkerProcess(
  runId: string,
  version: string,
): Promise<ResultType<number, RunStoreError>> {
  const loaded = await loadRunRecord(runId);
  const loadError = loaded.match({ ok: () => undefined, err: (error) => error });
  if (loadError !== undefined) return Result.err(loadError);
  const run = loaded.match({ ok: (value) => value, err: () => undefined });
  if (run === undefined) return loaded.map(() => 1);
  const resolvedHarness = await resolveHarness(run.harnessId);
  const resolveError = resolvedHarness.match({ ok: () => undefined, err: (error) => error });
  const harness = resolvedHarness.match({ ok: (value) => value, err: () => null });
  if (resolveError !== undefined || !harness) {
    const failed: PromptRunRecord = {
      ...run,
      status: "failed",
      updatedAt: Date.now(),
      error:
        resolveError !== undefined
          ? resolveError.message
          : (getHarnessDescriptor(run.harnessId)?.installHint ??
            `Harness '${run.harnessId}' is not launchable.`),
    };
    const saved = await saveRunRecord(failed);
    return saved.map(() => 1);
  }

  const collector = new SessionHistoryCollector();
  const sessionUpdates = createSessionUpdatePersistence(run, collector);
  const connected = await AcpHarnessClient.connect({
    harness,
    version,
    permissionBehavior: "always",
    counters: run.permissions,
    onUpdate: sessionUpdates.onUpdate,
  });
  const connectError = connected.match({ ok: () => undefined, err: (error) => error });
  if (connectError !== undefined) {
    const updatesFinalized = await sessionUpdates.finalize();
    const failed: PromptRunRecord = {
      ...run,
      status: "failed",
      updatedAt: Date.now(),
      error: connectError.message,
    };
    const saved = await sessionUpdates.persist(failed);
    const saveError = saved.match({ ok: () => undefined, err: (error) => error });
    if (saveError !== undefined) return Result.err(saveError);
    return updatesFinalized.map(() => 1);
  }
  const client = connected.match({ ok: (value) => value, err: () => undefined });
  if (client === undefined) return Result.ok(1);
  let clientCloseAttempted = false;
  const closeClient = async (): Promise<ResultType<void, ExternalOperationFailed>> => {
    if (clientCloseAttempted) return Result.ok(undefined);
    clientCloseAttempted = true;
    return client.close();
  };

  let remoteSessionId = run.remoteSessionId;
  let cancellationRequested = false;
  const onTerminate = () => {
    cancellationRequested = true;
    if (remoteSessionId) void client.cancel(remoteSessionId);
  };
  process.on("SIGTERM", onTerminate);
  process.on("SIGINT", onTerminate);

  const lifecycle = await runAcpWorkerLifecycle(
    async (): Promise<ResultType<void, { readonly message: string }>> => {
      let workError: { readonly message: string } | undefined;
      if (run.targetKind === "existing") {
        if (!remoteSessionId) {
          workError = new RunInvariantFailed({
            runId: run.id,
            message: `Run '${run.id}' is missing its remote session ID.`,
          });
        } else {
          const sessionLoaded = await client.loadSession(remoteSessionId, run.directory);
          sessionLoaded.match({
            ok: () => {},
            err: (error) => {
              workError = error;
            },
          });
        }
      } else {
        const created = await client.createSession(run.directory);
        const createError = created.match({ ok: () => undefined, err: (error) => error });
        if (createError !== undefined) {
          workError = createError;
        } else {
          const createdSession = created.match({ ok: (value) => value, err: () => undefined });
          if (createdSession === undefined) return created.map(() => undefined);
          remoteSessionId = createdSession.sessionId;
          run.remoteSessionId = remoteSessionId;
          run.sessionRef = formatSessionRef(run.harnessId, remoteSessionId);
          const indexed = await upsertSessionIndexEntries([
            {
              sessionRef: run.sessionRef,
              harnessId: run.harnessId,
              remoteSessionId,
              cwd: run.directory,
              title: run.requestedTitle,
              updatedAt: undefined,
              capabilities: client.capabilities(),
              lastSeenAt: Date.now(),
              ...(run.requestedTitle ? { localTitle: run.requestedTitle } : {}),
            },
          ]);
          indexed.match({
            ok: () => {},
            err: (error) => {
              workError = error;
            },
          });
          if (!workError && run.requestedTitle) {
            const titled = await setLocalSessionTitle(run.sessionRef, run.requestedTitle);
            titled.match({
              ok: () => {},
              err: (error) => {
                workError = error;
              },
            });
          }
        }
      }

      if (!workError) {
        if (!remoteSessionId || !run.sessionRef) {
          workError = new RunInvariantFailed({
            runId: run.id,
            message: `Run '${run.id}' could not resolve a session target.`,
          });
        }
      }

      if (!workError && remoteSessionId && run.sessionRef) {
        const activeSessionId = remoteSessionId;
        const userMessageId = randomUUID();
        const running: PromptRunRecord = {
          ...run,
          session: {
            title: run.requestedTitle,
            cwd: run.directory,
            updatedAt: collector.updatedAt,
            capabilities: client.capabilities(),
          },
          status: "running",
          userMessageId,
          updatedAt: Date.now(),
        };
        const runningSaved = await sessionUpdates.persist(running);
        runningSaved.match({
          err: (error) => {
            workError = error;
          },
          ok: () => {
            Object.assign(run, running);
          },
        });

        if (!workError) {
          const refreshedRun = await loadRunRecord(run.id);
          const refreshError = refreshedRun.match({ ok: () => undefined, err: (error) => error });
          const currentRun = refreshedRun.match({ ok: (value) => value, err: () => undefined });
          if (refreshError !== undefined) {
            workError = refreshError;
          } else if (cancellationRequested || currentRun?.cancelRequestedAt) {
            cancellationRequested = true;
            const updatesFinalized = await sessionUpdates.finalize();
            const finalizeError = updatesFinalized.match({
              ok: () => undefined,
              err: (error) => error,
            });
            if (finalizeError !== undefined) {
              workError = finalizeError;
            } else {
              const cancelled: PromptRunRecord = {
                ...run,
                status: "cancelled",
                updatedAt: Date.now(),
                error: "Cancelled before prompt submission completed.",
              };
              const cancelledSaved = await sessionUpdates.persist(cancelled);
              cancelledSaved.match({
                err: (error) => {
                  workError = error;
                },
                ok: () => {
                  Object.assign(run, cancelled);
                },
              });
            }
          }
        }

        if (!workError && run.status !== "cancelled" && run.requestedMode) {
          const mode = await client.setMode(activeSessionId, run.requestedMode);
          mode.match({
            ok: () => {},
            err: (error) => {
              workError = error;
            },
          });
        }
        if (!workError && run.status !== "cancelled" && run.requestedModel) {
          const model = await client.setModel(activeSessionId, run.requestedModel);
          model.match({
            ok: () => {},
            err: (error) => {
              workError = error;
            },
          });
        }

        if (!workError && run.status !== "cancelled") {
          const prompted = await runPromptWithCancellationMonitor({
            observe: () => observeRunCancellation(run),
            prompt: () => client.prompt(activeSessionId, run.promptText, userMessageId),
            cancel: () => client.cancel(activeSessionId),
            terminate: closeClient,
          });
          const promptError = prompted.match({ ok: () => undefined, err: (error) => error });
          if (promptError !== undefined) {
            workError = promptError;
          } else {
            const updatesFinalized = await sessionUpdates.finalize();
            const finalizeError = updatesFinalized.match({
              ok: () => undefined,
              err: (error) => error,
            });
            if (finalizeError !== undefined) {
              workError = finalizeError;
            } else {
              const promptResponse = prompted.match<PromptResponse | undefined>({
                ok: (value) => value,
                err: () => undefined,
              });
              if (promptResponse === undefined) return prompted.map(() => undefined);
              const terminal: PromptRunRecord = {
                ...run,
                stopReason: promptResponse.stopReason,
                status:
                  cancellationRequested || isCancelledStopReason(promptResponse.stopReason)
                    ? "cancelled"
                    : "completed",
                updatedAt: Date.now(),
              };
              const persisted = await sessionUpdates.persist(terminal);
              const persistError = persisted.match({ ok: () => undefined, err: (error) => error });
              if (persistError !== undefined) {
                workError = persistError;
              } else {
                Object.assign(run, terminal);
                const indexed = await upsertSessionIndexEntries([
                  buildIndexEntry(
                    {
                      harnessId: run.harnessId,
                      sessionId: activeSessionId,
                      sessionRef: run.sessionRef,
                      title: collector.title ?? run.requestedTitle,
                      cwd: run.directory,
                      updatedAt: collector.updatedAt,
                      capabilities: client.capabilities(),
                    },
                    run.requestedTitle,
                  ),
                ]);
                indexed.match({
                  ok: () => {},
                  err: (error) => {
                    workError = error;
                  },
                });
              }
            }
          }
        }
      }

      const updatesFinalized = await sessionUpdates.finalize();
      const finalizeError = updatesFinalized.match({ ok: () => undefined, err: (error) => error });
      if (!workError && finalizeError !== undefined) workError = finalizeError;
      return workError ? Result.err(workError) : Result.ok(undefined);
    },
    closeClient,
    () => {
      process.off("SIGTERM", onTerminate);
      process.off("SIGINT", onTerminate);
    },
  );
  const workError: { readonly message: string } | undefined = lifecycle.match({
    ok: () => undefined,
    err: (error) => error,
  });

  if (workError) {
    const authHint = client.authHint();
    const cancelled = run.status === "cancelled" || cancellationRequested;
    let runError = workError.message;
    if (cancelled) {
      runError = run.error ?? "Prompt cancelled.";
    } else if (authHint && workError instanceof ExternalOperationFailed) {
      if (isAuthRequiredError(workError)) runError = authHint;
    }
    const next: PromptRunRecord = {
      ...run,
      status: cancelled ? "cancelled" : "failed",
      updatedAt: Date.now(),
      error: runError,
    };
    const saved = await sessionUpdates.persist(next);
    return saved.map(() => 1);
  }
  return Result.ok(run.status === "completed" ? 0 : 1);
}

export async function main(argv: readonly string[]): Promise<number> {
  const commandName = "lilac-acp";
  const packageVersion = typeof PACKAGE_VERSION === "string" ? PACKAGE_VERSION : "0.0.0";
  const globalFlags = parseFlags(argv).flags;
  const cleanArgv = stripGlobalFlags(argv);
  const outputFlag = getStringFlag(globalFlags, "output");
  if (outputFlag && outputFlag !== "json" && outputFlag !== "human") {
    printJson({
      ok: false,
      error: `Invalid --output value '${outputFlag}' (expected json|human).`,
    });
    return 1;
  }
  const outputMode: OutputMode = outputFlag === "human" ? "human" : "json";
  const write = createOutputWriter(outputMode, commandName);

  if (cleanArgv.length === 0 || cleanArgv[0] === "help" || cleanArgv.includes("--help")) {
    write({ ok: true, help: help(commandName), version: packageVersion });
    return 0;
  }

  if (cleanArgv[0] === "--version" || cleanArgv[0] === "-v") {
    write({ ok: true, version: packageVersion });
    return 0;
  }

  if (cleanArgv[0] === "_worker") {
    const { flags, positionals } = parseFlags(cleanArgv.slice(1));
    if ((positionals[0] ?? "") !== "run") {
      write({ ok: false, error: "Unknown worker subcommand." });
      return 1;
    }
    const runId = getStringFlag(flags, "run-id");
    if (!runId) {
      write({ ok: false, error: "Missing --run-id for worker." });
      return 1;
    }
    const worker = await runWorkerProcess(runId, packageVersion);
    const workerError = worker.match({ ok: () => undefined, err: (error) => error });
    if (workerError !== undefined) {
      write({ ok: false, error: workerError.message, runId });
      return 1;
    }
    return worker.match({ ok: (value) => value, err: () => 1 });
  }

  const command = cleanArgv[0] ?? "";

  if (command === "harnesses") {
    const subcommand = cleanArgv[1] && !cleanArgv[1]?.startsWith("--") ? cleanArgv[1] : "list";
    if (subcommand !== "list") {
      write({
        ok: false,
        error: `Unknown harnesses subcommand '${subcommand}'.`,
        help: help(commandName),
      });
      return 1;
    }
    return runHarnessesList(packageVersion, write);
  }

  if (command === "sessions") {
    const subcommand = cleanArgv[1] && !cleanArgv[1]?.startsWith("--") ? cleanArgv[1] : "list";
    const rest =
      subcommand === "list" || subcommand === "snapshot" ? cleanArgv.slice(2) : cleanArgv.slice(1);
    const { flags } = parseFlags(rest);
    const directory = getStringFlag(flags, "directory") ?? process.cwd();
    const harnessId = getStringFlag(flags, "harness");

    if (subcommand === "snapshot") {
      return runSessionsSnapshot({
        directory,
        harnessId,
        sessionIdFlag: getStringFlag(flags, "session-id"),
        title: getStringFlag(flags, "title"),
        latest: getBoolFlag(flags, "latest", false),
        maxRuns: getIntFlag(flags, "runs", 6),
        maxChars: getIntFlag(flags, "max-chars", 1200),
        version: packageVersion,
        write,
      });
    }

    if (subcommand !== "list") {
      write({
        ok: false,
        error: `Unknown sessions subcommand '${subcommand}'.`,
        help: help(commandName),
      });
      return 1;
    }

    return runSessionsList({
      directory,
      harnessId,
      search: getStringFlag(flags, "search"),
      limit: getIntFlag(flags, "limit", 20),
      version: packageVersion,
      write,
    });
  }

  if (command === "prompt") {
    const subcommand = cleanArgv[1] && !cleanArgv[1]?.startsWith("--") ? cleanArgv[1] : "submit";
    const rest =
      subcommand === "submit" && cleanArgv[1]?.startsWith("--")
        ? cleanArgv.slice(1)
        : cleanArgv.slice(2);
    const { flags } = parseFlags(rest);

    if (!new Set(["submit", "status", "result", "wait", "cancel"]).has(subcommand)) {
      write({
        ok: false,
        error: `Unknown prompt subcommand '${subcommand}'.`,
        help: help(commandName),
      });
      return 1;
    }

    if (getStringFlag(flags, "variant")) {
      write({ ok: false, error: "--variant is not supported by lilac-acp." });
      return 1;
    }

    if (subcommand === "status") {
      const runId = getStringFlag(flags, "run-id");
      if (!runId) {
        write({ ok: false, error: "Missing --run-id for prompt status." });
        return 1;
      }
      return runPromptInspect({ runId, write });
    }

    if (subcommand === "result") {
      const runId = getStringFlag(flags, "run-id");
      if (!runId) {
        write({ ok: false, error: "Missing --run-id for prompt result." });
        return 1;
      }
      return runPromptResult({ runId, write });
    }

    if (subcommand === "wait") {
      const runId = getStringFlag(flags, "run-id");
      if (!runId) {
        write({ ok: false, error: "Missing --run-id for prompt wait." });
        return 1;
      }
      return runPromptWait({
        runId,
        timeoutMs: getIntFlag(flags, "timeout-ms", 20 * 60 * 1000),
        pollMs: getIntFlag(flags, "poll-ms", 1000),
        write,
      });
    }

    if (subcommand === "cancel") {
      const runId = getStringFlag(flags, "run-id");
      if (!runId) {
        write({ ok: false, error: "Missing --run-id for prompt cancel." });
        return 1;
      }
      return runPromptCancel({ runId, write });
    }

    const textFlag = getStringFlag(flags, "text");
    const text = (textFlag ?? (await readStdinText())).trim();
    if (text.length === 0) {
      write({ ok: false, error: "Missing --text and no stdin provided." });
      return 1;
    }

    return runPromptSubmit({
      directory: getStringFlag(flags, "directory") ?? process.cwd(),
      harnessId: getStringFlag(flags, "harness"),
      sessionIdFlag: getStringFlag(flags, "session-id"),
      title: getStringFlag(flags, "title"),
      latest: getBoolFlag(flags, "latest", false),
      text,
      requestedMode: getStringFlag(flags, "agent"),
      requestedModel: getStringFlag(flags, "model"),
      wait: getBoolFlag(flags, "wait", false),
      timeoutMs: getIntFlag(flags, "timeout-ms", 20 * 60 * 1000),
      pollMs: getIntFlag(flags, "poll-ms", 1000),
      version: packageVersion,
      write,
    });
  }

  write({ ok: false, error: `Unknown command '${command}'.`, help: help(commandName) });
  return 1;
}
