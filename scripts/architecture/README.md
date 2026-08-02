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
