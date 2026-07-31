# Mini Lilac History Tree And Worktree Checkpoints

## Status

Agreed implementation plan.

This phase implements durable `/undo` and `/redo` for Mini Lilac. History storage is deliberately
modeled as an immutable tree of transcript/worktree states so a later phase can expose arbitrary
history checkout, fork from any state, and an undotree-style branch viewer without first replacing a
linear undo-stack schema.

The current phase does **not** add history-tree inspection or arbitrary navigation APIs. It only
builds the persistence and snapshot primitives they will need.

## Agreed Decisions

1. Every history state pairs exact model/UI transcript heads with either a managed-worktree checkpoint
   or an explicit unavailable/deferred workspace outcome.
2. History is an immutable rooted tree. Starting a prompt after undo creates a new branch; it does
   not delete the old forward branch.
3. `/undo` and `/redo` use a durable per-session navigation stack layered on the immutable tree.
   The stack is navigation state, not the history representation.
4. The `git` executable is required for worktree capture and restore, but the workspace itself does
   not need to be a Git repository.
5. If `git` is unavailable, history commands still move the transcript and report that worktree
   restoration was skipped.
6. If `git` exists but capture/restore fails, respond by phase: read-side capture failure never claims
   a snapshot or globally blocks the workspace; a possibly partial restore never moves transcript
   history and remains journal-blocked until verified startup recovery completes.
7. Git is only a private content-addressed object store. Mini Lilac never modifies the user's Git
   index, refs, branches, commits, stash, or reflog.
8. Snapshots honor workspace ignore rules. Ignored paths are outside the managed worktree and remain
   untouched during history navigation.
9. All nonignored files are eligible regardless of size. Do not copy OpenCode's 2 MiB untracked-file
   exclusion.
10. Multiple write-capable sessions may continue sharing one `cwd`. This remains intentionally
    unsafe: one session can capture or restore over another session's changes.
11. Todos, title, model/profile bindings, credentials, and other session metadata remain outside the
    history tree in this phase.
12. No automatic age, count, or byte retention policy is added in this phase. Every retained branch
    remains navigable; storage accounting and safe reference cleanup are included so policy can be
    added later.

## Goals

- Make `/undo` restore the transcript and managed worktree from immediately before the latest
  model-visible user message.
- Make `/redo` restore the exact transcript and managed worktree state captured by the corresponding
  undo, including managed manual edits that existed before undo.
- Support repeated undo and redo across root prompts and steering messages.
- Preserve alternate branches when the user sends a new prompt from an older state.
- Make undo/redo idempotent, durable across restart, and recoverable across crashes during restore.
- Work in both Git and non-Git directories whenever the `git` executable is available.
- Keep the user's repository metadata untouched.
- Deduplicate unchanged content and repeated file versions across states and sessions sharing the
  same canonical workspace.
- Establish a schema that can later list the complete history tree and navigate/fork from any state.

## Non-Goals

- A history-tree or undotree TUI.
- `/history`, `/checkout`, `/fork`, branch naming, branch deletion, or arbitrary state navigation.
- Merging history branches.
- Automatically reconciling sessions that concurrently mutate the same workspace.
- Undoing writes outside the session's canonical `cwd`.
- Capturing ignored files, Git metadata, empty directories, ownership, timestamps, ACLs, xattrs,
  hard-link identity, sockets, devices, or FIFOs.
- Sandboxing or terminating background processes launched by Bash.
- Rewinding todos, title, model/profile selection, auth, or provider state.
- A retention UI or configurable pruning policy.
- Compatibility with machines that have no Git for filesystem history; those machines get
  transcript-only navigation.

## Current State

Mini Lilac already has most of the transcript primitives but models navigation linearly:

- `transcript_nodes` are immutable per-session chains, and the same parent can already have multiple
  children. `session_transcript_heads` selects the current model/UI pair.
- `user_checkpoints` stores a pre-user-message transcript prefix keyed by linear `ui_position`.
- Root prompt admission writes a checkpoint in the same transaction as the run and command result in
  `SqliteStore.beginRootRun()`.
- Steering checkpoints are persisted when steering becomes canonical in
  `SessionActor.handleAgentEvent()`.
- `undoLatestUser()` deletes the selected and later checkpoints, moves transcript heads backward,
  and writes `runs.undone_at`.
- No filesystem preimage or snapshot is retained by `apply_patch`, `edit_file`, Bash, formatters, or
  subprocesses.

The relevant current code is:

- `packages/mini-lilac-runtime/src/sqlite-store.ts:593-633` -- transcript heads and checkpoints.
- `packages/mini-lilac-runtime/src/sqlite-store.ts:993-1048` -- root prompt admission.
- `packages/mini-lilac-runtime/src/sqlite-store.ts:1304-1340` -- steering checkpoint append.
- `packages/mini-lilac-runtime/src/sqlite-store.ts:1343-1455` -- destructive linear undo.
- `packages/mini-lilac-runtime/src/session-service.ts:1082-1235` -- prompt admission and execution.
- `packages/mini-lilac-runtime/src/session-service.ts:2164-2189,2311-2347` -- steering delivery.
- `packages/mini-lilac-runtime/src/session-service.ts:3031-3048` -- undo service.
- `apps/mini-lilac-tui/src/controller.ts:875-930` -- TUI undo and draft restoration.

The existing immutable transcript chains should remain. Replace `user_checkpoints` as the source of
history navigation rather than replacing transcript storage.

## Mental Model

### History state

A history state is an immutable, durable pair:

```text
HistoryState = {
  modelTranscriptHead,
  uiTranscriptHead,
  managedWorkspaceSnapshot | unavailable,
}
```

It records facts, not mutable lifecycle state. Two history states may point to the same transcript
heads and Git tree while remaining distinct positions in history.

### History transition

A transition connects one history state to one child state. This phase needs these kinds:

- `user-message`: one exact model-visible root or steering user message and the effects that followed
  it until the next user-message boundary or root-run termination.
- `workspace-observation`: managed files changed outside a recorded user transition, such as manual
  edits after a run and before undo or the next prompt.
- `compaction`: a transcript rewrite boundary. It is retained in the tree but remains an undo barrier
  for `/undo` in this phase.

Completed transitions form a rooted tree: each state has at most one incoming transition and any
number of outgoing transitions. Content identity does not merge state identities. A future merge
feature would need an explicit extension rather than silently turning this into a general graph.

### Open user transition

Immediately before a user message is handed to the provider, Mini Lilac first makes that message
canonical and opens its transition with a known `from_state_id` but no `to_state_id`. The provider is
invoked only after this commit. A crash after the commit but before provider delivery therefore leaves
a real user transition with no effects, not an ambiguous unrecorded delivery. The transition closes at
the next safe user-message boundary or when the root run terminalizes. Navigation is allowed only
while no transition is open.

### Session cursor

Every idle/error session selects one current history state. Its model/UI heads must equal
`session_transcript_heads`.

During an active run, the cursor remains at the last closed boundary while one user transition is
open and live transcript state advances. Finalization closes the transition and advances the cursor.

### Redo stack

Redo is represented by a durable LIFO stack of target state IDs. It is intentionally separate from
the immutable tree:

- undo pushes the exact state observed before moving backward;
- redo pops and restores that exact state;
- a new user message clears the redo stack but retains every target state and branch;
- a future arbitrary checkout can replace the stack without changing history records.

This gives conventional full-state undo/redo now while preserving an undotree later.

## Core Invariants

1. A completed history state is immutable.
2. A completed transition's endpoints and user message are immutable.
3. Every non-root state has exactly one incoming completed transition.
4. A session has at most one open `user-message` transition.
5. An idle/error session's selected history state's transcript heads equal the canonical session
   transcript heads.
6. A captured workspace snapshot is rooted in the private Git store for as long as any history state
   or pending operation references it.
7. Transcript movement occurs only after the target worktree restore is complete and verified, unless
   the operation explicitly degrades because Git or the target snapshot is unavailable.
8. Operational Git failures never silently degrade to transcript-only navigation.
9. Ignored and protected paths are never removed merely because they are absent from a target tree.
10. A command retry with the same command ID returns the original result and never creates another
    history transition or navigation entry.
11. A new prompt clears redo navigation only. It never deletes immutable history states or branches.
12. A retained restore operation, pending finalization boundary, or unhealthy workspace prevents
    conflicting capture/restore/admission/GC work for that workspace until recovery completes. The
    journal owner may perform its own capture or recovery work.

## User-Visible Semantics

### Undo

For a visible history ending in user transitions `A`, `B`, and `C`:

```text
root -> A -> B -> C  (current)
```

`/undo`:

1. Captures any managed workspace drift since `C` into an observation state using the normal warm
   capture path.
2. Pushes that captured current state onto the redo stack.
3. Finds the latest applied `user-message` transition without crossing the undo floor.
4. Restores its `from_state` transcript and managed worktree.
5. Returns the removed user message so the TUI can restore it as a draft.

