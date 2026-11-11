# Independent Codex review

Two independent Codex reviewers read the combined candidate, pinned fork/upstream source,
connected callers, persistence/authority boundaries and focused tests. They did not implement
the domain changes. One covered Core/Telegram/runtime; the other covered providers,
configuration, delivery, migration and inventory. The final verification record identifies
the tested commit and any subsequent review confirmation.

## Findings and resolution

| Finding | Evidence and scope | Resolution and regression |
| --- | --- | --- |
| P1: Telegram control could precede the batch it joined | Early session claim plus slow composition allowed `steer` before `prompt`. The actual runner starts an idle session from that control; an in-memory reproduction reached the mocked model with only the later mention. Introduced by this integration's early claim. | A claim now exposes publication completion. Later messages await it and refresh routing. Completion settles on success and failure; failed composition restores the prior claim and the waiting mention becomes a fresh prompt. The regression failed with `[steer, prompt]` before the fix, then passed with `[prompt, steer]`; it uses the real runner and asserts that its first model input contains the original batch. A second controlled test verifies failure rerouting without a hang or dropped mention. |
| P2: restricted target could cross clients through the same literal alias | Both the HTTP authority gate and surface adapter compared session strings without first rejecting a different explicit client. Reviewer reproduced a native-origin call reading an allowed Discord channel through an alias equal to the native origin. Inherited fork behavior, but violates F15's explicit cross-client denial requirement. | Both guards reject a differing explicit client before defaulting or comparing IDs. Native raw/prefixed aliases remain valid within native. Equal-literal and omitted-session regressions failed before the surface fix; HTTP tests cover both forms under authenticated workflow origin. |
| P2: scheduled releases rejected successful sync tips | The inherited release demanded a prior push-CI event. `GITHUB_TOKEN` sync updates deliberately do not produce that event, despite the sync's reusable CI. | Release artifact builds now depend on reusable CI for the release's exact SHA and pinned upstream footprint ref. The unchanged-release skip remains. The dependency regression failed before the change; actual YAML gate and publication tests pass after it. |
| Stale current migration guidance promised an automatic backup/migration | The entrypoint hook and wrappers were removed, while current `MIGRATIONS.md`, `PROJECT.md` and fork inventories still described them. | Current guidance now names the supported offline baseline and verified backup/restore procedure. Historical dated reports remain historical. The old migration anchor remains usable and points at the new cutover description. |

The provider reviewer demonstrated no further consequential F09–F14/F23 issue. The inventory
was independently recounted at review time without missing or extra paths; final counts are
regenerated after adding the final evidence files.

The Core reviewer independently ran 40 startup, lineage, mirror and Telegram-memory tests
with Bun 1.4.4: zero failures and 230 assertions. Reviewer bug reproductions used in-memory
fixtures and mocked execution, without live services or private data.

## Residual findings and limits

- F17's asynchronous fatal-startup window is inherited from the fork: `main.ts` receives the
  runtime only after `startCoreRuntime` finishes. A fatal callback during startup may therefore
  exit before the process handler can call `runtime.stop`. This integration preserves the
  requested typed settlement and normal startup rollback; it does not claim to redesign fatal
  process shutdown. The limitation remains recorded for separate lifecycle work.
- The analogous early-control ordering limitation in the upstream Discord router was not
  expanded into unrelated Discord product work. The new Telegram ordering regression is fixed.
- Review does not certify live providers, operator data, GitHub/GHCR execution or arm64.
  Native recording and GitHub publication retain their documented best-effort limits.
- Whole-repository checks, exact candidate SHA checks and final image provenance are recorded
  separately. A source review is not a substitute for those checks.
