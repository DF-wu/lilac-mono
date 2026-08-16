import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { isPanic } from "./runtime-utils";

export const SERVER_COMPACTION_REQUEST_HEADER = "x-lilac-server-compaction-request";
export const SERVER_COMPACTION_REQUEST_MARKER = "true";
export const REMOTE_COMPACTION_BETA_FEATURE = "remote_compaction_v2";

const CODEX_BETA_FEATURES_HEADER = "x-codex-beta-features";
const compactionTriggerSchema = z.object({ type: z.literal("compaction_trigger") }).passthrough();
const responsesRequestSchema = z
  .object({
    input: z.array(z.unknown()),
  })
  .passthrough();

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];
type PreparedServerCompactionRequest = { input: FetchInput; init: FetchInit };

export class ServerCompactionRequestInvalid extends TaggedError("ServerCompactionRequestInvalid")<{
  readonly issue: "invalid-target" | "unreadable-body" | "malformed-json" | "invalid-body";
  readonly cause?: unknown;
  readonly message: string;
}> {}

function requestUrl(input: FetchInput): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}

function requestMethod(input: FetchInput, init: FetchInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function requestHeaders(input: FetchInput, init: FetchInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

async function requestBody(input: FetchInput, init: FetchInit): Promise<string | undefined> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  if (body !== undefined && body !== null) return undefined;
  if (input instanceof Request) return input.clone().text();
  return undefined;
}

function mergeRemoteCompactionFeature(headers: Headers): void {
  const features = (headers.get(CODEX_BETA_FEATURES_HEADER) ?? "")
    .split(",")
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0);
  headers.set(
    CODEX_BETA_FEATURES_HEADER,
    [...new Set([...features, REMOTE_COMPACTION_BETA_FEATURE])].join(","),
  );
}

function encodeServerCompactionPayload(payload: z.output<typeof responsesRequestSchema>): string {
  const inputItems = payload.input.filter((item) => !isServerCompactionTrigger(item));
  return JSON.stringify({
    ...payload,
    input: [...inputItems, { type: "compaction_trigger" }],
  });
}

export function decodeServerCompactionPayload(
  value: unknown,
): ResultType<z.output<typeof responsesRequestSchema>, ServerCompactionRequestInvalid> {
  const parsed = responsesRequestSchema.safeParse(value);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new ServerCompactionRequestInvalid({
          issue: "invalid-body",
          cause: parsed.error,
          message: "Marked server compaction request must contain a Responses input array",
        }),
      );
}

export function isServerCompactionTrigger(value: unknown): boolean {
  return compactionTriggerSchema.safeParse(value).success;
}

export async function prepareServerCompactionRequestResult(
  input: FetchInput,
  init: FetchInit,
): Promise<ResultType<PreparedServerCompactionRequest | null, ServerCompactionRequestInvalid>> {
  const headers = requestHeaders(input, init);
  if (headers.get(SERVER_COMPACTION_REQUEST_HEADER) !== SERVER_COMPACTION_REQUEST_MARKER) {
    return Result.ok(null);
  }

  headers.delete(SERVER_COMPACTION_REQUEST_HEADER);
  const strippedInit = { ...init, headers };
  const url = requestUrl(input);
  if (requestMethod(input, init) !== "POST" || !url.pathname.endsWith("/responses")) {
    return Result.err(
      new ServerCompactionRequestInvalid({
        issue: "invalid-target",
        message: "Marked server compaction request must target POST /responses",
      }),
    );
  }

  let encoded: string | undefined;
  try {
    encoded = await requestBody(input, init);
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new ServerCompactionRequestInvalid({
        issue: "unreadable-body",
        cause,
        message: "Marked server compaction request must have a readable JSON body",
      }),
    );
  }
  if (encoded === undefined) {
    return Result.err(
      new ServerCompactionRequestInvalid({
        issue: "unreadable-body",
        message: "Marked server compaction request must have a readable JSON body",
      }),
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch (cause) {
    if (isPanic(cause)) throw cause;
    return Result.err(
      new ServerCompactionRequestInvalid({
        issue: "malformed-json",
        cause,
        message: "Marked server compaction request must have a valid JSON body",
      }),
    );
  }
  const parsed = decodeServerCompactionPayload(decoded);
  return parsed.map((value) => {
    const body = encodeServerCompactionPayload(value);
    mergeRemoteCompactionFeature(headers);
    return { input, init: { ...strippedInit, body } };
  });
}

/** Adds server compaction wire fields only to explicitly marked Responses requests. */
export function withServerCompactionRequestFetch<T extends typeof globalThis.fetch>(fetchFn: T): T {
  const wrappedFetch = async (input: FetchInput, init?: FetchInit) => {
    const prepared = await prepareServerCompactionRequestResult(input, init);
    const resolved = prepared.match<
      | { readonly value: PreparedServerCompactionRequest | null }
      | { readonly error: ServerCompactionRequestInvalid }
    >({
      ok: (value) => ({ value }),
      err: (error) => ({ error }),
    });
    if ("error" in resolved) {
      switch (resolved.error.issue) {
        case "unreadable-body":
          if (Object.hasOwn(resolved.error, "cause")) throw resolved.error.cause;
          throw new Error(resolved.error.message);
        case "malformed-json":
        case "invalid-body":
          throw new Error(resolved.error.message, { cause: resolved.error.cause });
        case "invalid-target":
          throw new Error(resolved.error.message);
      }
    }
    return resolved.value === null
      ? fetchFn(input, init)
      : fetchFn(resolved.value.input, resolved.value.init);
  };

  return Object.assign(wrappedFetch, fetchFn);
}
