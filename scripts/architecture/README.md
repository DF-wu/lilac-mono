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
