import type { ExternalToolExecutionOutcome } from "@stanley2058/lilac-agent";
import { claudeCodeExecutableSettings } from "@stanley2058/lilac-utils";
import type { LanguageModel, ToolSet } from "ai";
import {
  createClaudeCode,
  getSessionInfo,
  type ClaudeCodeSettings,
  type MessageInjector,
  type SpawnedProcess,
  type SpawnOptions,
} from "ai-sdk-provider-claude-code";
import { spawn } from "node:child_process";
import { z } from "zod";

import {
  createClaudeCodeToolBridge,
  validateClaudeCodeBuiltInTools,
  type ClaudeCodeBuiltInTool,
  type ClaudeCodeToolCatalogMetadataMap,
  type ClaudeCodeToolExecutionRequest,
} from "./claude-code-tools";

const MAX_CALLBACK_ERROR_CHARS = 2_000;
const MAX_PROVIDER_WARNINGS = 32;
const MAX_PROVIDER_WARNING_CHARS = 1_000;
// Agent SDK cleanup waits 2s before SIGTERM and schedules SIGKILL 5s later.
// This outer bound leaves 3s for the OS exit event; expiry fails promotion closed.
const PROCESS_EXIT_PROOF_TIMEOUT_MS = 10_000;

const uuidSchema = z.uuid();
const nativeSessionStartSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("ephemeral") }).strict(),
  z.object({ mode: z.literal("fresh"), sessionId: uuidSchema }).strict(),
  z
    .object({
      mode: z.literal("fork"),
      baseSessionId: uuidSchema,
      sessionId: uuidSchema,
      expectedSourceLastModified: z.number().finite().nonnegative(),
    })
    .strict()
    .refine(({ baseSessionId, sessionId }) => baseSessionId !== sessionId, {
      message: "fork source and candidate session IDs must be distinct",
      path: ["sessionId"],
    }),
]);

const sdkMessageTypeSchema = z.object({ type: z.string() }).passthrough();
const sdkInitMessageSchema = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    session_id: z.string().min(1),
    model: z.string().min(1),
  })
  .passthrough();
const sdkSuccessResultMessageSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.literal("success"),
    session_id: z.string().min(1),
  })
  .passthrough();
const stopHookInputSchema = z.object({ hook_event_name: z.literal("Stop") }).passthrough();
const contextUsageSchema = z
  .object({
    totalTokens: z.number().int().nonnegative(),
    maxTokens: z.number().int().positive(),
  })
  .refine(({ totalTokens, maxTokens }) => totalTokens <= maxTokens, {
    message: "totalTokens must not exceed maxTokens",
  });
const sessionInfoSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  lastModified: z.number().finite().nonnegative(),
});

type CreateClaudeCodeModel = (modelId: string, settings: ClaudeCodeSettings) => LanguageModel;
type SpawnClaudeCodeProcess = NonNullable<ClaudeCodeSettings["spawnClaudeCodeProcess"]>;

type TrackedClaudeProcess = {
  readonly waitForExit: () => Promise<void>;
};

export type ClaudeNativeSessionStart =
  | {
      readonly mode: "ephemeral";
    }
  | {
      readonly mode: "fresh";
      readonly sessionId: string;
    }
  | {
      readonly mode: "fork";
      readonly baseSessionId: string;
      readonly sessionId: string;
      readonly expectedSourceLastModified: number;
    };

export type ClaudeNativeAttemptObservation = {
  readonly requestedSessionId: string | null;
  readonly sourceSessionId: string | null;
  readonly initSessionId: string | null;
  readonly resultSessionId: string | null;
  readonly contextTokens: number | null;
  readonly contextMaxTokens: number | null;
  readonly requestedModel: string;
  readonly initializedModel: string | null;
  readonly requestedReasoning: string | null;
  readonly providerWarnings: readonly string[];
  readonly invoked: boolean;
  readonly requiredObservabilityError: string | null;
  readonly callbackError: string | null;
};

export type ClaudeNativeSessionMetadata = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly lastModified: number;
};

