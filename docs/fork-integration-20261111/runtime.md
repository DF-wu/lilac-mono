# Runtime, authority, recording and publication integration

Compared fork `3c01ce2c29a66fa9be573f573c9865b7cb20c030`, upstream
`3493c0c6c06260e6c472bd230dc02d4b0308db43`, and merge base
`05c41baa7a45b728d1722d69d5e55d5dc9e580b4`. Implemented on
`catalina/pr101-integration-20261111` in the isolated integration worktree.

## Dispositions and final ownership

| Feature | Disposition | Final implementation and evidence |
| --- | --- | --- |
| F08 native visible-message recording | Retained as a bounded post-commit observer | `surface/native/store.ts` adds `subscribeCommittedDisplay`, queueing at `bump`, and exact persisted replay-row verification before notification. `discord-mirror*` remains the best-effort sender. `native/runtime.ts` starts and stops it without replacing upstream jobs, questions, workflows, waiting state or turn reconstruction. |
| F15 authenticated origin targeting | Retained on upstream authority primitives | `tool-server/create-tool-server.ts` keeps capability/cache/principal validation and scopes restricted surface calls to the authenticated initiator. `tools/surface.ts` defaults to the initiator session, retains restricted explicit-target checks and native alias normalization. Optional origin compatibility fields, Bash environment and bridge header forwarding remain present. |
| F17 typed startup settlement | Retained as a small adapter | `runtime/start-core-runtime.ts` retains typed create/start failures and the exact throw/Panic cause in `CoreRuntimeInvocationFailed`; `main.ts` logs the structured failure. The start continuation is named to satisfy the updated Result-callback syntax rule. Upstream create/start cleanup and supervision remain authoritative. |
| F18 Redis cleanup | Retained over upstream lifecycle | `redis-streams-bus.ts` keeps successful group/stop attempts and releases failed attempts for retry, while preserving upstream subscription-owner maintenance, maintenance failure precedence, lease cleanup and Panic settlement. The fork scan-count assertion remains alongside upstream destructive-cleanup tests. |
| F19 GitHub final publication | Retained as prompt policy | `github-webhook-server.ts` keeps the issue and review `NO_REPLY_TOKEN` instructions over upstream collaborator admission, delivery IDs, pagination, dedupe and failed-setup rollback. New dispatch tests inspect both prompt variants. |
| Shared Telegram runner/relay seams | Adapted to upstream extracted owners | `bus-agent-runner/auto-inject-thread-search.ts` uses `ConversationSurface` and the request-client projection. Entry IDs, subject offsets and entry-level exclusion remain upstream behavior. The runner retains the active canonical-input callback. `subscribe-from-bus.ts` carries commentary continuation into `relayStream` when reanchoring. |
| Transcript discovery | Adapted to upstream incremental discovery | `transcript-store.ts` retains the exported schema constant, discovery version/snapshot, request-ID batches and channel queries. Supported surface filtering is applied in the shared discovery reader's LEFT JOIN, preserving unlinked transcripts and Telegram refs. |

The runner conflict was resolved to upstream's extracted session queue, controls, lineage and recall
modules. The old inline recall implementation was removed from the merged runner. The surface test
conflict retains both Telegram recent-write filtering and upstream bot-author-only mutation tests.

## Regression coverage

- Native mirror tests include a real hidden `job-wake:` admission and deferred question, followed by
  visible assistant text carrying a question part. Only the visible text is recorded. Existing tests
  continue to cover rollback, historical replay, children/external output, internal/service inputs,
  reasoning/tools, ready-resource authority and bytes, edits/reset/retraction, sender deadlines and
  blocked-sender isolation.
- Startup tests cover create/start returned domain failures, ordinary throws, thrown Panics, returned
  Panics, exact cause identity and successful runtime return.
- Origin tests cover synthetic workflow sessions, caller-forged headers, capability/cache/principal
  mismatch, native raw/prefixed aliases, cross-session/cross-client denial and Telegram capability and
  delegation origin. The Telegram authority fixture now waits for observable toolset construction
  instead of the removed `getActiveDrainOperation` API.
