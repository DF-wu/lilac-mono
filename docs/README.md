# Lilac Documentation

This index covers operational and design documentation beyond the root README. [`../README.md`](../README.md) is the repository's primary, canonical entry point. Read it first, then use the sections below to find detailed documentation.

Language: [`English (primary / canonical)`](../README.md) · [`Traditional Chinese (translation)`](../README.zh-TW.md) · [`Traditional Chinese documentation index`](./README.zh-TW.md)

## Fork and Architecture

| Document | Contents |
| --- | --- |
| [`fork-differences.md`](./fork-differences.md) | Current differences from upstream, limitations, sync policy, and upstreamed contributions |
| [`../PROJECT.md`](../PROJECT.md) | Complete Core and Mini Lilac architecture, terminology, data flow, and configuration model |
| [`../MIGRATIONS.md`](../MIGRATIONS.md) | Core configuration and storage-format migration contract |

## Deployment and Surfaces

| Document | Contents |
| --- | --- |
| [`docker-deployment.md`](./docker-deployment.md) | Docker/Compose, operator tokens, persistence, UID, security boundaries, and diagnostics |
| [`telegram-surface.md`](./telegram-surface.md) | BotFather, allowlists, groups, forum topics, workflows, verification, and limitations |
| [`github-reply-permalinks.md`](./github-reply-permalinks.md) | GitHub issue/PR body and comment reply permalink contract |

## Generation and Extensions

| Document | Contents |
| --- | --- |
| [`generate-image-openai-compatible.md`](./generate-image-openai-compatible.md) | Route `generate.image` to an OpenAI-compatible endpoint |
| [`../PLUGIN_AUTHORING.md`](../PLUGIN_AUTHORING.md) | Level 1/Level 2 external plugin contract, lifecycle, and permissions |
| [`../examples/plugins/custom-media/README.md`](../examples/plugins/custom-media/README.md) | Deployable OpenAI-compatible image/video plugin example |

## Applications

| Document | Contents |
| --- | --- |
| [`../apps/mini-lilac/README.md`](../apps/mini-lilac/README.md) | Mini Lilac installation and first run |
| [`../apps/mini-lilac-server/README.md`](../apps/mini-lilac-server/README.md) | Mini server configuration, providers/auth, API, and history recovery |
| [`../apps/mini-lilac-tui/README.md`](../apps/mini-lilac-tui/README.md) | Mini TUI options, keyboard model, and rendering |
| [`../apps/acp-controller/README.md`](../apps/acp-controller/README.md) | `lilac-acp` build, session search, and detached prompts |

## Contributors

| Document | Contents |
| --- | --- |
| [`../AGENTS.md`](../AGENTS.md) | Repository commands, test rules, and TypeScript conventions |
| [`../packages/remote-fs-runner/README.md`](../packages/remote-fs-runner/README.md) | Remote filesystem helper used by Core SSH tools |

> [!NOTE]
> `plan/` contains design and execution records. `ref/` contains read-only reference repositories. Neither is an entry point for general operational documentation.
