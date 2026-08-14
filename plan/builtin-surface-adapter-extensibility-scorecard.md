# Built-In Surface Extension Scorecard

Status: completed post-cleanup scorecard (2026-08-14). This records the shared production edits an
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
| Accidental routing | `apps/core/src/runtime/surface-runtime-lifecycle.ts` | Recovery agent preflight recognizes built-in request clients through platform literals. | No ordinary-adapter edit. Recovery recognizes the closed catalog, then requires the registered descriptor and relay. |
| Accidental routing | `apps/core/src/tool-server/tools/programmatic-workflow.ts`, `apps/core/src/workflow/workflow-action-resolver.ts` | Workflow targets and normalized action interpretation repeat the built-in platform set. | No ordinary-adapter edit. Explicit targets resolve registered progress ports and actions resolve registered protocols before durable authorization. |
| Accidental routing | `apps/core/src/transcript/transcript-store.ts` | Recent-write and discovery reads project only Discord and GitHub linked refs. | No ordinary-adapter edit. Persisted rows decode broadly and built-in refs project through the static catalog. |
| Accidental composition | `apps/core/src/runtime/create-core-runtime.ts` | Discord health checks call the concrete adapter directly in the runtime root. | No ordinary-adapter edit unless health participation is desired. Optional descriptor health contributions are protocol-owned and registry-aggregated. |
| Accidental routing | `apps/core/src/tools/subagent.ts` | Shared subagent request-context construction repeats built-in platform selection. | No ordinary-adapter edit. It consumes `SurfacePrincipal`; plugin request contexts are generic in their platform type. |
| Closed ref contract | `apps/core/src/surface/types.ts` | Add the adapter's `SessionRef` and `MsgRef` variants; this is the authoritative implemented-ref contract, not routing duplication. | One shared production edit: add matching closed ref variants. |
| Static protocol catalog | `apps/core/src/surface/builtin-surface-protocols.ts` | No pre-migration catalog existed. | One shared production edit: add the exhaustive protocol entry for the closed ref platform. |
| Static composition | `apps/core/src/runtime/compose-builtin-surface-runtimes.ts` | Composition was inline in the Core root. | One shared production edit: add the explicit executable descriptor composition entry. |
| Static construction | `apps/core/src/runtime/create-core-runtime.ts` | Concrete built-in adapters are still constructed at the Core root before static composition. | One shared production edit: construct and pass the adapter. This remains separate from descriptor composition. |
| Shared contract harness | `apps/core/tests/surface/reference-adapter-contract.test.ts` | No catalog-backed common harness covered both references. | Add the adapter case to the shared contract harness. This is a test edit, not a shared production edit. |
| Protocol-local implementation | `apps/core/src/surface/<platform>/` | Implement the adapter plus protocol-local ingress, output, relay policy, descriptor factory, and optional sidecars. | Required protocol-local work; it does not count as a shared production edit. |

Pre-migration accidental shared-routing total: 8 identified files. Post-cleanup ordinary adapter total:
4 shared production edits (`surface/types.ts`, `builtin-surface-protocols.ts`,
`compose-builtin-surface-runtimes.ts`, and adapter construction in `create-core-runtime.ts`). The shared contract harness is test-only, and protocol-local
files do not count. This meets the two-to-four target, excluding the independently owned rows below.

## Independently Owned Contracts And Boundaries

| Classification | Owner or touch point | Ordinary adapter expectation | Post-migration result |
| --- | --- | --- | --- |
| Config | `packages/utils/core-config.ts`, `packages/utils/config-templates/core-config.example.yaml` | Only when the adapter owns new operator configuration. | Separately reviewed; no edit for an ordinary adapter without new configuration. |
| Wire | `packages/event-bus/lilac-spec.ts` and compatible event fixtures | None when using an existing wire platform/value; required for a new wire contract. | Separately reviewed; unchanged for the ordinary existing-wire-platform path. |
| Persistence | Owning SQLite codecs and schema migrations | None for a thin adapter; required only for adapter-owned durable state. | Separately reviewed; no codec or migration is derived from the catalog or registry. |
| Recovery | `apps/core/src/runtime/graceful-restart-store.ts` and `apps/core/src/runtime/surface-runtime-lifecycle.ts` | None unless the adapter participates in persisted relay or restart recovery. | Runtime preflight is catalog/registry-driven; persisted snapshot readers remain explicit and independently reviewed. |
| Workflow | `apps/core/src/workflow/` domain, store, and progress owners | None unless the adapter opts into workflow actions/progress with durable semantics. | Registered progress ports and protocols provide routing; persistence and durable authorization remain independently reviewed. |
| Transcript | `apps/core/src/transcript/` | None unless transcript links or continuation need an adapter-specific stored contract. | Generic read projection follows the catalog; persisted codecs and continuation contracts remain independently reviewed. |
| Health | Optional descriptor health port | None for an adapter without persistent health semantics. | Protocol-local health contributions participate without another Core-root platform branch. |
| Rich protocol parity | `surface/types.ts`, `surface/adapter.ts`, `surface/events.ts`, `surface/protocol.ts`, and `surface/authenticated-request.ts` | Review when an adapter needs new participant provenance, output-routing hints, guild-like capabilities, shared commands, or specialized verified-ingress proof. | Existing Discord/GitHub vocabulary remains an intentional shared-contract limitation. It does not block ordinary participation, but richer parity can require additional shared contract edits. |
| Plugin-compatible context | `packages/plugin-runtime/` and Core request-context plumbing | Review only when a plugin-visible contract must change. | Separately reviewed; generic platform context avoids another built-in principal-union edit and does not change runtime context shape. |
| External boundary | Protocol ingress plus `scripts/architecture/manifest.ts` registrations | Required for actual external SDK, gateway, webhook, CLI, or host boundary handling. | Separately reviewed; ingress remains the existing external authentication owner, with no new trust admission. |

## Post-Migration Verification

| Measure | Result |
| --- | --- |
| Shared production edits for an ordinary built-in adapter | 4: closed refs/types, built-in catalog, static composition, and concrete adapter construction. |
| Meets the two-to-four shared-production-edit target | Yes. |
| Shared contract harness | One test registration; excluded from production-edit total. |
| Protocol-local files | Required but excluded from shared production-edit total. |
| Intentional config/wire/persistence/recovery/workflow/transcript/rich-parity/plugin/external reviews recorded separately | Yes; each remains independently owned and is not implied by registry registration. |
