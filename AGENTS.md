# AGENTS.md

## Quick Repo Facts

- Use `bun`
- Monorepo: **Bun workspaces** (`apps/*`, `packages/*`).
- Markdown plans/todos in `plan/*`.
- Project mental model / terminology: search `PROJECT.md`.
- `ref/` contains vendored/reference projects. Treat as read-only references.
- Treat private internal APIs as greenfield and generally free to break. Preserve existing wire, persisted-data, filesystem-tool, and plugin contracts unless a separate compatibility change is explicitly approved.

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

- **No `any`** and **no `as any`**.
- Prefer unions and discriminated unions for error/results.
- Prefer `Record<string, T>` to `{ [k: string]: T }`.
- Prefer `readonly T[]` when you don’t mutate.
- Use `satisfies` when validating object shapes without widening.

### Trust boundaries and runtime validation

- Keep `unknown` at real trust boundaries. Decode it immediately and return a typed value.
- Do not accept `unknown` in an internal function merely because its caller received external data. Decode in the caller's boundary adapter and type the internal parameter.
- Decode again across each process, wire, persistence, plugin, or SDK boundary.
- Use Zod for rich external structures. Validate the complete envelope and every payload field used after parsing.
- Do not call `parse` or `safeParse` in ordinary service, domain, orchestration, or render functions. Use a registered boundary decoder, projection, or persistence codec; domain constructors accept typed values.
- Keep boundary schemas and `z.output` types together. Use `z.input` explicitly when input and output differ.
- Do not write generic `parseJson<T>` helpers that establish `T` only through an assertion.
- Persisted-data codecs must explicitly handle valid current data, supported legacy data, unsupported versions, malformed serialization, and corrupt fields.

### Predicates and unions

- Use `isX` for semantic predicates over typed values or exact capability checks.
- Do not use a partial `isX(value: unknown): value is RichType` guard. Use a complete schema-backed decoder when downstream code relies on a rich structure.
- For project-owned discriminated unions, prefer direct discriminant checks, exhaustive switches, or precise `Extract`-based predicates.
- Never add a local `isRecord`; use the centralized utility only for small boundary inspections.
- Do not write nested ternaries. Extract the decision or use a switch.
- Treat project-owned unions as closed and handle every member with an exhaustive switch or exhaustive typed map. Do not hide an unhandled member behind a silent `default`, generic fallback, or final ternary arm.
- Treat third-party/open protocols as open only in their adapter. Normalize unknown variants to an explicit local fallback before internal use.

### Assertions

- Never cast `unknown` to a structured domain type and never use `as unknown as T`.
- A cast is not a substitute for boundary validation or a typed function signature.
- Assertions are allowed only for documented representation-preserving bridges where the source is already typed and TypeScript cannot express the relationship.
- Prefer fixing producer and consumer signatures over adding a cast or guard.

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

### Errors as values

- Return expected failures as `Result<T, E>` or `Promise<Result<T, E>>`; do not throw or reject them.
- Use `better-result` directly. The root catalog pins the exact version and every importing workspace declares `"better-result": "catalog:"`.
- Define expected error variants in the owning domain's vocabulary. Prefer `TaggedError` variants with stable `_tag` discriminants over strings or generic `Error`.
- Instantiate a `TaggedError` and return it with `Result.err`; never throw it.
- Catch an external exception only in the smallest immediate adapter and map it to a specific typed error. Do not pass `unknown`, `UnhandledException`, SDK errors, or driver errors to consumers.
- Use `Result.gen` and `Result.await` for multi-step linear workflows. Keep effects in named Result-returning functions and generator bodies declarative.
- Use direct `result.status` branching for one or two steps. Handle or translate the complete error union at the next policy boundary.
- Do not use `unwrap`, unsafe Result codecs, or generic `Result.try`/`tryPromise` in production flow.
- Keep Result callbacks total. Capture throwing or rejecting operations before passing values into combinators, collection helpers, or a Result generator.
- For a stream that can fail after yielding data, use `AsyncIterable<Result<TChunk, TTerminalError>>`; yield one terminal Err and close rather than rejecting for an expected failure.
- Use Panic only for an individually registered unrecoverable defect or hard invariant. Never convert a Panic to an ordinary Err.
- Do not wrap total helpers in Result or flatten meaningful state-machine outcomes such as cancelled, stale, expired, or skipped into generic success/error.
- Do not serialize `better-result` objects or TaggedErrors onto existing contracts. Map them to the existing wire, storage, tool, or plugin representation at its compatibility adapter.
- Never pass a TaggedError to implicit `JSON.stringify` or generic structured logging because `toJSON()` includes `cause`. Emit only an approved tag, message, and explicitly safe fields. Until the Stage 1 repository formatter lands, construct that safe representation explicitly; afterward, use the formatter.
- Avoid leaking secrets in logs; redact tokens and keys when printing command or environment data.

### Framework edges

- `try/finally` is allowed for cleanup; catch clauses are restricted to registered adapters and defect supervisors.
- A result-to-framework adapter may signal an exception only when the host contract requires rollback, delivery parking, stream termination, or callback failure.
- SQLite transaction bodies must not return Err after partial writes unless a transaction adapter turns that Err into a private rollback sentinel and converts it back immediately outside.
- Event handlers return typed delivery Results. After migration, subscription policy maps each error to commit, park-pending, dead-letter, or stop; handlers do not acknowledge messages directly.
- Cancellation is a typed expected result. Capture external abort rejections using the exact owned `AbortSignal`; do not classify arbitrary errors solely by an `AbortError` name.
- If `Result.tryPromise` stops an aborted retry delay, return its latest Err rather than synthesizing cancellation. When cancellation must remain distinct, use a cancellation-aware adapter that checks the owned signal around every attempt and delay, or do not use built-in retry.
- Expected cleanup returns Result explicitly: cleanup Err wins after a successful main operation; if both fail, return a domain-owned combined failure preserving both. A rollback failure that leaves atomicity unknown is a Panic. Do not put expected throwing cleanup in a Result generator's `finally` block.

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
