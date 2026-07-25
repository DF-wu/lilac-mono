import type { EventTopic, PersistenceEntry, StateMachine, WorkspacePackage } from "./types";
import { source } from "./types";

export const EVENT_TOPICS = [
  {
    topic: "cmd.request",
    role: "Request ingress + in-flight control",
    semantics:
      "Agent runner uses work/begin; request cache and relays use fanout. Missing request_id is rejected at publish/runtime consumer boundaries.",
    key: "request_id",
    producers: [
      "Discord router",
      "GitHub webhook",
      "Workflow service/scheduler",
      "Heartbeat",
      "Subagent tool",
      "cancel/slash paths",
    ],
    consumers: [
      "Bus Agent Runner",
      "Request Message Cache",
      "Discord/GitHub relays (cancel tracking)",
    ],
    events: [
      {
        type: "cmd.request.message",
        payload: "{ queue, messages, runPolicy?, origin?, modelOverride?, raw? }",
        purpose: "開始 prompt，或以 steer/followUp/interrupt 控制 active request",
      },
    ],
    sources: [
      source("packages/event-bus/lilac-spec.ts", 92),
      source("packages/event-bus/lilac-spec.ts", 291),
      source("packages/event-bus/lilac-bus.ts", 137),
    ],
  },
  {
    topic: "cmd.surface",
    role: "Active output UX control",
    semantics:
      "Fanout to each surface relay; correlated by request_id and separate from agent transcript control.",
    key: "request_id",
    producers: ["Discord request router"],
    consumers: ["Discord/GitHub Bus-to-Adapter Relay"],
    events: [
      {
        type: "cmd.surface.output.reanchor",
        payload: "{ inheritReplyTo, mode?: steer|interrupt, replyTo? }",
        purpose: "凍結目前訊息鏈，從新 reply anchor 繼續 streaming",
      },
    ],
    sources: [
      source("packages/event-bus/lilac-spec.ts", 112),
      source("packages/event-bus/lilac-spec.ts", 297),
      source("apps/core/src/surface/bridge/subscribe-from-bus.ts", 336),
    ],
  },
  {
    topic: "evt.adapter",
    role: "Canonical surface ingress",
    semantics:
      "Adapter bridge publishes platform-neutral events; router/workflow/search paths fan out. Event key is messageId.",
    key: "messageId",
    producers: ["Discord Adapter-to-Bus Bridge"],
    consumers: ["Request Router", "Workflow Service", "Discord Search/other fanout observers"],
    events: [
      {
        type: "evt.adapter.message.created",
        payload: "{ platform, channelId, messageId, userId, text, ts, ... }",
        purpose: "新訊息 ingress",
      },
      {
        type: "evt.adapter.message.updated",
        payload: "same message identity + updated text",
        purpose: "更新 cache/index 與平台狀態",
      },
      {
        type: "evt.adapter.message.deleted",
        payload: "{ platform, channelId, messageId, ts, raw? }",
        purpose: "刪除 cache/index entry",
      },
      {
        type: "evt.adapter.reaction.added",
        payload: "message identity + user + reaction",
        purpose: "reaction ingress",
      },
      {
        type: "evt.adapter.reaction.removed",
        payload: "message identity + user + reaction",
        purpose: "reaction removal ingress",
      },
    ],
    sources: [
      source("packages/event-bus/lilac-spec.ts", 122),
      source("packages/event-bus/lilac-spec.ts", 303),
      source("packages/event-bus/lilac-bus.ts", 151),
    ],
  },
  {
    topic: "evt.request",
    role: "Request lifecycle + open-output signal",
    semantics:
      "Durable stream intentionally excluded from watermark trimming for cursor-based restart recovery; multiple fanout observers.",
    key: "request_id",
    producers: ["Bus Agent Runner", "Subagent/cancel recovery paths"],
    consumers: ["Request Router", "Surface Relays", "Heartbeat", "Subagent join managers"],
    events: [
      {
        type: "evt.request.lifecycle.changed",
        payload: "{ state: queued|running|resolved|failed|cancelled, detail?, ts? }",
        purpose: "Request state machine observation",
      },
      {
        type: "evt.request.reply",
        payload: "{}",
        purpose: "通知 relay 立即建立 out.req subscription / output stream",
      },
    ],
    sources: [
      source("packages/event-bus/lilac-spec.ts", 58),
      source("packages/event-bus/lilac-spec.ts", 333),
      source("packages/event-bus/redis-streams-bus.ts", 28),
    ],
  },
  {
    topic: "evt.surface",
    role: "Surface output identity feedback",
    semantics: "Fanout feedback from relay to router after a real platform message is created.",
    key: "request_id",
    producers: ["Bus-to-Adapter Relay"],
    consumers: ["Request Router"],
    events: [
      {
        type: "evt.surface.output.message.created",
        payload: "{ msgRef: { platform, channelId, messageId } }",
        purpose: "追蹤 active streaming reply anchor，支援 direct reply steer/reanchor",
      },
    ],
    sources: [
      source("packages/event-bus/lilac-spec.ts", 187),
      source("packages/event-bus/lilac-spec.ts", 345),
      source("apps/core/src/surface/bridge/subscribe-from-bus.ts", 630),
    ],
  },
  {
    topic: "cmd.workflow",
    role: "Durable workflow commands",
    semantics:
      "Workflow Service consumes in work mode; workflowId is the routing key; writes authoritative state to SQLite.",
    key: "workflowId",
    producers: ["Level 1 workflow tool", "Level 2 workflow tools"],
    consumers: ["Workflow Service"],
    events: [
      {
        type: "cmd.workflow.create",
        payload: "{ workflowId, definition? }",
        purpose: "建立 v2 interactive 或 v3 scheduled workflow",
      },
      {
        type: "cmd.workflow.task.create",
        payload: "{ workflowId, taskId, kind, description, input? }",
        purpose: "加入等待/時間 task",
      },
      {
        type: "cmd.workflow.cancel",
        payload: "{ workflowId, reason? }",
        purpose: "取消 workflow 與非 terminal tasks",
      },
    ],
    sources: [
      source("packages/event-bus/lilac-spec.ts", 192),
      source("packages/event-bus/lilac-spec.ts", 351),
      source("apps/core/src/workflow/workflow-service.ts", 214),
    ],
  },
  {
    topic: "evt.workflow",
    role: "Workflow/task observation",
    semantics:
      "Current core has publishers but no subscriber; useful as external integration/observability contract, while SQLite remains authoritative.",
    key: "workflowId",
    producers: ["Workflow Service", "Workflow Resolver", "Workflow Scheduler"],
    consumers: ["No current core subscriber"],
    events: [
      {
        type: "evt.workflow.task.resolved",
        payload: "{ workflowId, taskId, result }",
        purpose: "Task result event",
      },
      {
        type: "evt.workflow.task.lifecycle.changed",
        payload: "task identity + state/detail/ts",
        purpose: "Task state observation",
      },
      {
        type: "evt.workflow.resolved",
        payload: "{ workflowId, result }",
        purpose: "Workflow aggregate result",
      },
      {
        type: "evt.workflow.lifecycle.changed",
        payload: "workflow identity + state/detail/ts",
        purpose: "Workflow state observation",
      },
    ],
    sources: [
      source("packages/event-bus/lilac-spec.ts", 201),
      source("packages/event-bus/lilac-spec.ts", 357),
      source("apps/core/src/workflow/workflow-resolver.ts", 21),
    ],
  },
  {
    topic: "cmd.agent",
    role: "Reserved agent command lane",
    semantics:
      "Typed in the canonical spec, but no current core publisher or subscriber was found. Treat as implemented contract surface, not wired behavior.",
    key: "agentId",
    producers: ["None in current core"],
    consumers: ["None in current core"],
    events: [
      {
        type: "cmd.agent.create",
        payload: "{ agentId, context }",
        purpose: "Reserved agent creation contract",
      },
    ],
    sources: [
      source("packages/event-bus/lilac-spec.ts", 238),
      source("packages/event-bus/lilac-spec.ts", 393),
    ],
  },
  {
    topic: "out.req.<request_id>",
    role: "Request-scoped agent output stream",
    semantics:
      "Dynamic topic + key derived from request_id; relay/subagent managers tail from begin or saved cursor; every publish refreshes 24h expiry.",
    key: "request_id",
    producers: ["Bus Agent Runner", "Subagent/attachment output helpers"],
    consumers: ["Discord/GitHub Relays", "Subagent join managers", "Recovery observers"],
    events: [
      {
        type: "evt.agent.output.delta.reasoning",
        payload: "{ delta, seq? }",
        purpose: "Reasoning progress",
      },
      {
        type: "evt.agent.output.delta.text",
        payload: "{ delta, seq? }",
        purpose: "Visible text delta",
      },
      {
        type: "evt.agent.output.response.text",
        payload: "{ finalText, delivery?, statsForNerdsLine? }",
        purpose: "Authoritative final visible text / skip",
      },
      {
        type: "evt.agent.output.response.binary",
        payload: "{ mimeType, dataBase64, filename? }",
        purpose: "Attachment/binary output",
      },
      {
        type: "evt.agent.output.toolcall",
        payload: "{ toolCallId, status, display, ok?, error? }",
        purpose: "Surface tool progress",
      },
      {
        type: "evt.agent.output.activity",
        payload: "{ source: model|tool|subagent }",
        purpose: "Idle watchdog/activity signal",
      },
    ],
    sources: [
      source("packages/event-bus/lilac-spec.ts", 243),
      source("packages/event-bus/lilac-spec.ts", 399),
      source("packages/event-bus/redis-streams-bus.ts", 347),
    ],
  },
] as const satisfies readonly EventTopic[];

