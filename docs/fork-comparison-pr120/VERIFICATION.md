# Integrated PR #120 verification

This record describes the resolved integration candidate C in the [canonical comparison](../fork-differences.md). F remains the shipped Git baseline; C is locally verified and unpublished. It is not evidence of a deployment, hosted CI run or live-provider compatibility. Documentation preparation results from a separate baseline-only tree are not included in candidate pass/fail counts.

## Inputs and deliverables

| Input | Exact identity |
| --- | --- |
| Fork main F, including PR #121 | `4d8c0a8d799fcacd8aa51ca7613f48d7bb3f2327` |
| Upstream / PR #120 U | `7613d519643005ee4574c085a534c74af9508f88` |
| Common ancestor B | `90d71dbe9a2a86d8b0a39513e9eb67d65eb93683` |
| Candidate C | Content fingerprint and complete mode/path records in [PATH-INVENTORY.md](PATH-INVENTORY.md) and [inventory.json](inventory.json); no invented commit SHA |

The original merge had one textual conflict in `apps/core/tests/tools/web.test.ts`. Both parent test groups are retained. Core/web/provider fixes and reasons are listed in the [candidate repair table](../fork-differences.md#candidate-repair-delta-by-area). The integration has no unresolved index entries. F and U remain HEAD and MERGE_HEAD until publication; no commit, push, PR write or deployment is implied by this document.

The comparison deliverable consists of [English](../fork-differences.md), [Traditional Chinese](../fork-differences.zh-TW.md), [PATH-INVENTORY.md](PATH-INVENTORY.md), [inventory.json](inventory.json), [reproduce.py](reproduce.py) and this record. All six are inventoried as documentation artifacts. Three evidence files omit their own content hashes to avoid self-reference; their presence and modes remain counted. The generator and language guides are fingerprinted normally. The identity therefore is not a complete-tree release attestation.

## Candidate path and footprint verification

The generator independently compares each path/status mapping with Git's NUL-delimited `diff --name-only` and `--name-status --no-renames`; it records every A/M/D/T path, mode, blob or gitlink. Full tree counts are independent of the changed-path union. It rejects uncategorized paths and duplicate/empty policy reasons.

| Comparison | Paths and statuses |
| --- | --- |
| B → F | 371: 160 A / 207 M / 4 D |
| B → U | 147: 26 A / 121 M |
| U → F | 494: 160 A / 304 M / 30 D |
| F → C | 157: 31 A / 126 M |
| U → C | 384: 165 A / 215 M / 4 D |
| Combined union | 500 paths, including the six current comparison artifacts |
| Candidate complete tree | 2,263 paths: 2,248 regular 100644 files, seven 100755 executables, one 120000 symlink, seven 160000 gitlinks |
| Candidate exact footprint against U | 219 policy rows, 219 covered, zero unlisted, zero stale |

All seven gitlinks and `.gitmodules` match B/F/U/C. No submodule was fetched, initialized or read. The four U → C deletions are historical previous-release fixtures, not removal of current workflow APIs. The inventory names generated/schema/bundle artifacts separately.

The production checker and original fixture tests remain exactly as at F. Their merge-base semantics intentionally exclude upstream changes not yet incorporated by the fork, including newer upstream commits fetched by CI. Direct comparison with latest upstream would incorrectly attribute incoming changes to the fork.

During this uncommitted merge, the production CLI still uses B because HEAD=F. It is not the exact U → C check. Executing it now exits 1 with **217 allowed, 92 unlisted, 2 stale**: that is the expected comparison-stage mismatch, not a failure of the exact pinned candidate policy. No checker or allowlist relaxation was used to disguise it. The candidate check instead compares the candidate policy with exactly:

```sh
git diff --name-only --diff-filter=MDT --no-renames 7613d519643005ee4574c085a534c74af9508f88
```

Once a merge commit contains U, the normal gate against U has merge base U and is equivalent. Hosted CI must still run the unchanged gate against its actual fetched upstream ref; the pinned local comparison cannot predict a later ref or merge base. Fork additions are outside the footprint gate and remain fully accounted for by this inventory.

## Reproduction before and after publication

```sh
# Before commit: exact HEAD=F and MERGE_HEAD=U, all source/docs present.
python3 -B docs/fork-comparison-pr120/reproduce.py --candidate-worktree
python3 -B docs/fork-comparison-pr120/reproduce.py --candidate-worktree --check
# An explicitly computed temporary-index write-tree object is also accepted:
python3 -B docs/fork-comparison-pr120/reproduce.py --candidate <tree-object> --check
# After committing/publishing the same content, without changing the report:
python3 -B docs/fork-comparison-pr120/reproduce.py --candidate HEAD --check
bun run fork:footprint -- --upstream=<fetched-upstream-ref> --strict
```

Reproduction uses Python/Git and the repository's already-declared, locally installed oxfmt to produce JSON accepted by the format gate. Install the existing frozen dev dependencies first; the helper never downloads tools. Temporary-index mode starts at F, stages candidate content through a temporary `GIT_INDEX_FILE`, preserves ref gitlinks without entering them, and writes only ordinary Git tree/blob objects. It neither changes the real index nor creates a commit. It includes nonignored new files, so inspect Git status before capturing a candidate. Commit mode requires both F and U as ancestors. Its positive post-commit invocation cannot be exercised until such a candidate commit exists; no synthetic commit was made to claim that result. The existing ancestry checks are exercised by rejecting unintegrated HEAD. `--candidate HEAD` must reject the uncommitted F baseline; it is only a post-merge command. With no candidate argument the helper produces the immutable baseline ledger only, which does not match these combined outputs.

`--check` verifies both generated outputs byte for byte. They contain no transient tree OID, host name, checkout path or timestamp. The content fingerprint is stable across committing the same files because commit identity is not an input. Changing verification prose does not change that fingerprint, but still requires review; changing code, policy, generator or language guides requires regeneration.

## Integrated engineering evidence

These runs used the actual resolved integration, local/injected provider fixtures and fake clocks. No live provider inference was required.

| Command / check | Result |
| --- | --- |
| `bun run test:root -- ./apps/core/tests/tools/web.test.ts ./apps/core/tests/tools/web-search-openai.test.ts ./apps/core/tests/tools/web-search-openai-model.test.ts ./apps/core/tests/tools/web-search-firecrawl.test.ts ./apps/core/tests/tools/web-search-exa.test.ts` | 88 pass, zero fail, 279 assertions. Slow OpenAI route tests first failed at the old 10-second deadline. Final tests prove 20-second success, independent 30-second OpenAI attempts, 10-second other-provider attempts, one retry, exact timeout messages and early cancellation. |
| `bun run test:root -- ./apps/core/tests/agent/anthropic-thinking-recovery.test.ts ./apps/core/tests/surface/bridge/bus-agent-runner.test.ts -t 'repairs Anthropic\|attribution headers'` | 15 pass, zero fail, 151 assertions. Adjacent attribution and tool-ended repair cases failed before their fixes. Checkpoint assertions execute after settlement; newly generated signature is isolated. |
| `bun run test:root -- ./apps/core/src/surface/native/execution.test.ts` | 71 pass, zero fail, 277 assertions. Failed-overlap draining and recovery job-suppression tests first failed with no publication/suppression. |
| `bun run test:web -- tests/uploads.test.ts tests/cache.test.ts` | 56 pass, zero fail, 167 assertions after the final originating-draft-key assertion. Attachment-only listing, retained reservation retry and question-draft readiness failed before their fixes. |
| `bun run test:web` | 820 pass, zero fail, 3,915 assertions across 85 files in the engineering gate. |
| `bun run test:root -- ./apps/core/tests/tool-server-health-state.test.ts` | 18 pass, zero fail, 60 assertions. The dependency-streak fixture now disables its unrelated ambient main-isolate threshold; production and dedicated memory-limit behavior remain intact. |
| `bun run typecheck:workspaces` | All workspace typechecks passed on the resolved source. |
| `bun run lint:architecture` | Semantic gate passed; production syntax gate: zero errors. |
| `bun run test:all` | Full engineering run passed: 8,284 Bun tests plus 14 Rust tests at that point. The root set then had 39 tests before a subsequently removed checker fixture; this is an earlier run, not the combined-tree total below. |
| `bun run build:web` | Passed. Existing large Monaco/runtime chunk warnings; no build error. |
| `bun run check` before the comparison import | Passed: 8,310 Bun tests and 14 Rust tests, zero failures, 13 declared optional skips. That run included one checker fixture subsequently removed to restore CI semantics. The final combined-tree check is recorded below. |

The available Bun is 1.4.5; `packageManager` requests 1.4.4. The installed `1.94` rustup alias lacked Cargo despite listing the musl target, while system PATH selected Rust 1.100. Selecting the already installed patch release through `PATH="$HOME/.cargo/bin:$PATH" RUSTUP_TOOLCHAIN=1.94.1` allowed normal repository musl builds and Rust tests. No host/toolchain configuration was changed and no target or tool installation was needed. This difference is disclosed rather than hidden by a check bypass.

The first combined documentation run had all tests pass but exited 1 because plain Python JSON formatting differed from the repository formatter. The generator now formats through the existing local oxfmt, and byte-for-byte reproduction plus standalone `bun run fmt:check` pass. No formatting rule was disabled.

A full-worker health test once failed because real accumulated main-isolate memory crossed its default limit; its snapshot identified the memory alarm, not a dependency-streak defect. The fixture was isolated with the existing option and rerun. An intermediate browser-fixture format failure was also corrected. Those failures are not counted as passes; the final gate below supersedes them. The separate documentation-only preparation clone's missing dependencies or tooling were never candidate failures.

## Running-web checks

A fresh repository `bun run dev:web` fixture served synthetic data. Desktop and mobile checks verified:

- Real DM send, settle and rewind restore the original editable prompt.
- Reference-only attachment undo restores the attachment record and remains sendable.
- Rewind aborts a held message-paste download; completing it later does not change the restored draft.
- A held rewind keeps the composer disabled after navigating away and back, then restores editability on completion.
- One unchanged failed history-page request retries exactly once and restores availability.
- File viewer app.ts selection reveals the parent folder and highlights the file; download completed with the expected file name and 8,351 bytes.
- The standalone gallery DM demo disables busy rewind and restores the prompt in its available state; desktop and mobile layout/composer/sidebar interactions were inspected.

The reusable browser check [rewind-regressions.js](../../apps/web/tests/support/rewind-regressions.js) mounts the real component/hook, waits on DOM conditions, cleans up its roots and returns two passing results. Run it from the repository development browser:

```js
await (await import('/tests/support/rewind-regressions.js')).verifyRewindRegressions()
```

Screenshots were inspected during integration. Final app snapshots showed meaningful content, no framework error overlay and no relevant console errors. No numeric production performance baseline or provider-network claim is inferred from these checks. This documentation refresh does not change rendered UI behavior.

## Final combined-tree verification

The complete source plus these six refreshed artifacts is checked together. Repository checks use `PATH="$HOME/.cargo/bin:$PATH" RUSTUP_TOOLCHAIN=1.94.1 bun run check`; the final result is **exit 0**. This is the candidate tree, not the earlier documentation-only clone.

| Evidence check | Actual integrated result |
| --- | --- |
| Restored checker and original fixture | Both byte-identical to F; focused fixture suite: **4 pass, zero fail, 10 assertions**. |
| Exact pinned footprint using the existing policy parser/comparator | **219 covered, zero unlisted, zero stale**, against the exact worktree MDT set relative to U. |
| Raw Git working-tree status sets vs inventory | F → C: 157 paths (31 A / 126 M); U → C: 384 paths (165 A / 215 M / 4 D). Every path and status agrees independently of the generator. |
| Independent temporary-index tree | 2,263 paths, all mode/kind counts agree; seven unchanged gitlinks; real merge-index digest unchanged by snapshot generation. |
| Baseline preservation | All 494 original B/F/U object/status rows, fixed pins, baseline comparison counts, generated-artifact set and conflict ledger match the imported baseline evidence. |
| Worktree and explicit tree-input reproduction | Regeneration produced identical Markdown/JSON bytes; both `--candidate-worktree --check` and `--candidate <tree-object> --check` passed. |
| Generator helper cases | A/M/D/type/executable-mode classification, duplicate/empty policy rejection, evidence-content hash omission and unintegrated `--candidate HEAD` rejection passed without synthetic commits. |
| Documentation links and public object references | 681 relative links/anchors, three pinned GitHub SHA URL targets and 64 plain public commit references resolve locally. Seven gitlink OIDs are verified as tree entries only, without fetching their commits. |
| Private-artifact scan | Six artifacts contain no host checkout paths, loopback/private host names, fixture passwords, token-shaped credentials, private keys or internal thread links. |
| Whitespace | `git diff --check` and `git diff --cached --check` pass. |

Final combined `bun run check`: **8,309 Bun tests and 14 Rust tests passed, zero failures; 13 declared optional skips**. Core: 4,757 tests / 25,925 assertions. Web: 820 tests / 3,915 assertions. Root: 39 tests after restoring the original checker fixture. Architecture: 114 tests / 1,174 assertions. Generated-code checks, lint/semantic architecture/production syntax, custom-media source/bundle tests, all typechecks and formatting passed. The skips are the existing optional container, installer and real-S3 cases; no new skip was added.

Candidate content fingerprint: `a1f880156e222701be3fb687229c20bf56bd81325ea4c22be1f7a6ef92b8bd44`. The six comparison artifacts were present in the tested tree; the final verification-result prose was filled from actual output afterwards and is deliberately outside the fingerprint. Reproduction and whitespace were rechecked after filling it. Earlier engineering totals include the removed checker fixture and must not be substituted for this combined total.

The first exploratory link scan tried to resolve gitlink OIDs as locally present commits; the corrected check recognizes their Git-tree semantics and validates the entries without submodule access. No missing documentation link was found.

## Limits and remaining publication work

The candidate is uncommitted and unpublished. Hosted exact-commit CI, image/Docker smoke, dedicated e2e, real-S3 and deployment checks remain separate; optional suite skips are reported, not fabricated. Live provider traffic was not exercised.

The only deferred review finding is Exa transport cancellation: `exa-js@2.11.0` has no supported signal argument on its search/request APIs. The existing abort wrapper bounds tool waiting and caller cancellation; the underlying SDK request can remain in flight. Replacing or patching the dependency is a separate scoped decision, unnecessary for the verified caller-visible policy. A second consecutive history-page failure remains bounded at two automatic requests; existing Load more/reconnect/navigation can retry later.

No essential fix requires a new product or persistent-contract decision. Publication still requires its own approval and exact-commit verification. Preserve both pins, the complete ledger and the shipped-versus-candidate distinction when refreshing after publication.
