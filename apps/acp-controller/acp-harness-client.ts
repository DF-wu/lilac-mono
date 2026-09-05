import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Writable } from "node:stream";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Client,
  type InitializeResponse,
  type ListSessionsResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { Result, type Result as ResultType } from "better-result";

import { captureExternal, replaceExternalFailureMessage } from "./external-adapters.ts";
import { ExternalOperationFailed, HarnessUnavailable, WorkAndCleanupFailed } from "./failures.ts";
import type { PermissionBehavior, PermissionCounters, ResolvedHarness } from "./types.ts";

export type AcpClientError =
  | ExternalOperationFailed
  | HarnessUnavailable
  | WorkAndCleanupFailed<ExternalOperationFailed>;

function choosePermissionOutcome(
  behavior: PermissionBehavior,
  request: RequestPermissionRequest,
): RequestPermissionResponse["outcome"] {
  const pick = (...kinds: readonly string[]) =>
    request.options.find((option) => kinds.includes(option.kind));

  let preferred: RequestPermissionRequest["options"][number] | undefined;
  switch (behavior) {
    case "reject":
      preferred = pick("reject_once", "reject_always");
      break;
    case "once":
      preferred = pick("allow_once", "allow_always", "reject_once", "reject_always");
      break;
    case "always":
      preferred = pick("allow_always", "allow_once", "reject_once", "reject_always");
      break;
  }

  if (!preferred) return { outcome: "cancelled" };
  return { outcome: "selected", optionId: preferred.optionId };
}

class ControllerClient implements Client {
  constructor(
    private readonly permissionBehavior: PermissionBehavior,
    private readonly counters: PermissionCounters,
    private readonly onUpdate?: (notification: SessionNotification) => Promise<void> | void,
  ) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const outcome = choosePermissionOutcome(this.permissionBehavior, params);
    if (outcome.outcome === "cancelled") {
      this.counters.permissionsCancelled++;
    } else if (
      params.options.some(
        (option) => option.optionId === outcome.optionId && option.kind.startsWith("reject"),
      )
    ) {
      this.counters.permissionsRejected++;
    } else {
      this.counters.permissionsApproved++;
    }
    return { outcome };
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    await this.onUpdate?.(params);
  }
}

export class AcpHarnessClient {
  private constructor(
    readonly harness: ResolvedHarness,
    readonly initializeResponse: InitializeResponse,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: ClientSideConnection,
    private readonly stderrBuffer: { value: string },
  ) {}

