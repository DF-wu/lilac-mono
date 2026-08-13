import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import {
  subagentDelegateBaseInputSchema,
  subagentDelegateOutputSchema,
  subagentTerminalStatusSchema,
  type SubagentDelegateOutput,
  type SubagentMode,
  type SubagentProfile,
} from "@stanley2058/lilac-coding-tools/schemas";
import {
  createLogger,
  formatTaggedErrorForLog,
  opaqueErrorMessage,
  MODEL_REASONING_EFFORTS,
  type ModelReasoningEffort,
} from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { projectRuntimeError } from "../runtime/error-format";
import { getBuiltinSurfaceProtocol } from "../surface/builtin-surface-protocols";
import type { SurfaceProtocolRouting } from "../surface/protocol";
import type {
  AuthenticatedSurfaceOrigin,
  AuthenticatedSurfaceOriginFor,
  RegisteredSurfacePlatform,
  SurfacePrincipal,
} from "../surface/types";
import { adaptToolResultToHost, preserveToolPanic } from "./tool-result-adapters";

const modelReasoningEffortSchema = z.enum(MODEL_REASONING_EFFORTS);

type AgentSelectableModelPreset = {
  model: string;
  reasoning?: ModelReasoningEffort;
  comment?: string;
  agentCanSelect?: boolean;
};

type SubagentDelegateInput = z.input<typeof subagentDelegateBaseInputSchema> & {
  model?: string;
  reasoning?: ModelReasoningEffort;
};

type ParsedSubagentDelegateInput = z.output<typeof subagentDelegateBaseInputSchema> & {
  model?: string;
  reasoning?: ModelReasoningEffort;
};

function isSelectableModelPreset(entry: readonly [string, AgentSelectableModelPreset]): boolean {
  const [alias, preset] = entry;
  return preset.agentCanSelect === true && !alias.includes("/") && /^[^/]+\/.+/u.test(preset.model);
}

function createSubagentDelegateInputSchema(
  selectableModels: ReadonlyArray<readonly [string, AgentSelectableModelPreset]>,
): z.ZodType<ParsedSubagentDelegateInput> {
  const documentedModels = selectableModels.slice(0, 5).map(([alias, preset]) => {
    const detail = preset.comment?.trim()
      ? truncateEnd(normalizeToolDisplay(preset.comment), 240)
      : `${preset.model}${preset.reasoning ? `; default reasoning: ${preset.reasoning}` : ""}`;
    return `- ${alias}: ${detail}`;
  });
  let configuredAliasDescription =
    "No agent-selectable model aliases are configured; omit this field.";
  if (selectableModels.length > 0) {
    const qualifier =
      selectableModels.length > 5 ? " (first 5 documented; all aliases are in the enum)" : "";
    configuredAliasDescription = `Configured aliases${qualifier}:\n${documentedModels.join("\n")}`;
  }
  const modelDescription = [
    "Optional agent-selectable alias from models.def. Direct provider/model values are not accepted.",
    configuredAliasDescription,
  ].join("\n");

  if (selectableModels.length === 0) {
    return subagentDelegateBaseInputSchema;
  }

  const [firstAlias, ...remainingAliases] = selectableModels.map(([alias]) => alias);
  return subagentDelegateBaseInputSchema.extend({
    model: z
      .enum([firstAlias!, ...remainingAliases])
      .optional()
      .describe(modelDescription),
    reasoning: modelReasoningEffortSchema
      .optional()
      .describe(
        "Optional reasoning-effort override for this child run. When omitted, the selected alias or profile default applies.",
      ),
  });
}

type SubagentTerminalStatus = z.infer<typeof subagentTerminalStatusSchema>;
export type { SubagentDelegateOutput, SubagentMode, SubagentProfile };

type ChildToolStatus = "running" | "done";

export type ChildToolState = {
  toolCallId: string;
  status: ChildToolStatus;
  ok: boolean | null;
  display: string;
  updatedSeq: number;
};

type RequestContextLike = {
  requestId: string;
  sessionId: string;
  requestClient: string;
  subagentDepth?: number | string;
  subagentProfile?: string;
  requestInitiator?: SurfacePrincipal;
  requestInitiatorSessionId?: string;
};

type CurrentRunProfile = SubagentProfile | "primary";

const requestContextSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  requestClient: z.string(),
  subagentDepth: z.union([z.number(), z.string()]).optional(),
  subagentProfile: z.string().optional(),
  requestInitiator: z
    .object({ platform: z.string().trim().min(1), userId: z.string().trim().min(1) })
    .optional(),
  requestInitiatorSessionId: z.string().trim().min(1).optional(),
});