export const STATE_MACHINES = [
  {
    id: "request-lifecycle",
    label: "Request Lifecycle",
    summary:
      "Bus-visible lifecycle; initial idle request may go directly to running, while busy-session requests first enter queued.",
    states: [
      { id: "queued", label: "queued", tone: "neutral" },
      { id: "running", label: "running", tone: "active" },
      { id: "resolved", label: "resolved", tone: "success" },
      { id: "failed", label: "failed", tone: "danger" },
      { id: "cancelled", label: "cancelled", tone: "blocked" },
    ],
    transitions: [
      { from: "queued", to: "running", label: "session becomes idle" },
      { from: "running", to: "resolved", label: "final response committed" },
      { from: "running", to: "failed", label: "run/model/idle failure" },
      { from: "queued", to: "cancelled", label: "queued cancel" },
      { from: "running", to: "cancelled", label: "active cancel / policy" },
    ],
    sources: [
      source("packages/event-bus/lilac-spec.ts", 58),
      source("apps/core/src/surface/bridge/bus-agent-runner.ts", 2389),
    ],
  },
  {
    id: "agent-loop",
    label: "AiSdkPiAgent Turn Loop",
    summary:
      "Canonical messages persist across turns; model/tool phases alternate, then steer and follow-ups drain at safe boundaries.",
    states: [
      { id: "idle", label: "idle", tone: "neutral" },
      { id: "model", label: "model running", tone: "active" },
      { id: "tools", label: "tools running", tone: "active" },
      { id: "steer", label: "drain steer", tone: "blocked" },
      { id: "followup", label: "drain follow-up", tone: "blocked" },
      { id: "ended", label: "agent_end", tone: "success" },
      { id: "aborted", label: "turn_abort/reset", tone: "danger" },
    ],
    transitions: [
      { from: "idle", to: "model", label: "prompt/continue" },
      { from: "model", to: "tools", label: "finalized tool calls" },
      { from: "tools", to: "model", label: "append tool results" },
      { from: "tools", to: "steer", label: "tool phase boundary" },
      { from: "model", to: "steer", label: "no tools" },
      { from: "steer", to: "model", label: "inject steer + buffered follow-ups" },
      { from: "steer", to: "followup", label: "no steer" },
      { from: "followup", to: "model", label: "inject follow-up" },
      { from: "followup", to: "ended", label: "queues empty" },
      { from: "model", to: "aborted", label: "interrupt" },
      { from: "aborted", to: "model", label: "rewind + rerun" },
    ],
    sources: [
      source("packages/agent/ai-sdk-pi-agent.ts", 653),
      source("packages/agent/ai-sdk-pi-agent.ts", 996),
      source("packages/agent/ai-sdk-pi-agent.ts", 1028),
    ],
  },
  {
    id: "workflow",
    label: "Workflow / Task State",
    summary:
      "Workflow and task share the same state vocabulary, but are separate records and events.",
    states: [
      { id: "queued", label: "queued", tone: "neutral" },
      { id: "running", label: "running", tone: "active" },
      { id: "blocked", label: "blocked", tone: "blocked" },
      { id: "resolved", label: "resolved", tone: "success" },
      { id: "failed", label: "failed", tone: "danger" },
      { id: "cancelled", label: "cancelled", tone: "blocked" },
    ],
    transitions: [
      { from: "queued", to: "running", label: "service/scheduler claims" },
      { from: "running", to: "blocked", label: "waiting reply/time" },
      { from: "blocked", to: "running", label: "matching event/due time" },
      { from: "running", to: "resolved", label: "completion met" },
      { from: "running", to: "failed", label: "invalid/runtime error" },
      { from: "blocked", to: "cancelled", label: "cancel command" },
    ],
    sources: [
      source("apps/core/src/workflow/types.ts", 66),
      source("packages/event-bus/lilac-spec.ts", 60),
    ],
  },
  {
    id: "acp-run",
    label: "ACP Prompt Run",
    summary:
      "Persisted JSON state observed by status/result/wait; worker liveness can trigger respawn or failure reconciliation.",
    states: [
      { id: "submitted", label: "submitted", tone: "neutral" },
      { id: "running", label: "running", tone: "active" },
      { id: "completed", label: "completed", tone: "success" },
      { id: "failed", label: "failed", tone: "danger" },
      { id: "cancelled", label: "cancelled", tone: "blocked" },
    ],
    transitions: [
      { from: "submitted", to: "running", label: "session resolved" },
      { from: "submitted", to: "submitted", label: "dead worker observed → respawn" },
      { from: "running", to: "completed", label: "normal stop reason" },
      { from: "running", to: "failed", label: "exception/dead worker" },
      { from: "submitted", to: "cancelled", label: "cancel requested" },
      { from: "running", to: "cancelled", label: "SIGTERM / cancelled stop" },
    ],
    sources: [
      source("apps/acp-controller/types.ts", 3),
      source("apps/acp-controller/controller.ts", 439),
      source("apps/acp-controller/controller.ts", 1245),
    ],
  },
  {
    id: "plugin-load",
    label: "Plugin Contribution Status",
    summary:
      "A plugin inventory entry is always visible as loaded, disabled, skipped, or failed; external errors do not necessarily abort all plugins.",
    states: [
      { id: "loaded", label: "loaded", tone: "success" },
      { id: "disabled", label: "disabled", tone: "neutral" },
      { id: "skipped", label: "skipped", tone: "blocked" },
      { id: "failed", label: "failed", tone: "danger" },
    ],
    transitions: [
      { from: "disabled", to: "loaded", label: "config enable + reload" },
      { from: "skipped", to: "loaded", label: "capability becomes available" },
      { from: "loaded", to: "failed", label: "fresh snapshot import/init error" },
      { from: "failed", to: "loaded", label: "tree/config fixed + reload" },
    ],
    sources: [
      source("packages/plugin-runtime/types.ts", 146),
      source("packages/plugin-runtime/manager.ts", 128),
    ],
  },
  {
    id: "remote-daemon",
    label: "Remote FS Daemon",
    summary:
      "Short-lived process coordinated by mkdir lock and socket; in-flight work suppresses idle exit.",
    states: [
      { id: "absent", label: "absent", tone: "neutral" },
      { id: "contender", label: "lock contender", tone: "blocked" },
      { id: "starting", label: "starting", tone: "active" },
      { id: "listening", label: "listening", tone: "success" },
      { id: "busy", label: "busy / inFlight", tone: "active" },
      { id: "idle", label: "idle countdown", tone: "blocked" },
      { id: "exit", label: "exit", tone: "neutral" },
    ],
    transitions: [
      { from: "absent", to: "contender", label: "socket connect failed" },
      { from: "contender", to: "starting", label: "mkdir lock won" },
      { from: "starting", to: "listening", label: "socket ready" },
      { from: "listening", to: "busy", label: "request accepted" },
      { from: "busy", to: "idle", label: "inFlight=0" },
      { from: "idle", to: "busy", label: "new request" },
      { from: "idle", to: "exit", label: "5m default idle" },
    ],
    sources: [
      source("packages/remote-fs-runner/src/cli.ts", 337),
      source("packages/remote-fs-runner/src/cli.ts", 385),
      source("packages/remote-fs-runner/src/cli.ts", 431),
    ],
  },
  {
    id: "config-cache",
    label: "Config Validation / Last-known-good",
    summary:
      "File events warm a validated global cache; services pull at boundaries and retain prior local config on failure.",
    states: [
      { id: "missing", label: "missing", tone: "neutral" },
      { id: "seeded", label: "seeded v2", tone: "success" },
      { id: "valid", label: "valid parsed", tone: "success" },
      { id: "cached", label: "cached", tone: "active" },
      { id: "invalid", label: "invalid change", tone: "danger" },
      { id: "lkg", label: "last-known-good", tone: "blocked" },
    ],
    transitions: [
      { from: "missing", to: "seeded", label: "copy v2 template" },
      { from: "seeded", to: "valid", label: "version parser" },
      { from: "valid", to: "cached", label: "prompt composition" },
      { from: "cached", to: "invalid", label: "bad watched edit" },
      { from: "invalid", to: "lkg", label: "validation warning" },
      { from: "lkg", to: "cached", label: "file fixed + pull" },
    ],
    sources: [
      source("packages/utils/core-config.ts", 265),
      source("apps/core/src/runtime/create-core-runtime.ts", 366),
    ],
  },
] as const satisfies readonly StateMachine[];

