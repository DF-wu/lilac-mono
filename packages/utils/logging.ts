import { Buffer } from "node:buffer";

import {
  Logger,
  type ITimer,
  type LogLevel,
  type LoggerOptions,
  type TimerOptions,
  type WriteStream,
} from "@stanley2058/simple-module-logger";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { isPanic, isRecord } from "./runtime-utils";

function hasTestGlobals(): boolean {
  return "describe" in globalThis && "it" in globalThis;
}

export function isTestEnv(): boolean {
  const env = process.env;

  // Common conventions across runners (Bun/Jest/Vitest).
  if (env.NODE_ENV === "test") return true;
  if (env.BUN_ENV === "test") return true;
  if (env.BUN_TEST === "1" || env.BUN_TEST === "true") return true;
  if (typeof env.VITEST === "string") return true;
  if (typeof env.JEST_WORKER_ID === "string") return true;

  // Fallback: Bun's test runner installs `describe`/`it` globals.
  return hasTestGlobals();
}

export function resolveLogLevel(override?: LogLevel): LogLevel {
  if (override) return override;
  if (isTestEnv()) return "error";
  const fromEnv = process.env.LOG_LEVEL as LogLevel | undefined;
  return fromEnv ?? "info";
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "fatal":
      return normalized;
    default:
      return undefined;
  }
}

function resolveOutputFormat(override?: "text" | "jsonl"): "text" | "jsonl" {
  if (override) return override;
  return parseBoolean(process.env.LILAC_LOG_JSONL) ? "jsonl" : "text";
}

function resolveJsonlSplitStreams(override?: boolean): boolean | undefined {
  if (override !== undefined) return override;
  return parseBoolean(process.env.LILAC_LOG_JSONL_SPLIT_STREAMS) ? true : undefined;
}

type OpenObserveConfig = {
  endpoint: string;
  authorizationHeader?: string;
};

type ExtendedLoggerOptions = LoggerOptions & {
  outputFormat?: "text" | "jsonl";
  jsonlSplitStreams?: boolean;
};

function resolveOpenObserveConfig(): OpenObserveConfig | null {
  const baseUrl = process.env.LILAC_LOG_OPENOBSERVE_BASE_URL?.trim();
  if (!baseUrl) return null;

  const org = process.env.LILAC_LOG_OPENOBSERVE_ORG?.trim() || "default";
  const stream = process.env.LILAC_LOG_OPENOBSERVE_STREAM?.trim() || "lilac";

  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const endpoint = new URL(
    `api/${encodeURIComponent(org)}/${encodeURIComponent(stream)}/_json`,
    normalizedBaseUrl,
  ).toString();

  const bearerToken = process.env.LILAC_LOG_OPENOBSERVE_BEARER_TOKEN?.trim();
  if (bearerToken) {
    return {
      endpoint,
      authorizationHeader: `Bearer ${bearerToken}`,
    };
  }

  const username = process.env.LILAC_LOG_OPENOBSERVE_USERNAME?.trim();
  const password = process.env.LILAC_LOG_OPENOBSERVE_PASSWORD;
  if (username && password) {
    const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    return {
      endpoint,
      authorizationHeader: `Basic ${basic}`,
    };
  }

  return { endpoint };
}

function resolveOpenObserveLogLevel(fallback: LogLevel): LogLevel {
  const fromEnv = parseLogLevel(process.env.LILAC_LOG_OPENOBSERVE_LEVEL);
  return fromEnv ?? fallback;
}

const MAX_OBJECT_FIELDS_PER_ARG = 40;
const MAX_RETAINED_RECORDS = 2_000;
const MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_BATCH_RECORDS = 200;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = MAX_RETAINED_BYTES - MAX_BATCH_BYTES;
const OPEN_OBSERVE_REQUEST_TIMEOUT_MS = 5_000;
const OPEN_OBSERVE_DIAGNOSTIC_INTERVAL_MS = 30_000;
let openObserveOutcomeSequence = 0;

type OpenObserveFieldValue = string | number | boolean | null;
type OpenObserveRecord = Record<string, OpenObserveFieldValue>;
type SerializedOpenObserveRecord = {
  readonly json: string;
  readonly bytes: number;
};

type OpenObserveFailureKind = "timeout" | "request" | "http";

class OpenObserveTimeout extends TaggedError("OpenObserveTimeout")<{
  readonly message: string;
}> {}

