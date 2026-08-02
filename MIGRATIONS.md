# MIGRATIONS.md

This file documents config-version changes in a form that is readable by both humans and agents.

## Core Config

Lilac parses `core-config.yaml` through a versioned parser into one universal runtime config shape. The app only consumes the universal shape.

Rules:

- New generated configs include `configVersion`.
- Existing configs without `configVersion` are treated as `configVersion: 1`.
- Lilac does not auto-upgrade config files at startup.
- Versioned parsers own defaults for their version.
- New behavior-changing defaults only apply to configs on the version that introduced them.
- If a newer field cannot be represented safely in an older version, that field requires the newer `configVersion`.

Removed fields:

- `surface.discord.outputPreviewPlainFinalStats` was removed. Discord preview + plain final output now appends the stats footer whenever stats metadata is produced.

## v1

`configVersion: 1` is the initial versioned config contract and matches the defaults used before config versioning was introduced.

To make an existing implicit v1 config explicit, add:

```yaml
configVersion: 1
```

No field migrations are required for v1.

## v2

`configVersion: 2` uses the universal runtime config field names directly and changes several defaults.

Field renames from v1:

- `tools.experimental_hashline_edit` -> `tools.editFile.hashline`
- `surface.discord.previewFinalOutputStyle` -> `surface.discord.outputPreviewModeFinalStyle`
- `surface.discord.experimental.markdownTableRender` -> `surface.discord.markdownTableRender`
- `agent.subagents.defaultTimeoutMs` -> `agent.subagents.idleTimeoutMs`; the timeout now measures inactivity rather than total runtime.

Removed v2 fields:

- `agent.subagents.maxTimeoutMs`; the universal runtime config no longer exposes a hard timeout cap. Frozen v1 configs may still contain this field, but it is not carried into the universal config.

New v2 fields:

- `workflows.maxActiveRuns`: principal-blind global admission cap across all nonterminal workflow runs, including scheduled and generated subagent runs; defaults to `64`. Frozen v1 configs receive the same universal fallback but cannot override it.
- `agent.idleTimeoutMs`: primary agent inactivity timeout; defaults to `900000` (15 minutes). Active runs have no total runtime cap. Frozen v1 configs receive the same universal fallback but cannot override it.
- `tools.inspect.model`: configurable Gemini model for `content.inspect`; must start with `google/`.
- `models.capability.overrides.<provider/model>.attachment`: optional manual override for model attachment input support.
- `conversation.thread.summarization.enabled`: default-false gate for background conversation thread summarization.
- `conversation.thread.summarization.model`: model used for conversation thread summaries; defaults to `fast`.
- `conversation.thread.summarization.concurrency`: number of threads to summarize concurrently inside one run; defaults to `1`.
- `conversation.thread.summarization.batchSize`: maximum threads processed by one periodic run; defaults to `32`. Manual runs remain unbounded unless they provide a limit. Frozen v1 configs receive the same universal fallback but cannot override it.
- `conversation.thread.summarization.includePromptContext`: default-false option to include `MEMORY.md`, `USER.md`, and optional `ENTITIES.md` as background-only summarization context.
- `conversation.thread.embedding.enabled` and `conversation.thread.embedding.model`: default-false semantic thread embedding generation using an AI SDK embedding model ref.
- `conversation.thread.autoInject.plannerModel`: optional model used for request-time auto-inject query planning; when unset, it inherits `conversation.thread.summarization.model`.
- `conversation.thread.autoInject.minTextUnits`: minimum authored text mass before auto-injecting conversation thread metadata; defaults to `80`.
- `conversation.thread.autoInject.followUpMinTextUnits`: higher text-mass threshold after prior auto-injected thread metadata exists in the same conversation; defaults to `110`.
- `conversation.thread.autoInject.minScore`: minimum final `conversation.thread.search` score for auto-injected metadata; defaults to `0.1`.
- `tools.output`: direct-result preview and transient artifact policy. Defaults to `40KiB`, `7d`, and `50MiB` per session.
- `tools.historicalResultPruning`: compatibility policy for rewriting old tool results. It defaults to disabled with the prior `40000`/`20000` token thresholds retained when enabled.
- `tools.batch.maxCalls`: maximum calls accepted by one batch; defaults to `8`.
- Batch now expands children into ordinary Level 1 tool calls. Enabled tools are batchable by default; plugin authors can set `supportsBatch: false` to opt out.
- `tools.media`: model-view inline binary limits. Defaults to `10MiB` per part and `20MiB` in total.
- `agent.subagents.delegatePromptOverlay`: optional free-form guidance appended to the parent-visible `subagent_delegate` tool description.
- `models.def.<alias>.comment`: optional guidance shown when an agent selects a model for a subagent.
- `models.def.<alias>.agentCanSelect`: explicitly opts an alias into dynamic selection through `subagent_delegate`; defaults to `false`. It does not restrict static profiles, model slots, or explicit human overrides.
- `surface.telegram`: the Telegram surface. It is disabled by default, so adding it changes no existing behavior. Frozen v1 configs receive the same universal fallback (`enabled: false`) but cannot enable or configure the surface — enabling Telegram requires `configVersion: 2`. Keys: `enabled`, `tokenEnv` (default `TELEGRAM_BOT_TOKEN`), `botName`, `botUsername`, `allowedChatIds`, `allowedUserIds`, `dbPath`, `outputMode`, `parseMode`, `streamEditIntervalMs`, `outputNotification`, `workingIndicators`, `commandMenu`, and `markdownTableRender`.
  - `allowedChatIds` fails closed: while it is empty the bot ignores every chat.
  - `streamEditIntervalMs` defaults to `1500`. Telegram throttles `editMessageText` at roughly one call per second per chat, so lower values trip `429 retry_after`.
  - `parseMode` defaults to `html`. Telegram's MarkdownV2 requires escaping 18 reserved characters, whereas HTML needs only three, and a malformed entity degrades to plain text instead of failing the send.
