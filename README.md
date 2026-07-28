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
- Run all root and workspace tests: `bun run test:all`
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

### Local Claude Subscription

Core can use an authenticated local Claude Code installation without an Anthropic API key. Install
the official Claude tooling, run `claude auth login`, and select the credentialless provider in
`core-config.yaml`:

```yaml
models:
  main:
    model: claude-code/claude-sonnet-4-6
```

Lilac does not read, store, or refresh the Claude credential. The provider delegates authentication
to the official local tooling. Claude filesystem settings, built-in tools, and Claude transcript
persistence are disabled; run-scoped Lilac tools are exposed through an in-process MCP server.
`batch` is intentionally omitted because Claude can issue independent MCP calls in parallel. This
provider is distinct from the API-key-backed `anthropic` provider.

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
  output normalization. It is the only Claude built-in that is enabled, and only for profiles that
  already ask for web search. Core enables none.
- Steering is injected into the live Claude query rather than waiting for a turn boundary. Messages
  the query cannot take — attachments, or a steer sent before the query opened — stay queued and
  behave as they do on any other provider.

Because it needs the local Claude CLI and its credential, this provider is for local runs; it does
not work inside the Docker image.

## License

This repository is licensed under MIT. See `LICENSE` for details.

The `ref/` directory is vendored upstream/reference code and keeps each upstream project's own license terms.