class OpenObserveRequestFailed extends TaggedError("OpenObserveRequestFailed")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

class OpenObserveHttpFailed extends TaggedError("OpenObserveHttpFailed")<{
  readonly status: number;
  readonly message: string;
}> {}

type OpenObserveDeliveryFailure =
  | OpenObserveTimeout
  | OpenObserveRequestFailed
  | OpenObserveHttpFailed;

function projectOpenObserveRequestFailure(cause: unknown): OpenObserveRequestFailed {
  if (isPanic(cause)) throw cause;
  return new OpenObserveRequestFailed({
    cause,
    message: "OpenObserve request failed",
  });
}

function signalOpenObservePanic(cause: unknown): void {
  const panic = isPanic(cause)
    ? cause
    : new Panic({ cause, message: "OpenObserve flush rejected with an opaque defect" });
  queueMicrotask(() => {
    throw panic;
  });
}

export type OpenObserveAggregateDiagnostics = {
  readonly streamCount: number;
  readonly retainedRecords: number;
  readonly retainedBytes: number;
  readonly pendingRecords: number;
  readonly pendingBytes: number;
  readonly activeRecords: number;
  readonly activeBytes: number;
  readonly inFlightRequests: number;
  readonly droppedRecords: number;
  readonly droppedBytes: number;
  readonly oversizeDroppedRecords: number;
  readonly overflowDroppedRecords: number;
  readonly succeededBatches: number;
  readonly failedBatches: number;
  readonly timeoutFailures: number;
  readonly requestFailures: number;
  readonly httpFailures: number;
  readonly lastSuccessAtMs: number | null;
  readonly lastFailureAtMs: number | null;
  readonly lastFailureKind: OpenObserveFailureKind | null;
  readonly lastHttpStatus: number | null;
};

type OpenObserveDiagnosticValues = Omit<OpenObserveAggregateDiagnostics, "streamCount">;
type OpenObserveStreamDiagnostics = OpenObserveDiagnosticValues & {
  readonly lastSuccessSequence: number;
  readonly lastFailureSequence: number;
};
type MutableOpenObserveAggregateDiagnostics = {
  -readonly [Key in keyof OpenObserveAggregateDiagnostics]: OpenObserveAggregateDiagnostics[Key];
};

function emptyOpenObserveDiagnostics(): OpenObserveDiagnosticValues {
  return {
    retainedRecords: 0,
    retainedBytes: 0,
    pendingRecords: 0,
    pendingBytes: 0,
    activeRecords: 0,
    activeBytes: 0,
    inFlightRequests: 0,
    droppedRecords: 0,
    droppedBytes: 0,
    oversizeDroppedRecords: 0,
    overflowDroppedRecords: 0,
    succeededBatches: 0,
    failedBatches: 0,
    timeoutFailures: 0,
    requestFailures: 0,
    httpFailures: 0,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
    lastFailureKind: null,
    lastHttpStatus: null,
  };
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function sanitizeFieldSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, "_");
  return sanitized.length > 0 ? sanitized : "field";
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "[unsupported]";
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return "[unserializable]";
  }
}

function addNormalizedArgFields(target: OpenObserveRecord, index: number, value: unknown): void {
  const prefix = `arg${index}`;

  if (isPrimitive(value)) {
    target[prefix] = value;
    return;
  }

  if (Array.isArray(value)) {
    target[`${prefix}Type`] = "array";
    target[`${prefix}Json`] = safeJsonStringify(value);
    return;
  }

  if (isRecord(value)) {
    target[`${prefix}Type`] = "object";

    let fieldCount = 0;
    for (const [key, nestedValue] of Object.entries(value)) {
      if (fieldCount >= MAX_OBJECT_FIELDS_PER_ARG) {
        target[`${prefix}_truncated`] = true;
        break;
      }

      const fieldName = `${prefix}_${sanitizeFieldSegment(key)}`;
      target[fieldName] = isPrimitive(nestedValue) ? nestedValue : safeJsonStringify(nestedValue);
      fieldCount += 1;
    }

    return;
  }

  if (typeof value === "bigint") {
    target[prefix] = value.toString();
    return;
  }

  target[prefix] = "[unsupported]";
}

