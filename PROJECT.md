# Lilac Monorepo: Structure, Terminology, And Working Mental Model

This repo is an event-driven “agent runtime” built around a typed event bus (Redis Streams), Discord and GitHub surface adapters, and **layered tools** that are **progressively disclosed** to the agent:

- Level 1 (direct AI SDK tools): low-level local tools the LLM can call during generation (`bash`, `read_file`, `glob`, `grep`, `apply_patch`, `batch`, and `subagent_delegate` when enabled).
- Level 2 (tool server + `tools` CLI): a stable HTTP tool API (Elysia) exposed via the `tools` CLI (and usable by the agent through `bash`).
- Level 3 (skills): higher-level, file-based “skill bundles” discovered on disk and loaded on-demand.

All three are “for the agent”; the layering is mostly about keeping the default prompt/tool surface small while still enabling richer capabilities when needed.

The main loop is:

1. Surface ingress receives platform events (Discord adapter events and optional GitHub webhook triggers).
2. Discord adapter events are published onto the bus (`evt.adapter`).
3. A router turns Discord adapter events into request messages (`cmd.request.message`) based on per-session routing mode.
4. GitHub webhook handlers can publish `cmd.request.message` directly for GitHub-triggered runs.
5. An agent runner consumes request messages, runs an LLM (AI SDK) with local tools, and publishes streamed output to request-scoped topics (`out.req.<request_id>`).
6. A relay subscribes to `out.req.<request_id>` and streams output back to surface adapters (Discord and GitHub).
7. The unified workflow engine executes trusted immutable programs through the same request bus and projects durable progress independently of request output relays.

This document explains where things live, the words used in code, and the project’s “shape” so you don’t have to re-derive it each time.

---

## Repo Layout (What Is Where)

Workspace roots are Bun workspaces (`apps/*`, `packages/*`). `ref/` contains vendored upstreams as git submodules and is treated as read-only.

`scripts/architecture/` contains the architecture manifest and semantic checker; syntax-only rules live under `scripts/oxlint-plugins/`.

- `apps/core/`
  - The core runtime process (Discord + optional GitHub surfaces, event bus, router, agent runner, unified workflow engine, tool server, and runtime recovery/search services).
  - Entry: `apps/core/src/runtime/main.ts` (starts/stops `createCoreRuntime()`).
  - Most of the “system wiring” is in `apps/core/src/runtime/create-core-runtime.ts`.

- `apps/tool-bridge/`
  - The `tools` CLI + a “dev-mode” tool server.
  - CLI client: `apps/tool-bridge/client.ts`.
  - Tool server (no bus, no surface adapter by default): `apps/tool-bridge/index.ts`.
  - Build script: `apps/tool-bridge/build.ts` (produces `dist/index.js`, used as the `tools` binary).

- `apps/acp-controller/`
  - ACP harness controller CLI (`lilac-acp`) with JSON and human output modes, designed for local and automation/ssh workflows.
  - Entry/client: `apps/acp-controller/client.ts`.
  - Build script: `apps/acp-controller/build.ts` (produces `dist/index.js`).

- `apps/mini-lilac-server/`
  - Redis-free coding-agent HTTP/SSE server with durable local sessions and process-local active-run replay.
  - Entry: `apps/mini-lilac-server/src/main.ts`; API wiring: `apps/mini-lilac-server/src/server.ts`.

- `apps/mini-lilac-tui/`
  - OpenTUI client for creating, resuming, steering, and inspecting Mini Lilac sessions.
  - Entry: `apps/mini-lilac-tui/src/main.tsx`.

- `apps/mini-lilac/`
  - Installable `mini-lilac` command that bundles and dispatches to Mini Lilac clients and server.
  - Entry: `apps/mini-lilac/src/main.ts`; build: `apps/mini-lilac/build.ts`.

- `packages/event-bus/`
  - The bus implementation and the canonical event spec.
  - Single event catalog and payload schemas: `packages/event-bus/lilac-spec.ts`.
  - Typed bus wrapper: `packages/event-bus/lilac-bus.ts`.
  - Redis Streams transport: `packages/event-bus/redis-streams-bus.ts`.
  - Low-level types: `packages/event-bus/types.ts`.

- `packages/agent/`
  - The “pi-agent-like” wrapper around AI SDK streaming + steering/follow-up/interrupt queues.
  - Core implementation: `packages/agent/ai-sdk-pi-agent.ts`.
  - Optional auto-compaction: `packages/agent/auto-compaction.ts`.

- `packages/utils/`
  - Cross-cutting utilities: env parsing, core config, model providers, prompt templates, skills.
  - Config schema + loader: `packages/utils/core-config.ts`.
  - Provider wiring: `packages/utils/model-provider.ts`.
  - Model selection for “main/fast” slots: `packages/utils/model-slot.ts`.
  - Prompt file workspace management: `packages/utils/agent-prompts.ts`.

- `packages/mini-lilac-client/`
  - Strict Mini Lilac wire protocol and reconnectable HTTP/SSE transport shared by clients and the server.

- `packages/mini-lilac-runtime/`
  - Standalone session actors, immutable SQLite transcript chains, live active-run logs, provider/model catalogs, and product-specific tools.
  - Uses the shared agent, coding-tool, filesystem, OAuth, and skill primitives without depending on Core.

- `data/`
  - “Runtime data directory” for local/dev.
  - Prompt workspace lives in `data/prompts/*` by default.
  - `core-config.yaml` is seeded into `DATA_DIR` on startup if missing.
  - In docker compose this directory is bind-mounted for persistence.

