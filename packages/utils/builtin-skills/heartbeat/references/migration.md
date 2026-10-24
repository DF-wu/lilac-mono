# Migrate heartbeat notes

Use the matching route below. Core preserves existing files on startup; installing the new skill does
not migrate them.

## Monolithic working notes

1. Read the active workflow, index, and related prompt instructions. Preserve a backup outside the
   active heartbeat files before restructuring.
2. Move each unresolved matter into `heartbeat/topics/<topic>.md` as a current snapshot under the
   skill's "Keep notes current" rules. Preserve current authorization boundaries, source references,
   explicit destinations, pending delivery, next checks, and stopping conditions. Resolve conflicting
   history from the latest supported instruction; retain uncertainty when it cannot be resolved.
3. Save useful closed outcomes and user-stopped watches in `heartbeat/archive/<topic>.md`. Keep
   concise outcome and source references. Leave detailed evidence in existing reports or transcripts.
4. Replace `WORK.md` with short active routes and the latest discovery cursor and coverage gap.
   Reconcile the active `HEARTBEAT.md` and `AGENTS.md` so they route details to topic files and use
   the skill's cleanup rules. Replace instructions that accumulate check histories in working notes;
   preserve unrelated customizations.
5. Verify every unresolved matter has a route, every link resolves, and current delivery and
   authorization instructions survived. Keep the backup until the conversion is verified. Record any
   useful migration outcome outside the active index. This note reorganization needs no configuration
   change or test notification.

## Legacy ownership and inbox handoffs

1. Read the active `HEARTBEAT.md`, `AGENTS.md`, pending `heartbeat/inbox/` files, and relevant archived
   notes. Preserve copies outside the active files before editing. Record the migration outcome in
   `heartbeat/archive/` so rerunning this procedure merges work rather than duplicating watches.
2. Transfer standing instructions into the new workflow structure, retaining user customizations.
   Convert watchlists, upcoming checks, and unresolved inbox notes into topic snapshots linked from
   `WORK.md`. Preserve source references, due dates, the last communicated finding, relevant lessons,
   and explicit delivery targets. Read the
   originating conversation when needed; do not invent dates or recipients.
3. Use the current skill assets as a guide. Allow ordinary conversations to edit workflow and working
   notes. Remove obsolete instructions requiring all changes to pass through an inbox. Reconcile the
   same rule in active `AGENTS.md`; preserve unrelated policies and the user's stricter preferences.
   Include routing to the skill's conversation reconciliation procedure for replies to proactive
   updates and changes to ongoing matters, including those missing from current context.
   If a `.new` or merge candidate exists, inspect its relevant changes rather than replacing the file.
4. Preserve `surface.heartbeat.defaultOutputSession` when configured. If missing, ask where default
   output should go and resolve the answer. Keep per-watch targets separate. “Here” in an old note
   needs its original concrete thread; if unresolved, mark delivery blocked and ask the user.
5. Verify every unfinished legacy item is represented, every explicit destination is preserved, and
   completed work is not reopened. Keep original inbox/archive files and backups until the user has
   verified the conversion. The new workflow no longer consumes them each wake.
6. Follow [setup.md](setup.md) to verify configuration, an actual wake, and delivery. Record pending
   verification. Migration is complete only after the converted work and delivery behavior are checked.
