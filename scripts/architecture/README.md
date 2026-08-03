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