function normalizeRecordForOpenObserve(record: unknown): OpenObserveRecord | null {
  if (!isRecord(record)) return null;

  const normalized: OpenObserveRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "args") continue;
    normalized[key] = isPrimitive(value) ? value : safeJsonStringify(value);
  }
  const args = record["args"];
  if (!Array.isArray(args)) {
    return normalized;
  }

  normalized.argsCount = args.length;
  delete normalized.args;

  for (const [index, value] of args.entries()) {
    addNormalizedArgFields(normalized, index, value);
  }

  return normalized;
}

class OpenObserveJsonlStream implements WriteStream {
  private readonly queue: SerializedOpenObserveRecord[] = [];
  private activeBatch: readonly SerializedOpenObserveRecord[] = [];
  private pendingBytes = 0;
  private activeBytes = 0;
  private flushScheduled = false;
  private flushing = false;
  private droppedRecords = 0;
  private droppedBytes = 0;
  private oversizeDroppedRecords = 0;
  private overflowDroppedRecords = 0;
  private succeededBatches = 0;
  private failedBatches = 0;
  private timeoutFailures = 0;
  private requestFailures = 0;
  private httpFailures = 0;
  private lastSuccessAtMs: number | null = null;
  private lastFailureAtMs: number | null = null;
  private lastFailureKind: OpenObserveFailureKind | null = null;
  private lastHttpStatus: number | null = null;
  private lastSuccessSequence = 0;
  private lastFailureSequence = 0;

  constructor(private readonly config: OpenObserveConfig) {}

