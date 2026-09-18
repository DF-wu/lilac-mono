# Native client protocol

Stage 0 contract and transport proofs for the active [native surface plan](../../plan/native-surface.md).
Core does not serve these procedures yet. This is a partial, pre-release contract, not a usable native
backend or a promise that the complete protocol is settled.

`src/replay.ts` defines strict display checkpoint, window, deferred-slot, hydration and live-update
schemas. Display messages currently cover the AI SDK UIMessage text subset. Tools, resources and the
remaining message parts belong to subsequent implementation slices.

`src/rpc.ts` declares typed oRPC synchronization procedures. The runtime schemas stay available to the
server; browser callers import the contract type without bundling Core or the server implementation.
The installed oRPC version is pinned to 1.15.1. Its Bun adapter is `@orpc/server/bun-ws`; newer online
documentation may show the unified WebSocket adapter instead.

Tests run an actual loopback Bun WebSocket and browser-target bundle. The replay reducer under
`tests/support` is a proof model, not the production shared client. It will inform `packages/client`.
No authentication, admission, persistence, reconnect manager or public gateway is implemented here.

Run from the repository root:

```sh
bun run --filter=@stanley2058/lilac-client-protocol test
bunx tsc -p packages/client-protocol/tsconfig.json --noEmit
```
