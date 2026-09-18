# Native Lilac surface and first-party clients

Status: active, 2026-09-19. Approved for implementation by Stanley. Stage 0 is in progress. Product scope and stage exit gates below remain authoritative. Incremental commits are authorized; every stage requires review and fixes until no blockers remain before closure.

## Objective and sequence

Build a native surface for the owner to work with Lilac, with other people participating in threads. Deliver the backend and typed wire protocol first, then the React web SPA, then a small OpenTUI client for daily terminal use and the installation demo. Web and TUI work can overlap once the backend contract is mostly ready. Frontend integration may refine private interfaces and pre-release protocol details.

First-party clients become the default installation entrypoint when the full daily-use loop works without Discord. Discord and GitHub remain supported surfaces. The owner can inspect available external-surface threads through static, read-only views.

## Confirmed product decisions

| Area | Decision |
| --- | --- |
| People | One owner; other users are participants. Multi-user correctness is required, polished administration is not. No registration/onboarding workflow in the app. |
| Visibility and sharing | Owner sees every thread and adds existing users with `read` or `edit` access. Participants see their shared threads. Everyone can create a thread. Restricted participants are read-only; effective editors can send, steer, cancel and mutate history. |
| Administration | Only owner receives config data, sees config UI, changes config, manages shares, or changes per-user tool mode. Thread execution and agent data access follow its starter, not a later editor. No general role/permission editor. |
| Authentication | Per-install Clerk, plus a local Basic-auth login option with a fixed user and no add-user operation. Lilac is a native service user. |
| Transport | oRPC with contract-first schemas over JSON, no Yjs. One shared WebSocket for application RPC and updates. Separate authenticated HTTP upload/download/preview endpoints; socket messages carry resource references or pending upload handles. |
| Synchronization | Optional persistent cache in every first-party client, incremental replay, bounded replay retention initially seven days plus a byte cap, snapshot fallback, logout cache purge. |
| Native history | One thread is one session. No mention mode. History age selection and storage retention are separate settings, both disabled by default. Context compaction remains and emits a client event. |
| Sending | Idle input starts a run. Active input defaults to steering, with follow-up selectable. Cross-thread surface sends admit work according to configuration. Same-thread surface sends are posted but never trigger work. No cyclic self-prompt limit. |
| Models | Thread default plus per-message override using configured model choices. Pin selection for the active run. Steering does not switch it. |
| Streaming | Surface setting in Core config. `paragraph` commits at literal `\n\n`; `complete` commits at normal model stop or tool-call handoff. Emit remaining text on abnormal termination. No token streaming to clients. |
| Timeline | Active tools/thinking form collapsed work blocks separated by commentary. Settled turns fold intermediate activity behind an expandable duration row and leave the final answer visible. |
| Mutations | Effective editors can rename, archive/unarchive, delete and rewind a thread; readers cannot. No direct user/assistant message edit/delete UI. Rewind targets only complete user-turn boundaries, never steering inputs. Restore target text to the invoking composer; cancel first if active. |
| Queue | View/remove queued entries. No edit/reorder. Cancel drops all follow-ups queued for that run. |
| Files | Send publishes the message while attachments upload; model admission waits for all resource URIs. Broad attachment acceptance. Model gets native media when supported, otherwise a resource URI. File-path previews read the current file; missing files show an error. No file snapshots for preview. |
| Config | Reuse existing parser diagnostics. Core config Save uses existing auto-reload. MCP config has Save and an explicit Reload button using the existing registry operation. No `.env` editing. |
| Questions | Native structured question capability is deferred beyond MVP. Existing Discord questions remain unchanged. |
| Web | React 19, Vite SPA, TypeScript, shadcn/ui with Base UI, Tailwind tokens, GFM, MathJax, Mermaid, Shiki common languages. Optional animation only when useful. |
| TUI | OpenTUI with Solid bindings. Modern terminals, especially Ghostty/Kitty. Text/image/file input including clipboard; plain text output. |
| Performance | Cached thread content paints immediately. Uncached threads fetch recent turns first, then older pages. No auth/list/thread startup waterfall. Unchanged cached-thread reconciliation transfers under 1 KiB excluding auth handshake. |

## Existing owners and implementation changes

Production source and `PROJECT.md` describe the current behavior. Reference repositories supply interaction examples, not replacement architecture.

| Existing owner | Work required |
| --- | --- |
| `apps/core/src/surface/runtime-descriptor.ts` | Compose native adapter, ingress, relay, workflow progress and health. Do not register a native question port in MVP. |
| `apps/core/src/surface/types.ts`, `builtin-surface-protocols.ts` | Add native refs/principals and truthful native participants/read-state semantics to the closed contracts. |
| `packages/event-bus/lilac-spec.ts` | Native routing, semantic text/step/phase information, compaction and lineage events as needed. Preserve existing surface contracts through explicit compatible extensions or documented migrations. |
| `apps/core/src/surface/bridge/bus-agent-runner.ts` and its output publisher | Reuse durable admission and execution. Current time/byte batching cannot implement the new publication policy alone. Add turn identity, paragraph accumulation, terminal/step events, and rewind coordination at the appropriate owners. |
| `apps/core/src/discovery/discovery-service.ts` | Add native ingestion and visibility filtering, with duplicate suppression between native display messages and canonical agent transcripts. |
| `apps/core/src/conversation` | Remove Discord assumptions from native materialization/search paths. One native thread remains one summarized conversation thread. |
| `apps/core/src/resource`, `packages/blob-storage`, filesystem modules | Reuse resource ingestion and managed bytes. Add authenticated public resolution and live-path reading using existing filesystem authority. |
| `apps/core/src/custom-commands/manager.ts`, `packages/utils` | Reuse command/skill discovery and execution, model definitions, configuration schemas and detailed validation. |
| Core config watcher and `apps/core/src/mcp` | Preserve Core auto-reload; expose MCP registry reload through an owner-only button. Do not build another config store or MCP watcher. |
| `apps/installer` | Configure native/local or Clerk authentication and provide the terminal demo. |

The Level 2 tool server is a trusted-network interface without a public authentication contract. The native gateway calls shared domain modules through a separately authenticated interface; it does not publish that tool server to browsers.

Proposed ownership:

- `apps/core/src/surface/native`: native domain module, store, auth integration, gateway, adapter, ingress, output projection, and lifecycle.
- `packages/client-protocol`: runtime schemas, typed procedure contracts, message/event projections, versioning and fixtures. No Core or UI implementation imports.
- `packages/client`: framework-independent connection, replay reducer, command reconciliation, subscriptions, and cache interface. Shared by React and Solid clients.
- `apps/web`: browser SPA, browser cache, app-shell service worker, rich rendering and composer.
- `apps/tui`: OpenTUI/Solid terminal interaction, local cache and installation demo client.

Keep the gateway in Core initially. No separate deployed gateway service is necessary. Register each new workspace and exact boundary/codec owner with repository architecture checks.

## Native persistence and reliable handoffs

`native-surface.db` is separate from Discord storage. It owns native users/provider mappings, owner identity, participant membership, tool modes, threads, message/part/turn identity, visible chronology, read positions, reactions, command receipts, replay changes, and minimal handoff records for accepted input and rewind operations. Keep managed byte content in BlobStore; databases contain opaque references and domain metadata.