- `__tests__/`
  - Root-level repository tests and shared test preloads.

- `compose.yaml` and `Dockerfile`
  - A container that starts Core; Compose includes Redis.
  - The docker build installs Bun, system tools (git, rg, browser dependencies, python, etc.), builds tool-bridge, and symlinks `tools` into PATH.
  - `bun run docker:verify-image` boots a credential-free verify-only container; `bun run docker:verify` checks a running Compose service.
  - Docker compose persists extra home directories for agent ergonomics:
    - `./home/agents:/home/lilac/.agents`
    - `./home/.ssh:/home/lilac/.ssh`

---

## Key Concepts / Terminology

### Bus / Topics / Subscriptions

The event bus is Redis Streams underneath, wrapped in a typed API.

Implementation note: subscriptions use a small Redis connection pool because Redis Streams reads are blocking (`XREAD`/`XREADGROUP`). See `packages/event-bus/redis-connection-pool.ts` and `packages/event-bus/redis-streams-bus.ts`.

- Topic: a logical channel (backed by a Redis Stream key).
  - Examples (static topics): `cmd.request`, `evt.adapter`, `evt.request`, `evt.workflow`.
  - Output topics are request-scoped: `out.req.<request_id>`.

- Event type: a string like `cmd.request.message`.
  - `LILAC_EVENTS` in `packages/event-bus/lilac-spec.ts` is the single source for event types, families, routing, keys, payload contracts, and codecs.

- Subscription `mode` (delivery semantics):
  - `work`: consumer-group queue semantics (competing consumers).
  - `fanout`: consumer-group broadcast semantics (each subscriptionId sees all events).
  - `tail`: non-durable streaming read (no consumer group).

- subscriptionId: durable identifier for the consumer group (used by `work`/`fanout`).
- consumerId: identity inside the group (often includes pid + random to avoid collisions).
- cursor: Redis stream entry id; used as an offset/checkpoint.

### Envelope Headers (Correlation)

The “request-scoped” part of the system uses consistent headers on bus messages:

- `request_id`: correlates everything for a single agent run.
- `session_id`: the surface session (e.g. Discord channel/thread id or `OWNER/REPO#number` for GitHub).
- `request_client`: source platform (`discord`, `github`, or `unknown`).

Many flows treat missing `request_id` as an error (especially request lifecycle and output events).

### Surface / Adapter / Session

“Surface” is the user-facing platform integration layer.

- Adapter: implements the unparameterized, operation-Result-returning `SurfaceAdapter` (`apps/core/src/surface/discord/discord-adapter.ts`, `apps/core/src/surface/github/github-adapter.ts`).
- Session: a platform container (Discord channel/thread/DM or GitHub `OWNER/REPO#number`).
- Message refs:
  - `SessionRef` / `MsgRef` are closed discriminated unions that identify sessions/messages for the implemented Core platforms.

The Discord adapter also maintains a local SQLite cache (`discord-surface.db`) for read-history operations.

### Surface Runtime Registry

Core composes its implemented surfaces through one closed `SurfaceRuntimeRegistry` in
`apps/core/src/surface/runtime-descriptor.ts`. A platform-parameterized descriptor binds an
unparameterized adapter to coarse structural ports for adapter ingress, request ingress, output relay,
and workflow progress. Port presence declares complete subsystem participation; optional adapter
operations are attempted directly and their typed `SurfaceOperationResult` is authoritative. There is
no predeclared operation-support metadata, dynamic descriptor loading, or search descriptor port.

The registry exposes adapters to shared runtime and tool callers only through a guarded resolver. It
resolves an exact registered platform, never infers executable support from the broader event-bus wire
enum, and wraps the adapter with descriptor-bound guards. Callers validate primary and nested input refs
before protocol access; the facade validates adapter-produced session, message, event, callback, output,
workflow, and partial-completion refs before publication, transcript linking, persistence, or recovery.
Expected operations return the closed Result algebra, including explicit unsupported, invalid-input,
platform/session mismatch, partial completion, not-found, permission, rate-limit, and unavailable
outcomes. Unrecognized exceptions and produced-ref mismatches remain supervised defects.

Registry iteration in `apps/core/src/runtime/surface-runtime-lifecycle.ts` drives connection, startup
rollback ownership, ingress shutdown, relay drain, snapshot collection, restore dispatch, and
reverse-order cleanup without protocol branches. Workflow progress is gated by exact target/binding/ref
correlation and persisted permanent-versus-retryable policy; actions remain protocol-rendered while
their durable authorization and state transitions remain shared and atomic.

`RegisteredSurfacePlatform` is derived from the closed `SessionRef` union and currently contains only
`discord` and `github`. It is intentionally narrower than the event-bus `AdapterPlatform` wire enum,
which also recognizes placeholder values such as `slack`, `telegram`, `whatsapp`, `web`, and `unknown`.
A wire-valid platform is not therefore an implemented or registered Core surface.

The trust chain begins at authenticated Discord gateway or verified GitHub webhook ingress, decodes the
complete external envelope into a closed protocol projection, publishes compatible metadata on trusted
Redis, and decodes it again into a normalized origin. Downstream control, tool, workflow, plugin, and
subagent contexts preserve one correlated `(platform, userId, sessionId)` identity; conflicting metadata
fails closed before trusted authority is assigned.