  write(chunk: string): unknown {
    const lines = chunk.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        const normalized = normalizeRecordForOpenObserve(parsed);
        if (normalized) {
          const json = JSON.stringify(normalized);
          const bytes = Buffer.byteLength(json, "utf8");
          this.enqueue({ json, bytes });
        }
      } catch (cause) {
        if (isPanic(cause)) throw cause;
        // Ignore malformed lines; logger output should be valid JSONL.
      }
    }

    this.scheduleFlush();
    return true;
  }

  diagnostics(): OpenObserveStreamDiagnostics {
    return {
      retainedRecords: this.activeBatch.length + this.queue.length,
      retainedBytes: this.activeBytes + this.pendingBytes,
      pendingRecords: this.queue.length,
      pendingBytes: this.pendingBytes,
      activeRecords: this.activeBatch.length,
      activeBytes: this.activeBytes,
      inFlightRequests: this.activeBatch.length > 0 ? 1 : 0,
      droppedRecords: this.droppedRecords,
      droppedBytes: this.droppedBytes,
      oversizeDroppedRecords: this.oversizeDroppedRecords,
      overflowDroppedRecords: this.overflowDroppedRecords,
      succeededBatches: this.succeededBatches,
      failedBatches: this.failedBatches,
      timeoutFailures: this.timeoutFailures,
      requestFailures: this.requestFailures,
      httpFailures: this.httpFailures,
      lastSuccessAtMs: this.lastSuccessAtMs,
      lastFailureAtMs: this.lastFailureAtMs,
      lastFailureKind: this.lastFailureKind,
      lastHttpStatus: this.lastHttpStatus,
      lastSuccessSequence: this.lastSuccessSequence,
      lastFailureSequence: this.lastFailureSequence,
    };
  }

  private enqueue(record: SerializedOpenObserveRecord): void {
    if (record.bytes > MAX_RECORD_BYTES) {
      this.recordDrop(record, "oversize");
      return;
    }

    this.queue.push(record);
    this.pendingBytes += record.bytes;

    while (
      this.activeBatch.length + this.queue.length > MAX_RETAINED_RECORDS ||
      this.pendingBytes > MAX_PENDING_BYTES ||
      this.activeBytes + this.pendingBytes > MAX_RETAINED_BYTES
    ) {
      const evicted = this.queue.shift();
      if (!evicted) break;
      this.pendingBytes -= evicted.bytes;
      this.recordDrop(evicted, "overflow");
    }
  }

  private recordDrop(record: SerializedOpenObserveRecord, reason: "oversize" | "overflow"): void {
    this.droppedRecords += 1;
    this.droppedBytes += record.bytes;
    if (reason === "oversize") {
      this.oversizeDroppedRecords += 1;
    } else {
      this.overflowDroppedRecords += 1;
    }
    reportOpenObserveDiagnostics();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush().catch(signalOpenObservePanic);
    });
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    try {
      while (this.queue.length > 0) {
        const batch = this.takeBatch();
        try {
          const result = await this.postBatch(batch.body);

          if (result.status === "ok") {
            this.succeededBatches += 1;
            this.lastSuccessAtMs = Date.now();
            this.lastSuccessSequence = ++openObserveOutcomeSequence;
          } else {
            this.recordFailure(result.error);
            reportOpenObserveDiagnostics();
          }
        } finally {
          this.activeBatch = [];
          this.activeBytes = 0;
        }
      }
    } finally {
      this.flushing = false;
      if (this.activeBatch.length === 0 && this.queue.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  private takeBatch(): { readonly body: string } {
    const batch: SerializedOpenObserveRecord[] = [];
    let bodyBytes = 2;

    while (batch.length < MAX_BATCH_RECORDS) {
      const next = this.queue[0];
      if (!next) break;
      const addedBytes = next.bytes + (batch.length > 0 ? 1 : 0);
      if (bodyBytes + addedBytes > MAX_BATCH_BYTES) break;

      this.queue.shift();
      this.pendingBytes -= next.bytes;
      batch.push(next);
      bodyBytes += addedBytes;
    }

    const body = `[${batch.map((record) => record.json).join(",")}]`;
    this.activeBatch = batch;
    this.activeBytes =
      batch.reduce((total, record) => total + record.bytes, 0) + Buffer.byteLength(body, "utf8");
    return { body };
  }

  private async postBatch(body: string): Promise<ResultType<void, OpenObserveDeliveryFailure>> {
    const controller = new AbortController();

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.config.authorizationHeader) {
      headers.Authorization = this.config.authorizationHeader;
    }

    const request = Result.tryPromise({
      try: () =>
        fetch(this.config.endpoint, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        }),
      catch: projectOpenObserveRequestFailure,
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ readonly kind: "timeout"; readonly error: OpenObserveTimeout }>(
      (resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            kind: "timeout",
            error: new OpenObserveTimeout({
              message: "OpenObserve request exceeded its deadline",
            }),
          });
        }, OPEN_OBSERVE_REQUEST_TIMEOUT_MS);
        timeoutId.unref?.();
      },
    );

    try {
      const outcome = await Promise.race([
        request.then((result) => ({ kind: "response" as const, result })),
        timeout,
      ]);
      if (outcome.kind === "timeout") {
        controller.abort();
        await request;
        return Result.err(outcome.error);
      }

      const response = outcome.result;
      if (response.status === "error") return Result.err(response.error);
      if (!response.value.ok) {
        return Result.err(
          new OpenObserveHttpFailed({
            status: response.value.status,
            message: "OpenObserve rejected a log batch",
          }),
        );
      }
      return Result.ok(undefined);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private recordFailure(error: OpenObserveDeliveryFailure): void {
    this.failedBatches += 1;
    this.lastFailureAtMs = Date.now();
    this.lastFailureSequence = ++openObserveOutcomeSequence;
    this.lastHttpStatus = null;

    switch (error._tag) {
      case "OpenObserveTimeout":
        this.timeoutFailures += 1;
        this.lastFailureKind = "timeout";
        return;
      case "OpenObserveRequestFailed":
        this.requestFailures += 1;
        this.lastFailureKind = "request";
        return;
      case "OpenObserveHttpFailed":
        this.httpFailures += 1;
        this.lastFailureKind = "http";
        this.lastHttpStatus = error.status;
        return;
    }
  }
}

const OPEN_OBSERVE_STREAMS = new Map<string, OpenObserveJsonlStream>();
let lastOpenObserveDiagnosticAtMs = Number.NEGATIVE_INFINITY;

