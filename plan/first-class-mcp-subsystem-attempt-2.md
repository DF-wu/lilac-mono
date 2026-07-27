# First-Class MCP Subsystem: Attempt 2

## Status

This is the agreed implementation plan for the second MCP attempt. It replaces
the architecture on `expr/mcp-attempt-1`; that branch remains useful as a source
of config, OAuth, transport, and test cases, but its runtime and lifecycle should
not be merged wholesale.

### Implementation Progress

- [x] Map active architecture and identify narrowly reusable attempt-1 code.
- [x] Add strict versioned MCP config parsing and value-source resolution.
- [x] Add the process-wide MCP registry, complete pagination, and explicit reload.
- [x] Add source-neutral catalog naming, search, and durable session selection.
- [x] Freeze tool declaration and execution authority per model step.
- [x] Enable Claude Code native `ToolSearch` over the complete deferred catalog.
- [x] Add generic `tools mcp.*` management and persistent loopback OAuth.
- [x] Add secret-path guards, management skill, templates, and documentation.
- [x] Remove stale attempt-1 workspace directories.
- [x] Pass focused tests, package typechecks, lint, format, and full test suite.

The design keeps the first attempt's broad product goal while changing the
implementation around six decisions:

1. MCP management is exposed through ordinary Level 2 callable IDs such as
   `mcp.add`, invoked as `tools mcp.add`. There is no separate MCP CLI and no
   custom parser in the `tools` client.
2. Core owns one process-wide client for each configured MCP server. Sessions
   and requests share those clients; there are no request leases or idle TTLs.
3. MCP protocol and tool conversion use AI SDK abstractions wherever possible.
4. Core owns a persistent loopback OAuth callback so a human can copy a failed
   browser callback URL and an agent can `curl` it inside the container.
5. Credentials are ordinary files under `DATA_DIR/secret`. There is no secret
   removal, isolation, or MCP-specific redaction subsystem.
6. All non-builtin tools, from MCP servers and external plugins, live in one
   complete deferred-tool catalog. The catalog has no Lilac count or byte cap.

## Attempt 1 Problems

The first attempt implemented the opposite MCP client lifecycle:

- Clients are keyed by Lilac session as well as server identity.
- Agent runs acquire and release client leases.
- The last lease starts a two-minute idle eviction timer.
- Client retirement, late acquisition, server incarnation, and activation
  reconciliation are coupled together.
- MCP is explicitly unavailable through the `claude-code` provider.

It also created avoidable product and implementation surfaces:

- A standalone `lilac-mcp-auth` executable and Docker entry.
- MCP-only `load_mcp` behavior while external plugin tools remain eager.
- A bounded names-only prompt catalog and multiple independent catalog,
  activation, and schema byte limits.
- Manual MCP protocol wrapping and tool-result conversion already provided by
  `@ai-sdk/mcp`.
- MCP-specific session activation rows coupled to the transcript store.
- A generated standalone auth bundle of roughly 91,000 lines.

Attempt 2 should be implemented fresh and should port only code that still has
a clear responsibility in the new design.

## Mental Model

The subsystem has four independent concepts:

| Concept | Lifetime | Owner |
| --- | --- | --- |
| Configured MCP server | Core process | MCP registry |
| MCP client and manifest | Core process, until reload/removal/shutdown | MCP registry |
| Tool catalog | Current accepted plugin and MCP snapshots | Core tool assembly |
| Selected deferred tools | Lilac session | Source-neutral activation store |

MCP client ownership is never derived from a request, session, profile, or
currently selected tool. Tool exposure policy can filter what a run may search
or activate, but it does not create another protocol client.

"All MCPs are loaded" means that Core attempts to connect every accepted
configured server and discover its complete manifest at startup or explicit
reload. It does not mean that every MCP tool schema is placed directly in every
model prompt.

## Configuration

Keep a separate versioned `DATA_DIR/mcp-config.yaml`, based on the first
attempt's configuration plan. It remains independent from `core-config.yaml`.

The accepted server transports are:

- Streamable HTTP, with static headers or OAuth.
- Stdio, with command, arguments, cwd, and environment value sources.

Inline, environment, and file value sources remain supported. Parsing is strict
and uses Zod at the YAML and external-data boundaries.

