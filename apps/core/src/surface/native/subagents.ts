import { createHash } from "node:crypto";
import type {
  DisplayMessage,
  DisplayPart,
  SubagentSummary,
} from "@stanley2058/lilac-client-protocol";
import type { ModelMessage } from "ai";
import type { StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";
import type { DurableWorkflowStore } from "../../workflow/durable-workflow-store";
import type { WorkflowRun } from "../../workflow/workflow-domain";
import type { TranscriptStore } from "../../transcript/transcript-store";
import type { NativeStore } from "./store";
import { nativeFailure } from "./errors";

export type SubagentSnapshot = {
  messages: readonly ModelMessage[];
  streaming: boolean;
  activeTools?: readonly { toolCallId: string; toolName: string }[];
  title: string;
};
export type SubagentReader = {
  readSubagentSnapshot(
    sessionId: string,
    requestId: string,
    includeMessages?: boolean,
  ): SubagentSnapshot | undefined;
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

export function subagentMessages(
  messages: readonly (StoredMessageV1 | ModelMessage)[],
  streaming = false,
  activeTools: NonNullable<SubagentSnapshot["activeTools"]> = [],
): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  const activeIds = new Set(activeTools.map((tool) => tool.toolCallId));
  const includedTools = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.role === "system" || message.role === "tool") continue;
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    let segment = 0;
    for (const part of content) {
      const id = `child_${index}_${segment++}`;
      if (part.type === "text") {
        for (let offset = 0; offset < part.text.length; offset += 2000)
          result.push({
            id: `${id}_${offset}`,
            role: message.role,
            ...(streaming && index === messages.length - 1
              ? { metadata: { incomplete: true } }
              : {}),
            parts: [{ type: "text", text: part.text.slice(offset, offset + 2000) }],
          });
        continue;
      }
      if (part.type === "tool-call") includedTools.add(part.toolCallId);
      const running =
        (part.type === "tool-call" && activeIds.has(part.toolCallId)) ||
        (part.type === "reasoning" &&
          streaming &&
          !activeTools.length &&
          index === messages.length - 1 &&
          part === content.at(-1));
      const activity = transcriptActivity(part, id, running);
      if (activity) result.push({ id, role: message.role, parts: [activity] });
    }
  }
  for (const tool of activeTools) {
    if (includedTools.has(tool.toolCallId)) continue;
    const id = `child_tool_${digest(tool.toolCallId)}`;
    result.push({
      id,
      role: "assistant",
      parts: [
        {
          type: "data-activity",
          id,
          data: { kind: "tool", label: tool.toolName.slice(0, 256), state: "running" },
        },
      ],
    });
  }
  return result;
}

function transcriptActivity(
  part: Exclude<StoredMessageV1["content"] | ModelMessage["content"], string>[number],
  id: string,
  running: boolean,
): DisplayPart | undefined {
  if (part.type === "reasoning")
    return {
      type: "data-activity",
      id,
      data: {
        kind: "thinking",
        label: running ? "Thinking…" : "Thought",
        state: running ? "running" : "complete",
      },
    };
  if (part.type === "tool-call")
    return {
      type: "data-activity",
      id,
      data: {
        kind: "tool",
        label: part.toolName.slice(0, 256),
        state: running ? "running" : "complete",
      },
    };
  return undefined;
}

export class NativeSubagents {
  constructor(
    private readonly options: {
      native: Pick<
        NativeStore,
        "authorizeThread" | "listCanonicalRequestIds" | "getInputByRequestId"
      >;
      workflows: Pick<DurableWorkflowStore, "listSubagentRuns" | "getRun">;
      transcripts: Pick<TranscriptStore, "getRequestTranscript">;
      live: () => SubagentReader | undefined;
    },
  ) {}