export const WORKSPACE_PACKAGES = [
  {
    id: "apps/core",
    label: "@stanley2058/lilac-core",
    kind: "app",
    role: "Composition root and production runtime",
    runtime: "Bun process + Discord/GitHub + HTTP tool server",
    dependsOn: [
      "packages/agent",
      "packages/event-bus",
      "packages/fs",
      "packages/plugin-runtime",
      "packages/remote-fs-runner",
      "packages/utils",
    ],
    keyFiles: [
      source("apps/core/src/runtime/main.ts", 10),
      source("apps/core/src/runtime/create-core-runtime.ts", 107),
    ],
  },
  {
    id: "apps/tool-bridge",
    label: "@stanley2058/lilac-tool-bridge",
    kind: "app",
    role: "tools CLI and standalone dev Tool Server",
    runtime: "Bun CLI / Elysia dev process",
    dependsOn: ["apps/core", "packages/utils"],
    keyFiles: [source("apps/tool-bridge/client.ts", 14), source("apps/tool-bridge/index.ts", 12)],
  },
  {
    id: "apps/acp-controller",
    label: "@stanley2058/lilac-acp-controller",
    kind: "app",
    role: "Independent multi-harness ACP controller",
    runtime: "Caller + detached worker + harness child",
    dependsOn: [],
    keyFiles: [
      source("apps/acp-controller/client.ts", 1),
      source("apps/acp-controller/controller.ts", 704),
    ],
  },
  {
    id: "packages/event-bus",
    label: "@stanley2058/lilac-event-bus",
    kind: "package",
    role: "Canonical events, typed facade, Redis Streams transport",
    runtime: "In-process library + Redis connections",
    dependsOn: ["packages/utils"],
    keyFiles: [
      source("packages/event-bus/lilac-spec.ts", 1),
      source("packages/event-bus/redis-streams-bus.ts", 254),
    ],
  },
  {
    id: "packages/agent",
    label: "@stanley2058/lilac-agent",
    kind: "package",
    role: "AI SDK turn loop, queues, compaction",
    runtime: "In-process library",
    dependsOn: ["packages/utils"],
    keyFiles: [
      source("packages/agent/ai-sdk-pi-agent.ts", 653),
      source("packages/agent/auto-compaction.ts", 1117),
    ],
  },
  {
    id: "packages/plugin-runtime",
    label: "@stanley2058/lilac-plugin-runtime",
    kind: "package",
    role: "Level 1/2 plugin contract, discovery, lifecycle",
    runtime: "In-process dynamic imports",
    dependsOn: [],
    keyFiles: [
      source("packages/plugin-runtime/types.ts", 5),
      source("packages/plugin-runtime/manager.ts", 108),
    ],
  },
  {
    id: "packages/fs",
    label: "@stanley2058/lilac-fs",
    kind: "package",
    role: "Local/remote shared filesystem domain implementation",
    runtime: "In-process FileSystem / rg / fff",
    dependsOn: [],
    keyFiles: [
      source("packages/fs/src/fs-impl.ts", 450),
      source("packages/fs/src/search-backend.ts", 9),
    ],
  },
  {
    id: "packages/remote-fs-runner",
    label: "@stanley2058/lilac-remote-fs-runner",
    kind: "package",
    role: "Published request shim + short-lived remote daemon",
    runtime: "Remote CLI/daemon process",
    dependsOn: ["packages/fs (dev/build source)"],
    keyFiles: [
      source("packages/remote-fs-runner/src/cli.ts", 272),
      source("packages/remote-fs-runner/package.json", 2),
    ],
  },
  {
    id: "packages/utils",
    label: "@stanley2058/lilac-utils",
    kind: "package",
    role: "Config, providers, prompts, skills, env, logging",
    runtime: "In-process shared library",
    dependsOn: [],
    keyFiles: [
      source("packages/utils/core-config.ts", 202),
      source("packages/utils/model-provider.ts", 158),
    ],
  },
] as const satisfies readonly WorkspacePackage[];

