# Stage 7 Package Integration

`WORKSPACE_STATUSES` is the only package-status registry. Every active workspace has one explicit
`inventory`, `migrating`, or `migrated` value. Changing a workspace to `migrated` automatically enables
every rule in `FINAL_PACKAGE_WIDE_ARCHITECTURE_RULES` over the single `**` zone. Registration-owned
persistence, event, tool, projection, and SQLite rules remain on exact modules.

The runner executes `assertStage7EnforcementPreflight` before checking or inventorying. A migrated
workspace is rejected when a final package rule is not package-wide, an enforced registration lacks its
exact rule zone, a registered Result-bearing boundary is absent from `operationalResultApis`, or either
semantic or syntax baseline still contains an entry for the workspace.

## Per-Package Procedure

1. Run `bun scripts/architecture/runner.ts inventory` and isolate the package's findings. Also inspect all
   entries for the package in `syntax-baseline.mts`.
2. Set the package status to `migrating` before integrating partial enforcement. Do not mark it migrated
   to discover debt; the preflight deliberately rejects that state.
3. Classify each unknown as decoded domain data, an exact capability check, an opaque pass-through value,
   an external exception cause, or an invalid internal contract. Register only exact boundary,
   capability, opaque, and exception owners.
4. Register each real custom decoder in `boundaryDecoders` or the specialized Result, persistence, tool,
   event, or open-protocol registry. Keep every specialized rule zone on the decoder or consumer's exact
   module.
5. Migrate expected failures as complete vertical slices. Add every operational Result-returning API,
   enforced Result decoder, persisted codec/consumer, SQLite adapter/consumer, and event delivery
   API/consumer to `operationalResultApis`.
6. Resolve all package findings for package-wide boundary, union, Result, redaction, and Panic rules, and
   all rules in `FINAL_PACKAGE_WIDE_SYNTAX_RULES`. Register exact Panic sites and exception/framework
   adapters rather than broad modules.
7. Remove the package's semantic and syntax baseline entries only after the corresponding production
   findings are fixed. Do not regenerate either baseline for migrated code.
8. Change the package's `WORKSPACE_STATUSES` value to `migrated`. Run the architecture tests, lint-rule
   tests, architecture and lint-plugin typechecks, `runner.ts check`, the syntax ratchet, and
   `runner.ts inventory`.

The inventory command expands only `PACKAGE_WIDE_ARCHITECTURE_RULES`. It intentionally preserves every
zone in `EXACT_REGISTRATION_ARCHITECTURE_RULES`, so inventory cannot turn a reviewed exact registration
into a package-wide exemption or enforcement claim.
