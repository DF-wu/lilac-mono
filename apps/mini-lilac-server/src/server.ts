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

function miniLilacPersistenceHttpFailure(
  error: MiniLilacSessionServiceError,
): MiniLilacHttpFailure {
  if (error instanceof HistoryRecoveryAbandonedError) {
    return httpFailure(409, "history-recovery-abandoned", error.message);
  }
  if (error instanceof WorkspaceHistoryStoreError) {
    return workspaceHistoryHttpFailure(error);
  }
  switch (error._tag) {
    case "UnsupportedVersion":
    case "MalformedSerialization":
    case "CorruptPersistedFields":
    case "MiniLilacSqliteDriverFailure":
    case "WorkspaceHistoryPersistenceUnsupportedVersion":
    case "WorkspaceHistoryPersistenceMalformed":
    case "WorkspaceHistoryPersistenceCorrupt":
      return httpFailure(
        500,
        "persistence_failure",
        "The persisted Mini Lilac session could not be read",
      );
    case "MiniLilacHistoryRecordMissing":
      return error.recordKind === "session"
        ? httpFailure(404, "not_found", `Session '${error.recordId}' was not found`)
        : httpFailure(
            500,
            "persistence_failure",
            "The persisted Mini Lilac session could not be read",
          );
    case "MiniLilacStoreOperationRejected":
    case "MiniLilacSessionOperationRejected":
      return (
        classifySessionOperationMessage(error.message) ??
        httpFailure(500, "internal_error", "The request could not be completed")
      );
    case "MiniLilacSessionOperationAndCleanupFailed":
      return httpFailure(500, "internal_error", "The request could not be completed");
    case "MiniLilacSessionExternalFailure":
      return classifyHttpOperationFailure(error);
  }
}

export function adaptMiniLilacPersistenceResult<T>(
  result: ResultType<T, MiniLilacSessionServiceError>,
): HttpResult<T> {
  const adapt = result.match<() => HttpResult<T>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => Result.err(miniLilacPersistenceHttpFailure(error)),
  });
  return adapt();
}

export function adaptMiniLilacPersistenceResultToHost<T>(
  result: ResultType<T, MiniLilacSessionServiceError>,
): T {
  const adapted = adaptMiniLilacPersistenceResult(result);
  let failure: MiniLilacHttpFailure | undefined;
  let resolve: () => T;
  resolve = adapted.match<() => T>({
    ok: (value) => () => value,
    err: (error) => {
      failure = error;
      return () => resolve();
    },
  });
  if (failure !== undefined) throw failure;
  return resolve();
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
  type CapturedHttpFailure = {
    readonly kind: "failure";
    readonly classify: () => MiniLilacHttpFailure;
  };
  function captureHttpFailure<Cause>(cause: Cause): CapturedHttpFailure {
    return { kind: "failure", classify: () => classifyHttpOperationFailure(cause) };
  }
  const attempted = await Result.tryPromise({
    try: async () => operation(),
    catch: captureHttpFailure,
  });
  const settlement = attempted.match<
    { readonly kind: "success"; readonly result: HttpResult<Response> } | CapturedHttpFailure
  >({
    ok: (result) => ({ kind: "success", result }),
    err: (failure) => failure,
  });
  return settlement.kind === "success" ? settlement.result : Result.err(settlement.classify());
}

async function handleHttpOperation(
  operation: () => HttpResult<Response> | Promise<HttpResult<Response>>,
): Promise<Response> {
  const respond = (await captureHttpOperation(operation)).match<() => Response>({
    ok: (response) => () => response,
    err: (error) => () => failureResponse(error),
  });
  return respond();
}

