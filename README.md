# Lilac Monorepo

Lilac is an event-driven agent runtime: a typed Redis Streams event bus + surface adapters (Discord, with optional GitHub webhook integration) + an agent runner (AI SDK) + an HTTP tool server and `tools` CLI.

- Architecture/terminology: `PROJECT.md`
- Repo conventions for coding agents: `AGENTS.md`

## Layout

- `apps/core/`: core runtime (Discord + optional GitHub surfaces, bus wiring, router, agent runner, workflow, tool server)
- `apps/tool-bridge/`: dev-mode tool server entry + `tools` CLI bundle (builds to `dist/`)
- `apps/acp-controller/`: ACP harness controller CLI (`lilac-acp`) with JSON and human output modes, builds to `dist/`
- `packages/event-bus/`: typed event spec + Redis Streams transport
- `packages/agent/`: AI SDK streaming agent wrapper
- `packages/utils/`: env/config parsing, model providers, prompt + skills utilities
- `data/`: local runtime state (config, prompts, sqlite dbs, default workspace)
- `ref/`: vendored upstream references (treat as read-only unless a task says otherwise)

## Install

This monorepo uses Bun workspaces. Install dependencies in the workspace(s) you work on:

- `cd apps/core && bun install`
- `cd apps/tool-bridge && bun install`
- `cd apps/acp-controller && bun install`
- `cd packages/event-bus && bun install`
- `cd packages/utils && bun install`
- `cd packages/agent && bun install`

## Build / Test / Typecheck

- Build the `tools` CLI: `cd apps/tool-bridge && bun run build`
- Build the `lilac-acp` CLI: `cd apps/acp-controller && bun run build`
- Run the complete local check with independent gates overlapped: `bun run check`
- Run the conservative CI sequence locally: `bun run ci`
- Run the Core product and its shared package tests: `bun run test:core`
- Run the Mini product and its shared package tests: `bun run test:mini`
- Run all root, workspace, lint-rule, and architecture tests: `bun run test:all`
- Run workspace tests: `cd apps/core && bun run test`
- Typecheck `lilac-acp`: `cd apps/acp-controller && bun run typecheck`
- Typecheck (per workspace): `cd <workspace> && bunx tsc -p tsconfig.json --noEmit`
- Lint workspaces: `bun run lint`
- Lint and auto-fix where possible: `bun run lint:fix`
- Format check (code + JSON): `bun run fmt:check`
- Format write (code + JSON): `bun run fmt`

## Running

Most commands below are long-running.

- Docker/Compose (includes Redis): `docker compose up --build -d`
- Verify a running deployment with the operator CLI: `bun run docker:verify`
- Credential-free image smoke: `bun run docker:build --tag lilac:dev . && bun run docker:verify-image`
- Docker deployment contract and diagnostics: `docs/docker-deployment.md`
- Core runtime (needs `REDIS_URL` + Discord config): `bun apps/core/src/runtime/main.ts`
  - Important: with default `core-config.yaml`, both Discord allowlists are empty, so the bot ignores all Discord traffic until you set at least one of `surface.discord.allowedChannelIds` or `surface.discord.allowedGuildIds`.
- Tool server only (dev mode): `bun apps/tool-bridge/index.ts`
- `tools` CLI (after building): `./apps/tool-bridge/dist/index.js --list`
  - Target a different server with `TOOL_SERVER_BACKEND_URL=http://host:port`

### Claude Subscription Provider

Core can use Claude Code subscription authentication without an Anthropic API key. For a local run,
install the official Claude tooling and use an existing authenticated config or run
`claude auth login`, then select the credentialless provider in `core-config.yaml`:

```yaml
models:
  main:
    model: claude-code/claude-sonnet-4-6
```

Lilac does not read, store, or refresh the Claude credential. The provider delegates authentication
to the official Claude runtime. Claude filesystem settings are disabled; run-scoped Lilac tools are
exposed through an in-process MCP server. `batch` is intentionally omitted because Claude can issue
independent MCP calls in parallel. This provider is distinct from the API-key-backed `anthropic`
provider.

Core's Docker image can use the Claude Agent SDK's bundled executable when no `claude` executable is
on `PATH`. Operators may pass `CLAUDE_CODE_OAUTH_TOKEN`, mount an existing authenticated Claude
config, or use both. Set `CLAUDE_CONFIG_DIR` to a non-empty absolute path that is writable by the
`lilac` service user and backed by persistent storage; the stock Compose file does not configure
Claude authentication or this mount automatically. See `docs/docker-deployment.md`.