Graceful restart snapshot v4 preserves exact relay platform/request-client/session/ref correlation,
normalized recovery identity, current-turn user identity, PEL event identity, queue reservations,
control-application state, and partial lifecycle-publication progress. Recovery reads are non-destructive:
v1/v2/v3 remain readable and migrate in memory, unavailable or failed restore targets remain retained,
paused apply stays rollbackable, and the exact row is compare-and-deleted only before total synchronous
activation. Compatible wire and persistence readers remain broader than the installed registry and are not
narrowed by executable adapter selection.

The registry is internal runtime composition, not a dynamic plugin API. Discord health, request routing,
aliases, allowlists, local storage, search indexing/healing, and search sidecars remain Discord-owned.
GitHub webhook verification, authentication, trigger parsing, rendering, pagination, and acknowledgement
state remain GitHub-owned. Shared discovery is a query-facing application service rather than a descriptor
search port, and workflow reply waits remain Discord-only. Adding another platform requires a separate
future plan; the canonical pattern itself adds no speculative ref variant, enum/config/persisted platform
value, descriptor, or protocol module.

### Router

The router subscribes to `evt.adapter` and decides whether to create/append to an agent request for Discord events.

- Implementation: `apps/core/src/surface/discord/discord-request-router.ts`.
- Routing modes:
  - `mention`: only start a new request when the bot is mentioned or replied-to.
  - `active`: treat the session like a group chat and respond more aggressively.

Active-mode details:

- It can debounce multiple messages into a single initial prompt.
- It can optionally run a “gate” (small/fast model) to decide whether the bot should reply.

Router gate behavior (Discord):

- Gate enablement uses per-session override first, then global default:
  - `surface.router.sessionModes.<sessionId>.gate` (if set)
  - otherwise `surface.router.activeGate.enabled`
- DMs are ungated.
- Mention-mode channels:
  - non-triggers are ignored
  - mention/reply triggers bypass the active-batch gate
- Active-mode channels with **no running request**:
  - direct mention or direct reply-to-bot bypasses active-batch gating and starts a request immediately
  - non-trigger messages are debounced and may go through the active-batch gate
- Active-mode channels with a **running request** are not active-batch gated:
  - messages are routed as follow-up/steer/queued prompt according to in-flight rules

Mention-mode mixed reply behavior (active request):

- If a user replies to the currently active output message **without** mentioning the bot,
  router defers that reply and batches it as the next `prompt` request.
- The batched prompt is anchored to the latest reply in that deferred batch (thread reply target = batch end).
- If a reply+mention steer/interrupt arrives before the active request resolves,
  the deferred batch is converted into `followUp` messages on the active request instead of starting a separate prompt.

Direct-reply mention disambiguation gate (additional path):

- Runs for **non-DM** messages when all are true:
  - `replyToBot=true`
  - `mentionsBot=false`
  - message contains a non-self `@token`
- This gate is used to disambiguate “addressing another bot” vs “referencing another bot”.
- Context passed to this gate includes:
  - trigger text
  - replied-to message text
  - immediate previous message text
- Failure policy differs by gate mode:
  - direct-reply disambiguation: fail-open (forward on gate errors/timeouts)
  - active-batch gate: fail-closed (skip on gate errors/timeouts)

Router message directives (Discord):

- Leading directives are parsed after an optional leading bot mention such as `<@bot>` or `@Lilac`.
- `!m:<model>` or `!model:<model>`
  - one-shot model override for the current routed request
  - takes precedence over adapter/config session model overrides
  - stripped before the model sees user text
- `!continue=<n>` or `!cont=<n>`
  - active-mode only
  - reopens recent context and asks for `n` messages before the current one (non-inclusive)
  - sticky only while the directive message remains visible in reconstructed post-divider history
  - visible directives are applied cumulatively: if a loaded message also has `!cont`, it can expand history further
  - still bounded by dividers, history exhaustion, and the active history cap
  - stripped before the model sees user text
- `!interrupt`
  - only meaningful on a direct mention/reply to the currently active output chain
  - routes as queue mode `interrupt` instead of normal `steer`
  - stripped before the model sees user text
- `/divider`
  - Discord slash command, not a text prefix
  - inserts a session divider marker that cuts off active-history reconstruction

When the router forwards, it publishes `cmd.request.message` (topic: `cmd.request`) containing `ModelMessage[]`.

GitHub webhook ingress can also publish `cmd.request.message` directly (without passing through routing on `evt.adapter`).

### Request / Queue Modes

A “request” is the unit of agent work and output streaming.

`cmd.request.message` includes a queue mode:

- `prompt`: start a new request.
- `steer`: inject guidance into a currently running request (delivered at safe boundaries; also drains buffered follow-ups).
- `followUp`: append a user follow-up to a currently running request (buffered; delivered at safe boundaries).
- `interrupt`: abort + rewind and restart with the new message.

The agent runner enforces one active request per session at a time (per-session serialization).

### Agent Runner

Consumes `cmd.request` and runs the LLM.

- Implementation: `apps/core/src/surface/bridge/bus-agent-runner.ts`.
- Uses `AiSdkPiAgent` from `packages/agent`.
- Publishes:
  - `evt.request.lifecycle.changed` (queued/running/resolved/failed/cancelled)
  - `evt.request.reply` (a “start streaming output now” signal)
  - output stream events on `out.req.<request_id>`:
    - `evt.agent.output.delta.text`
    - `evt.agent.output.response.text`
    - `evt.agent.output.response.binary`
    - `evt.agent.output.toolcall`

