import { describe, expect, it } from "bun:test";
import { z, ZodError } from "zod";

import { defineServerTool, ToolInputValidationError, type ServerToolCallOptions } from "../index";

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
          run: ({ query }) => query,
        }),
        standalone: callable({
          name: "Second",
          description: "Second callable",
          inputSchema: z.object({ count: z.number().optional() }),
          primaryPositional: { field: "count", variadic: true },
          run: ({ count }) => count,
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
            return output;
          },
        }),
      }),
    });

    expect(await tool.call("convert", { count: "3" })).toBe(output);
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
          run: () => undefined,
        }),
        dynamicDisabled: callable({
          name: "Dynamic disabled",
          description: "Hidden from catalog",
          inputSchema: z.object({}),
          catalog: () => false,
          run: () => undefined,
        }),
        syncOverride: callable({
          name: "Sync",
          description: "Original sync description",
          inputSchema: z.object({}),
          hidden: true,
          catalog: () => ({ description: "Current sync description", hidden: false }),
          run: () => undefined,
        }),
        asyncOverride: callable({
          name: "Async",
          description: "Original async description",
          inputSchema: z.object({}),
          catalog: async () => ({ description: "Current async description", hidden: true }),
          run: () => undefined,
        }),
        sharedFirst: callable({
          name: "Shared first",
          description: "Shared catalog snapshot",
          inputSchema: z.object({}),
          catalog: sharedCatalog,
          run: () => undefined,
        }),
        sharedSecond: callable({
          name: "Shared second",
          description: "Shared catalog snapshot",
          inputSchema: z.object({}),
          catalog: sharedCatalog,
          run: () => undefined,
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
          run: () => undefined,
        }),
        partial: callable({
          name: "Partial",
          description: "Partial CLI",
          inputSchema: z.object({ requiredValue: z.string() }),
          cli: { shortInput: ["partial-short"] },
          run: () => undefined,
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
            return "ok";
          },
        }),
      }),
    });

    expect(await tool.call("inspect", {}, opts)).toBe("ok");
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
          run: ({ value }) => value,
        }),
        rawZod: callable({
          name: "Zod",
          description: "Zod validation",
          inputSchema: z.object({ value: z.string() }),
          validation: "zod",
          run: ({ value }) => value,
        }),
      }),
    });

    const guided = tool.call("guided", { value: 1 });
    await expect(guided).rejects.toBeInstanceOf(ToolInputValidationError);
    await expect(guided).rejects.toThrow("guided has invalid input.");
    await expect(tool.call("rawZod", { value: 1 })).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects unknown callable IDs with the exact host message", async () => {
    const tool = defineServerTool({ id: "empty", callables: () => ({}) });

    await expect(tool.call("toString", {})).rejects.toHaveProperty(
      "message",
      "Invalid callable ID 'toString'",
    );
  });
});