export type ClaudeNativeSessionValidationIssue = {
  readonly code:
    | "source-preflight-read-failed"
    | "source-preflight-missing"
    | "source-preflight-invalid"
    | "source-preflight-id-mismatch"
    | "source-preflight-cwd-mismatch"
    | "source-preflight-last-modified-mismatch"
    | "init-session-id-missing"
    | "init-session-id-mismatch"
    | "init-session-id-conflict"
    | "result-session-id-missing"
    | "result-session-id-mismatch"
    | "result-session-id-conflict"
    | "context-usage-missing"
    | "candidate-read-failed"
    | "candidate-missing"
    | "candidate-invalid"
    | "candidate-id-mismatch"
    | "candidate-cwd-mismatch"
    | "source-final-read-failed"
    | "source-final-missing"
    | "source-final-invalid"
    | "source-final-id-mismatch"
    | "source-final-cwd-mismatch"
    | "source-last-modified-changed"
    | "required-observability-failed";
  readonly message: string;
};

type ClaudeNativeSessionFinalizationBase = {
  readonly observations: ClaudeNativeAttemptObservation;
  readonly candidate: ClaudeNativeSessionMetadata | null;
  readonly sourcePreflight: ClaudeNativeSessionMetadata | null;
  readonly sourceFinal: ClaudeNativeSessionMetadata | null;
};

export type ClaudeNativeSessionFinalization =
  | (ClaudeNativeSessionFinalizationBase & {
      readonly status: "promotable";
      readonly issues: readonly [];
    })
  | (ClaudeNativeSessionFinalizationBase & {
      readonly status: "unpromotable";
      readonly issues: readonly ClaudeNativeSessionValidationIssue[];
    });

export class ClaudeNativeSessionPreflightError extends Error {
  readonly issues: readonly ClaudeNativeSessionValidationIssue[];

  constructor(issues: readonly ClaudeNativeSessionValidationIssue[]) {
    super(
      `Claude native fork preflight requires a fresh start: ${issues
        .map(({ message }) => message)
        .join("; ")}`,
    );
    this.name = "ClaudeNativeSessionPreflightError";
    this.issues = issues;
  }
}

export type ClaudeNativeSessionLifecycle = {
  getObservation(): ClaudeNativeAttemptObservation;
  /**
   * Wait for currently scheduled native observability work without finalizing the session.
   * Init/result IDs and context usage are returned only when freshly observed since the previous wait.
   */
  waitForObservation(): Promise<ClaudeNativeAttemptObservation>;
  recordWarning(warning: string): void;
  finalize(): Promise<ClaudeNativeSessionFinalization>;
};

export type ClaudeCodeRunControl = {
  inject(message: string, onResult?: (delivered: boolean) => void): boolean;
  interrupt(): Promise<boolean>;
  clear(): void;
};

export type MaterializedClaudeCodeRun = {
  agentModel: LanguageModel;
  /** Internal in-place candidate continuation model for persistent attempts. */
  continuationModel?: LanguageModel;
  createUtilityModel(): LanguageModel;
  control: ClaudeCodeRunControl;
  /** Present on bridge-created runs; optional for existing injected run implementations. */
  nativeSession?: ClaudeNativeSessionLifecycle;
  dispose(): Promise<void>;
};

export type ClaudeNativeQueryController = {
  getContextUsage(): Promise<unknown>;
  interrupt(): Promise<void>;
  /** End the query and prove its tracked subprocess emitted `exit`. */
  settle(): Promise<void>;
};

export type ClaudeNativeSessionInfoReader = (
  sessionId: string,
  options: { dir: string },
) => Promise<unknown>;

type SessionReadResult =
  | { readonly status: "ok"; readonly metadata: ClaudeNativeSessionMetadata }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly error: string }
  | { readonly status: "failed"; readonly error: string };

function boundedText(value: unknown, maxChars: number): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function invokeAsync<T>(callback: () => T | PromiseLike<T>): Promise<T> {
  return Promise.resolve().then(callback);
}

function spawnLocalClaudeCodeProcess(options: SpawnOptions): SpawnedProcess {
  return spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
}

