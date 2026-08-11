# Lilac Agent Guide

These rules apply to all tasks. Use the linked documents for detailed rules and commands.

## Scope

- Implement only the behavior that the user requests or an approved plan defines. Use the smallest
  solution that meets the requirements.
- Do not change an approved plan or its active checklist during implementation.
- Do not add cleanup, future features, protection for possible problems, or unrelated fixes. Record
  such work as residual work, but do not implement it.
- Follow product decisions and non-goals. Do not follow conflicting reviewer suggestions.
- Fix review findings that the current change causes. Also fix a finding if it proves that the change
  violates an acceptance criterion or fails a required check.
- Ask the user before you add a new contract, dependency, configuration option, or subsystem. Also ask
  before you add stored data, a queue, a journal, a worker, or a recovery process.
- Stop and ask if a fix needs a new product decision or increases the approved scope.

## Compatibility And Safety

- You can change private APIs. Do not change an existing wire contract, stored data contract,
  filesystem tool contract, or plugin contract without approval.
- Do not revert, overwrite, or include unrelated worktree changes.
- Use `ref/` only as a read-only upstream reference.
- Do not put credentials, tokens, private transcripts, or sensitive command data in outputs or files.

## Repository Information

- Use `bun` in this Bun workspace. The workspace packages are in `apps/*` and `packages/*`.
- Read `PROJECT.md` for terms, architecture, code locations, and subsystem owners.
- Read `scripts/architecture/README.md` before you change a trust boundary, persistence code, exception
  code, or architecture registration.
- Read `MIGRATIONS.md` before you change versioned configuration or a stored data contract.
- Use the root `package.json` scripts for build, test, typecheck, lint, and format operations.
- If a type is not visible, follow the `node_modules` symlink into `node_modules/.bun`. Inspect the
  package `exports` or `types` entry to find its type declarations.

## Work And Verification

- Use focused tests and the typecheck for each changed workspace.
- Run architecture checks when the change is in code that these checks control.
- Run full repository checks only for broad changes, the final plan check, or a user request.
- Do not use fixed waits to synchronize tests. Follow the `lilac/no-fixed-test-wait` rule.
- Commit or create a pull request only when the user requests it.
