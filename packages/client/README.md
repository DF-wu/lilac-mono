# Native client

Framework-independent client for web and terminal surfaces. No React or Solid imports.

`createNativeRPC(socket)` exposes the complete contract over one existing WebSocket.
`NativeClient` coordinates that connection with HTTP bootstrap, catalog/thread subscriptions,
background history reads, replay state, cache writes and input retries.

## Startup

Pass a principal/installation-scoped `CacheScope`, an authenticated HTTP `bootstrap` callback and
an `openSocket` factory. `start(threadId)` starts the socket immediately, loads the cached selected
thread, and includes its checkpoint in bootstrap. Bootstrap owns initial content. The socket watch
attaches at that watermark, so it does not request a second initial snapshot.

For a first visit without cached identity, start HTTP bootstrap and the socket in parallel. Once
bootstrap supplies identity, construct the client with that scope, the already-created socket,
and a callback that returns that first bootstrap response once before using normal HTTP fetches.
HTTP callbacks should translate authentication responses into `ORPCError("UNAUTHENTICATED")`.
A selected-thread authorization failure belongs in the successful bootstrap's thread result.

Use `selectThread(id)` for navigation. `thread(id)` immediately returns the stable store. Subscribe
to `store.subscribeSlot(slotId, callback)` for row updates and `store.subscribe(...)` for structural
changes. `slotIds` retains its identity for text/activity-only changes. `get(slotId)` returns a stable
slot identity until that slot changes. Avoid mapping every loaded turn in a render subscription.

`hydrate(threadId, slotId)` fills a deferred/failed range. Requests for an abandoned thread are
canceled on navigation. `loadTurnPage(threadId, slotId)` extends a large turn with bounded part pages.
The caller chooses the visible/overscan window and schedules older requests between foreground work.
Both methods reject stale generation, revision and cursor results.

The client retains at most eight inactive thread stores. The selected thread, active subscriptions and
UI-observed stores stay resident. In no-cache mode, inactive unobserved stores are released. Eviction
keeps queued atomic cache writes intact; restoring an evicted thread waits for its pending write so it
cannot reload an older checkpoint.

## Persistence

`NativeCache.commit` atomically persists each patch's changed slots, removals and checkpoint. A reset
sets `replace: true`. Implementations must never persist the cursor before its data. The coordinator
serializes writes per thread without blocking display or input. Cache exceptions produce an error
event and do not stop in-memory rendering. `MemoryNativeCache` and `NoNativeCache` are provided;
web supplies IndexedDB, while the temporary operator TUI uses `NoNativeCache`.

All cache keys include installation, principal and protocol/projection versions. Revocation clears
the thread and drains queued writes before removing persisted data. Logout clears all private stores
and catalogs before emitting `logged-out`. Downloaded data cannot be recalled from another client.

## Commands and connection state

Allocate one `commandId` when the user sends. `submit(input)` returns `accepted`, `rejected`, or
`uncertain`. An uncertain response means the server may have accepted it. `retry(commandId)` reuses
the exact payload and ID; do not construct another command. Resolved receipt memory is bounded to
256 commands. Pending sends are retained in memory, not presented as durable offline admission.

Retryable connection failures emit `offline`; other failures emit `error`. A close reconnects with
bounded jittered exponential backoff. `reconnect()` bypasses backoff and replaces the socket without
clearing thread stores or pending commands. `connectionState` becomes `online` after both the socket
and bootstrap are ready. Web clients call `reconnect()` when returning to the foreground or network.
`reauthenticate(token)` refreshes the connection identity. Switching principal logs out rather than
reusing a private store. `dispose()` aborts subscriptions, waits for their protocol cleanup and closes
the socket. Await it when shutting down a test or terminal process.
