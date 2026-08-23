import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp as mkdtempFs,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createOpenAI } from "@ai-sdk/openai";
import {
  attachAutoCompaction,
  type AutoCompactionOptions,
  type HistoryProviderState,
} from "@stanley2058/lilac-agent";
import type {
  MiniLilacCancelCompactionResult,
  MiniLilacCompactionEvent,
  MiniLilacTodo,
  MiniLilacTodoState,
  MiniLilacUIMessage,
} from "@stanley2058/mini-lilac-client";
import { miniLilacUserUIMessageSchema } from "@stanley2058/mini-lilac-client";
import { createToolResultArtifactStore } from "@stanley2058/lilac-tool-results";
import {
  readUIMessageStream,
  type LanguageModel,
  type ModelMessage,
  type UIMessageChunk,
} from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { getCodexAuthStoragePath, ModelCapability } from "@stanley2058/lilac-utils";
import { Panic, Result } from "better-result";
import { z } from "zod";

import type { RuntimeConfig } from "../src/config";
import {
  createAiProviderRegistry,
  type LoadedProviderRegistry,
  type ProviderAuth,
  type ProviderConfig,
} from "../src/providers";
import {
  MiniLilacSessionOperationRejected,
  SessionService,
  type MiniLilacRuntimeChunk,
  type SessionServiceOptions,
} from "../src/session-service";
import { MiniLilacSkillCatalog } from "../src/skills";
import {
  MiniLilacDatabaseVersionError,
  MiniLilacSqliteStore,
  MiniLilacStoreOperationRejected,
} from "../src/sqlite-store";
import {
  WorkspaceHistoryStore,
  type LockedWorkspaceHistoryStore,
  type WorkspaceHistoryCaptureResult,
  type WorkspaceHistoryExpectedCurrent,
  type WorkspaceHistoryMaintenanceOptions,
  type WorkspaceHistoryMaintenanceResult,
  type WorkspaceHistoryMetric,
  type WorkspaceHistoryStoreOptions,
} from "../src/workspace-history-store";

const temporaryDirectories: string[] = [];

