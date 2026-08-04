import { realpath, stat } from "node:fs/promises";

import {
  MINI_LILAC_REASONING_LEVELS,
  miniLilacCancelRequestSchema,
  miniLilacCancelCompactionRequestSchema,
  miniLilacCompactRequestSchema,
  miniLilacInterruptQueuedSteeringRequestSchema,
  miniLilacMessagesSchema,
  miniLilacReconnectQuerySchema,
  miniLilacRedoRequestSchema,
  miniLilacSteerRequestSchema,
  miniLilacUndoRequestSchema,
  miniLilacUpdateSessionBindingsRequestSchema,
  type MiniLilacModelSummary,
  type MiniLilacProfileSummary,
  type MiniLilacSessionSnapshot,
  type MiniLilacTodoState,
  type MiniLilacUIMessage,
} from "@stanley2058/mini-lilac-client";
import {
  HistoryRecoveryAbandonedError,
  MiniLilacSessionExternalFailure,
  type MiniLilacSessionServiceError,
  type ModelCatalogSnapshot,
  type RuntimeConfig,
  type SessionService,
  WorkspaceHistoryStoreError,
} from "@stanley2058/mini-lilac-runtime";
import { isRecord, opaqueErrorMessage } from "@stanley2058/lilac-utils";
import { createUIMessageStreamResponse, safeValidateUIMessages } from "ai";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import Elysia from "elysia";
import { z } from "zod";

export const MINI_LILAC_API_PREFIX = "/api/mini-lilac";
const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

const identifierSchema = z.string().trim().min(1);
const sessionParamsSchema = z.object({ sessionId: identifierSchema }).strict();
const sessionsQuerySchema = z.object({ cwd: z.string().trim().min(1) }).strict();
const skillsQuerySchema = z
  .object({
    cwd: z.string().trim().min(1),
    profile: identifierSchema.optional(),
  })
  .strict();
const emptyBodySchema = z.union([z.undefined(), z.null(), z.object({}).strict()]);
const chatRequestSchema = z
  .object({
    id: identifierSchema,
    messages: z.array(z.unknown()),
    trigger: z.enum(["submit-message", "regenerate-message"]),
    messageId: identifierSchema.nullish(),
    clientCommandId: identifierSchema,
    cwd: z.string().min(1).optional(),
    model: identifierSchema.optional(),
    profile: identifierSchema.optional(),
    reasoning: z
      .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
      .optional(),
  })
  .strict();

export type MiniLilacModelCatalog = {
  get(options?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<ModelCatalogSnapshot>;
};

export type CreateMiniLilacServerOptions = {
  config: RuntimeConfig;
  sessionService: SessionService;
  modelCatalog: MiniLilacModelCatalog;
  authToken?: string;
  reportFatalPanic?: (panic: Panic) => void;
};

export function signalMiniLilacServerPanicToProcess(panic: Panic): void {
  queueMicrotask(() => {
    throw panic;
  });
}

export class MiniLilacHttpFailure extends TaggedError("MiniLilacHttpFailure")<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly issues?: z.core.$ZodIssue[];
}> {}

export class MiniLilacServerConfigurationInvalid extends TaggedError(
  "MiniLilacServerConfigurationInvalid",
)<{
  readonly message: string;
}> {}

type HttpResult<T> = ResultType<T, MiniLilacHttpFailure>;

function httpFailure(status: number, code: string, message: string): MiniLilacHttpFailure {
  return new MiniLilacHttpFailure({ status, code, message });
}

function workspaceHistoryHttpFailure(error: WorkspaceHistoryStoreError): MiniLilacHttpFailure {
  switch (error.code) {
    case "restore-conflict":
      return httpFailure(409, "conflict", "Workspace history changed during the request");
    case "filesystem-error":
    case "git-unavailable":
    case "git-command-failed":
    case "malformed-git-output":
    case "ownership-mismatch":
    case "snapshot-invalid":
    case "platform-unsupported":
    case "workspace-invalid":
      return httpFailure(500, "internal_error", "The request could not be completed");
  }
}

export function decodeMiniLilacHttpRequest<T>(
  schema: z.ZodType<T>,
  input: unknown,
  member?: "body",
): HttpResult<T> {
  let value = input;
  if (member !== undefined) value = isRecord(input) ? input[member] : undefined;
  const decoded = schema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new MiniLilacHttpFailure({
      status: 400,
      code: "invalid_request",
      message: "Request validation failed",
      issues: decoded.error.issues,
    }),
  );
}