Claude Code agent runs use the official Claude runtime and operator-provided authentication. Local
runs may use an installed CLI with existing authenticated config or `claude auth login`. Core's Docker
image can use the SDK-bundled executable with `CLAUDE_CODE_OAUTH_TOKEN`, a mounted authenticated
config, or both. Container deployments must give `CLAUDE_CONFIG_DIR` a writable persistent mount when
native continuation must survive replacement. Lilac does not own the authentication flow. Eligible
sessions continue through native Claude transcripts across turns and restarts: the first or any
incompatible attempt starts fresh persisted, while only an exact compatible continuation forks the
last clean session rather than advancing it in place.

Native continuation requires product-specific proof:

- Mini main: the binding owns the exact selected history-state ID, so undo, redo, and branching can
  select the matching retained native history.
- Mini named subagent: the binding owns that child's current exact history state/hash. The stable
  identity may be caller-supplied or generated and returned by `subagent_delegate`.
- Core named subagent: the delegation supplied a stable continuation identity and the marked
  request-client/session transcript has the exact canonical hash and message count.
- Core primary: only Discord is eligible. The binding names the terminal request whose retained
  transcript and lineage manifest recompute its exact clean head, and the current lineage must be an
  exact complete-segment extension of that ordered prefix digest.

Execution scope, cwd, Claude storage namespace, and native metadata must also match. Missing or
externally mutated native state, compaction, or any failed proof starts a fresh persisted Claude
session from Lilac's canonical history. Native session IDs remain internal operational data.

Core transcript schema 5 makes that primary terminal request identity explicit. Its migration
backfills a schema-4 binding only from exact retained durable proof, scanning retained transcript and
lineage rows when the matching succeeded attempt was already pruned; a binding with no exact proof is
removed. Binding lookup repeats terminal transcript/manifest verification and compare-and-delete
retires a stale binding without deleting a concurrently installed replacement. The next request then
uses the ordinary fresh path. `getCoreRetentionDiagnostics()` provides an internal aggregate snapshot
of named/primary bindings, active/terminal attempts, unverifiable bindings, orphan succeeded attempts
and manifests, unreferenced projections, and owned/unreferenced blob bytes.

Explicit model selection can cross the `claude-code` boundary only at a new-turn boundary. Historical
context is then lowered to lossy text: visible conversation text and bounded, labeled historical tool
facts remain, while hidden reasoning, provider metadata, binary history, and historical executable
tool protocol do not. Core automatic fallback is provider-family-local; a Core run whose head model
is `claude-code` has automatic fallback disabled. Mini does not implement that Core fallback chain.

### Reply Relay (Bus -> Surface)

When `evt.request.reply` arrives for a request, the relay subscribes to `out.req.<request_id>` and streams output to the adapter.

- Implementation: `apps/core/src/surface/bridge/subscribe-from-bus.ts`.

The relay also supports “re-anchoring” output mid-request (used by steer UX on Discord):

- `cmd.surface.output.reanchor` (topic: `cmd.surface`) tells the relay to freeze the current in-flight message chain and continue streaming in a new message.
- `evt.surface.output.message.created` (topic: `evt.surface`) is published by the relay when a surface message is created for a request.
  - Router uses this to detect “reply to the active streaming message”.

Important detail: `request_id` sometimes encodes “reply-to” behavior.

- If `request_id` is formatted as `discord:<session_id>:<message_id>`, the relay will reply to that Discord message.

### Workflow

Programmatic workflows are immutable JavaScript revisions executed by one durable engine. Workflow source cannot grant child-agent capabilities: workflows own deterministic orchestration and durability, while deployed subagent profiles and surrounding server policy own Level-1 tool/plugin exposure, Level-2 callable/plugin exposure, execution, delegation, request capabilities, and guardrails. `network` and `workspaceWrites` are behavioral/tool-surface settings, not trusted-Bash security boundaries. The workflow definition adds no second path, network, tool, prompt, or cwd policy of its own.

- Domain and SQLite authority: `apps/core/src/workflow/workflow-domain.ts` and `durable-workflow-store.ts`.
- Deterministic replay runtime: `workflow-engine.ts`, `workflow-sandbox.ts`, and `workflow-sandbox-child.js`.
- Durable reply/timer matching: `workflow-wait-resolver.ts`.
- Timestamp/cron run creation: `workflow-trigger-scheduler.ts`.
- Generated one-agent subagent runs and live-parent delivery: `workflow-subagent-dispatcher.ts` and `workflow-live-parent-bridge.ts`.
- Independent progress cards: `workflow-progress-projector.ts`.
- Level-2 definition, run, and trigger APIs: `tool-server/tools/programmatic-workflow.ts`.

Definitions live in `<selected-project-root>/.lilac/workflows/*.js` or `${DATA_DIR}/workflows/*.js`. The selected project root is the server-authorized request cwd bound to the active Level-2 capability; an internal shell `cd` does not change it. Every run is pinned to content-addressed source and input-schema snapshots plus a normalized resource-policy hash. Primary requests, ordinary workflow children, durable triggers, and generated subagents share the `workflows.maxActiveRuns` global cap. Durable triggers pin the immutable revision and origin snapshot when created, then fire without a human recheck. `agent()` selects a server-owned native profile plus optional `cwd`, `model`, `reasoning`, and `label`; a workflow launch uses the same profile assembly, tools, Bash behavior, and profile-bound request capability as a direct launch, and carries only durable request context rather than a second behavioral envelope. Cwd is free-form: any service-UID-accessible directory, absolute or relative to the invocation project, and not required to stay inside it. Shared operations may race; trusted Bash runs with service-user authority when execution is enabled. Discord-only `waitForReply` and platform-independent `sleep` are journaled host operations. Deferred and synchronous `subagent_delegate` calls use generated one-agent runs through the same journal. The deterministic program child is a plain Bun subprocess that keeps its determinism lockdown and NDJSON protocol; the host retains cancellation, operation-idle, output-size, and protocol limits, with no workflow wall-time limit. Deterministic request IDs, dispatch epochs, terminal receipts, ownership fencing, pinned resolved-model identity, cancellation, waits, and Redis correlation remain durable.