export const PERSISTENCE_ENTRIES = [
  {
    name: "Redis Streams: durable topics",
    owner: "event-bus transport",
    location: "lilac:event-bus:<topic>",
    purpose: "cmd/evt lanes and consumer-group cursors",
    lifecycle: "Watermark trim after ACK; evt.request intentionally not trimmed",
    source: source("packages/event-bus/redis-streams-bus.ts", 254),
  },
  {
    name: "Redis Streams: output",
    owner: "agent runner / relay",
    location: "lilac:event-bus:out.req.<request_id>",
    purpose: "Request-scoped text/reasoning/tool/binary replay",
    lifecycle: "24h EXPIRE refreshed on every publish",
    source: source("packages/event-bus/redis-streams-bus.ts", 347),
  },
  {
    name: "Workflow DB",
    owner: "Workflow Service/Scheduler",
    location: "<DATA_DIR>/data.sqlite3",
    purpose: "Workflow/task definitions, state, indexed reply/time fields",
    lifecycle: "Durable across core restart; terminal records retained by store policy",
    source: source("packages/utils/env.ts", 51),
  },
  {
    name: "Discord surface DB",
    owner: "DiscordSurfaceStore",
    location: "<DATA_DIR>/discord-surface.db (configurable)",
    purpose: "Platform message/session cache and read history",
    lifecycle: "Persistent local cache",
    source: source("packages/utils/core-config.ts", 329),
  },
  {
    name: "Discord search DB",
    owner: "Search + Conversation Thread",
    location: "<DATA_DIR>/discord-search.db",
    purpose: "Message search, derived threads, FTS/facets/vectors",
    lifecycle: "Incremental index; summaries/embeddings invalidated by hashes",
    source: source("packages/utils/core-config.ts", 339),
  },
  {
    name: "Agent transcripts",
    owner: "SqliteTranscriptStore",
    location: "<DATA_DIR>/agent-transcripts.db",
    purpose: "Request snapshots, surface links, compaction checkpoints",
    lifecycle: "Persistent; unlinked checkpoint candidates cleaned immediately/after 24h",
    source: source("packages/utils/core-config.ts", 335),
  },
  {
    name: "Discovery DB",
    owner: "DiscoveryService",
    location: "<DATA_DIR>/discovery.db",
    purpose: "Discovery/search service state",
    lifecycle: "Persistent local service DB",
    source: source("packages/utils/core-config.ts", 341),
  },
  {
    name: "Graceful restart DB",
    owner: "Core runtime",
    location: "<DATA_DIR>/graceful-restart.db",
    purpose: "Singleton agent + relay recovery snapshot",
    lifecycle: "Consume-once; logical freshness TTL 120s",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 498),
  },
  {
    name: "Core config",
    owner: "utils/core-config",
    location: "<DATA_DIR>/core-config.yaml",
    purpose: "Versioned runtime configuration",
    lifecycle: "Seed if missing; never auto-upgrade/rewrite",
    source: source("packages/utils/core-config.ts", 110),
  },
  {
    name: "Prompt workspace",
    owner: "utils/agent-prompts",
    location: "<DATA_DIR>/prompts/*",
    purpose: "Editable system prompt fragments and template baselines",
    lifecycle: "Managed files update; local edits preserved with *.new conflict files",
    source: source("PROJECT.md", 345),
  },
  {
    name: "External plugins / skills",
    owner: "Plugin manager / skill discovery",
    location: "<DATA_DIR>/plugins/* and skills/*",
    purpose: "On-disk capability bundles",
    lifecycle: "Fingerprint/reload; plugin snapshots cache-bust imports",
    source: source("packages/plugin-runtime/discovery.ts", 103),
  },
  {
    name: "Tool result artifacts",
    owner: "Artifact store",
    location: "<DATA_DIR>/tool-results",
    purpose: "Encrypted overflow payload behind session-owned tool-result:// URI",
    lifecycle: "Transient; startup cleanup + TTL/quota eviction",
    source: source("apps/core/src/artifacts/tool-result-artifact-store.ts", 205),
  },
  {
    name: "ACP run records",
    owner: "lilac-acp",
    location: "$XDG_STATE_HOME/lilac-acp-controller/runs/<runId>.json",
    purpose: "Prompt, PID, status, history, plan, result/error",
    lifecycle: "Atomic temp+rename per update; independent of DATA_DIR",
    source: source("apps/acp-controller/run-store.ts", 14),
  },
  {
    name: "ACP session index",
    owner: "lilac-acp",
    location: "$XDG_STATE_HOME/lilac-acp-controller/sessions/index.json",
    purpose: "Cross-harness session cache / local titles",
    lifecycle: "mkdir lock, 5s deadline, merge by canonical sessionRef",
    source: source("apps/acp-controller/run-store.ts", 128),
  },
  {
    name: "Remote fff runtime",
    owner: "remote-fs-runner",
    location: "$XDG_CACHE_HOME/lilac/remote-fs-runner/<version>",
    purpose: "daemon socket, startup lock, fff persistent root indexes",
    lifecycle: "Daemon idle exits; version changes create new namespace/cache",
    source: source("packages/remote-fs-runner/src/cli.ts", 85),
  },
] as const satisfies readonly PersistenceEntry[];

