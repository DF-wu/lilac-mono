# Offline blob cutover

This integration supports current managed-blob data directly: transcript schema 6 or later and
workflow schema 26 or later. Current startup applies the later upstream schema upgrades. It no
longer launches a legacy migration from the Docker entrypoint. Removing that hook does not claim
that every deployed installation is already current; operators must identify their installed
build and schema versions before upgrading.

Legacy transcript schema 5 and workflow schema 25 remain supported through the upstream offline
command at **`f2c90667ac5616796c992602ca5fb5be726cf40d`**. Other legacy schema combinations require
identification of their matching historical upgrade path before proceeding; they are outside
this integration's verified fixture baseline.
Mixed, corrupt, drifted, and future states must stop for diagnosis rather than start current Core.
The historical command rejects already-current data; it is not a recurring startup step.

## Operator procedure

1. Identify the installed build, configuration version, schema ledgers, configured blob root or
   bucket/prefix, and any `SQLITE_URL` override. Do not infer data compatibility from config version.
2. Drain accepted work and stop Core and all producers. The migration does not translate Redis
   requests, pending entries, consumer groups, output events, or dead-letter payloads. A backup
   cannot undo external tool effects.
3. Back up the stopped databases and their required WAL state, durable legacy content, managed
   blobs, and required Redis state as one matching set. Keep configuration and credential backups
   private. Verify backup file lengths and SHA-256 hashes and rehearse restoration in a disposable
   location before applying the migration.
4. Use a separate checkout of the exact historical commit and its pinned dependencies. From the
   same working directory and environment used for the workflow database override, run:

   ```sh
   bun run migrate:blob-storage -- --config /private/path/core-config.yaml --data-dir /private/path/data --dry-run
   bun run migrate:blob-storage -- --config /private/path/core-config.yaml --data-dir /private/path/data
   ```

   Preserve the deployment's `SQLITE_URL` value when set. These commands are an operator recipe;
   no real deployment paths or credentials were read during this integration.
5. Confirm the historical command completed transcript schema 6 and workflow schema 26, with all
   retained bytes verified. Then start current Core and verify its subsequent schema upgrades,
   retained history, resources, new requests, and configured integrations.

The historical command intentionally discards exact valid graceful snapshots v1–v4; its dry-run
reports the discard without performing it. Malformed snapshots, corrupt current v5 snapshots,
future versions, and drifted layouts block migration. Current Core leaves old
`graceful-restart.db` files inert.

Apply is transactional per database, not across every database and the blob store. On failure
after mutation starts, keep producers stopped and restore the complete matching pre-upgrade set
before retrying. Rollback likewise restores matching databases and blobs before starting the old
binary. Do not remove migration markers or point Core at partially copied storage.

## Disposable verification on 2026-11-11

The exact historical commit was exported with `git archive` into
`/tmp/lilac-offline-cutover-woyfoha0`; installed external dependencies were linked into that archive,
while workspace package links resolved to the historical source. Tests used Bun **1.4.4** and
explicit disposable data/database paths, without a running Redis endpoint or application launch.

`bun --cwd apps/core test ./tests/migration/` passed all **46 historical tests**. They cover the
offline CLI arguments and `SQLITE_URL`, dry-run, object verification, transaction/close ordering,
rollback, legacy transcript content, graceful snapshot classification, and transient cleanup.
The documented root `bun run migrate:blob-storage -- --config ... --data-dir ...` command also
ran successfully with `--dry-run` and then apply against a separate disposable 5/25 CLI fixture,
using its explicit `SQLITE_URL` override.

Four supplemental fixture cases passed with **20 assertions**:

- Legacy 5/25: dry-run leaves every fixture file's SHA-256 unchanged; the copied backup has the
  exact original file map and hashes; apply reaches 6/26; reading the migrated durable object
  through the blob adapter returns the exact seven input bytes and matching length/hash; restoring
  the backup returns the complete original file map, hashes, and schema versions.
- Current 6/26: the historical command refuses another dry-run without altering any fixture file.
- Mixed legacy/current databases: apply fails before changing the fixture file map or hashes.
- Corrupt legacy owned bytes: both dry-run and apply fail without changing fixture files.

The supplemental test source is retained as a local review artifact at
[fixtures/fork-cutover-evidence.test.ts](fixtures/fork-cutover-evidence.test.ts), SHA-256
`5436e4a77001857a9b639d3292de32c3320b3b0a7b7ca00e350749721cf5296f`.
Copy it into the historical archive's `apps/core/tests/migration/` and run that individual test
through the same workspace test command to reproduce these cases. It is verification code, not
a replacement runtime migrator.

No live data was migrated. Local-adapter fixtures do not certify an operator's backups, deployed
schema baseline, S3 credentials, or live bucket cutover.