- `tools.generate.image.provider`: transport routing switch for `generate.image`; values are `default` (built-in aliases) or `openai-compatible` (route through the OpenAI-compatible provider). Aliases and adapters remain unchanged; all aliases route together. Canonical model IDs are fixed. Selecting third-party routing has no automatic fallback. Frozen v1 configs receive the same `default` fallback but cannot opt in.

Tool byte-size fields accept `B`, `KB`, `MB`, `GB`, `KiB`, `MiB`, and `GiB`. Duration fields accept `ms`, `s`, `m`, `h`, `d`, `w`, and `mo`; `mo` is a fixed 30 days. These fields cannot be configured in the frozen v1 input shape, but v1 receives the same universal runtime defaults.

Default changes from v1:

- `tools.fsBackend: fff`
- `tools.editFile.hashline: true`
- `tools.inspect.model: google/gemini-3.5-flash` (`configVersion: 1` always uses `google/gemini-3-flash`)
- `surface.discord.outputMode: preview`
- `surface.discord.outputPreviewModeFinalStyle: plain`
- `surface.discord.outputNotification: true`
- `surface.discord.markdownTableRender: { enabled: true, style: unicode, maxWidth: 50, fallbackMode: list }`
- `agent.reasoningDisplay: detailed`
- `agent.subagents.idleTimeoutMs: 360000`; explicit v1 `defaultTimeoutMs` values are preserved, while omitted values use the new universal default.

## Mini Lilac Database Schema 3

Mini Lilac migrates schema 2 databases to schema 3 transactionally at startup. Schema 3 preserves
sessions, runs, commands, and todos, and replaces mutable full transcript rows and full-prefix undo
checkpoint blobs with immutable, hash-chained model/UI nodes. Session heads and undo checkpoints
reference those chains, so common prefixes are shared while legacy divergent checkpoint branches
remain usable. The migration drops `run_chunks`, `model_transcript`, and `ui_messages`, and sets
`user_version` to 3 only after all data and tables have migrated successfully. It does not run
`VACUUM`. Database versions other than 0, 2, and 3 are rejected.