function waitForProcessExitProof(exit: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`Claude process exit was not observed within ${PROCESS_EXIT_PROOF_TIMEOUT_MS}ms`),
      );
    }, PROCESS_EXIT_PROOF_TIMEOUT_MS);
    timer.unref();
    exit.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function settleQueryAndProcess(input: {
  readonly settleQuery: () => Promise<void>;
  readonly process: TrackedClaudeProcess | undefined;
}): Promise<void> {
  const errors: unknown[] = [];
  try {
    await input.settleQuery();
  } catch (error) {
    errors.push(error);
  }
  if (input.process === undefined) {
    errors.push(new Error("Claude query has no tracked subprocess exit proof"));
  } else {
    try {
      await input.process.waitForExit();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Claude query settlement could not prove subprocess exit");
  }
}

function nativeSettings(
  start: ClaudeNativeSessionStart,
): Pick<ClaudeCodeSettings, "forkSession" | "persistSession" | "resume" | "sessionId"> {
  switch (start.mode) {
    case "ephemeral":
      return { persistSession: false };
    case "fresh":
      return { persistSession: true, sessionId: start.sessionId };
    case "fork":
      return {
        persistSession: true,
        resume: start.baseSessionId,
        forkSession: true,
        sessionId: start.sessionId,
      };
  }
}

async function readSessionInfo(
  reader: ClaudeNativeSessionInfoReader,
  sessionId: string,
  cwd: string,
): Promise<SessionReadResult> {
  let raw: unknown;
  try {
    raw = await reader(sessionId, { dir: cwd });
  } catch (error) {
    return { status: "failed", error: boundedText(error, MAX_CALLBACK_ERROR_CHARS) };
  }
  if (raw === undefined) return { status: "missing" };

  const parsed = sessionInfoSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "invalid",
      error: boundedText(z.prettifyError(parsed.error), MAX_CALLBACK_ERROR_CHARS),
    };
  }
  return { status: "ok", metadata: parsed.data };
}

function pushSessionReadIssue(
  issues: ClaudeNativeSessionValidationIssue[],
  scope: "candidate" | "source-preflight" | "source-final",
  read: Exclude<SessionReadResult, { status: "ok" }>,
): void {
  if (read.status === "failed") {
    issues.push({ code: `${scope}-read-failed`, message: `${scope} read failed: ${read.error}` });
  } else if (read.status === "invalid") {
    issues.push({
      code: `${scope}-invalid`,
      message: `${scope} metadata is invalid: ${read.error}`,
    });
  } else {
    issues.push({ code: `${scope}-missing`, message: `${scope} session is missing` });
  }
}

