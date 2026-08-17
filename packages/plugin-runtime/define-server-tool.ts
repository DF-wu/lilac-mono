import { z } from "zod";
import { Result, type Result as ResultType } from "better-result";

import type {
  ServerTool,
  ServerToolCallOptions,
  ServerToolFailure,
  ServerToolHelpEntry,
  ServerToolPrimaryPositional,
  ServerToolResult,
} from "./types";
import { serverToolFailure } from "./types";
import { decodeToolInput, type ToolInputValidationError } from "./validation-error-message";
import { zodObjectToCliLines } from "./zod-cli";

export type ServerToolValidationMode = "guided" | "zod";

export type ServerToolCliHelp = {
  readonly shortInput?: readonly string[];
  readonly input?: readonly string[];
};

export type ServerToolCatalogOverrides = {
  readonly description?: string;
  readonly hidden?: boolean;
};

export type ServerToolCatalogResult = false | ServerToolCatalogOverrides;

export type ServerToolCatalog = () => ServerToolCatalogResult | Promise<ServerToolCatalogResult>;

export type ServerToolCallableDefinition<
  TSchema extends z.ZodType,
  TResult,
  P extends string = string,
> = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TSchema;
  readonly validation?: ServerToolValidationMode;
  readonly primaryPositional?: string | ServerToolPrimaryPositional;
  readonly hidden?: boolean;
  readonly cli?: ServerToolCliHelp;
  readonly catalog?: false | ServerToolCatalog;
  run(
    input: z.output<TSchema>,
    opts: ServerToolCallOptions<P> | undefined,
  ): ServerToolResult<TResult> | Promise<ServerToolResult<TResult>>;
};

export type ServerToolCallable<P extends string = string> = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly primaryPositional?: ServerToolPrimaryPositional;
  readonly hidden?: boolean;
  readonly cli?: ServerToolCliHelp;
  readonly catalog?: false | ServerToolCatalog;
  invoke(
    callableId: string,
    input: Record<string, unknown>,
    opts: ServerToolCallOptions<P> | undefined,
  ): Promise<ServerToolResult>;
};

export type ServerToolCallableBuilder<P extends string = string> = <
  TSchema extends z.ZodType,
  TResult,
>(
  definition: ServerToolCallableDefinition<TSchema, TResult, P>,
) => ServerToolCallable<P>;

export type ServerToolDefinition<P extends string = string> = {
  readonly id: string;
  readonly init?: () => void | Promise<void>;
  readonly destroy?: () => void | Promise<void>;
  readonly callables: (helpers: {
    readonly callable: ServerToolCallableBuilder<P>;
  }) => Readonly<Record<string, ServerToolCallable<P>>>;
};

function createCallable<P extends string>(): ServerToolCallableBuilder<P> {
  return <TSchema extends z.ZodType, TResult>(
    definition: ServerToolCallableDefinition<TSchema, TResult, P>,
  ): ServerToolCallable<P> => {
    const validation = definition.validation ?? "guided";
    const primaryPositional =
      typeof definition.primaryPositional === "string"
        ? { field: definition.primaryPositional }
        : definition.primaryPositional;

    return {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      primaryPositional,
      hidden: definition.hidden,
      cli: definition.cli,
      catalog: definition.catalog,
      async invoke(callableId, input: Record<string, unknown>, opts) {
        const decoded = decodeToolInput({ callableId, input, schema: definition.inputSchema });
        const invoke = decoded.match<() => Promise<ServerToolResult<TResult>>>({
          ok: (value) => () => Promise.resolve(definition.run(value, opts)),
          err: (error) => () => Promise.resolve(Result.err(validationFailure(validation, error))),
        });
        return invoke();
      },
    };
  };
}

function validationFailure(
  validation: ServerToolValidationMode,
  error: ToolInputValidationError,
): ServerToolFailure {
  return serverToolFailure({
    kind: "usage",
    code: "invalid_input",
    message: validation === "guided" ? error.message : error.cause.message,
    retryable: false,
  });
}

function lookupServerToolCallable<P extends string>(
  callables: ReadonlyMap<string, ServerToolCallable<P>>,
  callableId: string,
): ResultType<ServerToolCallable<P>, ServerToolFailure> {
  const entry = callables.get(callableId);
  if (entry) return Result.ok(entry);
  return Result.err(
    serverToolFailure({
      kind: "not_found",
      code: "unknown_callable",
      message: `Invalid callable ID '${callableId}'`,
      retryable: false,
    }),
  );
}

function createHelpEntry<P extends string>(
  callableId: string,
  definition: ServerToolCallable<P>,
  overrides?: ServerToolCatalogOverrides,
): ServerToolHelpEntry {
  const hidden = overrides?.hidden ?? definition.hidden;
  return {
    callableId,
    name: definition.name,
    description: overrides?.description ?? definition.description,
    shortInput: definition.cli?.shortInput
      ? [...definition.cli.shortInput]
      : zodObjectToCliLines(definition.inputSchema, { mode: "required" }),
    input: definition.cli?.input
      ? [...definition.cli.input]
      : zodObjectToCliLines(definition.inputSchema),
    ...(definition.primaryPositional ? { primaryPositional: definition.primaryPositional } : {}),
    ...(hidden === undefined ? {} : { hidden }),
  };
}

export function defineServerTool<P extends string = string>(
  definition: ServerToolDefinition<P>,
): ServerTool<P> {
  const callable = createCallable<P>();
  const callables = new Map(Object.entries(definition.callables({ callable })));

  return {
    id: definition.id,
    async init() {
      await definition.init?.();
    },
    async destroy() {
      await definition.destroy?.();
    },
    async list() {
      const entries: ServerToolHelpEntry[] = [];
      const catalogResults = new Map<ServerToolCatalog, Promise<ServerToolCatalogResult>>();
      for (const [callableId, entry] of callables) {
        if (entry.catalog === false) continue;
        let catalog: ServerToolCatalogResult | undefined;
        if (entry.catalog) {
          let pending = catalogResults.get(entry.catalog);
          if (!pending) {
            pending = Promise.resolve(entry.catalog());
            catalogResults.set(entry.catalog, pending);
          }
          catalog = await pending;
        }
        if (catalog === false) continue;
        entries.push(createHelpEntry(callableId, entry, catalog));
      }
      return entries;
    },
    async call(callableId, input, opts) {
      const invoke = lookupServerToolCallable(callables, callableId).match<
        () => Promise<ServerToolResult>
      >({
        ok: (entry) => () => entry.invoke(callableId, input, opts),
        err: (error) => () => Promise.resolve(Result.err(error)),
      });
      return invoke();
    },
  };
}