### Layered Tools (Progressive Disclosure)

There are three tool “levels”. They all serve the agent; higher levels are usually only used when the agent needs richer capabilities or a more stable interface.

1. Level 1: direct AI SDK tools (agent-local)
   - Loaded through the shared plugin runtime in `apps/core/src/plugins/manager.ts` and used inside `apps/core/src/surface/bridge/bus-agent-runner.ts` via AI SDK tool calling.
   - Shared Level 1 names, input schemas, local adapters, patch parsing, `AGENTS.md` discovery/rendering, and batch expansion/preflight live in `packages/coding-tools`. Core-specific SSH/restricted execution, artifacts, attachments, instruction result adaptation, logging, and bus delegation adapters live under `apps/core/src/tools/*`; built-ins are exposed through `apps/core/src/plugins/builtin/*`.
   - External plugins are discovered from `DATA_DIR/plugins/*`.
   - Key ones:
     - `bash` (`apps/core/src/tools/bash.ts`), guarded by `apps/core/src/tools/bash-safety/*` unless `dangerouslyAllow=true`.
       - Bash safety is an evidence-only accidental-damage guardrail. It blocks statically identified destructive operations and sensitive-path access, including direct static access to `DATA_DIR/secret`, but parsing failures, unsupported syntax, and runtime-dependent behavior fail open. Dynamic `rm -rf` targets are the deliberate exception and remain blocked because their deletion scope cannot be verified.
       - Child env always includes request context vars (`LILAC_REQUEST_ID`, `LILAC_SESSION_ID`, `LILAC_REQUEST_CLIENT`, `LILAC_CWD`) and VCS vars (`GIT_CONFIG_GLOBAL`, `GNUPGHOME`, with color forced off via `NO_COLOR=1`).
       - Trusted local bash also loads `$DATA_DIR/secret/tool-env.jsonc` before each process. This overlay is not used for restricted bash or SSH execution.
       - Bash path denial and output redaction are best-effort accidental-leak prevention, not a security boundary. Trusted local commands can evade static analysis and read, transform, or transmit their environment and same-user files; use restricted bash or OS-level isolation when commands must not access secrets.
       - When GitHub outbound auth is configured, bash also injects GitHub auth vars from `apps/core/src/github/github-auth.ts`:
         - Canonical: `GH_TOKEN`, `GITHUB_TOKEN` (prefer user token when configured, otherwise app token).
         - Optional host: `GH_HOST`.
         - Explicit alternates: `LILAC_GITHUB_USER_TOKEN`, `LILAC_GITHUB_USER_HOST`, `LILAC_GITHUB_APP_TOKEN`, `LILAC_GITHUB_APP_HOST`.
         - This allows command-level override to app auth when needed (for example: `GH_TOKEN="$LILAC_GITHUB_APP_TOKEN" gh ...`).
     - `read_file`, `glob`, `grep` (`apps/core/src/tools/fs/fs.ts`) (normal-operation denylists include `DATA_DIR/secret`, including MCP OAuth credentials, plus `~/.ssh`, `~/.aws`, and `~/.gnupg` unless `dangerouslyAllow=true`).
     - `apply_patch` (`apps/core/src/tools/apply-patch/index.ts`) (format docs: `apps/core/src/tools/apply-patch/README.md`; remote denylist can be bypassed with `dangerouslyAllow=true`).
     - `batch` (`apps/core/src/tools/batch.ts`) expands one call into ordinary synthetic Level 1 tool-call/result pairs.
     - `subagent_delegate` (`apps/core/src/tools/subagent.ts`) when `agent.subagents` is enabled and depth limits allow delegation. Its model argument is generated from agent-selectable `models.def` aliases, with optional per-call reasoning overrides and config-authored routing guidance.

2. Level 2: tool server tools + the `tools` CLI
   - Served by Elysia from `apps/core/src/tool-server/create-tool-server.ts`.
   - Exposes endpoints:
     - `GET /health` and `GET /healthz` liveness checks
     - `GET /readyz` readiness check
     - `GET /list` tool catalog
     - `GET /help/:callableId` tool help
     - `POST /call` invoke by `callableId`
     - `POST /reload` re-init tools and refresh callable mapping
   - Tool definitions live in `apps/core/src/tool-server/tools/*`.
   - Registration now goes through the same shared plugin runtime used by Level 1 (`apps/core/src/plugins/manager.ts`).
   - Built-in Level 2 plugins live in `apps/core/src/plugins/builtin/*`; external plugins are discovered from `DATA_DIR/plugins/*`.
   - The tool server uses request context headers (`x-lilac-request-id`, etc.) and generic server-issued request capabilities for request-scoped behavior. Capabilities bind cwd and native profile identity; profile headers are context only and cannot expand Level-2 access.
   - `apps/tool-bridge/client.ts` provides a human-friendly `tools` CLI that calls the tool server; the agent can also invoke it through Level-1 `bash`.
   - Capability-bound plugins skip cleanly in dev mode when required services are absent.
   - Configured MCP servers are Core-owned, process-wide clients managed through ordinary `mcp.list`, `mcp.add`, `mcp.remove`, `mcp.status`, `mcp.auth`, and `mcp.reload` callable IDs. Every accepted server is attempted at startup; unavailable servers wait for explicit reload rather than retrying on requests or in the background. Load the `mcp-management` skill for operational syntax and OAuth flow.
   - Health distinguishes fatal liveness failures from readiness degradation. Sustained event-loop
     lag is readiness-only: it is retained as a diagnostic incident and can make `/readyz` return
     503, but lag alone never invokes the process watchdog. Incident diagnostics contain process
     CPU/event-loop/resource/memory data, best-effort Linux pressure/cgroup data, and active-work
     metadata without tool arguments or command text. Runtime-specific metrics such as event-loop
     utilization explicitly report when they are unsupported.