Repeated undo applies the same operation to `B`, then `A`.

### Redo

`/redo` pops the latest target from the redo stack and restores that state's transcript and managed
worktree. It does not recompute the state by replaying patches or model calls.

If the user changed a nonignored file after undo, redo discards that change by restoring the saved
target state. The pre-redo drift is first captured as an observation state so the immutable tree does
not lose it, although this phase exposes no command for returning to that state after redo.

### Branching after undo

Starting a prompt after undo clears the redo navigation stack and creates a child transition from the
currently selected historical state:

```text
root -> A -> B -> C
             \
              D  (current)
```

`C` remains fully retained. `/redo` at `D` returns `empty` because no redo navigation entry exists.
A future tree viewer can show both `C` and `D`, and a future checkout/fork command can select either.

### Empty operations

- `/undo` returns `empty` when no applied user transition exists above the current undo floor.
- `/redo` returns `empty` when the redo stack is empty.
- Empty operations do not capture a new workspace state or mutate command-independent history.

### Git unavailable

If the Git executable is unavailable during capture or navigation:

- transcript history still moves;
- the history state records `workspace_status = "unavailable"` and reason `git-unavailable` instead
  of a tree;
- the result reports `filesystem.status = "skipped"`;
- redo of that exact state is also transcript-only when no snapshot exists.

If Git later becomes available, new states can be captured normally. Historical states without a
tree cannot have their prior worktree reconstructed retroactively.

### Capture, snapshot, and restore failure

Failure behavior depends on whether the live worktree may be partially modified:

- prompt, undo, redo, or compaction preparation capture failure occurs before live-workspace writes:
  fail that command, leave cursor/transcript/workspace health unchanged, and permit later
  retries/admissions;
- terminal capture failure records an unavailable `capture-failed` destination and warning rather
  than preventing an already-finished run from terminalizing;
- a retained snapshot whose ref/object is missing or corrupt is marked locally unavailable; new
  captures and unrelated states continue, while navigation to it reports transcript-only
  `snapshot-unavailable` with an explicit warning;
- restore preflight failure before writes moves neither transcript nor cursor, fails the command, and
  does not block unrelated workspace activity;
- once a restore-mode operation enters `restoring`, any materialization/verification/permission/disk
  failure retains the journal and blocks every Mini Lilac session sharing the workspace because files
  may be torn;
- verification retries are bounded and never spin indefinitely against a background writer.

Once a navigation journal is durable, automatic recovery always rolls forward to its
`target_state_id`; it never silently deletes the journal, restores the source instead, or changes
`restore` into `skip`. A crash during `/undo` or `/redo` may therefore finish that requested operation
on the next startup before the server accepts commands.

Phase-one recovery is automatic and runs before admissions. The operator surface is limited to
read-only status and explicit abandonment; interactive repair tooling is deferred.

## Database Schema

Bump `MINI_LILAC_DATABASE_SCHEMA_VERSION` and replace linear checkpoint navigation with the following
logical schema. Exact migration version numbers should use the next available version when
implementation starts.

### `history_store_metadata`

```sql
CREATE TABLE history_store_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  namespace_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Generate `namespace_id` once. Derive the on-disk store namespace from both this value and the
canonical database path. The private store contains an ownership marker with both values. This keeps
custom database paths and copied databases from silently sharing refs or garbage-collecting each
other's objects.

### `workspaces`

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  canonical_cwd TEXT NOT NULL UNIQUE,
  health_status TEXT NOT NULL DEFAULT 'healthy'
    CHECK(health_status IN ('healthy', 'corrupt')),
  health_detail TEXT,
  created_at TEXT NOT NULL
);
```

The ID is opaque and stable inside one Mini Lilac database. The private Git directory is derived from
the database identity plus workspace ID; do not persist an absolute snapshot-store path.

Sessions continue storing `cwd` for the public snapshot. Rebuild `sessions` with a non-null
`workspace_id` foreign key and `UNIQUE(id, workspace_id)`, then verify that the workspace's canonical
path equals `sessions.cwd`. SQLite cannot safely add this constrained non-null column in place; the
migration must rebuild the table and run `PRAGMA foreign_key_check` before advancing the schema
version.

Live journal rows and persistent health are separate authorities:

- a retained restore/navigation operation blocks every session sharing the workspace because live
  files may be torn;
- a pending finalization blocks conflicting capture/restore/admission/GC work only while preserving
  that exact boundary for completion/recovery;
- `health_status` is reserved for independent store ownership/integrity corruption, not mirrored for
  every live journal;
- an ordinary capture error with no retained journal does not permanently change workspace health;
- a missing historical snapshot marks that snapshot unavailable and makes navigation to it
  transcript-only with an explicit warning; it does not block new prompts or unrelated states.

### `workspace_snapshots`

```sql
CREATE TABLE workspace_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  root_tree_oid TEXT NOT NULL,
  git_ref TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  availability TEXT NOT NULL DEFAULT 'available'
    CHECK(availability IN ('available', 'missing', 'corrupt')),
  availability_detail TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(id, workspace_id),
  UNIQUE(workspace_id, git_ref),
  UNIQUE(workspace_id, root_tree_oid, format_version)
);
```

Ref namespaces are private per workspace store, so the same ref string/OID can validly occur across
workspaces; uniqueness is scoped to the workspace.

Rows are content records, not per-state copies. States with identical managed contents share one row
and one Git ref. Delete the row/ref only when no history state or pending operation references it.
Missing/corrupt historical objects update only this snapshot's availability. New captures and prompts
continue unless store ownership or broad integrity is independently compromised.

The `root_tree_oid` points to a synthetic wrapper tree containing:

```text
manifest.json  # version, managed-root metadata, empty policy
workspace/     # actual managed workspace tree
```

The wrapper avoids reserving a filename inside the user's workspace and leaves room for future
metadata versions.

### `history_states`

```sql
CREATE TABLE history_states (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  model_head_id INTEGER,
  model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
  ui_head_id INTEGER,
  ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
  workspace_snapshot_id TEXT,
  workspace_status TEXT NOT NULL CHECK(
    workspace_status IN ('captured', 'unavailable', 'capture-deferred')
  ),
  workspace_unavailable_reason TEXT CHECK(
    workspace_unavailable_reason IN (
      'git-unavailable', 'capture-failed', 'legacy-migration', 'platform-unsupported'
    )
  ),
  origin TEXT NOT NULL CHECK(
    origin IN ('root', 'turn-boundary', 'workspace-observation', 'compaction', 'migration')
  ),
  created_at TEXT NOT NULL,
  UNIQUE(id, session_id),
  UNIQUE(id, workspace_id),
  FOREIGN KEY(session_id, workspace_id)
    REFERENCES sessions(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_snapshot_id, workspace_id)
    REFERENCES workspace_snapshots(id, workspace_id),
  FOREIGN KEY(model_head_id, session_id, model_lane)
    REFERENCES transcript_nodes(id, session_id, lane),
  FOREIGN KEY(ui_head_id, session_id, ui_lane)
    REFERENCES transcript_nodes(id, session_id, lane),
  CHECK(
    (workspace_status = 'captured' AND workspace_snapshot_id IS NOT NULL
      AND workspace_unavailable_reason IS NULL) OR
    (workspace_status = 'unavailable' AND workspace_snapshot_id IS NULL
      AND workspace_unavailable_reason IS NOT NULL) OR
    (workspace_status = 'capture-deferred' AND workspace_snapshot_id IS NULL
      AND workspace_unavailable_reason IS NULL)
  )
);
```

Do not unique-deduplicate history states by their contents. Distinct state identities preserve
topology even when transcript and worktree values are identical.

### `history_transitions`

Rebuild/extend `runs` with `UNIQUE(id, session_id)` so transition and journal ownership can use
composite foreign keys.

```sql
CREATE TABLE history_transitions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  from_state_id TEXT NOT NULL,
  to_state_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('user-message', 'workspace-observation', 'compaction')),
  delivery TEXT CHECK(delivery IN ('prompt', 'steer')),
  command_id TEXT,
  user_message_json TEXT,
  root_run_id TEXT,
  replay_after_seq INTEGER CHECK(replay_after_seq IS NULL OR replay_after_seq >= 0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(id, session_id),
  UNIQUE(to_state_id),
  FOREIGN KEY(from_state_id, session_id) REFERENCES history_states(id, session_id),
  FOREIGN KEY(to_state_id, session_id) REFERENCES history_states(id, session_id),
  FOREIGN KEY(session_id, command_id) REFERENCES commands(session_id, command_id),
  FOREIGN KEY(root_run_id, session_id) REFERENCES runs(id, session_id),
  CHECK(
    (kind = 'user-message' AND delivery IS NOT NULL AND user_message_json IS NOT NULL
      AND root_run_id IS NOT NULL AND replay_after_seq IS NOT NULL) OR
    (kind != 'user-message' AND delivery IS NULL AND command_id IS NULL
      AND user_message_json IS NULL AND root_run_id IS NULL AND replay_after_seq IS NULL)
  ),
  CHECK(
    (to_state_id IS NULL AND completed_at IS NULL) OR
    (to_state_id IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CHECK(
    to_state_id IS NOT NULL OR kind = 'user-message'
  )
);

CREATE UNIQUE INDEX one_open_user_transition_per_session
  ON history_transitions(session_id) WHERE to_state_id IS NULL;
```