export const STARTUP_SEQUENCE = [
  {
    order: 1,
    title: "Redis hard dependency",
    detail:
      "Require REDIS_URL, ping, create Streams bus + blocking-reader pool (warm 8, initial/max 16, autoscale cap 256).",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 126),
  },
  {
    order: 2,
    title: "Local managers / stores",
    detail:
      "Initialize custom commands, adapters, workflow store, data dirs, artifacts, transcript/search/surface/conversation stores.",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 165),
  },
  {
    order: 3,
    title: "Search + summarization",
    detail: "Start conversation summarization worker isolate and Discord search indexer.",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 541),
  },
  {
    order: 4,
    title: "Ingress bridge before connect",
    detail: "Subscribe Adapter-to-Bus before Discord connect, preventing early-event loss.",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 564),
  },
  {
    order: 5,
    title: "Workflow / scheduler / router",
    detail: "Start every evt.adapter consumer before adapter.connect().",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 576),
  },
  {
    order: 6,
    title: "Request cache + plugins + HTTP tools",
    detail: "Tool context and Level 2 server are ready before any agent run.",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 615),
  },
  {
    order: 7,
    title: "Connect Discord",
    detail: "Only after ingress consumers and Tool Server are ready.",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 677),
  },
  {
    order: 8,
    title: "Start Discord relay",
    detail: "Output consumer exists before runner can publish evt.request.reply.",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 684),
  },
  {
    order: 9,
    title: "Optional GitHub surface",
    detail: "GitHub webhook + relay start together only when App secret exists.",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 696),
  },
  {
    order: 10,
    title: "Agent runner last",
    detail: "Prevents replies/output from racing ahead of relays/cache.",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 721),
  },
  {
    order: 11,
    title: "Restore relays then agents",
    detail:
      "Consume fresh graceful snapshot; output subscriptions are restored before recoverable requests.",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 738),
  },
  {
    order: 12,
    title: "Heartbeat + periodic conversation",
    detail:
      "Autonomous lane starts with restored external-active state; runtime finally marks fully started.",
    source: source("apps/core/src/runtime/create-core-runtime.ts", 767),
  },
] as const;

