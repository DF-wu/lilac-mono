# AGENTS.md

## Quick Repo Facts

- Use `bun`
- Monorepo: **Bun workspaces** (`apps/*`, `packages/*`).
- Markdown plans/todos in `plan/*`.
- Project mental model / terminology: search `PROJECT.md`.
- `ref/` contains vendored/reference projects. Treat as read-only references.
- Treat project as greenfield, breaking changes are usually ok. Consult with user whether to include backwards compatibility when introducing breaking changes.

## Finding Type Definitions (Bun + symlinks)

This repo uses Bun's install layout. Many packages in `apps/*/node_modules` are symlinks into Bun's cache under `node_modules/.bun/...`. If you can't find a type definition by searching the workspace `node_modules`, follow the symlink and then follow `package.json` `exports`/`types`. Always use `ls -al` because the `grep`, `glob` don't work on ignored files and dot-dirs.

## Build / Test / Typecheck

### Build

- `apps/core`: `cd apps/core && bun run build:remote-runner` (`bun run test` builds this automatically for the remote-runner parity test)
- `apps/tool-bridge`: `cd apps/tool-bridge && bun run build`
- `apps/acp-controller`: `cd apps/acp-controller && bun run build` (`lilac-acp`)

### Testing (Bun)

Tests use Bun’s built-in runner + `bun:test`.

- Every newly added workspace package under `apps/*` or `packages/*` must define a `test` script in its `package.json`.
- Tests that intentionally trigger errors or warnings must suppress the expected console/logger output and restore mocks afterward so test output stays high-signal.

- Run all tests in a package:
  - `cd apps/core && bun run test`
  - `cd packages/utils && bun run test`
  - `cd packages/event-bus && bun run test`

- Run all root and workspace tests from repo root:
  - `bun run test:all`

- Run a single test file:
  - `cd apps/core && bun test tests/tools/bash.test.ts`
  - `cd packages/event-bus && bun test tests/redis-streams-bus.test.ts`

- Run a single test by name (regex):
  - `cd apps/core && bun test --test-name-pattern "<pattern>"`

### Test timing

- Do not use fixed-time sleeps or waits to synchronize tests. Await the observable operation, resolve a deferred from the callback/event under test, or use an injected/fake clock.
- Real-time waits are allowed only when elapsed time is itself the behavior under test and a fake clock cannot cover it safely.
- Every allowed real-time wait must have an immediately preceding, specific justification:
  - `// test-wait-justification: verifies the real idle deadline while monitoring is paused`
- Rejection-only timeout guards are allowed because they do not delay the successful path.
- `lilac/no-fixed-test-wait` enforces this policy through Oxlint for test files. Run its focused tests with `bun run test:lint-rules`.

### Typechecking

- Treat running `tsc` as essential (same tier as running tests).
- Run all root and workspace typechecks: `bun run typecheck`.
- Run typecheck in the package you changed:
  - `cd <package> && bunx tsc -p tsconfig.json --noEmit`

### Lint / Format

This repo uses Oxc tooling and local Oxlint rules at the root:

- Lint: `bun run lint` (`oxlint`, including local rules)
- Lint fix: `bun run lint:fix` (`oxlint --fix`, including local rules)
- Format check: `bun run fmt:check` (`oxfmt --check`)
- Format write: `bun run fmt` (`oxfmt --write`)

Before wrapping up any task that changes code/config/docs, run lint + format checks from repo root at least once as the final validation step:

- `bun run lint:fix`
- `bun run fmt`

## Code Style Guidelines (TypeScript)

### Types (important)

- ALWAYS prefer `zod` over manual type assertions/narrowing.
- **No `any`** and **no `as any`**.
  - If you must bridge unknown data, use `unknown` + narrowing.
  - Prefer using `zod` schemas to parse/validate `unknown` at boundaries (tool inputs, JSON/YAML, external APIs) when possible.
  - Prefer user-defined type guards:
    - `function isFoo(x: unknown): x is Foo { ... }`
- Prefer type narrowing over casting (`as Foo`) when possible.
- Prefer unions and discriminated unions for error/results.
- Avoid erasing discriminated unions by narrowing to generic shapes on values that are already strongly typed; prefer checking the discriminant (`part.type === "tool-result"`) or use a type guard that returns the precise union member.
- Never introduce new `isRecord` helpers, use centralized utils instead.
- Avoid `as unknown as SomeType` casts that effectively act like `as any` (they hide concrete types and break narrowing). Prefer proper narrowing, precise type guards, or compiler-assisted inspection (e.g. typehint) to find the real type.
- Prefer `Record<string, T>` to `{ [k: string]: T }`.
- Prefer `readonly T[]` when you don’t mutate.
- Use `satisfies` when validating object shapes without widening.

### Imports

- Group imports with blank lines:
  - External imports
  - Internal relative imports
- Prefer named exports over default exports.

### Naming conventions

- Files: `kebab-case.ts`.
- Functions/variables: `camelCase`.
- Types/interfaces/classes: `PascalCase`.
- Constants: `UPPER_SNAKE_CASE`.

### Error handling

- Convert unknown caught values safely:
  - e.g., `const msg = e instanceof Error ? e.message : String(e)`
  - For known error shapes, ensure logged error message is informative and traceable.
- Avoid swallowing errors silently.
- For library-like code:
  - Throw for programmer/configuration errors.
  - For runtime/IO failures, either throw with context or return a typed error object.
- Avoid leaking secrets in logs; redact tokens/keys when printing command/env data.

## Core Config

- `core-config.yaml` is parsed by versioned parsers in `packages/utils/core-config/*` into `UniversalCoreConfig`.
- v1 file shape is frozen: do not add keys to `coreConfigInputSchemaV1`; if `UniversalCoreConfig` gains fields, add v1 fallbacks in `parseCoreConfigV1ToUniversal`.
- When v1 and v2 shape/defaults diverge, update `MIGRATIONS.md`.
- When adding config options, update `packages/utils/config-templates/core-config.example.yaml`.

## Monorepo / references

- `ref/` is for reference material and vendored upstreams.
  - `ref/*` are git submodules and may not be checked out on a fresh clone.
  - Don’t copy rules from `ref/*` blindly; this repo’s active workspace is `apps/*` + `packages/*`.
- When reading external/library code:
  - Prefer `ref/` first (it often contains the upstream repo).