Validate `user_message_json` with `miniLilacUserUIMessageSchema` at every boundary.

The composite foreign keys keep endpoints in the same session, and `UNIQUE(to_state_id)` gives every
non-root state at most one parent. `session_history.root_state_id` identifies the one permitted root.
Store operations must validate that every completed non-root state is connected to that root and that
no cycle can be introduced before committing topology changes.

`command_id` links steering transitions to their admitted control command. Root prompt transitions
link to the prompt command. Observation/compaction transitions leave it null.

### `session_history`

```sql
CREATE TABLE session_history (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  root_state_id TEXT NOT NULL,
  current_state_id TEXT NOT NULL,
  undo_floor_state_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(root_state_id, session_id) REFERENCES history_states(id, session_id),
  FOREIGN KEY(current_state_id, session_id) REFERENCES history_states(id, session_id),
  FOREIGN KEY(undo_floor_state_id, session_id) REFERENCES history_states(id, session_id)
);
```

- `root_state_id` is the one state allowed to have no incoming transition.
- `current_state_id` is the selected transcript state.
- `undo_floor_state_id` prevents `/undo` crossing a compaction barrier while retaining older tree
  states for future explicit navigation.

Do not persist a claim that the workspace is currently synchronized. Concurrent sessions and external
processes can invalidate such a flag immediately. Correctness always recaptures before navigation and
verifies after restore.

### `history_redo_stack`

```sql
CREATE TABLE history_redo_stack (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  target_state_id TEXT NOT NULL,
  user_transition_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id, position),
  FOREIGN KEY(target_state_id, session_id) REFERENCES history_states(id, session_id),
  FOREIGN KEY(user_transition_id, session_id) REFERENCES history_transitions(id, session_id)
);
```

`user_transition_id` supplies the exact redone message identity. The target state may be a
descendant observation state rather than merely the user transition's `to_state`, preserving manual
managed edits observed immediately before undo.

### `history_operations`

```sql
CREATE TABLE history_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind = 'navigate'),
  requested_action TEXT NOT NULL CHECK(requested_action IN ('undo', 'redo')),
  source_state_id TEXT NOT NULL,
  observed_source_state_id TEXT,
  target_state_id TEXT NOT NULL,
  user_transition_id TEXT NOT NULL,
  filesystem_mode TEXT NOT NULL CHECK(filesystem_mode IN ('restore', 'skip')),
  skip_reason TEXT CHECK(
    skip_reason IN ('git-unavailable', 'snapshot-unavailable', 'platform-unsupported')
  ),
  phase TEXT NOT NULL CHECK(phase IN ('prepared', 'restoring', 'verified')),
  prepared_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id),
  FOREIGN KEY(session_id, workspace_id) REFERENCES sessions(id, workspace_id),
  FOREIGN KEY(session_id, command_id) REFERENCES commands(session_id, command_id),
  FOREIGN KEY(source_state_id, session_id) REFERENCES history_states(id, session_id),
  FOREIGN KEY(observed_source_state_id, session_id) REFERENCES history_states(id, session_id),
  FOREIGN KEY(target_state_id, session_id) REFERENCES history_states(id, session_id),
  FOREIGN KEY(user_transition_id, session_id) REFERENCES history_transitions(id, session_id),
  CHECK(
    (filesystem_mode = 'restore' AND skip_reason IS NULL) OR
    (filesystem_mode = 'skip' AND skip_reason IS NOT NULL)
  )
);
```

The database constrains one operation per workspace, which already subsumes one operation per session
because a session has one immutable workspace. A future `checkout` action can extend the journal in the
schema migration that introduces that action.

Any retained operation row makes the whole workspace unavailable for captures/admissions from other
sessions until recovery finishes. This is stricter than the agreed ordinary concurrency policy only
while a possibly partial restore exists.

### `pending_run_finalizations`

```sql
CREATE TABLE pending_run_finalizations (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  open_transition_id TEXT NOT NULL,
  model_head_id INTEGER,
  model_lane TEXT NOT NULL DEFAULT 'model' CHECK(model_lane = 'model'),
  ui_head_id INTEGER,
  ui_lane TEXT NOT NULL DEFAULT 'ui' CHECK(ui_lane = 'ui'),
  run_status TEXT NOT NULL CHECK(run_status IN ('completed', 'cancelled', 'error')),
  session_status TEXT NOT NULL CHECK(session_status IN ('idle', 'error')),
  error TEXT,
  terminal_result_json TEXT,
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  prepared_at TEXT NOT NULL,
  UNIQUE(workspace_id),
  UNIQUE(open_transition_id),
  FOREIGN KEY(session_id, workspace_id)
    REFERENCES sessions(id, workspace_id),
  FOREIGN KEY(run_id, session_id) REFERENCES runs(id, session_id),
  FOREIGN KEY(open_transition_id, session_id)
    REFERENCES history_transitions(id, session_id),
  FOREIGN KEY(model_head_id, session_id, model_lane)
    REFERENCES transcript_nodes(id, session_id, lane),
  FOREIGN KEY(ui_head_id, session_id, ui_lane)
    REFERENCES transcript_nodes(id, session_id, lane)
);
```

This table durably preserves final canonical transcript heads and terminal metadata before worktree
capture. After a crash, startup can retry capture and finish the exact intended terminalization instead
of falling back to the older admitted transcript. If read-side capture still fails, recovery closes the
same prepared terminal transcript with `capture-failed`; it does not lose the terminal facts or leave a
permanent workspace outage.

Ordinary queued steering commits directly into `history_states`/`history_transitions`. Capture and
steering-preparation failures use existing command, stream, status, and logging paths without altering
canonical transcript history.

### Query indexes

Add explicit indexes for expected hot/recovery queries:

```sql
CREATE INDEX sessions_workspace ON sessions(workspace_id);
CREATE INDEX history_states_session ON history_states(session_id);
CREATE INDEX history_states_workspace_snapshot ON history_states(workspace_snapshot_id);
CREATE INDEX history_transitions_from_state
  ON history_transitions(session_id, from_state_id);
CREATE INDEX history_transitions_root_run
  ON history_transitions(session_id, root_run_id);
```

The primary/uniqueness constraints already cover redo stack order, operations/finalizations by
workspace, open transitions, and transition destinations. Add more indexes only when an implemented
query requires them.

Transactional store validators must additionally require:

- every `root_run_id` belongs to the transition's session and has `parent_run_id IS NULL`;
- a destination state's `origin` matches its incoming transition kind;
- a pending finalization's run, open transition, session, workspace, statuses, and active session run
  identify one coherent terminalization;
- before inserting either journal in `BEGIN IMMEDIATE`, no navigation operation or pending
  finalization already exists for that workspace; the retained journal row itself is the temporary
  exclusion authority and may perform its own recovery work.

### Workspace exclusion protocol

Use one lock order everywhere: acquire the in-process workspace mutex, then inspect or mutate journal
rows in SQLite, then access the private Git store/worktree. Hold the mutex through capture/restore and
the SQLite commit that records the resulting boundary. Root prompt, steering, and compaction commits
must recheck both journal tables in their final `BEGIN IMMEDIATE` transaction. Finalization and
navigation preparation insert their own journal row only after cross-checking the other table; recovery
retains the same mutex until it deletes the row. GC uses the same mutex and refuses to run while either
journal exists. The existing process-wide database lock excludes another Mini Lilac process using the
same database.

### Existing `runs.undone_at`

`runs.undone_at` cannot remain the source of truth. One run may contain several steering transitions,
and the same run can exist on a retained but unselected branch.

- Stop using `undone_at IS NULL` in `getLatestRun()`.
- Split the overloaded query into `getActiveRootRun(sessionId)` and
  `getLatestSelectedRootRun(sessionId)`.
- `getActiveRootRun()` uses `sessions.active_run_id` plus active/root-run validation and remains the
  admission/cancel/control guard. During an active run the history cursor has not advanced and the open
  transition has no destination, so ancestry cannot answer this lifecycle question.
- `getLatestSelectedRootRun()` walks history ancestry from `session_history.current_state_id` to the
  nearest applicable `user-message` transition for terminal replay/history presentation.
- Keep `undone_at` as legacy data during migration or remove it in a later schema rebuild.
- Do not toggle a global run flag on undo/redo; branch selection belongs to `session_history`.

## Private Git Snapshot Store

### Location

Add a state path such as:

```text
~/.local/state/mini-lilac/workspace-history/<database-namespace>/<workspace-id>/objects.git
```

