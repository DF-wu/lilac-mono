# Lilac Monorepo

<p align="center">
  <strong>Bun monorepo for a Redis-backed AI agent runtime with Discord ingress, optional GitHub ingress, layered tools, and durable workflow resume.</strong>
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

- Receives work from **Discord** and optional **GitHub issue/PR webhook** flows.
- Routes requests through a **typed Redis Streams event bus**.
- Runs agent turns with **local tools**, **HTTP tool-server callables**, and **on-disk skills**.
- Sends results back to Discord and GitHub surfaces.
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
bun run test:all
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
- GitHub webhook ingress requires `GITHUB_WEBHOOK_SECRET`.
- GitHub auth can be configured through user or app credentials, depending on the workflow.

## Further Reading

- [`PROJECT.md`](./PROJECT.md): architecture, terminology, and runtime flow
- [`AGENTS.md`](./AGENTS.md): repo-specific coding and validation rules
- [`apps/acp-controller/README.md`](./apps/acp-controller/README.md): ACP controller usage details
- [`docs/generate-image-openai-compatible.md`](./docs/generate-image-openai-compatible.md): routing `generate.image` through an OpenAI-compatible provider

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

This repository is licensed under MIT. See [`LICENSE`](./LICENSE) for details.

The `ref/` directory contains vendored or reference material that keeps its own upstream license terms.