Stream chunks are no longer durable SQLite state. An active session actor keeps a monotonic live log
for replay, tail reconnect, resume projection, and final UI reconstruction. The log is discarded at
run finalization. A process crash therefore retains no partial chunks and startup marks interrupted
runs as errors; finalized canonical transcripts remain durable.

## Mini Lilac Database Schema 4

Mini Lilac migrates schema 3 databases to schema 4 transactionally at startup. Schema 4 rebuilds the
`sessions` table to widen its status `CHECK` with `compacting` and to add
`input_tokens_estimated`. Every other table cascades from `sessions`, so the rebuild follows
SQLite's documented recipe: `foreign_keys` off and `legacy_alter_table` on around the transaction,
with `PRAGMA foreign_key_check` verified afterwards. No row content changes; existing sessions get
`input_tokens_estimated = 0`. Database versions other than 0, 2, 3, and 4 are rejected, and a
schema 2 database migrates through 3 to 4 in one startup.

Behaviour changes that accompany the schema:

- Manual compaction sets the session status to `compacting` for its duration instead of leaving it
  `idle`, and `commitCompaction` accepts `compacting` as a valid pre-commit state. An interrupted
  compaction is recovered to `idle` at startup rather than to `error`, because compaction commits
  only on success and therefore never leaves a partial transcript.
- A committed manual compaction now writes the post-compaction token estimate to `input_tokens`
  with `input_tokens_estimated = 1`, where it previously wrote `NULL`. The next turn's reported
  usage clears the flag.

## Mini Lilac Protocol: compaction lifecycle

`miniLilacCompactionEventSchema` replaces its terminal-only `status: "completed" | "failed"` field
with a `phase` discriminant (`started`, `progress`, `completed`, `failed`, `cancelled`) plus
`outcome`, `progress`, `summary`, `elapsedMs`, `durationMs`, and `modelCalls`. Persisted
`data-compaction` UI parts written by older builds carry `status` and no longer parse; they are
rejected at the transcript boundary rather than silently dropped.

`POST /sessions/:id/compact` returns a UI message event stream instead of a JSON body. Admission
still happens before the stream opens, so a non-quiescent session is still a 409.

The response stream is a view of the compaction, not its owner. Abandoning the request only detaches
the client: the compaction continues and still commits, and reattaching to it is not supported.
Stopping it is `POST /sessions/:id/compact/cancel`, which answers `{"status":"cancelling"}` or
`{"status":"inactive"}`; the terminal `cancelled` event then arrives on any stream still attached.
Clients that previously cancelled by aborting the request will no longer stop anything.

`compacting` is a session status, and every admission path — prompts included — now requires
`idle`/`error`. A prompt sent during a compaction is rejected rather than raced.

## Mini Lilac Database Schema 7

Schema 7 adds provider-family metadata to history states and pending finalizations, plus
exact-history-state Claude bindings and bounded attempt records for Mini main sessions. Existing
history has unknown provider-family metadata and no native binding, so its next Claude turn starts a
fresh persisted session rather than guessing that native state is synchronized. The current schema 8
startup path applies this step to schema 6 and older supported databases in the same transaction as
the schema 8 step.

Successful Claude turns promote a binding only with their committed terminal history state. Main
bindings remain attached to retained history states, allowing restart, undo, redo, and branch
navigation to select an exact clean native base. Active attempts left by a crash become uncertain at
startup and are never promoted.

## Mini Lilac Database Schema 8

Mini Lilac migrates schema 7 databases to schema 8 transactionally at startup. Schema 8 adds one
current Claude binding and bounded attempt records for named delegated sessions, together
with pending-finalization promotion metadata. Existing named sessions receive no inferred native
binding and start fresh on their next eligible Claude turn. Both caller-supplied and generated names
are eligible; callers continue an automatically named child by reusing the returned name.

Main-session schema 7 behavior is unchanged. Startup recovery marks interrupted named attempts
uncertain and can finish a canonically verified pending success. Foreign keys are checked before
`user_version` becomes 8. Fresh databases and supported schema 2 through 7 databases end at schema 8.