async function mkdtemp(prefix: string): Promise<string> {
  const directory = await mkdtempFs(prefix);
  const child = Bun.spawn(["git", "-C", directory, "init", "--quiet"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git init failed: ${stderr}`);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function zeroUsage() {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

function textResult(id: string, text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id },
        { type: "text-delta" as const, id, delta: text },
        { type: "text-end" as const, id },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function textResultWithInputTokens(id: string, text: string, inputTokens: number) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id },
        { type: "text-delta" as const, id, delta: text },
        { type: "text-end" as const, id },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            ...zeroUsage(),
            inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
          },
        },
      ],
    }),
  };
}

function textResultWithOpenAIItemId(id: string, text: string, itemId: string) {
  const providerMetadata = { openai: { itemId, phase: "final_answer" } };
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id, providerMetadata },
        { type: "text-delta" as const, id, delta: text, providerMetadata },
        { type: "text-end" as const, id, providerMetadata },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function phasedOpenAITextResult(
  parts: readonly {
    readonly id: string;
    readonly itemId: string;
    readonly phase: "commentary" | "final_answer";
    readonly text: string;
  }[],
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        ...parts.flatMap((part) => {
          const providerMetadata = {
            openai: { itemId: part.itemId, phase: part.phase },
          };
          return [
            { type: "text-start" as const, id: part.id, providerMetadata },
            {
              type: "text-delta" as const,
              id: part.id,
              delta: part.text,
              providerMetadata,
            },
            { type: "text-end" as const, id: part.id, providerMetadata },
          ];
        }),
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 9, noCache: 9, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
        },
      ],
    }),
  };
}

function streamErrorResult(error: unknown, partialText?: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        ...(partialText === undefined
          ? []
          : [
              { type: "text-start" as const, id: "partial" },
              { type: "text-delta" as const, id: "partial", delta: partialText },
            ]),
        { type: "error" as const, error },
      ],
    }),
  };
}

function textAndReadToolResult(id: string, text: string, filePath: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id },
        { type: "text-delta" as const, id, delta: text },
        { type: "text-end" as const, id },
        {
          type: "tool-call" as const,
          toolCallId: `${id}-read`,
          toolName: "read",
          input: JSON.stringify({ path: filePath }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function commentaryAndReadToolResult(id: string, text: string, filePath: string) {
  const providerMetadata = {
    openai: { itemId: `msg_${id}`, phase: "commentary" as const },
  };
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id, providerMetadata },
        { type: "text-delta" as const, id, delta: text, providerMetadata },
        { type: "text-end" as const, id, providerMetadata },
        {
          type: "tool-call" as const,
          toolCallId: `${id}-read`,
          toolName: "read",
          input: JSON.stringify({ path: filePath }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function webfetchToolResult(url: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: "failing-webfetch",
          toolName: "webfetch",
          input: JSON.stringify({ url }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function delegateResult(
  mode: "sync" | "deferred",
  prompt = "investigate",
  overrides: {
    readonly model?: string;
    readonly effort?: string;
    readonly sessionName?: string;
  } = {},
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: `delegate-${mode}-${prompt}`,
          toolName: "subagent_delegate",
          input: JSON.stringify({ profile: "child", prompt, mode, ...overrides }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function bashToolResult(command: string, dangerouslyAllow?: boolean) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: dangerouslyAllow ? "silent-bash-bypass" : "silent-bash",
          toolName: "bash",
          input: JSON.stringify({ command, dangerouslyAllow }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function textThenBashToolResult(command: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "idle-draft" },
        { type: "text-delta" as const, id: "idle-draft", delta: "starting command" },
        { type: "text-end" as const, id: "idle-draft" },
        {
          type: "tool-call" as const,
          toolCallId: "silent-bash",
          toolName: "bash",
          input: JSON.stringify({ command }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function grepToolResult(pattern: string, targetPath?: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: "oversized-grep",
          toolName: "grep",
          input: JSON.stringify({ pattern, path: targetPath }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function readToolResult(path: string, options?: { dangerouslyAllow?: boolean }) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: "direct-read",
          toolName: "read",
          input: JSON.stringify({ path, maxCharacters: 20_000, ...options }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

const bashOutputDeltaTestSchema = z.object({
  type: z.literal("output-delta"),
  delta: z.string(),
});

function batchedSkillResult(name: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: `batch-skill-${name}`,
          toolName: "batch",
          input: JSON.stringify({
            tool_calls: [{ tool: "skill", parameters: { name } }],
          }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function batchedReadResult(paths: readonly string[]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: "batch-read",
          toolName: "batch",
          input: JSON.stringify({
            tool_calls: paths.map((path) => ({ tool: "read", parameters: { path } })),
          }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function todoWriteResult(todos: readonly MiniLilacTodo[], toolCallId = "write-todos") {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId,
          toolName: "todowrite",
          input: JSON.stringify({ todos }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function todoAndReadResult(
  firstTodos: readonly MiniLilacTodo[],
  secondTodos: readonly MiniLilacTodo[],
  filePath: string,
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: "write-todos-first",
          toolName: "todowrite",
          input: JSON.stringify({ todos: firstTodos }),
        },
        {
          type: "tool-call" as const,
          toolCallId: "read-with-todos",
          toolName: "read",
          input: JSON.stringify({ path: filePath }),
        },
        {
          type: "tool-call" as const,
          toolCallId: "write-todos-second",
          toolName: "todowrite",
          input: JSON.stringify({ todos: secondTodos }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function userMessage(text: string): MiniLilacUIMessage & { role: "user" } {
  return { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
}

function steeringMessage(text: string): MiniLilacUIMessage & { role: "user" } {
  return { id: `steer-${text}`, role: "user", parts: [{ type: "text", text }] };
}

function seedCompletedHistory(
  store: MiniLilacSqliteStore,
  sessionId: string,
  modelMessages: readonly ModelMessage[],
  uiMessages: readonly MiniLilacUIMessage[],
  todos?: readonly MiniLilacTodo[],
  runId = `seed-run:${crypto.randomUUID()}`,
  providerState?: HistoryProviderState,
): string {
  const currentModelMessages = store.getModelMessages(sessionId);
  const currentUiMessages = store.getUiMessages(sessionId);
  const firstUser = miniLilacUserUIMessageSchema.parse(uiMessages[currentUiMessages.length]);
  const admittedModelMessages = modelMessages.slice(0, currentModelMessages.length + 1);
  if (admittedModelMessages.at(-1)?.role !== "user") {
    throw new Error("Seed history requires one new user message after the current transcript");
  }
  const commandId = `seed-command:${crypto.randomUUID()}`;
  const command = { kind: "prompt", runId: null, payload: { seed: commandId } } as const;
  store.reserveCommand(sessionId, commandId, command);
  const current = store.getCurrentHistoryState(sessionId);
  const admitted = store.admitRootPromptHistory({
    run: { id: runId, sessionId, profile: "reader", depth: 0 },
    commandId,
    commandPayload: command.payload,
    transitionId: `seed-transition:${crypto.randomUUID()}`,
    expectedCurrentStateId: current.id,
    modelMessages: admittedModelMessages,
    uiMessages: [...currentUiMessages, firstUser],
    observation:
      current.workspaceStatus === "capture-deferred"
        ? {
            stateId: `seed-observation:${crypto.randomUUID()}`,
            transitionId: `seed-observation-transition:${crypto.randomUUID()}`,
            workspaceSnapshotId: null,
            workspaceStatus: "unavailable",
            workspaceUnavailableReason: "git-unavailable",
          }
        : undefined,
  });
  if (todos !== undefined) store.replaceTodosForRun({ sessionId, runId, todos });
  store.reservePendingRunFinalization({
    runId,
    sessionId,
    openTransitionId: admitted.transition.id,
    modelMessages,
    uiMessages,
    runStatus: "completed",
    sessionStatus: "idle",
    error: null,
    terminalResult: undefined,
    inputTokens: null,
  });
  store.commitPendingRunFinalization({
    runId,
    destinationStateId: `seed-final:${crypto.randomUUID()}`,
    workspaceSnapshotId: null,
    workspaceStatus: "unavailable",
    workspaceUnavailableReason: "git-unavailable",
    ...(providerState === undefined ? {} : { providerState }),
  });
  return runId;
}

function seedOpenHistory(
  store: MiniLilacSqliteStore,
  sessionId: string,
  runId: string,
  message: MiniLilacUIMessage & { role: "user" },
): string {
  const text = message.parts.find((part) => part.type === "text")?.text ?? "seed";
  const commandId = `seed-command:${crypto.randomUUID()}`;
  const command = { kind: "prompt", runId: null, payload: { message } } as const;
  store.reserveCommand(sessionId, commandId, command);
  const current = store.getCurrentHistoryState(sessionId);
  const admitted = store.admitRootPromptHistory({
    run: { id: runId, sessionId, profile: "reader", depth: 0 },
    commandId,
    commandPayload: command.payload,
    transitionId: `seed-transition:${crypto.randomUUID()}`,
    expectedCurrentStateId: current.id,
    modelMessages: [...store.getModelMessages(sessionId), { role: "user", content: text }],
    uiMessages: [...store.getUiMessages(sessionId), message],
    observation:
      current.workspaceStatus === "capture-deferred"
        ? {
            stateId: `seed-observation:${crypto.randomUUID()}`,
            transitionId: `seed-observation-transition:${crypto.randomUUID()}`,
            workspaceSnapshotId: null,
            workspaceStatus: "unavailable",
            workspaceUnavailableReason: "git-unavailable",
          }
        : undefined,
  });
  return admitted.transition.id;
}

function reserveRetainedHistoryOperation(
  store: MiniLilacSqliteStore,
  sessionId: string,
  operationId: string,
): void {
  const transition = store.findLatestUndoableUserTransition(sessionId);
  if (transition === null) throw new Error("Seeded session has no undoable transition");
  const commandId = `undo:${operationId}`;
  store.reserveCommand(sessionId, commandId, { kind: "undo", runId: null, payload: {} });
  store.reserveHistoryOperation({
    id: operationId,
    sessionId,
    commandId,
    requestedAction: "undo",
    expectedSourceStateId: store.getCurrentHistoryState(sessionId).id,
    targetStateId: transition.fromStateId,
    userTransitionId: transition.id,
    filesystemMode: "skip",
    skipReason: "git-unavailable",
  });
}

class ScriptedWorkspaceHistoryStore extends WorkspaceHistoryStore {
  private captureCall = 0;

  constructor(
    options: WorkspaceHistoryStoreOptions,
    private readonly captureScript: (
      call: number,
      workspaceId: string,
    ) => Promise<WorkspaceHistoryCaptureResult>,
  ) {
    super(options);
  }

  override async withWorkspaceLock<T>(
    callback: (lockedStore: LockedWorkspaceHistoryStore) => Promise<T>,
  ): Promise<T> {
    return await callback({
      capture: async () => {
        this.captureCall += 1;
        return await this.captureScript(this.captureCall, this.workspaceId);
      },
      captureResult: async () => {
        this.captureCall += 1;
        return Result.ok(await this.captureScript(this.captureCall, this.workspaceId));
      },
      invalidateCaptureCacheResult: async () => Result.ok(undefined),
      prepareRestore: async () => ({ status: "skipped", reason: "git-unavailable" }),
    });
  }
}

class InterceptedWorkspaceHistoryStore extends WorkspaceHistoryStore {
  constructor(
    options: WorkspaceHistoryStoreOptions,
    private readonly hooks: {
      readonly beforePrepare?: (
        expectedCurrent: WorkspaceHistoryExpectedCurrent | undefined,
      ) => Promise<void> | void;
      readonly onCapture?: () => void;
      readonly onLockRequest?: () => void;
    },
  ) {
    super(options);
  }

  override async withWorkspaceLock<T>(
    callback: (lockedStore: LockedWorkspaceHistoryStore) => Promise<T>,
  ): Promise<T> {
    this.hooks.onLockRequest?.();
    return await super.withWorkspaceLock(async (lockedStore) => {
      const resumePreparedRestore = lockedStore.resumePreparedRestore;
      return await callback({
        captureResult: async () => {
          this.hooks.onCapture?.();
          return await lockedStore.captureResult();
        },
        invalidateCaptureCacheResult: async () => await lockedStore.invalidateCaptureCacheResult(),
        capture: async () => {
          this.hooks.onCapture?.();
          return await lockedStore.capture();
        },
        prepareRestore: async (rootTreeOid, expectedCurrent, operationId) => {
          await this.hooks.beforePrepare?.(expectedCurrent);
          return await lockedStore.prepareRestore(rootTreeOid, expectedCurrent, operationId);
        },
        ...(resumePreparedRestore === undefined
          ? {}
          : {
              resumePreparedRestore: async (input) => await resumePreparedRestore(input),
            }),
      });
    });
  }
}

class MaintenanceProbeWorkspaceHistoryStore extends WorkspaceHistoryStore {
  constructor(
    options: WorkspaceHistoryStoreOptions,
    private readonly maintain: (
      options: WorkspaceHistoryMaintenanceOptions,
    ) => Promise<WorkspaceHistoryMaintenanceResult>,
  ) {
    super(options);
  }

  override async runMaintenance(
    options: WorkspaceHistoryMaintenanceOptions,
  ): Promise<WorkspaceHistoryMaintenanceResult> {
    return await this.maintain(options);
  }
}

function capturedWorkspace(call: number, workspaceId: string): WorkspaceHistoryCaptureResult {
  const rootTreeOid = call.toString(16).padStart(40, "0");
  return {
    status: "captured",
    workspaceId,
    rootTreeOid,
    workspaceTreeOid: rootTreeOid,
    manifestBlobOid: rootTreeOid,
    gitRef: `refs/mini-lilac/snapshots/${rootTreeOid}`,
    formatVersion: 1,
    managedPathCount: 0,
  };
}

async function privateGit(store: WorkspaceHistoryStore, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "--git-dir", store.storeDirectory, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Private Git command failed (${exitCode}): ${stderr}`);
  }
  return stdout.trim();
}

