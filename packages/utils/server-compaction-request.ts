import { z } from "zod";

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

async function prepareServerCompactionRequest(
  input: FetchInput,
  init: FetchInit,
): Promise<{ input: FetchInput; init: FetchInit } | null> {
  const headers = requestHeaders(input, init);
  if (headers.get(SERVER_COMPACTION_REQUEST_HEADER) !== SERVER_COMPACTION_REQUEST_MARKER) {
    return null;
  }

  headers.delete(SERVER_COMPACTION_REQUEST_HEADER);
  const strippedInit = { ...init, headers };
  const url = requestUrl(input);
  if (requestMethod(input, init) !== "POST" || !url.pathname.endsWith("/responses")) {
    throw new Error("Marked server compaction request must target POST /responses");
  }

  const encoded = await requestBody(input, init);
  if (encoded === undefined) {
    throw new Error("Marked server compaction request must have a readable JSON body");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded) as unknown;
  } catch (error) {
    throw new Error("Marked server compaction request must have a valid JSON body", {
      cause: error,
    });
  }

  const parsed = responsesRequestSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("Marked server compaction request must contain a Responses input array", {
      cause: parsed.error,
    });
  }

  const inputItems = parsed.data.input.filter(
    (item) => !compactionTriggerSchema.safeParse(item).success,
  );
  const body = JSON.stringify({
    ...parsed.data,
    input: [...inputItems, { type: "compaction_trigger" }],
  });
  mergeRemoteCompactionFeature(headers);

  return { input, init: { ...strippedInit, body } };
}

/** Adds server compaction wire fields only to explicitly marked Responses requests. */
export function withServerCompactionRequestFetch<T extends typeof globalThis.fetch>(fetchFn: T): T {
  const wrappedFetch = async (input: FetchInput, init?: FetchInit) => {
    const prepared = await prepareServerCompactionRequest(input, init);
    return prepared === null ? fetchFn(input, init) : fetchFn(prepared.input, prepared.init);
  };

  return Object.assign(wrappedFetch, fetchFn);
}