Every accepted configured server is process-loaded. Do not use session or
profile allowlists to decide whether a client exists. If run-profile exposure
policy is retained, apply it only while building that run's searchable catalog.

Config writes from `mcp.add` and `mcp.remove` must be atomic. A successful
management mutation performs one registry reconciliation immediately.

## Process-Wide MCP Registry

Core creates one `McpRegistry` during startup. It has a deliberately small
public surface:

```ts
interface McpRegistry {
  init(): Promise<void>;
  reload(serverId?: string): Promise<readonly McpReloadOutcome[]>;
  list(): readonly McpServerStatus[];
  getTools(): readonly McpCatalogTool[];
  shutdown(): Promise<void>;
}
```

The exact types can change during implementation, but the ownership model must
not grow request/session acquire and release methods.

### Startup

At Core startup:

1. Parse the accepted MCP config.
2. Create one client per configured server.
3. Connect each server and fetch its complete paginated tool manifest.
4. Convert the manifest to ordinary AI SDK tools.
5. Publish one immutable registry snapshot for catalog assembly.

Servers may initialize in parallel. Each server has one fixed internal init
deadline covering connect and complete manifest discovery, so a silent stdio
child or stalled HTTP endpoint cannot block Core startup indefinitely. Core
startup continues when a server fails or times out. The failed server is
represented as unavailable and is not automatically retried. A later explicit
`mcp.reload` is the only retry trigger.

### Reload

`mcp.reload` reparses config and reconciles registry state:

- New server: create, connect, and discover it.
- Changed server: construct the replacement first, then swap and close the old
  client after successful initialization.
- Removed server: remove its catalog tools and close its client.
- Unchanged healthy server: retain its existing client.
- Unavailable server: retry it.
- Failed replacement: retain the previous healthy client and report the new
  candidate failure.

`tools mcp.reload` retries every unavailable server. `tools mcp.reload <id>` may
be supported through the ordinary primary positional metadata for the callable.
The callable returns one outcome per targeted server, including success,
unavailable/auth-required status, and safe failure text; it must not reduce a
multi-server reconciliation to `void`.

There is no config watcher retry loop, request-boundary refresh, background
reconnect policy, idle eviction, or short-lived client TTL.

If a live client or stdio child closes, or a transport failure makes the client
unusable, atomically mark that server unavailable and remove its tools from new
catalog snapshots. The failing call returns its transport error. Later calls
fail with the recorded unavailable status until explicit `mcp.reload`; Core does
not create a replacement client from request traffic. Do not add a Lilac retry
loop, and configure dependency retries off where the selected transport exposes
that option.

### Shutdown

Core closes all MCP clients during normal reverse-order shutdown. No client is
owned by the transcript store, agent runner, or individual run cleanup.

## AI SDK MCP Integration

Add `@ai-sdk/mcp` and use its abstractions as the default implementation:

- `createMCPClient` for client initialization.
- AI SDK HTTP and stdio transport support where it satisfies the config.
- `listTools` for manifest discovery.
- `toolsFromDefinitions` for AI SDK tool conversion.
- AI SDK MCP result conversion for model-facing output.
- AI SDK OAuth helpers and `OAuthClientProvider` for authorization and refresh.

Lilac-specific code is limited to:

- Config parsing and value-source resolution.
- Process-wide registry lifecycle and reload reconciliation.
- Complete pagination over `listTools` cursors before tool conversion.
- Provider-safe naming and collision handling.
- Persistent OAuth provider state.
- Status and management integration.
- Logging with credential and callback-query omission.

Do not initially add custom support for MCP notifications, resumable streams, or
durable protocol sessions. Tool changes become visible after `mcp.reload`.
Extract a reusable package only when a second Lilac runtime actually needs the
same implementation; attempt 2 starts as Core-owned code under
`apps/core/src/mcp/`.

## Unified Deferred Tool Catalog

Replace the MCP-specific `load_mcp` design with a source-neutral tool catalog.

### Catalog Membership

The catalog contains every non-builtin Level 1 tool that is structurally
available to the run:

- Every tool from every available configured MCP server.
- Every Level 1 tool contributed by an external plugin.

Built-in Lilac tools stay directly active and do not need discovery. The
portable `tool_search` tool is also directly active for ordinary AI SDK model
providers.