Add `workspaceHistoryDirectory` to `MiniLilacStatePaths`, initialize it with mode `0700`, pass it into
`SessionService`, and include it in `protectedToolPaths`. Prefer a location outside the managed
workspace; when a broad `cwd` contains the state directory, the protected-path policy must exclude it
from capture and restore. Write and verify an ownership marker containing the database namespace,
canonical database path hash, workspace ID, and canonical `cwd` before mutating a store.

### Isolation

Use two explicit Git execution profiles.

Private-store commands must:

- pass an explicit private `--git-dir`;
- never use the user's index or write into the user's `.git`;
- clear inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, object-directory/alternate, namespace,
  config-injection, replacement-object, and related repository-selection environment variables, then
  set `GIT_INDEX_FILE` only to Mini Lilac's private capture or wrapper index;
- disable system/global configuration where practical;
- disable hooks, clean/smudge filters, external diff drivers, credential helpers, and pagers;
- use literal/NUL-delimited paths rather than shell interpolation;
- execute without a shell;
- redact paths and command environment appropriately in logs.

Read-only source-repository classification commands are the narrow exception to private `--git-dir`:

- discover/use the enclosing source repository only for `ls-files`, `check-ignore`, and resolving the
  effective ignore context;
- set `GIT_OPTIONAL_LOCKS=0`, disable fsmonitor/maintenance/pagers/external diff, and never run
  `status`, `add`, `update-index`, checkout, or another command that can refresh/mutate the user index;
- keep literal/NUL-delimited repository-relative path scopes under canonical `cwd`;
- resolve ordinary source global excludes read-only, then pass the resolved file explicitly so the
  remainder of classification can use a controlled environment;
- snapshot source index/config metadata before and after Stage 0 tests and prove no logical or file
  mutation occurred.

Do not use source-repository alternates. A durable history state must remain readable if the user's
repository is deleted, rewritten, or garbage-collected.

### Capture implementation

Implement `WorkspaceHistoryStore` in a focused module such as
`packages/mini-lilac-runtime/src/workspace-history-store.ts`.

Use a hybrid private-index capture design. The persistent private index is a performance cache, while
Mini Lilac retains explicit control over managed-path classification, policy validation, durable
objects, and restore.

The private store contains at least:

```text
objects.git/
capture.index
wrapper.index
empty-hooks/
empty-config
empty-attributes
empty-excludes
ownership.json
temp/
```

Capture proceeds as follows:

1. Canonicalize and verify workspace/store ownership.
2. Enumerate path metadata without following symlinks and classify managed paths using the source
   repository/ignore policy below. The scanner validates special files, nested repositories,
   protected paths, and platform collisions but does not open every unchanged regular file.
3. Compare the classified set with the reusable private index. Remove entries that are now deleted,
   ignored-and-untracked, protected, or below a repository boundary.
4. Stage only validated new/changed paths using NUL-delimited literal pathspecs, `git add --force`, the
   private gitdir/worktree/index, and content-transform overrides. `--force` is safe only because Mini
   Lilac has already selected the managed set and source-tracked ignored files must remain managed.
5. Run `git write-tree`; Git's stat cache and cache-tree extension avoid rereading unchanged file
   payloads and rebuilding every directory tree.
6. Hash the small canonical manifest with `git hash-object -w --no-filters --stdin`.
7. Use a temporary wrapper index with `read-tree --empty`, `update-index --cacheinfo`, and
   `read-tree --prefix=workspace/` to build the synthetic wrapper tree.
8. Create/update a ref under `refs/mini-lilac/snapshots/` for the deduplicated snapshot row.
9. Verify the root with `git cat-file -e <oid>^{tree}` before returning it.

Do not copy the user's index or use source-object alternates. The first capture is self-contained and
must store every managed file's current bytes. The source repository is queried read-only only for
tracked/ignored classification.

The private Git configuration must disable automatic maintenance, fsmonitor, ignore-stat behavior,
autocrlf/safecrlf conversion, hooks, replace objects, and log/ref side effects. Install a
highest-precedence private attributes override that disables `text`, `crlf`, `eol`, `ident`, named
filters, and `working-tree-encoding`; test staged OIDs against `hash-object --no-filters` for attribute
and Git LFS cases. If the implementation cannot prove a Git version/configuration stores exact bytes,
fall back to `hash-object --no-filters` plus explicit `update-index --cacheinfo` for changed paths.

Warm capture intentionally provides Git-index-grade change detection rather than adversarial
byte-exact detection when a writer preserves every checked stat field. Never enable
`assume-unchanged`, skip-worktree, fsmonitor-valid, `core.ignoreStat`, or reduced stat checking. Rebuild
the index when its checksum, format, workspace identity, platform capabilities, or implementation
version changes. Post-restore verification always uses a fresh index/full hash rather than the warm
stat cache.

Throughout this plan, an "exact worktree state" means exact restoration of the bytes/modes recorded in
the resulting snapshot tree. Warm capture uses ordinary Git stat/racy-clean semantics.

Git loose objects store complete compressed file versions. Periodic repacking may delta-compress
similar versions, but correctness must not depend on delta compression.

### Capture performance validation

Stage 0 must demonstrate the hybrid behavior before session integration:

- warm no-op capture writes no blobs, returns the same OID, and reads effectively no regular-file
  payload bytes;
- one small edit reads that file, not the whole workspace;
- an unchanged multi-gigabyte file adds only stat traversal cost;
- source repository index, lockfiles, objects, refs, config, logs, and status remain unchanged.

Record benchmark observations for engineering reference only; phase one specifies behavioral rather
than hardware-specific latency, throughput, or memory requirements.

### Ignore policy

The managed set is:

- for a workspace inside a user Git repository: source-tracked files under canonical `cwd` plus
  in-scope untracked files not ignored by the repository's ordinary ignore rules;
- for a non-Git workspace: files not ignored by hierarchical `.gitignore` files;
- minus protected Mini Lilac paths and every `.git` file/directory boundary.

Use Git's read-only ignore machinery where possible. For non-Git workspaces, use an isolated temporary
Git context solely for `check-ignore --no-index`. Do not honor ambient user-global excludes in the
non-Git case; they would make snapshots host-dependent. Record the capture implementation version
in the manifest.

When `cwd` is a subdirectory of a larger repository, discover the nearest enclosing repository root,
run tracked/ignore classification in that repository context, pass repository-relative literal paths,
and restrict every result to canonical `cwd`. This preserves ancestor `.gitignore`, `.git/info/exclude`,
and source-repository global exclude semantics without capturing siblings outside `cwd` or refreshing
the user's index. The asymmetry is deliberate: existing Git workspaces follow their ordinary Git
classification, while non-Git workspaces use only `.gitignore` files rooted at or below `cwd` and no
ambient global excludes.

Ignored paths are not represented and are not deleted on restore. A source-tracked file remains
managed even if an ignore pattern matches it, matching Git semantics.

The current capture's ignore classification governs preservation during restore. If a target-managed
path would require replacing, deleting, or traversing through a currently ignored/protected live path
that is absent from the current managed tree, preflight fails before any filesystem write. It may skip
an ignored collision only when the live object already exactly satisfies the target and no mutation is
required. Restoring an older `.gitignore` never grants permission to clobber something classified as
ignored at operation preparation time.

Nested repositories are boundaries: preserve their `.git` metadata and do not recursively manage a
nested repository unless the Mini Lilac session's canonical `cwd` is inside that repository.

### Restore implementation

Do not run `git reset --hard`, `git clean`, or user-worktree checkout porcelain.

Restore from the synthetic tree with `git ls-tree -rz` and `git cat-file --batch`:

1. Require the target snapshot and objects to resolve.
2. Capture/resolve the current managed state and freeze its ignore/protected classification before
   preparing navigation.
3. Treat the target snapshot tree/manifest as the authoritative target-managed path set. Compare the
   current managed tree to that set; do not reclassify target membership using current or restored
   ignore rules.
4. Preflight every target write, traversal, type change, and deletion against live ignored/protected
   collisions; fail before writes if preservation and target restoration conflict.
5. Materialize target regular files to temporary siblings, fsync, then rename into place.
6. Recreate target symlinks without following them.
7. Apply executable mode where supported.
8. Remove paths present in the current managed tree but absent from the target.
9. Resolve file/directory/symlink type changes through temporary names in deterministic depth order.
10. Remove newly empty managed directories, but never remove ignored/protected content.
11. Build a fresh verification index by hashing exactly the target-defined managed entries,
    verify every expected target type/mode/content, verify current-managed paths absent from the target
    were removed, and separately verify preparation-time ignored/protected paths were untouched. Do
    not let restored `.gitignore`, source-index changes, or ambient global excludes alter verification
    membership.
12. Verify the resulting target-defined wrapper tree equals the target OID.
13. After verification, atomically replace the warm `capture.index` with an index reconciled to the
    post-restore current classification so later
    captures resume from the restored state.

