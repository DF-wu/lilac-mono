import { describe, expect, it } from "bun:test";
import { asSchema } from "ai";

import { BUILTIN_SURFACE_PROTOCOLS } from "../../src/surface/builtin-surface-protocols";
import { subagentTools } from "../../src/tools/subagent";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

async function resolveExecuteResult<T>(value: T | PromiseLike<T> | AsyncIterable<T>): Promise<T> {
  if (isAsyncIterable(value)) {
    let last: T | undefined;
    for await (const chunk of value) {
      last = chunk;
    }
    if (last === undefined) {
      throw new Error("AsyncIterable tool execute produced no values");
    }
    return last;
  }

  return await value;
}

describe("subagent_delegate tool", () => {
  it("documents selectable model aliases and appends delegation guidance", () => {
    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 1,
      delegatePromptOverlay: "Escalate critical reviews to a stronger model.",
      modelPresets: {
        scout: {
          model: "openrouter/google/gemini-2.5-flash",
          comment: "Fast repository exploration.",
          agentCanSelect: true,
        },
        coder: {
          model: "openai/gpt-5.5",
          comment: "Bounded implementation work.",
          agentCanSelect: true,
        },
        architect: {
          model: "vercel/anthropic/claude-opus-4.8",
          reasoning: "high",
          comment: "Architecture and critical review.",
          agentCanSelect: true,
        },
        reviewer: {
          model: "openai/gpt-5.5",
          comment: "Independent review.",
          agentCanSelect: true,
        },
        vision: {
          model: "openai/gpt-5.5",
          comment: "Visual analysis.",
          agentCanSelect: true,
        },
        overflow: {
          model: "openai/gpt-5.5",
          comment: "Sixth comment is omitted.",
          agentCanSelect: true,
        },
        manual: {
          model: "openai/gpt-5.5",
          comment: "Operator-only model.",
          agentCanSelect: false,
        },
        "invalid/alias": {
          model: "openai/gpt-5.5",
          comment: "Alias cannot be resolved as an alias.",
          agentCanSelect: true,
        },
        invalidTarget: {
          model: "gpt-5.5",
          comment: "Target is not a canonical model spec.",
          agentCanSelect: true,
        },
      },
    });
    const delegate = tools.subagent_delegate as unknown as {
      description?: string;
      inputSchema: unknown;
      outputSchema: unknown;
    };
    const schema = asSchema(delegate.inputSchema as never).jsonSchema as unknown as {
      properties?: {
        model?: { enum?: string[]; description?: string };
        mode?: { description?: string };
        reasoning?: { enum?: string[] };
        sessionName?: { description?: string };
      };
    };

    expect(schema.properties?.model?.enum).toEqual([
      "scout",
      "coder",
      "architect",
      "reviewer",
      "vision",
      "overflow",
    ]);
    expect(schema.properties?.model?.description).toContain("scout: Fast repository exploration.");
    expect(schema.properties?.model?.description).toContain(
      "architect: Architecture and critical review.",
    );
    expect(schema.properties?.model?.description).not.toContain("Sixth comment is omitted.");
    expect(schema.properties?.model?.description).not.toContain("Operator-only model.");
    expect(schema.properties?.model?.enum).not.toContain("invalid/alias");
    expect(schema.properties?.model?.enum).not.toContain("invalidTarget");
    expect(schema.properties?.reasoning?.enum).toContain("xhigh");
    expect(schema.properties?.sessionName?.description).toContain(
      "If the session is active, the new invocation waits in the queue",
    );
    expect(schema.properties?.sessionName?.description).toContain(
      "Reuse does not check or join the active invocation",
    );
    expect(schema.properties?.mode?.description).toContain(
      "acceptance confirms that the child started, not that it finished",
    );
    expect(schema.properties?.mode?.description).toContain(
      "give the final answer after every deferred subagent has returned a terminal subagent_result",
    );
    expect(delegate.description).toContain("reply with exactly NO_REPLY and end the turn");
    expect(delegate.description).toContain("Do not call tools only to wait");
    expect(delegate.description).toContain(
      "Wait for all deferred results before you send the final response",
    );
    expect(delegate.description).toContain("Escalate critical reviews to a stronger model.");
    expect(JSON.stringify(asSchema(delegate.outputSchema as never).jsonSchema)).toContain(
      "workflowRunId",
    );
  });

  it("omits the model field when no aliases are selectable", async () => {
    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 1,
      modelPresets: {
        defaultAlias: {
          model: "openai/gpt-5.5-mini",
        },
        manual: {
          model: "openai/gpt-5.5",
          agentCanSelect: false,
        },
      },
    });
    const delegate = tools.subagent_delegate as unknown as { inputSchema: unknown };
    const schema = asSchema(delegate.inputSchema as never).jsonSchema as unknown as {
      properties?: { model?: unknown; reasoning?: unknown };
    };

    expect(schema.properties?.model).toBeUndefined();
    expect(schema.properties?.reasoning).toBeUndefined();
    await expect(
      resolveExecuteResult(
        tools.subagent_delegate.execute!(
          {
            profile: "explore",
            task: "Try a hidden model",
            mode: "deferred",
            model: "manual",
          },
          {
            toolCallId: "tool-no-selectable-models",
            messages: [],
            context: {
              requestId: "r:no-selectable-models",
              sessionId: "s:no-selectable-models",
              requestClient: "discord",
              subagentDepth: 0,
            },
          },
        ),
      ),
    ).rejects.toThrow("not available for agent selection");
    await expect(
      resolveExecuteResult(
        tools.subagent_delegate.execute!(
          {
            profile: "explore",
            task: "Try a reasoning override",
            mode: "deferred",
            reasoning: "high",
          },
          {
            toolCallId: "tool-no-reasoning-override",
            messages: [],
            context: {
              requestId: "r:no-reasoning-override",
              sessionId: "s:no-reasoning-override",
              requestClient: "discord",
              subagentDepth: 0,
            },
          },
        ),
      ),
    ).rejects.toThrow("Reasoning override requires an agent-selectable model alias");
  });

  it("passes selected model and reasoning to deferred registration", async () => {
    let selected:
      | {
          modelOverride?: string;
          reasoningOverride?: string;
          authenticatedOrigin?: {
            platform: "discord" | "github";
            userId: string;
            sessionRef: { platform: "discord" | "github"; channelId: string };
          };
        }
      | undefined;
    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 1,
      modelPresets: {
        scout: {
          model: "openrouter/google/gemini-2.5-flash",
          agentCanSelect: true,
        },
        manual: {
          model: "openai/gpt-5.5",
          agentCanSelect: false,
        },
      },
      onDelegate: async (registration) => {
        selected = registration;
        return {
          runId: "run:model-override",
          completion: Promise.resolve({ status: "resolved", finalText: "" }),
          cancel: async () => {},
        };
      },
    });

    await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        {
          profile: "explore",
          task: "Map auth flow",
          mode: "deferred",
          model: "scout",
          reasoning: "high",
        },
        {
          toolCallId: "tool-model-override",
          messages: [],
          context: {
            requestId: "r:model-override",
            sessionId: "s:model-override",
            requestClient: "discord",
            subagentDepth: 0,
            requestInitiator: { platform: "discord", userId: "user-1" },
            requestInitiatorSessionId: "surface-session",
          },
        },
      ),
    );

    expect(selected?.modelOverride).toBe("scout");
    expect(selected?.reasoningOverride).toBe("high");
    expect(selected?.authenticatedOrigin).toEqual({
      platform: "discord",
      userId: "user-1",
      sessionRef: { platform: "discord", channelId: "surface-session" },
    });

    await expect(
      resolveExecuteResult(
        tools.subagent_delegate.execute!(
          { profile: "explore", task: "Try manual", mode: "deferred", model: "manual" },
          {
            toolCallId: "tool-manual-model",
            messages: [],
            context: {
              requestId: "r:manual-model",
              sessionId: "s:manual-model",
              requestClient: "discord",
              subagentDepth: 0,
            },
          },
        ),
      ),
    ).rejects.toThrow();
  });

  it("returns an accepted handle by default in deferred mode", async () => {
    const launches: Array<{
      sessionName: string;
      childRequestId: string;
      childSessionId: string;
      task: string;
      stableNamedContinuation: true;
    }> = [];

    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 1,
      onDelegate: async (registration) => {
        launches.push({
          sessionName: registration.sessionName,
          childRequestId: registration.childRequestId,
          childSessionId: registration.childSessionId,
          task: registration.task,
          stableNamedContinuation: registration.stableNamedContinuation,
        });
        return {
          runId: "run:deferred-1",
          completion: Promise.resolve({ status: "resolved", finalText: "" }),
          cancel: async () => {},
        };
      },
    });

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        { profile: "explore", task: "Map auth flow", mode: "deferred" },
        {
          toolCallId: "tool-deferred-1",
          messages: [],
          context: {
            requestId: "r:deferred-1",
            sessionId: "s:deferred-1",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    expect(res).toEqual({
      ok: true,
      mode: "deferred",
      status: "accepted",
      workflowRunId: "run:deferred-1",
      profile: "explore",
      sessionName: expect.stringMatching(/^explore-[0-9a-f]{8}$/u),
    });
    expect(launches).toEqual([
      {
        sessionName: res.sessionName,
        childRequestId: expect.stringMatching(/^sub:r:deferred-1:/u),
        childSessionId: `sub:s:deferred-1:named:${res.sessionName}`,
        task: "Map auth flow",
        stableNamedContinuation: true,
      },
    ]);
  });

  it("ignores legacy raw sessionId input and creates a named child session", async () => {
    const launches: Array<{ sessionName: string; childRequestId: string; childSessionId: string }> =
      [];

    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 1,
      onDelegate: async (registration) => {
        launches.push({
          sessionName: registration.sessionName,
          childRequestId: registration.childRequestId,
          childSessionId: registration.childSessionId,
        });
        return {
          runId: "run:legacy-session-id",
          completion: Promise.resolve({ status: "resolved", finalText: "" }),
          cancel: async () => {},
        };
      },
    });

    const inputWithLegacySessionId = {
      profile: "explore" as const,
      task: "Map auth flow",
      mode: "deferred" as const,
      sessionId: "sub:dummy",
    };

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(inputWithLegacySessionId, {
        toolCallId: "tool-legacy-session-id",
        messages: [],
        context: {
          requestId: "r:legacy-session-id",
          sessionId: "s:legacy-session-id",
          requestClient: "discord",
          subagentDepth: 0,
        },
      }),
    );

    expect(res.status).toBe("accepted");
    expect(res.sessionName).toMatch(/^explore-[0-9a-f]{8}$/u);
    expect(launches).toEqual([
      {
        sessionName: res.sessionName,
        childRequestId: expect.stringMatching(/^sub:r:legacy-session-id:/u),
        childSessionId: `sub:s:legacy-session-id:named:${res.sessionName}`,
      },
    ]);
  });

  it("delegates to child request and returns child final text", async () => {
    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 1,
      onDelegate: async () => ({
        runId: "run:sync-result",
        completion: Promise.resolve({ status: "resolved", finalText: "hello world" }),
        cancel: async () => {},
      }),
    });

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        {
          profile: "explore",
          task: "Map auth flow",
          mode: "sync",
        },
        {
          toolCallId: "tool-1",
          messages: [],
          context: {
            requestId: "r:1",
            sessionId: "s:1",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    expect(res.mode).toBe("sync");
    if (res.mode !== "sync") throw new Error("expected sync subagent result");
    expect(res.ok).toBe(true);
    expect(res.status).toBe("resolved");
    expect(res.workflowRunId).toBe("run:sync-result");
    expect(res.profile).toBe("explore");
    expect(res.sessionName).toMatch(/^explore-[0-9a-f]{8}$/u);
    expect(res.finalText).toBe("hello world");
    expect(res).not.toHaveProperty("childRequestId");
    expect(res).not.toHaveProperty("childSessionId");
    expect(res).not.toHaveProperty("timeoutMs");
    expect(res).not.toHaveProperty("durationMs");
  });

  it("times out after the configured period without child activity", async () => {
    let cancelQueued = false;

    const tools = subagentTools({
      idleTimeoutMs: 30,
      maxDepth: 1,
      onDelegate: async () => {
        cancelQueued = true;
        return {
          runId: "run:sync-timeout",
          completion: Promise.resolve({
            status: "timeout",
            finalText: "",
            detail: "idle timed out after 30ms without child activity",
          }),
          cancel: async () => {},
        };
      },
    });

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        { profile: "explore", task: "Wait forever", mode: "sync" },
        {
          toolCallId: "tool-idle-timeout",
          messages: [],
          context: {
            requestId: "r:idle-timeout",
            sessionId: "s:idle-timeout",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    expect(res.mode).toBe("sync");
    if (res.mode !== "sync") throw new Error("expected sync subagent result");
    expect(res.status).toBe("timeout");
    expect(res.detail).toContain("without child activity");
    expect(cancelQueued).toBe(true);
  });

  it("supports general and self delegation profiles", async () => {
    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 1,
      onDelegate: async (registration) => {
        seenProfiles.push(registration.profile);
        return {
          runId: `run:${registration.profile}`,
          completion: Promise.resolve({
            status: "resolved",
            finalText: `done:${registration.profile}`,
          }),
          cancel: async () => {},
        };
      },
    });

    const seenProfiles: string[] = [];

    const profiles = ["general", "self"] as const;

    for (const profile of profiles) {
      const res = await resolveExecuteResult(
        tools.subagent_delegate.execute!(
          {
            profile,
            task: "Do delegated work",
            mode: "sync",
          },
          {
            toolCallId: `tool-${profile}`,
            messages: [],
            context: {
              requestId: `r:${profile}`,
              sessionId: `s:${profile}`,
              requestClient: "discord",
              subagentDepth: 0,
            },
          },
        ),
      );

      expect(res.mode).toBe("sync");
      if (res.mode !== "sync") throw new Error("expected sync subagent result");
      expect(res.ok).toBe(true);
      expect(res.status).toBe("resolved");
      expect(res.profile).toBe(profile);
      expect(res.finalText).toBe(`done:${profile}`);
    }

    expect(seenProfiles).toEqual(["general", "self"]);
  });

  it.each(Object.values(BUILTIN_SURFACE_PROTOCOLS).map((protocol) => protocol.platform))(
    "projects a registered %s initiator into delegated origin without message authority",
    async (platform) => {
      let origin: unknown;
      const tools = subagentTools({
        idleTimeoutMs: 2_000,
        maxDepth: 1,
        onDelegate: async (registration) => {
          origin = registration.authenticatedOrigin;
          return {
            runId: `run:${platform}-origin`,
            completion: Promise.resolve({ status: "resolved", finalText: "done" }),
            cancel: async () => {},
          };
        },
      });

      await resolveExecuteResult(
        tools.subagent_delegate.execute!(
          { profile: "explore", task: "Inspect origin", mode: "deferred" },
          {
            toolCallId: `tool-${platform}-origin`,
            messages: [],
            context: {
              requestId: `request-${platform}`,
              sessionId: `session-${platform}`,
              requestClient: platform,
              requestInitiator: { platform, userId: "user-1" },
              requestInitiatorSessionId: `origin-${platform}`,
            },
          },
        ),
      );

      expect(origin).toEqual({
        platform,
        userId: "user-1",
        sessionRef: { platform, channelId: `origin-${platform}` },
      });
    },
  );

  it.each(["slack", "future-surface"])(
    "rejects unsupported initiator platform %s",
    async (platform) => {
      const tools = subagentTools({
        idleTimeoutMs: 2_000,
        maxDepth: 1,
        onDelegate: async () => ({
          runId: "run:unsupported-origin",
          completion: Promise.resolve({ status: "resolved", finalText: "done" }),
          cancel: async () => {},
        }),
      });

      await expect(
        resolveExecuteResult(
          tools.subagent_delegate.execute!(
            { profile: "explore", task: "Inspect origin", mode: "deferred" },
            {
              toolCallId: `tool-${platform}-origin`,
              messages: [],
              context: {
                requestId: `request-${platform}`,
                sessionId: `session-${platform}`,
                requestClient: platform,
                requestInitiator: { platform, userId: "user-1" },
                requestInitiatorSessionId: `origin-${platform}`,
              },
            },
          ),
        ),
      ).rejects.toThrow("subagent_delegate requires request context");
    },
  );

  it("derives child session id from sessionName for continuation", async () => {
    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 1,
      onDelegate: async (registration) => {
        seenChildSessionId = registration.childSessionId;
        seenStableNamedContinuation = registration.stableNamedContinuation;
        return {
          runId: "run:continued-session",
          completion: Promise.resolve({ status: "resolved", finalText: "continued" }),
          cancel: async () => {},
        };
      },
    });

    const sessionName = "session-1";
    const expectedSessionId = `sub:s:parent:named:${sessionName}`;
    let seenChildSessionId: string | null = null;
    let seenStableNamedContinuation = false;

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        {
          profile: "explore",
          task: "Continue prior work",
          mode: "sync",
          sessionName,
        },
        {
          toolCallId: "tool-continued-session",
          messages: [],
          context: {
            requestId: "r:continued-session",
            sessionId: "s:parent",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    expect(res.status).toBe("resolved");
    expect(res.sessionName).toBe(sessionName);
    expect(seenChildSessionId === expectedSessionId).toBe(true);
    expect(seenStableNamedContinuation).toBe(true);
  });

  it("makes a generated child name reusable for stable continuation", async () => {
    const launches: Array<{ sessionName: string; childSessionId: string; stable: true }> = [];
    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 1,
      onDelegate: async (registration) => {
        launches.push({
          sessionName: registration.sessionName,
          childSessionId: registration.childSessionId,
          stable: registration.stableNamedContinuation,
        });
        return {
          runId: `run:generated-stable-${launches.length}`,
          completion: Promise.resolve({ status: "resolved", finalText: "done" }),
          cancel: async () => {},
        };
      },
    });

    const generated = await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        { profile: "explore", task: "One-off utility run", mode: "deferred" },
        {
          toolCallId: "tool-generated-fresh-only",
          messages: [],
          context: {
            requestId: "r:generated-fresh-only",
            sessionId: "s:generated-fresh-only",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        {
          profile: "explore",
          task: "Continue the utility run",
          mode: "deferred",
          sessionName: generated.sessionName,
        },
        {
          toolCallId: "tool-generated-stable-continuation",
          messages: [],
          context: {
            requestId: "r:generated-stable-continuation",
            sessionId: "s:generated-fresh-only",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    expect(launches).toEqual([
      {
        sessionName: generated.sessionName,
        childSessionId: `sub:s:generated-fresh-only:named:${generated.sessionName}`,
        stable: true,
      },
      {
        sessionName: generated.sessionName,
        childSessionId: `sub:s:generated-fresh-only:named:${generated.sessionName}`,
        stable: true,
      },
    ]);
  });

  it("rejects invalid continuation session names", async () => {
    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 1,
    });

    await expect(
      tools.subagent_delegate.execute!(
        {
          profile: "explore",
          task: "Continue prior work",
          mode: "deferred",
          sessionName: "../someone-else",
        },
        {
          toolCallId: "tool-invalid-continued-session",
          messages: [],
          context: {
            requestId: "r:invalid-continued-session",
            sessionId: "s:parent",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    ).rejects.toThrow(/sessionName must be a short slug/i);
  });

  it("rejects delegation when depth limit is reached", async () => {
    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 1,
    });

    await expect(
      tools.subagent_delegate.execute!(
        { profile: "explore", task: "Map auth flow", mode: "deferred" },
        {
          toolCallId: "tool-2",
          messages: [],
          context: {
            requestId: "r:2",
            sessionId: "s:2",
            requestClient: "discord",
            subagentDepth: 1,
          },
        },
      ),
    ).rejects.toThrow(/depth limit reached/i);
  });

  it("rejects delegation from explore and general runs", async () => {
    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 2,
    });

    await expect(
      tools.subagent_delegate.execute!(
        { profile: "explore", task: "Map auth flow", mode: "deferred" },
        {
          toolCallId: "tool-no-nest-explore",
          messages: [],
          context: {
            requestId: "r:no-nest-explore",
            sessionId: "s:no-nest-explore",
            requestClient: "discord",
            subagentDepth: 1,
            subagentProfile: "explore",
          },
        },
      ),
    ).rejects.toThrow(/disabled in explore subagent runs/i);

    await expect(
      tools.subagent_delegate.execute!(
        { profile: "general", task: "Fix lint", mode: "deferred" },
        {
          toolCallId: "tool-no-nest-general",
          messages: [],
          context: {
            requestId: "r:no-nest-general",
            sessionId: "s:no-nest-general",
            requestClient: "discord",
            subagentDepth: 1,
            subagentProfile: "general",
          },
        },
      ),
    ).rejects.toThrow(/disabled in general subagent runs/i);
  });

  it("rejects self->self recursion but allows self->explore at depth 1", async () => {
    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 2,
      onDelegate: async () => ({
        runId: "run:self-explore",
        completion: Promise.resolve({ status: "resolved", finalText: "self->explore ok" }),
        cancel: async () => {},
      }),
    });

    await expect(
      tools.subagent_delegate.execute!(
        { profile: "self", task: "Spawn self again", mode: "deferred" },
        {
          toolCallId: "tool-self-self",
          messages: [],
          context: {
            requestId: "r:self-self",
            sessionId: "s:self-self",
            requestClient: "discord",
            subagentDepth: 1,
            subagentProfile: "self",
          },
        },
      ),
    ).rejects.toThrow(/cannot delegate to self profile/i);

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        {
          profile: "explore",
          task: "Map auth flow",
          mode: "sync",
        },
        {
          toolCallId: "tool-self-explore",
          messages: [],
          context: {
            requestId: "r:self-explore",
            sessionId: "s:self-explore",
            requestClient: "discord",
            subagentDepth: 1,
            subagentProfile: "self",
          },
        },
      ),
    );

    expect(res.mode).toBe("sync");
    if (res.mode !== "sync") throw new Error("expected sync subagent result");
    expect(res.status).toBe("resolved");
    expect(res.finalText).toBe("self->explore ok");
    expect(res.profile).toBe("explore");
  });

  it("ignores legacy caller timeouts and uses the configured idle timeout", async () => {
    let capturedIdleTimeoutMs: number | undefined;

    const tools = subagentTools({
      idleTimeoutMs: 2_000,
      maxDepth: 1,
      onDelegate: async (registration) => {
        capturedIdleTimeoutMs = registration.idleTimeoutMs;
        return {
          runId: "run:legacy-timeout",
          completion: Promise.resolve({ status: "resolved", finalText: "" }),
          cancel: async () => {},
        };
      },
    });

    const inputWithLegacyTimeout = {
      profile: "explore" as const,
      task: "Map auth flow",
      mode: "deferred" as const,
      timeoutMs: 999_999,
    };

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(inputWithLegacyTimeout, {
        toolCallId: "tool-3",
        messages: [],
        context: {
          requestId: "r:3",
          sessionId: "s:3",
          requestClient: "discord",
          subagentDepth: 0,
        },
      }),
    );

    expect(capturedIdleTimeoutMs).toBe(2_000);
    expect(res.status).toBe("accepted");
  });
});