The authoritative catalog has no Lilac maximum tool count, byte limit, prompt
catalog limit, selected-row cap, or active-schema budget. If an operator adds a
server with 5,000 tools, all 5,000 entries belong to the catalog.

Search may accept an optional result count and providers may impose their own
protocol/model limits, but Lilac must not prune or truncate authoritative
catalog membership.

### Names And Identity

Model-facing names use underscores rather than colons:

```text
plugin_<plugin-id>_<tool-name>
mcp_<server-id>_<tool-name>
```

Builtin Level 1 names remain unchanged and unprefixed. Prefixing external plugin
tools is an accepted greenfield breaking change: update repository-owned
prompts, skills, docs, and tests that name them, and do not add compatibility
aliases. Existing cross-plugin duplicate detection is replaced by the qualified
model names plus final normalized-name collision detection.

Normalize unsupported characters to `_`. Apply deterministic truncation and a
hash suffix when required by the strictest supported provider length or when
normalization creates a collision.

Do not recover identity by parsing the model-facing name. Keep a structured
internal mapping from model name to source, source ID, and raw tool name.
Persist the stable normalized name or another explicitly versioned structured
ID; do not place literal NUL separators in source files or database keys.

Each catalog entry also retains its original discovery metadata: source ID,
raw tool name, title when present, and the complete original tool description.
Search must use this metadata rather than relying on the normalized model-facing
name, which may have lost useful tokens through sanitization or truncation.

### Portable `tool_search`

For ordinary AI SDK model providers, expose a built-in `tool_search` tool that:

1. Searches the complete source-neutral catalog over model name, title, and
   description. For MCP tools this explicitly includes server ID, raw MCP tool
   name, MCP title, and MCP description; external plugins receive the analogous
   plugin ID, raw name, title, and description treatment.
2. Returns the matching stable tool names and concise source metadata.
3. Marks the returned matches selected for the current Lilac session.
4. Makes newly selected tools available on the next model step.

There is no MCP-specific search syntax or `load_mcp` name. External plugin and
MCP tools use exactly the same search and activation path.

### Session Selection

Keep the first attempt's durable per-Lilac-session selection behavior, but make
it source-neutral. Attempt 2 starts from `main`, where the attempt-1
`session_loaded_mcp_tools` table does not exist, so add a generic selected tool
store directly, for example `session_loaded_tools`; there is no database rename
or migration.

The store contains only session identity, stable catalog tool identity, and
selection time. It does not contain clients, leases, manifests, connection
fingerprints, or server lifecycle state.

If a selected tool disappears after reload, omit it from active tools without
deleting unrelated selections. If it returns under the same stable identity,
it becomes available again.

### Step Authority

Retain the useful part of the first attempt's agent changes: freeze an immutable
tool mapping for each model step and execute calls from that exact mapping.
Selection during step N affects step N+1 and cannot authorize a call emitted by
step N.

Port only the minimal active-tool and per-step snapshot behavior. Do not include
the first attempt's unrelated duplicate-tool-call changes in the MCP work.

## Claude Code Adapter

Claude Code has its own deferred tool search architecture, so it should not use
Lilac's portable `tool_search` activation loop.

### Built-In Configuration

Do not replace the agent model's `tools` setting with a hardcoded array.
`packages/claude-code-bridge/claude-code-run.ts` already passes its validated
`builtInTools` argument to the agent model, while `tools: []` in provider
defaults and on the utility model deliberately keeps those contexts tool-free.

```ts
env: {
  ENABLE_TOOL_SEARCH: "true",
},
```

`ai-sdk-provider-claude-code` constructs a sanitized subprocess environment and
merges this `env` object over it. Do not spread `process.env`, which would bypass
that allowlist and expose unrelated host variables to the Claude subprocess.

Add `ToolSearch` to `CLAUDE_CODE_BUILT_IN_TOOLS`, append it to the built-ins Core
passes for catalog-backed Claude Code runs, and allow it through the bridge's
`canUseTool` policy. Do not replace other explicitly selected built-ins such as
`WebSearch`. Keep all other Claude Code built-ins disabled unless they are
separately enabled by existing product policy.