Restoration is idempotent. A crash may leave temporary files, so their names must be recognizable and
recoverable without confusing them with user files.

### Platform metadata

The first version guarantees:

- regular-file contents;
- symlink target text where symlinks are supported;
- executable bit where supported;
- addition, deletion, rename-as-content/path changes, and file/directory/symlink transitions.

It does not guarantee empty directories, ownership, timestamps, ACLs, xattrs, or hard-link topology.
Record platform and format version in the manifest so support can be expanded without reinterpreting
old snapshots.

Windows filesystem history is deferred from phase one. Keep the `platform-unsupported` outcome and use
transcript-only history on Windows; native Windows restore mechanics belong in the deferred follow-up.

### Git availability

Probe `git --version` through the same isolated process runner. Cache a positive result briefly, but
do not assume Git remains available forever. Every operation must classify process-spawn `ENOENT` as
`git-unavailable`.

Inability to spawn Git is an expected capability skip. A nonzero Git command, malformed output,
permission failure, or disk failure is operational failure, but the response depends on phase: a
read-only capture can fail without blocking, terminal capture can record `capture-failed`, and a
possibly partial restore retains its blocking journal. Missing historical objects degrade only their
snapshot records unless broad store integrity is compromised.

## Capturing History Boundaries

### Session creation and migration root

Every session atomically gets a root history state, cursor, and undo floor, but session creation does
not run Git. Store the root with `workspace_status = 'capture-deferred'`.

The first prompt always captures the then-current managed workspace and appends/selects an observation
state before opening its user transition. This preserves identical first-undo semantics while keeping
session creation fast and ensuring manual edits between session creation and first prompt belong to
the root branch state that actually preceded the prompt. `/undo` never exposes the deferred sentinel
as a target in this phase.

### Root prompt admission

In `SessionActor.startPrompt()`:

1. Complete existing validation and idempotency checks.
2. Plan to clear the redo navigation stack while retaining all immutable states/branches.
3. Capture the current managed workspace.
4. Require canonical transcript heads to equal the selected state's heads. A mismatch is corruption
   or incomplete recovery, not a workspace observation.
5. If the selected state is `capture-deferred` or the managed workspace differs, append a
   `workspace-observation` state/transition and select it.
6. Create an open `user-message` transition containing the exact prompt.
7. In one transaction, clear redo navigation, select any observation state, open the transition,
   admit the prompt/run and transcript message, mark the command side effect started, and save the
   prompt command result.
8. Start model execution only after that transaction commits.

If Git is absent and the selected state is captured or deferred, always create/select a distinct
`unavailable` boundary state with reason `git-unavailable`: undetectable manual drift must not later be
mistaken for an older captured tree. If the selected state is already unavailable with the same
transcript heads, it may be reused. If capture operationally fails, release the reserved prompt command
and do not start the model; this read-side failure does not block the workspace.

If filesystem history is gated on the current platform, follow the same admission path with reason
`platform-unsupported`; do not misclassify it as Git absence or operational capture failure.

Replace `beginRootRun()` checkpoint arguments with the selected `from_state_id` and transition ID.

### Steering delivery

The boundary is immediately before steering becomes canonical and is handed to the provider, not
merely when its HTTP request arrives.

Stage 0 must prove the awaited ordinary/interrupt boundary before production schema/runtime
integration. The current
`message_start` subscriber is too late because event persistence is queued while the agent can proceed
to `streamText()`. Add an explicit asynchronous pre-delivery history hook to the agent/Claude bridge:

- ordinary queued steering invokes it after the current tool block settles and before queue
  consumption;
- the hook captures the boundary and atomically closes the prior transition, persists the steering
  message, and opens the steering transition;
- the agent waits for that durable commit before putting the message into its provider request;
- history-enabled Claude sessions use this ordinary queued path; native injection is deferred;
- a failed capture leaves the steering entry unconsumed, reports the failure through existing command,
  stream, status, and logging paths, and lets the active run continue without that steer; it does not
  block the workspace or automatically terminalize an hours-long run;
- Git absence records a transcript-only boundary and still allows delivery.

The existing steer command durably returns `status: "queued"` before ordinary delivery. Preserve that
admission contract. Link the eventual history transition to the steer `command_id`; if pre-delivery
capture fails, do not rewrite the idempotent queued result or consume the entry. A later safe boundary
may attempt ordinary delivery again, and the user can cancel/interrupt explicitly.

`queued` acknowledges admission, not provider delivery. Until the pre-delivery transaction commits,
the entry remains process-local: a crash may drop it, command replay returns the original `queued`
result without recreating delivery, and startup clears the recovered session's queued count. Normal run
terminalization likewise discards any unconsumed queued entries. This is the explicit phase-one tradeoff
for omitting a steering-delivery journal.

The ordinary queued/interrupt durable ordering is:

1. Capture the boundary snapshot.
2. Commit the prior destination state, canonical steering message, and new open transition.
3. Acknowledge the history hook to the agent/Claude bridge.
4. Deliver to the provider.

A crash between steps 2 and 4 leaves a canonical ordinary steering turn with no provider effects.
Startup closes it as an interrupted/error turn. No provider-visible steer can be absent from the
durable history tree. Claude native injection remains disabled for history-enabled sessions in phase
one because its current callback boundary cannot provide this ordering without another journal.

At the boundary:

1. Capture one managed workspace snapshot for the consumed steering batch.
2. Close the previously open user transition at the first steering message's exact transcript prefix.
3. For each consumed steering message, create a user transition.
4. When several messages are consumed at one boundary, create intermediate transcript states using
   the same workspace snapshot and close all but the final transition immediately.
5. Leave the final steering transition open until the next steering boundary or run termination.

Replace `appendUserCheckpoints()` with one transaction that interns the model/UI prefixes and advances
the history transition chain. Preserve `replay_after_seq` on each user transition for active-run UI
reconstruction.

### Root-run terminalization

Before `finalizeRootRun()` commits terminal transcript state:

1. Wait for the active event queue and all owned tool executions to settle.
2. Intern the final model/UI transcript without selecting it.
3. In one `BEGIN IMMEDIATE` transaction, verify no `history_operations` row exists for the workspace
   and persist `pending_run_finalizations` with those heads and all terminal metadata. Its
   `UNIQUE(workspace_id)` constraint and SQLite's writer serialization exclude competing journals.
4. Capture the managed workspace as the operation owned by that pending finalization.
5. Create the destination history state.
6. Close the open user transition and advance `session_history.current_state_id`.
7. Commit run/session terminal state, canonical transcript heads, destination state, and deletion of
   the pending finalization in the same SQLite transaction.

Do this for completed, cancelled, and error runs. Undo must be able to reverse partial edits from a
failed or cancelled run.

If Git is absent, terminalization remains successful with an unavailable destination state and reason
`git-unavailable`. If Git exists but capture fails before any live-workspace mutation, close the run
with an unavailable destination state and reason `capture-failed`, report it through existing status
and logging paths, and continue serving the workspace. Redo into that state is necessarily
transcript-only. The pending-finalization row exists to survive a crash between prepared terminal facts
and this final decision, not to turn a read-side capture failure into a permanent outage.

A platform-gated implementation terminalizes with reason `platform-unsupported`; it does not attempt
capture and does not emit a capture-failed error.

### Startup recovery

Startup recovery is workspace-coordinated and awaited before the server listens:

1. Verify store ownership and reconcile refs whose objects still exist.
2. Recover retained navigation/restore operations first, grouped and serialized by workspace.
3. Recover pending run finalizations, grouped and serialized by workspace.
4. For each remaining open transition on an active run, create a pending finalization from the most
   accurate durable transcript heads and terminal facts. If no terminal outcome was committed, use the
   existing interrupted/error outcome. Recover it through the same capture-and-commit path rather than
   closing the transition independently.
5. Run the remaining interrupted run/session lifecycle recovery after no open transition remains.
6. Enable admissions.

This order is authoritative globally, but a valid database cannot contain navigation and finalization
journals for the same workspace. Both insertion paths use `BEGIN IMMEDIATE`, cross-check the other
table, and rely on their own `UNIQUE(workspace_id)` constraint. Detect a dual owner as invariant
corruption rather than choosing one. Git absence creates a transcript-only destination; capture failure
closes with `capture-failed`. Move current synchronous constructor recovery behind an awaited
`SessionService` initialization/factory because Git and filesystem recovery are asynchronous.

### Manual compaction

Manual compaction remains an `/undo` barrier but must stop deleting historical branches.

On successful compaction:

1. Capture the actual managed workspace. Operational capture failure aborts compaction before
   transcript movement; Git/platform unavailability uses the normal unavailable boundary outcome.
2. If the selected state is deferred or managed state differs, prepare a completed
   `workspace-observation` from the selected state.
3. Intern the compacted transcript without selecting it.
4. Create a `compaction` destination from the observation, or current state when unchanged, reusing
   that boundary's workspace snapshot/outcome.
