# Stage 6 Architecture Infrastructure

Stage 6 introduced the persistence and SQLite contracts retained by the permanent architecture gate.
Every registration is active immediately; there is no advisory state.

## Persisted Codecs

Each `persistedCodecs` entry names one exact callable, its persisted input parameter, one exact fixture
catalog, and its complete success provenance. Every registration requires all of the following:

- The callable returns a direct `better-result` Result.
- Success is `{ value: Decoded; provenance }` with the exact provenance union declared by the
  registration. `current` and `migrated` are required; `missing-defaulted` is declared only when
  absence has a genuine default contract.
- Decoded success and owned error types recursively exclude `any`, `unknown`, and `never`.
- The fixture catalog is an explicit object with exactly `current`, `legacy`, `missing-defaulted`,
  `unsupported-version`, `malformed-serialization`, and `corrupt-fields`.
- Current and legacy cases declare `ok` with `current` and `migrated` provenance. The missing case
  declares `ok` with `missing-defaulted` only when that provenance is registered; otherwise it declares
  `error`. Unsupported, malformed, and corrupt cases declare `error` and no provenance.
- The codec identity is linked in `operationalResultApis`.

`persistedStoreConsumers` links store policy to the codecs it must invoke. A registered consumer must call
every declared codec and be linked in `operationalResultApis`.
`lilac/no-store-inline-decoding` prohibits `JSON.parse`, Zod-style `parse`, `safeParse`, and async variants
inside that consumer or nested callbacks. Decoding belongs in the registered codec, not in the store.

## SQLite Results

`sqliteTransactionAdapters` names the adapter, database and operation parameters, rollback sentinel,
Panic classifier, and SQLite driver classifier. A registered adapter must:

- Accept a real `bun:sqlite` `Database` and a callback returning a direct Result.
- Invoke `Database.transaction` with a callback returning a plain value.
- Throw one exact non-exported sentinel when the logical callback returns Err.
- Recover only that sentinel immediately outside the driver callback.
- call exact `better-result#Panic.is` and rethrow the same Panic;
- call the exact registered driver classifier and return only recognized driver failures as Err;
- rethrow every unrecognized thrown value as a defect; and
- be linked in `operationalResultApis`.

`architecture/no-result-err-in-sqlite-callback` resolves the actual `bun:sqlite` callback and
`better-result` return declarations. It rejects both inline `Result.err` and named callbacks whose return
type contains `Err`, preventing a raw callback from committing after a logical failure.

`sqliteTransactionConsumers` must invoke their exact adapter and link to `operationalResultApis`.
`lilac/no-direct-sqlite-transaction` prohibits direct `.transaction()` and SQL
`BEGIN`, `COMMIT`, or `ROLLBACK` in the registered symbol and descendants. The adapter itself remains the
only registered rollback exception boundary.

## Registration

1. Land the codec or adapter and focused real compatibility/atomicity tests.
2. Add every public or operational Result-returning consumer to `operationalResultApis`.
3. Add each registration-owned module to the exact semantic rule zone. Manifest integrity rejects broad,
   missing, extra, or stale zones.
4. Run architecture tests, lint-rule tests, architecture and lint-plugin typechecks, the architecture
   runner, lint, and formatting.

The real fixtures under `fixtures/real-libraries` use installed `better-result` 3.0 and `bun:sqlite`.
They execute all six persistence outcomes and prove commit, logical Err rollback, recognized driver
failure mapping, and exact Panic identity propagation against an in-memory SQLite database.