async function removeLoosePrivateObject(
  store: WorkspaceHistoryStore,
  rootTreeOid: string,
): Promise<void> {
  await rm(
    path.join(store.storeDirectory, "objects", rootTreeOid.slice(0, 2), rootTreeOid.slice(2)),
    { force: true },
  );
}

function config(): RuntimeConfig {
  return {
    configVersion: 1,
    server: { host: "127.0.0.1", port: 3000 },
    providerConfigFile: "providers.yaml",
    providerAuthFile: "auth.json",
    agent: {
      systemPrompt: "You are Mini Lilac.",
      defaultProfile: "reader",
      idleTimeoutMs: 900_000,
      compaction: { model: "inherit", earlyCompactionPoint: 0.8 },
      subagents: {
        enabled: true,
        maxDepth: 1,
      },
      profiles: {
        reader: {
          description: "Read-only main agent",
          promptOverlay: "Be concise.",
          subagentOnly: false,
          tools: ["read", "bash", "patch", "subagent_delegate"],
          execution: false,
          workspaceWrites: false,
          delegation: false,
        },
        delegate: {
          description: "Delegating main agent",
          subagentOnly: false,
          tools: ["subagent_delegate"],
          execution: false,
          workspaceWrites: false,
          delegation: true,
        },
        child: {
          description: "Child investigator",
          promptOverlay: "Investigate only.",
          subagentOnly: true,
          tools: ["subagent_delegate"],
          execution: false,
          workspaceWrites: false,
          delegation: true,
        },
      },
    },
  };
}