async function captureSessionCreation(
  operation: () => Promise<ResultType<MiniLilacSessionSnapshot, MiniLilacSessionServiceError>>,
): Promise<HttpResult<MiniLilacSessionSnapshot>> {
  const result = await operation();
  const adapt = result.match<() => HttpResult<MiniLilacSessionSnapshot>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      if (error instanceof HistoryRecoveryAbandonedError) {
        return Result.err(httpFailure(409, "history-recovery-abandoned", error.message));
      }
      if (error instanceof WorkspaceHistoryStoreError) {
        return Result.err(workspaceHistoryHttpFailure(error));
      }
      switch (error._tag) {
        case "MiniLilacSessionOperationRejected":
          return Result.err(httpFailure(400, "invalid_session_configuration", error.message));
        case "MiniLilacSessionExternalFailure":
          return Result.err(classifyHttpOperationFailure(error, "invalid_session_configuration"));
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
          return Result.err(miniLilacPersistenceHttpFailure(error));
      }
    },
  });
  return adapt();
}

async function canonicalDirectory(
  supplied: string,
  subject: "Session" | "Skill",
): Promise<HttpResult<string>> {
  type CapturedCanonicalDirectoryFailure =
    | { readonly kind: "panic"; readonly panic: Panic }
    | { readonly kind: "missing" };
  function captureCanonicalDirectoryFailure<Cause>(
    cause: Cause,
  ): CapturedCanonicalDirectoryFailure {
    return Panic.is(cause) ? { kind: "panic", panic: cause } : { kind: "missing" };
  }
  const attempted = await Result.tryPromise({
    try: () => realpath(supplied),
    catch: captureCanonicalDirectoryFailure,
  });
  const settlement = attempted.match<
    { readonly kind: "success"; readonly directory: string } | CapturedCanonicalDirectoryFailure
  >({
    ok: (directory) => ({ kind: "success", directory }),
    err: (failure) => failure,
  });
  if (settlement.kind === "success") return Result.ok(settlement.directory);
  if (settlement.kind === "panic") throw settlement.panic;
  return Result.err(httpFailure(400, "invalid_cwd", `${subject} cwd '${supplied}' does not exist`));
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
    type CapturedPumpFailure = {
      readonly kind: "failure";
      readonly restoreCause: () => unknown;
    };
    function capturePumpFailure<Cause>(cause: Cause): CapturedPumpFailure {
      return { kind: "failure", restoreCause: () => cause };
    }
    const attempted = await Result.tryPromise({
      try: async () => {
        for (;;) {
          const result = await reader.read();
          if (result.done) {
            close();
            controller.close();
            return;
          }
          controller.enqueue(result.value);
        }
      },
      catch: capturePumpFailure,
    });
    const settlement = attempted.match<{ readonly kind: "success" } | CapturedPumpFailure>({
      ok: () => ({ kind: "success" }),
      err: (failure) => failure,
    });
    if (settlement.kind === "failure") {
      close();
      controller.error(settlement.restoreCause());
    }
  })();
}

function enqueueSseKeepAlive(
  controller: ReadableStreamDefaultController<Uint8Array>,
  value: Uint8Array,
  close: () => void,
): void {
  type CapturedEnqueueFailure =
    | { readonly kind: "panic"; readonly panic: Panic }
    | { readonly kind: "failure" };
  function captureEnqueueFailure<Cause>(cause: Cause): CapturedEnqueueFailure {
    return Panic.is(cause) ? { kind: "panic", panic: cause } : { kind: "failure" };
  }
  const attempted = Result.try({
    try: () => controller.enqueue(value),
    catch: captureEnqueueFailure,
  });
  const settlement = attempted.match<{ readonly kind: "success" } | CapturedEnqueueFailure>({
    ok: () => ({ kind: "success" }),
    err: (failure) => failure,
  });
  if (settlement.kind === "success") return;
  if (settlement.kind === "panic") throw settlement.panic;
  close();
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
  const findSession = adaptMiniLilacPersistenceResult(sessionService.listSessionsResult()).match<
    () => HttpResult<MiniLilacSessionSnapshot | undefined>
  >({
    ok: (sessions) => () => Result.ok(sessions.find((session) => session.id === sessionId)),
    err: (error) => () => Result.err(error),
  });
  return findSession();
}