Set `env: { ENABLE_TOOL_SEARCH: "true" }` only at
`packages/claude-code-bridge/claude-code-run.ts`, the provider construction used
by materialized Core and Mini Lilac agent runs. Leave the tool-free shared
provider in `packages/utils/model-provider.ts` and the tool-free Mini Lilac
utility provider in `packages/mini-lilac-runtime/src/providers.ts` unchanged;
they carry no MCP bridge or searchable tools. The materialized utility model
also remains `tools: []`; only the materialized agent receives its caller's
validated built-in selection and catalog bridge.

### Catalog Exposure

Expose the complete catalog through the existing in-process Lilac MCP bridge:

- Built-in Lilac tools remain immediately available. Mark their MCP
  declarations with Anthropic's always-load metadata where needed.
- External plugin and configured MCP tools are emitted without `alwaysLoad`, so
  Claude Code defers them behind native `ToolSearch`.
- Pass a small catalog-metadata map alongside the AI SDK `ToolSet`, keyed by
  model-facing name. For each deferred declaration, emit
  `_meta["anthropic/searchHint"]` from its source ID, raw tool name, title, and
  full original description. This preserves recall after provider-safe name
  normalization without creating another catalog or changing execution lookup.
- Do not expose Lilac's portable `tool_search` through the bridge; native
  `ToolSearch` is the sole search primitive on this provider path.
- Do not cap the declarations supplied to the bridge.

Configured remote MCP clients still belong to Core's process-wide registry.
The per-Claude-run Lilac MCP bridge is only an adapter over already-created AI
SDK tools; it must not create another remote client per session.

Remove the first attempt's `provider !== "claude-code"` MCP exclusion.

## MCP Management Through `tools`

MCP management is a set of normal Level 2 callable IDs:

```text
mcp.list
mcp.add
mcp.remove
mcp.status
mcp.auth
mcp.reload
```

They are invoked through the existing generic CLI parser:

```bash
tools mcp.list
tools mcp.add <server-id> --transport=http --url=https://example.com/mcp
tools mcp.remove <server-id>
tools mcp.status [server-id]
tools mcp.auth <server-id>
tools mcp.reload [server-id]
```

Structured stdio definitions, headers, environment sources, and OAuth options
can use the existing `--input`, `--stdin`, and `--field:json` support. Define
ordinary `primaryPositional` metadata for server IDs. Do not add `tools mcp ...`
subcommand parsing to `apps/tool-bridge/client.ts`.

`mcp.add` atomically adds or replaces one server definition and performs one
registry reconciliation. `mcp.remove` removes config and closes the client but
never removes its credential file. `mcp.reload` is the explicit retry and
manifest-refresh operation.

No standalone `apps/mcp-auth`, `lilac-mcp-auth` binary, or separate Docker
installation is added.

## OAuth Flow

Core owns one loopback callback listener for its process lifetime, using a fixed
callback such as:

```text
http://localhost:1456/mcp/oauth/callback
```

### Start

`tools mcp.auth <server-id>`:

1. Resolves an HTTP server configured for authorization-code OAuth.
2. Uses AI SDK OAuth discovery, registration/client configuration, and PKCE.
3. Stores pending verifier and state in Core memory, keyed by random OAuth
   state.
4. Returns the authorization URL and callback URL as ordinary command output.
5. Does not open a browser and does not wait for the callback request.

Create one long-lived OAuth provider/state holder per configured OAuth server.
The same instance must be reachable from auth start, runtime token refresh, and
the callback handler. Implement its verifier/state methods according to the AI
SDK OAuth contract and pass callback state back through the SDK helper so the
library performs its state comparison. `redirectToAuthorization` captures the
generated URL into the pending attempt instead of opening a browser.

Pending authorization attempts do not need durable recovery. A Core restart
invalidates them and the user runs `mcp.auth` again.

### Complete

The intended human/agent flow is:

1. User tells the agent to add an MCP URL.
2. Agent runs `tools mcp.add ...` and `tools mcp.auth <id>`.
3. Agent sends the returned authorization URL to the user.
4. User opens it. The browser may fail to reach container-local `localhost`.
5. User copies the complete final callback URL from the address bar and pastes
   it to the agent.