## Core Transcript Database Schemas 1-5

Core's `agent-transcripts.db` has its own `transcript_schema_migrations` sequence. These are internal
SQLite migrations and do not change `core-config.yaml`; its current config contract remains
`configVersion: 2`.

- Transcript schema 1 records the baseline request transcript/cache tables and the current named
  Claude binding/attempt substrate. Existing transcripts do not gain guessed native bindings.
- Transcript schema 2 adds immutable first-seen surface projections, Core-owned attachment blobs,
  request/checkpoint lineage references, primary lineage manifests, and canonical transcript digests.
  Existing transcript rows are parsed and hashed during migration; an unreadable row aborts the
  migration rather than receiving an unsafe digest.
- Transcript schema 3 adds request-output alias references so split Discord output messages can point
  to one canonical request atom without duplicating history.
- Transcript schema 4 adds Discord-primary Claude bindings and bounded attempt records. A binding is
  usable only when the current composed lineage proves the exact complete-segment prefix; existing
  Discord history starts fresh until a successful current turn establishes that proof.
- Transcript schema 5 adds `terminal_request_id` to every Discord-primary Claude binding. The ID
  points to the exact retained request transcript and lineage manifest that produce the binding's
  atom count, prefix digest, and canonical message count. Migration first considers matching retained
  succeeded attempts, then scans retained durable transcript/manifest rows so a valid binding can be
  backfilled even when bounded attempt retention already pruned its attempt. Every candidate is fully
  recomputed and accepted only when its client/session, provider state, lineage version, atom count,
  digest, and canonical count match exactly. Bindings without one exact durable terminal request are
  deleted rather than guessed.

Core applies missing versions in one immediate transaction, validates foreign keys, marks interrupted
native attempts uncertain during startup recovery, and promotes recovered pending successes only
after canonical transcript/lineage verification. Primary binding reads lazily reverify the identified
terminal transcript and manifest. A missing, corrupt, or mismatched head is compare-and-delete retired;
a concurrent replacement is re-read rather than deleted, and continuation safely starts fresh when no
verified binding remains.

Core also exposes aggregate retention diagnostics for named/primary binding counts, active/terminal
attempt counts, unverifiable primary bindings, orphan succeeded attempts/manifests, unreferenced
surface projections, total Core-owned blob bytes, and unreferenced blob counts/bytes. Bounded attempt
pruning emits per-owner metadata-pruned diagnostics. These are internal retention/operational
diagnostics and do not add a `core-config.yaml` key; the config contract remains `configVersion: 2`.

## Historical Workflow Schema 18

Workflow capability review now stores a normalized maximum envelope with per-operation narrowing, exact Level-1 tools, concrete Level-2 callable IDs, destination-scoped origin surface operations, allowed roots, bounded reasoning, and explicit trusted executable authority.

Pre-envelope revisions cannot be interpreted without changing their approval meaning. Migration 18 therefore removes their dependent runs, triggers, approvals, and revision rows. Workflow source files remain in place and must be triggered and reviewed again under the new contract.

## Workflow Runtime Clean Break

The unified programmatic workflow runtime does not read or migrate legacy `WorkflowDefinitionV2`/`WorkflowDefinitionV3` records. Existing `workflows` and `workflow_tasks` SQLite tables may remain on disk but are inert. Recreate scheduled jobs as JavaScript definitions plus `workflow.trigger.create`; existing approvals do not carry forward because approval identity includes the immutable source, schema, capability profile, project path, and runtime version.

Deferred subagents now persist as generated unified workflow runs. Graceful-restart snapshots no longer contain runner-local deferred child handles, output cursors, timers, or buffered completions. Active generated runs and pending live-parent deliveries recover from the durable workflow database; terminal results fall back to a durable progress card when the parent cannot be restored.

