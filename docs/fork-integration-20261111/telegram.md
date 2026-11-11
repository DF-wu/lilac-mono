# Telegram integration evidence

Scope: audit features F01–F07, integrated against upstream
`3493c0c6c06260e6c472bd230dc02d4b0308db43`, retaining fork behavior from
`3c01ce2c29a66fa9be573f573c9865b7cb20c030`. This report covers the Telegram,
conversation-memory, workflow, and conversation-tool files assigned to this worker.
The parent owns runtime/runner/relay integration and final repository verification.

## Decisions and requirements coverage

| Feature | Integration decision | Evidence and limits |
| --- | --- | --- |
| F01 lifecycle/config | Retain Telegram's initialized history/identity before consumers, ingress after consumers, opt-in configuration, allowlists, reload and supervision. Keep the existing runtime descriptor adapter. | Telegram lifecycle, health, polling supervision, ingress outbox, surface runtime and adapter tests. Central runtime composition remains parent-owned. |
| F02 routing | Keep Telegram mention/reply/directive and username rules. Add upstream-style debounce supersession and claim the session before asynchronous composition. Release only the matching claim on failure, including composition exceptions, using lexical cleanup. | Three deterministic regressions cover a mention during a pending gate, a mention during composition, and failed composition followed by a fresh prompt. Existing router tests cover active/mention/DM behavior, deferred replies, reanchors, interrupts, suppression, shutdown flush and rollback. Shared control settlement remains runner-owned. |
| F03 output/tools | Retain Telegram HTML/chunking, media delivery, reactions, topic refs, sent-message history and cancellation modes. Adopt shared upstream relay ownership through the parent integration. | Telegram output stream/shrink/recording, chunk fidelity, HTML, attachments, end-to-end and adapter suites. No new renderer or tool contract. |
| F04 inbound files | Retain stable file IDs, authenticated byte-bounded resolution, one aggregate request budget, newest-first media selection, blob handles and metadata fallback. | Telegram inbound-media, attachment-resolution and end-to-end suites. No live Bot API or model-provider call. Audio/video/voice remain metadata-only. |
| F05 menus | Retain the existing isolated menu alias assignment, collision rules, Telegram command-name limits and targeted bot parsing. | Telegram command-menu suite and 53 shared custom-command tests. No new commands or aliases. |
| F06 memory | Preserve Telegram source DB and source revisions while adopting upstream per-subject summaries, facets, embeddings, IDs, anchor offsets and current-generation filtering. Preserve native DM windows and upstream batch attachment reads. | Actual search worker pool tests cover multiple Telegram subjects, offsets and metadata, generation replacement, source edits, allowlist revocation, equal IDs across surfaces and concurrent refresh. A derived-index reset fixture proves Telegram source messages remain available. |
| F07 workflows | Retain Telegram target/reply variants and live authorization checks while adopting schema 28, atomic operation/wait creation, cancellation outbox and scheduler stop/claim ownership. | Telegram progress send/edit/recreation race tests, trigger revocation and claim-to-fire race tests, reply correlation/suppression tests, plus a fixture upgrading schema 27 to 28, reopening Telegram targets/waits, cancelling and reopening cancellation intent. |

## Implementation seams

- `thread-store.ts` combines Telegram materialization with upstream native DM windows;
  shared message joins retain platform isolation. Native and Discord attachments retain
  upstream batch reads; Telegram attachment metadata remains source-owned.
- `upsertSummary` retains all upstream subject entries. Search hits must match both the
  current entry ordinal/write generation and, for Telegram/native sources, the current
  source revision. Older generations cannot survive re-summary or source edits.
- `thread-service.ts` uses the existing surface-kind projection while preserving subject
  IDs, offsets and metadata entries. The conversation-tool help describes Telegram and
  the per-subject read offset.
- Existing search/summarization worker protocols retain Telegram source paths, bot-name
  normalization and allowlists alongside upstream entry fields.
- `workflow-trigger-scheduler.ts` keeps both live target authorization and upstream
  in-flight tick completion. No workflow engine, queue, store or schema was added.
- Router debounce epochs invalidate a pending batch when a direct trigger replaces it.
  A claimed request is visible before composition awaits. Lexical claim cleanup restores
  prior state only while that request still owns the session.

## Verification

All final commands use the locally installed repository-matching Bun 1.4.4:

```sh
rtk proxy env PATH=/home/df/workspace/lilac-pr101-checkpoint-20261111/toolchain/package/bin:$PATH bun run test:root -- ./apps/core/tests/conversation ./apps/core/tests/surface/telegram ./apps/core/tests/workflow --only-failures
rtk proxy env PATH=/home/df/workspace/lilac-pr101-checkpoint-20261111/toolchain/package/bin:$PATH bun run test:root -- ./apps/core/tests/custom-commands --only-failures
rtk proxy env PATH=/home/df/workspace/lilac-pr101-checkpoint-20261111/toolchain/package/bin:$PATH bunx tsc -p apps/core/tsconfig.json --noEmit
rtk proxy env PATH=/home/df/workspace/lilac-pr101-checkpoint-20261111/toolchain/package/bin:$PATH bun run lint:architecture
```

- The first full focused run passed 939 tests in 61 files before the final composition
  failure and schema-28 fixtures were added. The final run passed 941 tests in 61 files,
  with zero failures and 6,586 assertions. Shared custom-command tests passed 53 tests
  in two files, with zero failures and 141 assertions.
- The affected router/store rerun passed 82 tests in two files after those additions.
- Core TypeScript check: exit 0. The earlier run exposed errors in other integration
  owners' files; those were reported and the subsequent run passed.
- Combined semantic and syntax architecture checks: exit 0; syntax gate reports zero errors.
- Targeted formatter and `git diff --check` passed. Targeted lint passed with no output
  after renaming the unused disposable binding to `_claim`.
- The pending-gate and composition-claim regressions were observed failing before their
  fixes. The composition-failure cleanup regression also failed before its fix.

No full repository check, commit, deployment, live configuration, credentials, runtime
database or private transcript was accessed by this worker. The linked audit note
`clusters/05-surfaces-memory.md` was absent, so the feature rows were validated against
the pinned source snapshots directly.

## Remaining limits and coordination

The parent must retain Telegram authenticated-origin/current-turn identity and per-entry
recall exclusion in the extracted runner, plus Telegram adapter composition in the shared
runtime/relay. The parent owns architecture registrations and final global acceptance.
No registration change has been introduced by this worker.

Existing limits remain: long polling only, observed/sent local history only, no structured
Telegram question port, Telegram heartbeat destination, process-job wake support,
native Telegram reference links or audio/video transcription. Telegram thread segmentation
continues to use one source thread per chat/topic; subjects are derived entries within it.
Real delivery, provider compatibility and deployment/rollback smoke tests remain unverified.