export function decodeMiniLilacUiMessages(input: unknown): HttpResult<MiniLilacUIMessage[]> {
  const decoded = miniLilacMessagesSchema.safeParse(input);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    httpFailure(
      400,
      "invalid_ui_messages",
      `UI message validation failed: ${z.prettifyError(decoded.error)}`,
    ),
  );
}

export function adaptMiniLilacPersistenceResult<T>(
  result: ResultType<T, MiniLilacSessionServiceError>,
): HttpResult<T> {
  if (result.status === "ok") return Result.ok(result.value);
  if (result.error instanceof HistoryRecoveryAbandonedError) {
    return Result.err(httpFailure(409, "history-recovery-abandoned", result.error.message));
  }
  if (result.error instanceof WorkspaceHistoryStoreError) {
    return Result.err(workspaceHistoryHttpFailure(result.error));
  }
  switch (result.error._tag) {
    case "UnsupportedVersion":
    case "MalformedSerialization":
    case "CorruptPersistedFields":
    case "MiniLilacSqliteDriverFailure":
    case "WorkspaceHistoryPersistenceUnsupportedVersion":
    case "WorkspaceHistoryPersistenceMalformed":
    case "WorkspaceHistoryPersistenceCorrupt":
      return Result.err(
        httpFailure(
          500,
          "persistence_failure",
          "The persisted Mini Lilac session could not be read",
        ),
      );
    case "MiniLilacHistoryRecordMissing":
      return result.error.recordKind === "session"
        ? Result.err(
            httpFailure(404, "not_found", `Session '${result.error.recordId}' was not found`),
          )
        : Result.err(
            httpFailure(
              500,
              "persistence_failure",
              "The persisted Mini Lilac session could not be read",
            ),
          );
    case "MiniLilacStoreOperationRejected":
    case "MiniLilacSessionOperationRejected":
      return Result.err(
        classifySessionOperationMessage(result.error.message) ??
          httpFailure(500, "internal_error", "The request could not be completed"),
      );
    case "MiniLilacSessionOperationAndCleanupFailed":
      return Result.err(httpFailure(500, "internal_error", "The request could not be completed"));
    case "MiniLilacSessionExternalFailure":
      return Result.err(classifyHttpOperationFailure(result.error));
  }
}

export function adaptMiniLilacPersistenceResultToHost<T>(
  result: ResultType<T, MiniLilacSessionServiceError>,
): T {
  const adapted = adaptMiniLilacPersistenceResult(result);
  if (adapted.status === "ok") return adapted.value;
  throw adapted.error;
}

function classifySessionOperationMessage(message: string): MiniLilacHttpFailure | undefined {
  if (message.includes("was not found")) return httpFailure(404, "not_found", message);
  if (message.includes("already has an active run")) {
    return httpFailure(409, "session_active", message);
  }
  if (
    message.startsWith("Invalid model reference") ||
    message.startsWith("Provider '") ||
    message.startsWith("Unknown profile '") ||
    message.includes("is subagent-only")
  ) {
    return httpFailure(400, "invalid_session_bindings", message);
  }
  if (
    message.includes("has no active run") ||
    message.includes("is not active for session") ||
    message.includes("is not accepting") ||
    message.includes("is pending") ||
    message.includes("was already used") ||
    message.includes("must be quiescent to undo") ||
    message.includes("must be quiescent to redo") ||
    message.includes("must be quiescent for history navigation") ||
    message.includes("must be quiescent to compact") ||
    message.includes("cannot accept a prompt") ||
    message.includes("must be quiescent to update bindings") ||
    message.includes("has no durable checkpoint") ||
    message.includes("has no exact UI prefix") ||
    message.includes("has an invalid checkpoint") ||
    message.includes("has a retained history operation") ||
    message.includes("Retained history operation") ||
    message.includes("pending run finalization") ||
    message.includes("requires Git for recovery") ||
    message.includes("requires Git for verification") ||
    message.includes("UNIQUE constraint failed")
  ) {
    return httpFailure(409, "conflict", message);
  }
  return undefined;
}

function jsonResponse<T>(value: T, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers });
}