5. In the existing compaction commit transaction, add any observation and the `compaction` transition,
   select the compacted transcript/state, set `undo_floor_state_id`, clear redo navigation, and save the
   command result.

The pre-compaction tree remains retained for a future explicit history viewer/checker. `/undo` simply
does not cross `undo_floor_state_id` in this phase.

Automatic compaction inside a run is transcript-internal and does not independently create a
navigation barrier. Its final canonical transcript is captured when the surrounding user transition
closes.

## Undo State Machine

`SessionActor.undo()` remains quiescent-only and serialized by the actor lock.

### Prepare

1. Resolve command idempotency.
2. Re-read the session and reject active/compacting/cancelling state.
3. If no undoable user transition exists above the floor, persist/return `empty`.
4. Require current transcript heads to equal the selected history state.
5. Capture the actual managed workspace and prepare a `workspace-observation` only if managed files
   differ.
6. Identify the latest applied user transition and its `from_state` target.
7. Determine the exact observed source state and transition ID that the final commit will push onto
   `history_redo_stack`.
8. Resolve target objects and complete ignored/protected/type/space restore preflight before creating
   a restore-mode journal. Preflight failure leaves no operation row and makes no live-workspace write.
9. In one `BEGIN IMMEDIATE` transaction, verify no `pending_run_finalizations` row exists for the
   workspace, mark the command side effect started, insert the unselected observation, and reserve the
   `history_operations` intent with that selected current state as `source_state_id`, the new
   observation as `observed_source_state_id`, plus the undo target and filesystem mode. The row's
   `UNIQUE(workspace_id)` constraint excludes another navigation journal.

Preparing an observation extends immutable topology but does not move
`session_history.current_state_id` or transcript heads. Selection moves only in the final commit after
restore verification.

If Git is unavailable, the source observation is unavailable with reason `git-unavailable`, and the
operation uses `skip`. If the target has no available captured snapshot, use `skip` with
`snapshot-unavailable` and preserve the target state's more precise unavailable reason for diagnostics.
If filesystem history is platform-gated, use `skip` with `platform-unsupported`.

### Apply

1. Mark the operation `restoring` before the first filesystem mutation.
2. Restore the target managed tree when mode is `restore`.
3. Recapture/verify the target and mark the operation `verified`.
4. For `skip`, perform no filesystem writes.

### Commit

In one SQLite transaction:

- move model/UI transcript heads to the target state;
- set `session_history.current_state_id` to the target;
- push `observed_source_state_id ?? source_state_id` as the redo target;
- save the exact undo command result;
- delete the history operation intent.

Return the transition's exact user message and filesystem outcome.

Do not delete transcript nodes, history states, transitions, branches, or Git refs.

## Redo State Machine

`SessionActor.redo()` has the same quiescence and recovery requirements.

### Prepare

1. Resolve command idempotency.
2. If the redo stack is empty, persist/return `empty`.
3. Require transcript heads to equal the selected state and capture managed drift into an unselected
   observation. Operational capture failure aborts before restore; Git/platform unavailability records
   the corresponding unavailable observation and proceeds with `skip`.
4. Select the top redo target and associated user transition.
5. Reserve a history operation from the observed current state to that exact target.

### Apply and commit

Restore/verify the target using the same operation engine as undo. In the final transaction:

- restore target transcript heads and cursor;
- pop exactly one redo entry;
- save the idempotent redo result;
- remove the operation intent.

Redo never reruns the model, tools, patches, or commands.

## Crash Consistency

Git objects and SQLite cannot participate in one transaction. Use leak-safe ordering.

### Snapshot creation

1. Write all blobs/trees.
2. Verify the synthetic root.
3. Create the private Git ref atomically.
4. Insert/reuse `workspace_snapshots` and the referencing history state transactionally.
5. Reconcile orphan refs after a grace period if SQLite commit fails.

Never persist a captured history state before its ref exists.

### History navigation

1. In one `BEGIN IMMEDIATE` transaction, cross-check `pending_run_finalizations`, mark the command side
   effect started, and persist `history_operations` with `phase = 'prepared'`; the retained journal row
   immediately blocks competing workspace history work.
2. Set `phase = 'restoring'` before writes.
3. Apply the idempotent restore.
4. Verify and set `phase = 'verified'`.
5. Commit cursor/transcript/redo/`commands.result_json` and delete the operation in one transaction.

On startup, recover every operation before opening admissions:

- `prepared`/`restoring`: rerun restore from the target state, verify, then finalize;
- `verified`: repeat verification, then finalize;
- `skip`: finalize transcript movement without filesystem writes;
- missing Git for an operation already marked `restore` is not a normal skip; leave it blocked until
  Git returns because writes may already have started.

Recovery always rolls forward, including `prepared`: it restores/verifies the recorded target and
commits the original command result. Only the explicit operator `abandon` path may terminate a restore
journal without reaching its target.

Every capture/admission/restore/GC entry point checks workspace health, retained navigation journals,
and pending finalizations. Recovery clears the journal block only after restore verification and the
final SQLite transaction commit; it does not need to toggle a duplicate workspace health flag.

Temporary materialization is idempotent and target-addressed. Recovery must tolerate a crash at every
individual file replacement or deletion.

### Operator recovery surface

Add a local server/CLI maintenance command, not a model tool or session transcript command:

```text
mini-lilac history-recovery status [--workspace <cwd>]
mini-lilac history-recovery abandon --workspace <cwd> --acknowledge-partial-worktree
```

It operates under the database/workspace locks while the HTTP server is stopped or before it begins
listening. `status` is read-only: navigation entries report workspace, session, command, source, target,
phase, and update time; pending finalizations report workspace, session, run, transition, terminal
status, and preparation time. Normal server restart is the retry mechanism. `abandon` applies only to a
navigation entry and requires the explicit acknowledgement flag. In one `BEGIN IMMEDIATE` transaction,
it validates the operation/source, stores a replayable terminal error outcome in
`commands.result_json`, leaves the selected cursor/transcript at `source_state_id`, retains any
`observed_source_state_id` as an unselected branch state, and deletes the operation row. It never claims
the source or target worktree is synchronized. Document how to inspect/copy the workspace before
abandonment.

Validate the stored abandonment value as an internal command-error shape with code
`history-recovery-abandoned`, command ID, and message. Command replay recognizes that shape and raises
the same mapped control error instead of parsing it as a successful undo/redo result. Successful and
`empty` outcomes retain the public result schemas below; no separate audit record is needed.

## Protocol And API

### Filesystem outcome

Add a shared schema:

```ts
type MiniLilacHistoryFilesystemResult =
  | { status: "restored" }
  | {
      status: "skipped";
      reason: "git-unavailable" | "snapshot-unavailable" | "platform-unsupported";
    };
```

Operational failures are HTTP/control errors, not another skipped variant. The internal persisted
abandonment outcome replays the corresponding control error.

### Undo result

Extend the existing result:

```ts
type MiniLilacUndoResult =
  | {
      status: "undone";
      clientCommandId: string;
      message: MiniLilacUserUIMessage;
      historyStateId: string;
      filesystem: MiniLilacHistoryFilesystemResult;
    }
  | { status: "empty"; clientCommandId: string };
```

### Redo request/result

Add `MiniLilacRedoRequest` and `MiniLilacRedoResult` schemas parallel to undo:

```ts
type MiniLilacRedoResult =
  | {
      status: "redone";
      clientCommandId: string;
      message: MiniLilacUserUIMessage;
      historyStateId: string;
      filesystem: MiniLilacHistoryFilesystemResult;
    }
  | { status: "empty"; clientCommandId: string };
```

### Session snapshot

Expose only the navigation facts needed by current clients:

```ts
historyStateId: string;
canUndo: boolean;
canRedo: boolean;
```

Do not expose the complete tree yet.

### Routes and transport

- Keep `POST /sessions/:sessionId/undo`.
- Add `POST /sessions/:sessionId/redo`.
- Add `MiniLilacTransport.redo()` next to `undo()`.
- Map redo quiescence and recovery-blocked failures consistently in the server.
- Keep command IDs mandatory/idempotent for both operations.

## TUI

### Commands

- Keep `/undo` and `/rollback`.
- Add `/redo` to the parser, command palette, help text, controller, and tests.
- Both commands remain idle-only local controls and must never be sent to the model.

### Reconciliation

After a successful undo/redo, refresh canonical messages from the server and rerender. If refresh
fails, use the returned message/state result for the narrow local fallback and show that the server
operation already committed.

### Draft behavior

Undo continues restoring the removed user message as a draft. Redo may clear that automatic draft only
when the editor still exactly matches what undo inserted. If the user typed, pasted, or attached
anything afterward, leave the editor untouched. Minimal process-local provenance may track that exact
comparison; it is not durable and must never erase a draft after restart.

### Skipped filesystem warning

Persist the filesystem outcome in the command result and render a concise noncanonical status warning
such as:

