import { describe, expect, it } from "bun:test";
import { Result, type Result as ResultType } from "better-result";

import type {
  MiniLilacModelSummary,
  MiniLilacProfileSummary,
  MiniLilacSessionSnapshot,
  MiniLilacTodoState,
  MiniLilacUIMessage,
} from "@stanley2058/mini-lilac-client";

import { canonicalCwd, type CliOptions } from "./cli";
import type { PreflightIO } from "./preflight";
import { loadExistingSession, resolveStartupSession, type StartupTransport } from "./startup";

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw new Error("expected startup success");
  return result.value;
}

function canonicalCwdValue(value: string): string {
  return resultValue(canonicalCwd(value));
}

const cwd = canonicalCwdValue(process.cwd());

function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    server: "http://127.0.0.1:8090/api/mini-lilac",
    token: undefined,
    model: undefined,
    profile: undefined,
    session: undefined,
    reasoning: undefined,
    cwd,
    help: false,
    ...overrides,
  };
}

function io(): PreflightIO {
  return { write: () => {}, question: async () => "" };
}

const messages: MiniLilacUIMessage[] = [
  { id: "user-1", role: "user", parts: [{ type: "text", text: "existing" }] },
];

const todos: MiniLilacTodoState = {
  revision: 2,
  todos: [{ content: "Hydrate todo state", status: "in_progress", priority: "high" }],
};

const sessionPresentation = {
  title: "Test session",
  inputTokens: null,
  contextWindow: null,
} as const;

const snapshot: MiniLilacSessionSnapshot = {
  ...sessionPresentation,
  id: "session-1",
  activeRunId: "run-1",
  status: "streaming",
  cwd,
  model: "removed-provider/removed-model",
  profile: "removed-profile",
  reasoning: "high",
  historyStateId: "history-1",
  canUndo: true,
  canRedo: false,
  queuedSteeringCount: 2,
};

function transport(
  calls: string[],
  storedSnapshot: MiniLilacSessionSnapshot = snapshot,
  replayCursor: { runId: string; afterSeq: number } | null = null,
): StartupTransport {
  const models: MiniLilacModelSummary[] = [
    {
      id: "provider/current-model",
      label: "Current model",
      supportsReasoning: true,
      isDefault: true,
    },
  ];
  const profiles: MiniLilacProfileSummary[] = [
    {
      id: "current-profile",
      label: "Current profile",
      subagentOnly: false,
      workspaceWrites: true,
      isDefault: true,
    },
  ];
  return {
    getSessionResumeResult: async () => {
      calls.push("resume");
      return Result.ok({ snapshot: storedSnapshot, messages, todos, replayCursor });
    },
    setReconnectCursor: () => {},
    listModelsResult: async () => {
      calls.push("models");
      return Result.ok(models);
    },
    listProfilesResult: async () => {
      calls.push("profiles");
      return Result.ok(profiles);
    },
  };
}