export function getOpenObserveDiagnostics(): OpenObserveAggregateDiagnostics {
  const aggregate: MutableOpenObserveAggregateDiagnostics = {
    streamCount: OPEN_OBSERVE_STREAMS.size,
    ...emptyOpenObserveDiagnostics(),
  };
  let lastSuccessSequence = 0;
  let lastFailureSequence = 0;

  for (const stream of OPEN_OBSERVE_STREAMS.values()) {
    const current = stream.diagnostics();
    aggregate.retainedRecords += current.retainedRecords;
    aggregate.retainedBytes += current.retainedBytes;
    aggregate.pendingRecords += current.pendingRecords;
    aggregate.pendingBytes += current.pendingBytes;
    aggregate.activeRecords += current.activeRecords;
    aggregate.activeBytes += current.activeBytes;
    aggregate.inFlightRequests += current.inFlightRequests;
    aggregate.droppedRecords += current.droppedRecords;
    aggregate.droppedBytes += current.droppedBytes;
    aggregate.oversizeDroppedRecords += current.oversizeDroppedRecords;
    aggregate.overflowDroppedRecords += current.overflowDroppedRecords;
    aggregate.succeededBatches += current.succeededBatches;
    aggregate.failedBatches += current.failedBatches;
    aggregate.timeoutFailures += current.timeoutFailures;
    aggregate.requestFailures += current.requestFailures;
    aggregate.httpFailures += current.httpFailures;

    if (current.lastSuccessAtMs !== null && current.lastSuccessSequence > lastSuccessSequence) {
      lastSuccessSequence = current.lastSuccessSequence;
      aggregate.lastSuccessAtMs = current.lastSuccessAtMs;
    }
    if (current.lastFailureAtMs !== null && current.lastFailureSequence > lastFailureSequence) {
      lastFailureSequence = current.lastFailureSequence;
      aggregate.lastFailureAtMs = current.lastFailureAtMs;
      aggregate.lastFailureKind = current.lastFailureKind;
      aggregate.lastHttpStatus = current.lastHttpStatus;
    }
  }

  return aggregate;
}

function reportOpenObserveDiagnostics(): void {
  const now = Date.now();
  if (now - lastOpenObserveDiagnosticAtMs < OPEN_OBSERVE_DIAGNOSTIC_INTERVAL_MS) return;
  lastOpenObserveDiagnosticAtMs = now;

  const diagnostics = getOpenObserveDiagnostics();
  const message =
    `[openobserve] delivery degraded failures=${diagnostics.failedBatches}` +
    ` timeout=${diagnostics.timeoutFailures} request=${diagnostics.requestFailures}` +
    ` http=${diagnostics.httpFailures} dropped_records=${diagnostics.droppedRecords}` +
    ` last_http_status=${diagnostics.lastHttpStatus ?? "none"}` +
    ` dropped_bytes=${diagnostics.droppedBytes} retained_records=${diagnostics.retainedRecords}` +
    ` retained_bytes=${diagnostics.retainedBytes} in_flight=${diagnostics.inFlightRequests}\n`;

  try {
    process.stderr.write(message);
  } catch (cause) {
    if (isPanic(cause)) throw cause;
  }
}

function getOpenObserveStream(config: OpenObserveConfig): OpenObserveJsonlStream {
  const key = `${config.endpoint}\n${config.authorizationHeader ?? ""}`;
  const existing = OPEN_OBSERVE_STREAMS.get(key);
  if (existing) return existing;

  const stream = new OpenObserveJsonlStream(config);
  OPEN_OBSERVE_STREAMS.set(key, stream);
  return stream;
}

function createMirroredTimer(
  localTimer: ITimer,
  mirrorTimer: ITimer,
  fatalMirrorTimer: ITimer,
): ITimer {
  return {
    log(level, message, ...args) {
      if (level === "fatal") {
        fatalMirrorTimer.logError(message, ...args);
        localTimer.log(level, message, ...args);
        return;
      }

      localTimer.log(level, message, ...args);
      mirrorTimer.log(level, message, ...args);
    },
    logDebug(message, ...args) {
      localTimer.logDebug(message, ...args);
      mirrorTimer.logDebug(message, ...args);
    },
    logInfo(message, ...args) {
      localTimer.logInfo(message, ...args);
      mirrorTimer.logInfo(message, ...args);
    },
    logWarn(message, ...args) {
      localTimer.logWarn(message, ...args);
      mirrorTimer.logWarn(message, ...args);
    },
    logError(message, ...args) {
      localTimer.logError(message, ...args);
      mirrorTimer.logError(message, ...args);
    },
    logFatal(message, ...args) {
      fatalMirrorTimer.logError(message, ...args);
      localTimer.logFatal(message, ...args);
    },
    debug(message, ...args) {
      localTimer.debug(message, ...args);
      mirrorTimer.debug(message, ...args);
    },
    info(message, ...args) {
      localTimer.info(message, ...args);
      mirrorTimer.info(message, ...args);
    },
    warn(message, ...args) {
      localTimer.warn(message, ...args);
      mirrorTimer.warn(message, ...args);
    },
    error(message, ...args) {
      localTimer.error(message, ...args);
      mirrorTimer.error(message, ...args);
    },
    fatal(message, ...args) {
      fatalMirrorTimer.error(message, ...args);
      localTimer.fatal(message, ...args);
    },
  };
}

