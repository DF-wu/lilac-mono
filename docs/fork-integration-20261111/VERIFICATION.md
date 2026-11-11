# Verification record

The broad integration already landed externally in PR #101. The follow-up is reconciled with main `2e5159be7b23fa34a25a517275d20f327858f9f7` and includes upstream `3493c0c6c06260e6c472bd230dc02d4b0308db43`. The follow-up PR records the exact final tested HEAD, final independent review and image IDs, avoiding a self-referential commit identifier in this file.

## Required repository gate

`bun run check` runs all generated schema/provider/activity freshness gates, Oxlint, semantic and syntax architecture gates, root and every workspace test, lint-rule tests, custom-media source/bundle tests and typecheck, workspace/extras typechecks, and formatting. Bun is exactly **1.4.4**, matching `packageManager`; frozen workspace dependency installation passed.

The full pre-reconciliation candidate check passed: **7,878 passed, four skipped, zero failed**, including 4,491 Core tests and 113 architecture tests. Its log is saved locally as `check-precommit-snapshot.log`; the preceding independent full run is `check-verified-final.log`. These are precursor results, not a claim about an untested later HEAD. The reconciled/final checks are recorded in the follow-up PR with exact SHA and fresh counts.

Final footprint validation uses `bun run fork:footprint -- --strict --upstream=3493c0c6c06260e6c472bd230dc02d4b0308db43`. The generated allowlist covers only modified/deleted upstream-owned paths; fork additions and all original/refreshed/follow-up paths are separately accounted for in PATH-INVENTORY.md. Regenerate that report with `python3 docs/fork-integration-20261111/reproduce-inventory.py`; unassigned ownership is an error.

## Isolation and diagnosis

Full checks run in a disposable local amd64 container with `--init`, clean image home, UID/GID 1000, the candidate bind-mounted at its original absolute path, and common Git metadata mounted readonly. Docker CLI/socket access supports the tests' disposable Redis containers. An explicit persistence-disabled fixture Redis is provided; `TOOL_SERVER_BACKEND_SOCKET` is cleared so production image defaults cannot redirect test clients. No production data, credentials, services or configuration is mounted.

Two host failures were reproduced on pinned upstream `3493c0c6` before being classified:

- The operator fixture used a fixed port already occupied on the host. It now binds its real `Bun.serve` listener to port zero through a test-only spy and uses the returned URL. Production ports are unchanged.
- Host-global skill/prompt overlays exceeded an inherited small compaction-fixture budget. The unchanged test passes in a clean image home. No budget inflation or production behavior change was retained.

Earlier container attempts without init, Docker CLI or normalized backend-socket environment failed for those environment reasons and are not passing evidence. Current full checks pass under the documented isolated setup. Three inherited Oxlint warnings remain (unused disposal bindings and a throwing async-generator test); lint reports zero errors. No required check is waived.

## Focused evidence

Domain reports name the source boundaries and regression families. Focused Telegram/memory/workflow suites passed 941 tests; command suites passed 53; provider/compaction/config suites passed 389. The independent Core reviewer ran 40 tests with 230 assertions. Runtime/native recording, authenticated-origin, Redis cleanup and publication YAML shell-gate suites also passed. Their meaningful regressions and review corrections are described in REVIEW.md.

`bun run build:web` and `bun run build:installer` passed. Installer verification is local linux-x64. The offline historical migration suite passed 46 tests at `f2c90667ac5616796c992602ca5fb5be726cf40d`, plus four supplemental legacy/current/mixed/corrupt fixture cases with 20 assertions. The retained supplemental fixture proves dry-run, backup/restore file-map/hash integrity and migrated-byte integrity; see migration.md for reproduction and support limits.

## Image and deployment boundary

Earlier frozen-context default/Catalina/Claudia images passed the expanded image verifier; delivery.md records their precursor IDs and explicitly identifies their earlier source snapshot. Final images must be rebuilt from the committed reconciled HEAD, with its full SHA and `dirty=false` build metadata, then checked using `bun run docker:verify-image -- IMAGE USER UID`. The follow-up PR records those final tags, IDs and results.

Local amd64 checks do not certify arm64, live Telegram/OpenAI gateways, GitHub/GHCR execution or an installed data baseline. Deployment requires the documented offline migration/backup/restore gate when applicable, matching Core/client artifacts, actual provider smoke checks and exact artifact identity. No merge, deployment, production restart or live migration was performed by this agent.