class SubagentDelegationError extends TaggedError("SubagentDelegationError")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

function signalSubagentFailure(operation: string, message: string): never {
  return adaptToolResultToHost(
    Result.err(new SubagentDelegationError({ operation, cause: new Error(message), message })),
  );
}

async function captureSubagentOperation<T>(params: {
  readonly operation: string;
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, SubagentDelegationError>> {
  const captured = await Result.tryPromise({
    try: params.run,
    catch: projectRuntimeError(`Opaque subagent ${params.operation} failure`),
  });
  if (captured.status === "error") {
    const cause = preserveToolPanic(captured.error);
    return Result.err(
      new SubagentDelegationError({
        operation: params.operation,
        cause,
        message: opaqueErrorMessage(cause, `Subagent ${params.operation} failed`),
      }),
    );
  }
  return Result.ok(captured.value);
}

function decodeRequestContext(
  context: unknown,
): ResultType<RequestContextLike, SubagentDelegationError> {
  const decoded = requestContextSchema.safeParse(context);
  if (decoded.success) {
    const initiator = decoded.data.requestInitiator;
    const { requestInitiator: _, ...common } = decoded.data;
    if (!initiator) return Result.ok(common);
    const protocol = getBuiltinSurfaceProtocol(initiator.platform);
    if (protocol) {
      return Result.ok({
        ...common,
        requestInitiator: {
          platform: protocol.platform,
          userId: initiator.userId,
        },
      });
    }
  }
  return Result.err(
    new SubagentDelegationError({
      operation: "decode_context",
      cause: decoded.error,
      message: "subagent_delegate requires request context",
    }),
  );
}

function createAuthenticatedSurfaceOrigin<P extends RegisteredSurfacePlatform>(
  protocol: SurfaceProtocolRouting<P>,
  userId: string,
  sessionId: string,
): AuthenticatedSurfaceOriginFor<P> {
  return {
    platform: protocol.platform,
    userId,
    sessionRef: protocol.refs.createSessionRef(sessionId),
  };
}

function parseDepth(ctx: RequestContextLike): number {
  const raw = ctx.subagentDepth;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.trunc(raw));
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed));
    }
  }
  return 0;
}

function parseCurrentRunProfile(ctx: RequestContextLike): CurrentRunProfile {
  const raw = ctx.subagentProfile;
  if (raw === "primary") return "primary";
  if (raw === "explore" || raw === "general" || raw === "self") return raw;
  return "primary";
}

function toAdapterPlatform(value: string): AdapterPlatform {
  switch (value) {
    case "discord":
    case "github":
    case "whatsapp":
    case "slack":
    case "telegram":
    case "web":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function generateSessionName(profile: SubagentProfile): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${profile}-${token}`;
}

function truncateEnd(input: string, maxLen: number): string {
  if (input.length <= maxLen) return input;
  if (maxLen <= 3) return "...".slice(0, maxLen);
  return input.slice(0, maxLen - 3) + "...";
}

function normalizeToolDisplay(display: string): string {
  return display
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function childToolIcon(state: ChildToolState): string {
  if (state.status === "running") return ">";
  if (state.ok) return "+";
  return "x";
}

export function renderSubagentDisplay(params: {
  profile: SubagentProfile;
  children: ReadonlyMap<string, ChildToolState>;
  model?: string;
  reasoning?: ModelReasoningEffort;
}): string {
  const children = Array.from(params.children.values());
  const total = children.length;
  const done = children.filter((c) => c.status === "done").length;
  let model: string | null = null;
  if (params.model) {
    model = params.reasoning ? `${params.model} [${params.reasoning}]` : params.model;
  }
  const header = `subagent (${[params.profile, model, `${done}/${total} done`]
    .filter((part): part is string => part !== null)
    .join("; ")})`;

  if (children.length === 0) return header;

  const recent = children
    .filter((c) => c.updatedSeq > 0)
    .sort((a, b) => b.updatedSeq - a.updatedSeq)
    .slice(0, 3)
    .sort((a, b) => a.updatedSeq - b.updatedSeq);

  if (recent.length === 0) return header;

  const lines = recent.map((c, idx) => {
    const branch = idx === recent.length - 1 ? "`-" : "|-";
    const display = normalizeToolDisplay(c.display || "tool");
    return `${branch} ${childToolIcon(c)} ${truncateEnd(display, 120)}`;
  });

  return [header, ...lines].join("\n");
}

function buildDelegatedTaskPrompt(task: string): ModelMessage {
  return {
    role: "user",
    content: task,
  };
}