  static async connect(params: {
    harness: ResolvedHarness;
    version: string;
    permissionBehavior: PermissionBehavior;
    counters: PermissionCounters;
    onUpdate?: (notification: SessionNotification) => Promise<void> | void;
  }): Promise<ResultType<AcpHarnessClient, AcpClientError>> {
    const spawned = await captureExternal("initialize-harness", async () =>
      spawn(params.harness.command, [...params.harness.args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      }),
    );
    const child = spawned.match<ChildProcessWithoutNullStreams | ExternalOperationFailed>({
      ok: (value) => value,
      err: (error) => error,
    });
    if (ExternalOperationFailed.is(child)) return Result.err(child);

    const stderrBuffer = { value: "" };
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrBuffer.value = `${stderrBuffer.value}${text}`.slice(-4000);
    });

    const initialized = await captureExternal(
      "initialize-harness",
      async () => {
        const input = Writable.toWeb(child.stdin);
        const output = new ReadableStream<Uint8Array>({
          async start(controller) {
            function captureFailure(readCause: () => unknown): void {
              (() => controller.error(readCause()))();
            }

            const pumped = await Result.tryPromise({
              try: async () => {
                for await (const rawChunk of child.stdout) {
                  const chunk: unknown = rawChunk;
                  if (!(chunk instanceof Uint8Array)) {
                    return new TypeError("ACP harness stdout emitted a non-byte chunk");
                  }
                  controller.enqueue(chunk);
                }
                controller.close();
                return null;
              },
              catch:
                (cause): (() => unknown) =>
                () =>
                  cause,
            });
            const failure = pumped.match<TypeError | (() => unknown) | null>({
              ok: (value) => value,
              err: (signal) => signal,
            });
            if (failure instanceof TypeError) controller.error(failure);
            else if (failure) captureFailure(failure);
          },
          cancel(reason) {
            child.stdout.destroy(reason instanceof Error ? reason : undefined);
          },
        });
        const stream = ndJsonStream(input, output);
        const client = new ControllerClient(
          params.permissionBehavior,
          params.counters,
          params.onUpdate,
        );
        const connection = new ClientSideConnection(() => client, stream);
        const initializeResponse = await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: "lilac-acp",
            title: "Lilac ACP",
            version: params.version,
          },
        });
        return { connection, initializeResponse };
      },
      `Failed to initialize harness '${params.harness.descriptor.id}'.`,
    );
    const initializedValue = initialized.match<
      | { connection: ClientSideConnection; initializeResponse: InitializeResponse }
      | ExternalOperationFailed
    >({ ok: (value) => value, err: (error) => error });
    if (!ExternalOperationFailed.is(initializedValue)) {
      return Result.ok(
        new AcpHarnessClient(
          params.harness,
          initializedValue.initializeResponse,
          child,
          initializedValue.connection,
          stderrBuffer,
        ),
      );
    }

    const cleanup = await captureExternal("close-harness", async () => {
      child.kill();
    });
    const stderr = stderrBuffer.value.trim();
    const details = stderr.length > 0 ? ` stderr=${stderr}` : "";
    const primary = replaceExternalFailureMessage(
      initializedValue,
      `${initializedValue.message}${details}`,
    );
    const cleanupError = cleanup.match({ ok: () => undefined, err: (error) => error });
    if (cleanupError === undefined) return Result.err(primary);
    return Result.err(
      new WorkAndCleanupFailed({
        primary,
        cleanup: cleanupError,
        message: `${primary.message} Harness process cleanup also failed.`,
      }),
    );
  }

  capabilities(): string[] {
    const agentCapabilities = this.initializeResponse.agentCapabilities;
    const values: string[] = [];
    if (agentCapabilities?.sessionCapabilities?.list) values.push("listSessions");
    if (agentCapabilities?.loadSession) values.push("loadSession");
    if (agentCapabilities?.sessionCapabilities?.resume) values.push("resumeSession");
    return values;
  }

  authHint(): string | undefined {
    const authMethods = this.initializeResponse.authMethods;
    if (!authMethods || authMethods.length === 0) return undefined;
    const first = authMethods[0];
    return (
      first?.description ?? `Authenticate with ${first?.name ?? this.harness.descriptor.title}.`
    );
  }

  async listSessions(
    cwd: string,
  ): Promise<
    ResultType<ListSessionsResponse["sessions"], ExternalOperationFailed | HarnessUnavailable>
  > {
    if (!this.initializeResponse.agentCapabilities?.sessionCapabilities?.list) {
      return Result.err(
        new HarnessUnavailable({
          harnessId: this.harness.descriptor.id,
          message: `Harness '${this.harness.descriptor.id}' does not support session listing.`,
        }),
      );
    }

    const sessions: ListSessionsResponse["sessions"] = [];
    let cursor: string | null | undefined;
    do {
      const response = await captureExternal("list-sessions", () =>
        this.connection.listSessions({ cwd, ...(cursor ? { cursor } : {}) }),
      );
      const page = response.match<ListSessionsResponse | ExternalOperationFailed>({
        ok: (value) => value,
        err: (error) => error,
      });
      if (ExternalOperationFailed.is(page)) return Result.err(page);
      sessions.push(...page.sessions);
      cursor = page.nextCursor;
    } while (cursor);

    return Result.ok(sessions);
  }

  async createSession(
    cwd: string,
  ): Promise<ResultType<NewSessionResponse, ExternalOperationFailed>> {
    return captureExternal("create-session", () =>
      this.connection.newSession({ cwd, mcpServers: [] }),
    );
  }

  async loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<ResultType<void, ExternalOperationFailed | HarnessUnavailable>> {
    if (this.initializeResponse.agentCapabilities?.loadSession) {
      const loaded = await captureExternal("load-session", () =>
        this.connection.loadSession({ sessionId, cwd, mcpServers: [] }),
      );
      return loaded.map(() => undefined);
    }

    if (this.initializeResponse.agentCapabilities?.sessionCapabilities?.resume) {
      const resumed = await captureExternal("load-session", () =>
        this.connection.unstable_resumeSession({ sessionId, cwd }),
      );
      return resumed.map(() => undefined);
    }

    return Result.err(
      new HarnessUnavailable({
        harnessId: this.harness.descriptor.id,
        message: `Harness '${this.harness.descriptor.id}' does not support loading sessions.`,
      }),
    );
  }

  async setMode(
    sessionId: string,
    modeId: string,
  ): Promise<ResultType<void, ExternalOperationFailed>> {
    const updated = await captureExternal("set-session-mode", () =>
      this.connection.setSessionMode({ sessionId, modeId }),
    );
    return updated.map(() => undefined);
  }

  async setModel(
    sessionId: string,
    modelId: string,
  ): Promise<ResultType<void, ExternalOperationFailed>> {
    const updated = await captureExternal("set-session-model", () =>
      this.connection.unstable_setSessionModel({ sessionId, modelId }),
    );
    return updated.map(() => undefined);
  }

  async prompt(
    sessionId: string,
    text: string,
    messageId: string,
  ): Promise<ResultType<PromptResponse, ExternalOperationFailed>> {
    return captureExternal("prompt-session", () =>
      this.connection.prompt({
        sessionId,
        messageId,
        prompt: [{ type: "text", text }],
      }),
    );
  }

  async cancel(sessionId: string): Promise<ResultType<void, ExternalOperationFailed>> {
    const cancelled = await captureExternal("cancel-session", () =>
      this.connection.cancel({ sessionId }),
    );
    return cancelled.map(() => undefined);
  }

  async close(): Promise<ResultType<void, ExternalOperationFailed>> {
    return captureExternal("close-harness", async () => {
      this.child.kill();
      await Promise.race([
        this.connection.closed,
        new Promise<void>((resolve) => setTimeout(resolve, 200)),
      ]);
    });
  }

  stderr(): string {
    return this.stderrBuffer.value.trim();
  }
}

export function isAuthRequiredError(error: ExternalOperationFailed): boolean {
  return error.cause instanceof RequestError && error.cause.code === -32004;
}

export function isCancelledStopReason(stopReason: PromptResponse["stopReason"]): boolean {
  return stopReason === "cancelled";
}

export function extractModeIds(
  response: SessionUpdate | NewSessionResponse | InitializeResponse,
): string[] {
  if ("modes" in response && response.modes) {
    return response.modes.availableModes.map((mode) => mode.id);
  }
  return [];
}
