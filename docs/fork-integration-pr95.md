# PR #95 upstream integration

## Fixed inputs and scope

- Fork baseline: `1a6a26820fc012a3f4a721448fe4e1c756f04ab7` (`origin/main`).
- PR/upstream input: `473656e5b51907033c64c8a7a06a6a14ac93902e`.
- Common ancestor: `02b02ea7bfb668fc21e3d8d5c0985efd5d5ee89f`.
- Integration keeps the PR head as first parent and merges the fork baseline as second parent.
  Earlier PR-description/review SHAs are historical, not the integration input.
- Owner direction: prefer upstream architecture and migrate retained fork features where feasible.
  No incompatible product decision was identified. This candidate does not merge the PR or deploy it.

## Conflict decisions

The read-only merge probe reproduced nine conflicted paths. Resolution adopts upstream v3 schema
refactoring/descriptions, minimal v3 starter configuration, retired-callable behavior, and reorganized
migration documentation. It retains Telegram/OpenAI configuration, independent lazy defaults,
restricted-origin tests, fork migration guidance, and `startCoreRuntime` Result settlement.
`modelCatalogCache.supervise` feeds the process fatal handler alongside that startup seam.

Both fork schema modules now supply editor descriptions. The generated JSON was regenerated from the
merged schemas; the recursive v3 hover test was observed failing before those descriptions and passing
afterward. The exception registrations retain both sides' exact identities; their reviewed derived
catalog digest is `ca5099472f8af8c7b079f412daaca1eb61a755c8396a3d6fced2cbd9468d9010`.

`surface.messages.search`, `content.inspect`, and `attachment.download` remain retired as upstream
requires. Restricted native alias/literal-session tests remain. The standalone bridge's regression test
now verifies its lazy configuration callback with current workflow settings instead of invoking retired
`content.inspect`. A new v2/v3 regression checks Telegram admission/media, hosted-search configuration,
unknown-key diagnostics, fail-closed defaults, and independence between parsed configurations.

## Retained fork behavior and evidence

| Contract | Preservation and regression evidence |
| --- | --- |
| Telegram ingress, topics, streaming/HTML/chunking, cancellation, reactions, menus, media, lifecycle | `apps/core/tests/surface/telegram/` exercises the real adapter against local fake Bot API servers. |
| Telegram admission and origin-session authority | Chat/user allowlists remain fail closed; surface/server, Telegram authority, Bash/subagent, bridge-client and authenticated-request tests retain origin scoping. |
| Telegram workflows, progress/actions, waits and target revalidation | Existing workflow engine, progress-projector, trigger-scheduler and wait-resolver tests remain; no parallel workflow subsystem is introduced. |
| Telegram conversation memory and attachments | `telegram-cross-surface.test.ts`, `cross-surface.test.ts`, shared worker/store tests preserve chat/topic indexing, revisions, allowlisted reads, search and hydration. |
| OpenAI hosted search and search-only extraction skip | `web-search-openai*.test.ts`, `web.test.ts`, config/schema tests; v3 inherits the fork schema and rejects legacy singular spellings as upstream requires. |
| Compatible image provider on upstream script runner | `image-script-openai-compatible.test.ts`, image-generation tests and the existing skill recipe retain `providers.openaiCompatible`. |
| Command menu aliases and target parsing | `custom-commands/menu-alias.test.ts`, Telegram menu tests and utility tests. |
| Protected current-input compaction | `auto-compaction.test.ts` and runner compaction/lineage tests preserve untouched current input and loaded-tool authority. |
| Compatible-provider local tool calls | `ai-sdk-pi-agent.test.ts` retains parsed calls for nonstandard finish reasons while excluding truncated `length` output; latest inline-result continuation/retry logic remains upstream. |
| Compatible-provider tool images | `openai-compatible-tool-images.test.ts`; only compatible Chat Completions model views are wrapped, with canonical history intact. |
| GitHub final publication | Existing webhook prompt policy remains unchanged from the fork baseline; it prevents instructed duplicate final publication. This remains prompt guidance. |
| Redis cleanup | Existing single-flight cleanup and retry behavior, covered by `redis-streams-bus.test.ts`. |
| Startup legacy blob migration and Result boundary | Startup migration/backup tests retain exact legacy version checks, immutable backups, opt-out and default-command gating; `start-core-runtime.test.ts` covers Result settlement. |
| Custom media plugin example | Existing external Level 2 example, source/tests and plugin integration remain. |
| Container identities and maintenance | Catalina/Claudia UID/GID variants, `rsync`, image smoke matrix, sync workflow and footprint tooling remain. CI must validate this integrated fork, not an upstream-only run. |

The audit covers the full two-parent diff, including the 43 paths changed on both sides and the
nonconflicting authority, runtime ordering, schema-generator, provider, workflow and CI changes.
Fork-owned implementations not requiring migration retain the baseline content. The starter YAML now
matches upstream and was removed from the footprint allowlist. Canonical fork docs use v3 examples
while documenting continued v2 support.

## Local validation

Validation uses pinned Bun `1.4.4` installed outside the repository, a frozen dependency install, and
an isolated disposable Redis 7 container. No deployed service is restarted.

- Focused fork/integration selection: **1,007 passed, zero failed**, across 46 files.
- Additional isolated suites for skills, operator startup and the production bus runner:
  **254 passed, zero failed**. This includes the real compaction checkpoint regression.
- Generated config freshness and merged architecture catalog integrity pass.
- Strict upstream footprint: **115 allowed, zero unlisted, zero stale**.
- The initial host `bun run check` passed typechecks, generated/static gates and 113 architecture
  tests, but Core reported three host-dependent failures: global skill discovery polluted the skill
  result and exceeded the tiny compaction fixture's prompt budget; occupied port 8788 blocked the
  operator console. All three passed in the isolated suites above. No production code or tests were
  weakened to accommodate host state.

The final full check runs in a disposable Node 24 container with Bun 1.4.4, an empty home, private test
networking, Python, Go, fd/ripgrep/git, a private disposable Docker daemon for nested startup fixtures,
and the same working tree. The integration commit is gated on that full
`bun run check`, including codegen, workspace/extras typechecks, semantic/syntax architecture gates,
architecture tests, all workspace/root tests, lint rules, and formatting. CI run links and the final
commit/remote SHA are reported with the handoff because they exist only after this report is committed.

The complete isolated `bun run check` passed: **7,115 Bun tests passed, zero failed**, with five
existing conditional skips (two real computer-use Docker suites, the real S3 suite, and two real-browser
table PNG tests). All three check lanes exited successfully. The final read-only Codex review found no
actionable integration regression. This validation covers the integrated working tree; upstream-only
CI is not counted. A final full check is repeated after recording these results, before the merge commit.

## Limits and owner decisions

No incompatible retained feature requires an owner decision. Upstream v3 permission profiles, model
catalog/rules, retired tools and deployment-setting migrations are intentional; operators must follow
`docs/core-config-migrations.md` before upgrading existing configuration.

Fixtures do not validate live Telegram, hosted search, image/video providers, or private gateways.
Existing Telegram limitations remain: long polling, locally observed history, one memory thread per
chat/topic, no native reference links, and no Telegram heartbeat default destination. Existing
same-literal-ID cross-client authority policy is unchanged; the prior fork review records that separate
policy question. No live UI session or provider credentials are used for this integration.