- The new Core lineage test uses the real mapping helper and lineage codec to preserve the exact
  active multipart input and tool-pair suffix across a restored boundary and repeated canonical
  replacements. Package-level compaction callback and recovery-checkpoint tests belong to the
  provider integration work; this test does not claim a new live WAL/restart simulation.
- Redis regression tests prove one `DESTROY` and one successful managed-state scan for racing
  stop/close, successful retry after cleanup failure, stale-incarnation isolation and Panic identity.
- GitHub dispatch tests assert automatic issue publication, successful direct-publication sentinel,
  successful manual-review suppression and changed-head/no-review fallback. Upstream webhook tests
  retain collaborator gating, payload/signature validation, response-before-dispatch and retryable
  failure behavior.

## Commands and results

All shell commands used `rtk`. Bun was pinned through:

```sh
rtk proxy env PATH=/home/df/workspace/lilac-pr101-checkpoint-20261111/toolchain/package/bin:$PATH bun ...
```

Focused tests were invoked through root `test:root` with explicit `./` paths:

| Batch | Test files or scope | Result |
| --- | --- | --- |
| Authority and feature seams | Startup, mirror, GitHub dispatch, tool-server surface, tool-server HTTP/context, Telegram runner authority | 200 passed |
| Persistence and extracted helpers | Transcript store, recall, controls, agent-event projection | 117 passed |
| Runner and relay integration | Core lineage, recall, session queue, bus relay, relay reducer, production runner | 242 passed |
| Native and compatibility | Startup, mirror, native execution, native questions, GitHub collaborator gate, webhook ingress, tool-bridge client | 126 passed |
| Redis lifecycle | `redis-streams-bus.test.ts` filtered to cleanup/retry/incarnation/Panic cases | 8 passed, 54 unrelated tests filtered |
| Final startup identity | Startup suite after adding thrown-Panic cases and naming the Result continuation | 9 passed |

The Redis command used an explicitly supplied loopback URL for a dedicated, randomly named
`redis:7-alpine` fixture container with persistence disabled. The fixture container was removed in a
`finally` block. Neither default nor deployed Redis was contacted.

Scoped typechecks passed:

```sh
rtk proxy env PATH=/home/df/workspace/lilac-pr101-checkpoint-20261111/toolchain/package/bin:$PATH bunx tsc -p apps/core/tsconfig.json --noEmit
rtk proxy env PATH=/home/df/workspace/lilac-pr101-checkpoint-20261111/toolchain/package/bin:$PATH bunx tsc -p packages/event-bus/tsconfig.json --noEmit
```

The root `typecheck:workspaces` script does not accept filters. An initial attempted filtered
invocation therefore checked all workspaces and exposed in-progress issues owned by other workers;
those findings were sent to the relevant owners. Final scoped checks use the commands above.

Targeted `oxfmt --write` covered only files edited by this worker; a 13-file targeted format check
passed. Removed the obsolete transcript-message decoder import reported by the parent's lint.
Scoped `git diff --check` and a
merge-marker scan passed. The parent owns final repository-wide lint, architecture, format, check,
footprint and release evidence. No commit was created.

## Architecture handoff and limits

Retain the existing boundary decoder registration for
`src/surface/native/discord-mirror-webhook.ts#decodeDiscordMirrorReply` with category `wire`.
Upstream already registers the extracted recall, lineage and queue boundary identities. No additional
registration was introduced by these changes; the parent must validate the merged catalog globally.

Recording remains best effort: bounded in-memory work, no historical backfill, no persistent webhook
message map, no restart replay and no durable deletion guarantee. GitHub sentinel instructions remain
model-facing policy and do not establish transactional duplicate prevention. Optional origin
compatibility fields were preserved; current authorization still comes from server-validated
initiator/capability state. No new stored contract, dependency, configuration option, queue or worker
was introduced. No live configuration, credentials, user data, external webhook or deployed service
was accessed.
