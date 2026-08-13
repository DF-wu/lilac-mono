# Built-In Surface Extension Scorecard

Status: completed post-migration scorecard (2026-08-14). This records the shared production edits an
ordinary built-in adapter using an existing event-bus platform encounters after the routing migration.
It distinguishes the closed ref contract from shared routing and independently owned contracts and
boundaries. No production behavior or contract is changed by this scorecard.

## Ordinary Adapter

| Classification | Pre-migration shared production touch point | Why an adapter edit is currently needed | Post-migration result |
| --- | --- | --- | --- |
| Accidental routing | `apps/core/src/surface/runtime-descriptor.ts` | Registry guard and resolver enumerate Discord and GitHub. | No ordinary-adapter edit. The registry binds descriptors by their protocol platform, owns guarded adapter and workflow-port wrapping, and invokes descriptor factories. |
| Accidental routing | `apps/core/src/tool-server/tools/surface.ts` | Tool target construction, request-ID defaults, help, and a non-GitHub Discord fallback select platforms here. | No ordinary-adapter edit. Generic tool routing uses the selected protocol's target routing. |
| Accidental routing | `apps/core/src/surface/authenticated-request.ts` | Trusted normalized request projection reconstructs built-in refs through Discord/GitHub branches. | No ordinary-adapter edit. Generic correlated normalized identity routing selects the built-in protocol; protocol-local projection remains local. |
| Accidental routing | `apps/core/src/tool-server/request-message-cache.ts` | Alias projections reconstruct Discord/GitHub session refs locally. | No ordinary-adapter edit. Shared ref construction uses protocol routing. |
| Accidental routing | `apps/core/src/workflow/workflow-progress-projector.ts` | Workflow progress correlation reconstructs message refs through a platform switch. | No ordinary-adapter edit. Shared decoding uses protocol routing; workflow policy remains owned by the workflow domain. |
| Accidental routing | `apps/core/src/runtime/create-core-runtime.ts` | Built-in adapter, relay, ingress, and descriptor composition is inline and platform-specific. | Replaced by one static composition edit in `apps/core/src/runtime/compose-builtin-surface-runtimes.ts`. |
| Accidental routing | `apps/core/src/surface/bridge/bus-agent-runner.ts` | Shared request and output plumbing repeats built-in platform selection for ref and origin behavior. | No ordinary-adapter edit. It consumes the shared principal and protocol-routed refs. |
| Accidental routing | `apps/core/src/tools/subagent.ts` | Shared subagent request-context construction repeats built-in platform selection. | No ordinary-adapter edit. It consumes `SurfacePrincipal`; plugin request contexts are generic in their platform type. |
| Closed ref contract | `apps/core/src/surface/types.ts` | Add the adapter's `SessionRef` and `MsgRef` variants; this is the authoritative implemented-ref contract, not routing duplication. | One shared production edit: add matching closed ref variants. |
| Static protocol catalog | `apps/core/src/surface/builtin-surface-protocols.ts` | No pre-migration catalog existed. | One shared production edit: add the exhaustive protocol entry for the closed ref platform. |
| Static composition | `apps/core/src/runtime/compose-builtin-surface-runtimes.ts` | Composition was inline in the Core root. | One shared production edit: add the explicit executable descriptor composition entry. |
| Shared contract harness | `apps/core/tests/surface/reference-adapter-contract.test.ts` | No catalog-backed common harness covered both references. | Add the adapter case to the shared contract harness. This is a test edit, not a shared production edit. |
| Protocol-local implementation | `apps/core/src/surface/<platform>/` | Implement the adapter plus protocol-local ingress, output, relay policy, descriptor factory, and optional sidecars. | Required protocol-local work; it does not count as a shared production edit. |

Pre-migration accidental shared-routing total: 8 identified files. Post-migration ordinary adapter total:
3 shared production edits (`surface/types.ts`, `builtin-surface-protocols.ts`, and
`compose-builtin-surface-runtimes.ts`). The shared contract harness is test-only, and protocol-local
files do not count. This meets the two-to-four target, excluding the independently owned rows below.

## Independently Owned Contracts And Boundaries

| Classification | Owner or touch point | Ordinary adapter expectation | Post-migration result |
| --- | --- | --- | --- |
| Config | `packages/utils/core-config.ts`, `packages/utils/config-templates/core-config.example.yaml` | Only when the adapter owns new operator configuration. | Separately reviewed; no edit for an ordinary adapter without new configuration. |
| Wire | `packages/event-bus/lilac-spec.ts` and compatible event fixtures | None when using an existing wire platform/value; required for a new wire contract. | Separately reviewed; unchanged for the ordinary existing-wire-platform path. |
| Persistence | Owning SQLite codecs and schema migrations | None for a thin adapter; required only for adapter-owned durable state. | Separately reviewed; no codec or migration is derived from the catalog or registry. |
| Recovery | `apps/core/src/runtime/graceful-restart-store.ts` and `apps/core/src/runtime/surface-runtime-lifecycle.ts` | None unless the adapter participates in persisted relay or restart recovery. | Separately reviewed; snapshot readers and recovery admission remain explicitly owned and unchanged. |
| Workflow | `apps/core/src/workflow/` domain, store, and progress owners | None unless the adapter opts into workflow actions/progress with durable semantics. | Separately reviewed; descriptor workflow-progress participation does not change workflow persistence or authorization. |
| Transcript | `apps/core/src/transcript/` | None unless transcript links or continuation need an adapter-specific stored contract. | Separately reviewed; no transcript schema change for the ordinary path. |
| Plugin-compatible context | `packages/plugin-runtime/` and Core request-context plumbing | Review only when a plugin-visible contract must change. | Separately reviewed; generic platform context avoids another built-in principal-union edit and does not change runtime context shape. |
| External boundary | Protocol ingress plus `scripts/architecture/manifest.ts` registrations | Required for actual external SDK, gateway, webhook, CLI, or host boundary handling. | Separately reviewed; ingress remains the existing external authentication owner, with no new trust admission. |

## Post-Migration Verification

| Measure | Result |
| --- | --- |
| Shared production edits for an ordinary built-in adapter | 3: closed refs/types, built-in catalog, and static composition. |
| Meets the two-to-four shared-production-edit target | Yes. |
| Shared contract harness | One test registration; excluded from production-edit total. |
| Protocol-local files | Required but excluded from shared production-edit total. |
| Intentional config/wire/persistence/recovery/workflow/transcript/plugin/external reviews recorded separately | Yes; each remains independently owned and is not implied by registry registration. |