export const DEPLOYMENT_UNITS = [
  {
    zone: "EXTERNAL",
    name: "Discord / GitHub / Model + Web APIs",
    runtime: "Managed platform endpoints",
    detail:
      "Discord Gateway/REST and optional GitHub webhook are human surfaces. Model/search providers are outbound HTTPS dependencies selected by config and environment.",
    interfaces: ["Discord Gateway + REST", "GitHub webhook / API", "HTTPS model and search APIs"],
    sources: [
      source("packages/utils/env.ts", 57),
      source("apps/core/src/runtime/create-core-runtime.ts", 667),
    ],
  },
  {
    zone: "COMPOSE / LILAC",
    name: "lilac:dev container",
    runtime: "Bun → apps/core/src/runtime/main.ts",
    detail:
      "Ubuntu-based application container. The core process embeds the Tool Server, exposes host port 8080, and runs as the configured non-root user with tini-style init enabled.",
    interfaces: ["0.0.0.0:8080 → Tool Server", "REDIS_URL=redis://redis:6379", "healthz every 15s"],
    sources: [source("compose.yaml", 2), source("Dockerfile", 174), source("compose.yaml", 35)],
  },
  {
    zone: "COMPOSE / REDIS",
    name: "redis:7-alpine container",
    runtime: "redis-server --appendonly yes",
    detail:
      "Internal event-bus transport and persistence. The lilac service waits for redis-cli ping health before startup; Redis is not published as a host port by this compose file.",
    interfaces: ["Compose DNS: redis:6379", "redis-cli ping healthcheck", "redis-data:/data"],
    sources: [source("compose.yaml", 16), source("compose.yaml", 54)],
  },
  {
    zone: "HOST BINDS",
    name: "Application state mounts",
    runtime: "Host filesystem → /data and /home/lilac",
    detail:
      "The whole DATA_DIR, agent bundles, and SSH configuration persist outside the container. Global Bun/npm installs and GPG/config paths are redirected into /data.",
    interfaces: [
      "./data:/data",
      "./home/agents:/home/lilac/.agents",
      "./home/.ssh:/home/lilac/.ssh",
    ],
    sources: [source("compose.yaml", 25), source("compose.yaml", 37)],
  },
  {
    zone: "BUILD",
    name: "Workspace image pipeline",
    runtime: "tools → deps → build stages",
    detail:
      "Bun performs one frozen workspace install, then builds the tools CLI, embedded remote runner, and published remote-fs runner. The tools binary is symlinked into /usr/local/bin.",
    interfaces: [
      "bun install --frozen-lockfile",
      "tools CLI bundle",
      "remote FS bundles",
      "/usr/local/bin/tools",
    ],
    sources: [source("Dockerfile", 125), source("Dockerfile", 141), source("Dockerfile", 157)],
  },
  {
    zone: "REMOTE / OPTIONAL",
    name: "SSH target hosts",
    runtime: "remote bash + embedded CJS or remote-fs daemon",
    detail:
      "Not part of the Compose network. Core spawns local ssh against explicit aliases; each remote host executes one-shot JS or a versioned short-lived daemon/cache.",
    interfaces: ["OpenSSH child process", "stdin/stdout JSON", "remote Unix socket / named pipe"],
    sources: [
      source("apps/core/src/ssh/ssh-exec.ts", 257),
      source("packages/remote-fs-runner/src/cli.ts", 85),
    ],
  },
] as const;

export const DEPLOYMENT_CONNECTIONS = [
  {
    from: "Discord",
    to: "lilac container",
    protocol: "Gateway + REST",
    direction: "bidirectional",
    note: "Primary surface; token and allowlists from env/config",
  },
  {
    from: "GitHub",
    to: "lilac container",
    protocol: "Webhook + REST",
    direction: "bidirectional",
    note: "Optional; App secret gates ingress and relay",
  },
  {
    from: "lilac container",
    to: "redis container",
    protocol: "Redis Streams / TCP 6379",
    direction: "bidirectional",
    note: "Hard startup dependency",
  },
  {
    from: "Operator / agent",
    to: "lilac container",
    protocol: "HTTP :8080",
    direction: "inbound",
    note: "Tool Server has no code-level HTTP auth",
  },
  {
    from: "lilac container",
    to: "Model / web APIs",
    protocol: "HTTPS / SSE / WebSocket",
    direction: "outbound",
    note: "Availability follows configured provider credentials",
  },
  {
    from: "lilac container",
    to: "SSH target",
    protocol: "OpenSSH + JSON",
    direction: "outbound",
    note: "Explicit non-wildcard SSH aliases only",
  },
] as const;

