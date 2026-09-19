# Native surface implementation progress

Active plan: [native-surface.md](native-surface.md). Product scope and stage exit gates are unchanged.

## Implementation status

The backend, shared client and web SPA are complete through Stage 2. Independent standards and
specification reviews found no remaining blockers after the final fixes. Repository checks, the
production build and browser verification passed. Stage 3 has not started.

The initial protocol proof was committed as `61485a63`; backend and web implementation were committed
as `8ed38ff7`. Subsequent implementation adds:

- A separate versioned SQLite native store, immutable turns, command receipts, owner-managed sharing,
  starter authority, replay checkpoints, deferred history and bounded detail pagination.
- Local fixed-owner sessions and Clerk verification, authenticated bootstrap and one typed oRPC
  socket, HTTP uploads and origin-thread-authorized resources.
- Existing execution admission, pinned model selection, steering/follow-up/cancel, upload gating,
  rewind/delete recovery, canonical history selection, semantic durable output and compaction events.
- Native surface tools, search and summaries, read-only external views, static skill/command catalogs,
  owner config Save and MCP Reload. Structured native questions remain unsupported.
- A framework-independent client with persistent replay/cache interfaces, revision fences, reconnect,
  incremental updates, scoped IndexedDB storage and bounded inactive state.
- React/Vite UI with virtualized lists, local autocomplete, resource previews, persistent text/skill
  drafts, activity folds, rich Markdown and explicit service-worker updates.

## Performance fixture and limits

Reference environment: Linux x86_64, AMD Ryzen 9 5950X, Bun 1.4.2, Chrome 151 headless, loopback with
no injected latency. The executable fixture is
`apps/core/tests/surface/native/browser-fixture.ts`. It uses production native services and runner
with a deterministic model, synthetic credentials, 600 historical turns, 60 sidebar threads, rich
content and a huge paged turn. It does not use the operator's real conversations or credentials.

Selected implementation bounds:

| Item | Bound |
| --- | --- |
| Initial recent window | Five turns, 224 KiB projection budget. |
| Replay retention | Seven days and 128 MiB across retained native changes. |
| Persisted browser thread cache | 24 threads, 64 MiB, with eviction. |
| Inactive shared-client stores | Eight; active or observed stores remain pinned. |
| Deferred hydration | Bounded turn/range and within-turn pages, independent of committed replay cursor. |

Measured unchanged rich-thread navigation transfers 702–708 bytes including masked client/server
WebSocket framing, subscription replacement and the queue request. Authentication and connection
establishment are excluded. The browser renders cached content before waiting for these requests.
Earlier protocol-only fixtures measured 355 bytes with representative IDs and 753 bytes at maximum
schema identifier lengths; those results do not include the web UI's queue traffic.

The browser fixture records frame sizes and request paths without recording credentials or message
payloads. Twenty cached rich-thread clicks measured 43.7 ms p95 and 44.5 ms maximum through two animation
frames, within the 50 ms reference target. Twenty uncached 600-turn bootstrap requests measured
5.1 ms p95 and 23.3 ms maximum including loopback transfer and JSON parsing. The response was
20,942 bytes and contained a bounded recent window rather than the full history.

A cold production shell transferred 609,049 bytes on the fixture's uncompressed HTTP endpoint,
including headers for its three asset requests. The build reports approximately 175 KiB gzip for
main JavaScript. The rich fixture fetched 5.72 MB of lazy renderer assets in total. A subsequent
service-worker-controlled reload transferred zero asset bytes. On that warm reload the socket opened
at 47 ms and bootstrap began at 60.9 ms; neither waited for the auth-info response or a thread-list
request. The rich fixture measured 30.8 MB JavaScript heap, 0.007 layout shift and a longest renderer
long task of 135 ms. Rich libraries remain an observable lazy-load cost, separate from cached
thread navigation.

## Review and fixes

Independent standards and specification reviews run against `61485a63` plus the implementation.
Confirmed fixes include:

- Snapshot/live ordering, stale generation fences, sparse hydration and missing-target cursor safety.
- Duplicate initial selected-thread transfer, duplicate queue reads and stale cached-store replacement.
- Durable model-plan pinning and input acknowledgement before model execution.
- Repeated TTL trimming with explicit canonical-history provenance, including identical user turns.
- Shutdown drainage for RPC mutations and HTTP transfers, original defect supervision, and persistence
  errors preserved during failed upload settlement.
- Native summaries moved into the existing scheduler, outside critical delivery maintenance.
- Config editor save/tab races, external transcript ordering, draft restoration and logout races.

Independent re-review cleared the web upload lifecycle, rich accessibility, config, auth/logout and
client memory fixes. Actual browser tests cover two users, immediate access revocation, two-tab
logout, automatic 60-second expiry with private-cache purge, latest-turn positioning and bounded
history hydration, malformed rich content, drafts, file retry/preview, non-blocking send and rewind.
An explicit service-worker upgrade from build `980c627937d74d1f3297` to `2e86b19823697da5995a`
preserved the draft. The late command review fixed omitted optional prompt metadata, custom-command
activity and stable workflow activity identity across retry/recovery. Success, failure and cancellation
have real-runtime integration coverage, and the fix passed independent review.

