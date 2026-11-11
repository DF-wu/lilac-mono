# PR #101 integration checkpoint

Status: integration in progress; no validation or release claim.

- Fork base: `3c01ce2c29a66fa9be573f573c9865b7cb20c030`.
- Upstream target and original PR head: `3493c0c6c06260e6c472bd230dc02d4b0308db43`.
- Merge base: `05c41baa7a45b728d1722d69d5e55d5dc9e580b4`.
- Integration branch: `catalina/pr101-integration-20261111`.
- PR: https://github.com/DF-wu/lilac-mono/pull/101.
- Existing main and earlier resolution worktree remain untouched. Cancelled native handoff left a separate checkout with modified reference submodules; that checkout is untouched too.
- GitHub account: authorized fallback `DF-wu`; only that login is configured locally. Git author and committer: Catalina.
- No live service changes, runtime configuration or secret changes, live data migration, merge, or deployment are authorized. Disposable fixture servers and containers are used for verification.

## Execution plan

1. Refresh complete changed-path inventory and independently validate F01–F23 contracts against both pins. Record source ownership, disposition, behavior, regression checks, and limits for every feature and remaining path.
2. Merge the exact upstream target. Adopt upstream execution, resource, workflow, persistence, and memory owners. Retain narrow Telegram, provider compatibility, recording, authority, and operational adapters.
3. Resolve migration support through the historical offline migration baseline; do not restore removed startup migration machinery. Document backup, offline upgrade, support boundary, and rollback. Test disposable fixtures only.
4. Add regressions for actual integration gaps, run focused workspace tests and typechecks, schema generation, footprint, architecture, lint, format, builds, and full repository checks. Reproduce existing failures on pinned sources before classifying them.
5. Obtain independent Codex review of connected code at the exact candidate. Fix consequential findings and repeat affected checks. Record review conclusions in the PR.
6. Run `bun run check` before each commit. Commit coherent integration and documentation changes, verify the remote PR head has not changed, and push normally with `HEAD:automation/sync-upstream`. Update the PR with exact pins, final tested code commit, inventory, migration, validation, review, limits, and deployment gates. Leave it open.

## Evidence

The prior audit at `/home/df/workspace/lilac-fork-audit-20261111` is analysis, not implementation evidence. Fresh checks and source review are required. The target refs were refreshed and match those pins. The first merge produced 19 conflicted paths. Bounded read-only Codex exploration covers Telegram, providers/config/compaction, runtime/authority/recording, and delivery/migration/registrations.

## Current implementation checkpoint

All merge conflicts are resolved. Domain implementation and focused checks are complete.
Independent Core and delivery/provider reviews found Telegram control publication ordering,
restricted cross-client alias authorization, release verification after token-authenticated sync,
and stale current migration guidance. These have narrow fixes and regression evidence in REVIEW.md.
The native operator integration test now binds an ephemeral fixture port through the real Bun
listener boundary; production operator configuration stays unchanged.

Bun 1.4.4 is installed in a task-local toolchain. Full checks use a disposable init-managed
container, the exact candidate bind mount, a clean image home, current Git metadata, Docker access
only for the suite's disposable Redis fixture, and an explicitly configured fixture Redis URL.
The container's production-only backend-socket environment setting is cleared for tests.
Host failures were reproduced against pinned upstream: the operator fixture's fixed port was
occupied, and host-global prompt/skill overlays exceeded a small compaction fixture budget.
The compaction test passes unchanged in the clean container; no budget change was retained.
Earlier container attempts without init, socket normalization or Docker CLI produced environment
failures and are not passing evidence. Final required check result remains to be recorded.

Web production build and local linux-x64 installer build passed. Historical offline suites and
supplemental byte-integrity fixtures passed. Three identity smoke images passed on the earlier
frozen context; a final candidate rebuild and exact final commit verification remain outstanding.