```text
Transcript undone; managed worktree unchanged because Git is unavailable.
```

Do not append operational warnings to canonical session messages or transcript heads. Do not report
skipped restoration as a command failure.

### Deferred tree UI

Do not add tree rendering, branch labels, checkout controls, or a history inspector in this phase.
The TUI should consume only `canUndo`, `canRedo`, and command outcomes.

## Migration

Migrate schema v4 linear checkpoints into one retained linear history branch.

1. Create `history_store_metadata` and one `workspaces` row per canonical session `cwd`.
2. Rebuild `sessions` with its required `workspace_id`, backfill it, rebuild affected dependent
   tables/foreign keys, and run `PRAGMA foreign_key_check` before changing `user_version`.
3. For each session, read `user_checkpoints` in `ui_position` order.
4. Create one pre-message history state for each checkpoint using its model/UI heads and
   `workspace_status = 'unavailable'`, reason `legacy-migration`.
5. Create a `user-message` transition for each checkpoint. Infer `delivery = 'prompt'` for the first
   retained checkpoint of each `root_run_id` and `delivery = 'steer'` for later checkpoints sharing
   that run. Legacy transitions may have `command_id = NULL` because v4 checkpoints do not preserve
   the originating command ID.
6. Use the next checkpoint's pre-message state as the prior transition's destination.
7. For a terminal root run, create one final state from the session's current transcript heads and
   close the final transition. Leave an active run's final transition open for startup recovery.
8. For sessions with no checkpoint, create one root/current migration state.
9. Set the current state to the final visible closed state and set an appropriate undo floor.
10. Leave the redo stack empty.
11. Validate every migrated user message, topology invariant, and transcript foreign key before
    selecting the migrated tree.

Use `origin = 'migration'` only for the no-incoming root and the single-state fallback. Every migrated
state selected as a `user-message` transition destination, including a terminal final state, uses
`origin = 'turn-boundary'` so the normal topology validator remains valid.

Migration is resilient per session. If checkpoint ordering is unusual but canonical transcript heads
and messages remain readable, preserve the full visible transcript in one current migration state,
set the undo floor there, and report an actionable migration warning through existing logging/status
paths. Do not invent turn ordering. Structural transcript corruption, invalid foreign keys, or an
unreadable current session still fails and rolls back the migration rather than starting with silently
corrupted canonical history.

The truncated fallback is allowed only for a quiescent session. An active run requires a valid open
user transition for startup recovery; inconsistent active-run checkpoints are structural corruption
and fail migration rather than producing a cursor with no recoverable transition.

Parse/validate a complete session before inserting its history, or wrap each session in a SQLite
`SAVEPOINT` and roll it back before writing the truncated fallback. Run `PRAGMA foreign_key_check`
inside the outer migration transaction and advance `user_version` only after all sessions validate.

Historical worktree state cannot be synthesized. Undoing across migrated states is transcript-only
with `snapshot-unavailable` until navigation reaches newly captured history.

Existing already-undone suffixes cannot be recovered because current undo deleted their checkpoint
metadata. Preserve orphan transcript nodes as today; do not guess their topology.

Run migration before the existing interrupted-run terminalization, then run history-aware startup
recovery to close migrated open transitions. Do not let the legacy startup path terminalize a run
without updating its history transition.

## Retention And Garbage Collection

### Current phase

Retain all immutable history states and all branch snapshots. Clearing redo navigation does not
release history.

This is necessary for the future undotree/fork goal. It also means archived or abandoned branches can
continue consuming storage indefinitely.

### Git rooting

Every unique `workspace_snapshots` row owns a durable private Git ref. Never rely on a tree hash stored
only in SQLite: Git GC cannot see SQLite references.

Run repack/GC only under the workspace-store lock. Rooted snapshots remain reachable. Unrooted objects
from failed captures are eligible after a conservative grace period.

### Reference reconciliation

At startup and before GC:

1. Enumerate snapshot rows and expected refs.
2. Verify each retained ref resolves to its recorded root tree.
3. Repair a missing ref when the object still exists; otherwise mark that snapshot `missing` or
   `corrupt`, report which historical states are transcript-only, and continue new history capture.
   Escalate workspace health only for ownership mismatch or broad object-store corruption that makes
   new writes unsafe.
4. Remove orphan refs only after confirming no SQLite state/operation references them and the grace
   period elapsed.
5. Delete an entire private store only when no snapshots, history operations, or pending finalizations
   remain for its workspace.

Restoring/copying a database under a different canonical path derives a new store namespace. If its
old private object store was not copied too, reconciliation marks historical snapshots `missing` but
does not brick prompt admission; new captured history starts in the new namespace.

### Accounting

Record and expose structured metrics/logs for:

- capture/restore duration;
- candidate and managed path counts;
- bytes read/written/materialized;
- state, transition, branch, snapshot, and redo-stack counts;
- loose object count/bytes and pack count/bytes (`git count-objects -v`);
- Git-unavailable captures/navigation;
- restore retries, verification failures, and blocked operations.

Do not attempt per-session byte attribution: Git objects are shared across states, branches, and
sessions using the same workspace.

### Future policy hooks

Future retention can prune explicit history subtrees by deleting state/transition rows, then deleting
unreferenced snapshot rows/refs and running Git GC. Do not encode retention as parent-linked Git
commits, because retaining one tip would retain every ancestor and prevent subtree expiry.

Snapshot release ordering is intentionally leak-safe: transactionally delete the unreferenced
`workspace_snapshots` row first, then remove its Git ref under the workspace lock. A crash can leak a
ref for reconciliation, but it cannot leave a retained database row whose only Git reachability root
was removed. Run Git GC only after ref reconciliation.

Useful future policy dimensions are:

- explicit branch deletion;
- deleted-session cleanup;
- per-workspace byte quota;
- minimum free-space reserve;
- maximum age for unselected branches;
- pinned/named states exempt from pruning.

If a future quota prevents a required checkpoint, prompt admission should fail before model/tool side
effects rather than silently promise undo without a snapshot.

## Concurrency

The agreed policy allows unsafe concurrent sessions sharing one canonical `cwd`.

Still implement:

- one in-process mutex per workspace store for Git object/index/ref operations;
- one durable database lock as today;
- no simultaneous restore and GC in one store;
- verification after every restore;
- clear diagnostics naming concurrent mutation as a likely verification-failure cause.

Do not claim that snapshots are coherent under concurrent writers. Another Mini Lilac session, editor,
build, watcher, or background process can mutate files during capture/restore. Verification prevents a
false success when the race is observed, but a process can mutate the workspace immediately after a
successful verification.

History remains session-scoped even when snapshot objects are workspace-shared. A restore in one
session does not move another session's transcript cursor; that other session can therefore become
semantically stale.

## Security And Guardrails

- Canonicalize the workspace and reject path escape at every capture/restore boundary.
- Use `lstat` and never follow symlinks while walking or deleting.
- Preserve `.git` metadata and Mini Lilac protected paths unconditionally.
- Prefer the private object store outside the workspace, always protect/exclude it when a broad `cwd`
  contains it, and keep it mode `0700`; files/refs should not be group/world writable.
- Do not execute Git hooks, filters, aliases, pagers, editors, credential helpers, or shell commands.
- Treat Git/tree/manifest data as untrusted on read and validate every relative path before
  materialization.
- Reject absolute paths, `..`, NUL, duplicate normalized names, and case-fold collisions relevant to
  the target platform.
- Avoid logging file contents, symlink targets, credentials, or command environments.
- Check free space before large materialization when the platform exposes it, but retain recovery for
  mid-operation exhaustion.

## Implementation Stages

### Stage 0 -- Feasibility and performance spikes

- Prototype the hybrid private-index capture path and run the cold/warm performance and exact-byte
  transform tests before finalizing Stage 1 APIs.
- Add a test-only awaited agent steering hook at ordinary boundary and interrupt consumption sites.
  Prove provider invocation waits, batches retain exact IDs/prefixes, and repeated hook invocation does
  not prepare twice.
- Confirm history-enabled Claude sessions can use ordinary queued steering with native injection
  disabled.
- Record engineering-reference results locally without treating machine-specific timings as release
  gates.

### Stage 1 -- Private snapshot engine

- Add workspace-history state paths and protected paths.
- Implement isolated Git process execution, availability classification, and workspace-store locks.
- Implement managed path enumeration and ignore handling for Git/non-Git workspaces.
- Implement content-addressed capture, wrapper manifests, refs, restore, verification, and orphan
  reconciliation.
- Add focused filesystem tests before integrating sessions.

### Stage 2 -- History-tree schema and migration

- Add the new tables and schemas.
- Migrate v4 checkpoints into a linear immutable branch.
- Add store operations for state creation, open/close transitions, cursor selection, ancestry lookup,
  redo stack, undo floor, and snapshot reference reuse.
- Replace `runs.undone_at` latest-run selection with selected-history ancestry.
- Add invariant/round-trip/migration tests.

