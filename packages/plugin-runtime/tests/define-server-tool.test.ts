import { describe, expect, expectTypeOf, it } from "bun:test";
import { z } from "zod";
import { Result } from "better-result";

import type { Level1ExecutionRequestContext, RequestContext } from "../types";
import {
  defineServerTool,
  serverToolExitCode,
  serverToolFailure,
  type ServerToolCallOptions,
  type ServerToolFailureKind,
  type ServerToolResult,
} from "../index";

expectTypeOf<NonNullable<RequestContext["requestInitiator"]>["platform"]>().toEqualTypeOf<string>();
expectTypeOf<
  NonNullable<Level1ExecutionRequestContext["requestInitiator"]>["platform"]
>().toEqualTypeOf<string>();

describe("defineServerTool", () => {
  it("lists heterogeneous callables in declaration order using their exact external IDs", async () => {
    const tool = defineServerTool({
      id: "internal-tool-id",
      callables: ({ callable }) => ({
        "external.first": callable({
          name: "First",
          description: "First callable",
          inputSchema: z.object({ query: z.string().describe("Search query") }),
          primaryPositional: "query",
          run: ({ query }) => Result.ok(query),
        }),
        standalone: callable({
          name: "Second",
          description: "Second callable",
          inputSchema: z.object({ count: z.number().optional() }),
          primaryPositional: { field: "count", variadic: true },
          run: ({ count }) => Result.ok(count),
        }),
      }),
    });

    expect(tool.id).toBe("internal-tool-id");
    expect(await tool.list()).toEqual([
      {
        callableId: "external.first",
        name: "First",
        description: "First callable",
        shortInput: ["--query=<string> | Search query"],
        input: ["--query=<string> | Search query"],
        primaryPositional: { field: "query" },
      },
      {
        callableId: "standalone",
        name: "Second",
        description: "Second callable",
        shortInput: [],
        input: ["--count=<number> (Optional)"],
        primaryPositional: { field: "count", variadic: true },
      },
    ]);
  });

  it("infers and passes transformed schema output to run", async () => {
    const output = { transformed: true };
    const tool = defineServerTool({
      id: "transform",
      callables: ({ callable }) => ({
        convert: callable({
          name: "Convert",
          description: "Convert a count",
          inputSchema: z.object({
            count: z.string().transform((value) => Number(value)),
          }),
          run(input) {
            const count: number = input.count;
            // @ts-expect-error z.output is number after the schema transform.
            const source: string = input.count;
            void source;
            expect(count).toBe(3);
            return Result.ok(output);
          },
        }),
      }),
    });

    const result = await tool.call("convert", { count: "3" });
    expect(result.status).toBe("ok");
    if (result.status === "error") throw new Error(result.error.message);
    expect(result.value).toBe(output);
  });

  it("omits disabled catalog entries and applies sync and async catalog overrides", async () => {
    let sharedCatalogCalls = 0;
    const sharedCatalog = async () => {
      sharedCatalogCalls += 1;
      return { hidden: true };
    };
    const tool = defineServerTool({
      id: "catalog",
      callables: ({ callable }) => ({
        staticDisabled: callable({
          name: "Static disabled",
          description: "Hidden from catalog",
          inputSchema: z.object({}),
          catalog: false,
          run: () => Result.ok(),
        }),
        dynamicDisabled: callable({
          name: "Dynamic disabled",
          description: "Hidden from catalog",
          inputSchema: z.object({}),
          catalog: () => false,
          run: () => Result.ok(),
        }),
        syncOverride: callable({
          name: "Sync",
          description: "Original sync description",
          inputSchema: z.object({}),
          hidden: true,
          catalog: () => ({ description: "Current sync description", hidden: false }),
          run: () => Result.ok(),
        }),
        asyncOverride: callable({
          name: "Async",
          description: "Original async description",
          inputSchema: z.object({}),
          catalog: async () => ({ description: "Current async description", hidden: true }),
          run: () => Result.ok(),
        }),
        sharedFirst: callable({
          name: "Shared first",
          description: "Shared catalog snapshot",
          inputSchema: z.object({}),
          catalog: sharedCatalog,
          run: () => Result.ok(),
        }),
        sharedSecond: callable({
          name: "Shared second",
          description: "Shared catalog snapshot",
          inputSchema: z.object({}),
          catalog: sharedCatalog,
          run: () => Result.ok(),
        }),
      }),
    });

    const entries = await tool.list();
    expect(entries.map(({ callableId }) => callableId)).toEqual([
      "syncOverride",
      "asyncOverride",
      "sharedFirst",
      "sharedSecond",
    ]);
    expect(entries[0]).toMatchObject({
      description: "Current sync description",
      hidden: false,
    });
    expect(entries[1]).toMatchObject({
      description: "Current async description",
      hidden: true,
    });
    expect(entries.slice(2).every((entry) => entry.hidden === true)).toBe(true);
    expect(sharedCatalogCalls).toBe(1);

    await tool.list();
    expect(sharedCatalogCalls).toBe(2);
  });

  it("uses per-field CLI overrides and derives non-overridden help", async () => {
    const tool = defineServerTool({
      id: "cli",
      callables: ({ callable }) => ({
        custom: callable({
          name: "Custom",
          description: "Custom CLI",
          inputSchema: z.object({
            requiredValue: z.string(),
            optionalValue: z.boolean().optional(),
          }),
          cli: {
            shortInput: ["custom-short"],
            input: ["custom-all"],
          },
          run: () => Result.ok(),
        }),
        partial: callable({
          name: "Partial",
          description: "Partial CLI",
          inputSchema: z.object({ requiredValue: z.string() }),
          cli: { shortInput: ["partial-short"] },
          run: () => Result.ok(),
        }),
      }),
    });

    const entries = await tool.list();
    expect(entries[0]?.shortInput).toEqual(["custom-short"]);
    expect(entries[0]?.input).toEqual(["custom-all"]);
    expect(entries[1]?.shortInput).toEqual(["partial-short"]);
    expect(entries[1]?.input).toEqual(["--required-value=<string>"]);
  });

  it("supports supplied and no-op lifecycle methods", async () => {
    const events: string[] = [];
    const configured = defineServerTool({
      id: "lifecycle",
      init: () => {
        events.push("init");
      },
      destroy: async () => {
        events.push("destroy");
      },
      callables: () => ({}),
    });
    const noOp = defineServerTool({ id: "no-op", callables: () => ({}) });

    await configured.init();
    await configured.destroy();
    await noOp.init();
    await noOp.destroy();

    expect(events).toEqual(["init", "destroy"]);
  });

  it("forwards call options unchanged", async () => {
    const controller = new AbortController();
    const opts: ServerToolCallOptions = {
      signal: controller.signal,
      context: { requestId: "request-1" },
      messages: [{ role: "user" }],
    };
    let received: ServerToolCallOptions | undefined;
    const tool = defineServerTool({
      id: "options",
      callables: ({ callable }) => ({
        inspect: callable({
          name: "Inspect",
          description: "Inspect options",
          inputSchema: z.object({}),
          run(_input, runOpts) {
            received = runOpts;
            return Result.ok("ok");
          },
        }),
      }),
    });

    const result = await tool.call("inspect", {}, opts);
    expect(result.status).toBe("ok");
    if (result.status === "error") throw new Error(result.error.message);
    expect(result.value).toBe("ok");
    expect(received).toBe(opts);
  });

  it("uses guided validation by default and can preserve Zod errors", async () => {
    const tool = defineServerTool({
      id: "validation",
      callables: ({ callable }) => ({
        guided: callable({
          name: "Guided",
          description: "Guided validation",
          inputSchema: z.object({ value: z.string() }),
          run: ({ value }) => Result.ok(value),
        }),
        rawZod: callable({
          name: "Zod",
          description: "Zod validation",
          inputSchema: z.object({ value: z.string() }),
          validation: "zod",
          run: ({ value }) => Result.ok(value),
        }),
      }),
    });

    const guided = await tool.call("guided", { value: 1 });
    expect(guided.status).toBe("error");
    if (guided.status === "ok") throw new Error("expected guided validation failure");
    expect(guided.error).toEqual({
      kind: "usage",
      code: "invalid_input",
      message: expect.stringContaining("guided has invalid input."),
      retryable: false,
    });

    const rawZod = await tool.call("rawZod", { value: 1 });
    expect(rawZod.status).toBe("error");
    if (rawZod.status === "ok") throw new Error("expected Zod validation failure");
    expect(rawZod.error).toEqual({
      kind: "usage",
      code: "invalid_input",
      message: expect.stringContaining("expected string"),
      retryable: false,
    });
    expect(() => JSON.parse(rawZod.error.message)).not.toThrow();
  });

  it("returns semantic not-found failures for unknown callable IDs", async () => {
    const tool = defineServerTool({ id: "empty", callables: () => ({}) });

    const result = await tool.call("toString", {});
    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected unknown callable failure");
    expect(result.error).toEqual({
      kind: "not_found",
      code: "unknown_callable",
      message: "Invalid callable ID 'toString'",
      retryable: false,
    });
  });

  it("exports the failure helper, exhaustive exit codes, and strict callable return type", () => {
    const failure = serverToolFailure({
      kind: "unavailable",
      code: "backend_offline",
      message: "Backend is offline",
      retryable: true,
      details: { attempts: 2, regions: ["west", null] },
    });
    const expectedExitCodes = {
      internal: 1,
      usage: 2,
      denied: 3,
      not_found: 4,
      conflict: 5,
      unavailable: 6,
      timeout: 7,
      cancelled: 8,
    } as const satisfies Record<ServerToolFailureKind, number>;

    expect(failure).toEqual({
      kind: "unavailable",
      code: "backend_offline",
      message: "Backend is offline",
      retryable: true,
      details: { attempts: 2, regions: ["west", null] },
    });
    expect(serverToolExitCode).toEqual(expectedExitCodes);

    defineServerTool({
      id: "strict-result",
      callables: ({ callable }) => ({
        invalid: callable({
          name: "Invalid",
          description: "Compile-time contract fixture",
          inputSchema: z.object({}),
          // @ts-expect-error Raw callable returns are not supported.
          run: () => "legacy raw value",
        }),
        valid: callable({
          name: "Valid",
          description: "Typed Result fixture",
          inputSchema: z.object({}),
          run: (): ServerToolResult<string> => Result.ok("value"),
        }),
      }),
    });
  });
});