async function validateSessionBinding(
  snapshot: MiniLilacSessionSnapshot,
  supplied: { cwd?: string; model?: string; profile?: string; reasoning?: string },
): Promise<HttpResult<void>> {
  let validatedCwd: HttpResult<void> = Result.ok(undefined);
  if (supplied.cwd !== undefined) {
    validatedCwd = (await canonicalDirectory(supplied.cwd, "Session")).andThen((canonicalCwd) =>
      canonicalCwd === snapshot.cwd
        ? Result.ok(undefined)
        : Result.err(
            httpFailure(409, "session_binding_mismatch", "cwd does not match the session"),
          ),
    );
  }
  return validatedCwd.andThen(() => {
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
  });
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
  const resolveConfiguration = validateMiniLilacServerConfiguration(options).match<
    () => string | undefined
  >({
    ok: (value) => () => value,
    err: (error) => () => signalMiniLilacServerConfigurationFailure(error),
  });
  const authToken = resolveConfiguration();

  const sessionLocks = new Map<string, Promise<void>>();
  async function withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => void (release = resolve));
    sessionLocks.set(sessionId, current);
    await previous;
    using _releaseSessionLock = {
      [Symbol.dispose]() {
        release();
        if (sessionLocks.get(sessionId) === current) sessionLocks.delete(sessionId);
      },
    };
    return await operation();
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
      const continueRequest = decodeMiniLilacHttpRequest(chatRequestSchema, context, "body").match<
        () => Promise<HttpResult<Response>>
      >({
        err: (error) => async () => Result.err(error),
        ok: (request) => async () => {
          if (request.trigger !== "submit-message") {
            return Result.err(
              httpFailure(400, "regenerate_unsupported", "Regenerate requests are not supported"),
            );
          }
          const continueMessages = decodeMiniLilacUiMessages(request.messages).match<
            () => Promise<HttpResult<Response>>
          >({
            err: (error) => async () => Result.err(error),
            ok: (strictMessages) => async () => {
              const validatedMessages = await safeValidateUIMessages<MiniLilacUIMessage>({
                messages: strictMessages,
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
              const userMessage = validatedMessages.data.findLast(
                (message) => message.role === "user",
              );
              if (!userMessage) {
                return Result.err(
                  httpFailure(400, "user_message_required", "A user UI message is required"),
                );
              }

              return withSessionLock(request.id, async () => {
                const continueSession = existingSession(sessionService, request.id).match<
                  () => Promise<HttpResult<Response>>
                >({
                  err: (error) => async () => Result.err(error),
                  ok: (found) => async () => {
                    let snapshotResult: HttpResult<MiniLilacSessionSnapshot>;
                    if (found === undefined) {
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
                      snapshotResult = await captureSessionCreation(() =>
                        sessionService.createSessionResult({
                          id: request.id,
                          cwd,
                          model,
                          profile: request.profile,
                          reasoning: request.reasoning,
                        }),
                      );
                    } else {
                      snapshotResult = (await validateSessionBinding(found, request)).map(
                        () => found,
                      );
                    }
                    const continueSnapshot = snapshotResult.match<
                      () => Promise<HttpResult<Response>>
                    >({
                      err: (error) => async () => Result.err(error),
                      ok: (snapshot) => async () =>
                        adaptMiniLilacPersistenceResult(
                          await sessionService.startPromptResult(
                            snapshot.id,
                            userMessage,
                            request.clientCommandId ?? crypto.randomUUID(),
                          ),
                        ).map((started) => uiMessageStreamResponse(started.stream)),
                    });
                    return continueSnapshot();
                  },
                });
                return continueSession();
              });
            },
          });
          return continueMessages();
        },
      });
      return continueRequest();
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/chat/:sessionId/stream`, ({ params, query }) =>
    handleHttpOperation(() => {
      return decodeMiniLilacHttpRequest(sessionParamsSchema, params).andThen(({ sessionId }) =>
        decodeMiniLilacHttpRequest(miniLilacReconnectQuerySchema, query).andThen((reconnect) =>
          existingSession(sessionService, sessionId).andThen((found) => {
            if (found === undefined) {
              return Result.err(
                httpFailure(404, "not_found", `Session '${sessionId}' was not found`),
              );
            }
            const runId = "runId" in reconnect ? reconnect.runId : found.activeRunId;
            if (runId === null) return Result.ok(new Response(null, { status: 204 }));
            return adaptMiniLilacPersistenceResult(sessionService.getRunResult(runId)).andThen(
              (run) => {
                if (run.sessionId !== sessionId) {
                  return Result.err(
                    httpFailure(
                      409,
                      "run_session_mismatch",
                      `Run '${runId}' does not belong to session '${sessionId}'`,
                    ),
                  );
                }
                if (run.status !== "active") {
                  return Result.ok(new Response(null, { status: 204 }));
                }
                const afterSeq = "after" in reconnect ? reconnect.after : 0;
                return adaptMiniLilacPersistenceResult(
                  sessionService.replayRunResult(run.id, { afterSeq }),
                ).map(uiMessageStreamResponse);
              },
            );
          }),
        ),
      );
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId`, ({ params }) =>
    handleHttpOperation(() =>
      decodeMiniLilacHttpRequest(sessionParamsSchema, params).andThen(({ sessionId }) =>
        adaptMiniLilacPersistenceResult(sessionService.getSnapshotResult(sessionId)).map(
          jsonResponse,
        ),
      ),
    ),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/resume`, ({ params }) =>
    handleHttpOperation(async () => {
      const continueDecoded = decodeMiniLilacHttpRequest(sessionParamsSchema, params).match<
        () => Promise<HttpResult<Response>>
      >({
        err: (error) => async () => Result.err(error),
        ok:
          ({ sessionId }) =>
          async () =>
            adaptMiniLilacPersistenceResult(
              await sessionService.getSessionResumeResult(sessionId),
            ).andThen((resume) =>
              adaptMiniLilacPersistenceResult(sessionService.getTodosResult(sessionId)).map(
                (todos) => jsonResponse({ ...resume, todos }),
              ),
            ),
      });
      return continueDecoded();
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions`, ({ query }) =>
    handleHttpOperation(async () => {
      const continueDecoded = decodeMiniLilacHttpRequest(sessionsQuerySchema, query).match<
        () => Promise<HttpResult<Response>>
      >({
        err: (error) => async () => Result.err(error),
        ok:
          ({ cwd }) =>
          async () =>
            (await canonicalDirectory(cwd, "Session")).andThen((canonicalCwd) =>
              adaptMiniLilacPersistenceResult(sessionService.listSessionsResult()).map((listed) => {
                const sessions = listed
                  .filter(
                    (session) => session.cwd === canonicalCwd && !session.id.startsWith("sub:"),
                  )
                  .toSorted((left, right) => {
                    const timestamp = (right.updatedAt ?? right.createdAt ?? "").localeCompare(
                      left.updatedAt ?? left.createdAt ?? "",
                    );
                    return timestamp === 0 ? left.id.localeCompare(right.id) : timestamp;
                  });
                return jsonResponse(
                  sessions.map((session) => sessionService.describeSession(session)),
                );
              }),
            ),
      });
      return continueDecoded();
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/messages`, ({ params }) =>
    handleHttpOperation(() =>
      decodeMiniLilacHttpRequest(sessionParamsSchema, params).andThen(({ sessionId }) =>
        adaptMiniLilacPersistenceResult(sessionService.getMessagesResult(sessionId)).map(
          jsonResponse,
        ),
      ),
    ),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/todos`, ({ params }) =>
    handleHttpOperation(() =>
      decodeMiniLilacHttpRequest(sessionParamsSchema, params).andThen(({ sessionId }) =>
        adaptMiniLilacPersistenceResult(sessionService.getTodosResult(sessionId)).map(jsonResponse),
      ),
    ),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/skills`, ({ query }) =>
    handleHttpOperation(async () => {
      const continueDecoded = decodeMiniLilacHttpRequest(skillsQuerySchema, query).match<
        () => Promise<HttpResult<Response>>
      >({
        err: (error) => async () => Result.err(error),
        ok:
          ({ cwd, profile }) =>
          async () => {
            const continueCanonical = (await canonicalDirectory(cwd, "Skill")).match<
              () => Promise<HttpResult<Response>>
            >({
              err: (error) => async () => Result.err(error),
              ok: (canonicalCwd) => async () => {
                if (!(await stat(canonicalCwd)).isDirectory()) {
                  return Result.err(
                    httpFailure(400, "invalid_cwd", `Skill cwd '${cwd}' is not a directory`),
                  );
                }
                return Result.ok(jsonResponse(await sessionService.listSkills(cwd, profile)));
              },
            });
            return continueCanonical();
          },
      });
      return continueDecoded();
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/bindings`, (context) =>
    handleHttpOperation(async () => {
      const validated = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params).andThen(
        ({ sessionId }) =>
          decodeMiniLilacHttpRequest(
            miniLilacUpdateSessionBindingsRequestSchema,
            context,
            "body",
          ).andThen((request) =>
            requireMatchingSessionId(request, sessionId).map((matched) => ({
              sessionId,
              request: matched,
            })),
          ),
      );
      const continueValidated = validated.match<() => Promise<HttpResult<Response>>>({
        err: (error) => async () => Result.err(error),
        ok:
          ({ sessionId, request }) =>
          async () =>
            adaptMiniLilacPersistenceResult(
              await withSessionLock(sessionId, () =>
                sessionService.updateSessionBindingsResult(request),
              ),
            ).map(jsonResponse),
      });
      return continueValidated();
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/steer`, (context) =>
    handleHttpOperation(async () => {
      const validated = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params).andThen(
        ({ sessionId }) =>
          decodeMiniLilacHttpRequest(miniLilacSteerRequestSchema, context, "body").andThen(
            (request) =>
              requireClientCommandId(request).andThen((command) =>
                requireMatchingSessionId(command, sessionId),
              ),
          ),
      );
      const continueValidated = validated.match<() => Promise<HttpResult<Response>>>({
        err: (error) => async () => Result.err(error),
        ok: (request) => async () =>
          adaptMiniLilacPersistenceResult(await sessionService.steerResult(request)).map(
            jsonResponse,
          ),
      });
      return continueValidated();
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/interrupt-queued-steering`, (context) =>
    handleHttpOperation(async () => {
      const validated = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params).andThen(
        ({ sessionId }) =>
          decodeMiniLilacHttpRequest(
            miniLilacInterruptQueuedSteeringRequestSchema,
            context,
            "body",
          ).andThen((request) =>
            requireClientCommandId(request).andThen((command) =>
              requireMatchingSessionId(command, sessionId),
            ),
          ),
      );
      const continueValidated = validated.match<() => Promise<HttpResult<Response>>>({
        err: (error) => async () => Result.err(error),
        ok: (request) => async () =>
          adaptMiniLilacPersistenceResult(
            await sessionService.interruptQueuedSteeringResult(request),
          ).map(jsonResponse),
      });
      return continueValidated();
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/cancel`, (context) =>
    handleHttpOperation(async () => {
      const validated = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params).andThen(
        ({ sessionId }) =>
          decodeMiniLilacHttpRequest(miniLilacCancelRequestSchema, context, "body").andThen(
            (request) =>
              requireClientCommandId(request).andThen((command) =>
                requireMatchingSessionId(command, sessionId),
              ),
          ),
      );
      const continueValidated = validated.match<() => Promise<HttpResult<Response>>>({
        err: (error) => async () => Result.err(error),
        ok: (request) => async () =>
          adaptMiniLilacPersistenceResult(await sessionService.cancelResult(request)).map(
            jsonResponse,
          ),
      });
      return continueValidated();
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/undo`, (context) =>
    handleHttpOperation(async () => {
      const validated = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params).andThen(
        ({ sessionId }) =>
          decodeMiniLilacHttpRequest(miniLilacUndoRequestSchema, context, "body").andThen(
            (request) =>
              requireClientCommandId(request).andThen((command) =>
                requireMatchingSessionId(command, sessionId).map((matched) => ({
                  sessionId,
                  request: matched,
                })),
              ),
          ),
      );
      const continueValidated = validated.match<() => Promise<HttpResult<Response>>>({
        err: (error) => async () => Result.err(error),
        ok:
          ({ sessionId, request }) =>
          async () =>
            adaptMiniLilacPersistenceResult(
              await withSessionLock(sessionId, () => sessionService.undoResult(request)),
            ).map(jsonResponse),
      });
      return continueValidated();
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/redo`, (context) =>
    handleHttpOperation(async () => {
      const validated = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params).andThen(
        ({ sessionId }) =>
          decodeMiniLilacHttpRequest(miniLilacRedoRequestSchema, context, "body").andThen(
            (request) =>
              requireClientCommandId(request).andThen((command) =>
                requireMatchingSessionId(command, sessionId).map((matched) => ({
                  sessionId,
                  request: matched,
                })),
              ),
          ),
      );
      const continueValidated = validated.match<() => Promise<HttpResult<Response>>>({
        err: (error) => async () => Result.err(error),
        ok:
          ({ sessionId, request }) =>
          async () =>
            adaptMiniLilacPersistenceResult(
              await withSessionLock(sessionId, () => sessionService.redoResult(request)),
            ).map(jsonResponse),
      });
      return continueValidated();
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/compact`, (context) =>
    handleHttpOperation(async () => {
      const validated = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params).andThen(
        ({ sessionId }) =>
          decodeMiniLilacHttpRequest(miniLilacCompactRequestSchema, context, "body").andThen(
            (request) =>
              requireMatchingSessionId(request, sessionId).map((matched) => ({
                sessionId,
                request: matched,
              })),
          ),
      );
      const continueValidated = validated.match<() => Promise<HttpResult<Response>>>({
        err: (error) => async () => Result.err(error),
        ok:
          ({ sessionId, request }) =>
          async () =>
            adaptMiniLilacPersistenceResult(
              await withSessionLock(sessionId, () => sessionService.compactResult(request)),
            ).map((started) => uiMessageStreamResponse(started.stream)),
      });
      return continueValidated();
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/compact/cancel`, (context) =>
    handleHttpOperation(async () => {
      const validated = decodeMiniLilacHttpRequest(sessionParamsSchema, context.params).andThen(
        ({ sessionId }) =>
          decodeMiniLilacHttpRequest(
            miniLilacCancelCompactionRequestSchema,
            context,
            "body",
          ).andThen((request) => requireMatchingSessionId(request, sessionId)),
      );
      const continueValidated = validated.match<() => Promise<HttpResult<Response>>>({
        err: (error) => async () => Result.err(error),
        ok: (request) => async () =>
          adaptMiniLilacPersistenceResult(await sessionService.cancelCompactionResult(request)).map(
            jsonResponse,
          ),
      });
      return continueValidated();
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/models`, () =>
    handleHttpOperation(async () =>
      Result.ok(jsonResponse(modelSummaries(await modelCatalog.get()))),
    ),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/models/refresh`, (context) =>
    handleHttpOperation(async () => {
      const continueDecoded = decodeMiniLilacHttpRequest(emptyBodySchema, context, "body").match<
        () => Promise<HttpResult<Response>>
      >({
        err: (error) => async () => Result.err(error),
        ok: () => async () =>
          Result.ok(jsonResponse(modelSummaries(await modelCatalog.get({ forceRefresh: true })))),
      });
      return continueDecoded();
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/profiles`, () => jsonResponse(profileSummaries(config)));

  return app;
}