Eligible Claude agent sessions use Claude's native persisted transcripts for continuation across
turns and process restarts. The first eligible call, or one with missing, invalid, compacted,
scope-mismatched, or otherwise incompatible state, starts a fresh persisted session. Only an exact
compatible continuation forks the last clean session; Lilac never advances that clean base in place.
Native continuation is enabled only with exact proof:

- Mini main sessions bind the exact selected history state, including states selected by undo/redo.
- Mini named subagents persist under either a caller-supplied or returned generated `sessionName`.
- Core named subagents require their stable continuation identity and an exact canonical
  transcript hash/count.
- Core primary continuation is limited to Discord. Its binding identifies the terminal request whose
  retained transcript and lineage manifest prove the clean head, and the composed request must be an
  exact complete-segment extension of that prefix.

Missing, externally changed, incompatible, compacted, or otherwise unprovable native state starts a
fresh persisted Claude session from Lilac's canonical history. Native Claude session IDs are
operational details and are not exposed in normal user-facing output.

Explicit model selection may cross between `claude-code` and another provider family at a new-turn
boundary. The historical prefix is then replayed as lossy text: visible user/assistant text is kept,
historical tool activity is labeled and bounded, and hidden reasoning, provider metadata, binary
history, and executable historical tool protocol are dropped. In Core, automatic fallback never
crosses a provider-family boundary, and automatic fallback is disabled entirely when the run starts
on `claude-code`. Mini does not expose this Core model-fallback chain.

Native transcripts are stored under `CLAUDE_CONFIG_DIR`, falling back to `~/.claude`, outside Lilac's
SQLite/transcript stores. If explicitly set, it must be a non-empty absolute path. The directory must
be writable, and must be mounted/persisted when continuation should survive container replacement.
A dedicated directory separates operator-selected storage and retention, but is not an access-control
or privacy boundary from Core, trusted tools, plugins, or other processes running as the same OS user.
Native transcripts contain conversation data subject to Claude's own retention policy. Repeated exact
continuations create retained forks and can make native storage grow roughly quadratically with
conversation length. Attempt records are bounded. Core primary/named owners and Mini named children
keep one current binding; Mini main bindings remain attached to retained history states
and may grow with that history. Lilac does not delete Claude's native transcript files. Core
revalidates primary terminal-request proof when a binding is read and retires stale bindings instead
of resuming them. Its internal aggregate retention diagnostics report binding/attempt counts, orphan
lineage metadata, unreferenced projections, total owned-blob bytes, and unreferenced owned-blob
counts/bytes; they do not expose native Claude transcript contents.

For direct Core `openai` or `codex` models, set `options.openai_server_compaction: true` to opt a
model into OpenAI server compaction. This is model metadata and is never forwarded as an AI SDK
provider option.

Mini Lilac supports the same provider, declared in `providers.yaml`:

```yaml
providers:
  claude-code:
    type: claude-code
    catalog: models-dev
```

It takes no `auth.json` entry (supplying one is a configuration error), no `baseUrl`, and requires
`catalog: models-dev`. Models are resolved from Anthropic's models.dev metadata and filtered to the
Claude families the CLI can launch. Two behaviors differ from other Mini Lilac providers:

- Profiles that request `websearch` get Claude's built-in `WebSearch` instead of the API-key-backed
  provider tool. Claude executes it, so it does not pass through Lilac approval, artifact capture, or
  output normalization. It is the only profile-requested Claude built-in and is enabled only for
  profiles that already ask for web search. Both Mini and Core also enable Claude's `ToolSearch` over
  the deferred Lilac MCP tool catalog; Core enables no profile-requested built-ins.
- Steering is injected into the live Claude query rather than waiting for a turn boundary. Messages
  the query cannot take — attachments, or a steer sent before the query opened — stay queued and
  behave as they do on any other provider.

The published single-file `mini-lilac` command resolves an external `claude` executable from `PATH`;
unlike the Core image, it cannot resolve the SDK optional executable from a bundled dependency tree.
Local Mini runs may use `claude auth login` or existing authenticated config. A custom Mini container
must install/mount that external CLI and provide authentication and persistent writable Claude config
storage explicitly.

## License

This repository is licensed under MIT. See `LICENSE` for details.

The `ref/` directory is vendored upstream/reference code and keeps each upstream project's own license terms.
