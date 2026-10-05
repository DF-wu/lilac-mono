# Lilac Documentation

This index covers operational and design documentation beyond the root README. [`../README.md`](../README.md) is the repository's primary, canonical entry point. Read it first, then use the sections below to find detailed documentation.

Language: [`English (primary / canonical)`](../README.md) · [`Traditional Chinese (translation)`](../README.zh-TW.md) · [`Traditional Chinese documentation index`](./README.zh-TW.md)

## Fork and Architecture

| Document | Contents |
| --- | --- |
| [`fork-differences.md`](./fork-differences.md) | Current differences from upstream, limitations, sync policy, and upstreamed contributions |
| [`../PROJECT.md`](../PROJECT.md) | Durable Core architecture, terminology, workspace ownership, trust boundaries, and persistence guide |
| [`../MIGRATIONS.md`](../MIGRATIONS.md) | Core configuration and storage-format migration contract |
| [`core-config-migrations.md`](./core-config-migrations.md) | Manual `core-config.yaml` upgrades between config versions, including the fork's v2 keys |
| [`architecture-blob-publication-design.md`](./architecture-blob-publication-design.md) | Design record for recoverable workflow artifact publication: ownership and concurrency decisions |

## Deployment and Surfaces

| Document | Contents |
| --- | --- |
| [`docker-deployment.md`](./docker-deployment.md) | Docker/Compose, operator tokens, persistence, UID, security boundaries, and diagnostics |
| [`native-surface.md`](./native-surface.md) | Native Web surface: authentication, configuration, operation, and the temporary operator console |
| [`telegram-surface.md`](./telegram-surface.md) | BotFather, allowlists, groups, forum topics, workflows, conversation memory, verification, and limitations |
| [`telegram-feature-parity.md`](./telegram-feature-parity.md) | Telegram versus Discord capability matrix: what the router rewrite aligned, every remaining gap with its reason and the change needed, and Telegram-only strengths |
| [`github-reply-permalinks.md`](./github-reply-permalinks.md) | GitHub issue/PR body and comment reply permalink contract |

## Generation and Extensions

| Document | Contents |
| --- | --- |
| [`generate-image-openai-compatible.md`](./generate-image-openai-compatible.md) | Structured `generate.image` internals and per-alias provider routing, including an OpenAI-compatible endpoint |
| [`web-search-openai.md`](./web-search-openai.md) | `web.search` through the OpenAI Responses `web_search` tool: what the mediator model receives, what the conversation model gets back, configuration, and limitations |
| [`../PLUGIN_AUTHORING.md`](../PLUGIN_AUTHORING.md) | Level 1/Level 2 external plugin contract, lifecycle, and permissions |
| [`../examples/plugins/custom-media/README.md`](../examples/plugins/custom-media/README.md) | Deployable OpenAI-compatible image/video plugin example |
| [`skill-authoring.md`](./skill-authoring.md) | Skill format, discovery, and authoring guidance |
| [`claude-code.md`](./claude-code.md) | Claude Code provider: authentication, tools, continuation, and storage |

## Applications

| Document | Contents |
| --- | --- |
| [`installation.md`](./installation.md) | Guided installer: system requirements, setup, provider authentication, reconfiguration, and release overrides |
| [`computer-use.md`](./computer-use.md) | Optional computer-use desktop gateway and runner: build, Core configuration, agent use, and verification |

## Contributors

| Document | Contents |
| --- | --- |
| [`../AGENTS.md`](../AGENTS.md) | Repository commands, test rules, and TypeScript conventions |
| [`../packages/remote-fs-runner/README.md`](../packages/remote-fs-runner/README.md) | Remote filesystem helper used by Core SSH tools |

> [!NOTE]
> `plan/` contains design and execution records. `ref/` contains read-only reference repositories. Neither is an entry point for general operational documentation.
