# Lilac Monorepo

<p align="center">
  <strong>A maintained fork of Lilac focused on reliable operator workflows, container delivery, ACP robustness, and provider compatibility.</strong>
</p>

<p align="center">
  <a href="#repository-status">Status</a>
  ·
  <a href="#current-differences-from-upstream">Fork Differences</a>
  ·
  <a href="#development-status">Development</a>
  ·
  <a href="#pull-request-status">Pull Requests</a>
  ·
  <a href="#documentation-map">Documentation</a>
  ·
  <a href="https://github.com/stanley2058/lilac-mono">Upstream</a>
</p>

Lilac is an event-driven runtime for request-scoped LLM work. It combines surface ingress, Redis-backed routing, agent execution, layered tools, skills, durable workflows, and operator-facing CLIs in one Bun monorepo.

This repository is a fork of [`stanley2058/lilac-mono`](https://github.com/stanley2058/lilac-mono). Upstream remains the source of the core architecture. This fork stays close to it while carrying a deliberately small set of operational changes and testing new integrations before they are proposed or promoted to `main`.

## Repository Status

> Status snapshot: **2026-07-15 (Asia/Taipei)**. Branch, PR, and upstream-sync information is time-sensitive; use the linked GitHub pages for live state.

| Item | Status at this snapshot |
| --- | --- |
| Fork integration branch | [`main`](https://github.com/DF-wu/lilac-mono/tree/main) at [`bb74d0f`](https://github.com/DF-wu/lilac-mono/commit/bb74d0f), last updated by an upstream merge on 2026-07-14 |
| Upstream branch | [`stanley2058/lilac-mono@main`](https://github.com/stanley2058/lilac-mono/tree/main) at [`0ad03bc`](https://github.com/stanley2058/lilac-mono/commit/0ad03bc) |
| Sync distance | Fork `main` is one upstream commit behind: `fix: retry closed SSE connections` |
| Open pull requests | **0** in [`DF-wu/lilac-mono`](https://github.com/DF-wu/lilac-mono/pulls) |
| Current development branch | [`feat/openai-compatible-image-routing`](https://github.com/DF-wu/lilac-mono/tree/feat/openai-compatible-image-routing); implementation and documentation are present, but no GitHub PR has been opened |
| Delivery | `main` pushes build GHCR images for `catalina` and `claudia`; scheduled upstream sync runs every six hours |

The scheduled sync workflow merges upstream directly into fork `main` when upstream is ahead. If a merge conflicts, the workflow cannot resolve it automatically and manual maintenance is required.

## Current Differences From Upstream

This table describes meaningful differences that remain after comparing the current fork `main` with upstream `main`. It intentionally excludes old fork changes that have since converged with upstream.

| Area | Fork-specific behavior | Operational impact | Evidence |
| --- | --- | --- | --- |
| Upstream maintenance | A scheduled workflow checks upstream every six hours, merges `upstream/main` directly, pushes fork `main`, and dispatches the image build. | The fork normally tracks upstream without a manual sync PR, while merge conflicts still require intervention. | [`.github/workflows/sync-upstream.yml`](./.github/workflows/sync-upstream.yml) |
| Container publishing | GitHub Actions publish `catalina` and `claudia` GHCR variants, per-variant SHA tags, and `latest` for `catalina`. | Operators can consume prebuilt images tied to the fork's `main` branch. | [`.github/workflows/build-image.yml`](./.github/workflows/build-image.yml) |
| Container runtime compatibility | The image adds `rsync` and a `/home/Catalinna` compatibility symlink when the container user is `Catalina`. | Existing Catalina deployments and file-transfer workflows remain compatible. | [`Dockerfile`](./Dockerfile) |
| ACP detached-run reliability | Linux zombie worker PIDs are treated as dead; cancellation closes the ACP client so a misbehaving transport cannot keep a worker alive indefinitely. | `lilac-acp` status, wait, restart, and cancel flows recover more reliably. | [`apps/acp-controller/controller.ts`](./apps/acp-controller/controller.ts) |
| Nonstandard provider finish reasons | Parsed tool calls are executed even when an OpenAI-compatible provider reports a nonstandard finish reason such as `other`. | Valid tool calls do not become orphaned and trigger missing-tool-result failures on the next model request. | [`packages/agent/ai-sdk-pi-agent.ts`](./packages/agent/ai-sdk-pi-agent.ts) |
| Fork maintenance records | The repository keeps fork-specific reports and operational documentation alongside the source. | Maintainers can audit why a change was made and how it was reviewed. | [`plan/pr-23-subagent-blocking-reason-report.md`](./plan/pr-23-subagent-blocking-reason-report.md) |

### Changes that are no longer fork-only

Several items previously advertised as fork differences now exist upstream or have equivalent upstream behavior:

- GitHub issue/PR comment self-loop protection and agent-comment markers.
- Discord preview/plain stats behavior.
- The `smart-search` runtime and its upstream prerequisites in the container image.
- General third-party image-provider configuration added through the earlier image-provider work.

They remain part of this repository, but they are no longer listed as current deltas from upstream. The fork-specific container **publishing variants** and compatibility additions still differ.

## Branch-Only: OpenAI-Compatible Image Routing

The current `feat/openai-compatible-image-routing` branch adds a routing mode that is **not yet on fork `main` and has no PR at this snapshot**.

| Property | Current branch behavior |
| --- | --- |
| Configuration | v2 `core-config.yaml` accepts `tools.generate.image.provider: openai-compatible`; v1 receives the safe `default` fallback but cannot opt in |
| Endpoint | Uses `OPENAI_COMPATIBLE_BASE_URL` and `OPENAI_COMPATIBLE_API_KEY` |
| Scope | Routes every existing `generate.image` alias through the configured OpenAI-compatible image endpoint |
| Model IDs | Keeps Lilac aliases at the tool boundary and sends fixed canonical model IDs upstream |
| Discovery | Image tool discovery remains available even when the compatible base URL is absent; execution then fails with a configuration error |
| Failure behavior | No automatic fallback to OpenAI, OpenRouter, or xAI; compatible-provider requests use a single generation attempt |
| Video behavior | `generate.video` is independent and remains on its existing provider path |
| Tool bridge | The standalone bridge loads the same core config so routing is consistent with the main runtime |
| Coverage | Config parsing, construction, registration, alias mapping, generation, editing, malformed responses, HTTP errors, and no-fallback behavior have focused tests |

Setup, canonical alias mappings, examples, error behavior, and troubleshooting are documented in [`docs/generate-image-openai-compatible.md`](./docs/generate-image-openai-compatible.md).

## Development Status

| Workstream | State | Notes |
| --- | --- | --- |
| Fork `main` | Maintained integration branch | Receives upstream merges and fork-specific operational fixes. It is the source for container publishing. |
| Upstream sync | Automated, one commit pending at snapshot | The six-hour workflow should pick up `0ad03bc`; conflicts require manual resolution. |
| OpenAI-compatible image routing | Implemented on feature branch; awaiting PR | The branch has been updated with the latest fork `main`. It is not a stable `main` feature until reviewed and merged. |
| Alternative image-provider proposal | Closed, not merged | PR [#25](https://github.com/DF-wu/lilac-mono/pull/25) passed CI but was closed. Its status must not be confused with the current routing branch. |
| Persistent compaction checkpoints | Implemented and independently reviewed | The checklist is complete; documented residual issues are non-blocking. See the [todo](./plan/persistent-compaction-checkpoints-todo.md) and [review](./plan/persistent-compaction-checkpoints-review.md). |
| Conversation thread search | Implemented checklist with one optional step deferred | Storage, search, embeddings, filters, workers, and validation are checked off; the optional top-N LLM reranker remains deferred. See [`plan/conversation-thread-search-todo.md`](./plan/conversation-thread-search-todo.md). |
| Other files under `plan/` | Mixed design and implementation records | A plan document is not proof that a feature is shipped. Check its status/checklist and then confirm against source and `MIGRATIONS.md`. |

### Validation recorded for this branch update

The following checks were completed while updating the branch with fork `main`:

- Focused core image/plugin suite: **43 passed, 0 failed**.
- Focused utils config suite: **27 passed, 0 failed**.
- Root `bun test`, including the workspace test harness: passed.
- Root `bun run typecheck`, covering all workspace TypeScript projects and model-option codegen: passed.
- Core remote runner, `tools` bridge, and `lilac-acp` builds: passed.
- Root lint auto-fix: **0 warnings, 0 errors**.
- Root formatter: completed successfully.

These results describe the checked commit/worktree, not a permanent guarantee. GitHub CI remains authoritative after a PR is opened or the branch is pushed.

## Pull Request Status

At the 2026-07-15 snapshot the repository has **19 historical PRs: 15 merged, 4 closed without merge, and 0 open**.

| PR | Result | What it represents |
| --- | --- | --- |
| [#25](https://github.com/DF-wu/lilac-mono/pull/25) | Closed, not merged; CI passed | Alternative "complete third-party image provider" implementation. It is not the current feature branch and is not on `main`. |
| [#24](https://github.com/DF-wu/lilac-mono/pull/24) | Merged into the image-provider feature base | Detailed PR #23 subagent failure report. It was carried into the later #22 merge. |
| [#23](https://github.com/DF-wu/lilac-mono/pull/23) | Merged into the image-provider feature base | Accepts an empty deferred-subagent `blockingReason`; later carried into #22. |
| [#22](https://github.com/DF-wu/lilac-mono/pull/22) | Merged to `main`; CI passed | Third-party image generation provider support and the feature-base work from #23/#24. Much of the provider behavior has since converged with upstream. |
| [#21](https://github.com/DF-wu/lilac-mono/pull/21) | Merged to `main`; CI passed | Upstream sync on 2026-06-19. |
| [#20](https://github.com/DF-wu/lilac-mono/pull/20) | Merged to `main`; CI passed | Added the `smart-search` runtime to the container image; upstream later gained equivalent runtime support. |
| [#19](https://github.com/DF-wu/lilac-mono/pull/19) | Merged to `main`; CI passed | Removed the Discord preview/plain stats flag. |
| [#18](https://github.com/DF-wu/lilac-mono/pull/18) | Closed, not merged; CI passed | Proposed stripping thinking blocks from outbound GitHub comments. |
| [#17](https://github.com/DF-wu/lilac-mono/pull/17) | Draft closed, not merged | Draft upstream GitHub `issue_comment` self-trigger fix. |
| [#16](https://github.com/DF-wu/lilac-mono/pull/16) | Merged to `main`; CI passed | Added a Discord preview/plain nerd-stats gate, later superseded by #19. |
| [#15](https://github.com/DF-wu/lilac-mono/pull/15) | Merged to `main`; CI passed | Hardened GitHub `issue_comment` self-trigger protection after the #13/#14 iteration. |
| [#14](https://github.com/DF-wu/lilac-mono/pull/14) | Merged to `main`; CI passed | Reverted the initial #13 self-trigger fix before the corrected implementation landed. |
| [#13](https://github.com/DF-wu/lilac-mono/pull/13) | Merged to `main`; CI passed | Initial GitHub `issue_comment` self-trigger fix, subsequently reverted by #14. |
| [#12](https://github.com/DF-wu/lilac-mono/pull/12) | Closed, not merged; CI passed | Proposed PR-based upstream synchronization; the repository currently uses direct scheduled merges instead. |
| [#11](https://github.com/DF-wu/lilac-mono/pull/11) | Merged to `main`; CI passed | Upstream sync on 2026-03-20. |
| [#9](https://github.com/DF-wu/lilac-mono/pull/9) | Merged to `main`; CI passed | Upstream sync on 2026-03-17. |
| [#8](https://github.com/DF-wu/lilac-mono/pull/8) | Merged into the 2026-03-16 sync branch | Restored Discord working-indicator defaults to upstream behavior. |
| [#7](https://github.com/DF-wu/lilac-mono/pull/7) | Merged into the 2026-03-16 sync branch | Refreshed fork documentation after upstream synchronization. |
| [#4](https://github.com/DF-wu/lilac-mono/pull/4) | Merged to `main`; CI passed | Upstream sync on 2026-03-16. |

The current image-routing branch is absent from this table because it does not yet have a PR number.

## What This Repository Does

- Receives requests from Discord and optional GitHub webhook ingress.
- Routes work through a typed Redis Streams event bus.
- Runs agent turns with provider-backed models, local tools, tool-server callables, and on-disk skills.
- Delivers output through Discord and GitHub surfaces.
- Supports wait-for-reply, scheduling, cancellation, resume, transcript persistence, compaction checkpoints, and conversation-thread retrieval.
- Exposes operator workflows through the `tools` bridge and the `lilac-acp` controller.

The high-level runtime flow is:

1. A surface adapter or GitHub webhook publishes a request.
2. Routing and request composition assemble the relevant conversation state.
3. The agent runner executes with models, tools, plugins, and skills.
4. Output is relayed back to the originating surface.
5. Workflow and heartbeat services can resume or initiate work later.

For the complete terminology and file-level mental model, read [`PROJECT.md`](./PROJECT.md).

## Repository Map

| Path | Purpose |
| --- | --- |
| `apps/core/` | Main runtime, surfaces, routing, agent runner, tool server, workflow services, transcript/search stores, and heartbeat services. |
| `apps/tool-bridge/` | Standalone tool-server construction and the built `tools` CLI bridge. |
| `apps/acp-controller/` | `lilac-acp`, a harness-aware ACP CLI with detached run state. |
| `packages/agent/` | AI SDK-based agent execution, streaming, compaction, and turn control. |
| `packages/event-bus/` | Typed event specification and Redis Streams transport. |
| `packages/plugin-runtime/` | Shared plugin contracts. |
| `packages/utils/` | Config parsing, environment handling, model/provider resolution, prompts, and skill discovery. |
| `data/` | Seeded runtime configuration and local runtime state. |
| `docs/` | Operator-facing feature documentation. |
| `plan/` | Design proposals, implementation checklists, reviews, and incident/PR reports with mixed completion states. |
| `ref/` | Vendored/reference repositories; read-only and not part of the active workspace. |

## Documentation Map

| Document | Use it for | Status / caveat |
| --- | --- | --- |
| [`PROJECT.md`](./PROJECT.md) | Architecture, terminology, routing, tools, runtime wiring, config, and file ownership | Primary technical mental model |
| [`AGENTS.md`](./AGENTS.md) | Bun commands, validation requirements, TypeScript conventions, config-version rules, and repo guardrails | Authoritative contributor instructions |
| [`MIGRATIONS.md`](./MIGRATIONS.md) | Frozen v1 behavior, v2 fields, defaults, and removed config | Check before changing `core-config.yaml` contracts |
| [`docs/generate-image-openai-compatible.md`](./docs/generate-image-openai-compatible.md) | Compatible image endpoint setup, aliases, generation/edit examples, errors, and troubleshooting | Branch-only until this feature is merged |
| [`apps/acp-controller/README.md`](./apps/acp-controller/README.md) | `lilac-acp` build, harness discovery, sessions, detached prompts, output, and state paths | Operator guide for the ACP CLI |
| [`plan/persistent-compaction-checkpoints-review.md`](./plan/persistent-compaction-checkpoints-review.md) | Independent review findings and verification for checkpoint persistence | Implemented; residual findings are documented as non-blocking |
| [`plan/conversation-thread-search-todo.md`](./plan/conversation-thread-search-todo.md) | Implementation completion and remaining optional reranking work | Checklist mostly complete; one optional item deferred |
| [`plan/pr-23-subagent-blocking-reason-report.md`](./plan/pr-23-subagent-blocking-reason-report.md) | Root cause, regression coverage, and merge history for PR #23 | Historical fork report in Traditional Chinese |
| [`plan/`](./plan/) | Broader proposals for heartbeat, subagents, plugins, tool-output governance, ACP, and other subsystems | Read each file's status; some are plans, others are completed records |

## Build, Test, and Validation

Use Bun from the repository root:

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run fmt:check
```

Build operator binaries:

```bash
cd apps/tool-bridge && bun run build
cd apps/acp-controller && bun run build
cd apps/core && bun run build:remote-runner
```

Before completing code, config, or documentation changes, project policy requires:

```bash
bun run lint:fix
bun run fmt
```

GitHub CI runs on pushes and pull requests targeting `main`. It installs with the frozen lockfile, starts Redis, builds the core remote runner, and runs the root `ci` script.

## Runtime and Delivery

### Prerequisites

- Redis, normally configured through `REDIS_URL`.
- Runtime config under `DATA_DIR`; the seeded local default is `data/core-config.yaml`.
- `DISCORD_TOKEN` unless `surface.discord.tokenEnv` selects another variable.
- `GITHUB_WEBHOOK_SECRET` when GitHub webhook ingress is enabled.
- Provider credentials required by the configured model and tool providers.

### Local container stack

```bash
docker compose up --build
```

This is an operator workflow, not a zero-config demo. Surface credentials and allowlists still need to be configured.

### Published images

The fork publishes `ghcr.io/df-wu/lilac-mono` with these tags:

- `catalina`: Catalina container-user variant.
- `claudia`: Claudia container-user variant.
- `latest`: currently points to `catalina`.
- `catalina-<sha>` and `claudia-<sha>`: commit-specific variants.

The image includes the upstream `smart-search` runtime and prerequisites. The fork's persistent config path normally resolves to:

```text
/data/.config/smart-search/config.json
```

Useful container checks are `smart-search --version`, `smart-search doctor --format json`, and `smart-search setup`.

## License

This repository is licensed under MIT. See [`LICENSE`](./LICENSE).

Material under `ref/` keeps its own upstream license terms.