function failureResponse(error: MiniLilacHttpFailure): Response {
  const envelope = error.issues
    ? { error: { code: error.code, message: error.message, issues: error.issues } }
    : { error: { code: error.code, message: error.message } };
  return jsonResponse(envelope, error.status);
}

function classifyHttpOperationFailure(
  cause: unknown,
  fallbackCode?: "invalid_session_configuration",
): MiniLilacHttpFailure {
  const failureCause = cause instanceof MiniLilacSessionExternalFailure ? cause.cause : cause;
  if (Panic.is(failureCause)) throw failureCause;
  if (failureCause instanceof HistoryRecoveryAbandonedError) {
    return httpFailure(409, "history-recovery-abandoned", failureCause.message);
  }
  if (failureCause instanceof WorkspaceHistoryStoreError) {
    return workspaceHistoryHttpFailure(failureCause);
  }
  const message = opaqueErrorMessage(failureCause, "The request could not be completed");
  const sessionFailure = classifySessionOperationMessage(message);
  if (sessionFailure !== undefined) return sessionFailure;
  if (fallbackCode !== undefined) return httpFailure(400, fallbackCode, message);
  return httpFailure(500, "internal_error", "The request could not be completed");
}

async function captureHttpOperation(
  operation: () => HttpResult<Response> | Promise<HttpResult<Response>>,
): Promise<HttpResult<Response>> {
  try {
    return await operation();
  } catch (cause) {
    return Result.err(classifyHttpOperationFailure(cause));
  }
}

async function handleHttpOperation(
  operation: () => HttpResult<Response> | Promise<HttpResult<Response>>,
): Promise<Response> {
  const result = await captureHttpOperation(operation);
  return result.status === "ok" ? result.value : failureResponse(result.error);
}

async function captureSessionCreation(
  operation: () => Promise<ResultType<MiniLilacSessionSnapshot, MiniLilacSessionServiceError>>,
): Promise<HttpResult<MiniLilacSessionSnapshot>> {
  const result = await operation();
  if (result.status === "ok") return Result.ok(result.value);
  if (result.error instanceof HistoryRecoveryAbandonedError) {
    return Result.err(httpFailure(409, "history-recovery-abandoned", result.error.message));
  }
  if (result.error instanceof WorkspaceHistoryStoreError) {
    return Result.err(workspaceHistoryHttpFailure(result.error));
  }
  switch (result.error._tag) {
    case "MiniLilacSessionOperationRejected":
      return Result.err(httpFailure(400, "invalid_session_configuration", result.error.message));
    case "MiniLilacSessionExternalFailure":
      return Result.err(
        classifyHttpOperationFailure(result.error, "invalid_session_configuration"),
      );
    case "MiniLilacSessionOperationAndCleanupFailed":
    case "MiniLilacStoreOperationRejected":
    case "UnsupportedVersion":
    case "MalformedSerialization":
    case "CorruptPersistedFields":
    case "MiniLilacSqliteDriverFailure":
    case "MiniLilacHistoryRecordMissing":
    case "WorkspaceHistoryPersistenceUnsupportedVersion":
    case "WorkspaceHistoryPersistenceMalformed":
    case "WorkspaceHistoryPersistenceCorrupt":
      return adaptMiniLilacPersistenceResult(result);
  }
}

async function canonicalDirectory(
  supplied: string,
  subject: "Session" | "Skill",
): Promise<HttpResult<string>> {
  try {
    return Result.ok(await realpath(supplied));
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      httpFailure(400, "invalid_cwd", `${subject} cwd '${supplied}' does not exist`),
    );
  }
}

function requireClientCommandId<T extends { clientCommandId?: string }>(
  request: T,
): HttpResult<T & { clientCommandId: string }> {
  if (request.clientCommandId === undefined) {
    return Result.err(
      httpFailure(400, "client_command_id_required", "clientCommandId is required"),
    );
  }
  return Result.ok({ ...request, clientCommandId: request.clientCommandId });
}

function requireMatchingSessionId<T extends { sessionId: string }>(
  request: T,
  sessionId: string,
): HttpResult<T> {
  if (request.sessionId === sessionId) return Result.ok(request);
  return Result.err(
    httpFailure(409, "session_id_mismatch", "Body sessionId does not match the path"),
  );
}

function pumpSseBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  close: () => void,
): void {
  void (async () => {
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          close();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      }
    } catch (cause) {
      close();
      controller.error(cause);
    }
  })();
}

function enqueueSseKeepAlive(
  controller: ReadableStreamDefaultController<Uint8Array>,
  value: Uint8Array,
  close: () => void,
): void {
  try {
    controller.enqueue(value);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    close();
  }
}

export function withSseKeepAlive(
  response: Response,
  intervalMs = SSE_KEEPALIVE_INTERVAL_MS,
): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const keepAlive = new TextEncoder().encode(": keepalive\n\n");
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearInterval(timer);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (!closed) enqueueSseKeepAlive(controller, keepAlive, close);
      }, intervalMs);
      pumpSseBody(reader, controller, close);
    },
    async cancel(reason) {
      close();
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function uiMessageStreamResponse(
  stream: Parameters<typeof createUIMessageStreamResponse>[0]["stream"],
): Response {
  return withSseKeepAlive(createUIMessageStreamResponse({ stream }));
}

function modelSummaries(snapshot: ModelCatalogSnapshot): MiniLilacModelSummary[] {
  return snapshot.models.map((model) => ({
    id: model.ref.value,
    label: model.name ?? model.ref.value,
    provider: model.provider.id,
    supportsReasoning: model.reasoning === true,
    ...(model.reasoning === true ? { reasoningLevels: [...MINI_LILAC_REASONING_LEVELS] } : {}),
    ...(model.limits && model.limits.context > 0 ? { contextWindow: model.limits.context } : {}),
  }));
}

function profileSummaries(config: RuntimeConfig): MiniLilacProfileSummary[] {
  return Object.entries(config.agent.profiles).map(([id, profile]) => ({
    id,
    label: id,
    ...(profile.description ? { description: profile.description } : {}),
    ...(id === config.agent.defaultProfile ? { isDefault: true } : {}),
    subagentOnly: profile.subagentOnly,
    workspaceWrites: profile.workspaceWrites,
  }));
}

function existingSession(
  sessionService: SessionService,
  sessionId: string,
): HttpResult<MiniLilacSessionSnapshot | undefined> {
  const sessions = adaptMiniLilacPersistenceResult(sessionService.listSessionsResult());
  if (sessions.status === "error") return Result.err(sessions.error);
  return Result.ok(sessions.value.find((session) => session.id === sessionId));
}

async function validateSessionBinding(
  snapshot: MiniLilacSessionSnapshot,
  supplied: { cwd?: string; model?: string; profile?: string; reasoning?: string },
): Promise<HttpResult<void>> {
  if (supplied.cwd !== undefined) {
    const canonicalCwd = await canonicalDirectory(supplied.cwd, "Session");
    if (canonicalCwd.status === "error") return Result.err(canonicalCwd.error);
    if (canonicalCwd.value !== snapshot.cwd) {
      return Result.err(
        httpFailure(409, "session_binding_mismatch", "cwd does not match the session"),
      );
    }
  }
  const immutable = ["model", "profile", "reasoning"] as const;
  for (const field of immutable) {
    const value = supplied[field];
    if (value !== undefined && value !== snapshot[field]) {
      return Result.err(
        httpFailure(409, "session_binding_mismatch", `${field} does not match the session`),
      );
    }
  }
  return Result.ok(undefined);
}

export function validateMiniLilacServerConfiguration(
  options: Pick<CreateMiniLilacServerOptions, "config" | "authToken">,
): ResultType<string | undefined, MiniLilacServerConfigurationInvalid> {
  if (options.config.server.authTokenEnv && options.authToken === undefined) {
    return Result.err(
      new MiniLilacServerConfigurationInvalid({
        message: `An auth token is required by '${options.config.server.authTokenEnv}'`,
      }),
    );
  }
  if (options.authToken !== undefined && !options.authToken.trim()) {
    return Result.err(
      new MiniLilacServerConfigurationInvalid({ message: "The auth token cannot be blank" }),
    );
  }
  return Result.ok(options.config.server.authTokenEnv ? options.authToken : undefined);
}

function signalMiniLilacServerConfigurationFailure(
  error: MiniLilacServerConfigurationInvalid,
): never {
  throw error;
}

export function createMiniLilacServer(options: CreateMiniLilacServerOptions) {
  const { config, modelCatalog, sessionService } = options;
  const reportFatalPanic = options.reportFatalPanic ?? signalMiniLilacServerPanicToProcess;
  const validatedConfiguration = validateMiniLilacServerConfiguration(options);
  if (validatedConfiguration.status === "error") {
    signalMiniLilacServerConfigurationFailure(validatedConfiguration.error);
  }
  const authToken = validatedConfiguration.value;

  const sessionLocks = new Map<string, Promise<void>>();
  async function withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => void (release = resolve));
    sessionLocks.set(sessionId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (sessionLocks.get(sessionId) === current) sessionLocks.delete(sessionId);
    }
  }

  const app = new Elysia();

  app.onBeforeHandle(({ request }) => {
    const pathname = new URL(request.url).pathname;
    if (
      authToken !== undefined &&
      pathname.startsWith(`${MINI_LILAC_API_PREFIX}/`) &&
      pathname !== `${MINI_LILAC_API_PREFIX}/healthz` &&
      request.headers.get("authorization") !== `Bearer ${authToken}`
    ) {
      return jsonResponse(
        { error: { code: "unauthorized", message: "A valid bearer token is required" } },
        401,
        { "WWW-Authenticate": "Bearer" },
      );
    }
  });

  app.onError(({ code, error }) => {
    if (Panic.is(error)) {
      reportFatalPanic(error);
      return new Response(null, { status: 500 });
    }
    if (code === "PARSE") {
      return jsonResponse(
        { error: { code: "invalid_json", message: "Request body must be valid JSON" } },
        400,
      );
    }
    return jsonResponse(
      { error: { code: "internal_error", message: "The request could not be completed" } },
      500,
    );
  });

  app.get(`${MINI_LILAC_API_PREFIX}/healthz`, () => ({ ok: true }));

  app.post(`${MINI_LILAC_API_PREFIX}/chat`, (context) =>
    handleHttpOperation(async () => {
      const decoded = decodeMiniLilacHttpRequest(chatRequestSchema, context, "body");
      if (decoded.status === "error") return Result.err(decoded.error);
      const request = decoded.value;
      if (request.trigger !== "submit-message") {
        return Result.err(
          httpFailure(400, "regenerate_unsupported", "Regenerate requests are not supported"),
        );
      }
      const strictMessages = decodeMiniLilacUiMessages(request.messages);
      if (strictMessages.status === "error") return Result.err(strictMessages.error);
      const validatedMessages = await safeValidateUIMessages<MiniLilacUIMessage>({
        messages: strictMessages.value,
      });
      if (!validatedMessages.success) {
        return Result.err(
          httpFailure(
            400,
            "invalid_ui_messages",
            `UI message validation failed: ${validatedMessages.error.message}`,
          ),
        );
      }
      const userMessage = validatedMessages.data.findLast((message) => message.role === "user");
      if (!userMessage) {
        return Result.err(
          httpFailure(400, "user_message_required", "A user UI message is required"),
        );
      }

      return withSessionLock(request.id, async () => {
        const found = existingSession(sessionService, request.id);
        if (found.status === "error") return Result.err(found.error);
        let snapshot = found.value;
        if (snapshot === undefined) {
          const cwd = request.cwd;
          const model = request.model;
          if (cwd === undefined || model === undefined) {
            return Result.err(
              httpFailure(
                400,
                "session_configuration_required",
                "New sessions require cwd and model",
              ),
            );
          }
          const created = await captureSessionCreation(() =>
            sessionService.createSessionResult({
              id: request.id,
              cwd,
              model,
              profile: request.profile,
              reasoning: request.reasoning,
            }),
          );
          if (created.status === "error") return Result.err(created.error);
          snapshot = created.value;
        } else {
          const binding = await validateSessionBinding(snapshot, request);
          if (binding.status === "error") return Result.err(binding.error);
        }
        const started = adaptMiniLilacPersistenceResult(
          await sessionService.startPromptResult(
            snapshot.id,
            userMessage,
            request.clientCommandId ?? crypto.randomUUID(),
          ),
        );
        if (started.status === "error") return Result.err(started.error);
        return Result.ok(uiMessageStreamResponse(started.value.stream));
      });
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/chat/:sessionId/stream`, ({ params, query }) =>
    handleHttpOperation(() => {
      const decodedParams = decodeMiniLilacHttpRequest(sessionParamsSchema, params);
      if (decodedParams.status === "error") return Result.err(decodedParams.error);
      const decodedQuery = decodeMiniLilacHttpRequest(miniLilacReconnectQuerySchema, query);
      if (decodedQuery.status === "error") return Result.err(decodedQuery.error);
      const { sessionId } = decodedParams.value;
      const found = existingSession(sessionService, sessionId);
      if (found.status === "error") return Result.err(found.error);
      if (found.value === undefined) {
        return Result.err(httpFailure(404, "not_found", `Session '${sessionId}' was not found`));
      }
      const runId =
        "runId" in decodedQuery.value ? decodedQuery.value.runId : found.value.activeRunId;
      if (runId === null) return Result.ok(new Response(null, { status: 204 }));
      const run = adaptMiniLilacPersistenceResult(sessionService.getRunResult(runId));
      if (run.status === "error") return Result.err(run.error);
      if (run.value.sessionId !== sessionId) {
        return Result.err(
          httpFailure(
            409,
            "run_session_mismatch",
            `Run '${runId}' does not belong to session '${sessionId}'`,
          ),
        );
      }
      if (run.value.status !== "active") return Result.ok(new Response(null, { status: 204 }));
      const afterSeq = "after" in decodedQuery.value ? decodedQuery.value.after : 0;
      const replay = adaptMiniLilacPersistenceResult(
        sessionService.replayRunResult(run.value.id, { afterSeq }),
      );
      return replay.status === "ok"
        ? Result.ok(uiMessageStreamResponse(replay.value))
        : Result.err(replay.error);
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId`, ({ params }) =>
    handleHttpOperation(() => {
      const decoded = decodeMiniLilacHttpRequest(sessionParamsSchema, params);
      if (decoded.status === "error") return Result.err(decoded.error);
      const snapshot = adaptMiniLilacPersistenceResult(
        sessionService.getSnapshotResult(decoded.value.sessionId),
      );
      return snapshot.status === "ok"
        ? Result.ok(jsonResponse(snapshot.value))
        : Result.err(snapshot.error);
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/resume`, ({ params }) =>
    handleHttpOperation(async () => {
      const decoded = decodeMiniLilacHttpRequest(sessionParamsSchema, params);
      if (decoded.status === "error") return Result.err(decoded.error);
      const resume = adaptMiniLilacPersistenceResult(
        await sessionService.getSessionResumeResult(decoded.value.sessionId),
      );
      if (resume.status === "error") return Result.err(resume.error);
      const todos = adaptMiniLilacPersistenceResult(
        sessionService.getTodosResult(decoded.value.sessionId),
      );
      return todos.status === "ok"
        ? Result.ok(jsonResponse({ ...resume.value, todos: todos.value }))
        : Result.err(todos.error);
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions`, ({ query }) =>
    handleHttpOperation(async () => {
      const decoded = decodeMiniLilacHttpRequest(sessionsQuerySchema, query);
      if (decoded.status === "error") return Result.err(decoded.error);
      const canonicalCwd = await canonicalDirectory(decoded.value.cwd, "Session");
      if (canonicalCwd.status === "error") return Result.err(canonicalCwd.error);
      const listed = adaptMiniLilacPersistenceResult(sessionService.listSessionsResult());
      if (listed.status === "error") return Result.err(listed.error);
      const sessions = listed.value
        .filter((session) => session.cwd === canonicalCwd.value && !session.id.startsWith("sub:"))
        .toSorted((left, right) => {
          const timestamp = (right.updatedAt ?? right.createdAt ?? "").localeCompare(
            left.updatedAt ?? left.createdAt ?? "",
          );
          return timestamp === 0 ? left.id.localeCompare(right.id) : timestamp;
        });
      return Result.ok(
        jsonResponse(sessions.map((session) => sessionService.describeSession(session))),
      );
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/messages`, ({ params }) =>
    handleHttpOperation(() => {
      const decoded = decodeMiniLilacHttpRequest(sessionParamsSchema, params);
      if (decoded.status === "error") return Result.err(decoded.error);
      const messages = adaptMiniLilacPersistenceResult(
        sessionService.getMessagesResult(decoded.value.sessionId),
      );
      return messages.status === "ok"
        ? Result.ok(jsonResponse(messages.value))
        : Result.err(messages.error);
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/todos`, ({ params }) =>
    handleHttpOperation(() => {
      const decoded = decodeMiniLilacHttpRequest(sessionParamsSchema, params);
      if (decoded.status === "error") return Result.err(decoded.error);
      const todos: HttpResult<MiniLilacTodoState> = adaptMiniLilacPersistenceResult(
        sessionService.getTodosResult(decoded.value.sessionId),
      );
      return todos.status === "ok" ? Result.ok(jsonResponse(todos.value)) : Result.err(todos.error);
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/skills`, ({ query }) =>
    handleHttpOperation(async () => {
      const decoded = decodeMiniLilacHttpRequest(skillsQuerySchema, query);
      if (decoded.status === "error") return Result.err(decoded.error);
      const canonicalCwd = await canonicalDirectory(decoded.value.cwd, "Skill");
      if (canonicalCwd.status === "error") return Result.err(canonicalCwd.error);
      if (!(await stat(canonicalCwd.value)).isDirectory()) {
        return Result.err(
          httpFailure(400, "invalid_cwd", `Skill cwd '${decoded.value.cwd}' is not a directory`),
        );
      }
      return Result.ok(
        jsonResponse(await sessionService.listSkills(decoded.value.cwd, decoded.value.profile)),
      );
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/bindings`, (context) =>
    handleHttpOperation(async () => {
      const decodedParams = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params);
      if (decodedParams.status === "error") return Result.err(decodedParams.error);
      const decoded = decodeMiniLilacHttpRequest(
        miniLilacUpdateSessionBindingsRequestSchema,
        context,
        "body",
      );
      if (decoded.status === "error") return Result.err(decoded.error);
      const matched = requireMatchingSessionId(decoded.value, decodedParams.value.sessionId);
      if (matched.status === "error") return Result.err(matched.error);
      const updated = adaptMiniLilacPersistenceResult(
        await withSessionLock(decodedParams.value.sessionId, () =>
          sessionService.updateSessionBindingsResult(matched.value),
        ),
      );
      return updated.status === "ok"
        ? Result.ok(jsonResponse(updated.value))
        : Result.err(updated.error);
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/steer`, (context) =>
    handleHttpOperation(async () => {
      const decodedParams = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params);
      if (decodedParams.status === "error") return Result.err(decodedParams.error);
      const decoded = decodeMiniLilacHttpRequest(miniLilacSteerRequestSchema, context, "body");
      if (decoded.status === "error") return Result.err(decoded.error);
      const command = requireClientCommandId(decoded.value);
      if (command.status === "error") return Result.err(command.error);
      const matched = requireMatchingSessionId(command.value, decodedParams.value.sessionId);
      if (matched.status === "error") return Result.err(matched.error);
      const steered = adaptMiniLilacPersistenceResult(
        await sessionService.steerResult(matched.value),
      );
      return steered.status === "ok"
        ? Result.ok(jsonResponse(steered.value))
        : Result.err(steered.error);
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/interrupt-queued-steering`, (context) =>
    handleHttpOperation(async () => {
      const decodedParams = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params);
      if (decodedParams.status === "error") return Result.err(decodedParams.error);
      const decoded = decodeMiniLilacHttpRequest(
        miniLilacInterruptQueuedSteeringRequestSchema,
        context,
        "body",
      );
      if (decoded.status === "error") return Result.err(decoded.error);
      const command = requireClientCommandId(decoded.value);
      if (command.status === "error") return Result.err(command.error);
      const matched = requireMatchingSessionId(command.value, decodedParams.value.sessionId);
      if (matched.status === "error") return Result.err(matched.error);
      const interrupted = adaptMiniLilacPersistenceResult(
        await sessionService.interruptQueuedSteeringResult(matched.value),
      );
      return interrupted.status === "ok"
        ? Result.ok(jsonResponse(interrupted.value))
        : Result.err(interrupted.error);
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/cancel`, (context) =>
    handleHttpOperation(async () => {
      const decodedParams = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params);
      if (decodedParams.status === "error") return Result.err(decodedParams.error);
      const decoded = decodeMiniLilacHttpRequest(miniLilacCancelRequestSchema, context, "body");
      if (decoded.status === "error") return Result.err(decoded.error);
      const command = requireClientCommandId(decoded.value);
      if (command.status === "error") return Result.err(command.error);
      const matched = requireMatchingSessionId(command.value, decodedParams.value.sessionId);
      if (matched.status === "error") return Result.err(matched.error);
      const cancelled = adaptMiniLilacPersistenceResult(
        await sessionService.cancelResult(matched.value),
      );
      return cancelled.status === "ok"
        ? Result.ok(jsonResponse(cancelled.value))
        : Result.err(cancelled.error);
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/undo`, (context) =>
    handleHttpOperation(async () => {
      const decodedParams = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params);
      if (decodedParams.status === "error") return Result.err(decodedParams.error);
      const decoded = decodeMiniLilacHttpRequest(miniLilacUndoRequestSchema, context, "body");
      if (decoded.status === "error") return Result.err(decoded.error);
      const command = requireClientCommandId(decoded.value);
      if (command.status === "error") return Result.err(command.error);
      const matched = requireMatchingSessionId(command.value, decodedParams.value.sessionId);
      if (matched.status === "error") return Result.err(matched.error);
      const undone = adaptMiniLilacPersistenceResult(
        await withSessionLock(decodedParams.value.sessionId, () =>
          sessionService.undoResult(matched.value),
        ),
      );
      return undone.status === "ok"
        ? Result.ok(jsonResponse(undone.value))
        : Result.err(undone.error);
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/redo`, (context) =>
    handleHttpOperation(async () => {
      const decodedParams = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params);
      if (decodedParams.status === "error") return Result.err(decodedParams.error);
      const decoded = decodeMiniLilacHttpRequest(miniLilacRedoRequestSchema, context, "body");
      if (decoded.status === "error") return Result.err(decoded.error);
      const command = requireClientCommandId(decoded.value);
      if (command.status === "error") return Result.err(command.error);
      const matched = requireMatchingSessionId(command.value, decodedParams.value.sessionId);
      if (matched.status === "error") return Result.err(matched.error);
      const redone = adaptMiniLilacPersistenceResult(
        await withSessionLock(decodedParams.value.sessionId, () =>
          sessionService.redoResult(matched.value),
        ),
      );
      return redone.status === "ok"
        ? Result.ok(jsonResponse(redone.value))
        : Result.err(redone.error);
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/compact`, (context) =>
    handleHttpOperation(async () => {
      const decodedParams = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params);
      if (decodedParams.status === "error") return Result.err(decodedParams.error);
      const decoded = decodeMiniLilacHttpRequest(miniLilacCompactRequestSchema, context, "body");
      if (decoded.status === "error") return Result.err(decoded.error);
      const matched = requireMatchingSessionId(decoded.value, decodedParams.value.sessionId);
      if (matched.status === "error") return Result.err(matched.error);
      const started = adaptMiniLilacPersistenceResult(
        await withSessionLock(decodedParams.value.sessionId, () =>
          sessionService.compactResult(matched.value),
        ),
      );
      return started.status === "ok"
        ? Result.ok(uiMessageStreamResponse(started.value.stream))
        : Result.err(started.error);
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/compact/cancel`, (context) =>
    handleHttpOperation(async () => {
      const decodedParams = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params);
      if (decodedParams.status === "error") return Result.err(decodedParams.error);
      const decoded = decodeMiniLilacHttpRequest(
        miniLilacCancelCompactionRequestSchema,
        context,
        "body",
      );
      if (decoded.status === "error") return Result.err(decoded.error);
      const matched = requireMatchingSessionId(decoded.value, decodedParams.value.sessionId);
      if (matched.status === "error") return Result.err(matched.error);
      const cancelled = adaptMiniLilacPersistenceResult(
        await sessionService.cancelCompactionResult(matched.value),
      );
      return cancelled.status === "ok"
        ? Result.ok(jsonResponse(cancelled.value))
        : Result.err(cancelled.error);
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/models`, () =>
    handleHttpOperation(async () =>
      Result.ok(jsonResponse(modelSummaries(await modelCatalog.get()))),
    ),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/models/refresh`, (context) =>
    handleHttpOperation(async () => {
      const decoded = decodeMiniLilacHttpRequest(emptyBodySchema, context, "body");
      if (decoded.status === "error") return Result.err(decoded.error);
      return Result.ok(
        jsonResponse(modelSummaries(await modelCatalog.get({ forceRefresh: true }))),
      );
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/profiles`, () => jsonResponse(profileSummaries(config)));

  return app;
}