At the time of this clean break, workflow JavaScript ran inside a fail-closed OS sandbox that required a systemd-PID1 Docker image with Bubblewrap, cgroup v2, and a reachable `lilac` user systemd manager. That deployment requirement is historical and is superseded by Schema 21, which runs the deterministic program child as a plain Bun subprocess. See the Schema 21 section below.

The Level-2 HTTP server remains an internal trusted-network service rather than a generally authenticated public API. Workflow admission adds no caller-specific or principal gate beyond ordinary Level-2 callable routing; every caller and trigger competes against the same global active-run cap.

## Workflow Schema 20

Schema 20 and runtime `lilac-workflow-js-v3` are the profile-native trusted-auto-run clean break. Workflow definitions use `resources` for orchestration bounds, and the public durable hash is `resourcePolicySha256`. The former maximum capability envelope, exact grant identity, approval API/state/actions, `awaiting_review`, and shared-editor lease runtime are removed.

Migration from schema 19 does not translate old authority:

- Every v19 revision receives a bounded `workflow_legacy_audit_records` summary before its executable rows are removed.
- Terminal v19 runs are retained only as audit summaries because their maximum-envelope revision shape is not readable as a v3 resource policy.
- Nonterminal v19 runs and operations, plus active/paused triggers, receive explicit `workflow_quarantine` reasons before deletion.
- All old request dispatches are deactivated before dependent rows are deleted, so no old dispatch can be adopted or redispatched under current defaults.
- Standalone v19 terminal receipts are archived as bounded `terminal_receipt` audit records and deleted with their old runs; no receipt can outlive the executable identity it referred to.
- Old triggers and generated subagent revisions are deleted and must be recreated from current source by an authenticated trusted principal.
- The historical approval tables/columns remain inert to avoid a disproportionate SQLite table-rebuild migration. No current store API, engine, scheduler, tool API, event, or progress action reads or writes approval records.
- `workflow_shared_editor_leases` is dropped. Shared writers are intentionally concurrent.

After migration, source files remain on disk and are statically revalidated into a new v3 snapshot on their first trusted invocation. Removed `capabilities` metadata fails validation with migration guidance; rename resource bounds to `resources` and use only profile-native `agent()` options.

The unshipped workflow-only `plugins.workflowExternal`, plugin `workflowExposure`, and Level-1 effect metadata were removed rather than migrated. Config v2 now owns Level-1 tools/plugins, Level-2 callables/plugins, direct network, workspace writes, execution, and delegation under each `agent.subagents.profiles.*` entry. Config v1 remains frozen and receives the useful built-in profile defaults during universal parsing. These native profiles apply identically to direct and workflow-launched subagents and are not serialized into workflow revisions or operation guardrail envelopes.

## Workflow Schema 21

Schema 21 is the workflow-runtime-simplification clean break. The guiding rule is that workflows orchestrate and profiles authorize: the workflow layer keeps durable operation identity, dispatch epochs, single-owner claims, terminal receipts, waits, triggers, replay, and progress, and drops every workflow-specific security concept. This is an atomic migration that shrinks the persisted dispatch policy while still reading persisted v20 dispatches.

Resolved `agent()` input is reduced to `profile`, `cwd`, `model`, `reasoning`, and `label`. `cwd` is free-form and no longer canonicalized against protected roots. Agent authority comes entirely from the selected native profile: profiles own tools, Bash, Level-2 callables, network, and delegation, identically for direct and workflow launches. The former `isolation`, `editing`, `tools`, `executables`, `level2Callables`, `surfaceOriginOperations`, and `delegation` agent options are removed and fail validation with migration guidance.

The deterministic program child is spawned directly with `bun --smol workflow-sandbox-child.js`. The child keeps its determinism lockdown and NDJSON protocol, and the host retains wall-time, cancellation, output-size, and protocol limits with forced termination. `maxRuntimeMemoryBytes` is removed because a plain Bun subprocess does not enforce that contract; it is stripped from persisted revision limits. Workflow execution no longer requires systemd, Bubblewrap, cgroup v2, or user namespaces, and there is no plain-subprocess fallback to fail closed against.

