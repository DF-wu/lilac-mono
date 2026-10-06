# Current-input compaction implementation plan

**Goal / spec:** Independently fix https://github.com/DF-wu/lilac-mono/issues/80.

**Architecture:** Apply the existing protected-current-input boundary during threshold compaction preflight, before announcing or starting compaction. Preserve canonical transcript, current input and real overflow errors. Provider image transmission is independently tracked in #79 and another branch.

**Tech stack:** Bun 1.4.2, existing AI SDK agent and compaction pipeline.

**Constraints:** No new dependencies, configuration, persisted data, or production changes. Separate commits, branch pushes, PRs, and Codex review requests are authorized by the user on 2026-10-06. Preserve unrelated main-worktree modifications. Execute inline under existing authorization.

- [x] Add cases in `packages/agent/tests/auto-compaction.test.ts`: three completed tool rounds with high usage and current start=0 must complete without summary/transcript replacement; an older prefix still compacts while retaining current input; true overflow and malformed boundaries remain errors.
- [x] Run `bun run --filter=@stanley2058/lilac-agent test -- tests/auto-compaction.test.ts`; observe the original null-selection failure before implementation.
- [x] Move existing validated maximum suffix boundary resolution ahead of threshold preflight in `packages/agent/auto-compaction.ts`. Skip threshold compaction when either selected boundary or protected maximum boundary is zero; reuse validated boundary in compaction.
- [x] Rerun focused agent tests: all 59 pass.
- [x] Request read-only independent review of protected input, overflow and continuation semantics; no blocking findings.
- [x] Run `bun run check` on this isolated branch. Typechecks, static and architecture lanes pass; overall check fails on three baseline failures independently reproduced on clean origin/main (bash-safety codes, host skill discovery, native operator gateway).
- [x] Update #80 with final scope and evidence. Agent: 531 pass, 0 fail. Changes remain undeployed; final commit and PR verification follows.

## PR preparation (2026-10-06)

- User authorized separate commits, pushes, PRs, and Codex review requests.
- Fresh workspace suite: 531 pass / 0 fail using Bun 1.4.2.
- Independent pre-PR review found no blocking issues.