Existing modules retain ownership of execution queues, agent-run WAL, canonical agent history, provider continuation, workflows, configuration files, and blobs. Client checkpoints are cached display state and cursors, not execution checkpoints.

Native mutations, command receipts, and corresponding replay records commit in one native-store transaction. IDs are stable across retries. A repeated command ID with a different payload is a conflict. Receipt retention covers the retry window; after expiry, an uncertain command must not silently become fresh work.

Admission crosses the native and request-delivery stores. Atomically record the native input plus its admission intent, including pending attachment dependencies. A message accepted while uploading remains ineligible for execution until every attachment resolves. Use a stable identity with the existing durable request path, and settle the intent after confirmed acceptance. Reconcile unfinished intents through native lifecycle integration. Do not add a second agent execution queue.

Native output must survive a crash between Core run completion and visible-message persistence. Use durable bus consumption, commit the native projection before acknowledging, and verify retention covers unconsumed output. Stage 0 must establish the exact handoff; the current best-effort surface-write behavior is not an adequate native delivery guarantee. Preserve existing at-least-once execution semantics rather than claiming tools or model calls happen exactly once.

Thread deletion, rewind, and retention must update active lineage, resource references, replay visibility, discovery and summarized search consistently. Plan cross-store recovery where a single SQLite transaction cannot cover those owners. Logical mutation completion and cleanup progress are distinct; stale work cannot resurrect a deleted or rewound thread.

## People, authentication and tool mode

The owner is configured explicitly and has implicit access to every native thread and the available external-surface views. A new thread records its starter and includes Lilac. Everyone may create a thread and use it under their own tool mode, including a restricted starter running their own restricted thread.

The owner shares a thread by adding an existing user as `read` or `edit`, changes that grant, and removes participants. A shared URL identifies the thread but does not grant membership. Restricted-mode users added as participants have effective read-only access, even if a stale edit grant exists. Full-access participants still require an explicit edit grant to change a shared thread. Anonymous/public read links are deferred; MVP has two authenticated participant grants.

| Actor/access | Native thread operations |
| --- | --- |
| Owner | View and operate all native threads; manage sharing and user tool mode; edit configuration. |
| Starter | Operate their own thread using their configured tool mode. |
| Participant with effective `edit` | Read, submit, steer, follow up, cancel, remove queued input, change thread model, rename, archive/unarchive, delete and rewind. Cannot manage sharing or config. |
| Participant with effective `read` | Read history/activity, search visible content, preview/download visible resources, and keep their own read position. Cannot submit/control work or mutate shared history. |

The server computes effective access and returns it with thread metadata. Web and TUI use it to render read-only views, while every mutation independently enforces it on the server. Membership/tool-mode changes update capabilities and revalidate subscriptions and new commands; hiding the composer alone is insufficient.

Only the owner can read/write Core or MCP config and change another user's tool mode. Participants never receive configuration documents through bootstrap, catalogs, replay, or errors. They can receive safe display information necessary for the composer, such as model labels and command availability.

Clerk is configured per installation. Use existing provider accounts and sign-in; no Lilac registration/invitation/onboarding flow is added. Local auth provides one fixed owner account with Basic-auth credentials supplied through installation/server configuration. It has no user creation, password-recovery or enrollment system. Switching auth provider must preserve the explicit native owner mapping rather than granting ownership to the first login.

Proposed local login implementation: validate `Authorization: Basic` on the login endpoint, then issue the minimal same-origin authenticated session needed for HTTP requests and WebSocket upgrade. Use a maintained password verifier/session primitive and bounded login attempts, never store reusable credentials in URLs or browser caches. The credential and signing secret are installation secrets, outside the editable config UI. TUI uses the same local login operation; Clerk uses its supported public-client login flow. Local auth has no Clerk dependency at startup.