  private summary(run: WorkflowRun, turnId: string): SubagentSummary | undefined {
    const target = run.completionTarget;
    if (target.kind !== "live_parent") return;
    const live = this.options
      .live()
      ?.readSubagentSnapshot(target.childSessionId, target.childRequestId);
    const states = {
      succeeded: "complete",
      failed: "failed",
      cancelled: "canceled",
    } as const;
    const state =
      run.state === "succeeded" || run.state === "failed" || run.state === "cancelled"
        ? states[run.state]
        : "running";
    const titles = {
      running: live?.title ?? "Waiting…",
      complete: "Completed",
      failed: "Failed",
      canceled: "Canceled",
    };
    const title = titles[state];
    return {
      id: run.runId,
      activityId: digest(target.parentToolCallId),
      turnId,
      profile: target.profile,
      name: target.sessionName.slice(0, 256),
      title: title.slice(0, 256),
      state,
      startedAt: run.startedAt ?? run.createdAt,
    };
  }

  list(actorId: string, input: { threadId: string; cursor?: string }) {
    return Result.gen(function* () {
      yield* this.options.native.authorizeThread(actorId, input.threadId);
      const offset = Number(input.cursor ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0)
        return Result.err(nativeFailure("invalid", "Invalid agent cursor"));
      const validRequests = new Set(
        yield* this.options.native.listCanonicalRequestIds(input.threadId),
      );
      const runs = yield* this.options.workflows
        .listSubagentRuns(`native:${input.threadId}`, offset)
        .mapError(() => nativeFailure("sqlite", "Subagents are unavailable"));
      const items: SubagentSummary[] = [];
      for (const run of runs.slice(0, 100)) {
        const target = run.completionTarget;
        if (target.kind !== "live_parent" || !validRequests.has(target.parentRequestId)) continue;
        const parent = yield* this.options.native.getInputByRequestId(target.parentRequestId);
        if (!parent?.turnId) continue;
        const summary = this.summary(run, parent.turnId);
        if (summary) items.push(summary);
      }
      return Result.ok({
        items,
        ...(runs.length > 100 ? { nextCursor: String(offset + 100) } : {}),
      });
    }, this);
  }

  read(
    actorId: string,
    input: { threadId: string; agentId: string; before?: number; from?: number },
  ) {
    return Result.gen(function* () {
      yield* this.options.native.authorizeThread(actorId, input.threadId);
      const run = yield* this.options.workflows
        .getRun(input.agentId)
        .mapError(() => nativeFailure("sqlite", "Subagent is unavailable"));
      const target = run?.completionTarget;
      if (
        !run ||
        target?.kind !== "live_parent" ||
        target.parentSessionId !== `native:${input.threadId}`
      )
        return Result.err(nativeFailure("not-found", "Subagent not found"));
      const validRequests = yield* this.options.native.listCanonicalRequestIds(input.threadId);
      if (!validRequests.includes(target.parentRequestId))
        return Result.err(nativeFailure("not-found", "Subagent not found"));
      const parent = yield* this.options.native.getInputByRequestId(target.parentRequestId);
      if (!parent?.turnId) return Result.err(nativeFailure("not-found", "Subagent not found"));
      const agent = this.summary(run, parent.turnId)!;
      const live = this.options
        .live()
        ?.readSubagentSnapshot(target.childSessionId, target.childRequestId, true);
      const saved = live
        ? null
        : yield* (
            this.options.transcripts
              .getRequestTranscript?.({ requestId: target.childRequestId })
              .mapError(() => nativeFailure("sqlite", "Transcript is unavailable")) ??
              Result.ok(null)
          );
      const projected = subagentMessages(
        live?.messages ?? saved?.messages ?? [],
        live?.streaming,
        live?.activeTools,
      );
      const before = Math.min(input.before ?? projected.length, projected.length);
      const start =
        input.from === undefined || input.from > projected.length
          ? Math.max(0, before - 20)
          : input.from;
      const end = input.from === undefined ? before : Math.min(projected.length, start + 40);
      return Result.ok({
        agent,
        messages: projected.slice(start, end),
        offset: start,
        total: projected.length,
        ...(start ? { nextBefore: start } : {}),
        unavailable: !live && !saved && agent.state !== "running",
      });
    }, this);
  }
}