3. Level 3: skills
   - Skills are on-disk bundles: a directory containing a required `SKILL.md` (YAML frontmatter + instructions) and optional helpers/resources.
   - Discovery + parsing lives in `packages/utils/skills.ts`.
   - The tool server exposes skills through `apps/core/src/tool-server/tools/skills.ts` (`skills.list`, `skills.brief`, `skills.full`).
   - Skills are meant to be loaded on-demand (metadata first, then full body) to avoid prompt bloat.

### The `tools` CLI

`apps/tool-bridge/client.ts` is a human-friendly CLI that talks to the tool server.

- It can pass correlation headers via env vars:
  - `LILAC_REQUEST_ID`, `LILAC_SESSION_ID`, `LILAC_REQUEST_CLIENT`, `LILAC_CWD`
- It can point at a non-default tool server via `TOOL_SERVER_BACKEND_URL`.
- The core tool server has no general public HTTP authentication layer. Keep it on a trusted host/network boundary; generic request capabilities constrain agent calls but are not a reason to expose the server publicly.
- It supports `--input=@file.json` and `--stdin` for whole-JSON payloads, plus `--field:value` flags.

---

## Runtime Configuration And State

### DATA_DIR

`DATA_DIR` (default: `<repo>/data`) is where runtime state lives.

Expected contents over time:

- `core-config.yaml` (seeded from `packages/utils/config-templates/core-config.example.yaml` if missing)
- `mcp-config.yaml` (independently versioned configured MCP servers)
- `prompts/` (seeded from `packages/utils/prompt-templates/*` if missing)
- `discord-surface.db` (Discord cache DB; default path)
- `discord-search.db` (Discord search index DB)
- `agent-transcripts.db` (agent transcript/turn cache used by routing/gating)
- `data.sqlite3` (default SQLite DB for workflow store; override via `SQLITE_URL`)
- `graceful-restart.db` (in-flight relay/agent recovery snapshots)
- `skills/` (skill bundles installed/seeded for discovery)
- `plugins/` (external Level 1 / Level 2 tool plugins)
- `secret/` (persisted secrets, e.g. GitHub App credentials, GPG home,
  `mcp-oauth/<server-id>.json`, and the mode-`0600` `event-dead-letter.key` required to recover encrypted
  Redis dead-letter records)
- `workspace/` (default working directory for bash/fs tools in the core runtime)

Native Claude continuation is separate from `DATA_DIR`. Claude stores its own conversation
transcripts under `CLAUDE_CONFIG_DIR`, or `~/.claude` when unset. An explicit value must be a
non-empty absolute path. It must be writable and, in a container, persistently mounted for restart
continuation. A dedicated directory is operator-controlled storage separation, not an access-control
or privacy boundary from the same service user. Fresh persisted attempts are used without an exact
binding; exact continuations create retained forks, so fork-heavy history may grow roughly
quadratically. Attempt records are bounded. Core primary/named owners and Mini named children keep one
current binding. Mini main historical bindings remain with retained history states
and may grow with that history. Lilac does not delete native transcript files.

Onboarding-related tools may also create additional persisted directories under `DATA_DIR` (for example `bin/`, `.bun/`, `.npm-global/`, `.config/`, `tmp/`).

### Prompts

The agent system prompt is built from local prompt files.

- Source templates: `packages/utils/prompt-templates/*`
- Runtime workspace: `DATA_DIR/prompts/*` (see `packages/utils/agent-prompts.ts`)

Prompt sync behavior is template-aware and stateful:

- Prompt sync state: `DATA_DIR/prompts/.prompt-template-state.json`
- If a prompt file still matches the last managed version, template updates are auto-applied in place.
- If a prompt file has local edits and the template changes, a sibling `*.new` file is written (for example `AGENTS.md.new`) and the local file is left untouched.

At run time, the core agent runner appends a compact `## Available Skills` index to the end of the primary agent's system prompt. The index is discovered using the same rules as the `tools skills.list` command.

This makes prompt iteration a file-edit operation rather than a code change.

### core-config.yaml

Loaded via `packages/utils/core-config.ts` and cached by mtime.

Key sections:

- `surface.router`: mention/active routing config.
- `surface.discord`: bot token env var name, allowlists, botName.
- `tools.web.extract.providers`: ordered web provider list shared by `web.search` and provider-backed `web.fetch`/extract (`tavily`, `exa`, `firecrawl`).
- `tools.web.fetch.mode`: default fetch strategy (`auto`, `fetch`, `browser`, `extract`, or `provider-only`).
- `agent.idleTimeoutMs`: primary agent inactivity timeout; active runs have no total runtime cap.
- `agent.subagents`: subagent enablement/depth/timeout/profile config.
  - Built-in defaults: `explore` (read/search, no workspace writes/Bash/delegation), `general` (full useful tools/plugins, workspace writes, Bash, and network, without delegation), and `self` (the same plus delegation).
  - Each profile may configure Level-1 tools/plugins, Level-2 callables/plugins, network behavior, workspace-write behavior/tool exposure, execution, and delegation. `network` and `workspaceWrites` do not sandbox ordinary trusted Bash when execution is enabled. `resolveNativeSubagentProfile` is authoritative for every launch path, direct or workflow-launched.
  - `delegatePromptOverlay` appends free-form routing policy to the parent-visible `subagent_delegate` description.
- `models.def`: reusable model aliases. `comment` documents an alias to the orchestrating agent, while `agentCanSelect: true` explicitly opts it into dynamic subagent selection without changing explicit static or human selection.
  - Model aliases, `models.main` / `models.fast`, and native subagent profiles may define an ordered `fallback` array. Core exhausts each candidate's transient retry budget before rebuilding the model-derived prompt and complete Level-1 toolset for the next eligible model. There is no global enable flag or switch cap.
  - Workflow heads remain pinned, while fallback is excluded from workflow identity hashes and is re-resolved from current config on stale redispatch.
  - Delegation policy: `explore`/`general` cannot delegate; `self` may delegate but cannot delegate to `self`.
- `plugins.disabled`: plugin ids to disable without uninstalling them.
- `plugins.config`: opaque per-plugin config passed through to plugin code.
- `models`: model slots (`main`, `fast`) with optional preset aliases and capability overrides (`models.capability`).
- `entity`: optional aliasing/mention rewriting for users/sessions.

### Environment variables

Most Core environment variables are parsed in `packages/utils/env.ts`. Important parsed values
include:

