import path from "node:path";

import { isRecord } from "@stanley2058/lilac-utils";
import { z } from "zod";

import type { McpValueSource } from "./config-types";

export type McpValueResolution = { ok: true; value: string } | { ok: false; error: string };

export type McpValueResolutionContext = {
  /** Relative file sources resolve from the directory containing mcp-config.yaml. */
  readonly baseDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readTextFile?: (filePath: string) => Promise<string>;
};

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

function decodeJsonPointerSegment(segment: string): string {
  if (/~(?:[^01]|$)/.test(segment)) {
    throw new Error(`JSON pointer segment ${JSON.stringify(segment)} has invalid escaping`);
  }
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) {
    throw new Error(`JSON pointer must be empty or start with '/': ${JSON.stringify(pointer)}`);
  }

  let current = document;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodeJsonPointerSegment(rawSegment);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) {
        throw new Error(`JSON pointer segment ${JSON.stringify(segment)} is not an array index`);
      }
      const index = Number(segment);
      if (index >= current.length) {
        throw new Error(`JSON pointer array index ${segment} is out of bounds`);
      }
      current = current[index];
      continue;
    }
    if (isRecord(current)) {
      if (!Object.hasOwn(current, segment)) {
        throw new Error(`JSON pointer segment ${JSON.stringify(segment)} does not exist`);
      }
      current = current[segment];
      continue;
    }
    throw new Error(`JSON pointer segment ${JSON.stringify(segment)} has no parent object`);
  }
  return current;
}

async function readTextFile(filePath: string, context: McpValueResolutionContext): Promise<string> {
  if (context.readTextFile) return await context.readTextFile(filePath);
  return await Bun.file(filePath).text();
}

export async function resolveMcpValueSource(
  source: McpValueSource,
  context: McpValueResolutionContext,
): Promise<McpValueResolution> {
  if (typeof source === "string") return { ok: true, value: source };

  if ("env" in source) {
    const value = context.env[source.env];
    return value === undefined
      ? { ok: false, error: `environment variable ${source.env} is not set` }
      : { ok: true, value };
  }

  const filePath = path.isAbsolute(source.file)
    ? source.file
    : path.resolve(context.baseDir, source.file);
  let text: string;
  try {
    text = await readTextFile(filePath, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `failed to read ${source.file}: ${message}` };
  }

  if (source.pointer === undefined) return { ok: true, value: text.trim() };

  let document: unknown;
  try {
    document = jsonValueSchema.parse(JSON.parse(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `failed to parse ${source.file} as JSON: ${message}` };
  }

  let resolved: unknown;
  try {
    resolved = resolveJsonPointer(document, source.pointer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${source.file}: ${message}` };
  }

  return typeof resolved === "string"
    ? { ok: true, value: resolved }
    : {
        ok: false,
        error: `${source.file}: pointer ${source.pointer} did not resolve to a string`,
      };
}

export async function resolveMcpValueSourceMap(
  sources: Readonly<Record<string, McpValueSource>>,
  context: McpValueResolutionContext,
): Promise<{ ok: true; values: Record<string, string> } | { ok: false; error: string }> {
  const values: Record<string, string> = {};
  for (const key of Object.keys(sources).sort()) {
    const source = sources[key];
    if (source === undefined) continue;
    const resolution = await resolveMcpValueSource(source, context);
    if (!resolution.ok) return { ok: false, error: `${key}: ${resolution.error}` };
    values[key] = resolution.value;
  }
  return { ok: true, values };
}

const INVALID_HEADER_NAME = /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/;
// eslint-disable-next-line no-control-regex
const INVALID_HEADER_VALUE = /[\0\r\n]/;

export function validateHttpHeaders(
  headers: Readonly<Record<string, string>>,
): { ok: true } | { ok: false; error: string } {
  for (const [name, value] of Object.entries(headers)) {
    if (name.length === 0 || INVALID_HEADER_NAME.test(name)) {
      return { ok: false, error: `header name ${JSON.stringify(name)} is not a valid HTTP token` };
    }
    if (INVALID_HEADER_VALUE.test(value)) {
      return {
        ok: false,
        error: `header ${name} contains characters that are not valid in an HTTP header value`,
      };
    }
  }
  return { ok: true };
}