export type SubagentDelegationRegistration = {
  mode: SubagentMode;
  profile: SubagentProfile;
  sessionName: string;
  stableNamedContinuation: true;
  task: string;
  idleTimeoutMs: number;
  depth: number;
  parentRequestId: string;
  parentSessionId: string;
  parentRequestClient: string;
  parentToolCallId: string;
  childRequestId: string;
  childSessionId: string;
  parentHeaders: {
    request_id: string;
    session_id: string;
    request_client: AdapterPlatform;
  };
  childHeaders: {
    request_id: string;
    session_id: string;
    request_client: "unknown";
    parent_request_id: string;
    parent_tool_call_id: string;
    subagent_profile: SubagentProfile;
    subagent_depth: string;
  };
  initialMessages: ModelMessage[];
  modelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
  authenticatedOrigin?: AuthenticatedSurfaceOrigin;
};

export type TrustedSubagentDelegationRegistration = SubagentDelegationRegistration & {
  projectRoot: string;
  fallbackSurface: {
    platform: SurfacePrincipal["platform"];
    sessionId: string;
    userId: string;
  };
};

export type SubagentDelegationOutcome = {
  status: SubagentTerminalStatus;
  finalText: string;
  detail?: string;
};

export type SubagentDelegationHandle = {
  runId: string;
  completion: Promise<SubagentDelegationOutcome>;
  cancel(detail: string): Promise<void>;
};