6. Agent runs `curl '<complete-callback-url>'` inside the container.
7. Core validates path and state, exchanges the code, and persists credentials.
8. Agent runs `tools mcp.reload <id>` to connect the previously unavailable
   server.

Only a complete callback URL with matching state is accepted. Do not accept a
bare authorization code. Returning or pasting this URL through the agent leaks
OAuth callback material into the transcript; this is accepted behavior when the
user chooses the agent-assisted flow.

The same callback also works directly when the user's browser can reach the
Core loopback listener.

## Credential Storage And Tool Guards

Persist MCP OAuth credentials at:

```text
DATA_DIR/secret/mcp-oauth/<server-id>.json
```

Use private directory/file modes and atomic writes. Reuse the existing singular
`DATA_DIR/secret` convention; do not introduce `DATA_DIR/secrets`.

There is deliberately no:

- Logout or credential-removal callable.
- Automatic credential deletion when a server is removed.
- Per-session credential identity.
- Secret broker or isolated credential process.
- MCP-specific output redaction system.

Apply the existing best-effort prohibited-directory behavior for
`DATA_DIR/secret` to every agent tool. File/edit/search denial already exists in
`apps/core/src/tools/fs/fs.ts`; preserve it and add focused coverage rather than
reimplementing it. Bash is separate new work: integrate a best-effort protected
path check into Core's actual Bash safety and virtual-filesystem execution path
instead of assuming the unused `packages/coding-tools` helper protects Core.
This remains an accidental-access guard, not a security boundary; trusted
same-user code can evade static Bash analysis.

## Progressive Disclosure

`packages/utils/prompt-templates/TOOLS.md` gets one MCP entry only:

```md
- `mcp.*` - Manage configured MCP servers. Load the `mcp-management` skill before adding, removing, authenticating, or reloading one.
```

Do not enumerate all management commands or MCP tools in `TOOLS.md`.

Add `packages/utils/skill-templates/mcp-management/SKILL.md` and seed it through
the existing onboarding defaults flow. The skill documents:

- `mcp.*` command syntax and JSON input examples.
- HTTP and stdio configuration.
- Status and explicit reload behavior.
- The browser/copy/paste/`curl` OAuth flow.
- Credential retention after `mcp.remove`.
- The accepted callback-secret leakage in agent-assisted auth.
- The fact that unavailable servers are not retried until `mcp.reload`.

Keep the existing `mcporter` skill only for ad-hoc/direct MCP calls, independent
configs, and code generation. Update both skill descriptions to state that
`mcp-management` manages Core's configured always-on servers and credentials,
while `mcporter` does not modify or authenticate Core's MCP registry.

## Observability And Failure Policy

Status is per configured server and should distinguish at least:

- `available`: connected with a complete manifest.
- `unavailable`: the latest startup/reload attempt failed.
- `authentication_required`: authorization-code credentials are absent or
  rejected.

Diagnostics may include server ID, transport type, phase, and safe error text.
They must omit resolved headers, tokens, client secrets, PKCE verifier, full
authorization URLs, and callback query strings. The one exception is the
intentional `mcp.auth` return value: return the authorization URL once to that
caller, but never write it to logs, status, health diagnostics, or later list
responses.

Failure rules:

| Event | Behavior |
| --- | --- |
| Server fails during Core startup | Mark unavailable; continue startup; do not retry automatically |
| Server fails during explicit reload | Retain old healthy client when replacing; otherwise mark unavailable |
| Live client or stdio child dies | Mark unavailable, remove tools from new catalogs, fail calls until explicit reload |
| Server removed | Close client and remove tools; retain credential file |
| OAuth credential missing | Mark authentication required; user runs `mcp.auth` |
| OAuth callback has wrong/missing state | Return HTTP 400; write nothing |
| Core restarts during OAuth | Pending attempt is lost; user starts again |
| Manifest changes upstream | Remain unchanged until explicit `mcp.reload` |
| Tool selected but absent after reload | Omit it until the same stable identity returns |

## Primary Code Changes

Expected implementation areas:

- `apps/core/src/mcp/*`: config source, process registry, OAuth provider and
  callback, naming, and status.
- `apps/core/src/plugins/builtin/*`: Level 2 `mcp.*` callables and portable
  Level 1 `tool_search`.