export const CONTEXT_LAYERS = [
  {
    order: 1,
    name: "Canonical active transcript",
    owner: "AiSdkPiAgent.state.messages",
    mutability: "Authoritative during one active run",
    content:
      "Real user/assistant/tool messages; replaced only by explicit reset/compaction/interrupt logic.",
    notThis: "Not the request SQLite checkpoint and not conversation memory.",
    source: source("packages/agent/ai-sdk-pi-agent.ts", 218),
  },
  {
    order: 2,
    name: "Outbound model view",
    owner: "BusAgentRunner transformMessages",
    mutability: "Ephemeral per model turn",
    content:
      "Binary scrub, old tool-output placeholders, cache metadata, provider tool-call ID normalization.",
    notThis: "Usually does not mutate canonical transcript; tool-result pruning lives here.",
    source: source("apps/core/src/surface/bridge/bus-agent-runner.ts", 3387),
  },
  {
    order: 3,
    name: "Request transcript / checkpoint",
    owner: "SqliteTranscriptStore",
    mutability: "Persisted after/request during execution",
    content:
      "Response slices, request messages, surface mappings; full canonical transcript when compaction occurred.",
    notThis:
      "Not automatically all Discord history; reachability depends on linked surface MsgRefs.",
    source: source("apps/core/src/surface/bridge/bus-agent-runner.ts", 4176),
  },
  {
    order: 4,
    name: "Conversation thread memory",
    owner: "ConversationThreadStore/Service",
    mutability: "Derived asynchronously from Discord search DB",
    content: "Inferred groups, summaries, FTS facets, optional vectors and retrieval metadata.",
    notThis:
      "Not built directly from each agent transcript and not loaded wholesale into every request.",
    source: source("apps/core/src/conversation/thread-store.ts", 839),
  },
  {
    order: 5,
    name: "Heartbeat handoff",
    owner: "Heartbeat transcript helper",
    mutability: "Persisted only for explicit proactive surface writes",
    content:
      "Compact context linked to each real MsgRef, with tool outputs replaced by placeholders.",
    notThis: "Not the heartbeat final assistant output; HEARTBEAT_OK is skipped.",
    source: source("apps/core/src/transcript/heartbeat-handoff.ts", 24),
  },
] as const;

export const FS_TRANSPORT_MATRIX = [
  {
    operation: "read_text",
    remotePrimary: "Embedded CJS",
    fallback: "none",
    sharedBackend: "direct filesystem read",
    caveat: "Never daemon-first",
  },
  {
    operation: "read_bytes",
    remotePrimary: "Embedded CJS",
    fallback: "none",
    sharedBackend: "direct filesystem read + base64",
    caveat: "Max-bytes stat gate",
  },
  {
    operation: "glob",
    remotePrimary: "fff daemon only when fsBackend=fff",
    fallback: "Embedded CJS",
    sharedBackend: "fff → recursive node fs",
    caveat: "Complex/exclude/node_modules patterns often bypass fff",
  },
  {
    operation: "grep",
    remotePrimary: "fff daemon only when fsBackend=fff",
    fallback: "Embedded CJS",
    sharedBackend: "fff → rg --json",
    caveat: "Two fallback layers: transport then backend",
  },
  {
    operation: "fuzzy_search",
    remotePrimary: "fff daemon",
    fallback: "none",
    sharedBackend: "fff only",
    caveat: "Returns explicit unavailable error",
  },
  {
    operation: "edit",
    remotePrimary: "Embedded CJS",
    fallback: "none",
    sharedBackend: "legacy/hashline with read/hash preconditions",
    caveat: "Runner package has fs.edit, but core callsite does not use daemon path",
  },
  {
    operation: "apply_patch",
    remotePrimary: "Embedded CJS",
    fallback: "none",
    sharedBackend: "remote patch dispatcher",
    caveat: "Separate Level 1 tool from edit_file",
  },
] as const;

export const CONFIG_VERSION_DIFF = [
  {
    field: "Missing configVersion",
    v1: "Interpreted as v1",
    v2: "Must explicitly say 2",
    impact: "Legacy files keep legacy defaults without rewrite",
  },
  {
    field: "Filesystem backend",
    v1: "node-rg",
    v2: "fff",
    impact: "Search performance and fuzzy availability",
  },
  {
    field: "Hashline editing",
    v1: "false / legacy experimental name",
    v2: "true / tools.editFile.hashline",
    impact: "Stale-line protection enabled by default in v2",
  },
  {
    field: "Inspect model",
    v1: "google/gemini-3-flash",
    v2: "google/gemini-3.5-flash",
    impact: "Version-owned default",
  },
  {
    field: "Discord output",
    v1: "inline/embed/table off, width 80",
    v2: "preview/plain/notification on, table on width 50",
    impact: "Visible surface behavior changes",
  },
  {
    field: "Reasoning display",
    v1: "simple",
    v2: "detailed",
    impact: "More granular reasoning status in v2",
  },
  {
    field: "Transient retry",
    v1: "disabled / 0",
    v2: "enabled / 3",
    impact: "Only pre-output transient errors are retried",
  },
  {
    field: "Subagent timeout",
    v1: "defaultTimeoutMs converts to idle; max discarded",
    v2: "idleTimeout directly",
    impact: "Timeout is activity-based, not total runtime",
  },
] as const;