The user selected automatic follow-ups for active-run custom commands. Backend admission normalizes
commands to follow-ups even when a client sends steering, pins the selected next-run model, and keeps
retry receipts stable. The composer reflects the effective mode. A real-runner integration test proves
the command waits for the current run and executes once in the next full turn.

The update notice now appears during sign-in, startup and offline states as well as an open session.
A browser check triggered the preload-error path while signed out, verified Reload was visible, and
used it to reload the sign-in page. A subsequent review found that a failed Clerk lazy import could
unmount that notice. Account controls now have an error boundary with a Reload fallback. Logout
catches account-module loading failures and routes them through the existing logout operation,
which clears private client state and reports the provider failure. A successful load invokes Clerk
sign-out before unmounting its provider. Controller regressions cover provider rejection and the
invoke-before-unmount ordering. An actual blocked Clerk chunk browser test confirmed that the shell
and Reload survive, repeated failures remain recoverable, and Reload restores sign-in after the
request block is removed.

## Authentication evidence

Local sessions, expiry, origin checks, resource access and principal isolation have executable tests.
A real native-only Core process starts against disposable Redis without Discord credentials, serves
an authenticated bootstrap and exits naturally after shutdown. Production-service integration tests
exercise streaming, replay, rewind, upload gating, steering, follow-ups, cancellation and shared-reader
permissions.

Clerk CLI initialization links the development app `app_3JVlP4sHyXZsQVtvzO819Lswzaq`. CLI doctor passes
its integration checks. The local credential files are ignored `apps/web/.env.local` and the Clerk
CLI's `/home/stanley/.config/clerk-cli/config.json`; their contents are not included in this document.
The supplied Clerk application user was configured as the owner in an isolated live fixture. A
short-lived, single-use Clerk sign-in ticket exercised the real Clerk SDK and backend verification.
Owner bootstrap, socket prompts, file upload/preview, automatic token refresh, authenticated reload,
and sign-out passed. Bootstrap and the previously accessible resource returned 401 after sign-out.
This verifies application sessions, not an interactive password or GitHub OAuth login. No registration
flow was added to Lilac; the embedded sign-in card hides signup and disables signup transfer.

`apps/core/tests/surface/native/clerk-browser-fixture.ts` loads the existing ignored environment
configuration at runtime and takes `TEST_NATIVE_CLERK_OWNER_ID`. It uses a disposable native store and
deterministic model without changing the operator's normal Core configuration. No credentials or
sign-in tickets were recorded in source or test artifacts.

The hosted application entry is `https://thorough-lamb-9546.accounts.dev/sign-in`.

OpenTUI runtime/clipboard research is in
[native-stage0-auth-terminal.md](native-stage0-auth-terminal.md). Actual Ghostty/Kitty and terminal
OAuth interaction have not been claimed as tested. No TUI implementation is included in this stage.

## Verification record

Focused protocol, store, execution, gateway, resource, runtime, client, cache, web and architecture
tests have passed as their review fixes landed. Full `bun run check` passed, including Core
tests, all other workspace tests, architecture checks, lint, formatting and repository typechecks.
The production web build also passed. A final check is repeated before each incremental commit.

See [operator setup and rollback](../docs/native-surface.md) and
[MIGRATIONS.md](../MIGRATIONS.md) for deployment and persistence details.

## Web component and draft follow-up

The web UI now uses the official shadcn Base UI registry components for split panes, messages,
markers, selectors, popovers, dropdown/context menus, dialogs, buttons, inputs and activity folds.
The existing virtualized history scroller retains ownership of deferred hydration and saved offsets;
MessageScroller was evaluated but would introduce competing scroll anchoring for those virtual rows.
The project logo is the bundled favicon. Sidebar toggle coordinates stay fixed across collapse, and
keyboard resizing works. Mobile verification at 390 pixels found no horizontal page overflow.

Plate supplies rich Markdown editing and keeps the existing Markdown wire payload. The editor is a
separate lazy chunk. Browser checks cover formatting, skill completion, multiple list items, heading
to paragraph editing, selectors, focus handling, dialogs and activity expansion. Plain-text editor
identity drives command/skill matching so Markdown escapes cannot change invocation names.

New conversations remain local until first Send. Dirty draft rows support rename/delete and persist
text and selection metadata in the existing scoped draft cache. Files remain in memory until Send.
Browser checks cover first-send creation/upload delays, editing and navigation during those delays,
unopened-thread actions, local draft restoration and Back navigation. No backend or wire changes
were required.

## Web layout and activity follow-up

Select menus now pad their item lists, the search icon sits inside the input, and the sidebar toggle
shares the header's vertical center while retaining its coordinates across collapse. Settled work
expands inline through the main timeline. Activity groups and individual tool details remain
independently collapsed until opened; expanding them suspends tail-following so the view stays put.
The sidebar shows relative activity times and offers thread details on hover or keyboard focus,
including the starter, model when selected, status and people with access. Participant names use the
existing authorized RPC only when details open. No wire or storage changes were needed.

Browser verification covers menu spacing, search placement, both toggle states, desktop/mobile
layout, inline expansion, individual tool detail disclosure, participant details and long-turn
paging. Focused tests cover default activity disclosure and relative timestamps. Standards and spec
reviews found no blockers.
