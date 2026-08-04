# Semantic Architecture Checker

The checker uses the `typescript-codegen` TypeScript 6 compiler API and creates one `Program` for each
active workspace in `manifest.ts`.

Commands are available directly until root scripts are wired in a separate change:

```sh
bun scripts/architecture/runner.ts check
bun scripts/architecture/runner.ts inventory
bun scripts/architecture/runner.ts write-baselines --reason "reviewed Stage 0 inventory"
bun test scripts/architecture/architecture.test.ts
```

`write-baselines` keeps boundary-validation and failure-flow findings in separate package/rule maps.
Existing entries suppress matching findings, new findings remain errors, and stale entries are warnings.
Fingerprints use the owning symbol, syntax kind, and normalized local structure rather than line numbers.
`inventory` and `write-baselines` scan all supported rules across production files; `check` enforces only
the migration zones activated in the manifest.

This initial semantic checker owns only rules that use resolved symbols or types. Pure throw, catch,
rejection, nested-ternary, and duplicate-record-guard syntax remains owned by Oxlint and is deliberately
not duplicated here.

Stage 2 adds semantic checks for project-owned closed-union switches, exhaustive union-keyed maps, and
registered open-protocol normalization. Closed-union switch and map rules apply to all production
workspaces. Open-protocol rules apply only to exact registered adapter and consumer modules. A
registration names the exact adapter, external protocol type and parameter, and local fallback
discriminant/value; manifest integrity rejects blank fields and duplicate callable registrations, and
direct switching on the registered external type is allowed only inside that adapter.

The mini-client owns the raw stream trust boundary: `normalizeStreamChunk` converts `unknown` wire
values into a validated installed `UIMessageChunk`, representing a future non-data chunk with the
reserved `data-*` sentinel validated by `miniLilacUnsupportedUIMessageChunkSchema`. The TUI detects that sentinel and
performs its registered Zod subtype classification in `projectMiniLilacStreamChunk`, while
`projectUIMessageChunk` remains the exact open AI SDK adapter with its local unsupported fallback.
Malformed stream frames signal through the exact registered stream-host adapters, including the
`ChatTransport` rejection contract in `MiniLilacTransport.responseStream`.

Stage 3 zero-debt enforcement is declared by each workspace's `zeroBaselineScopes`. A scope owns either
an exact module or one exact symbol; both the semantic and syntax ratchets reject baseline entries in
that scope. Migrated workspaces still retain package-wide zero-debt enforcement.

Stage 4 adds manifest infrastructure for exact event codec registries, raw receive boundaries, delivery
APIs, delivery policies, and event-family migrations. Registrations use exact module/symbol identities
and zero-based parameter indexes. Family declarations must partition every registered canonical event
exactly once. A migrated family must have declared codec coverage and workspace-owned zero-baseline
scopes.

The event-bus codec, raw receive, handler Result, and delivery-policy foundations are enforced. Exact
`eventDeliveryConsumers` cover every production `subscribeTopic` and `fetchTopic` owner;
each consumer must own a matching symbol zero-baseline scope, and unregistered calls fail analysis.
All six event families are `migrated`: the manifest partitions all 25 canonical events, links each
family to exact cross-workspace delivery registrations and zero-baseline scopes, and requires complete
codec coverage. Enforced raw and typed APIs reject generic receive contracts, handler-owned `commit`
contexts, legacy API aliases, generic message specialization assertions, and unregistered production
consumers.

Stage 5 adds an exact presentation codec registry resolved against the shared Mini Lilac protocol
catalog of 14 canonical tool names, exact
Result-decoder registrations, and recursively unknown-free presentation modules. Enforced tool
registries must use an explicit or const-tuple-composed string tuple and an explicit object literal
with one codec per tool; the shared catalog may combine explicit executable and transcript-only const tuples, while broad
computed keys, duplicate keys, missing codecs, and extra codecs fail. Canonical and codec members are
read from those source declarations rather than copied into the manifest. Enforced Result
decoders are non-generic exact symbols that accept boundary data containing `unknown` and return a
direct `Result<Decoded, SpecificError>` whose success and error types recursively exclude `unknown`,
`any`, and `never`.

An enforced unknown-free module rejects `unknown` recursively through parameters, returns, aliases,
properties, nested imported contracts, method and call signatures, generics, maps, unions, callback
contracts, and local variables. Traversal has a fixed property budget and fails closed if that budget
is exhausted. Such a module may not own either kind of decoder registration. The syntax ratchet also
rejects runtime `zod` imports and value imports or calls of registered projection/decoder boundaries in
an enforced unknown-free module. Registered tool codec registry values and their exported or local
aliases are covered as well; type-only projection imports remain allowed.

The landed Mini Lilac tool catalog, codec registry, Result decoder, parser owners, and raw observation
adapters are enforced. The six Zod parser calls are owned by `parseInput`, `decodeBash` (two calls),
`decodeEditFile`, `decodeSubagentDelegate`, and `decodeWebsearch`; `projectToolObservation`,
`observationFromCanonicalPart`, and `UIMessageChunkProjectionState.toolChunk` own the raw projection
edges. `render.ts` and `transcript-buffer.ts` are recursively unknown-free, and runtime Zod imports are
forbidden there. Module-wide zero-baseline scopes cover render, UI-message projection, tool-observation
projection, and transcript buffering, including all descendant symbols.

Stage 6 adds registered persisted codecs, six-case compatibility fixture catalogs, exact persisted-store
consumers, and SQLite Result transaction adapters and consumers. Codec contracts require a direct
`Result<{ value; provenance }, SpecificStorageError>` with an exact declared provenance union. Fixture
catalogs must explicitly cover current, legacy, missing-defaulted, unsupported-version,
malformed-serialization, and corrupt-fields behavior; their static expected outcomes must agree with the
contract provenance.

An enforced persisted-store consumer must call every codec named by its registration. The syntax ratchet
then rejects inline `JSON.parse` and schema parse calls in that exact symbol and all descendants. An
enforced SQLite consumer must call its exact registered adapter; the syntax ratchet rejects direct
`.transaction()` and manual `BEGIN`, `COMMIT`, or `ROLLBACK` in the same descendant-aware scope. The
semantic callback rule resolves real `bun:sqlite` and `better-result` declarations and rejects a raw
driver callback whose return type or body can produce `Err`.

Transaction adapter validation requires one non-exported rollback sentinel, a raw callback returning a
plain value, exact `better-result#Panic.is` observation, an exact registered driver classifier, and
unknown-defect rethrow. Codec, adapter, and consumer identities must also be listed in
`operationalResultApis`. Enforced consumers require a zero-baseline scope that owns the registered symbol
and descendants in both semantic and syntax ratchets. See `STAGE6.md` for activation and fixture details.

Stage 7 adds the fail-closed package migration preflight, explicit status registry, permanent package-wide
semantic and syntax rule sets, unknown-member/custom-decoder provenance checks, and inventory isolation
for exact registration zones. See `STAGE7.md` for the per-package integration procedure.