### Stage 3 -- Prompt, steering, finalization, and recovery boundaries

- Create the deferred session root and capture the first real boundary lazily at prompt admission.
- Integrate root prompt admission and branch creation.
- Productize the proven ordinary queued pre-steering-delivery hook from Stage 0.
- Close/open transitions across steering batches.
- Close the final transition during every root-run terminal path.
- Add workspace-coordinated asynchronous startup recovery in the specified navigation-first order.

### Stage 4 -- Undo/redo operation engine

- Implement workspace observation before navigation.
- Implement durable history operation prepare/apply/verify/commit/recover.
- Add read-only operator history-recovery `status` and explicit `abandon` handling; startup remains the
  retry path.
- Replace destructive `undoLatestUser()` with cursor-based undo.
- Add redo stack and `SessionActor.redo()`.
- Preserve idempotency and quiescence behavior.
- Add skipped-filesystem outcomes and blocked-operation errors.

### Stage 5 -- Protocol, server, and transport

- Extend session snapshots and undo results.
- Add redo schemas, transport, endpoint, validation, and error mapping.
- Update README/API documentation.
- Add protocol, server, reconnect, command-retry, and idempotency tests.

### Stage 6 -- TUI

- Add `/redo` parsing, command palette/help, controller effect, and rendering.
- Clear an automatically restored undo draft on redo only when the editor still matches it exactly.
- Surface skipped filesystem outcomes.
- Update undo behavior to use new result fields and history flags.
- Add input/controller/render tests.

### Stage 7 -- GC, metrics, and hardening

- Run grace-aware ref reconciliation and Git maintenance under the shared workspace lock.
- Expose accounting, latency, and failure outcomes through structured metrics/logging.
- Exercise disk-full, permissions, Git disappearance, corruption, and concurrent mutation.
- Document supported metadata and unsafe shared-workspace semantics.

## Test Plan

### Snapshot engine

- Capture/restore in a non-Git directory with `.gitignore`.
- Capture/restore in a dirty Git repository without changing its index, refs, status semantics, or
  `.git` contents.
- A repository much larger than a scoped subdirectory `cwd` honors ancestor ignore rules while
  capturing no sibling/out-of-scope path.
- Tracked-but-ignored files remain managed; ignored untracked files remain untouched.
- Add, modify, delete, rename, binary, executable, symlink, and path type transitions.
- Large nonignored files are captured.
- Identical states reuse one snapshot row/OID.
- Empty directories remain outside the contract.
- Protected and nested-repository metadata survive restore.
- Path traversal, symlink escape, case collisions, special files, malformed trees, and object
  corruption fail safely.
- Git absent is classified separately from Git nonzero failure.
- Warm no-op/one-file-change captures demonstrate Stage 0 byte-read behavior; post-restore verification
  uses a fresh index and full hashes.
- Git attributes, LFS filters, autocrlf, global hooks/config, and replacement objects cannot transform
  stored bytes or execute user programs.
- Windows reports `platform-unsupported` and uses transcript-only history without attempting restore.

### History topology

- Session creation writes only a deferred root and runs no Git process; first prompt capture creates
  the real pre-prompt observation state.
- Root prompt creates one user transition and final destination state.
- Steering creates one transition per model-visible message.
- Batched steering shares one workspace snapshot while retaining distinct transcript boundaries.
- Failed/cancelled runs close their transitions.
- Prompt after undo creates a sibling branch and retains the old branch.
- Identical state contents do not collapse state identities/topology.
- Manual compaction records pre-compaction workspace drift as an observation, advances the undo floor,
  and does not delete prior history.
- Migrated v4 sessions form the expected linear branch and navigate transcript-only.
- Unusual but readable v4 checkpoint ordering falls back per session to one current migration state
  without bricking other sessions; structural transcript corruption still rolls migration back.
- Active-run admission uses the direct active-run relation while selected-history lookup ignores open
  transition ancestry.

### Undo/redo

- Repeated undo/redo restores exact transcript and worktree states.
- Manual managed edits detected by warm capture before undo are captured and restored by redo.
- Manual edits after undo are discarded by redo but retained as an observation state.
- New prompt clears redo navigation while retaining the old branch.
- Undo never crosses the compaction floor.
- Empty undo/redo is idempotent and creates no observation state.
- Root and steering messages return the exact removed/redone UI message.
- Todos remain unchanged.
- Ignored files remain unchanged across undo/redo.
- A target path colliding with a live ignored/protected path fails preflight before any restore write.
- Absolute/out-of-workspace writes remain unchanged.

### Failure and recovery

- Git absent at prompt, finalization, undo, and redo yields transcript-only state/outcome.
- Operational capture failure during prompt, undo, redo, or compaction preparation aborts before
  transcript/worktree movement and leaves no blocking journal.
- Git becomes available after legacy/unavailable history; unavailable states remain filesystem-less.
- Git disappears after a restore operation is prepared; operation remains recoverable rather than
  degrading.
- Crash after every operation phase and after individual file writes/deletes converges on restart.
- Crash after ordinary canonical steering commit but before provider delivery closes an effect-free
  interrupted steering transition.
- Crash before the steering history hook may drop the process-local queued entry; replay returns the
  admitted `queued` result without redelivery, and startup clears the queued count.
- Startup converts an unmatched open transition into a pending interrupted/error finalization and
  closes it through the normal capture-and-commit path.
- Restore verification failure does not move transcript heads.
- Restore failure after preparing an observation does not move the selected history cursor.
- A historical snapshot found missing/corrupt before journal preparation navigates transcript-only
  with `snapshot-unavailable` and an actionable warning; object loss discovered after a restore journal
  is durable keeps that operation blocked for repair or explicit abandonment.
- Disk-full and permission errors preserve recoverability.
- Duplicate command IDs replay exact outcomes without another restore.
- Concurrent workspace mutation either verifies the target or fails; it never reports false success.
- Shared-workspace preparation cannot create simultaneous navigation/finalization journal owners;
  startup detects dual rows as corruption and otherwise recovers in the documented global order.
- Root prompt, steering, and compaction boundary commits cannot race past a retained journal while the
  workspace mutex is held.
- Prepared undo/redo recovery always rolls forward and returns the original idempotent result.
- Server restart retries the same target; operator `abandon` records a terminal command error, leaves
  the cursor at source, permits a later observation capture of the partially changed worktree, and
  replays the same mapped command error for the original command ID; command error and journal deletion
  commit atomically.
- Capture failures that performed no live-workspace write do not leave a workspace-wide block.
- Missing historical object stores mark only affected snapshots unavailable and permit new prompting.

### TUI

- `/redo` is local and idle-only.
- Undo restores multipart drafts.
- Redo clears an automatically restored draft only when unchanged.
- User edits while undo/redo is in flight are preserved.
- Uncertain responses retry with the same command ID.
- Canonical refresh failure reports committed history movement accurately.
- Git-unavailable outcomes render as warnings, not failures.

## Acceptance Criteria

- `/undo` and `/redo` survive server restart and uncertain client retries.
- With Git available, successful history navigation leaves the managed worktree hash equal to the
  target state's snapshot and canonical transcript heads equal to the target state.
- Without Git, the same commands move only transcript history and clearly report the skipped
  filesystem operation.
- A Git operational failure never commits transcript movement after an unverified restore.
- Sending a prompt after undo creates a retained sibling branch; database inspection can reconstruct
  the complete state/transition tree even though no public tree API exists yet.
- No history operation changes the user's Git index, refs, branches, commits, stash, or ignored files.
- Every retained snapshot is protected by a Git-visible ref, and Git maintenance cannot prune a
  snapshot still referenced by history.
- Warm captures use the private index and demonstrate the documented Stage 0 byte-read behavior rather
  than rehashing the whole workspace at every boundary.
- Ordinary queued steering cannot reach a provider before its history boundary commits; native Claude
  injection is disabled for history-enabled sessions in phase one.
- Capture-only failures and missing old snapshot stores do not globally block new history; only an
  active pending finalization, a possibly partial restore journal, or independent store-health failure
  blocks conflicting non-owner work.
- Current root prompts, steering, cancellation, compaction, reconnect, and terminal replay continue
  to pass their existing behavior tests.

## Explicitly Deferred Follow-Up

The persisted model must support a later feature without schema replacement:

- list history states/transitions as a tree;
- show current cursor, redo path, branch tips, timestamps, messages, run outcomes, and worktree diff
  summaries;
- preview a target state's transcript/worktree diff;
- checkout any retained state;
- fork a new prompt from any retained state;
- name/pin branches or states;
- choose among multiple children for forward navigation;
- prune an explicit subtree and release unreferenced snapshots.

Native Claude steering injection, native Windows filesystem restore, configurable retention/quota
policy, and richer interactive recovery tooling are also deferred from phase one.

Those features should consume `history_states`, `history_transitions`, and workspace snapshots as
defined here. They are not part of the `/undo` and `/redo` implementation phase.