export async function materializeClaudeCodeRun(options: {
  modelId: string;
  cwd: string;
  tools: ToolSet;
  catalogMetadata?: ClaudeCodeToolCatalogMetadataMap;
  execute(request: ClaudeCodeToolExecutionRequest): Promise<ExternalToolExecutionOutcome>;
  /**
   * Claude built-in tools this run may call. Applied to the agent model only;
   * the utility model is always tool-free so a summarization prompt cannot
   * reach the network.
   */
  builtInTools?: readonly ClaudeCodeBuiltInTool[];
  nativeSession?: ClaudeNativeSessionStart;
  reasoning?: string;
  createModel?: CreateClaudeCodeModel;
  getSessionInfo?: ClaudeNativeSessionInfoReader;
  controller?: ClaudeNativeQueryController;
  spawnClaudeCodeProcess?: SpawnClaudeCodeProcess;
  waitForProcessExit?: (exit: Promise<void>) => Promise<void>;
  onSdkMessage?: (message: unknown) => void | PromiseLike<void>;
}): Promise<MaterializedClaudeCodeRun> {
  const start = nativeSessionStartSchema.parse(options.nativeSession ?? { mode: "ephemeral" });
  const readInfo: ClaudeNativeSessionInfoReader =
    options.getSessionInfo ?? ((sessionId, readOptions) => getSessionInfo(sessionId, readOptions));
  const preflightIssues: ClaudeNativeSessionValidationIssue[] = [];
  let sourcePreflight: ClaudeNativeSessionMetadata | null = null;

  if (start.mode === "fork") {
    const read = await readSessionInfo(readInfo, start.baseSessionId, options.cwd);
    if (read.status !== "ok") {
      pushSessionReadIssue(preflightIssues, "source-preflight", read);
    } else {
      sourcePreflight = read.metadata;
      if (read.metadata.sessionId !== start.baseSessionId) {
        preflightIssues.push({
          code: "source-preflight-id-mismatch",
          message: `source preflight ID '${read.metadata.sessionId}' does not match '${start.baseSessionId}'`,
        });
      }
      if (read.metadata.cwd !== options.cwd) {
        preflightIssues.push({
          code: "source-preflight-cwd-mismatch",
          message: `source preflight cwd '${read.metadata.cwd}' does not match '${options.cwd}'`,
        });
      }
      if (read.metadata.lastModified !== start.expectedSourceLastModified) {
        preflightIssues.push({
          code: "source-preflight-last-modified-mismatch",
          message: `source preflight lastModified ${read.metadata.lastModified} does not match promoted snapshot ${start.expectedSourceLastModified}`,
        });
      }
    }
    if (preflightIssues.length > 0) throw new ClaudeNativeSessionPreflightError(preflightIssues);
  }

  // Validated here as well as in the bridge, because this array also reaches
  // the Agent SDK's own built-in allowlist.
  const builtInTools = [
    ...new Set([...validateClaudeCodeBuiltInTools(options.builtInTools), "ToolSearch" as const]),
  ];
  const bridge = await createClaudeCodeToolBridge({
    tools: options.tools,
    catalogMetadata: options.catalogMetadata,
    execute: options.execute,
    builtInTools,
  });
  const createModel =
    options.createModel ??
    createClaudeCode({
      defaultSettings: {
        tools: [],
        settingSources: [],
        persistSession: false,
      },
    });
  const executable = claudeCodeExecutableSettings();
  const requestedSessionId = start.mode === "ephemeral" ? null : start.sessionId;
  const sourceSessionId = start.mode === "fork" ? start.baseSessionId : null;
  const providerWarnings: string[] = [];
  const initSessionIds = new Set<string>();
  const resultSessionIds = new Set<string>();
  const pendingObservabilityCallbacks = new Set<Promise<void>>();
  const injectors = new Set<MessageInjector>();
  const queryControllers = new Set<ClaudeNativeQueryController>();
  const settledQueryControllers = new Set<ClaudeNativeQueryController>();
  const trackedProcesses: TrackedClaudeProcess[] = [];
  const unclaimedProcesses: TrackedClaudeProcess[] = [];
  let injector: MessageInjector | null = null;
  let controller: ClaudeNativeQueryController | null = options.controller ?? null;
  if (controller) queryControllers.add(controller);
  let initSessionId: string | null = null;
  let resultSessionId: string | null = null;
  let latestInitSessionId: string | null = null;
  let latestResultSessionId: string | null = null;
  let initializedModel: string | null = null;
  let contextTokens: number | null = null;
  let contextMaxTokens: number | null = null;
  let callbackError: string | null = null;
  let requiredObservabilityError: string | null = null;
  let contextCaptureSequence = 0;
  let successfulContextCaptureSequence = 0;
  let deliveredContextCaptureSequence = 0;
  let initObservationSequence = 0;
  let deliveredInitObservationSequence = 0;
  let resultObservationSequence = 0;
  let deliveredResultObservationSequence = 0;
  let pendingContextCapture: Promise<void> | null = null;
  let invoked = controller !== null;
  let disposed = false;
  let acceptingProcesses = true;
  let disposalPromise: Promise<void> | null = null;
  let finalizationPromise: Promise<ClaudeNativeSessionFinalization> | null = null;

  const recordCallbackError = (error: unknown, required = false) => {
    const next = boundedText(error, MAX_CALLBACK_ERROR_CHARS);
    if (required) {
      requiredObservabilityError = boundedText(
        requiredObservabilityError ? `${requiredObservabilityError}; ${next}` : next,
        MAX_CALLBACK_ERROR_CHARS,
      );
    }
    callbackError = boundedText(
      callbackError ? `${callbackError}; ${next}` : next,
      MAX_CALLBACK_ERROR_CHARS,
    );
  };

  const recordWarning = (warning: string) => {
    if (providerWarnings.length >= MAX_PROVIDER_WARNINGS) return;
    providerWarnings.push(boundedText(warning, MAX_PROVIDER_WARNING_CHARS));
  };

  const getObservation = (): ClaudeNativeAttemptObservation => ({
    requestedSessionId,
    sourceSessionId,
    initSessionId,
    resultSessionId,
    contextTokens,
    contextMaxTokens,
    requestedModel: options.modelId,
    initializedModel,
    requestedReasoning: options.reasoning ?? null,
    providerWarnings: [...providerWarnings],
    invoked,
    requiredObservabilityError,
    callbackError,
  });

  const beginContextCapture = () => {
    const liveController = controller;
    if (!liveController) {
      recordCallbackError("Stop hook ran without a live query controller", true);
      return;
    }

    const sequence = ++contextCaptureSequence;
    let requestedUsage: Promise<unknown>;
    try {
      requestedUsage = liveController.getContextUsage();
    } catch (error) {
      recordCallbackError(error, true);
      return;
    }
    const capture = requestedUsage
      .then((raw) => {
        const parsed = contextUsageSchema.safeParse(raw);
        if (!parsed.success) {
          recordCallbackError(`Invalid context usage: ${z.prettifyError(parsed.error)}`, true);
          return;
        }
        if (sequence >= successfulContextCaptureSequence) {
          successfulContextCaptureSequence = sequence;
          contextTokens = parsed.data.totalTokens;
          contextMaxTokens = parsed.data.maxTokens;
        }
      })
      .catch((error: unknown) => recordCallbackError(error, true));
    pendingContextCapture = capture;
  };

  const observeSdkMessage = (message: unknown) => {
    try {
      const envelope = sdkMessageTypeSchema.safeParse(message);
      if (!envelope.success) {
        recordCallbackError(`Invalid SDK message: ${z.prettifyError(envelope.error)}`, true);
      } else if (envelope.data.type === "system" && envelope.data["subtype"] === "init") {
        const parsed = sdkInitMessageSchema.safeParse(message);
        if (!parsed.success) {
          recordCallbackError(`Invalid SDK init message: ${z.prettifyError(parsed.error)}`, true);
        } else {
          initSessionIds.add(parsed.data.session_id);
          initSessionId ??= parsed.data.session_id;
          latestInitSessionId = parsed.data.session_id;
          initObservationSequence += 1;
          initializedModel ??= parsed.data.model;
          if (initSessionIds.size > 1) {
            recordCallbackError(
              `SDK init emitted conflicting session IDs: ${[...initSessionIds].join(", ")}`,
              true,
            );
          }
        }
      } else if (envelope.data.type === "result" && envelope.data["subtype"] === "success") {
        const parsed = sdkSuccessResultMessageSchema.safeParse(message);
        if (!parsed.success) {
          recordCallbackError(`Invalid SDK result message: ${z.prettifyError(parsed.error)}`, true);
        } else {
          resultSessionIds.add(parsed.data.session_id);
          resultSessionId ??= parsed.data.session_id;
          latestResultSessionId = parsed.data.session_id;
          resultObservationSequence += 1;
          if (resultSessionIds.size > 1) {
            recordCallbackError(
              `SDK result emitted conflicting session IDs: ${[...resultSessionIds].join(", ")}`,
              true,
            );
          }
        }
      }
    } catch (error) {
      recordCallbackError(error, true);
    }

    if (options.onSdkMessage) {
      try {
        const pending = Promise.resolve(options.onSdkMessage(message))
          .catch(recordCallbackError)
          .finally(() => pendingObservabilityCallbacks.delete(pending));
        pendingObservabilityCallbacks.add(pending);
      } catch (error) {
        recordCallbackError(error);
      }
    }
  };

  const stopHook = async (...args: unknown[]): Promise<unknown> => {
    try {
      const parsed = stopHookInputSchema.safeParse(args[0]);
      if (!parsed.success) {
        recordCallbackError(`Invalid Stop hook input: ${z.prettifyError(parsed.error)}`, true);
        return {};
      }
      beginContextCapture();
    } catch (error) {
      recordCallbackError(error, true);
    }
    return {};
  };

  const waitForObservability = async () => {
    const capture = pendingContextCapture;
    if (capture) await capture;
    if (pendingObservabilityCallbacks.size > 0) {
      await Promise.all(pendingObservabilityCallbacks);
    }
  };

  const waitForObservation = async (): Promise<ClaudeNativeAttemptObservation> => {
    await waitForObservability();
    const observation = getObservation();
    const hasNewTerminalUsage =
      contextCaptureSequence > deliveredContextCaptureSequence &&
      successfulContextCaptureSequence === contextCaptureSequence;
    const hasNewInit = initObservationSequence > deliveredInitObservationSequence;
    const hasNewResult = resultObservationSequence > deliveredResultObservationSequence;
    deliveredContextCaptureSequence = contextCaptureSequence;
    deliveredInitObservationSequence = initObservationSequence;
    deliveredResultObservationSequence = resultObservationSequence;
    return {
      ...observation,
      initSessionId: hasNewInit ? latestInitSessionId : null,
      resultSessionId: hasNewResult ? latestResultSessionId : null,
      contextTokens: hasNewTerminalUsage ? observation.contextTokens : null,
      contextMaxTokens: hasNewTerminalUsage ? observation.contextMaxTokens : null,
    };
  };

  const spawnTrackedProcess: SpawnClaudeCodeProcess = (spawnOptions) => {
    if (!acceptingProcesses) {
      throw new Error("Cannot spawn a Claude process after run disposal started");
    }
    const spawned = (options.spawnClaudeCodeProcess ?? spawnLocalClaudeCodeProcess)(spawnOptions);
    const exited = Promise.withResolvers<void>();
    const process = {
      waitForExit: (() => {
        let proof: Promise<void> | null = null;
        return () => {
          proof ??= invokeAsync(() =>
            (options.waitForProcessExit ?? waitForProcessExitProof)(exited.promise),
          );
          return proof;
        };
      })(),
    } satisfies TrackedClaudeProcess;
    spawned.once("exit", () => exited.resolve());
    if (spawned.exitCode !== null) exited.resolve();
    trackedProcesses.push(process);
    unclaimedProcesses.push(process);
    return spawned;
  };

  const drainQueryControllers = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (;;) {
      const batch = [...queryControllers].filter(
        (queryController) => !settledQueryControllers.has(queryController),
      );
      if (batch.length === 0) break;
      batch.forEach((queryController) => settledQueryControllers.add(queryController));
      const settlements = await Promise.allSettled(
        batch.map((queryController) => invokeAsync(() => queryController.settle())),
      );
      for (const settlement of settlements) {
        if (settlement.status === "rejected") errors.push(settlement.reason);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more Claude queries failed to settle");
    }
  };

  const control: ClaudeCodeRunControl = {
    inject(message, onResult) {
      if (disposed || !injector) return false;
      injector.inject(message, onResult);
      return true;
    },
    async interrupt() {
      if (disposed) return false;
      bridge.clear();
      if (!controller) return false;
      try {
        await controller.interrupt();
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      const errors: unknown[] = [];
      for (const activeInjector of injectors) {
        try {
          activeInjector.close();
        } catch (error) {
          errors.push(error);
        }
      }
      injectors.clear();
      injector = null;
      controller = null;
      try {
        bridge.clear();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Claude run controls could not be cleared cleanly");
      }
    },
  };

  const dispose = (): Promise<void> => {
    if (disposalPromise) return disposalPromise;
    disposed = true;
    acceptingProcesses = false;
    disposalPromise = (async () => {
      const errors: unknown[] = [];
      const collectQueryDrain = async () => {
        try {
          await drainQueryControllers();
        } catch (error) {
          errors.push(error);
        }
      };
      const collectExitProofs = async () => {
        const exitProofs = await Promise.allSettled(
          trackedProcesses.map((process) => invokeAsync(() => process.waitForExit())),
        );
        for (const exitProof of exitProofs) {
          if (exitProof.status === "rejected") errors.push(exitProof.reason);
        }
      };
      try {
        await waitForObservability();
      } catch (error) {
        errors.push(error);
      }
      try {
        control.clear();
      } catch (error) {
        errors.push(error);
      }
      // The spawn gate is now closed. Re-drain after every awaited phase so a
      // controller registered by an already-spawned query joins this disposal.
      await collectQueryDrain();
      await collectExitProofs();
      await collectQueryDrain();
      try {
        await bridge.close();
      } catch (error) {
        errors.push(error);
      }
      await collectQueryDrain();
      if (unclaimedProcesses.length > 0) {
        errors.push(
          new Error(
            `${unclaimedProcesses.length} Claude subprocess(es) exited without query-controller registration`,
          ),
        );
      }
      queryControllers.clear();
      if (errors.length > 0) {
        throw new AggregateError(errors, "Claude run disposal could not prove clean settlement");
      }
    })();
    return disposalPromise;
  };

  const finalize = (): Promise<ClaudeNativeSessionFinalization> => {
    if (start.mode === "ephemeral") {
      throw new Error("Cannot finalize an ephemeral Claude native session");
    }
    if (finalizationPromise) return finalizationPromise;

    finalizationPromise = (async () => {
      const issues = [...preflightIssues];
      let candidate: ClaudeNativeSessionMetadata | null = null;
      let sourceFinal: ClaudeNativeSessionMetadata | null = null;

      try {
        await waitForObservability();

        if (!initSessionId) {
          issues.push({
            code: "init-session-id-missing",
            message: "SDK init session ID is missing",
          });
        } else if (initSessionId !== start.sessionId) {
          issues.push({
            code: "init-session-id-mismatch",
            message: `SDK init session ID '${initSessionId}' does not match '${start.sessionId}'`,
          });
        }
        if (initSessionIds.size > 1) {
          issues.push({
            code: "init-session-id-conflict",
            message: `SDK init emitted conflicting session IDs: ${[...initSessionIds].join(", ")}`,
          });
        }

        if (!resultSessionId) {
          issues.push({
            code: "result-session-id-missing",
            message: "successful SDK result session ID is missing",
          });
        } else if (resultSessionId !== start.sessionId) {
          issues.push({
            code: "result-session-id-mismatch",
            message: `SDK result session ID '${resultSessionId}' does not match '${start.sessionId}'`,
          });
        }
        if (resultSessionIds.size > 1) {
          issues.push({
            code: "result-session-id-conflict",
            message: `SDK result emitted conflicting session IDs: ${[...resultSessionIds].join(", ")}`,
          });
        }

        if (
          contextTokens === null ||
          contextMaxTokens === null ||
          successfulContextCaptureSequence !== contextCaptureSequence
        ) {
          issues.push({
            code: "context-usage-missing",
            message: "terminal native context usage is missing",
          });
        }
        if (requiredObservabilityError !== null) {
          issues.push({
            code: "required-observability-failed",
            message: requiredObservabilityError,
          });
        }

        // The provider closes its AI SDK output stream at the result message while
        // Agent SDK query cleanup may still append to the persisted transcript.
        // Disposal combines Query.return() with the tracked child's actual exit.
        await dispose();

        const reads = await Promise.all([
          readSessionInfo(readInfo, start.sessionId, options.cwd),
          start.mode === "fork"
            ? readSessionInfo(readInfo, start.baseSessionId, options.cwd)
            : Promise.resolve<SessionReadResult>({ status: "missing" }),
        ]);
        const candidateRead = reads[0];
        if (candidateRead.status !== "ok") {
          pushSessionReadIssue(issues, "candidate", candidateRead);
        } else {
          candidate = candidateRead.metadata;
          if (candidate.sessionId !== start.sessionId) {
            issues.push({
              code: "candidate-id-mismatch",
              message: `candidate ID '${candidate.sessionId}' does not match '${start.sessionId}'`,
            });
          }
          if (candidate.cwd !== options.cwd) {
            issues.push({
              code: "candidate-cwd-mismatch",
              message: `candidate cwd '${candidate.cwd}' does not match '${options.cwd}'`,
            });
          }
        }

        if (start.mode === "fork") {
          const sourceRead = reads[1];
          if (sourceRead.status !== "ok") {
            pushSessionReadIssue(issues, "source-final", sourceRead);
          } else {
            sourceFinal = sourceRead.metadata;
            if (sourceFinal.sessionId !== start.baseSessionId) {
              issues.push({
                code: "source-final-id-mismatch",
                message: `source final ID '${sourceFinal.sessionId}' does not match '${start.baseSessionId}'`,
              });
            }
            if (sourceFinal.cwd !== options.cwd) {
              issues.push({
                code: "source-final-cwd-mismatch",
                message: `source final cwd '${sourceFinal.cwd}' does not match '${options.cwd}'`,
              });
            }
            if (sourcePreflight && sourceFinal.lastModified !== sourcePreflight.lastModified) {
              issues.push({
                code: "source-last-modified-changed",
                message: `source lastModified changed from ${sourcePreflight.lastModified} to ${sourceFinal.lastModified}`,
              });
            }
          }
        }

        const base = {
          observations: getObservation(),
          candidate,
          sourcePreflight,
          sourceFinal,
        } satisfies ClaudeNativeSessionFinalizationBase;
        return issues.length === 0
          ? { ...base, status: "promotable", issues: [] }
          : { ...base, status: "unpromotable", issues };
      } finally {
        await dispose();
      }
    })();
    return finalizationPromise;
  };

  try {
    const sharedAgentSettings = {
      ...executable,
      cwd: options.cwd,
      env: { ENABLE_TOOL_SEARCH: "true" },
      tools: builtInTools,
      settingSources: [],
      mcpServers: bridge.mcpServers,
      canUseTool: bridge.canUseTool,
      spawnClaudeCodeProcess: spawnTrackedProcess,
      streamingInput: "always",
      hooks: { Stop: [{ hooks: [stopHook] }] },
      onSdkMessage: observeSdkMessage,
      onStreamStart: (nextInjector) => {
        invoked = true;
        if (disposed) {
          nextInjector.close();
          return;
        }
        injectors.add(nextInjector);
        injector = nextInjector;
      },
      onQueryControllerCreated: (nextController) => {
        invoked = true;
        const process = unclaimedProcesses.shift();
        let settlement: Promise<void> | null = null;
        const queryController: ClaudeNativeQueryController = {
          getContextUsage: () => nextController.getContextUsage(),
          interrupt: () => nextController.interrupt(),
          settle: () => {
            settlement ??= settleQueryAndProcess({
              settleQuery: () => nextController.rawQuery.return(undefined).then(() => undefined),
              process,
            });
            return settlement;
          },
        };
        queryControllers.add(queryController);
        if (!disposed) controller = queryController;
      },
    } satisfies ClaudeCodeSettings;
    const agentModel = createModel(options.modelId, {
      ...sharedAgentSettings,
      ...nativeSettings(start),
    });
    const continuationModel =
      start.mode === "ephemeral"
        ? undefined
        : createModel(options.modelId, {
            ...sharedAgentSettings,
            persistSession: true,
            resume: start.sessionId,
          });
    const createUtilityModel = () =>
      createModel(options.modelId, {
        ...executable,
        cwd: options.cwd,
        tools: [],
        settingSources: [],
        persistSession: false,
      });
    return {
      agentModel,
      ...(continuationModel ? { continuationModel } : {}),
      createUtilityModel,
      control,
      nativeSession: { getObservation, waitForObservation, recordWarning, finalize },
      dispose,
    };
  } catch (error) {
    disposed = true;
    control.clear();
    await bridge.close().catch(() => undefined);
    throw error;
  }
}
