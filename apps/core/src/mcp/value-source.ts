import path from "node:path";

import { isRecord } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import type { McpValueSource } from "./config-types";
import { opaqueErrorMessage, rethrowPanic } from "./error-format";

type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export class McpEnvironmentValueMissingError extends TaggedError(
  "McpEnvironmentValueMissingError",
)<{
  readonly variable: string;
  readonly message: string;
}> {}

export class McpValueFileReadError extends TaggedError("McpValueFileReadError")<{
  readonly source: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class McpValueJsonParseError extends TaggedError("McpValueJsonParseError")<{
  readonly source: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class McpJsonPointerError extends TaggedError("McpJsonPointerError")<{
  readonly pointer: string;
  readonly message: string;
}> {}

export class McpValuePointerError extends TaggedError("McpValuePointerError")<{
  readonly source: string;
  readonly pointer: string;
  readonly cause: McpJsonPointerError;
  readonly message: string;
}> {}

export class McpValueNotStringError extends TaggedError("McpValueNotStringError")<{
  readonly source: string;
  readonly pointer: string;
  readonly message: string;
}> {}

export class McpValueMapResolutionError extends TaggedError("McpValueMapResolutionError")<{
  readonly key: string;
  readonly cause: McpValueSourceError;
  readonly message: string;
}> {}

export class McpInvalidHttpHeaderError extends TaggedError("McpInvalidHttpHeaderError")<{
  readonly headerName: string;
  readonly message: string;
}> {}

export type McpValueSourceError =
  | McpEnvironmentValueMissingError
  | McpValueFileReadError
  | McpValueJsonParseError
  | McpValuePointerError
  | McpValueNotStringError;

export type McpValueResolution = ResultType<string, McpValueSourceError>;
export type McpValueMapResolution = ResultType<Record<string, string>, McpValueMapResolutionError>;

export type McpValueResolutionContext = {
  /** Relative file sources resolve from the directory containing mcp-config.yaml. */
  readonly baseDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readTextFile?: (filePath: string) => Promise<string>;
};

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

function decodeJsonPointerSegment(
  segment: string,
  pointer: string,
): ResultType<string, McpJsonPointerError> {
  if (/~(?:[^01]|$)/.test(segment)) {
    return Result.err(
      new McpJsonPointerError({
        pointer,
        message: `JSON pointer segment ${JSON.stringify(segment)} has invalid escaping`,
      }),
    );
  }
  return Result.ok(segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function resolveJsonPointer(
  document: JsonValue,
  pointer: string,
): ResultType<JsonValue, McpJsonPointerError> {
  if (pointer === "") return Result.ok(document);
  if (!pointer.startsWith("/")) {
    return Result.err(
      new McpJsonPointerError({
        pointer,
        message: `JSON pointer must be empty or start with '/': ${JSON.stringify(pointer)}`,
      }),
    );
  }

  let current: JsonValue = document;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const decodedSegment = decodeJsonPointerSegment(rawSegment, pointer);
    if (decodedSegment.status === "error") return decodedSegment;
    const segment = decodedSegment.value;
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) {
        return Result.err(
          new McpJsonPointerError({
            pointer,
            message: `JSON pointer segment ${JSON.stringify(segment)} is not an array index`,
          }),
        );
      }
      const index = Number(segment);
      if (index >= current.length) {
        return Result.err(
          new McpJsonPointerError({
            pointer,
            message: `JSON pointer array index ${segment} is out of bounds`,
          }),
        );
      }
      const value = current[index];
      if (value === undefined) {
        return Result.err(
          new McpJsonPointerError({
            pointer,
            message: `JSON pointer array index ${segment} is out of bounds`,
          }),
        );
      }
      current = value;
      continue;
    }
    if (isRecord(current)) {
      if (!Object.hasOwn(current, segment)) {
        return Result.err(
          new McpJsonPointerError({
            pointer,
            message: `JSON pointer segment ${JSON.stringify(segment)} does not exist`,
          }),
        );
      }
      const value = current[segment];
      if (value === undefined) {
        return Result.err(
          new McpJsonPointerError({
            pointer,
            message: `JSON pointer segment ${JSON.stringify(segment)} does not exist`,
          }),
        );
      }
      current = value;
      continue;
    }
    return Result.err(
      new McpJsonPointerError({
        pointer,
        message: `JSON pointer segment ${JSON.stringify(segment)} has no parent object`,
      }),
    );
  }
  return Result.ok(current);
}

function captureTextFileRead(
  filePath: string,
  source: string,
  context: McpValueResolutionContext,
): Promise<ResultType<string, McpValueFileReadError>> {
  return Result.tryPromise({
    try: () => (context.readTextFile ? context.readTextFile(filePath) : Bun.file(filePath).text()),
    catch: (cause) => {
      rethrowPanic(cause);
      return new McpValueFileReadError({
        source,
        cause,
        message: `failed to read ${source}: ${opaqueErrorMessage(cause)}`,
      });
    },
  });
}

function decodeJsonValue(
  source: string,
  text: string,
): ResultType<JsonValue, McpValueJsonParseError> {
  const json = Result.try({
    try: () => JSON.parse(text),
    catch: (cause) => {
      rethrowPanic(cause);
      return new McpValueJsonParseError({
        source,
        cause,
        message: `failed to parse ${source} as JSON: ${opaqueErrorMessage(cause)}`,
      });
    },
  });
  if (json.status === "error") return json;

  const parsed = jsonValueSchema.safeParse(json.value);
  if (!parsed.success) {
    return Result.err(
      new McpValueJsonParseError({
        source,
        cause: parsed.error,
        message: `failed to parse ${source} as JSON: ${parsed.error.message}`,
      }),
    );
  }
  return Result.ok(parsed.data);
}

export async function resolveMcpValueSource(
  source: McpValueSource,
  context: McpValueResolutionContext,
): Promise<McpValueResolution> {
  if (typeof source === "string") return Result.ok(source);

  if ("env" in source) {
    const value = context.env[source.env];
    return value === undefined
      ? Result.err(
          new McpEnvironmentValueMissingError({
            variable: source.env,
            message: `environment variable ${source.env} is not set`,
          }),
        )
      : Result.ok(value);
  }

  const filePath = path.isAbsolute(source.file)
    ? source.file
    : path.resolve(context.baseDir, source.file);
  const read = await captureTextFileRead(filePath, source.file, context);
  if (read.status === "error") return read;
  const text = read.value;

  if (source.pointer === undefined) return Result.ok(text.trim());

  const document = decodeJsonValue(source.file, text);
  if (document.status === "error") return document;

  const resolved = resolveJsonPointer(document.value, source.pointer);
  if (resolved.status === "error") {
    return Result.err(
      new McpValuePointerError({
        source: source.file,
        pointer: source.pointer,
        cause: resolved.error,
        message: `${source.file}: ${resolved.error.message}`,
      }),
    );
  }

  return typeof resolved.value === "string"
    ? Result.ok(resolved.value)
    : Result.err(
        new McpValueNotStringError({
          source: source.file,
          pointer: source.pointer,
          message: `${source.file}: pointer ${source.pointer} did not resolve to a string`,
        }),
      );
}

async function resolveMcpValueSourceEntry(
  key: string,
  source: McpValueSource,
  context: McpValueResolutionContext,
): Promise<ResultType<string, McpValueMapResolutionError>> {
  const resolution = await resolveMcpValueSource(source, context);
  if (resolution.status === "ok") return resolution;
  return Result.err(
    new McpValueMapResolutionError({
      key,
      cause: resolution.error,
      message: `${key}: ${resolution.error.message}`,
    }),
  );
}

export async function resolveMcpValueSourceMap(
  sources: Readonly<Record<string, McpValueSource>>,
  context: McpValueResolutionContext,
): Promise<McpValueMapResolution> {
  return Result.gen(async function* () {
    const values: Record<string, string> = {};
    for (const key of Object.keys(sources).sort()) {
      const source = sources[key];
      if (source === undefined) continue;
      values[key] = yield* Result.await(resolveMcpValueSourceEntry(key, source, context));
    }
    return Result.ok(values);
  });
}

const INVALID_HEADER_NAME = /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/;
// eslint-disable-next-line no-control-regex
const INVALID_HEADER_VALUE = /[\0\r\n]/;

export function validateHttpHeaders(
  headers: Readonly<Record<string, string>>,
): ResultType<void, McpInvalidHttpHeaderError> {
  for (const [name, value] of Object.entries(headers)) {
    if (name.length === 0 || INVALID_HEADER_NAME.test(name)) {
      return Result.err(
        new McpInvalidHttpHeaderError({
          headerName: name,
          message: `header name ${JSON.stringify(name)} is not a valid HTTP token`,
        }),
      );
    }
    if (INVALID_HEADER_VALUE.test(value)) {
      return Result.err(
        new McpInvalidHttpHeaderError({
          headerName: name,
          message: `header ${name} contains characters that are not valid in an HTTP header value`,
        }),
      );
    }
  }
  return Result.ok();
}
