import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  ToolPluginCleanupError,
  ToolPluginHookError,
  ToolPluginManager,
  type Level1ToolSpec,
  type RequestContext,
} from "@stanley2058/lilac-plugin-runtime";
import { createLogger, parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError } from "better-result";

import {
  createToolServer as createToolServerImpl,
  type ToolServerOptions,
  type ToolServerHealthSnapshot,
} from "../src/tool-server/create-tool-server";
import type { ServerTool } from "../src/tool-server/types";
import { RequestControlAuthority } from "../src/tool-server/request-control-authority";
import { parseToolInput } from "../src/tool-server/validation-error-message";
import type { AuthenticatedRequestProjection } from "../src/surface/authenticated-request";

const originalMemoryUsage = process.memoryUsage;
const TEST_OPERATOR_TOKEN = "tool-server-test-operator";

function createToolServer(options: ToolServerOptions) {
  const hasExplicitAuthority =
    options.authorizeControlRequest !== undefined ||
    options.requestMessageCache !== undefined ||
    options.getConfig !== undefined ||
    options.resolveServerSafetyMode !== undefined ||
    options.operatorTokenSha256 !== undefined;
  if (hasExplicitAuthority) return createToolServerImpl(options);
  const server = createToolServerImpl({
    ...options,
    canonicalWorkspaceRoot: options.canonicalWorkspaceRoot ?? "/workspace",
    operatorTokenSha256: createHash("sha256").update(TEST_OPERATOR_TOKEN).digest("hex"),
  });
  const handle = server.app.handle.bind(server.app);
  server.app.handle = (request: Request) => {
    const hasLilacHeader = Array.from(request.headers.keys()).some((key) =>
      key.startsWith("x-lilac-"),
    );
    if (hasLilacHeader) return handle(request);
    const headers = new Headers(request.headers);
    headers.set("x-lilac-operator-token", TEST_OPERATOR_TOKEN);
    return handle(new Request(request, { headers }));
  };
  return server;
}

function discordRequestProjection(input: {
  readonly requestId: string;
  readonly sessionId: string;
  readonly userId?: string;
  readonly verifiedIngress?: boolean;
}): AuthenticatedRequestProjection {
  const sessionRef = { platform: "discord" as const, channelId: input.sessionId };
  return {
    requestId: input.requestId,
    requestClient: "discord",
    sessionId: input.sessionId,
    source: "external",
    platform: "discord",
    sessionRef,
    ...(input.userId
      ? {
          authenticatedOrigin: {
            platform: "discord" as const,
            userId: input.userId,
            sessionRef,
          },
        }
      : {}),
    authenticationMetadataKind: input.userId ? "origin" : "absent",
    verifiedIngress: input.verifiedIngress ?? input.userId !== undefined,
  };
}

type BuildEnvSnapshot = {
  LILAC_BUILD_VERSION: string | undefined;
  LILAC_BUILD_COMMIT: string | undefined;
  LILAC_BUILD_DIRTY: string | undefined;
  LILAC_BUILD_AT: string | undefined;
};

function setMockMemoryUsage(memory: ReturnType<typeof process.memoryUsage>) {
  process.memoryUsage = (() => memory) as typeof process.memoryUsage;
}

function snapshotBuildEnv(): BuildEnvSnapshot {
  return {
    LILAC_BUILD_VERSION: process.env.LILAC_BUILD_VERSION,
    LILAC_BUILD_COMMIT: process.env.LILAC_BUILD_COMMIT,
    LILAC_BUILD_DIRTY: process.env.LILAC_BUILD_DIRTY,
    LILAC_BUILD_AT: process.env.LILAC_BUILD_AT,
  };
}

