# Lilac Monorepo

<p align="center">
  <strong>Bun monorepo for a Redis-backed AI agent runtime with Discord ingress, optional Telegram and GitHub ingress, layered tools, and durable workflow resume.</strong>
</p>

<p align="center">
  <a href="./PROJECT.md">Architecture</a>
  ·
  <a href="./AGENTS.md">Agent Guide</a>
  ·
  <a href="./apps/acp-controller/README.md">ACP CLI</a>
  ·
  <a href="#quick-differences-from-upstream">Differences</a>
  ·
  <a href="https://github.com/stanley2058/lilac-mono">Upstream</a>
</p>

Lilac is an event-driven runtime for request-scoped LLM work. It keeps surface ingress, routing, agent execution, tool access, and workflow resume in one system instead of splitting them across separate bots, scripts, and operator glue.

This repository is a maintained fork of [`stanley2058/lilac-mono`](https://github.com/stanley2058/lilac-mono). The fork context matters: most architecture and runtime concepts still follow upstream, while this fork adds a small set of operator-focused changes for GitHub automation, container delivery, and ACP reliability.

## Quick Differences From Upstream

If you already know upstream Lilac, start here. This fork keeps the same Bun workspace layout and event-driven runtime model, but currently differs in these practical areas:

| Area | This fork adds or changes | Why it matters |
| --- | --- | --- |
| GitHub issue/PR comments | `/lilac` and `@bot` triggers are parsed from the first non-empty, non-quoted, non-code-fenced content line. Agent-authored comments are marked with `<!-- lilac:agent-comment -->` and ignored by webhook ingress. | Users can invoke the agent from GitHub comments more predictably, while avoiding self-trigger loops. |
| GitHub surface output | GitHub comments created by the adapter, output stream, or `surface.messages.send` are automatically marked as agent comments. | Outbound GitHub replies remain machine-identifiable across both runtime output and tool-driven messages. |
| ACP controller robustness | Detached ACP runs treat Linux zombie worker processes as dead, and cancellation closes the harness client so workers can settle instead of hanging indefinitely. | Long-running local/automation prompt workflows recover more cleanly from stuck harness transports. |
| Container delivery | GitHub Actions build and publish GHCR images for `catalina` and `claudia` variants, with `latest` pointing at the `catalina` image. The Docker image also includes `rsync` and the upstream `smart-search` CLI runtime. | Operators can consume prebuilt images and have a more complete shell toolbox plus an official `smart-search` runtime inside the container. |
| Upstream maintenance | A scheduled GitHub Actions workflow checks `stanley2058/lilac-mono` every 6 hours and merges upstream `main` when possible, then triggers image rebuilds. | This fork is intended to stay close to upstream while keeping local operational patches visible. |

The fork-specific code is intentionally small and easy to audit. Useful entry points are `apps/core/src/github/github-comment-marker.ts`, `apps/core/src/github/webhook/github-webhook-server.ts`, `apps/core/src/surface/github/`, `apps/acp-controller/controller.ts`, and `.github/workflows/`.

## What This Repo Does

- Receives work from **Discord**, optional **Telegram**, and optional **GitHub issue/PR webhook** flows.
- Routes requests through a **typed Redis Streams event bus**.
- Runs agent turns with **local tools**, **HTTP tool-server callables**, and **on-disk skills**.
- Sends results back to Discord, Telegram, and GitHub surfaces.
- Supports **pause/resume**, scheduled wakeups, and long-lived workflows.
- Ships operator-facing tooling through the **`tools` bridge** and **`lilac-acp` controller**.

## Core Capabilities

### 1. Runtime-first architecture

The center of gravity is `apps/core/`. That runtime wires together Redis, the event bus, Discord ingress, GitHub webhook ingress, routing, agent execution, tool serving, workflow services, transcript/search stores, and heartbeat-driven background prompting.

### 2. Typed event model

`packages/event-bus/` defines the canonical event contract and Redis Streams transport used across ingress, routing, execution, and output delivery.

### 3. Layered tools and skills

The runtime exposes three capability layers:

- **Local tools** such as shell, file reads, search, and patching.
- **Tool-server namespaces** for web, workflow, surface, attachments, onboarding, generation, summarize, SSH, and related runtime operations.
- **On-disk skills** that can be discovered and loaded into runs when needed.

### 4. Durable workflows

The repo includes workflow services for wait-for-reply, send-and-wait, scheduling, cancellation, and resume. This is built into the runtime rather than bolted on as a separate job system.

### 5. Operator tooling

Two supporting apps matter operationally:

- `apps/tool-bridge/`: builds the `tools` bridge and standalone tool-server entrypoints.
- `apps/acp-controller/`: builds `lilac-acp`, a CLI for ACP harness discovery, session inspection, and detached prompt execution.

## How It Works

The runtime flow is:

1. Discord adapter events enter through the surface bridge.
2. The router turns Discord events into request messages.
3. GitHub webhook handlers can publish request messages directly.
4. The agent runner executes with models, tools, and skills.
5. Output is delivered back to Discord or GitHub through the surface layer.
6. Workflow services can resume work later when time or user input arrives.

For the full system mental model, terminology, and file-level architecture, see [`PROJECT.md`](./PROJECT.md).

## Repository Map

| Path | Purpose |
| --- | --- |
| `apps/core/` | Main runtime process and supporting subsystems. |
| `apps/tool-bridge/` | `tools` bridge CLI and standalone tool-server entrypoints. |
| `apps/acp-controller/` | `lilac-acp` CLI for ACP harness operations. |
| `packages/event-bus/` | Typed event spec and Redis Streams bus implementation. |
| `packages/agent/` | AI SDK-based agent execution, streaming, and turn control. |
| `packages/utils/` | Runtime config, model/provider resolution, prompts, and skill discovery. |
| `packages/plugin-runtime/` | Shared plugin contract and runtime support. |
| `data/` | Local runtime data and seeded config. |
| `ref/` | Vendored/reference repos; treat as read-only. |

## Verified Commands

### Workspace validation

```bash
bun install
bun test
bun run lint
bun run typecheck
bun run fmt:check
```

### Build commands

```bash
cd apps/tool-bridge && bun run build
cd apps/acp-controller && bun run build
```

Remote runner build used by the core package:

```bash
cd apps/core && bun run build:remote-runner
```

### ACP controller workflow

```bash
cd apps/acp-controller
bun run build
./dist/index.js --help
./dist/index.js harnesses list
./dist/index.js sessions list --directory /path/to/repo --search "failing tests"
```

### Containerized operator stack

```bash
docker compose up --build
```

This container path is real, but it is an operator workflow rather than a zero-config quick start. The runtime expects Redis plus runtime configuration such as surface credentials.

### `smart-search` runtime in the image

The runtime container installs the official `@konbakuyomu/smart-search` npm package during image build. That package creates and manages its own isolated Python runtime as part of its upstream install flow, so the image does not need a custom wrapper layer for basic CLI availability.

The image already includes the upstream prerequisites that `smart-search` expects, including `nodejs`, `npm`, `python3`, `python3-pip`, and `python3-venv`.

Because the container sets `XDG_CONFIG_HOME=${DATA_DIR}/.config`, the default `smart-search` config path resolves inside the runtime data directory, typically:

```bash
/data/.config/smart-search/config.json
```

Useful checks inside the container:

```bash
smart-search --version
smart-search doctor --format json
smart-search setup
```

If you persist `/data`, the `smart-search` config and provider credentials persist with it.

## Operational Prerequisites

- The runtime expects **Redis** and reads seeded runtime config from `data/core-config.yaml`.
- Discord uses `DISCORD_TOKEN` by default unless `surface.discord.tokenEnv` is changed in `core-config.yaml`.
- Telegram is off by default. Set `surface.telegram.enabled: true` (requires `configVersion: 2`) and `TELEGRAM_BOT_TOKEN`; see `docs/telegram-surface.md`.
- GitHub webhook ingress requires `GITHUB_WEBHOOK_SECRET`.
- GitHub auth can be configured through user or app credentials, depending on the workflow.

## Further Reading

- [`PROJECT.md`](./PROJECT.md): architecture, terminology, and runtime flow
- [`AGENTS.md`](./AGENTS.md): repo-specific coding and validation rules
- [`apps/acp-controller/README.md`](./apps/acp-controller/README.md): ACP controller usage details

### Runtime and deployment smoke commands

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

This repository is licensed under MIT. See [`LICENSE`](./LICENSE) for details.

The `ref/` directory contains vendored or reference material that keeps its own upstream license terms.
