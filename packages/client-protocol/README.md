# Native client protocol

Version 1 contracts for the [native surface](../../docs/native-surface.md). These
schemas describe display state and commands. Core owns authorization, durable admission,
resource resolution and execution; importing this package does not start a backend.

`src/rpc.ts` exports `nativeContract`, a contract-first oRPC router. It covers authenticated bootstrap,
thread lifecycle and synchronization, participants, user tool modes, input/queue controls, static
catalogs, resource reservations, config, search and read-only external views. Expected domain failures
use the closed `nativeErrorMap`; Core converts its internal Results at the gateway boundary.
`AUTH_REFRESH_REQUIRED` remains distinct from signed-out `UNAUTHENTICATED`.

`src/replay.ts` defines strict checkpoint, window, delta, deferred-slot, hydration and live-update
schemas. A delta names its required `fromRevision` and contains the continuous changes through its
checkpoint. A window can mix ready turns and unresolved ranges. Hydration replaces a matching slot
without advancing the live checkpoint. Huge turns use a separate bounded `turnPage` cursor. Its `messages` introduce message metadata
once and `chunks` fill complete parts at explicit message/part indices. Projection splits long text
into bounded parts before paging; clients apply pages only against their requested version/cursor. Window,
delta, live, hydration and turn-page payloads have a 256 KiB encoded byte ceiling.

Display messages are assignable to AI SDK `UIMessage`. Text and custom `data-*` parts carry visible
activity, resources, compaction and input disposition. Stable identity/author metadata travels on
message insertion; text patches contain only target identity and appended text. No provider prompt,
hidden reasoning or arbitrary debug payload belongs in this protocol.

Text metadata preserves explicit provider phases. For providers without phase labels, the backend
publishes text as commentary and promotes the last unlabelled text block to final on normal turn
completion, unless an explicit final block already exists. `metadata.incomplete` survives normal
completion after length exhaustion. `message-meta` patches change only phase/incomplete flags; stable
author/time metadata is not retransmitted. Recovery restores these flags with the retained text.

`src/domain.ts` defines safe display catalogs and mutation inputs. Server-owned entity identifiers are
bounded ASCII. Existing model/skill/command identifiers use a separate bounded string schema so
configured names and paths remain valid. Client display capabilities never grant authority; Core
checks the authenticated actor and thread starter at each operation.

Browser callers import `NativeContract` as a type, leaving schemas, Core and the AI SDK runtime out of
the client bundle. The installed oRPC version is pinned to 1.15.1. Its Bun adapter is
`@orpc/server/bun-ws`. `nativeSyncContract` remains the narrow transport-proof contract, not the full
production router. The reducer under `tests/support` is a fixture model; `packages/client` owns the
production reducer and cache.

Tests use an actual loopback Bun WebSocket, runtime schema checks, replay fixtures and a browser-target
bundle. The no-change request/ACK proof includes masked WebSocket framing and stays below 1 KiB even
at maximum entity identifier lengths.

Run from the repository root:

```sh
bun run --filter=@stanley2058/lilac-client-protocol test
bunx tsc -p packages/client-protocol/tsconfig.json --noEmit
```