export function subagentTools(params: {
  idleTimeoutMs: number;
  maxDepth: number;
  modelPresets?: Readonly<Record<string, AgentSelectableModelPreset>>;
  delegatePromptOverlay?: string;
  onDelegate?: (registration: SubagentDelegationRegistration) => Promise<SubagentDelegationHandle>;
}) {
  const selectableModels = Object.entries(params.modelPresets ?? {}).filter(
    isSelectableModelPreset,
  );
  const selectableModelAliases = new Set(selectableModels.map(([alias]) => alias));
  const inputSchema = createSubagentDelegateInputSchema(selectableModels);
  const description = [
    "Delegate a task to an explore, general, or self subagent.",
    "Use deferred mode by default.",
    "Use sync mode only when you need the result before the next useful action.",
    "Deferred acceptance means that the subagent started. It does not mean that the task is complete.",
    "After a deferred launch, do all work that does not need the subagent result.",
    "When no such work remains, reply with exactly NO_REPLY and end the turn.",
    "Do not call tools only to wait or check the subagent status.",
    "The runtime keeps the request open. It resumes you when a subagent_result arrives.",
    "Wait for all deferred results before you send the final response to the user.",
    "Use all relevant subagent results in the final response.",
    params.delegatePromptOverlay?.trim(),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
  const logger = createLogger({
    module: "tool:subagent_delegate",
  });

  return {
    subagent_delegate: tool({
      description,
      inputSchema,
      outputSchema: subagentDelegateOutputSchema,
      execute: async (input: SubagentDelegateInput, { abortSignal, context, toolCallId }) => {
        const requestedModel = input.model;
        if (requestedModel !== undefined && !selectableModelAliases.has(requestedModel)) {
          signalSubagentFailure(
            "validate_input",
            `Model alias '${requestedModel}' is not available for agent selection`,
          );
        }
        if (input.reasoning !== undefined && selectableModels.length === 0) {
          signalSubagentFailure(
            "validate_input",
            "Reasoning override requires an agent-selectable model alias",
          );
        }
        const decodedInput = inputSchema.safeParse(input);
        if (!decodedInput.success) {
          signalSubagentFailure("decode_input", decodedInput.error.message);
        }
        const parsed = decodedInput.data;
        const decodedContext = decodeRequestContext(context);
        const ctx = adaptToolResultToHost(decodedContext);
        const profile = parsed.profile;
        const mode = parsed.mode;
        const depth = parseDepth(ctx);

        const currentRunProfile = parseCurrentRunProfile(ctx);
        if (currentRunProfile === "explore" || currentRunProfile === "general") {
          signalSubagentFailure(
            "authorize_delegation",
            `subagent_delegate is disabled in ${currentRunProfile} subagent runs`,
          );
        }

        if (currentRunProfile === "self" && profile === "self") {
          signalSubagentFailure(
            "authorize_delegation",
            "self subagent cannot delegate to self profile",
          );
        }

        if (depth >= params.maxDepth) {
          signalSubagentFailure(
            "authorize_delegation",
            "subagent_delegate is disabled in subagent runs (depth limit reached)",
          );
        }

        const idleTimeoutMs = params.idleTimeoutMs;
        const sessionName = parsed.sessionName ?? generateSessionName(profile);
        const stableNamedContinuation = true as const;
        const childRequestId = `sub:${ctx.requestId}:${crypto.randomUUID()}`;
        const childSessionId = `sub:${ctx.sessionId}:named:${sessionName}`;

        const childHeaders = {
          request_id: childRequestId,
          session_id: childSessionId,
          request_client: "unknown" as const,
          parent_request_id: ctx.requestId,
          parent_tool_call_id: toolCallId,
          subagent_profile: profile,
          subagent_depth: String(depth + 1),
        };

        const parentHeaders = {
          request_id: ctx.requestId,
          session_id: ctx.sessionId,
          request_client: toAdapterPlatform(ctx.requestClient),
        };
        let authenticatedOrigin: AuthenticatedSurfaceOrigin | undefined;
        if (ctx.requestInitiator && ctx.requestInitiatorSessionId) {
          const protocol = getBuiltinSurfaceProtocol(ctx.requestInitiator.platform);
          authenticatedOrigin = createAuthenticatedSurfaceOrigin(
            protocol,
            ctx.requestInitiator.userId,
            ctx.requestInitiatorSessionId,
          );
        }
        logger.info("subagent delegate start", {
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          parentToolCallId: toolCallId,
          mode,
          profile,
          parentDepth: depth,
          childDepth: depth + 1,
          sessionName,
          stableNamedContinuation,
          idleTimeoutMs,
          task: truncateEnd(parsed.task.replace(/\s+/g, " ").trim(), 240),
          modelOverride: parsed.model,
          reasoningOverride: parsed.reasoning,
        });

        const onDelegate = params.onDelegate;
        if (!onDelegate) {
          signalSubagentFailure(
            "start_delegation",
            "subagent delegation is unavailable in this runtime",
          );
        }

        const started = await captureSubagentOperation({
          operation: "start_delegation",
          run: () =>
            onDelegate({
              mode,
              profile,
              sessionName,
              stableNamedContinuation,
              task: parsed.task,
              idleTimeoutMs,
              depth: depth + 1,
              parentRequestId: ctx.requestId,
              parentSessionId: ctx.sessionId,
              parentRequestClient: ctx.requestClient,
              parentToolCallId: toolCallId,
              childRequestId,
              childSessionId,
              parentHeaders,
              childHeaders,
              initialMessages: [buildDelegatedTaskPrompt(parsed.task)],
              ...(authenticatedOrigin ? { authenticatedOrigin } : {}),
              modelOverride: parsed.model,
              reasoningOverride: parsed.reasoning,
            }),
        });
        const handle = adaptToolResultToHost(started);

        if (mode === "deferred") {
          logger.info("subagent delegate accepted", {
            requestId: ctx.requestId,
            sessionId: ctx.sessionId,
            parentToolCallId: toolCallId,
            childRequestId,
            childSessionId,
            workflowRunId: handle.runId,
            profile,
            mode: "deferred",
            idleTimeoutMs,
          });

          return {
            ok: true,
            mode: "deferred",
            status: "accepted",
            workflowRunId: handle.runId,
            profile,
            sessionName,
          };
        }

        let abortListener: (() => void) | null = null;
        if (abortSignal) {
          const onAbort = () => {
            void captureSubagentOperation({
              operation: "cancel_delegation",
              run: () => handle.cancel("parent request aborted"),
            });
          };
          if (abortSignal.aborted) onAbort();
          else {
            abortSignal.addEventListener("abort", onAbort, { once: true });
            abortListener = () => {
              abortSignal.removeEventListener("abort", onAbort);
            };
          }
        }

        let completed: ResultType<SubagentDelegationOutcome, SubagentDelegationError>;
        try {
          completed = await captureSubagentOperation({
            operation: "await_completion",
            run: () => handle.completion,
          });
        } finally {
          abortListener?.();
        }
        if (completed.status === "error") {
          logger.error("subagent delegate failed", {
            requestId: ctx.requestId,
            sessionId: ctx.sessionId,
            parentToolCallId: toolCallId,
            childRequestId,
            childSessionId,
            profile,
            idleTimeoutMs,
            ...formatTaggedErrorForLog(completed.error),
          });
          return adaptToolResultToHost<never, SubagentDelegationError>(Result.err(completed.error));
        }
        const outcome = completed.value;
        const status = outcome.status;
        const ok = status === "resolved";

        logger.info("subagent delegate done", {
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          parentToolCallId: toolCallId,
          childRequestId,
          childSessionId,
          profile,
          status,
          ok,
          idleTimeoutMs,
          workflowRunId: handle.runId,
        });

        return {
          ok,
          mode: "sync",
          status,
          workflowRunId: handle.runId,
          profile,
          sessionName,
          finalText: outcome.finalText,
          detail: outcome.detail,
        };
      },
    }),
  };
}