Normal requests authenticate with the existing session; they do not wait for a separate browser-side "who am I" fetch. Validate Clerk tokens using its supported verification path and cached verification keys. Handle token expiration and long-lived socket reauthentication explicitly. External authentication still needs its normal first-login or refresh flow; steady-state startup must not wait for the full Clerk UI bundle. Source: [Clerk manual verification](https://clerk.com/docs/guides/sessions/manual-jwt-verification).

Apply membership and owner checks to server queries, search/snippets, subscriptions, replay, resources, controls, and surface tools. Avoid a separate configurable ACL language. Full tool access still means existing service-user capabilities; this is an owner-operated assistant, not isolated tenant hosting.

Persist the starter identity on the thread and the actual author on each input. Resolve execution authority from the starter's configured tool mode and pin it in durable run admission. A later editor or steering input does not replace that authority or upgrade/downgrade the active run. Check the actor's effective edit access separately before accepting inputs or controls. A client cannot claim a different starter, author or tool mode. Mode changes apply when admitting subsequent runs; control checks also account for the mode pinned to any still-active run. The run's data-access principal is also the thread starter and remains so after steering. Keep input author identity for attribution, but never substitute it for the starter's agent authority. Self-prompts carry the source run's starter principal for target access checks rather than relying on Lilac's service identity.

Apply starter-scoped authorization to all agent retrieval and native data tools, including internal auto-injected conversation search, conversation.thread reads/metadata, resource materialization and cross-thread sends. Direct client browsing/search/resource requests still use the authenticated viewer's own access; sharing does not grant direct access to all of the starter's other threads. A shared thread can contain output produced from the starter's authorized context. Recheck current starter access when executing a data operation; persisted identity is not an irrevocable access grant. If starter identity/access is unavailable, fail the operation rather than falling back to the submitting editor or service user.

## Typed RPC, wire content and replay

### Selected RPC interface

Use a typed RPC interface on both ends. UI code should call methods such as `threads.open`, `inputs.submit`, `runs.cancel`, `threads.rewind`, and `config.save`, with typed subscriptions and runtime-validated payloads. Raw WebSocket handling belongs inside the shared transport module.

Use oRPC with contract-first schemas and its Bun WebSocket adapter. Stage 0 verifies typed streaming/cancellation, JSON frames, compact envelopes, bundle impact, runtime output validation, and repository Result/exception rules on the selected runtime. oRPC is the agreed dependency choice; it has not been installed during planning.

Sources: [oRPC contracts](https://orpc.dev/docs/contract/procedure), [oRPC WebSocket/Bun adapter](https://orpc.dev/docs/adapters/websocket).

RPC supplies procedure typing, routing and request correlation. Lilac owns durable replay, cache commits, snapshot watermarks, command idempotency and membership. A transport-level "last received event" cursor cannot replace the last durably applied/cache-committed cursor.

Use the framework-independent client directly; do not require TanStack Query or one React hook per RPC procedure for the synchronized conversation store. Terminating a subscription/RPC on socket loss must not cancel an admitted agent run. Expected domain errors remain typed Results; any framework exception conversion stays at an exact registered transport adapter.

### Message representation and metadata discipline

Use AI SDK `UIMessage` as the client message representation, with explicit Lilac metadata/data schemas and a pinned projection version. The installed SDK supports metadata and data parts. Keep procedure envelopes, cursor/version information, membership and config outside message bodies. Sources: [UIMessage](https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message), [metadata](https://ai-sdk.dev/docs/ai-sdk-ui/message-metadata).

Define stable thread, user-message, input, request, turn, assistant-message, activity and part identities. A logical UI turn is a user-to-agent work cycle; provider tool-call steps are inside it. Steering/follow-up lineage is explicit so folds, queue status and rewind do not infer causality from timestamps. Distinguish model role from displayed author, including Lilac-authored self-prompts.

JSON v1 deliberately avoids repeated display metadata:

- Define thread/message/part metadata once per known entity revision or snapshot. Later operations carry IDs and changed fields only.
- Send mostly static skill/command display catalogs once per authorized scope and revision, then only changes or invalidation. Clients filter these catalogs locally for autocomplete. Dynamic lists remain backend-filtered and paginated. Reuse known entity metadata; do not repeat names, descriptions, schemas, avatars or model definitions on every paragraph.
- Bind subscription scope once. Use compact operation batches with one cursor/sequence envelope rather than a full message envelope around each operation.
- Send only new text. Never retransmit accumulated text, message arrays, or the complete conversation with a prompt.
- Send tool start metadata once, state changes thereafter, and large details only when requested. Do not send provider debug payloads as UI data.
- Reserve full replacement for an explicit reset/correction and declare why it is needed. Required correlation IDs and retransmission after a lost acknowledgement remain valid protocol behavior.

Do not introduce Yjs, MessagePack, or multiple encodings in v1. Measure JSON traffic and make the metadata rules conformance tests.

### Stable turn identity and mutable revisions

Introduce an immutable `turnId` for each full user-to-agent turn. It is stable across reconnects, model retries, tool-call steps and process recovery. A started follow-up gets its own turn ID; steering attaches to the existing turn and does not create a rewind target. Allocate/persist the turn identity through durable admission before publishing its events. Pending entries retain their stable input/command IDs. New work after rewind always gets a new turn ID, even when the submitted text is identical.

Use `turnId` for timeline grouping, activity expansion, history pagination anchors and rewind targets. It identifies a turn, not an event position or proof of unchanged content. An active turn can gain paragraphs/tool results, settle or be removed while a client's latest remembered turn ID stays the same.

| Field | Purpose |
| --- | --- |
| `turnId` | Immutable identity of a full conversational turn. |
| `historyGeneration` | Identifies the valid conversation lineage after rewind/truncation; stale-generation mutations and pages are rejected. |
| `projectionRevision` | Changes whenever the subscribed visible state changes, including updates within a turn. |
| `cursor` | Opaque position for ordered incremental replay, scoped to the authorized projection. |

An unchanged compatible generation/revision can receive a new cursor without replaying content, even when the old log position expired. Compare state first; require retained events only when there is an actual change to reconstruct. Preserve separate loaded-page/detail coverage so a current revision cannot imply an uncached range is present.

### Incremental replay

Every first-party client supports both persistent-cache replay and no-cache snapshot operation. Cache keys include installation, authenticated principal, protocol/projection version and subscribed scope. State and cursor commit atomically in IndexedDB for web and the local TUI cache.

For each authorized thread subscription:

1. Submit the cached cursor/revision and loaded-history coverage, or request a recent-turn snapshot.
2. Recheck visibility and compare the cached projection version, history generation, revision and coverage. If state is unchanged and compatible, return a small acknowledgement and refreshed cursor with no transcript or unchanged metadata, even if the old cursor has expired.
3. If state changed, choose ordered incremental replay for a small gap or latest-first catch-up for a large gap using estimated bytes/work and requested viewport. Do not force a retained but large event backlog ahead of current content. When that delta is unavailable or the projection is incompatible, return a declared reset and a bounded recent snapshot with a watermark. Page older history separately.
4. Reconcile snapshot and live changes at that watermark without gaps. Duplicate deliveries reduce idempotently by entity/part identity and revision.
5. Atomically save reduced state and the new cursor before advancing the persistent checkpoint. A crash may replay a batch; it cannot skip it.
6. Resume live updates with bounded queues, reconnect backoff/jitter, and explicit reauthentication where necessary.

Use a catalog/unread feed plus content subscriptions for selected threads. Several logical subscriptions share one physical WebSocket; opening a thread does not open another socket. Older history pages and collapsed activity detail have separate coverage from the live tail. Never mark an unhydrated historical range as fully cached merely because the latest event cursor is current.

Replay covers message creation, tool/activity state, compaction, queue controls, revisions, rewind/truncation, deletion, membership and unread state. A rewind invalidates old-generation pages and prevents historical replay from restoring the removed suffix. Access changes also invalidate cached scope. Logout purges private caches; already downloaded data cannot be recalled from an untrusted client.

Replay retention starts at seven days, bounded by a byte cap to be fixed during Stage 0. Storage retention and client-cache eviction are independent. A slow client has bounded outbound buffers; discard replaceable transient statuses only, and explicitly resynchronize rather than silently dropping committed content. The projection path cannot stall model execution on a slow browser.

### Latest-first catch-up with deferred placeholders

For a large gap, return the latest turn's display-ready content and current controls, with deferred placeholders for older content. Hydrate those placeholders through the same socket in background batches. The reply describes an ordered view containing ready content and deferred slots; hydration replaces slots in place even when batches arrive out of order. For a small gap, ordinary ordered deltas avoid retransmitting cached content. This is display-state catch-up, not a requirement to replay every historical event.

Keep the initial reply bounded. A placeholder can represent one turn in the requested window or a range of older turns; do not enumerate every missing turn in a long history. Give each slot stable identity and an ordering anchor, with generation/revision information shared in the response envelope where possible. Reuse valid cached content instead of replacing it with placeholders. A range can expand into ready turns and a remaining deferred range as it hydrates. Exact wire fields are Stage 0 work.

Hydration replaces a matching unresolved slot only while its generation/revision remains valid. Ordered live changes continue from the reply's watermark. A late hydration cannot overwrite newer content, resurrect a deleted turn or cross a rewind generation. Shared client state distinguishes ready, deferred and failed/retryable content; deferred content is never treated as empty or fully cached. Persist unresolved slots with the cache so reconnect can resume hydration without downloading ready content again. Advancing the live cursor does not mark unresolved slots as hydrated. The reducer applies each replacement atomically and preserves scroll anchors.

Prioritize the latest turn by default and promote deferred content when it enters the user's viewport, without forcing a scroll to the tail. Use bounded low-priority hydration batches so controls and live updates can pass between them on the shared socket. Cancel or deprioritize obsolete hydration on navigation. Hydration failures stay local to their slots and can retry; auth loss and history invalidation remove affected slots. Catch-up must not replay old notifications or trigger side effects.

## Performance guidelines

These rules apply to the backend, wire contract, shared client, web and TUI. They are implementation review criteria, not a later optimization pass.

- Prioritize what the user can see or act on. Deliver the selected viewport, final answer/current turn, controls and concise activity state before older history or expanded detail. Never require full-history hydration before interaction.
- Keep clients slim. The backend owns authorization, dynamic-data filtering/search/ranking, applicability checks, pagination and display projections. Mostly static, mostly global display catalogs such as skills and commands are an explicit exception: cache them by scope/revision and filter locally to avoid per-keystroke requests and repeated result transfer. Send only authorized display entries, not skill bodies or execution definitions. Clients also own rendering, interaction, local drafts and bounded cache/reconciliation work.
- Before adding any RPC field, identify what the user sees or which visible behavior it directly determines. Stable IDs, revisions, cursors, capabilities and upload handles qualify when required for correct interaction/synchronization. Omit internal execution records, hidden prompts, debug payloads and speculative fields. Fetch large detail only when requested. Apply this review to bootstrap, events and errors as well as procedure results.
- Keep interaction non-blocking. File transfer, history hydration, cache writes and rich rendering must not disable typing, navigation, cancel or message acceptance. Bound work per update and yield between batches. Send remains available while attachments upload; model admission alone waits for attachment readiness.
- Virtualize every potentially large list, including conversation turns, expanded activity, thread lists, search results and command/skill menus. Server pagination limits transfer; virtualization limits mounted/rendered rows. Preserve variable-height measurement, scroll anchors, focus, keyboard navigation and accessible semantics. TUI renders a bounded viewport too.
- Bound memory, rendering and wire work by the requested window and changed entities. Avoid whole-history scans, reparsing and component updates on each event. Lazy-load heavy renderers, reuse unchanged projections, and coalesce progress/status updates. Background work must yield to foreground reads and controls on both server and client.

## Startup and thread performance

### Initial load without serial data fetching

Cache hashed app assets with a service worker. Cache private conversation projections in a principal-scoped data store, not indiscriminately in the service worker's HTTP cache. A service worker accelerates repeat visits; it cannot remove the first visit's asset download. It requires HTTPS or a supported secure localhost origin. Source: [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API).

At the earliest application entry, using the URL and existing cache/session:

1. Render the cached shell and start reading cached catalog/selected-thread state.
2. Start one authenticated HTTP bootstrap and establish the shared WebSocket in parallel. Include the URL-selected thread ID and known catalog/thread revisions from the outset. Do not wait for a thread-list response to discover a thread ID already in the URL.
3. Bootstrap validates auth while returning a thin display catalog and, when the selected thread is not usable from cache, its recent turn window with a watermark. With valid cache, send changes or unchanged markers instead of the same content.
4. Register the catalog and selected-thread subscriptions on that socket. Coordinate their cursors with bootstrap watermarks; buffer/catch up only the concurrent changes needed to close the snapshot/live race. Initial content painting must not await an additional full thread fetch.
5. Reconcile cached display state and continue live updates. Fetch older pages and heavy activity details later at low priority.

Assign ownership of initial data to bootstrap and subsequent changes to the socket so both paths do not ship the same initial snapshot. An early subscription may prepare a topic before the bootstrap watermark arrives; after it arrives, a cursor-only attach/catch-up is allowed. Retained changes close either arrival order without a full reload.

A bootstrap-level 401/403 clears authenticated UI state and displays login. An inaccessible URL-selected thread returns an unavailable thread result within an otherwise successful authenticated bootstrap; it does not log out a valid participant. A network outage is a reconnect/offline state, not an authentication failure. Do not cache login errors as a shell or automatically serve stale private bootstrap responses.

The thin catalog contains only visible thread summaries, current user/owner status, permitted display controls, safe model choices, command/skill catalog revisions and required UI state. Configuration documents load only when the owner opens settings. Paginate large lists. Serving native SPA assets from Core's origin avoids unnecessary CORS/auth coordination.

### Thread navigation

On a cached click, paint the cached recent content immediately without replacing it with a spinner. Revalidate with the cursor in the background. Keep recent thread windows in memory, hydrate IndexedDB early, and preserve per-thread scroll position. Authentication or revocation can remove stale cached visibility once detected.

On an uncached click, request the last few turns first. Proposed starting window: five turns with a byte budget, adjusted after measurements. Fetch display-ready user/final text and activity summaries first; expand detailed tool/reasoning history on demand. Bound huge single turns with explicit part/detail pagination. Progressively walk back through older turns at low priority and preserve the scroll anchor while prepending. Deprioritize obsolete history loads when the user changes threads; never delay a new active-thread read behind background hydration.

No spinner is the normal navigation target, not a claim that an uncached remote request takes zero network time. Test under a named latency profile; slow/offline/error states remain visible without clearing useful current content or disguising failure.

### Performance acceptance

| Scenario | Acceptance |
| --- | --- |
| Cached thread, unchanged server state | Sum of thread-specific request/ack payloads and WebSocket framing is under 1,024 bytes, excluding auth/connection handshake and unrelated traffic. No message body or unchanged metadata. |
| Cached click | No network await before content paint; proposed p95 click-to-content budget of 50 ms on the reference client. |
| Uncached thread | Recent content precedes older history and heavy details. Proposed p95 server recent-window response budget of 100 ms, with network/client paint measured separately. |
| Warm deep link | Cached shell; bootstrap/auth and socket start in parallel; no auth → list → thread chain. One bootstrap supplies the initial selected-thread view when needed. |
| New paragraph | Only newly committed text and minimal IDs/revisions cross the wire. Earlier text and catalog metadata are absent. |
| Long history | Thread switch/render cost depends on the visible window and changed entities; no full-thread reparsing or full-history download to display its tail. |
| Far-behind reconnect | Latest turn and current controls render before historical backfill completes; live updates remain responsive. Deferred placeholders hydrate out of order without stale overwrites or false cache coverage; the initial reply does not enumerate full history. |
| Uploading attachment | Send accepts/publishes the message before transfer completes; composer/navigation stay usable. No model admission before all attachments are ready. |
| Large lists | Mounted rows and per-update work remain bounded by viewport/overscan; server pagination/filtering prevents full-dataset transfer. |
| Active/settled UI | Activity updates do not rerender/highlight every prior turn. Idle pages have no continuous animation or unnecessary repaint loop. |

The 1 KiB rule is a product requirement. Proposed timing budgets require a fixed device/server/network fixture in Stage 0 before implementation acceptance. Measure cold and warm asset transfer, main-thread work, renderer chunks, layout shifts, memory, encoded bytes, and RPC overhead. Include service-worker/backend version mismatch and upgrade behavior in the fixture.

## Streaming, activity and compaction

The native output mode is a surface option in `core-config`, shared by all native sockets. There is no per-client streaming mode. Persist one native publication sequence and fan out the same event shape to all clients authorized for it.

`paragraph` buffers text until literal `\n\n`, preserves delimiters, and emits each completed span once. Recognize separators split across provider chunks; normalize CRLF consistently. Flush the final nonempty remainder when a text part or model step ends, without joining unrelated phases or tools. This is a textual delimiter, not a Markdown parser: blank lines inside code blocks also delimit chunks, and the client incrementally renders their combined message text.

`complete` buffers the current model step's text until normal stop or tool-call handoff, normalizing provider spellings such as `tool-calls`. A tool-call boundary publishes that step's text but does not settle the whole UI turn. Cancellation, failure, or length exhaustion publishes any remaining text once, marked incomplete.

Keep commentary/final phase, text-part identity, step identity and UI turn identity explicit. A provider lacking phase labels gets a documented normalized mapping; the client must not invent final-answer status from a quiet socket. Pin publication mode for the active run; a saved surface setting applies to subsequent runs so an existing buffer cannot be reinterpreted halfway through. Retained replay events preserve how text was actually published.

Typing/activity, tool state and cancellation outcomes can arrive independently of text commits. Publish reasoning activity as bounded blocks/status rather than token deltas. Do not expose hidden provider reasoning. Persist enough grouping/status information to reconstruct the same timeline on reconnect, and resolve retry rollback through explicit revision/reset operations.

Active view follows the supplied T3 examples: consecutive tool/thinking events form one collapsed summary block; commentary text splits successive blocks. On settlement, fold intermediate text and work behind an expandable "Worked for …" row and keep the final answer visible. Expanding reveals the original sequence. Failed/canceled turns retain their terminal status and incomplete text. Workflows still running outside the turn remain distinguishable from settled work. Duration comes from server timestamps, not a browser timer alone.

Emit a structured compaction event with identity, request/turn/session correlation, start/complete/failure state, affected context boundary and available before/after counts. The client chooses a marker or folded activity presentation. Compaction changes model context, not retained chat history; it must not delete old chat rows. Do not send the compaction summary or system prompt merely to render the event.

## Input, models, queue and self-prompting

Only an actor with effective edit access may submit. Attachment-ready idle submission starts work. Uploading submissions are accepted visibly but wait for attachment readiness before entering execution. Active submission defaults to steering and can explicitly be a follow-up. Both report durable acceptance and actual queue/application status. Provider-boundary steering is displayed as pending until applied. Disconnection neither cancels work nor creates a new submission ID.

Models come from configured definitions/slots. Expose safe display labels and relevant capabilities, with a thread default and optional per-message override. Resolve and pin the selected model at admission. Steering cannot switch it; follow-up may pin another model for its next run. Show actual fallback choice when it differs. Configuration changes never silently reinterpret an accepted input's model.

Queue UI can view and remove pending entries, with no edit/reorder. Canceling the active run drops all follow-ups queued for that run, broadcasts their disposition and prevents them from starting during cancellation. Serialize the cancel/finish/new-send race; work submitted after the completed cancel is a new admission, not accidentally included in the dropped set. Retained steering outcomes must also settle rather than remain visibly pending after cancel.

Native surface-tool sends to another thread create Lilac-authored input and use configured active-input behavior. Carry source/target/causation IDs and the source run's starter principal. Require that principal to have effective edit access to the destination, then run under the destination starter's tool mode and data-access identity. Lilac's service user is not a permission bypass. Sending to the current thread records the message only, even when the source run is idle or active. Ordinary output, workflow progress and message maintenance never self-trigger. Do not add a cyclic-prompt budget; standard global run limits still apply.

## Rewind and thread lifecycle

Rename/archive/unarchive/delete require effective edit access to the native thread. Readers cannot perform these mutations. Archive preserves history and removes the thread from the normal active list; no implicit cancellation is attached to archiving. Thread deletion cancels its active work, drops queued follow-ups, removes it from visible history/search and invalidates subscriptions/resources according to reference ownership. No direct message edit/delete controls appear in the first-party UI. Keep required adapter maintenance operations behind their existing tool/domain contracts; these do not create a generic client message editor.

Rewind is a dedicated command targeting an immutable `turnId` for a full user-to-agent turn, including a follow-up after it has started its own turn. Resolve its starting user message on the server. Steering messages are never targets. The command includes the expected history generation and revision:

1. Verify effective edit access, a valid full-turn target and the expected generation/revision; reject steering targets on the server and serialize against sends, cancel and other rewinds.
2. If active, cancel the run and drop its follow-ups. Fence old-generation output and wait for execution settlement before making the rewind effective.
3. Restore the active conversation prefix to immediately before the selected user turn. Remove the selected input and every subsequent visible turn from active history.
4. Reset canonical input/history selection, compaction lineage, deferred-tool selection and provider continuation to that prefix. A future run must not retain discarded context through a cached provider session or checkpoint. Rebuild from valid prefix history if an exact checkpoint cannot be reused.
5. Commit a new history generation and publish a truncation/reset operation. Invalidate removed search content and cached older pages so other clients converge without re-downloading unchanged prefixes.
6. Return the selected user text to the invoking client, which places it in its composer. Do not auto-send it or replace another participant's draft. Preserve an existing unsent draft before replacement. Text-only restoration is the initial contract; attachments are not silently reattached.

Rewind changes conversation history. It does not undo filesystem writes, tool effects, or external messages. It is not a branch UI. Repeated command IDs produce the same result, and late replies cannot restore the removed tail. Persist enough mutation intent to finish safely after a process crash across the relevant stores. Do not let recovery resume a discarded generation.

Owner and effective editors can rewind/delete shared history. Read-only participants cannot. The UI exposes rewind only on full-turn starting messages; the protocol enforces the same rule even for hand-written requests.

## Surface capabilities, search and resources

Implement native listing, participants, send/read/page/edit/delete maintenance, reply context, reply-chain/merge-block planning, reactions/details, unread/read state, typing/activity, output lifecycle, interactive actions, workflow progress and health. Implement the agreed optional capabilities except native structured questions, which are explicitly deferred. Discord guild lookup has no native meaning; do not fabricate a guild to satisfy it. Distinguish per-human read position from Lilac's tool-facing read position.

Actions bind identity, message, request and revision; repeated/stale interactions settle explicitly. Surface message maintenance and whole-thread rewind remain distinct operations.

Do not implement or advertise the native structured question capability in MVP. Omit its surface port and exclude the structured question tool from native run discovery/assembly. Any stale attempted call returns the established unsupported outcome rather than creating an unanswerable pending question. An agent may ask in ordinary text and receive a normal user input; there is no dedicated question UI or wait/answer lifecycle. Leave Discord question schemas, original-user authorization and recovery unchanged. A later native question redesign is a separate scope.

Native `discovery.search` ingestion uses stable surface identity and avoids duplicate canonical transcript hits. Apply visibility before snippets, surrounding context, counts or ranking can disclose other threads. Updates, retention, thread deletion and rewind invalidate indexes.

Treat each native thread as one `conversation.thread` unit. Refresh its summary when its content revision changes using the existing scheduling machinery; a continuously active thread cannot depend exclusively on a Discord quiet-period heuristic. Do not add searchable segmentation or a new reranker.

Only the owner can browse/read external-surface threads. Use available adapters/stores, display source and retrieval time, paginate, and refresh manually. No native write/steer/cancel/rewind on those views and no live mirroring or automatic account linking. Missing/unavailable sources show explicit states.

HTTP upload accepts broadly supported file types, verifies size/media metadata and resolves a server-issued upload handle to a resource ID. Socket input carries pending upload handles or ready opaque resource URIs plus required display metadata; binary content stays on HTTP. Reuse Discord-style model ingestion: native images/files where the selected provider supports them, resource URI otherwise. Upload limits follow an explicit finite server cap, initially reusing the existing resource-ingestion ceiling where appropriate; broad type acceptance does not require inlining arbitrary bytes into the model.

Sending does not wait for file bytes. Reserve lightweight upload handles when files are attached, start HTTP transfer, and accept the text plus attachment handles through the normal idempotent submit operation. Publish the user message immediately with an uploading attachment state and progress; release the composer for the next input. If handle reservation is still pending, show the local pending message immediately and finish reservation/submission without waiting for the file transfer. Distinguish local pending state from server acceptance.

The server owns each attachment's pending/ready/failed/canceled state and verifies upload completion before binding a URI. HTTP transfer progress is a coalesced display hint, never proof that the resource is ready; the sender can render local progress immediately. Broadcast bounded progress/state updates to other viewers. An input becomes execution-eligible only when every attachment is ready and authorization is rechecked. Never silently run only the text or a subset of the files after a failure. Retry a failed transfer against the same message/input identity; queue removal can cancel pending admission without adding a message-edit feature. Do not promise background browser uploads after the browser closes; show interrupted uploads and allow retry on return.

Preserve accepted input ordering within its admission lane while uploads finish; later follow-ups cannot overtake an earlier uploading follow-up. Record requested steering/follow-up mode and associated run at acceptance, and define the ready-versus-run-finish race in Stage 0 using the existing admission policy with an explicit outcome. Canceling that run drops its associated pending inputs, including uploading follow-ups. Rewind/delete/removal fences late upload completion so it cannot restart discarded work. Persist readiness with the existing admission intent and reconcile it on recovery; do not add a separate execution queue. Other threads and ongoing runs remain usable while one input waits.

Reuse managed bytes and cleanup/reference ownership for uploads. Implement interrupted upload cleanup and canceled/failed upload states. Resource authorization follows its immutable origin thread, not every thread where its URI later appears.

Current Discord resources store attachment origin and retained transcript/surface references. Those references govern lifetime, while exact-URI possession currently grants access without a session/principal comparison (`PROJECT.md`, resource retention section). Native origin-thread authorization is an explicit addition; do not assume the existing retained-resource codec or lineage already enforces it. Extend resource origin/schema handling for native uploads and generated attachments, and apply the native authorization adapter before materialization. Keep existing Discord internal behavior outside this native change; external-surface reads through native clients remain owner-only.

Create/reserve the native thread before upload. The server binds staged upload ownership to the authenticated uploader and that origin thread; clients cannot assert or replace provenance. Before message submission creates any resource reference, verify destination edit access plus either ownership of a staged upload handle for that same origin thread or current read access to an already published resource's origin. A pending handle is not a readable resource URI; bind the eventual resource reference only after verified upload completion and reauthorization. Unpublished upload previews are limited to the uploader/owner until attachment publication. Failed or abandoned uploads expire through existing cleanup ownership.

Reusing a resource in another thread never reparents it or broadens access. A direct client read/preview/download must authorize the current viewer against the origin thread; an agent read uses its starter data-access principal against that same origin. Readers of the destination who cannot access the origin get an unavailable attachment, not a new grant. Removing origin membership revokes future reads even when a URI/reference remains cached elsewhere. Origin-thread deletion makes native resolution unavailable; retained references govern later byte cleanup, not access. Rewind/retention removes references according to the existing ownership rules and must not manufacture an alternative origin.

Tests cover pre-submission upload access, foreign staged IDs, reattachment after lost membership, reuse across threads with different membership, agent-versus-viewer access, and origin deletion. Existing capability URIs must not bypass these checks through native RPC, native tool adapters or provider hydration.

File-path previews resolve the current filesystem file through the existing filesystem authority and relevant workspace/backend. Use the caller's thread access and permitted published path reference; do not provide an unrestricted path browser. No snapshot/copy into BlobStore just to preview a path. The preview reports missing/unreadable files directly. Recheck access and current file metadata on subsequent reads; do not cache mutable path bytes as immutable resource content. Remote paths require an existing backend capable of reading them.

Web previews choose a safe renderer for recognized formats, with download fallback for everything else. Do not execute uploaded HTML/SVG in the application origin. HTTP resource endpoints support appropriate range/content-type/download behavior. TUI sends image/file inputs and displays plain reference text for non-text results.

## Config and composer catalogs

Only owner can read/save `core-config` and `mcp-config`. Reuse current parsers and their detailed field/path errors. Save validates and atomically writes the selected existing config file, with revision checks against concurrent UI/disk changes. Core config uses its existing auto-reload behavior. MCP Save persists the document; a simple owner-only Reload button invokes the existing MCP registry reload operation and reports per-server outcomes. Do not add an MCP file watcher or automatically invoke reload on Save. Distinguish saved configuration from the currently applied registry and show save/reload failures and existing restart requirements accurately.

Start with validated config editing rather than duplicating the complete schema in hand-built forms. Entries can be added/changed/deleted under the existing parser. `.env`, process environment and separate credential files are outside the interface. Keep config/error payloads owner-only and out of general display-catalog replay; do not add a secret-management subsystem.

Use the T3 composer references for interaction:

- `/` opens one menu containing built-in commands, custom commands, and `/skill:<display name>` entries, with descriptions and source badges when discovery provides them.
- `$` opens a skills-only menu with names, descriptions and source badges. Selecting either syntax refers to the same canonical skill identity.
- Show one highlighted row, keyboard arrows, Enter/Tab selection, Escape dismissal, scroll-to-highlight, pointer selection and IME-safe behavior.
- Insert a structured skill mention/chip while preserving a stable canonical ID and lossless plain-text serialization. Display names may contain spaces and need not be unique. Do not resolve execution solely by the rendered label.
- Skill/command autocomplete filters and ranks a locally cached, revisioned display catalog. Fetch the authorized catalog once and reconcile only changes; typing `/`, `$` or a search string does not issue a query RPC. The backend supplies the applicable scope for the current thread/workspace/tool mode, sharing unchanged global entries across scopes. Cache by installation/principal/scope, invalidate on access or catalog changes, and revalidate invocation server-side. This exception applies to mostly static catalogs; dynamic thread/content search remains on the backend.
- Invoke through existing skill-loading behavior and command execution. Revalidate IDs/arguments on submit. Handle catalog removal/collisions explicitly rather than silently running a different command.

Do not copy T3-specific provider commands, permission menus, onboarding, path mentions or pull-request features merely because they appear in the reference. Lilac's supported commands and user/tool mode remain authoritative.

## UI design guidelines

Keep the interface minimal and let conversation content carry the hierarchy. Every label, title and helper sentence must help identify an action, explain a state or resolve an error; omit copy that repeats an obvious control or the surrounding context.

Use Lucide icon buttons without visible legends/titles when their meaning is clear. Give each an accessible name and a tooltip available on hover and keyboard focus. Keep visible text for ambiguous actions, choices and consequential confirmations; minimal styling must not obscure meaning. Import only the icons used.

Use shared semantic design tokens for hierarchy, spacing, type size/line height, color, radius and elevation. Reuse component variants instead of one-off styles. Do not inline arbitrary units unless runtime measurement requires them, such as virtual row positioning or measured layout; static exceptions need a concrete reason.

Separate blocks with spacing, surface/background color, backdrop or subtle shadow first. Add an outline or border only when adjacent blocks remain hard to distinguish. Preserve visible keyboard focus and required contrast, including high-contrast modes; focus indicators are not decorative separators. Avoid putting a border around every message, section or control group.

Keep loading, uploading and failure states local to the affected item. A pending file appears in its sent message with progress; background history loading does not cover the conversation or disable the composer. Apply the same hierarchy and concise status language in the TUI within its plain-text constraints.

## Web application

Use React 19 with Vite and TypeScript, shadcn/ui based on Base UI, Tailwind semantic tokens, Lucide icons, Bun and the repository's lint/format/typecheck tools. Ship an SPA, with built assets served by the installation and route fallback for deep links. No SSR requirement has emerged. Auth/data bootstrap can be handled by HTTP without rendering the conversation on the server.

Views cover login, visible threads/search, native conversation and queue, model selection, owner settings, owner-managed thread sharing, owner-only external conversations, previews and thread mutations. Sharing lists existing users with read/edit grants and supports changing/removing a grant. Read-only participants get a readable timeline and resource previews with no composer or mutation controls. Multi-user authors are visible without introducing a social/chat-service administration UI.

The composer supports multiline input, skill/command mentions, paste/drop attachments, image previews, progress/errors/removal, steering/follow-up choice and explicit cancel. Provide the rewind control on eligible user messages. Preserve drafts/scroll position per thread locally and reconcile accepted input by command ID.

Render GFM including tables/tasks, MathJax, Mermaid and Shiki, with source/error fallbacks. Bundle common Shiki languages and load uncommon grammars only when needed. Load heavy renderers lazily without gating initial text; memoize unchanged committed content and update only affected turns. Virtualize the timeline and every other potentially large list according to the shared performance guidelines, with variable-height rich content, stable scroll anchoring and keyboard accessibility. References: [shadcn Vite](https://ui.shadcn.com/docs/installation/vite), [Shiki bundles](https://shiki.style/guide/bundles).

Themes use semantic color/type/spacing/radius/motion tokens and support light/dark/system. Respect reduced motion. Avoid continuous work-indicator animations that repaint idle pages. Optional Motion/Framer is not a prerequisite for shipping.

Version the app shell, data projection and protocol. Coordinate service-worker activation so an old open tab does not unexpectedly lose its compatible assets or interpret new data incorrectly. An incompatible client gets an explicit reload path; upgrades never silently discard drafts. Purge user-specific cache on logout/account change. Test storage eviction and no-service-worker operation.

## TUI and installation

Use `@opentui/core` and `@opentui/solid` with Solid state bindings over the shared client. Target modern terminals, specifically Ghostty and Kitty. Use OpenTUI's clipboard/input facilities for text and images; no separate home-grown terminal/clipboard framework.

OpenTUI documents host clipboard reads separately from terminal paste events. Verify the installed runtime and local versus SSH behavior in Stage 0; do not claim a remote process can always read the local desktop clipboard. Preserve file/path attachment input when image clipboard access is unavailable. Sources: [Solid bindings](https://opentui.com/docs/bindings/solid/), [clipboard](https://opentui.com/docs/core-concepts/clipboard/).

Provide local/Clerk login, thread list/create/open, model choice, text composition, skill/custom-command completion, attachment/image input, steering/follow-up, queue view/remove and cancel. Native structured question interaction is outside MVP. Reuse replay and receipt logic. TUI output is plain text/source and status lines, with no image/table/math/diagram renderer. Sanitize terminal control sequences in untrusted output.

Keep editing responsive as output arrives; define distinct cancel and exit keys. Retain a bounded atomic cache, with no-cache mode. For rewind/reset, redraw the affected visible terminal history or show an explicit correction instead of pretending append-only output never happened. Detailed config editing stays in web; the TUI demo does not need full settings UI.

Bundle the client with installer artifacts. A local-auth installation can run the real authenticated demo without a Clerk account. Demo execution uses the normal native protocol and user's configured model. Offer Clerk configuration without forcing it for testing or local use.

## Staged implementation and exit gates

### Stage 0: Contracts and focused technical proofs

Establish exact versioned schemas and migration scope for the agreed product decisions and selected oRPC transport. Verify Bun/server and browser/Solid client integration without bringing Core implementation into bundles. Prove local login and Clerk login/verification, cookie or token use across bootstrap/socket/resources, and no user-registration requirement.

Use a small protocol prototype to measure JSON envelopes against the 1 KiB unchanged-thread requirement and to test bootstrap/snapshot/live ordering, latest-first replies with deferred placeholders and out-of-order hydration, and upload readiness/admission races. Audit provider turn/text/phase/compaction events. Prove native admission/output handoffs and identify the exact history state that rewind must reset. Verify OpenTUI clipboard and terminal runtime support. Set performance fixture hardware, network and byte/history windows.

Exit: no unresolved choice changes authority, history/rewind, replay or storage ownership; runtime/persistence/wire additions and required migrations are enumerated. This stage resolves implementation risk, not a redesign of accepted product decisions.

### Stage 1: Backend and typed client protocol

Deliver in bounded slices:

1. Shared runtime contracts, typed RPC transport, native refs/principals, local/Clerk auth, owner/participant checks and native-store codecs/migrations.
2. Thread/membership/message/read-state domain, owner-managed read/edit sharing and effective-access checks, command receipts, replay changes, recent-history windows, latest-first replies with deferred turn/range placeholders and background hydration, display bootstrap and subscriptions.
3. Existing request admission integration, starter-owned tool/data authority including internal retrieval, models, steering/follow-up/cancel, queue removal and surface self-prompt semantics.
4. Shared paragraph/complete publication, immutable turn identity and revision/generation replay, activity/compaction projection, durable relay and workflow progress. Native question capability is absent.
5. Rewind/delete with cancellation fencing, generation changes, canonical/provider history repair and cross-store recovery.
6. HTTP uploads/live-file/resource preview with immutable origin-thread authorization and submit-time checks, non-blocking send and durable attachment readiness; native search, owner-only external views, catalogs, owner config Save and MCP Reload.
7. Framework-independent cache/replay client, byte-budget and race fixtures, deployment and migration documentation.

Native works with Discord disabled. Readiness and shutdown follow existing runtime ownership: initialize stores/consumers before ingress, recover before admitting conflicting work, drain durable projection before releasing resources.

Exit: a non-UI protocol client exercises login, bootstrap, two participants/devices, thread creation, prompt/steer/follow-up/cancel, queue removal, attachments, model choice, compaction, replay, rewind, search, config Save and MCP Reload. Surface feature matrix is complete with native structured questions explicitly unsupported. No token text or duplicated stable display metadata crosses the wire. Cached no-change navigation meets the byte budget.

### Stage 2: Web SPA

Build the cached shell/bootstrap path and recent-thread rendering first, so performance is tested before rich UI fills the app. Then deliver composer, activity folds, queue/model controls, resources, owner settings/sharing and external-thread views, read-only participant views, and rewind/thread lifecycle controls. Integrate rich renderers without blocking initial text. Apply the UI design guidelines, virtualize all potentially large lists, and verify send-during-upload responsiveness. Add service-worker upgrade/cache handling and accessibility.

Exit: browser tests cover cached/uncached deep links and clicks, actual network dependency graph, long history, two users/tabs, resource input/preview, malformed rich text, compaction, cancellation, rewind and auth expiry. Meet byte/paint budgets with realistic content, not only empty threads. Owner config never reaches participant payloads.

### Stage 3: OpenTUI client

After the backend is mostly ready, implement Solid/OpenTUI over the same shared client. This can overlap later web work. Add local/Clerk login, composer/catalogs, modern-terminal clipboard/file input with non-blocking send, plain output, bounded list viewports, queue/cancel and latest-first replay. Package with installation and local-auth demo.

Exit: fresh native-only install, demo without Clerk, optional Clerk login, Ghostty/Kitty interaction, image/file input, disconnect/reconnect, cancel dropping follow-ups, and clean terminal exit. Protocol incompatibility produces an actionable message.

### Stage 4: Release and primary-entrypoint transition

Run native-only, Discord-only and combined deployment checks. Ship backend/web/TUI compatibility information, config/storage migrations, backup/restore and downgrade limitations. Changing defaults must not expose an unauthenticated gateway on an existing install.

Measure redacted connection/replay bytes, bootstrap latency, cache resets, queue pressure, native handoff failures and commit-to-client timing. Preserve request/thread/connection correlation without logging credentials or private message bodies.

Run focused workspace tests/typechecks, required architecture/codec checks, complete `bun run check` on final implementation changes, and browser/terminal integration checks. Use event/state synchronization, not fixed test waits. Incremental implementation commits are authorized. Publishing still requires a separate user request.

Release gate: install using local or Clerk auth, start work without Discord, attach files, leave/reconnect, inspect results, search, rewind and continue. Native then becomes the default entrypoint, with Discord optional.

## Required failure and conformance coverage

| Area | Cases |
| --- | --- |
| Auth/visibility | Owner/read/edit catalog and mutation access; fixed local user; login/logout; expired session; owner add/change/remove share; guessed IDs and URLs confer no membership; no anonymous access; owner-only external surfaces. |
| Mixed users | Starter tool mode and agent data identity remain authoritative across editor inputs; internal auto-injected search uses that scope; direct viewers retain their own access; restricted participants cannot mutate through stale edit grants; restricted starters use their own threads; full-access readers stay read-only; mode/share changes revalidate commands; cross-thread self-prompts check source-starter destination edit access. |
| Replay | No-change under 1 KiB even after cursor expiry; stable turnId with changing text/activity revisions; one paragraph without previous text/metadata; changed state with unavailable delta resets; torn-cache prevention; duplicate batches; partial history coverage; latest-first catch-up while live writes continue; turn/range placeholders hydrating out of order; bounded placeholder count; failed hydration/retry; crash before slots are hydrated; late page after rewind/delete; viewport changes during backfill; removal/rewind invalidation. |
| Startup | Bootstrap/socket in either arrival order; write during snapshot; cached deep link; cold selected thread without list dependency; auth rejection; network outage; service-worker upgrade. |
| Streaming | Delimiter across chunks, CRLF, blank lines in fences, remainder flush, complete tool boundaries, cancellation/failure, provider phase mapping, retry resets, surface config changed during a run. |
| Timeline | Active work blocks split by commentary; settled fold/final answer; expansion; durations after reconnect; compaction marker; no hidden active workflow. |
| Admission/output | Commit-before-ack disconnect; duplicated command; pending handoff at crash; completed run before native write; bounded slow consumer; receipt expiry. |
| Queue/rewind/delete | Editors may delete/rewind while readers cannot; steering targets rejected; cancel drops queued follow-ups without a start race; remove pending input; cancel-then-rewind; stale target generation; late output; process death mid-mutation; valid prefix after compaction/provider continuation. |
| Resources | Origin-thread authorization, staged upload ownership, forbidden reference creation, source membership loss and origin deletion, cross-thread reuse without reparenting; broad file input, unsupported model media fallback, clipboard/path input, send before upload finishes; multiple attachments completing out of order; upload failure/retry without duplicate input; run finish/cancel/rewind while uploading; readiness after restart; progress fanout/coalescing; interrupted uploads, size limit, live path changed/deleted, unauthorized preview and mutable caching. |
| Config | Detailed parser errors, concurrent disk save, Core auto-reload, MCP Save leaves applied registry unchanged until Reload, per-server reload outcome, no participant access, no `.env` write path. |
| Questions | Native capability absent from tool discovery and surface registry; stale attempts settle unsupported; no pending native question state; existing Discord question behavior unchanged. |
| Search | Native/transcript dedupe, long-thread summary refresh, membership-scoped snippets, deletion/rewind cleanup, owner-only external reads. |
| UI performance | Long code/math/diagram turns, last-window loading, background backfill priority, memoization/virtualization, keyboard/IME, storage eviction and terminal escape input. |
| UI design/contracts | Lucide icon controls have tooltips and accessible names; no redundant copy; token-based hierarchy/spacing/type; borders only where needed; keyboard focus preserved; every RPC field has a display/interaction/synchronization purpose; static autocomplete works without per-keystroke RPC; unchanged catalogs do not retransmit; scope/revision invalidation prevents stale unauthorized entries; dynamic search remains backend-filtered. |
| Regression | Existing Discord/GitHub semantics, workflow delivery, resources, request recovery and canonical history remain valid. |

## Reference evidence

Updated `/home/stanley/Sandbox/t3code` by clean fast-forward from `b1e223e2b` to `52e4b4429` on 2026-09-18. No local worktree changes were present. Inspected the updated source after the fast-forward.

- `apps/web/src/components/chat/MessagesTimeline.logic.ts`: active visual responses and settled work folds, including thinking/compaction behavior.
- `apps/web/src/components/chat/MessagesTimeline.tsx`: user-message "Edit from here" control.
- `apps/web/src/components/chat/ComposerCommandMenu.tsx`, `apps/web/src/composer-logic.ts`: command/skill menu, cursor trigger and selection behavior.
- `packages/contracts/src/orchestration.ts`: a distinct history-only revert contract, separate from file-checkpoint restore.
- `packages/client-runtime/src/rpc/protocol.ts`: T3 uses Effect's typed RPC. Lilac should reuse the interface principle without adopting T3's entire Effect stack.
- `packages/client-runtime/src/state/threadSnapshotHttp.ts`: windowed thread snapshot support and optional reasoning detail.

Stanley's supplied screenshots define the requested active/settled timeline, rewind control, combined slash menu and skills-only dollar menu. Only matching behaviors are adopted; T3's other product features are not part of this plan.

## Scope closure and implementation preparation

The five remaining decisions are settled: owner adds participants; thread execution follows the starter and restricted participants are read-only; effective editors can delete/rewind; steering inputs are not rewind targets; oRPC is selected. Owner-managed authenticated `read`/`edit` sharing is in MVP. Anonymous read sharing is optional future work and is not included in these stages.

Everyone's ability to create their own thread remains: a restricted starter can work in their own restricted thread. The read-only restriction applies when they are added as participants to another user's thread. This distinguishes their own execution authority from shared-thread access.

The adversarial review is resolved in scope: starter identity also governs agent data access; resources retain origin-thread authority with submit-time ownership checks; immutable turn IDs are distinct from mutable revisions and replay cursors; unchanged state renews expired cursors without a snapshot; native structured questions are deferred; MCP config uses an explicit Reload button.

No open product question blocks preparing implementation. Technical proofs, exact schema/version details, limits and migration mechanics remain Stage 0 work. This planning task does not start implementation or change the repository's active-plan index.

Engineering defaults to validate, without reopening product scope: surface streaming defaults to `paragraph`; local auth has one fixed owner; initial recent window is five turns with a byte cap; config starts as a validated editor; user messages restore text only on rewind; timing budgets use the stated reference fixture. Exact replay/cache byte caps and package versions are selected during implementation preparation.