- `apps/core/src/plugins/manager.ts` and plugin-runtime types: classify builtin
  versus external tools and build the source-neutral catalog.
- `apps/core/src/runtime/create-core-runtime.ts`: registry and callback startup,
  wiring, and shutdown.
- `apps/core/src/surface/bridge/bus-agent-runner.ts`: catalog assembly,
  session-selected tools, and provider-specific disclosure.
- `packages/agent/ai-sdk-pi-agent.ts`: minimal immutable per-step active-tool
  snapshots.
- `packages/claude-code-bridge/*`: `ToolSearch` allowlisting, explicit adapter
  environment, and per-tool deferred/always-load/search-hint MCP metadata.
- `apps/core/src/transcript/transcript-store.ts`: generic session selected-tool
  persistence.
- `packages/utils/prompt-templates/TOOLS.md`: one `mcp.*` disclosure entry.
- `packages/utils/skill-templates/mcp-management/SKILL.md`: full management
  instructions.
- `apps/core/src/tool-server/tools/onboarding.ts`: seed the management skill.
- `packages/utils/config-templates/mcp-config.example.yaml`: example config.
- `PROJECT.md` and deployment docs: final behavior. Update `MIGRATIONS.md` only
  for a real persisted/config migration, not for the unshipped attempt-1 table.

No new standalone workspace or MCP runtime package is required for attempt 2.
The ignored attempt-1 directories `apps/mcp-auth/` and
`packages/mcp-runtime/` currently remain physically present in this worktree and
match the Bun workspace globs. After porting any useful config, naming, OAuth,
credential-file, fixture, or test code, delete both stale directories so lint,
format, typecheck, and workspace discovery cannot pick them up.

## Implementation Sequence

1. Add the versioned MCP config parser and atomic mutation operations.
2. Add `@ai-sdk/mcp` and implement the process-wide registry with complete
   manifest pagination, shared clients, explicit reload, and shutdown.
3. Add the persistent OAuth provider and Core loopback callback.
4. Add Level 2 `mcp.*` callables and tests using the existing generic `tools`
   invocation shape.
5. Extend plugin assembly with a source-neutral unlimited catalog and safe
   underscore-prefixed names.
6. Generalize session-selected tool persistence and add portable `tool_search`.
7. Port the minimal immutable per-step active-tool snapshot into the agent.
8. Enable Claude Code `ToolSearch`, force `ENABLE_TOOL_SEARCH=true`, expose the
   full catalog through the bridge, emit deferred-tool search hints, and mark
   only builtin Lilac tools always loaded.
9. Preserve the existing filesystem `DATA_DIR/secret` deny behavior and add
   focused coverage proving MCP credential paths are included.
10. Implement the separate best-effort `DATA_DIR/secret` guard in Core's Bash
    safety/virtual-filesystem path and test direct static accesses.
11. Add the single `TOOLS.md` entry, management skill, mcporter boundary,
    example config, and operational documentation.
12. After all useful code has been ported, delete the stale ignored
    `apps/mcp-auth/` and `packages/mcp-runtime/` directories.
13. Run package tests, package typechecks, root tests, lint, and formatting.

## Test Plan

### Registry

- Two Lilac sessions receive tool wrappers backed by the same server client.
- Concurrent runs do not create additional clients or stdio children.
- Every configured server is attempted at startup.
- A server that does not complete initialization before the fixed deadline is
  marked unavailable without blocking Core startup.
- Startup failure does not stop Core and does not retry on later requests.
- Explicit reload retries an unavailable server.
- Changed config swaps clients and closes the replaced client.
- Failed replacement retains the old healthy client.
- Removed config closes the client but preserves credentials.
- Shutdown closes every client exactly once.
- Paginated manifests include every returned tool, including thousands of
  entries.
- A connected client or stdio child dying changes status to unavailable and
  does not create a replacement until explicit reload.

### Catalog And Activation

- Builtin tools are active and absent from the deferred catalog.
- External plugin and MCP tools share one catalog and search path.
- Names use `plugin_...` and `mcp_...` forms with deterministic collision and
  truncation handling.
- Portable search finds MCP and plugin tools from terms present only in their
  original descriptions, titles, raw names, or source IDs.