export const SAFETY_AND_RELIABILITY = [
  {
    type: "defense",
    area: "Bash",
    title: "Destructive command analyzer + process-group kill",
    detail:
      "Trusted bash analyzes dangerous commands unless dangerouslyAllow; timeout/abort TERM then KILL. Output redaction is best-effort, not a security boundary.",
    source: source("apps/core/src/tools/bash-impl.ts", 565),
  },
  {
    type: "defense",
    area: "Restricted execution",
    title: "just-bash virtual filesystem",
    detail:
      "Workspace read overlay, session temp writes, no symlink/SSH cwd, resource limits, credential/config path denies; Level 2 adds central allowlist.",
    source: source("apps/core/src/tools/restricted-bash.ts", 425),
  },
  {
    type: "defense",
    area: "Filesystem",
    title: "Deny paths + hash/read preconditions",
    detail:
      "Secrets, tool-results and credential directories denied; edit requires expected hash or same-instance prior read unless dangerouslyAllow.",
    source: source("apps/core/src/tools/fs/fs.ts", 1062),
  },
  {
    type: "defense",
    area: "Artifacts",
    title: "Encrypted, owned, transient overflow",
    detail:
      "AES-256-GCM, random in-memory key, 0600, session ownership, TTL/quota eviction and startup cleanup.",
    source: source("apps/core/src/artifacts/tool-result-artifact-store.ts", 205),
  },
  {
    type: "limitation",
    area: "Event contract",
    title: "Compile-time only payload typing",
    detail:
      "Corrupt/unknown payload may be cast into typed message; only key correlation headers receive hard runtime checks in key paths.",
    source: source("packages/event-bus/lilac-spec.ts", 1),
  },
  {
    type: "limitation",
    area: "Redis delivery",
    title: "Pending without reclaim/DLQ",
    detail:
      "Durable handler throw leaves entry pending and loop continues with >; no current XAUTOCLAIM/reclaim/dead-letter path.",
    source: source("packages/event-bus/redis-streams-bus.ts", 585),
  },
  {
    type: "limitation",
    area: "Plugins",
    title: "Trusted in-process code",
    detail:
      "Tree snapshot/cache busting is not sandboxing; external plugin runs with core process permissions and may define its own restricted-mode enablement.",
    source: source("PLUGIN_AUTHORING.md", 129),
  },
  {
    type: "limitation",
    area: "Tool HTTP",
    title: "No code-level authentication",
    detail:
      "Correlation/safety headers are caller-provided; deployment depends on localhost/container/network trust. Config lookup errors currently fail open to trusted.",
    source: source("apps/core/src/tool-server/create-tool-server.ts", 256),
  },
  {
    type: "limitation",
    area: "Timeout",
    title: "AbortSignal requires cooperation",
    detail:
      "Server deadline returns an error, but a plugin that ignores signal may continue; health watchdog later marks overdue activity unhealthy.",
    source: source("apps/core/src/tool-server/health-state.ts", 163),
  },
  {
    type: "limitation",
    area: "Retention",
    title: "Output replay window",
    detail:
      "out.req streams expire after 24h; graceful snapshot is fresh for 120s. evt.request is intentionally untrimmed and needs retention monitoring.",
    source: source("packages/event-bus/redis-streams-bus.ts", 28),
  },
] as const;

export const IMPLEMENTATION_GAPS = [
  {
    status: "planned-gap",
    title: "ACP npx fallback / registry OS validation",
    current: "Four hard-coded PATH probes: opencode, codex-acp, claude-agent-acp, cursor-agent.",
    planned: "Plan describes npx fallbacks and richer registry/OS validation.",
    source: source("apps/acp-controller/harness-registry.ts", 7),
    plan: source("plan/unified-acp-harness-controller.md", 23),
  },
  {
    status: "partial",
    title: "ACP cancel wire call",
    current: "Cancel persists cancelRequestedAt, SIGTERM worker, worker closes ACP transport.",
    planned: "AcpHarnessClient.cancel() exists but has no caller; plan claims ACP cancellation.",
    source: source("apps/acp-controller/controller.ts", 1170),
    plan: source("plan/unified-acp-harness-controller.md", 48),
  },
  {
    status: "unwired",
    title: "cmd.agent",
    current: "Canonical cmd.agent.create type exists, but no core publisher/subscriber was found.",
    planned: "No claim made; presented as an unwired contract lane.",
    source: source("packages/event-bus/lilac-spec.ts", 393),
    plan: source("packages/event-bus/lilac-spec.ts", 238),
  },
  {
    status: "unwired",
    title: "evt.workflow consumers",
    current:
      "Service/resolver/scheduler publish lifecycle/results; current core has no subscriber.",
    planned: "Useful for external observers, but not an internal feedback loop today.",
    source: source("apps/core/src/workflow/workflow-resolver.ts", 21),
    plan: source("packages/event-bus/lilac-spec.ts", 357),
  },
  {
    status: "partial",
    title: "Remote daemon operation coverage",
    current:
      "Core uses daemon-first only for fff glob/grep and daemon-only fuzzy; read/edit remain embedded.",
    planned: "Runner package exposes more ops, but callsite topology remains dual-path.",
    source: source("apps/core/src/tools/fs/remote-fs.ts", 362),
    plan: source("packages/remote-fs-runner/src/cli.ts", 167),
  },
] as const;

export const BUILTIN_PLUGIN_IDS = [
  "builtin-local-tools",
  "web",
  "skills",
  "discovery",
  "conversation.thread",
  "workflow",
  "surface",
  "attachment",
  "onboarding",
  "generate",
  "codex",
  "content.inspect",
  "ssh",
] as const;

export const LEVEL1_TOOL_MATRIX = [
  {
    tool: "bash",
    primary: true,
    self: true,
    general: true,
    explore: false,
    restricted: true,
    notes: "Restricted uses just-bash, not OS shell",
  },
  {
    tool: "read_file",
    primary: true,
    self: true,
    general: true,
    explore: true,
    restricted: true,
    notes: "Restricted only session-owned tool-result:// artifacts",
  },
  {
    tool: "glob / grep",
    primary: true,
    self: true,
    general: true,
    explore: true,
    restricted: false,
    notes: "Parallel-safe with read_file, max 4 workers",
  },
  {
    tool: "fuzzy_search",
    primary: true,
    self: true,
    general: true,
    explore: false,
    restricted: false,
    notes: "Only when fsBackend=fff",
  },
  {
    tool: "edit_file / apply_patch",
    primary: true,
    self: true,
    general: true,
    explore: false,
    restricted: false,
    notes: "Editing mode selects one interface",
  },
  {
    tool: "batch",
    primary: true,
    self: true,
    general: true,
    explore: true,
    restricted: true,
    notes: "Only supportsBatch contributions; edit collisions preflight",
  },
  {
    tool: "subagent_delegate",
    primary: true,
    self: true,
    general: false,
    explore: false,
    restricted: false,
    notes: "Depth/profile/model gates apply; self cannot delegate self",
  },
] as const;