- `REDIS_URL` (required by core runtime)
- `SQLITE_URL` (workflow store sqlite path; default: `${DATA_DIR}/data.sqlite3`)
- `DATA_DIR` (where config/prompt/db live)
- `LL_TOOL_SERVER_PORT` (tool server port; default 8080)
- `LILAC_WORKSPACE_DIR` (the main agent's default working directory for general tools)

Workflow project scope is selected per invocation. Run the Level-2 workflow command from the intended
Level-1 `bash` cwd; the generic request capability carries that resolved cwd independently from the main
agent's default workspace.

- `GITHUB_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_PORT`, `GITHUB_WEBHOOK_PATH` (enable GitHub webhook ingress)
- Provider keys/base URLs (`OPENAI_*`, `OPENROUTER_*`, `ANTHROPIC_*`, `GEMINI_*`, `AI_GATEWAY_*`, etc.)
- `TAVILY_API_KEY`, `EXA_API_KEY`, and/or `FIRECRAWL_API_KEY` (enable configured web providers)
- `EXA_API_BASE_URL` (optional Exa API endpoint override)
- `FIRECRAWL_API_BASE_URL` (optional Firecrawl API endpoint override)
- `TAVILY_API_BASE_URL` (optional Tavily API endpoint override)
- `DISCORD_TOKEN` (or whatever `surface.discord.tokenEnv` points to)

The Claude runtime integration and official SDK consume these directly rather than through
`packages/utils/env.ts`:

- `CLAUDE_CODE_OAUTH_TOKEN` (optional Core/SDK Claude authentication, including Docker deployments)
- `CLAUDE_CONFIG_DIR` (Claude auth/config/native transcript root; defaults to `~/.claude`; when set,
  must be a non-empty absolute writable path and should be persistently mounted in containers)

---

## How The Core Runtime Is Wired

`apps/core/src/runtime/create-core-runtime.ts` is the best “single file” overview.

Startup order is intentional:

1. Start Discord search indexer
2. Start registered adapter-event ingress (so early Discord events don’t get lost)
3. Request-message cache, durable workflow action/wait resolvers, and registered surface adapters
4. Workflow progress projector, trigger scheduler, and live-parent completion bridge
5. Router and privileged Level-2 tool server
6. Registered surface output relays and independently hosted request ingress such as the optional GitHub webhook
7. Agent runner
8. Restore graceful-restart request/relay snapshots
9. Unified workflow engine, which reclaims active durable runs and replays their operation journals

Shutdown stops registered ingress before relay drain, combines relay recovery snapshots, then releases
surface resources in deterministic reverse registry order (best-effort).

Recovery startup preflights all required registered descriptors and live relay handles before applying any
relay or agent state. Relay attempts apply behind paused gates, roll back in reverse order on failure, and
activate only after the exact persisted row disposition succeeds. A rollback failure that leaves atomicity
unknown is a registered `Panic`.

---

## Boundary Architecture

- Trust boundaries decode complete external envelopes into typed local values. Open SDK and protocol values instead pass through registered projections that produce closed local unions with explicit bounded fallbacks; internal services do not carry domain-bearing `unknown`.
- Expected failures use domain-owned `Result` error unions, including typed terminal errors for fallible streams. `Panic` is reserved for registered hard invariants and defects, is classified with `Panic.is`, and is never converted to an ordinary Err.
- Exception capture, host signaling, rollback sentinels, compatibility mappings, and defect supervision are allowed only at exact registered adapters. Add exception registrations to the owning workspace in `scripts/architecture/manifest.ts`; the global approval catalog is derived from them, and its reviewed digest must be updated. Other manifest entries use exact symbol identities or exact modules according to their schema, with reasons only where required. Broad allowlists are not an approval mechanism.
- Persisted codecs report successful provenance as `current`, `migrated`, or contractually valid `missing-defaulted`, while unsupported versions, malformed serialization, and corrupt fields remain distinct errors. Reads do not rewrite data. SQLite Result transactions use the registered private-sentinel adapter, preserve exact Panic and driver classification, and commit state transitions with their outbox records atomically.
- Surface boundaries follow the closed-ref/registered-platform pattern: protocol adapters validate caller refs and classify provider failures into operation Results, registry facades guard every produced ref, workflow ports gate durable correlation and failure policy, and v4 recovery validates identity plus relay/queue state before paused admission. Protocol sidecars and search stay outside the descriptor.
- Redis/SuperJSON receive paths begin with `Message<unknown>` and decode the complete event through the canonical codec registry before typed delivery. Handlers return Results; subscription policy owns commit, `park-pending`, dead-letter, or stop. Parked work entries are durable pending entries, not automatic retries.
- Presentation code consumes closed render-ready projections, never raw tool or SDK payloads or runtime parsers. Lifecycle states are exhaustive, and unknown future variants normalize at the projection adapter.
- `bun run lint:architecture` runs the semantic checker and production syntax gate; every finding is an error, with no baseline or migration-status path. Focused checks are `bun run test:architecture`, `bun run test:lint-rules`, and `bun run typecheck:architecture`. Root `bun run lint`, `bun run test:all`, `bun run typecheck`, `bun run fmt:check`, and `bun run ci` compose the repository gates.

---

## Common “Where Do I Change X?” Pointers

- Add/modify bus event types: add one `LILAC_EVENTS` entry in `packages/event-bus/lilac-spec.ts`, add its wire compatibility fixture, then publish and subscribe with an explicit delivery policy.
- Change request routing behavior: `apps/core/src/surface/discord/discord-request-router.ts` and config schema in `packages/utils/core-config.ts`.
- Change agent execution behavior (steer/follow-up/interrupt semantics): `packages/agent/ai-sdk-pi-agent.ts`.
- Change which local tools the LLM can call: `apps/core/src/surface/bridge/bus-agent-runner.ts`.
- Add a new HTTP tool: implement `ServerTool` in `apps/core/src/tool-server/tools/*` and expose it from a built-in plugin in `apps/core/src/plugins/builtin/*`.
- Add a new external plugin or change the shared plugin contract: `packages/plugin-runtime/*` and `PLUGIN_AUTHORING.md`.
- Change how tool invocations are served/logged: `apps/core/src/tool-server/create-tool-server.ts`.
- Change Discord ingestion/persistence/output rendering: `apps/core/src/surface/discord/discord-adapter.ts` and `apps/core/src/surface/discord/output/*`.
- Modify workflow behavior or add a host operation: `apps/core/src/workflow/*`.
- Modify scheduled workflows: `apps/core/src/workflow/workflow-trigger-scheduler.ts` and `apps/core/src/workflow/cron.ts`.
- Modify skill discovery rules: `packages/utils/skills.ts`.

---

## Running / Building / Testing (Quick)

- Run core runtime (expects Redis + Discord token + allowlists):
  - `bun apps/core/src/runtime/main.ts`
  - This command is for humans, DO NOT run it if you are an agent. Otherwise it will hang your bash tool.

- Run tool server only (dev mode; fewer tools enabled because no bus/adapter):
  - `bun apps/tool-bridge/index.ts`
  - This command is for humans, DO NOT run it if you are an agent. Otherwise it will hang your bash tool.

- Build `tools` CLI:
  - `cd apps/tool-bridge && bun run build`

- Build `lilac-acp` CLI:
  - `cd apps/acp-controller && bun run build`

- Run tests:
  - All root and workspace tests: `bun run test:all`
  - Per workspace: `cd apps/core && bun run test` (and similarly for other workspaces)

- Docker (includes Redis):
  - `docker compose up --build -d`
  - `bun run docker:verify`
  - Credential-free image smoke: `bun run docker:build --tag lilac:dev . && bun run docker:verify-image`
  - This command is for humans, DO NOT run it if you are an agent. Otherwise it will hang your bash tool.

---

## Gotchas / Design Intent

- Discord allowlist is strict: if both `allowedChannelIds` and `allowedGuildIds` are empty, the bot ignores all Discord traffic.
- Request IDs are meaningful:
  - `discord:<channelId>:<messageId>` implies “reply to this message”.
  - `github:<owner/repo#number>:<triggerId>[:<suffix>]` identifies GitHub-triggered runs.
  - `wfr:<run-hash>:<operation-hash>:<attempt>` identifies a workflow agent operation.
  - `sub:<parent_request_id>:<uuid>` identifies delegated subagent runs.
  - `req:<uuid>` is used for router-gated “start a request without a direct mention/reply”.
- The tool server is not the AI SDK tool runner; it’s a separate HTTP API that can be used by humans and by the agent (typically via the `tools` CLI).
- The deterministic workflow program child is a plain Bun subprocess (`bun --smol workflow-sandbox-child.js`); the child keeps its determinism lockdown and NDJSON protocol, and the host enforces cancellation, operation-idle, output-size, and protocol limits. Workflows have no wall-time or runtime memory-limit contract. Workflow execution no longer requires Linux user namespaces, Bubblewrap, cgroup v2, or a user systemd manager.
- Prompts/config are designed to be editable without code changes (seeded into `DATA_DIR`).
