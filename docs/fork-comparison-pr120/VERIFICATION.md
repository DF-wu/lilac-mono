# PR #120 integration and follow-up verification

This record distinguishes the fork baseline F, upstream input U, first published integration C1,
and current integration tree C. It describes source and fixture checks, not deployment or live-provider traffic.
The [English guide](../fork-differences.md), [Traditional Chinese guide](../fork-differences.zh-TW.md),
[complete path ledger](PATH-INVENTORY.md) and [JSON inventory](inventory.json) describe the same C.

## Immutable inputs and current tree

| Role | Identity |
| --- | --- |
| Fork main F, including PR #121 | `4d8c0a8d799fcacd8aa51ca7613f48d7bb3f2327` |
| Upstream / PR #120 U | `7613d519643005ee4574c085a534c74af9508f88` |
| Common ancestor B | `90d71dbe9a2a86d8b0a39513e9eb67d65eb93683` |
| First published merge C1 | [`3292b12b99992aa648b28aa2b00252098aeb4663`](https://github.com/DF-wu/lilac-mono/commit/3292b12b99992aa648b28aa2b00252098aeb4663), with parents F and U |
| Previous published follow-up E | [`e2750297a144344ab67c490ef5bf9a417decba39`](https://github.com/DF-wu/lilac-mono/commit/e2750297a144344ab67c490ef5bf9a417decba39); [all six hosted jobs passed](https://github.com/DF-wu/lilac-mono/actions/runs/44930917729) |
| Published job-cleanup follow-up J | [`677e56956fc6e7cec8927e28f3a4a5d6c55ca381`](https://github.com/DF-wu/lilac-mono/commit/677e56956fc6e7cec8927e28f3a4a5d6c55ca381); [all six hosted jobs passed](https://github.com/DF-wu/lilac-mono/actions/runs/44933469954) |
| Current integration C | Content fingerprint and complete path/mode records in the generated ledger; on a clean committed checkout, `--candidate HEAD --check` verifies that commit's tree |

C1 passed `bun run check`: 8,309 Bun and 14 Rust tests, zero failures and 13 existing optional skips.
Its [first hosted CI run](https://github.com/DF-wu/lilac-mono/actions/runs/44926179978) passed all six jobs.
Those are historical C1 results, not a substitute for checking the follow-up tree.
The original one-file conflict in `apps/core/tests/tools/web.test.ts` still retains both parents' tests.
The current changes preserve PR #121, Telegram authority, provider routes, search-only versus extract,
30-second OpenAI/compatible search attempts, 10-second other built-in attempts, one retry, status semantics,
caller cancellation and configured fallback. No provider network traffic or submodule access is needed.

## Review 6006774479: every finding

Findings were checked against C1 source; reviewer text was treated as data.
The eight inline discussion IDs below identify dispositions that can be resolved after current-head verification.
Outside-diff and unverified findings belong to the [review body](https://github.com/DF-wu/lilac-mono/pull/120#pullrequestreview-6006774479).
No review state or comment was changed as part of the engineering work.

| Finding / identifier | Disposition and concrete evidence |
| --- | --- |
| Failure-publication queue drain, [4653838788](https://github.com/DF-wu/lilac-mono/pull/120#discussion_r4653838788) | Fixed. Nonfatal failed-event publication still schedules the next queue drain; the broken request is not terminalized or reported settled when publication fails. `fails recovered work and drains after rejected failure publication` covers both publication outcomes. Panic retains fatal handling. |
| Marked predecessor fallback, [4653838792](https://github.com/DF-wu/lilac-mono/pull/120#discussion_r4653838792) | Fixed. A repaired head tries only a marked predecessor; unreadable or unmarked predecessors fail closed. Four `keeps repair consumed on unavailable checkpoint` cases cover ordinary fallback, repaired/unmarked rejection, readable marked promotion, and unreadable marked rejection. The readable case checks one promotion and the persisted consumed marker after settlement. |
| Native heartbeat overlays, [4653838798](https://github.com/DF-wu/lilac-mono/pull/120#discussion_r4653838798) | Fixed in the native model projection only. `native prompts remove prior heartbeat overlays` tests both enabled and disabled heartbeat, retains previous answer text and verifies fresh current source identity only when enabled. Original stored messages are not rewritten. The separate Discord lineage suite remains included in the focused run. |
| Suppression persistence failure, [4653838802](https://github.com/DF-wu/lilac-mono/pull/120#discussion_r4653838802) | Fixed. Job listing, suppression and remaining-active checks return Results. Live rewind and restart recovery both keep mutationPending on failure. Retry reselects still-pending matching events; repeated success is idempotent. Native and job-service regressions exercise partial failure and retry. |
| Post-send attachment Undo, [4653838803](https://github.com/DF-wu/lilac-mono/pull/120#discussion_r4653838803) | Fixed. Existing attachment synchronization associates outgoing reference records with undo atoms before silent clear. The real ComposerEditor browser fixture reproduces failure before the fix and passes post-send Undo, rewind Undo and attachment sendability afterwards. No editor-history reset or new state store. |
| Omitted staged gitlinks, [4653838809](https://github.com/DF-wu/lilac-mono/pull/120#discussion_r4653838809) | Fixed by rejection. Snapshot capture compares real-index gitlink paths/modes/OIDs against the verified HEAD before excluding ref. A disposable-index changed-gitlink case is rejected; unchanged post-merge capture passes without opening submodules or changing the real index. |
| Stale candidate status / commands, [4653838811](https://github.com/DF-wu/lilac-mono/pull/120#discussion_r4653838811) | Fixed in both guides and ledger. C1 is a committed/published two-parent merge. C is the current content snapshot, with a separate C1-to-C comparison. Clean committed checkouts use `--candidate HEAD --check`; edited follow-ups use the supported temporary-index worktree mode. |
| Rewind blockers documentation, [4653838812](https://github.com/DF-wu/lilac-mono/pull/120#discussion_r4653838812) | Fixed in [native operations](../native-surface.md#permanent-direct-conversation). Existing blockers are retained; cancellation in progress and undelivered external sends are listed even when no external message is visible or the originating request settled. Store policy is unchanged. |
| Outside diff: request ownership, `execution.ts:806-811`, review marker `02bd5697379752bbaafcffd3` | Fixed without a new stored contract. The existing receipt identifies the target; retained cancelled full-input records identify discarded request owners. Service jobs belonging to retained turns survive even when created after a queued discarded input. Job-service tests cover retained active jobs and pending events with overlapping timestamps. Native ownership tests exclude retained steering and exercise restart recovery. |
| Outside diff: canonical predecessor trim, `execution.ts:194-195`, marker `f218666d4a7b616670c9fd1e` | Fixed. Prove and trim predecessor history to the canonical start before appending it. The new mixed full/turn-row regression originally lost the entire non-DM prefix; it now retains the expected fourth-turn pair. Existing full/turn/mixed, compaction, repaired-prefix and DM tests remain included. Missing boundary proof retains the empty fallback. |
| Outside diff: superseded receipt, `execution.ts:838-839`, marker `90cb15b42d0fce4ebc53650b` | Fixed. Receipt generation must equal the current thread generation before returning its draft. The two-rewind regression rejects the old receipt; same-generation lost-response replay and later active-run preservation still pass. |
| Explicitly unverified cancellation note, `execution.ts:776`, marker `061a78af57cc66efcf77b73e` | Confirmed by the actual runner: C1 returned from queued rejection before calling activeRun.cancel or awaiting sessionDrainOperations. Fixed at the runner owner: accumulate the rejection failure, cancel the active run, await its drain, then return the original error. `drains the active native run even when queued rejection fails` uses a real runner, observes its abort before return and checks the rejection cause. The existing overlapping-cancellation execution case remains covered; the execution kick is safe because runner errors now follow the drain. |

## Receipt compatibility and safe failure

Rewind receipts, input records and database schemas are unchanged. Recovery requires exactly one matching
receipt and one retained cancelled full-input target from an older generation. Monotonic input positions,
request IDs, cancelled state and absence of a retained turn identify the discarded full requests;
steering records never become owners of a retained run's jobs. Job selection is by session and request
ownership for both await and service jobs, including active stopping, terminal persistence and pending
event suppression. It never uses input or job creation timestamps.

A legacy receipt with a missing/ambiguous target record cannot prove ownership. Recovery returns
`Rewind job ownership is unavailable` and leaves mutationPending set. It does not stop retained jobs or
clear the mutation by guessing. The regression deletes the target record from a local fixture and proves
this behavior. Transient job-store errors likewise leave the existing mutation eligible for retry.
No new queue, journal, recovery worker, persisted field or migration was added. Deletion retains its existing
whole-session cleanup path. These are operational failure results, not an automatic repair of corrupt state.

## Exact comparison and reproduction

| Comparison | Paths / statuses |
| --- | --- |
| B → F | 371: 160 A / 207 M / 4 D |
| B → U | 147: 26 A / 121 M |
| U → F | 494: 160 A / 304 M / 30 D |
| F → C | 161: 31 A / 130 M |
| U → C | 388: 165 A / 219 M / 4 D |
| Combined union | 503 paths; C1 → C is independently recorded in the ledger |
| Complete candidate tree | 2,263 paths: 2,248 mode 100644, seven 100755, one 120000, seven 160000 |
| Exact pinned footprint | 223 covered, zero unlisted, zero stale |

All seven gitlinks and `.gitmodules` remain unchanged at B/F/U/C1/C. No submodule was fetched,
initialized or opened. The four U-to-C deletions remain historical previous-release fixtures.
The production footprint checker and original fixture remain unchanged from F. Its merge-base semantics
exclude incoming upstream work the fork has not taken. Since C1 and its follow-ups contain U, the normal
strict gate against pinned U now compares exactly U to C. CI must also run against its actual fetched refs.

```sh
# Edited follow-up checkout: HEAD must contain both F and U.
python3 -B docs/fork-comparison-pr120/reproduce.py --candidate-worktree
python3 -B docs/fork-comparison-pr120/reproduce.py --candidate-worktree --check
# Clean committed checkout: verifies the actual commit tree, before or after push.
python3 -B docs/fork-comparison-pr120/reproduce.py --candidate HEAD --check
bun run fork:footprint -- --upstream=7613d519643005ee4574c085a534c74af9508f88 --strict
git diff --check
git diff --cached --check
```

Worktree mode validates F/U ancestry, starts a temporary GIT_INDEX_FILE at verified HEAD, rejects
unmerged entries and differing staged gitlinks, and snapshots nonignored source/docs without entering ref.
The original HEAD=F / MERGE_HEAD=U mode remains supported. Explicit temporary-index tree input is also
accepted on a validated integration checkout. No synthetic commit is created. Commit input verifies both
pins as ancestors. The helper uses Python/Git and the existing local oxfmt, never downloaded tooling.
`--check` compares generated Markdown and JSON byte for byte.

All six comparison artifacts are included. PATH-INVENTORY.md, inventory.json and this record omit their
own candidate content hashes to avoid self-reference; presence/mode remain counted. The generator,
both guides and production/test code are fingerprinted normally. This is not a complete-tree release
attestation: verification prose still needs review. Generated output contains no transient tree OID,
checkout path, host name, timestamp or invented commit link.

## Earlier follow-up local verification (E)

The focused command covered native execution, job service, runner recovery, session queue, thinking/heartbeat
and Discord core-primary lineage:

```sh
bun run test:root -- ./apps/core/src/surface/native/execution.test.ts ./apps/core/tests/jobs/job-service.test.ts ./apps/core/tests/surface/bridge/bus-agent-runner-recovery.test.ts ./apps/core/tests/surface/bridge/bus-agent-runner-session-queue.test.ts ./apps/core/tests/surface/bridge/bus-agent-runner.test.ts ./apps/core/tests/surface/bridge/bus-agent-runner-core-primary.test.ts --only-failures
```

Result: **315 pass, zero fail, 1,389 assertions**, six files. `bun run typecheck:workspaces` passed.
A deliberately restored pre-fix runner branch stranded the next request during the red experiment and
required terminating that test process; this was not counted as a passing run. Stale-receipt and mixed
canonical-prefix regressions failed their expected assertions before the fixes. Browser post-send Undo
failed with a missing reference record before capture was added. Initial test-fixture type errors and a
flat-control-flow lint error were corrected; final gate results below supersede intermediate failures.

A fresh `bun run dev:web` fixture exercised real components with synthetic data. The reusable
[rewind browser fixture](../../apps/web/tests/support/rewind-regressions.js) returned three passes:
reference-only rewind Undo, reference-only post-send Undo and bounded failed-history-page retry.
Run `await (await import('/tests/support/rewind-regressions.js')).verifyRewindRegressions()` in the
fixture development browser. Browser checks require no live providers. Screenshots remain local verification artifacts rather than committed host paths. The real DM flow
uploaded a synthetic file, reloaded to obtain a reference-only draft, sent it, then used Undo; its chip
returned with Send enabled on desktop and mobile. No overflow or framework overlay appeared. Repeated
dev mounting/resizing emitted ResizeObserver-loop notifications and one Tiptap flushSync warning; these
did not block Undo and were not hidden. No numeric production performance claim is made.

The full gate first exposed the old native job-lifecycle fixture's placeholder job owner. It was
corrected to bind jobs to their actual retained/discarded requests while making their timestamps overlap.
`bun run test:root -- ./apps/core/tests/surface/native/job-lifecycle.test.ts --only-failures` then passed
**9 tests / 23 assertions**. This corrects the fixture's ownership model; production selection was not relaxed.
The initial combined command ended with exit 143 after that failure; it is not counted as a successful run.

## Previous published combined-tree checks (E)

`PATH="$HOME/.cargo/bin:$PATH" RUSTUP_TOOLCHAIN=1.94.1 bun run check` completed with **exit 0**:
**8,321 Bun tests plus 14 Rust tests passed, zero failures, 13 existing optional skips**.
This includes all generated-code checks, lint/architecture/production syntax, custom-media source/bundle
checks, workspace and extra typechecks, formatting, 820 web tests and 114 architecture tests.
`bun run build:web` also passed; the existing large-chunk warning remains.
Bun was 1.4.5 (manifest 1.4.4); the explicitly selected already-installed Cargo/Rust was 1.94.1.
No toolchain installation, host configuration change, or check bypass was required.

The complete source and six comparison artifacts were present for this check; final verification-result
prose was filled from actual output afterwards and is one of the deliberate evidence-hash exclusions.
Byte-for-byte regeneration, raw Git status/mode comparison, strict pinned footprint, baseline preservation,
relative links/anchors, privacy scan and whitespace were rerun after filling it. The generator snapshot
checks include unchanged real-index bytes and a changed gitlink rejected through a disposable index.
All 500 C1 ledger rows retain their exact B/F/U objects and statuses; current extra rows are explicit.
These are E's historical results. The current narrow job-cleanup result follows below; hosted CI must
run on its actual PR head.

## Review 6007059282: published job-cleanup follow-up J

Both findings were confirmed against E's actual spawn/supervise/finish/stop flow.

| Finding | Disposition and regression evidence |
| --- | --- |
| [Inline 4654109469](https://github.com/DF-wu/lilac-mono/pull/120#discussion_r4654109469): discarded pending await output | Fixed. `stopSessionRequests` stops active service jobs as before, but selects pending events by request ownership independently of mode. The focused regression proves discarded completed await output is suppressed, retained output stays pending, and `pendingEvents` exposes only the retained owner's output. The real native rewind RPC exercises the same behavior. |
| [Outside-diff major](https://github.com/DF-wu/lilac-mono/pull/120#pullrequestreview-6007059282), marker `5ceea67609e6c28bd9cc675f`: completion-write failure | Fixed. The existing in-memory running record retains its exact observed terminal result after process exit and bounded stream cleanup until `finish` succeeds. Rewind retries that existing compare-and-transition, propagates write errors, and cannot release an active process. Tests stop a real process with SIGSTOP, prove cleanup still waits with no finish write, resume it, inject SQLITE_BUSY, and verify the same observed status/reason/output is persisted on retry. A competing terminal transition wins without overwrite; repeated cleanup is idempotent and retained jobs stay active. The real rewind RPC keeps mutationPending after failure and completes the same command after retry. |

No storage schema, journal, startup reconciliation, timeout setting or provider policy changed.
The supervisor alone establishes the terminal outcome. Retry does not infer process death from an absent
map entry, signal a settled PID, or synthesize an exit result. Unowned active rows keep the existing
ACTIVE_JOBS guard. Close still leaves interrupted live jobs for existing restart reconciliation, and skips
signalling already-settled records. The store retains its existing successful-write-time `ended_at` semantics.

Focused red command before the production fix:

```sh
bun run test:root -- ./apps/core/tests/jobs/job-service.test.ts -t 'pending await output|observed completion' --only-failures
```

Result: **0 pass, 3 fail**, with the discarded await event still pending and the two completion cases
returning ACTIVE_JOBS instead of the transient finish error. After the fix: **3 pass, zero fail,
30 assertions**. An initial fixture used a non-newline output marker that the sanitizer buffered and
hit the test deadline; using a newline made readiness observable. That fixture failure is not counted as
regression proof or as a successful check.

```sh
bun run test:root -- ./apps/core/tests/jobs/job-service.test.ts ./apps/core/tests/surface/native/job-lifecycle.test.ts ./apps/core/src/surface/native/execution.test.ts --only-failures
```

J focused result: **117 pass, zero fail, 450 assertions** across three files, including the existing
native execution/recovery cases. No web code or rendered interaction changed in this narrow follow-up;
the earlier browser evidence remains historical E evidence.

J passed `PATH="$HOME/.cargo/bin:$PATH" RUSTUP_TOOLCHAIN=1.94.1 bun run check`
with **exit 0: 8,325 Bun tests and 14 Rust tests passed, zero failures, 13 existing optional skips**.
This includes Core/web/provider suites, all workspace and extra typechecks, architecture and production
syntax, generated-code checks, formatting and the normal external plugin checks. No check was bypassed.
Bun 1.4.5 and the already-installed Rust/Cargo 1.94.1 were used, as for E; no host configuration changed.

The exact pinned strict footprint remains **223 covered, zero unlisted, zero stale**. All 503 ledger paths
and complete-tree mode counts match independent Git comparisons; the nine changed files from E are
limited to JobService, its focused/native tests, the affected comparison evidence and footprint reasons.
Byte-for-byte worktree/tree-input reproduction, 694 relative links/anchors, private-artifact scans and
whitespace passed. Verification-result prose was filled from actual output after the gate and is one of
the existing evidence-content hash exclusions. Reproduction is checked again before and after commit.
All B/F/U/C1 object/status evidence is preserved. New hosted CI must validate the actual follow-up head;
E's six successful jobs are historical evidence, not a result for changed code.

## Review 6007211581: await and restart contract audit

Both findings were reproduced against J and fixed in the JobService owner.

| Finding | Disposition |
| --- | --- |
| [4654241440](https://github.com/DF-wu/lilac-mono/pull/120#discussion_r4654241440): await rows bypass active cleanup | Fixed. Active selection and the remaining-active guard now cover every discarded request's await and service rows. Observed await outcomes receive the same persistence retry as service outcomes; a current process must finish supervision before success. The real rewind RPC test injects an await completion-write failure, checks mutationPending, retries the same command, verifies the actual exited/zero outcome, and proves no discarded output reaches the next model call. |
| [4654241445](https://github.com/DF-wu/lilac-mono/pull/120#discussion_r4654241445): restart finish failure blocks rewind | Fixed for proven pre-startup records. A synchronous active-ID snapshot at service construction fences all restart-lost classification. Both the normal sweep and targeted cleanup use the existing PID/start-tick check and active-only finish transition. Failed writes retain eligibility for retry. Cleanup touches only the requested owners/session; it never runs a global sweep. New reservations and spawn/register gaps are excluded from the startup set, regardless of running-map registration. |

The snapshot is process-local ownership evidence, not a new stored journal, schema, worker or knob.
A successful finish removes its ID from the retry set. A competing terminal transition is never overwritten.
The old lost/core_restart/pending classification, process identity check, existing output metadata and
successful-write-time ended_at semantics remain. Current observed outcomes take priority over restart
classification. There is no time cutoff and no inference of death from a missing map entry.

If the **initial constructor snapshot itself fails**, no pre-startup ID can be proved. Unclassified active
rows remain ACTIVE_JOBS and rewind stays pending until a successful new service startup can capture them.
A later sweep cannot adopt arbitrary rows, because they may be new reservations. This is the deliberate
fail-closed limitation required by ownership safety; confirmed current jobs still stop and persist normally.
A later sweep-enumeration failure after a successful initial snapshot is retryable through targeted cleanup.
No new product or persistent-data decision is required for these rules.

The contract audit checked the combinations together:

| Combination | Required result and evidence |
| --- | --- |
| Retained await/service, active or pending | Unchanged by discarded-owner cleanup. Mode matrix and pending-output tests preserve rows/events; startup retry compares the retained row byte for byte before/after the targeted operation. |
| Discarded await/service, current process active | Stop and await supervision; never finish early. SIGSTOP/SIGCONT tests prove no finish write while the process remains active. |
| Observed terminal result, transient write failure | Return the store failure, retain mutationPending, retry the same status/reason/output and preserve a competing terminal winner. Four mode/terminal-winner cases exercise this path. |
| Confirmed pre-startup row, failed later enumeration or finish | Retain startup-ID eligibility; retry only the selected predecessor job as lost, suppress its event, and leave retained/new current jobs unchanged. Four mode/failure-phase cases exercise this path. |
| Failed initial snapshot / unconfirmed record | Keep the row active and mutation pending, create no lost event, and continue to handle confirmed current jobs normally. Both modes are tested. |
| Reservation created after startup / spawn before map registration | Never classify it as lost. A direct reservation and a real markRunning registration seam retain the starting/running row and live process with no pending event. |
| Wake during pending rewind / next run after retry | Native deliverJobWake returns unavailable without model publication while mutationPending. After successful retry, pendingEvents is empty and the next real RPC prompt contains neither discarded await output nor the held wake. |
| Missing native receipt ownership | Existing native execution tests still fail closed before job cleanup; this change does not widen receipt/request authorization. |

Focused red/green command:

```sh
bun run test:root -- ./apps/core/tests/jobs/job-service.test.ts -t 'observed.*completion|startup' --only-failures
```

Before the fix: **2 pass, 9 fail**. After the fix: **11 pass, zero fail, 91 assertions** at that point.
The final expanded owner/snapshot assertions are included in the complete focused run below.

```sh
bun run test:root -- ./apps/core/tests/jobs/job-service.test.ts ./apps/core/tests/surface/native/job-lifecycle.test.ts ./apps/core/src/surface/native/execution.test.ts --only-failures
```

Result on the final source: **127 pass, zero fail, 529 assertions** across three files. No live provider
traffic was used. The first full check found two TS2339 errors in new test assertions that read `code`
from the broader JobStoreError union. Those assertions now match the expected error shape without
accessing an unproved property. That failed check is not counted as a successful gate.

The final tree passed `PATH="$HOME/.cargo/bin:$PATH" RUSTUP_TOOLCHAIN=1.94.1 bun run check`
with **exit 0: 8,335 Bun tests and 14 Rust tests passed, zero failures, 13 existing optional skips**,
using Bun 1.4.5 and Rust 1.94.1. This includes all workspace and extra typechecks, architecture and
production syntax, generated-code checks, formatting, provider/web suites and normal external plugin
checks. No check was bypassed. J's six successful hosted jobs remain historical evidence; hosted CI must
run on the new commit. No web code changed, so previous browser evidence is not counted as a new browser
run for this source-only repair.

The regenerated full ledger reproduces byte for byte using `--candidate-worktree --check`; publication
verification repeats it using `--candidate HEAD --check`. The independent pinned-U MDT set exactly matches
all **223** policy rows; the unchanged strict gate reports **zero unlisted and zero stale**. All 503
historical baseline objects/statuses and seven gitlinks remain unchanged. The 2,263-path candidate tree,
694 relative link targets, six comparison artifacts' private-pattern scan and whitespace checks pass.
The content fingerprint in the ledger excludes only the three documented evidence outputs' contents;
their presence and modes remain included. Verification prose is reviewed separately from that fingerprint.

## Remaining limits

Exa SDK transport cancellation remains the separately accepted open finding and is unchanged in this
follow-up. The existing wrapper cancels tool waiting; exa-js 2.11.0 has no supported request-signal API,
so its HTTP request can remain in flight. No provider inference, deployment or new release was exercised.
Optional container/installer/real-S3 cases remain subject to their normal repository mechanisms.
No essential repair requires a new product or stored-data decision; missing legacy ownership deliberately
fails closed rather than broadening cleanup to retained jobs.