describe("resolveStartupSession resume", () => {
  it("loads and cwd-validates a selected existing session", async () => {
    const selected = resultValue(await loadExistingSession(transport([]), "session-1", cwd));
    expect(selected).toEqual({ snapshot, messages, todos, replayCursor: null });

    const mismatched = await loadExistingSession(
      transport([]),
      "session-1",
      canonicalCwdValue("/tmp"),
    );
    expect(mismatched.status).toBe("error");
    if (mismatched.status === "error") expect(mismatched.error.message).toContain("belongs to cwd");
  });

  it("primes reconnect from the resume projection cursor", async () => {
    const cursors: unknown[] = [];
    const base = transport([], snapshot, { runId: "run-active", afterSeq: 12 });
    const selected = resultValue(
      await loadExistingSession(
        {
          ...base,
          setReconnectCursor: (_sessionId, cursor) => cursors.push(cursor),
        },
        "session-1",
        cwd,
      ),
    );

    expect(selected.replayCursor).toEqual({ runId: "run-active", afterSeq: 12 });
    expect(cursors).toEqual([{ runId: "run-active", afterSeq: 12 }]);
  });

  it("loads session/messages before catalogs and preserves stored bindings absent from catalogs", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const result = resultValue(
      await resolveStartupSession(
        transport(calls),
        options({
          session: "session-1",
          model: "provider/wrong",
          profile: "wrong-profile",
          reasoning: "low",
        }),
        { write: (message) => warnings.push(message), question: async () => "" },
      ),
    );

    expect(calls[0]).toBe("resume");
    expect(calls.slice(1).sort()).toEqual(["models", "profiles"]);
    expect(result).toMatchObject({
      sessionId: "session-1",
      model: "removed-provider/removed-model",
      profile: "removed-profile",
      reasoning: "high",
      snapshot,
      messages,
      todos,
      models: [expect.objectContaining({ id: "provider/current-model" })],
      profiles: [expect.objectContaining({ id: "current-profile" })],
    });
    expect(warnings).toEqual([
      "Warning: --model, --profile, --reasoning ignored; resumed sessions keep their stored bindings.\n",
    ]);
  });

  it("does not warn when explicit resume bindings match the snapshot", async () => {
    const warnings: string[] = [];

    await resolveStartupSession(
      transport([]),
      options({
        session: "session-1",
        model: snapshot.model ?? undefined,
        profile: snapshot.profile ?? undefined,
        reasoning: snapshot.reasoning ?? undefined,
      }),
      { write: (message) => warnings.push(message), question: async () => "" },
    );

    expect(warnings).toEqual([]);
  });

  it("rejects a resumed session bound to another canonical cwd", async () => {
    const other = { ...snapshot, cwd: canonicalCwdValue("/tmp") };
    const mismatched = await resolveStartupSession(
      transport([], other),
      options({ session: "session-1" }),
      io(),
    );
    expect(mismatched.status).toBe("error");
    if (mismatched.status === "error") expect(mismatched.error.message).toContain("belongs to cwd");
  });

  it("preserves null resume bindings instead of selecting fresh defaults", async () => {
    const unbound = { ...snapshot, model: null, profile: null, reasoning: null };
    const result = resultValue(
      await resolveStartupSession(
        transport([], unbound),
        options({
          session: "session-1",
          model: "provider/current-model",
          profile: "current-profile",
          reasoning: "high",
        }),
        {
          write: () => {},
          question: () => Promise.reject(new Error("resume must not prompt")),
        },
      ),
    );
    expect(result.model).toBeUndefined();
    expect(result.profile).toBeUndefined();
    expect(result.reasoning).toBeUndefined();
  });
});

describe("resolveStartupSession fresh bindings", () => {
  it("reuses remembered bindings without forcing model/profile preflight", async () => {
    const result = resultValue(
      await resolveStartupSession(
        transport([]),
        options(),
        {
          write: () => {
            throw new Error("remembered bindings must not render preflight");
          },
          question: () => Promise.reject(new Error("remembered bindings must not prompt")),
        },
        {
          model: "provider/current-model",
          profile: "current-profile",
          reasoning: "low",
        },
      ),
    );

    expect(result).toMatchObject({
      model: "provider/current-model",
      profile: "current-profile",
      reasoning: "low",
      snapshot: undefined,
      messages: [],
      todos: { revision: 0, todos: [] },
    });
  });

  it("only prompts for a first-ever missing model and leaves profile to the server default", async () => {
    let questions = 0;
    const result = resultValue(
      await resolveStartupSession(transport([]), options(), {
        write: () => {},
        question: async () => {
          questions += 1;
          return "";
        },
      }),
    );

    expect(questions).toBe(1);
    expect(result.model).toBe("provider/current-model");
    expect(result.profile).toBeUndefined();
    expect(result.reasoning).toBeUndefined();
  });

  it("prefers explicit CLI bindings over remembered values", async () => {
    const result = resultValue(
      await resolveStartupSession(
        transport([]),
        options({
          model: "provider/current-model",
          profile: "current-profile",
          reasoning: "high",
        }),
        io(),
        { model: "provider/old", profile: "old-profile", reasoning: "low" },
      ),
    );

    expect(result).toMatchObject({
      model: "provider/current-model",
      profile: "current-profile",
      reasoning: "high",
    });
  });
});