- A catalog with 5,000 tools is not truncated or pruned by Lilac.
- The Claude bridge serializes, transports, parses, and exposes an actual
  5,000-tool `tools/list` payload successfully; the test must exercise the
  payload rather than assert only an in-memory catalog count.
- `tool_search` activates matches on the next step, never the producing step.
- Selected external plugin and MCP tools persist across requests in one Lilac
  session.
- Hidden tools cannot execute through an earlier step snapshot.
- Removed selected tools disappear safely and can return under stable identity.

### Claude Code

- The materialized agent receives the validated built-in selection with
  `ToolSearch` appended; existing selected built-ins are not replaced.
- Provider defaults and the utility model remain `tools: []`.
- The provider created by `materializeClaudeCodeRun` sets only
  `env: { ENABLE_TOOL_SEARCH: "true" }` and does not spread `process.env`;
  tool-free shared and utility provider constructors remain unchanged.
- `ToolSearch` passes the builtin allowlist and permission callback.
- No other Claude Code builtin is enabled accidentally.
- Builtin Lilac tools carry always-load metadata.
- Every external plugin and MCP catalog tool is present and deferred.
- Deferred declarations carry `anthropic/searchHint` containing original source
  identity, raw name, title, and description, including terms absent from
  normalized/truncated model-facing names.
- The portable Lilac `tool_search` is not duplicated through the bridge.
- MCP tools are no longer excluded for the `claude-code` provider.

### Management And OAuth

- `tools mcp.add`, `tools mcp.remove`, `tools mcp.status`, `tools mcp.auth`, and
  `tools mcp.reload` work through generic callable parsing.
- No custom second-level parser is added to the CLI.
- Config mutation is atomic and triggers one reconciliation.
- Auth start returns a URL without blocking or opening a browser.
- Auth start and callback use the same long-lived per-server OAuth provider.
- A copied callback URL completed through `curl` writes credentials.
- Wrong state, missing state, error callback, and bare code write nothing.
- Credential output and status never include tokens or callback query strings.
- Auth completion followed by explicit reload connects the server.
- Server removal does not remove the credential file.

### Secret Guards And Docs

- Read/search/glob/edit tools deny `DATA_DIR/secret` under normal operation.
- Bash analysis rejects direct static access to `DATA_DIR/secret`.
- Tests and docs state that the guard is not isolation and can be bypassed by
  trusted same-user execution.
- `TOOLS.md` has exactly one `mcp.*` entry.
- The seeded management skill contains the complete human and agent OAuth flow.

## Acceptance Criteria

1. Core owns at most one live MCP client per configured server.
2. No MCP client key includes request or Lilac session identity.
3. There are no client leases, idle TTLs, or request-end MCP cleanup paths.
4. Every configured server is attempted at startup; failures wait for explicit
   `mcp.reload` rather than request traffic or background retry.
5. MCP tools use AI SDK client and tool-conversion abstractions unless a tested
   Lilac-specific adapter is required.
6. `tools mcp.*` management uses ordinary callable IDs and the existing generic
   CLI parser.
7. OAuth works through start URL, user browser, pasted complete callback URL,
   and agent/container `curl`.
8. MCP credential files live under `DATA_DIR/secret` and are never removed by
   MCP management.
9. Every external plugin and MCP tool is represented in one complete,
   untruncated catalog.
10. Model-facing deferred names use underscore-prefixed `plugin_...` and
     `mcp_...` forms with deterministic collision handling. Builtin names stay
     flat; external plugin renaming is an accepted break with no aliases.
11. Ordinary AI SDK providers use source-neutral `tool_search`; Claude Code
    uses native `ToolSearch` over the same catalog. Both search paths index
    original MCP/plugin names, source IDs, titles, and descriptions.
12. Claude Code appends `ToolSearch` to the caller's validated agent built-ins and
    explicitly sets `ENABLE_TOOL_SEARCH=true` without forwarding arbitrary host
    environment variables; tool-free provider defaults and utility models stay
    tool-free.
13. Session-selected tool persistence contains no MCP client lifecycle state.
14. `TOOLS.md` contains one `mcp.*` disclosure entry and delegates operational
    detail to the `mcp-management` skill.
15. No standalone MCP auth application or large generic MCP runtime package is
    introduced, and the stale ignored attempt-1 workspace directories are
    deleted before validation.
