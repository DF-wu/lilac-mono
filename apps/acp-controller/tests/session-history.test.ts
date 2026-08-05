import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "bun:test";

import { projectSessionUpdate, SessionHistoryCollector } from "../session-history.ts";

function add(collector: SessionHistoryCollector, update: SessionUpdate): void {
  collector.add({ sessionId: "session-1", update });
}

describe("SessionHistoryCollector", () => {
  it("flattens every current content kind and appends adjacent roles", () => {
    const collector = new SessionHistoryCollector();

    add(collector, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "hello" },
    });
    add(collector, {
      sessionUpdate: "user_message_chunk",
      content: { type: "resource_link", name: "source", uri: "file:///source.ts" },
    });
    add(collector, {
      sessionUpdate: "user_message_chunk",
      content: { type: "image", data: "image-data", mimeType: "image/png" },
    });
    add(collector, {
      sessionUpdate: "user_message_chunk",
      content: { type: "audio", data: "audio-data", mimeType: "audio/wav" },
    });
    add(collector, {
      sessionUpdate: "user_message_chunk",
      content: {
        type: "resource",
        resource: { uri: "file:///embedded.txt", text: "embedded" },
      },
    });
    add(collector, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "reply" },
    });
    add(collector, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " continued" },
    });

    expect(collector.history).toEqual([
      { role: "user", text: "hellofile:///source.ts[image][audio][resource]" },
      { role: "assistant", text: "reply continued" },
    ]);
    expect(collector.latestAssistantText()).toBe("reply continued");
  });

  it("replaces plans instead of accumulating entries", () => {
    const collector = new SessionHistoryCollector();

    add(collector, {
      sessionUpdate: "plan",
      entries: [{ content: "first", priority: "high", status: "pending" }],
    });
    add(collector, {
      sessionUpdate: "plan",
      entries: [{ content: "second", priority: "low", status: "completed" }],
    });

    expect(collector.plan).toEqual([{ content: "second", priority: "low", status: "completed" }]);
  });

  it("keeps session info when partial updates contain null or omit fields", () => {
    const collector = new SessionHistoryCollector();

    add(collector, {
      sessionUpdate: "session_info_update",
      title: "Session title",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    add(collector, {
      sessionUpdate: "session_info_update",
      title: null,
      updatedAt: null,
    });
    add(collector, { sessionUpdate: "session_info_update" });

    expect(collector.title).toBe("Session title");
    expect(collector.updatedAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("applies current mode updates", () => {
    const collector = new SessionHistoryCollector();

    add(collector, { sessionUpdate: "current_mode_update", currentModeId: "review" });

    expect(collector.currentModeId).toBe("review");
  });

  it("explicitly ignores every current no-op update category", () => {
    const ignoredUpdates: readonly SessionUpdate[] = [
      {
        sessionUpdate: "usage_update",
        size: 10_000,
        used: 1_000,
      },
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read file",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
      },
      {
        sessionUpdate: "config_option_update",
        configOptions: [],
      },
    ];
    const collector = new SessionHistoryCollector();
    add(collector, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "unchanged" },
    });
    const before = JSON.stringify(collector);

    for (const update of ignoredUpdates) {
      add(collector, update);
      expect(JSON.stringify(collector)).toBe(before);
    }
  });
});

describe("projectSessionUpdate", () => {
  it("projects runtime SDK version skew to the defensive unsupported variant", () => {
    // SDK notification validation normally rejects unknown tags before this defense-in-depth path.
    // @ts-expect-error intentionally probes a future tag outside the installed SessionUpdate union.
    const projected = projectSessionUpdate({ sessionUpdate: "future_session_update" });

    expect(projected).toEqual({
      type: "unsupported",
      sessionUpdate: "future_session_update",
    });
  });
});