function restoreBuildEnv(snapshot: BuildEnvSnapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

async function writePluginServerTool(params: {
  dataDir: string;
  pluginId: string;
  callableId: string;
  value: string;
}): Promise<void> {
  const pluginDir = path.join(params.dataDir, "plugins", params.pluginId, "dist");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "..", "package.json"),
    JSON.stringify(
      {
        name: params.pluginId,
        version: "0.0.1",
        lilac: {
          plugin: "./dist/index.js",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `export default {
  meta: { id: "${params.pluginId}" },
  create() {
    return {
      level2: [{
        id: "${params.pluginId}",
        async init() {},
        async destroy() {},
        async list() { return [{ callableId: "${params.callableId}", name: "${params.callableId}", description: "${params.callableId}", shortInput: [], input: [] }]; },
        async call() { return { value: "${params.value}" }; },
      }],
    };
  },
};`,
    "utf8",
  );
}

describe("createToolServer", () => {
  it("rejects an invalid operator-token digest through the host option adapter", () => {
    expect(() => createToolServer({ operatorTokenSha256: "not-a-sha256-digest" })).toThrow(
      "operatorTokenSha256 must be a SHA-256 hex digest",
    );
  });

  it("redacts nested sensitive JSON fields before ordinary tool-input logging", async () => {
    const chunks: string[] = [];
    const secret = "ordinary-tool-secret";
    const tool: ServerTool = {
      id: "preview-redaction",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "preview.redaction",
            name: "Preview redaction",
            description: "Tests input logging",
            shortInput: [],
          },
        ];
      },
      async call() {
        return { ok: true };
      },
    };
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const server = createToolServer({
      tools: [tool],
      logger: createLogger({
        module: "tool-preview-redaction-test",
        logLevel: "debug",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
    });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callableId: "preview.redaction",
            input: { nested: { authorization: secret }, visible: "retained" },
          }),
        }),
      );
      expect(await response.json()).toEqual({ isError: false, output: { ok: true } });
      const logged = chunks.join("\n");
      expect(logged).toContain("<redacted>");
      expect(logged).toContain("retained");
      expect(logged).not.toContain(secret);
    } finally {
      await server.stop();
    }
  });

  it("projects opaque unhandled rejections without serializing TaggedError fields", async () => {
    class SecretUnhandledRejection extends TaggedError("SecretUnhandledRejection")<{
      readonly token: string;
      readonly message: string;
    }> {}
    const secret = "unhandled-rejection-secret";
    const server = createToolServer({ tools: [] });
    await server.init();
    try {
      server.recordUnhandledRejection(
        new SecretUnhandledRejection({ token: secret, message: `token=${secret}` }),
      );
      const snapshot = await server.getHealthSnapshot();
      expect(snapshot.info.unhandledRejection).toMatchObject({
        count: 1,
        lastReason: "External tagged error",
      });
      expect(JSON.stringify(snapshot.info.unhandledRejection)).not.toContain(secret);
    } finally {
      await server.stop();
    }
  });

  it("uses the same request capability and native profile context for direct and workflow children", async () => {
    const contexts: RequestContext[] = [];
    const authority = new RequestControlAuthority();
    const capabilities = new Map<string, string>();
    for (const requestId of ["sub:direct", "wfr:workflow"] as const) {
      const workflowChild = requestId === "wfr:workflow";
      capabilities.set(
        requestId,
        authority.issue({
          kind: "primary",
          requestId,
          sessionId: workflowChild ? "workflow-child-session" : "origin-session",
          platform: workflowChild ? "unknown" : "discord",
          principal: { platform: "discord", userId: "user-1" },
          authenticatedOrigin: {
            platform: "discord",
            userId: "user-1",
            sessionRef: { platform: "discord", channelId: "origin-session" },
          },
          allowedCallables: null,
          profile: "general",
          canonicalCwd: "/selected/child/cwd",
          safetyMode: "trusted",
          expiresAt: Date.now() + 60_000,
        }),
      );
    }
    const tool: ServerTool = {
      id: "native-child-test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "workflow.test",
            name: "Workflow Test",
            description: "ordinary native-profile callable",
            shortInput: [],
          },
        ];
      },
      async call(_callableId, _input, options) {
        if (options?.context) contexts.push(options.context);
        return { ok: true };
      },
    };
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get: () => [{ role: "user", content: "cached" }],
        getOrigin: (requestId) =>
          requestId === "wfr:workflow"
            ? {
                requestId,
                requestClient: "unknown",
                sessionId: "workflow-child-session",
                source: "internal-delegated",
                authenticatedOrigin: {
                  platform: "discord",
                  userId: "user-1",
                  sessionRef: { platform: "discord", channelId: "origin-session" },
                },
                authenticationMetadataKind: "origin",
                verifiedIngress: false,
              }
            : discordRequestProjection({
                requestId,
                sessionId: "origin-session",
                userId: "user-1",
              }),
      },
      authorizeControlRequest: (input) => authority.authorize(input),
    });
    await server.init();
    try {
      for (const requestId of ["sub:direct", "wfr:workflow"] as const) {
        const capability = capabilities.get(requestId);
        if (!capability) throw new Error(`missing test capability for ${requestId}`);
        const workflowChild = requestId === "wfr:workflow";
        const headers = {
          "x-lilac-request-id": requestId,
          "x-lilac-session-id": workflowChild ? "workflow-child-session" : "origin-session",
          "x-lilac-request-client": workflowChild ? "unknown" : "discord",
          "x-lilac-cwd": "/selected/child/cwd",
          "x-lilac-control-capability": capability,
        };
        const list = await server.app.handle(new Request("http://localhost/list", { headers }));
        expect(await list.json()).toMatchObject({ tools: [{ callableId: "workflow.test" }] });
        expect(
          (await server.app.handle(new Request("http://localhost/help/workflow.test", { headers })))
            .status,
        ).toBe(200);
        const call = await server.app.handle(
          new Request("http://localhost/call", {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ callableId: "workflow.test", input: {} }),
          }),
        );
        expect(await call.json()).toMatchObject({ isError: false, output: { ok: true } });
      }
      expect(
        contexts.map(
          ({
            cwd,
            subagentProfile,
            controlPolicy,
            authenticatedPrincipal,
            authenticatedPrincipalSessionId,
            safetyMode,
          }) => ({
            cwd,
            subagentProfile,
            controlPolicy,
            authenticatedPrincipal,
            authenticatedPrincipalSessionId,
            safetyMode,
          }),
        ),
      ).toEqual([
        {
          cwd: "/selected/child/cwd",
          subagentProfile: "general",
          controlPolicy: { kind: "primary", allowedCallables: null },
          authenticatedPrincipal: { platform: "discord", userId: "user-1" },
          authenticatedPrincipalSessionId: "origin-session",
          safetyMode: "trusted",
        },
        {
          cwd: "/selected/child/cwd",
          subagentProfile: "general",
          controlPolicy: { kind: "primary", allowedCallables: null },
          authenticatedPrincipal: { platform: "discord", userId: "user-1" },
          authenticatedPrincipalSessionId: "origin-session",
          safetyMode: "trusted",
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("enforces the capability-bound native profile without trusting the profile header", async () => {
    const authority = new RequestControlAuthority();
    const capability = authority.issue({
      kind: "primary",
      requestId: "native-profile-capability",
      sessionId: "native-profile-session",
      platform: "discord",
      principal: null,
      authenticatedOrigin: null,
      allowedCallables: null,
      profile: "general",
      canonicalCwd: "/workspace",
      safetyMode: "trusted",
      expiresAt: Date.now() + 60_000,
    });
    const calls: string[] = [];
    const tool: ServerTool = {
      id: "profile-plugin",
      async init() {},
      async destroy() {},
      async list() {
        return ["profile.allowed", "profile.denied"].map((callableId) => ({
          callableId,
          name: callableId,
          description: callableId,
          shortInput: [],
        }));
      },
      async call(callableId) {
        calls.push(callableId);
        return { callableId };
      },
    };
    const pluginManager = {
      async init() {
        return Result.ok();
      },
      async destroy() {
        return Result.ok();
      },
      async reload() {
        return Result.ok();
      },
      async ensureFresh() {
        return Result.ok();
      },
      getLevel2Tools: () => [tool],
      getLevel2ContributionInfo: () =>
        new Map([[tool, { pluginId: "profile-plugin", source: "builtin" as const }]]),
    };
    const config = parseCoreConfigV2ToUniversal({
      configVersion: 2,
      agent: {
        subagents: {
          profiles: {
            general: {
              level2: {
                callables: ["profile.allowed"],
                plugins: ["profile-plugin"],
              },
            },
          },
        },
      },
    });
    const server = createToolServer({
      pluginManager,
      getConfig: async () => config,
      requestMessageCache: {
        get: () => [{ role: "user", content: "cached" }],
        getOrigin: (requestId) =>
          discordRequestProjection({ requestId, sessionId: "native-profile-session" }),
      },
      authorizeControlRequest: (input) => authority.authorize(input),
    });
    await server.init();
    const headers = {
      "x-lilac-request-id": "native-profile-capability",
      "x-lilac-session-id": "native-profile-session",
      "x-lilac-request-client": "discord",
      "x-lilac-cwd": "/workspace",
      "x-lilac-control-capability": capability,
    };
    try {
      const list = await server.app.handle(new Request("http://localhost/list", { headers }));
      expect(await list.json()).toMatchObject({
        tools: [{ callableId: "profile.allowed" }],
      });

      const denied = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "x-lilac-subagent-profile": "self",
          },
          body: JSON.stringify({ callableId: "profile.denied", input: {} }),
        }),
      );
      expect(await denied.json()).toEqual({
        isError: true,
        output: "Tool 'profile.denied' is not enabled for this subagent profile",
      });
      expect(calls).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("requires a request-bound control capability on list, help, and call", async () => {
    const contexts: RequestContext[] = [];
    const tool: ServerTool = {
      id: "control-test",
      async init() {},
      async destroy() {},
      async list() {
        return [{ callableId: "control.read", name: "read", description: "read", shortInput: [] }];
      },
      async call(_callableId, _input, options) {
        if (options?.context) contexts.push(options.context);
        return { ok: true };
      },
    };
    const server = createToolServer({
      tools: [tool],
      canonicalWorkspaceRoot: "/workspace",
      requestMessageCache: {
        get: () => [{ role: "user", content: "cached" }],
        getOrigin: (requestId) =>
          discordRequestProjection({ requestId, sessionId: "channel-1", userId: "user-1" }),
      },
      authorizeControlRequest: (input) =>
        input.token === "unguessable-primary-token" &&
        input.requestId === "request-1" &&
        input.sessionId === "channel-1" &&
        input.platform === "discord"
          ? {
              kind: "primary" as const,
              principal: { platform: "discord" as const, userId: "user-1" },
              authenticatedOrigin: {
                platform: "discord" as const,
                userId: "user-1",
                sessionRef: { platform: "discord" as const, channelId: "channel-1" },
              },
              allowedCallables: null,
              profile: "primary" as const,
              canonicalCwd: "/workspace",
              safetyMode: "trusted" as const,
            }
          : null,
    });
    await server.init();
    const headers = {
      "x-lilac-request-id": "request-1",
      "x-lilac-session-id": "channel-1",
      "x-lilac-request-client": "discord",
      "x-lilac-cwd": "/attacker-controlled",
      "x-lilac-control-capability": "unguessable-primary-token",
    };
    try {
      expect((await server.app.handle(new Request("http://localhost/list"))).status).toBe(500);
      expect(
        (await server.app.handle(new Request("http://localhost/list", { headers }))).status,
      ).toBe(200);
      expect(
        (await server.app.handle(new Request("http://localhost/help/control.read", { headers })))
          .status,
      ).toBe(200);
      expect(
        await (
          await server.app.handle(
            new Request("http://localhost/call", {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ callableId: "control.read", input: {} }),
            }),
          )
        ).json(),
      ).toMatchObject({ isError: false, output: { ok: true } });
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.cwd).toBe("/workspace");
      expect(
        (
          await server.app.handle(
            new Request("http://localhost/list", {
              headers: { ...headers, "x-lilac-session-id": "other-channel" },
            }),
          )
        ).status,
      ).toBe(500);
    } finally {
      await server.stop();
    }
  });

  it("rejects a control capability whose principal conflicts with the cached origin", async () => {
    const server = createToolServer({
      tools: [],
      requestMessageCache: {
        get: () => [{ role: "user", content: "cached" }],
        getOrigin: (requestId) => ({
          requestId,
          requestClient: "discord",
          sessionId: "channel-1",
          source: "external",
          platform: "discord",
          sessionRef: { platform: "discord", channelId: "channel-1" },
          authenticatedOrigin: {
            platform: "discord",
            userId: "user-1",
            sessionRef: { platform: "discord", channelId: "channel-1" },
          },
          authenticationMetadataKind: "origin",
          verifiedIngress: true,
        }),
      },
      authorizeControlRequest: () => ({
        kind: "primary",
        principal: { platform: "discord", userId: "user-2" },
        authenticatedOrigin: {
          platform: "discord",
          userId: "user-2",
          sessionRef: { platform: "discord", channelId: "channel-1" },
        },
        allowedCallables: null,
        profile: "primary",
        canonicalCwd: "/workspace",
        safetyMode: "trusted",
      }),
    });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/list", {
          headers: {
            "x-lilac-request-id": "request-1",
            "x-lilac-session-id": "channel-1",
            "x-lilac-request-client": "discord",
            "x-lilac-cwd": "/workspace",
            "x-lilac-control-capability": "capability",
          },
        }),
      );
      expect(response.status).toBe(500);
    } finally {
      await server.stop();
    }
  });

  it("rejects primary capabilities after their cached projection is missing or expired", async () => {
    const authority = new RequestControlAuthority();
    const capability = authority.issue({
      kind: "primary",
      requestId: "expired-cache-request",
      sessionId: "channel-1",
      platform: "discord",
      principal: { platform: "discord", userId: "user-1" },
      authenticatedOrigin: {
        platform: "discord",
        userId: "user-1",
        sessionRef: { platform: "discord", channelId: "channel-1" },
      },
      allowedCallables: null,
      profile: "primary",
      canonicalCwd: "/workspace",
      safetyMode: "trusted",
      expiresAt: Date.now() + 60_000,
    });
    const server = createToolServer({
      tools: [],
      requestMessageCache: { get: () => undefined, getOrigin: () => undefined },
      authorizeControlRequest: (input) => authority.authorize(input),
    });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/list", {
          headers: {
            "x-lilac-request-id": "expired-cache-request",
            "x-lilac-session-id": "channel-1",
            "x-lilac-request-client": "discord",
            "x-lilac-cwd": "/workspace",
            "x-lilac-control-capability": capability,
          },
        }),
      );
      expect(response.status).toBe(500);
    } finally {
      await server.stop();
    }
  });

  it("keeps standalone non-operator requests restricted", async () => {
    const tool: ServerTool = {
      id: "standalone-restricted",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "workflow.standalone-restricted",
            name: "restricted",
            description: "restricted",
            shortInput: [],
          },
        ];
      },
      async call() {
        return { ok: true };
      },
    };
    const server = createToolServerImpl({ tools: [tool] });
    await server.init();
    try {
      const listed = await server.app.handle(new Request("http://localhost/list"));
      expect(await listed.json()).toEqual({ tools: [] });
      const called = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callableId: "workflow.standalone-restricted", input: {} }),
        }),
      );
      expect(await called.json()).toMatchObject({
        isError: true,
        output: expect.stringContaining("restricted public-session mode"),
      });
    } finally {
      await server.stop();
    }
  });

  it("applies verified GitHub and validated Discord safety precedence without inventing principals", async () => {
    const contexts: RequestContext[] = [];
    let discordPolicyCalls = 0;
    const tool: ServerTool = {
      id: "safety-precedence",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "workflow.safety-precedence",
            name: "safety",
            description: "safety",
            shortInput: [],
          },
        ];
      },
      async call(_callableId, _input, options) {
        if (options?.context) contexts.push(options.context);
        return { ok: true };
      },
    };
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get: () => [{ role: "user", content: "cached" }],
        getOrigin: (requestId) => {
          const github = requestId === "github-request";
          if (github) {
            return {
              requestId,
              requestClient: "github",
              sessionId: "owner/repo#1",
              source: "external",
              platform: "github",
              sessionRef: { platform: "github", channelId: "owner/repo#1" },
              authenticationMetadataKind: "github-trigger",
              verifiedIngress: true,
            };
          }
          return {
            requestId,
            requestClient: "discord",
            sessionId: "channel-1",
            source: "external",
            platform: "discord",
            sessionRef: { platform: "discord", channelId: "channel-1" },
            authenticationMetadataKind: "origin",
            verifiedIngress: true,
          };
        },
      },
      resolveServerSafetyMode: async () => {
        discordPolicyCalls += 1;
        return "trusted";
      },
    });
    await server.init();
    try {
      for (const [requestId, sessionId, requestClient] of [
        ["github-request", "owner/repo#1", "github"],
        ["discord-request", "channel-1", "discord"],
      ] as const) {
        const response = await server.app.handle(
          new Request("http://localhost/call", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-lilac-request-id": requestId,
              "x-lilac-session-id": sessionId,
              "x-lilac-request-client": requestClient,
            },
            body: JSON.stringify({ callableId: "workflow.safety-precedence", input: {} }),
          }),
        );
        expect(await response.json()).toMatchObject({ isError: false });
      }
      expect(discordPolicyCalls).toBe(1);
      expect(contexts.map((context) => context.authenticatedPrincipal)).toEqual([
        undefined,
        undefined,
      ]);
    } finally {
      await server.stop();
    }
  });

  it("keeps actor-only GitHub principals restricted without verified trigger metadata", async () => {
    const contexts: RequestContext[] = [];
    const tool: ServerTool = {
      id: "github-actor-only",
      async init() {},
      async destroy() {},
      async list() {
        return [{ callableId: "fetch", name: "fetch", description: "fetch", shortInput: [] }];
      },
      async call(_callableId, _input, options) {
        if (options?.context) contexts.push(options.context);
        return { ok: true };
      },
    };
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get: () => [{ role: "user", content: "cached" }],
        getOrigin: (requestId) => ({
          requestId,
          requestClient: "github",
          sessionId: "owner/repo#1",
          source: "external",
          platform: "github",
          sessionRef: { platform: "github", channelId: "owner/repo#1" },
          authenticatedOrigin: {
            platform: "github",
            userId: "octocat",
            sessionRef: { platform: "github", channelId: "owner/repo#1" },
          },
          authenticationMetadataKind: "actor",
          verifiedIngress: false,
        }),
      },
    });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-lilac-request-id": "github-actor-only",
            "x-lilac-session-id": "owner/repo#1",
            "x-lilac-request-client": "github",
          },
          body: JSON.stringify({ callableId: "fetch", input: {} }),
        }),
      );
      expect(await response.json()).toMatchObject({ isError: false });
      expect(contexts[0]).toMatchObject({
        safetyMode: "restricted",
        serverOwnedRequest: false,
        authenticatedPrincipal: { platform: "github", userId: "octocat" },
        authenticatedPrincipalSessionId: "owner/repo#1",
      });
    } finally {
      await server.stop();
    }
  });

  it("grants full trusted access only to the hashed operator token", async () => {
    const token = "operator-token-for-focused-test";
    const contexts: RequestContext[] = [];
    const tool: ServerTool = {
      id: "operator-test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "workflow.operator-test",
            name: "operator test",
            description: "operator test",
            shortInput: [],
          },
        ];
      },
      async call(_callableId, _input, options) {
        if (options?.context) contexts.push(options.context);
        return { ok: true };
      },
    };
    const server = createToolServer({
      tools: [tool],
      canonicalWorkspaceRoot: "/canonical-workspace",
      operatorTokenSha256: createHash("sha256").update(token).digest("hex"),
      authorizeControlRequest: () => null,
      resolveServerSafetyMode: async () => "restricted",
    });
    await server.init();
    const headers = {
      "x-lilac-operator-token": token,
      "x-lilac-request-id": "operator:request-1",
      "x-lilac-tool-call-id": "operator:request-1",
    };
    try {
      expect(
        (
          await server.app.handle(
            new Request("http://localhost/list", {
              headers: { "x-lilac-operator-token": "wrong-token" },
            }),
          )
        ).status,
      ).toBe(500);
      expect(
        await (await server.app.handle(new Request("http://localhost/list", { headers }))).json(),
      ).toMatchObject({ tools: [{ callableId: "workflow.operator-test" }] });
      expect(
        (
          await server.app.handle(
            new Request("http://localhost/help/workflow.operator-test", { headers }),
          )
        ).status,
      ).toBe(200);
      expect(
        await (
          await server.app.handle(
            new Request("http://localhost/call", {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ callableId: "workflow.operator-test", input: {} }),
            }),
          )
        ).json(),
      ).toMatchObject({ isError: false, output: { ok: true } });
      expect(
        await (
          await server.app.handle(
            new Request("http://localhost/call", {
              method: "POST",
              headers: {
                ...headers,
                "content-type": "application/json",
                "x-lilac-cwd": "/operator-selected-project",
              },
              body: JSON.stringify({ callableId: "workflow.operator-test", input: {} }),
            }),
          )
        ).json(),
      ).toMatchObject({ isError: false, output: { ok: true } });
      expect(contexts).toEqual([
        {
          requestId: "operator:request-1",
          toolCallId: "operator:request-1",
          cwd: "/canonical-workspace",
          safetyMode: "trusted",
          serverOwnedRequest: true,
          operator: true,
        },
        {
          requestId: "operator:request-1",
          toolCallId: "operator:request-1",
          cwd: "/canonical-workspace",
          safetyMode: "trusted",
          serverOwnedRequest: true,
          operator: true,
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("limits heartbeat authority to its internal callable allowlist", async () => {
    const called: string[] = [];
    const tool: ServerTool = {
      id: "heartbeat-capability-test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "surface.messages.send",
            name: "send",
            description: "send",
            shortInput: [],
          },
          { callableId: "workflow.start", name: "start", description: "start", shortInput: [] },
          { callableId: "read_file", name: "read", description: "read", shortInput: [] },
        ];
      },
      async call(callableId, _input, options) {
        called.push(callableId);
        expect(options?.context?.cwd).toBe("/canonical-workspace");
        expect(options?.context?.authenticatedPrincipal).toBeUndefined();
        return { ok: true };
      },
    };
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get: () => undefined,
        getOrigin: () => undefined,
      },
      authorizeControlRequest: ({ token }) =>
        token === "heartbeat-capability-token"
          ? {
              kind: "heartbeat" as const,
              principal: null,
              authenticatedOrigin: null,
              allowedCallables: ["surface.messages.send"],
              profile: "primary" as const,
              canonicalCwd: "/canonical-workspace",
              safetyMode: "trusted" as const,
            }
          : null,
    });
    await server.init();
    const headers = {
      "x-lilac-request-id": "heartbeat:request-1",
      "x-lilac-session-id": "heartbeat:discord:channel-1",
      "x-lilac-request-client": "discord",
      "x-lilac-cwd": "/stale-cache-workspace",
      "x-lilac-safety-mode": "restricted",
      "x-lilac-control-capability": "heartbeat-capability-token",
    };
    try {
      const list = await server.app.handle(new Request("http://localhost/list", { headers }));
      expect(await list.json()).toMatchObject({
        tools: [{ callableId: "surface.messages.send" }],
      });

      const deniedHelp = await server.app.handle(
        new Request("http://localhost/help/workflow.start", { headers }),
      );
      expect(deniedHelp.status).toBe(404);

      const deniedCall = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ callableId: "read_file", input: { path: "README.md" } }),
        }),
      );
      expect(await deniedCall.json()).toMatchObject({
        isError: true,
        output: expect.stringContaining("outside the internal request capability"),
      });

      const deniedAttachment = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            callableId: "surface.messages.send",
            input: { content: "due", paths: ["secret.txt"] },
          }),
        }),
      );
      expect(await deniedAttachment.json()).toMatchObject({
        isError: true,
        output: expect.stringContaining("text-only"),
      });

      const allowedCall = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ callableId: "surface.messages.send", input: { content: "due" } }),
        }),
      );
      expect(await allowedCall.json()).toMatchObject({ isError: false, output: { ok: true } });
      expect(called).toEqual(["surface.messages.send"]);
    } finally {
      await server.stop();
    }
  });

  let tmpRoot: string | null = null;

  afterEach(async () => {
    process.memoryUsage = originalMemoryUsage;
    if (!tmpRoot) return;
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("passes x-lilac request context and cached messages to tool.call", async () => {
    const seenCalls: Array<{
      callableId: string;
      input: Record<string, unknown>;
      requestId?: string;
      sessionId?: string;
      requestClient?: string;
      cwd?: string;
      messages?: readonly unknown[];
      serverOwnedRequest?: boolean;
    }> = [];

    const tool: ServerTool = {
      id: "test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "test.echo",
            name: "Test Echo",
            description: "echo",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call(callableId, input, opts) {
        seenCalls.push({
          callableId,
          input,
          requestId: opts?.context?.requestId,
          sessionId: opts?.context?.sessionId,
          requestClient: opts?.context?.requestClient,
          cwd: opts?.context?.cwd,
          messages: opts?.messages,
          serverOwnedRequest: opts?.context?.serverOwnedRequest,
        });
        return { ok: true, echo: input };
      },
    };

    const cachedMessages = [{ role: "user", content: "cached" }];
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get(requestId: string) {
          return requestId === "req:1" ? cachedMessages : undefined;
        },
        getOrigin: (requestId) =>
          requestId === "req:1"
            ? {
                requestId,
                requestClient: "discord",
                sessionId: "chan",
                source: "external",
                platform: "discord",
                sessionRef: { platform: "discord", channelId: "chan" },
                authenticatedOrigin: {
                  platform: "discord",
                  userId: "user-1",
                  sessionRef: { platform: "discord", channelId: "chan" },
                },
                authenticationMetadataKind: "origin",
                verifiedIngress: true,
              }
            : undefined,
      },
      resolveServerSafetyMode: async () => "trusted",
    });

    await server.init();

    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lilac-request-id": "req:1",
          "x-lilac-session-id": "chan",
          "x-lilac-request-client": "discord",
          "x-lilac-cwd": "/tmp/work",
        },
        body: JSON.stringify({
          callableId: "test.echo",
          input: { hello: "world" },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ isError: false, output: { ok: true, echo: { hello: "world" } } });

    const captured = seenCalls[0]!;
    expect(captured.callableId).toBe("test.echo");
    expect(captured.input).toEqual({ hello: "world" });
    expect(captured.requestId).toBe("req:1");
    expect(captured.sessionId).toBe("chan");
    expect(captured.requestClient).toBe("discord");
    expect(captured.cwd).toBe("/tmp/work");
    expect(captured.messages).toEqual(cachedMessages);
    expect(captured.serverOwnedRequest).toBe(true);
  });

  it("includes primary positional metadata in list and help responses", async () => {
    const tool: ServerTool = {
      id: "test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "fetch",
            name: "Fetch",
            description: "Fetch a web page",
            shortInput: ["--url=<string>"],
            input: ["--url=<string>"],
            primaryPositional: {
              field: "url",
              variadic: true,
            },
          },
        ];
      },
      async call() {
        return { ok: true };
      },
    };

    const server = createToolServer({
      tools: [tool],
    });

    await server.init();

    const listRes = await server.app.handle(new Request("http://localhost/list"));
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual({
      tools: [
        {
          callableId: "fetch",
          name: "Fetch",
          description: "Fetch a web page",
          shortInput: ["--url=<string>"],
          primaryPositional: {
            field: "url",
            variadic: true,
          },
          hidden: undefined,
        },
      ],
    });

    const helpRes = await server.app.handle(new Request("http://localhost/help/fetch"));
    expect(helpRes.status).toBe(200);
    expect(await helpRes.json()).toEqual({
      callableId: "fetch",
      name: "Fetch",
      description: "Fetch a web page",
      shortInput: ["--url=<string>"],
      input: ["--url=<string>"],
      primaryPositional: {
        field: "url",
        variadic: true,
      },
    });

    await server.stop();
  });

  it("filters and rejects restricted public-session callables", async () => {
    const calls: string[] = [];
    const tool: ServerTool = {
      id: "test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "attachment.add_files",
            name: "Attachment Add Files",
            description: "Attachment add files",
            shortInput: [],
            input: [],
          },
          {
            callableId: "attachment.download",
            name: "Attachment Download",
            description: "Attachment download",
            shortInput: [],
            input: [],
          },
          {
            callableId: "discovery.search",
            name: "Discovery Search",
            description: "Discovery search",
            shortInput: [],
            input: [],
          },
          {
            callableId: "fetch",
            name: "Fetch",
            description: "Fetch a web page",
            shortInput: [],
            input: [],
          },
          {
            callableId: "generate.image",
            name: "Generate Image",
            description: "Generate image",
            shortInput: [],
            input: [],
          },
          {
            callableId: "generate.video",
            name: "Generate Video",
            description: "Generate video",
            shortInput: [],
            input: [],
          },
          {
            callableId: "onboarding.restart",
            name: "Restart",
            description: "Restart",
            shortInput: [],
            input: [],
          },
          {
            callableId: "surface.messages.delete",
            name: "Delete",
            description: "Delete",
            shortInput: [],
            input: [],
          },
          {
            callableId: "surface.messages.edit",
            name: "Edit",
            description: "Edit",
            shortInput: [],
            input: [],
          },
          {
            callableId: "surface.messages.send",
            name: "Send",
            description: "Send",
            shortInput: [],
            input: [],
          },
          {
            callableId: "surface.reactions.remove",
            name: "Remove Reaction",
            description: "Remove reaction",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call(callableId) {
        calls.push(callableId);
        return { ok: true, callableId };
      },
    };

    const server = createToolServer({
      tools: [tool],
    });

    await server.init();

    const restrictedHeaders = {
      "x-lilac-safety-mode": "restricted",
      "x-lilac-session-id": "chan",
      "x-lilac-request-id": "req:1",
      "x-lilac-request-client": "discord",
    };

    const listRes = await server.app.handle(
      new Request("http://localhost/list", {
        headers: restrictedHeaders,
      }),
    );
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual({
      tools: [
        {
          callableId: "attachment.add_files",
          name: "Attachment Add Files",
          description: "Attachment add files",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "attachment.download",
          name: "Attachment Download",
          description: "Attachment download",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "discovery.search",
          name: "Discovery Search",
          description: "Discovery search",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "fetch",
          name: "Fetch",
          description: "Fetch a web page",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "generate.image",
          name: "Generate Image",
          description: "Generate image",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "generate.video",
          name: "Generate Video",
          description: "Generate video",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "surface.messages.delete",
          name: "Delete",
          description: "Delete",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "surface.messages.edit",
          name: "Edit",
          description: "Edit",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "surface.messages.send",
          name: "Send",
          description: "Send",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
        {
          callableId: "surface.reactions.remove",
          name: "Remove Reaction",
          description: "Remove reaction",
          shortInput: [],
          primaryPositional: undefined,
          hidden: undefined,
        },
      ],
    });

    const blockedRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          ...restrictedHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "onboarding.restart", input: {} }),
      }),
    );
    expect(blockedRes.status).toBe(200);
    expect(await blockedRes.json()).toEqual({
      isError: true,
      output: "Tool 'onboarding.restart' is not allowed in restricted public-session mode",
    });

    const crossSessionRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          ...restrictedHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callableId: "surface.messages.send",
          input: { sessionId: "other", text: "hi" },
        }),
      }),
    );
    expect(crossSessionRes.status).toBe(200);
    expect(await crossSessionRes.json()).toEqual({
      isError: true,
      output: "Tool 'surface.messages.send' is not allowed in restricted public-session mode",
    });

    const crossSessionEditRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          ...restrictedHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callableId: "surface.messages.edit",
          input: { sessionId: "other", messageId: "m1", text: "hi" },
        }),
      }),
    );
    expect(crossSessionEditRes.status).toBe(200);
    expect(await crossSessionEditRes.json()).toEqual({
      isError: true,
      output: "Tool 'surface.messages.edit' is not allowed in restricted public-session mode",
    });

    const allowedRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          ...restrictedHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "fetch", input: { url: "https://example.com" } }),
      }),
    );
    expect(allowedRes.status).toBe(200);
    expect(await allowedRes.json()).toEqual({
      isError: false,
      output: { ok: true, callableId: "fetch" },
    });
    const discoveryRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          ...restrictedHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "discovery.search", input: { query: "context" } }),
      }),
    );
    expect(discoveryRes.status).toBe(200);
    expect(await discoveryRes.json()).toEqual({
      isError: false,
      output: { ok: true, callableId: "discovery.search" },
    });

    expect(calls).toEqual(["fetch", "discovery.search"]);

    await server.stop();
  });

  it("fails closed when server-side safety lookup fails for a privileged workflow call", async () => {
    let called = false;
    const tool: ServerTool = {
      id: "workflow-test",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "workflow.test",
            name: "Workflow Test",
            description: "privileged",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call() {
        called = true;
        return { ok: true };
      },
    };
    const server = createToolServer({
      tools: [tool],
      requestMessageCache: {
        get: (requestId) =>
          requestId === "request-1" ? [{ role: "user", content: "run workflow" }] : undefined,
        getOrigin: (requestId) =>
          requestId === "request-1"
            ? {
                requestId,
                requestClient: "discord",
                sessionId: "channel-1",
                source: "external",
                platform: "discord",
                sessionRef: { platform: "discord", channelId: "channel-1" },
                authenticatedOrigin: {
                  platform: "discord",
                  userId: "user-1",
                  sessionRef: { platform: "discord", channelId: "channel-1" },
                },
                authenticationMetadataKind: "origin",
                verifiedIngress: true,
              }
            : undefined,
      },
      getConfig: async () => {
        throw new Error("configuration unavailable");
      },
    });
    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-lilac-request-id": "request-1",
            "x-lilac-session-id": "channel-1",
            "x-lilac-request-client": "discord",
          },
          body: JSON.stringify({ callableId: "workflow.test", input: {} }),
        }),
      );
      expect(await response.json()).toEqual({
        isError: true,
        output: "Tool 'workflow.test' is not allowed in restricted public-session mode",
      });
      expect(called).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("supports plugin-backed list/call/reload flows", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-server-plugin-"));
    const dataDir = path.join(tmpRoot, "data");

    await writePluginServerTool({
      dataDir,
      pluginId: "echo-plugin",
      callableId: "echo.call",
      value: "one",
    });

    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir,
      adaptLevel1Item: (spec) => spec,
      adaptLevel2Item: (tool) => tool,
    });

    const server = createToolServer({
      pluginManager,
    });

    await server.init();

    const firstList = await server.app.handle(new Request("http://localhost/list"));
    expect(firstList.status).toBe(200);
    expect(await firstList.json()).toEqual({
      tools: [
        {
          callableId: "echo.call",
          name: "echo.call",
          description: "echo.call",
          shortInput: [],
          hidden: undefined,
        },
      ],
    });

    const firstCall = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "echo.call", input: {} }),
      }),
    );
    expect(await firstCall.json()).toEqual({ isError: false, output: { value: "one" } });

    // test-wait-justification: advances filesystem mtime so explicit reload observes the rewritten plugin bundle
    await Bun.sleep(5);
    await writePluginServerTool({
      dataDir,
      pluginId: "echo-plugin",
      callableId: "echo.call.v2",
      value: "two",
    });

    const reload = await server.app.handle(
      new Request("http://localhost/reload", {
        method: "POST",
      }),
    );
    expect(await reload.json()).toEqual({ ok: true });

    const secondList = await server.app.handle(new Request("http://localhost/list"));
    expect(await secondList.json()).toEqual({
      tools: [
        {
          callableId: "echo.call.v2",
          name: "echo.call.v2",
          description: "echo.call.v2",
          shortInput: [],
          hidden: undefined,
        },
      ],
    });

    const secondCall = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "echo.call.v2", input: {} }),
      }),
    );
    expect(await secondCall.json()).toEqual({ isError: false, output: { value: "two" } });

    await server.stop();
  });

  it("reads initialization-dependent and dynamic Level 2 catalogs at runtime", async () => {
    let listCalls = 0;
    let initialized = false;
    let callableId = "dynamic.call.v1";
    const tool: ServerTool = {
      id: "stateful-list",
      async init() {
        initialized = true;
      },
      async destroy() {},
      async list() {
        if (!initialized) throw new Error("list called before init");
        listCalls += 1;
        return [{ callableId, name: callableId, description: callableId, shortInput: [] }];
      },
      async call(callableId) {
        return { callableId };
      },
    };
    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir: "/tmp/tool-server-stateful-list-unused",
      builtinPlugins: [{ meta: { id: "stateful-list" }, create: () => ({ level2: [tool] }) }],
      adaptLevel1Item: (spec) => spec,
      adaptLevel2Item: (item) => item,
    });
    const server = createToolServer({ pluginManager });

    await server.init();
    expect(listCalls).toBe(2);
    callableId = "dynamic.call.v2";
    const listed = await server.app.handle(new Request("http://localhost/list"));
    expect(await listed.json()).toMatchObject({ tools: [{ callableId: "dynamic.call.v2" }] });
    expect(
      (await server.app.handle(new Request("http://localhost/help/dynamic.call.v2"))).status,
    ).toBe(200);
    const called = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "dynamic.call.v2", input: {} }),
      }),
    );
    expect(await called.json()).toEqual({
      isError: false,
      output: { callableId: "dynamic.call.v2" },
    });
    expect(listCalls).toBe(7);
    await server.stop();
  });

  it("refreshes routing after a committed reload whose previous-state cleanup fails", async () => {
    const chunks: string[] = [];
    let generation = 0;
    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir: "/tmp/tool-server-committed-cleanup-unused",
      builtinPlugins: [
        {
          meta: { id: "committed-cleanup" },
          create() {
            generation += 1;
            const current = generation;
            const callableId = `committed.call.${current}`;
            return {
              level2: [
                {
                  id: `committed-${current}`,
                  async init() {},
                  async destroy() {},
                  async list() {
                    return [
                      { callableId, name: callableId, description: callableId, shortInput: [] },
                    ];
                  },
                  async call() {
                    return { generation: current };
                  },
                },
              ],
              async destroy() {
                if (current === 1) throw new Error("previous cleanup failed");
              },
            };
          },
        },
      ],
      adaptLevel1Item: (spec) => spec,
      adaptLevel2Item: (item) => item,
    });
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const server = createToolServer({
      pluginManager,
      logger: createLogger({
        module: "committed-cleanup-test",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
    });

    await server.init();
    const reload = await server.app.handle(
      new Request("http://localhost/reload", { method: "POST" }),
    );
    expect(await reload.json()).toEqual({ ok: true });
    const called = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "committed.call.2", input: {} }),
      }),
    );
    expect(await called.json()).toEqual({ isError: false, output: { generation: 2 } });
    expect(chunks.join("\n")).toContain("reload committed");
    await server.stop();
  });

  it("refreshes plugin-backed call mapping on list/help/call without explicit reload", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-server-plugin-"));
    const dataDir = path.join(tmpRoot, "data");

    await writePluginServerTool({
      dataDir,
      pluginId: "fresh-plugin",
      callableId: "fresh.call",
      value: "one",
    });

    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir,
      adaptLevel1Item: (spec) => spec,
      adaptLevel2Item: (tool) => tool,
    });

    const server = createToolServer({ pluginManager });
    await server.init();

    // test-wait-justification: advances filesystem mtime so automatic freshness observes the rewritten plugin bundle
    await Bun.sleep(5);
    await writePluginServerTool({
      dataDir,
      pluginId: "fresh-plugin",
      callableId: "fresh.call.v2",
      value: "two",
    });

    const listRes = await server.app.handle(new Request("http://localhost/list"));
    expect(await listRes.json()).toEqual({
      tools: [
        {
          callableId: "fresh.call.v2",
          name: "fresh.call.v2",
          description: "fresh.call.v2",
          shortInput: [],
          hidden: undefined,
        },
      ],
    });

    const helpRes = await server.app.handle(new Request("http://localhost/help/fresh.call.v2"));
    expect(helpRes.status).toBe(200);

    const callRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ callableId: "fresh.call.v2", input: {} }),
      }),
    );
    expect(await callRes.json()).toEqual({ isError: false, output: { value: "two" } });

    await server.stop();
  });

  it("reports build metadata and loaded external plugin count from /versionz", async () => {
    const originalEnv = snapshotBuildEnv();
    process.env.LILAC_BUILD_VERSION = "2026.03.22";
    process.env.LILAC_BUILD_COMMIT = "abc123def456";
    process.env.LILAC_BUILD_DIRTY = "1";
    process.env.LILAC_BUILD_AT = "2026-03-22T00:00:00.000Z";

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-tool-server-plugin-"));
    const dataDir = path.join(tmpRoot, "data");

    await writePluginServerTool({
      dataDir,
      pluginId: "version-plugin",
      callableId: "version.call",
      value: "one",
    });

    const pluginManager = new ToolPluginManager<
      Record<string, never>,
      Level1ToolSpec<Record<string, never>>,
      ServerTool
    >({
      runtime: {},
      dataDir,
      adaptLevel1Item: (spec) => spec,
      adaptLevel2Item: (tool) => tool,
    });

    const server = createToolServer({ pluginManager });

    try {
      await server.init();

      const response = await server.app.handle(new Request("http://localhost/versionz"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        version: "2026.03.22",
        commit: "abc123def456",
        dirty: true,
        builtAt: "2026-03-22T00:00:00.000Z",
        plugins: {
          loadedExternal: 1,
        },
      });
    } finally {
      restoreBuildEnv(originalEnv);
      await server.stop();
    }
  });

  it("reports live and ready health separately", async () => {
    const server = createToolServer({
      tools: [],
      healthProvider: () => ({
        checks: [
          {
            name: "runtime.ready",
            ok: false,
            impact: "ready",
            reason: "warming up",
          },
        ],
        info: {
          runtime: {
            state: "warming",
          },
        },
      }),
      healthConfig: {
        eventLoopLagFailMs: 60_000,
        maxRssBytes: Number.MAX_SAFE_INTEGER,
      },
    });

    await server.init();
    await server.start(0);
    // test-wait-justification: allows the server health sampler to establish a baseline before rejection injection
    await Bun.sleep(5);
    server.recordUnhandledRejection(new Error("timer exploded"));

    const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
    const healthBody = (await healthRes.json()) as {
      live: boolean;
      ready: boolean;
      info: {
        external?: Record<string, unknown>;
        unhandledRejection?: {
          count: number;
          lastReason: string;
        };
      };
    };
    expect(healthBody.live).toBe(true);
    expect(healthBody.ready).toBe(false);
    expect(healthBody.info.external).toEqual({
      runtime: {
        state: "warming",
      },
    });
    expect(healthBody.info.unhandledRejection).toMatchObject({
      count: 1,
      lastReason: "timer exploded",
    });

    const readyRes = await server.app.handle(new Request("http://localhost/readyz"));
    const readyBody = (await readyRes.json()) as {
      ready: boolean;
    };
    expect(readyBody.ready).toBe(false);

    await server.stop();
  });

  it("ignores heap accounting and only uses rss for memory health", async () => {
    setMockMemoryUsage({
      rss: 300 * 1024 * 1024,
      heapUsed: 90 * 1024 * 1024,
      heapTotal: 70 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    });

    const server = createToolServer({
      tools: [],
      healthConfig: {
        eventLoopLagFailMs: 60_000,
        maxRssBytes: Number.MAX_SAFE_INTEGER,
      },
    });

    await server.init();
    await server.start(0);

    const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as {
      checks: Array<{ name: string; ok: boolean; details?: Record<string, unknown> }>;
    };
    const memoryCheck = healthBody.checks.find((check) => check.name === "process.memory");
    expect(memoryCheck?.ok).toBe(true);
    expect(memoryCheck?.details).toMatchObject({
      rss: 300 * 1024 * 1024,
      heapUsed: 90 * 1024 * 1024,
      heapTotal: 70 * 1024 * 1024,
    });

    await server.stop();
  });

  it("fails health when rss exceeds the limit", async () => {
    setMockMemoryUsage({
      rss: 300 * 1024 * 1024,
      heapUsed: 98 * 1024 * 1024,
      heapTotal: 100 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    });

    const server = createToolServer({
      tools: [],
      healthConfig: {
        eventLoopLagFailMs: 60_000,
        maxRssBytes: 256 * 1024 * 1024,
      },
    });

    await server.init();
    await server.start(0);

    const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
    expect(healthRes.status).toBe(503);
    const healthBody = (await healthRes.json()) as {
      checks: Array<{ name: string; ok: boolean; reason?: string }>;
    };
    expect(healthBody.checks.find((check) => check.name === "process.memory")).toMatchObject({
      ok: false,
      reason: `rss ${300 * 1024 * 1024} exceeded limit ${256 * 1024 * 1024}`,
    });

    await server.stop();
  });

  it("times out tool calls and marks wedged calls unhealthy", async () => {
    const tool: ServerTool = {
      id: "hang",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "hang.forever",
            name: "Hang Forever",
            description: "never resolves",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call() {
        return await new Promise(() => {});
      },
    };

    const server = createToolServer({
      tools: [tool],
      toolCallTimeouts: {
        defaultTimeoutMs: 20,
      },
      healthConfig: {
        eventLoopLagFailMs: 60_000,
        maxRssBytes: Number.MAX_SAFE_INTEGER,
        toolCallOverdueGraceMs: 10,
      },
    });

    await server.init();
    await server.start(0);

    const callRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callableId: "hang.forever",
          input: {},
        }),
      }),
    );
    expect(callRes.status).toBe(200);
    expect(await callRes.json()).toEqual({
      isError: true,
      output: "Tool call timed out after 20ms",
    });

    // test-wait-justification: crosses the overdue grace period after the real tool-call timeout fires
    await Bun.sleep(20);

    const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
    expect(healthRes.status).toBe(503);
    const healthBody = (await healthRes.json()) as {
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(healthBody.checks.find((check) => check.name === "tool-calls.overdue")?.ok).toBe(false);

    await server.stop();
  });

  it("reports an immediate Level 2 Panic to the fatal supervisor", async () => {
    const panic = new Panic({ message: "immediate tool invariant" });
    const observed = Promise.withResolvers<unknown>();
    const chunks: string[] = [];
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const tool: ServerTool = {
      id: "immediate-panic",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "immediate-panic.call",
            name: "Immediate Panic",
            description: "rejects immediately with Panic",
            shortInput: [],
          },
        ];
      },
      async call() {
        throw panic;
      },
    };
    const server = createToolServer({
      tools: [tool],
      logger: createLogger({
        module: "immediate-panic-test",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
      reportFatalToolCallDefect: observed.resolve,
    });

    await server.init();
    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "immediate-panic.call", input: {} }),
      }),
    );
    expect(response.status).toBe(500);
    expect(await observed.promise).toBe(panic);
    await server.stop();
  });

  it("invokes the fatal supervisor for a late Panic without changing the timeout response", async () => {
    const panic = new Panic({ message: "late tool invariant" });
    const observed = Promise.withResolvers<Panic>();
    let fatalReports = 0;
    const tool: ServerTool = {
      id: "late-panic",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "late-panic.call",
            name: "Late Panic",
            description: "rejects with Panic after cancellation",
            shortInput: [],
          },
        ];
      },
      async call(_callableId, _input, options) {
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(panic), { once: true });
        });
      },
    };
    const server = createToolServer({
      tools: [tool],
      toolCallTimeouts: { defaultTimeoutMs: 10 },
      reportFatalToolCallDefect: (reported) => {
        fatalReports += 1;
        if (Panic.is(reported)) observed.resolve(reported);
      },
    });

    await server.init();
    // test-wait-justification: verifies Panic observation after the real tool-call deadline wins
    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "late-panic.call", input: {} }),
      }),
    );
    expect(await response.json()).toEqual({
      isError: true,
      output: "Tool call timed out after 10ms",
    });
    expect(await observed.promise).toBe(panic);
    expect(fatalReports).toBe(1);
    await server.stop();
  });

  it("reports a late non-Panic rejection to the fatal supervisor", async () => {
    const defect = new Error("late logging defect");
    const observed = Promise.withResolvers<unknown>();
    const chunks: string[] = [];
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const logger = createLogger({
      module: "late-error-test",
      outputFormat: "jsonl",
      stdout: output,
      stderr: output,
    });
    Object.defineProperty(logger, "error", {
      value(message: string) {
        if (message === "tool plugin operation failed") throw defect;
      },
    });
    const tool: ServerTool = {
      id: "late-error",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "late-error.call",
            name: "Late Error",
            description: "settles through a broken logger after cancellation",
            shortInput: [],
          },
        ];
      },
      async call(_callableId, _input, options) {
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("expected plugin cancellation failure")),
            { once: true },
          );
        });
      },
    };
    const server = createToolServer({
      tools: [tool],
      logger,
      toolCallTimeouts: { defaultTimeoutMs: 10 },
      reportFatalToolCallDefect: observed.resolve,
    });

    await server.init();
    // test-wait-justification: verifies non-Panic defect observation after the real tool-call deadline
    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "late-error.call", input: {} }),
      }),
    );
    expect(await response.json()).toEqual({
      isError: true,
      output: "Tool call timed out after 10ms",
    });
    expect(await observed.promise).toMatchObject({ message: defect.message });
    await server.stop();
  });

  it("does not report an ordinary Level 2 completion after timeout", async () => {
    const release = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    let fatalReports = 0;
    const tool: ServerTool = {
      id: "late-success",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "late-success.call",
            name: "Late Success",
            description: "resolves after the caller deadline",
            shortInput: [],
          },
        ];
      },
      async call() {
        await release.promise;
        settled.resolve();
        return { late: true };
      },
    };
    const server = createToolServer({
      tools: [tool],
      toolCallTimeouts: { defaultTimeoutMs: 10 },
      reportFatalToolCallDefect: () => {
        fatalReports += 1;
      },
    });

    await server.init();
    // test-wait-justification: verifies ordinary completion after the real tool-call deadline
    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "late-success.call", input: {} }),
      }),
    );
    expect(await response.json()).toEqual({
      isError: true,
      output: "Tool call timed out after 10ms",
    });
    release.resolve();
    await settled.promise;
    await Promise.resolve();
    expect(fatalReports).toBe(0);
    await server.stop();
  });

  it("leaves internal result-orchestration defects on the framework error path", async () => {
    const defect = new Error("result logging defect");
    const chunks: string[] = [];
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const logger = createLogger({
      module: "result-orchestration-defect-test",
      outputFormat: "jsonl",
      stdout: output,
      stderr: output,
    });
    Object.defineProperty(logger, "info", {
      value(message: string) {
        if (message === "tool.call.result") throw defect;
      },
    });
    const tool: ServerTool = {
      id: "orchestration-defect",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "orchestration-defect.call",
            name: "Orchestration Defect",
            description: "completes before internal result logging fails",
            shortInput: [],
          },
        ];
      },
      async call() {
        return { ok: true };
      },
    };
    const server = createToolServer({ tools: [tool], logger });

    await server.init();
    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "orchestration-defect.call", input: {} }),
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('"isError":true');
    await server.stop();
  });

  it("does not leak active tool calls when tool.call throws synchronously", async () => {
    const tool: ServerTool = {
      id: "sync-throw",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "sync-throw.fail",
            name: "Sync Throw",
            description: "throws before returning a promise",
            shortInput: [],
            input: [],
          },
        ];
      },
      call() {
        throw new Error("sync boom");
      },
    };

    const server = createToolServer({
      tools: [tool],
      toolCallTimeouts: {
        defaultTimeoutMs: 20,
      },
      healthConfig: {
        eventLoopLagFailMs: 60_000,
        maxRssBytes: Number.MAX_SAFE_INTEGER,
        toolCallOverdueGraceMs: 10,
      },
    });

    await server.init();
    await server.start(0);

    const callRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callableId: "sync-throw.fail",
          input: {},
        }),
      }),
    );
    expect(await callRes.json()).toEqual({
      isError: true,
      output: "sync boom",
    });

    // test-wait-justification: crosses the timeout and overdue grace window to detect leaked synchronous failures
    await Bun.sleep(40);

    const healthRes = await server.app.handle(new Request("http://localhost/healthz"));
    const healthBody = (await healthRes.json()) as {
      checks: Array<{ name: string; ok: boolean }>;
      info: {
        toolServer: {
          activeCalls: unknown[];
        };
      };
    };
    expect(healthBody.checks.find((check) => check.name === "tool-calls.overdue")?.ok).toBe(true);
    expect(healthBody.info.toolServer.activeCalls).toEqual([]);

    await server.stop();
  });

  it("wraps external TaggedErrors without returning or logging their causes or secrets", async () => {
    class ExternalPluginSecretError extends TaggedError("ExternalPluginSecretError")<{
      readonly token: string;
      readonly message: string;
    }> {}
    const chunks: string[] = [];
    const secret = "plugin-tagged-secret-value";
    const tool: ServerTool = {
      id: "tagged-secret",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "tagged-secret.fail",
            name: "Tagged Secret",
            description: "throws an external TaggedError",
            shortInput: [],
          },
        ];
      },
      async call() {
        throw new ExternalPluginSecretError({ token: secret, message: `token=${secret}` });
      },
    };
    const output = { write: (chunk: string) => chunks.push(chunk) };
    const server = createToolServer({
      tools: [tool],
      logger: createLogger({
        module: "tagged-plugin-error-test",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
    });

    await server.init();
    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callableId: "tagged-secret.fail", input: {} }),
      }),
    );
    const body = await response.json();
    expect(body).toEqual({ isError: true, output: "External tagged error" });
    expect(`${JSON.stringify(body)}\n${chunks.join("\n")}`).not.toContain(secret);
    await server.stop();
  });

  it("returns guided validation errors for invalid tool input", async () => {
    const tool: ServerTool = {
      id: "validate",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "validate.input",
            name: "Validate Input",
            description: "validates request input",
            shortInput: ["--paths=<string | string[]>"],
            input: ["--paths=<string | string[]> | Local file paths"],
          },
        ];
      },
      async call(_callableId, input) {
        return parseToolInput({
          callableId: "validate.input",
          input,
          schema: z.object({
            paths: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
          }),
        });
      },
    };

    const server = createToolServer({
      tools: [tool],
    });

    await server.init();
    await server.start(0);

    const callRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callableId: "validate.input",
          input: {
            files: ["/tmp/generated-image.png"],
          },
        }),
      }),
    );

    expect(await callRes.json()).toEqual({
      isError: true,
      output: [
        "validate.input has invalid input.",
        "Missing or invalid fields: paths",
        "Provided keys: files",
        "Run 'tools --help validate.input' for details.",
      ].join("\n"),
    });

    await server.stop();
  });

  it("never logs mcp.add input or retained validation secrets", async () => {
    const chunks: string[] = [];
    const output = {
      write(chunk: string) {
        chunks.push(chunk);
      },
    };
    const tool: ServerTool = {
      id: "mcp-log-redaction",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "mcp.add",
            name: "MCP Add",
            description: "validates sensitive MCP input",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call(callableId, input) {
        if (input && typeof input === "object" && Reflect.get(input, "transport") === "stdio") {
          const error = new Error(`MCP runtime failed: ${JSON.stringify(input)}`);
          error.name = `McpRuntimeError:${Reflect.get(input, "env") ? "env-secret-value" : ""}`;
          throw error;
        }
        return parseToolInput({
          callableId,
          input,
          schema: z.strictObject({
            serverId: z.string(),
            transport: z.literal("http"),
            url: z.url(),
          }),
        });
      },
    };
    const server = createToolServer({
      tools: [tool],
      logger: createLogger({
        module: "mcp-log-redaction-test",
        logLevel: "debug",
        outputFormat: "jsonl",
        stdout: output,
        stderr: output,
      }),
    });
    const secrets = {
      clientSecret: "client-secret-value",
      authorization: "Bearer header-secret-value",
      envToken: "env-secret-value",
      commandToken: "command-token-value",
      argumentToken: "argument-token-value",
      code: "query-code-value",
      state: "query-state-value",
    };

    await server.init();
    try {
      const response = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callableId: "mcp.add",
            input: {
              transport: "http",
              url: `https://mcp.example/callback?code=${secrets.code}&state=${secrets.state}`,
              auth: {
                client: { clientSecret: secrets.clientSecret },
              },
              headers: { authorization: secrets.authorization },
              env: { MCP_TOKEN: secrets.envToken },
            },
          }),
        }),
      );
      const validationResult = await response.json();
      expect(validationResult).toEqual({
        isError: true,
        output: "mcp.add input validation failed",
      });

      const runtimeResponse = await server.app.handle(
        new Request("http://localhost/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            callableId: "mcp.add",
            input: {
              transport: "stdio",
              command: `bun --token=${secrets.commandToken}`,
              args: [`--api-key=${secrets.argumentToken}`],
              url: `https://mcp.example/callback?code=${secrets.code}&state=${secrets.state}`,
              auth: {
                client: { clientSecret: secrets.clientSecret },
              },
              headers: { authorization: secrets.authorization },
              env: { MCP_TOKEN: secrets.envToken },
            },
          }),
        }),
      );
      const runtimeResult = await runtimeResponse.json();
      expect(runtimeResult).toEqual({
        isError: true,
        output: "mcp.add failed without exposing sensitive configuration",
      });

      const logged = chunks.join("");
      expect(logged).toContain("<redacted mcp.add input>");
      expect(logged).toContain("McpAddError");
      expect(logged).not.toContain("MCP runtime failed");
      expect(logged).not.toContain("mcp.add has invalid input");
      expect(logged).not.toContain("?code=");
      const observableOutput = `${logged}\n${JSON.stringify({ validationResult, runtimeResult })}`;
      for (const secret of Object.values(secrets)) expect(observableOutput).not.toContain(secret);
    } finally {
      await server.stop();
    }
  });

  it("preserves runtime Zod errors that are not input parsing failures", async () => {
    const tool: ServerTool = {
      id: "validate-runtime",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "validate.runtime",
            name: "Validate Runtime",
            description: "parses non-input runtime data",
            shortInput: [],
            input: [],
          },
        ];
      },
      async call() {
        return z
          .object({
            tag: z.string(),
          })
          .parse({});
      },
    };

    const server = createToolServer({
      tools: [tool],
    });

    await server.init();
    await server.start(0);

    const callRes = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callableId: "validate.runtime",
          input: {},
        }),
      }),
    );

    const body = (await callRes.json()) as { isError: boolean; output: string };
    expect(body.isError).toBe(true);
    expect(body.output).toContain('"tag"');
    expect(body.output).not.toContain("validate.runtime has invalid input.");

    await server.stop();
  });

  it("keeps plugin startup failure fatal without leaking TaggedError", async () => {
    const failure = new ToolPluginHookError({
      pluginId: "startup",
      source: "builtin",
      hook: "plugin.create",
      cause: new Error("startup boom"),
      message: "startup boom",
    });
    const pluginManager = {
      init: async () => Result.err(failure),
      destroy: async () => Result.ok(),
      reload: async () => Result.ok(),
      ensureFresh: async () => Result.ok(),
      getLevel2Tools: () => [],
      getStatuses: () => [],
    };
    const server = createToolServer({ pluginManager });

    try {
      await server.init();
      throw new Error("expected startup failure");
    } catch (cause) {
      expect(cause).toBeInstanceOf(Error);
      expect(cause).not.toBe(failure);
      expect(cause instanceof Error ? cause.message : "").toContain("startup boom");
    }
  });

  it("omits tools whose list hook fails while retaining healthy tools", async () => {
    const healthy: ServerTool = {
      id: "healthy",
      async init() {},
      async destroy() {},
      async list() {
        return [
          { callableId: "healthy.call", name: "Healthy", description: "Healthy", shortInput: [] },
        ];
      },
      async call() {},
    };
    const broken: ServerTool = {
      id: "broken",
      async init() {},
      async destroy() {},
      async list() {
        throw new Error("list boom");
      },
      async call() {},
    };
    const server = createToolServer({ tools: [healthy, broken] });
    await server.init();
    const response = await server.app.handle(new Request("http://localhost/list"));
    expect(await response.json()).toEqual({
      tools: [
        {
          callableId: "healthy.call",
          name: "Healthy",
          description: "Healthy",
          shortInput: [],
          hidden: undefined,
        },
      ],
    });
    await server.stop();
  });

  it("propagates Panic from Level 2 hooks", async () => {
    const panic = new Panic({ message: "list invariant" });
    const tool: ServerTool = {
      id: "panic",
      async init() {},
      async destroy() {},
      async list() {
        throw panic;
      },
      async call() {},
    };
    const server = createToolServer({ tools: [tool] });
    try {
      await server.init();
      throw new Error("expected Panic");
    } catch (cause) {
      expect(Panic.is(cause)).toBe(true);
    }
  });

  it("continues shutdown after aggregated plugin cleanup failure", async () => {
    const hookFailure = new ToolPluginHookError({
      pluginId: "cleanup",
      source: "builtin",
      hook: "instance.destroy",
      cause: new Error("cleanup boom"),
      message: "cleanup boom",
    });
    const cleanupFailure = new ToolPluginCleanupError({
      failures: [hookFailure],
      message: "cleanup boom",
    });
    const pluginManager = {
      init: async () => Result.ok(),
      destroy: async () => Result.err(cleanupFailure),
      reload: async () => Result.ok(),
      ensureFresh: async () => Result.ok(),
      getLevel2Tools: () => [],
      getStatuses: () => [],
    };
    const server = createToolServer({ pluginManager });
    await server.init();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("stops the host and surfaces plugin cleanup Panic identity", async () => {
    const panic = new Panic({ message: "plugin cleanup invariant" });
    const pluginManager = {
      init: async () => Result.ok(),
      destroy: async () => {
        throw panic;
      },
      reload: async () => Result.ok(),
      ensureFresh: async () => Result.ok(),
      getLevel2Tools: () => [],
      getStatuses: () => [],
    };
    const server = createToolServer({ pluginManager });
    await server.init();
    await server.start(0);

    await expect(server.stop()).rejects.toBe(panic);
    expect(server.app.server).toBeNull();
  });

  it("invokes the unhealthy watchdog after repeated live failures", async () => {
    const unhealthySnapshots: ToolServerHealthSnapshot[] = [];
    const server = createToolServer({
      tools: [],
      healthProvider: () => ({
        checks: [
          {
            name: "runtime.redis",
            ok: false,
            impact: "live",
            reason: "redis ping failed",
          },
        ],
      }),
      onUnhealthy: async (snapshot) => {
        unhealthySnapshots.push(snapshot);
      },
      healthConfig: {
        watchdogIntervalMs: 10,
        watchdogFailureThreshold: 2,
      },
    });

    await server.init();
    await server.start(0);

    // test-wait-justification: allows two real watchdog intervals to trigger the configured unhealthy callback
    await Bun.sleep(40);

    expect(unhealthySnapshots).toHaveLength(1);
    expect(
      unhealthySnapshots[0]?.checks.find(
        (check: ToolServerHealthSnapshot["checks"][number]) => check.name === "runtime.redis",
      )?.ok,
    ).toBe(false);

    await server.stop();
  });
});
