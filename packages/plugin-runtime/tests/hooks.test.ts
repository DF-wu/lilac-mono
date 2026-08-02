import { describe, expect, it } from "bun:test";

import { Panic, TaggedError } from "better-result";

import {
  decodeLevel1ExecutableMetadata,
  decodeServerTool,
  decodeToolPlugin,
  isPluginPanic,
  invokeLevel1CreateTool,
  invokeLevel1EditTargets,
  invokeLevel1FormatArgs,
  invokeLevel1IsEnabled,
  invokeLevel1SummarizeFailure,
  invokeLevel2Call,
  invokeLevel2List,
  opaquePluginExceptionMessage,
  type Level1ToolSpec,
  type ServerTool,
} from "..";

const context: { pluginId: string; source: "external" } = {
  pluginId: "hooks",
  source: "external",
};

function level1(overrides: Partial<Level1ToolSpec<unknown>> = {}): Level1ToolSpec<unknown> {
  return {
    name: "hook",
    createTool() {},
    isEnabled() {
      return true;
    },
    ...overrides,
  };
}

describe("plugin hook adapters", () => {
  it("maps hostile proxy classification traps to typed errors", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile prototype trap");
        },
        get() {
          throw new Error("hostile property trap");
        },
      },
    );
    const spec = level1({
      formatArgs() {
        throw hostile;
      },
    });

    expect(isPluginPanic(hostile)).toBe(false);
    const invoked = invokeLevel1FormatArgs({ ...context, spec, args: {} });
    expect(invoked.status).toBe("error");
    if (invoked.status === "ok") throw new Error("expected hostile hook failure");
    expect(invoked.error._tag).toBe("ToolPluginHookError");

    const plugin = new Proxy(
      {},
      {
        get() {
          throw hostile;
        },
      },
    );
    const decoded = decodeToolPlugin(plugin);
    expect(decoded.status).toBe("error");
    if (decoded.status === "ok") throw new Error("expected hostile capability failure");
    expect(decoded.error._tag).toBe("ToolPluginCapabilityError");
  });

  it("captures executable metadata getters as Results and still propagates genuine Panic", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("metadata hostile prototype");
        },
        get() {
          throw new Error("metadata hostile property");
        },
      },
    );
    const executable = {};
    Object.defineProperty(executable, "title", {
      get() {
        throw hostile;
      },
    });
    const decoded = decodeLevel1ExecutableMetadata("metadata", executable);
    expect(decoded.status).toBe("error");
    if (decoded.status === "ok") throw new Error("expected hostile metadata failure");
    expect(decoded.error._tag).toBe("ToolPluginCapabilityError");

    const panic = new Panic({ message: "metadata invariant" });
    const panickingExecutable = {};
    Object.defineProperty(panickingExecutable, "description", {
      get() {
        throw panic;
      },
    });
    expect(() => decodeLevel1ExecutableMetadata("metadata", panickingExecutable)).toThrow(panic);
  });

  it("formats hostile and tagged external exceptions without throwing or exposing secrets", () => {
    class ExternalSecretError extends TaggedError("ExternalSecretError")<{
      readonly secret: string;
      readonly message: string;
    }> {}
    const tagged = new ExternalSecretError({
      secret: "plugin-token-secret-value",
      message: "token=plugin-token-secret-value",
    });
    const hostileMessage = Object.create(Error.prototype);
    Object.defineProperty(hostileMessage, "message", {
      get() {
        throw new Panic({ message: "hostile message getter" });
      },
    });
    const hostileCoercion = {
      toString() {
        throw new Panic({ message: "hostile coercion" });
      },
    };

    expect(opaquePluginExceptionMessage(tagged)).toBe("External tagged error");
    expect(opaquePluginExceptionMessage(hostileMessage)).toBe("Unknown plugin exception");
    expect(opaquePluginExceptionMessage(hostileCoercion)).toBe("Unknown plugin exception");
    expect(opaquePluginExceptionMessage(new Panic({ message: "panic text" }))).toBe(
      "External tagged error",
    );
  });

  it("preserves the Level 1 receiver", () => {
    const spec = level1();
    let receiverMatches = false;
    spec.createTool = function () {
      receiverMatches = this === spec;
      return { identity: spec };
    };
    const created = invokeLevel1CreateTool({
      ...context,
      spec,
      context: {
        runtime: undefined,
        cwd: "/",
        runProfile: "primary",
        editingToolMode: "none",
        subagentDepth: 0,
        subagentConfig: { enabled: false, idleTimeoutMs: 0, maxDepth: 0 },
        getTools: () => ({}),
        getLevel1ToolSpecs: () => new Map(),
        resolveEditTargets: async () => [],
      },
    });
    expect(created.status).toBe("ok");
    expect(receiverMatches).toBe(true);
  });

  it("validates rich Level 1 hook results", async () => {
    const spec = level1();
    Object.defineProperties(spec, {
      isEnabled: { value: () => "yes" },
      editTargets: { value: () => ["one", 2] },
      formatArgs: { value: () => 42 },
      summarizeFailure: { value: () => ({ ok: false, failureKind: "unknown" }) },
    });

    const enabled = invokeLevel1IsEnabled({
      ...context,
      spec,
      context: {
        runtime: undefined,
        cwd: "/",
        runProfile: "primary",
        editingToolMode: "none",
        subagentDepth: 0,
        subagentConfig: { enabled: false, idleTimeoutMs: 0, maxDepth: 0 },
      },
    });
    expect(enabled.status).toBe("error");
    expect((await invokeLevel1EditTargets({ ...context, spec, args: {}, cwd: "/" })).status).toBe(
      "error",
    );
    expect(invokeLevel1FormatArgs({ ...context, spec, args: {} }).status).toBe("error");
    expect(
      invokeLevel1SummarizeFailure({ ...context, spec, value: { isError: true, result: null } })
        .status,
    ).toBe("error");
  });

  it("captures synchronous throws and asynchronous rejections", async () => {
    const sync = level1({
      formatArgs() {
        throw new Error("sync hook");
      },
    });
    const syncResult = invokeLevel1FormatArgs({ ...context, spec: sync, args: {} });
    expect(syncResult.status).toBe("error");
    if (syncResult.status === "ok") throw new Error("expected sync hook failure");
    expect(syncResult.error._tag).toBe("ToolPluginHookError");

    const tool: ServerTool = {
      id: "async",
      async init() {},
      async destroy() {},
      async list() {
        return [];
      },
      async call() {
        throw new Error("async hook");
      },
    };
    const asyncResult = await invokeLevel2Call({
      ...context,
      tool,
      callableId: "async.call",
      input: {},
    });
    expect(asyncResult.status).toBe("error");
    if (asyncResult.status === "ok") throw new Error("expected async hook failure");
    expect(asyncResult.error.message).toContain("async hook");
  });

  it("contains hostile Level 2 list getters and thrown values", async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile list prototype");
        },
        get() {
          throw new Error("hostile list property");
        },
      },
    );
    const hostileGetter = {
      id: "hostile-getter",
      async init() {},
      async destroy() {},
      get list(): ServerTool["list"] {
        throw hostile;
      },
      async call() {},
    };
    const decoded = decodeServerTool("hooks", hostileGetter);
    expect(decoded.status).toBe("error");
    if (decoded.status === "ok") throw new Error("expected hostile list getter failure");
    expect(decoded.error._tag).toBe("ToolPluginCapabilityError");

    const throwingList: ServerTool = {
      id: "hostile-list",
      async init() {},
      async destroy() {},
      async list() {
        throw hostile;
      },
      async call() {},
    };
    const listed = await invokeLevel2List({ ...context, tool: throwingList });
    expect(listed.status).toBe("error");
    if (listed.status === "ok") throw new Error("expected hostile list hook failure");
    expect(listed.error._tag).toBe("ToolPluginHookError");
  });

  it("propagates Panic from external hooks", () => {
    const panic = new Panic({ message: "hook invariant" });
    const spec = level1({
      formatArgs() {
        throw panic;
      },
    });
    try {
      invokeLevel1FormatArgs({ ...context, spec, args: {} });
      throw new Error("expected Panic");
    } catch (cause) {
      expect(cause).toBe(panic);
      expect(Panic.is(cause)).toBe(true);
    }
  });
});
