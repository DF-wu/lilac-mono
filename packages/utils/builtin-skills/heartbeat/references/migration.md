# Migrate the legacy heartbeat workflow

Read this only when the active files use the old heartbeat-only ownership rule or inbox/archive
handoffs. Core preserves existing files on startup; installing the new skill does not migrate them.

1. Read the active `HEARTBEAT.md`, `AGENTS.md`, pending `heartbeat/inbox/` files, and relevant archived
   notes. Preserve copies outside the active files before editing. Record the migration in `WORK.md`
   so rerunning this procedure merges existing work rather than duplicating watches.
2. Transfer standing instructions into the new workflow structure, retaining user customizations.
   Convert watchlists, upcoming checks, and unresolved inbox notes into working-note entries. Preserve
   source references, due dates, notification history, lessons, and explicit delivery targets. Read the
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