The persisted state migration is a clean break rather than a reinterpretation:

- The minimal durable dispatch policy is `{ runId, operationId, dispatchEpoch, profile, model, reasoning, resolvedModelRequest, cwd, originSession, stableNamedContinuation? }`. The optional stable identity is present only for eligible live-parent named subagents and is verified against that run's persisted completion target. Old `policy_json` is rewritten into this envelope; the former `canonicalCwd` becomes `cwd`, and canonical-root, inode, safety-mode, isolation, scratch-root, and control-token identity are dropped.
- Terminal runs, operations, journals, results, and receipts stay readable. Pinned resolved-model identity and dispatch fencing are preserved.
- Nonterminal v20 runs and operations are quarantined with explicit reasons, then terminalized as `cancelled` with an explicit migration reason; their pending waits are cancelled.
- Active and paused triggers are quarantined and cancelled; they must be recreated from current source by an authenticated trusted principal.
- All active request dispatches are deactivated so no old dispatch can be adopted or redispatched under the current defaults.
- `maxRuntimeMemoryBytes` and revision `safety` metadata are removed from revision rows, and `safetyMode` is removed from trigger origins.
- Approval residue is dropped: the `workflow_approvals` table, the `approval_id` columns on `workflow_runs` and `workflow_surface_actions`, the `origin_safety_mode` column, and the approval-state index.
- Worktree residue is dropped: `workflow_worktree_outputs` and its cleanup index.
- Single-process projector residue is dropped: projection claims, orphans, missing-binding tables and triggers, and reconciliation state. One durable surface binding per run, the action outbox, edit-on-change, startup reconciliation, retry state, controls, and terminal cards are retained.

The workflow-only security modules removed in this break (Level-1 boundary, path authority, protected-path, denied-root policy, network policy, descriptor path, scratch, and worktree artifact) are deleted rather than migrated. The dead tool-bridge `x-lilac-workflow-capability` header and plugin `workflowPathAuthority` guidance are removed. Level-2 `workflow.*` access follows native profile configuration and the generic profile-bound request capability; there is no workflow-specific active-request or principal gate.

Schema 22 adds durable materialization attempt/error state to live-parent completion deliveries. Deferred subagent results retry artifact loading and output normalization across process restarts before Core inserts an explicit failed synthetic result, preventing transient delivery failures from either losing successful child output or waiting forever.

## Workflow Schema 23

Schema 23 and runtime `lilac-workflow-js-v4` remove the workflow-wide wall-time contract. Workflow programs, sleeps, reply waits, pauses, and recovery have no total elapsed-time limit. Individual child-agent operations retain `operationIdleTimeoutMs`, and explicit cancellation still forcibly terminates the workflow subprocess.

The v4 API also removes the unused public `parallel(..., { concurrency })` option; `parallel(promises)` joins already-created promises, while `pipeline(..., { concurrency })` provides bounded fan-out. Reply waits are explicitly limited to the authenticated originating Discord or Telegram session and user. Matching replies are suppressed from ordinary surface routing so they resume only the waiting workflow. Telegram durable progress targets must use the originating Telegram session; scheduled fire and every progress-card send/edit/recreation recheck the current `allowedChatIds`, so removing a chat stops persisted schedules and projections without deleting their durable records. Literal host-call option objects receive static validation before a definition is saved or triggered.

Terminal results, terminal detail, and requested result artifacts are returned without sensitivity gating. Sensitive input fields, argument hashes, and progress values remain redacted. The obsolete `includeSensitiveResult` run-inspection option is removed.

This is a clean break for persisted v3 execution identity. Migration 23 archives bounded summaries for old revisions, runs, triggers, and terminal receipts; quarantines nonterminal runs and active triggers; deactivates dispatches; and removes v3 executable rows. Source definition files remain on disk and can be corrected and saved as v4 definitions. The request-dispatch table no longer has a hard expiry column; active state, run and operation state, dispatch epochs, owner heartbeats, idle cancellation, and exact terminal receipts govern its lifecycle.