class MirroredLogger extends Logger {
  constructor(
    private readonly localLogger: Logger,
    private readonly mirrorLogger: Logger,
    private readonly fatalMirrorLogger: Logger,
  ) {
    super({
      logLevel: "fatal",
    });
  }

  override log(level: LogLevel, message: unknown, ...args: unknown[]): void {
    if (level === "fatal") {
      this.fatalMirrorLogger.logError(message, ...args);
      this.localLogger.log(level, message, ...args);
      return;
    }

    this.localLogger.log(level, message, ...args);
    this.mirrorLogger.log(level, message, ...args);
  }

  override logDebug(message: unknown, ...args: unknown[]): void {
    this.localLogger.logDebug(message, ...args);
    this.mirrorLogger.logDebug(message, ...args);
  }

  override logInfo(message: unknown, ...args: unknown[]): void {
    this.localLogger.logInfo(message, ...args);
    this.mirrorLogger.logInfo(message, ...args);
  }

  override logWarn(message: unknown, ...args: unknown[]): void {
    this.localLogger.logWarn(message, ...args);
    this.mirrorLogger.logWarn(message, ...args);
  }

  override logError(message: unknown, ...args: unknown[]): void {
    this.localLogger.logError(message, ...args);
    this.mirrorLogger.logError(message, ...args);
  }

  override logFatal(message: unknown, ...args: unknown[]): void {
    this.fatalMirrorLogger.logError(message, ...args);
    this.localLogger.logFatal(message, ...args);
  }

  override debug(message: unknown, ...args: unknown[]): void {
    this.localLogger.debug(message, ...args);
    this.mirrorLogger.debug(message, ...args);
  }

  override info(message: unknown, ...args: unknown[]): void {
    this.localLogger.info(message, ...args);
    this.mirrorLogger.info(message, ...args);
  }

  override warn(message: unknown, ...args: unknown[]): void {
    this.localLogger.warn(message, ...args);
    this.mirrorLogger.warn(message, ...args);
  }

  override error(message: unknown, ...args: unknown[]): void {
    this.localLogger.error(message, ...args);
    this.mirrorLogger.error(message, ...args);
  }

  override fatal(message: unknown, ...args: unknown[]): void {
    this.fatalMirrorLogger.error(message, ...args);
    this.localLogger.fatal(message, ...args);
  }

  override setLogLevel(level: LogLevel): void {
    this.localLogger.setLogLevel(level);
    this.mirrorLogger.setLogLevel(level);
  }

  override setModule(module: string): void {
    this.localLogger.setModule(module);
    this.mirrorLogger.setModule(module);
    this.fatalMirrorLogger.setModule(module);
  }

  override timer(options?: TimerOptions): ITimer {
    return createMirroredTimer(
      this.localLogger.timer(options),
      this.mirrorLogger.timer(options),
      this.fatalMirrorLogger.timer(options),
    );
  }
}

export type CreateLoggerOptions = Omit<LoggerOptions, "logLevel"> & {
  logLevel?: LogLevel;
  outputFormat?: "text" | "jsonl";
  jsonlSplitStreams?: boolean;
};

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { logLevel, outputFormat, jsonlSplitStreams, ...rest } = options;
  const localLogLevel = resolveLogLevel(logLevel);
  const localLoggerOptions: ExtendedLoggerOptions = {
    ...rest,
    logLevel: localLogLevel,
    outputFormat: resolveOutputFormat(outputFormat),
    jsonlSplitStreams: resolveJsonlSplitStreams(jsonlSplitStreams),
  };

  const localLogger = new Logger(localLoggerOptions);

  const openObserve = resolveOpenObserveConfig();
  if (!openObserve) {
    return localLogger;
  }

  const openObserveStream = getOpenObserveStream(openObserve);
  const mirrorLoggerOptions: ExtendedLoggerOptions = {
    ...rest,
    logLevel: resolveOpenObserveLogLevel(localLogLevel),
    outputFormat: "jsonl",
    jsonlSplitStreams: false,
    stdout: openObserveStream,
    stderr: openObserveStream,
  };
  const mirrorLogger = new Logger(mirrorLoggerOptions);
  const fatalMirrorLogger = new Logger({
    ...mirrorLoggerOptions,
    logLevel: "error",
  });

  return new MirroredLogger(localLogger, mirrorLogger, fatalMirrorLogger);
}