const IMMEDIATE_TRANSIENT_RETRY = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 0,
  maxDelayMs: 0,
} as const;

async function temporaryRuntime(model: LanguageModel, profile = "reader", initializeGit = false) {
  const directory = await (initializeGit ? mkdtemp : mkdtempFs)(
    path.join(tmpdir(), "mini-lilac-runtime-"),
  );
  temporaryDirectories.push(directory);
  const service = new SessionService({
    config: config(),
    databasePath: path.join(directory, "runtime.sqlite"),
    modelResolver: () => model,
  });
  const session = await service.createSession({
    cwd: directory,
    model: "test/mock",
    profile,
    reasoning: "high",
  });
  return { directory, service, session };
}

function delegatedRuns(service: SessionService, parentSessionId: string) {
  return service.store
    .listSessions()
    .filter((session) => session.id.startsWith(`sub:${parentSessionId}:named:`))
    .flatMap((session) => {
      const run =
        service.store.getActiveRootRun(session.id) ??
        service.store.getLatestSelectedRootRun(session.id);
      return run === null ? [] : [run];
    });
}

function loadedProviders(supersededProviderIds: readonly string[]): LoadedProviderRegistry {
  const providerConfig: ProviderConfig = {
    configVersion: 1,
    providers: {
      oauth: { type: "openai", catalog: "models-dev" },
      api: { type: "openai", catalog: "models-dev" },
      other: { type: "anthropic", catalog: "models-dev" },
    },
  };
  const auth: ProviderAuth = {
    api: { type: "api-key", key: "test-api-key" },
    other: { type: "api-key", key: "test-other-key" },
  };
  const superseded = new Set(supersededProviderIds);
  return {
    config: providerConfig,
    auth,
    registry: createAiProviderRegistry(providerConfig, auth, {
      supersededProviderIds: superseded,
      codexOAuthProvider: createOpenAI({ apiKey: "unused-test-key" }),
    }),
    supersededProviderIds,
  };
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

/** Drive a manual compaction to completion and return its lifecycle plus result. */
async function compact(
  service: SessionService,
  request: { sessionId: string; clientCommandId: string },
): Promise<{ events: MiniLilacCompactionEvent[]; result: MiniLilacCompactionEvent }> {
  const started = await service.compact(request);
  const events = (await collect(started.stream)).flatMap((chunk) =>
    chunk.type === "data-compaction" ? [chunk.data] : [],
  );
  const terminal = events.at(-1);
  if (terminal === undefined) throw new Error("Compaction produced no events");
  return { events, result: terminal };
}

export {
  describe,
  expect,
  it,
  spyOn,
  Database,
  chmod,
  copyFile,
  mkdir,
  mkdtempFs,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  tmpdir,
  path,
  createOpenAI,
  attachAutoCompaction,
  miniLilacUserUIMessageSchema,
  createToolResultArtifactStore,
  readUIMessageStream,
  MockLanguageModelV4,
  simulateReadableStream,
  getCodexAuthStoragePath,
  ModelCapability,
  Panic,
  Result,
  z,
  createAiProviderRegistry,
  MiniLilacSessionOperationRejected,
  SessionService,
  MiniLilacSkillCatalog,
  MiniLilacDatabaseVersionError,
  MiniLilacSqliteStore,
  MiniLilacStoreOperationRejected,
  WorkspaceHistoryStore,
  temporaryDirectories,
  mkdtemp,
  zeroUsage,
  textResult,
  textResultWithInputTokens,
  textResultWithOpenAIItemId,
  phasedOpenAITextResult,
  streamErrorResult,
  textAndReadToolResult,
  commentaryAndReadToolResult,
  webfetchToolResult,
  delegateResult,
  bashToolResult,
  textThenBashToolResult,
  grepToolResult,
  readToolResult,
  bashOutputDeltaTestSchema,
  batchedSkillResult,
  batchedReadResult,
  todoWriteResult,
  todoAndReadResult,
  userMessage,
  steeringMessage,
  seedCompletedHistory,
  seedOpenHistory,
  reserveRetainedHistoryOperation,
  ScriptedWorkspaceHistoryStore,
  InterceptedWorkspaceHistoryStore,
  MaintenanceProbeWorkspaceHistoryStore,
  capturedWorkspace,
  privateGit,
  removeLoosePrivateObject,
  config,
  IMMEDIATE_TRANSIENT_RETRY,
  temporaryRuntime,
  delegatedRuns,
  loadedProviders,
  collect,
  compact,
};

export type {
  AutoCompactionOptions,
  HistoryProviderState,
  MiniLilacCancelCompactionResult,
  MiniLilacCompactionEvent,
  MiniLilacTodo,
  MiniLilacTodoState,
  MiniLilacUIMessage,
  LanguageModel,
  ModelMessage,
  UIMessageChunk,
  RuntimeConfig,
  LoadedProviderRegistry,
  ProviderAuth,
  ProviderConfig,
  MiniLilacRuntimeChunk,
  SessionServiceOptions,
  LockedWorkspaceHistoryStore,
  WorkspaceHistoryCaptureResult,
  WorkspaceHistoryExpectedCurrent,
  WorkspaceHistoryMaintenanceOptions,
  WorkspaceHistoryMaintenanceResult,
  WorkspaceHistoryMetric,
  WorkspaceHistoryStoreOptions,
};
