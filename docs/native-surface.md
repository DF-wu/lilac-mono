# Native surface

The native surface runs inside Core. It owns `native-surface.db` independently of Discord and serves
the web app, authenticated HTTP bootstrap, file endpoints and one typed oRPC WebSocket. A native
thread is a session. Messages start work without a mention or active-channel mode.

## Local setup

Build the web assets with `bun run build:web`. Enable the surface in an existing version-2
`core-config.yaml`:

```yaml
surface:
  native:
    enabled: true
    installationId: my-lilac
    host: 127.0.0.1
    port: 8789
    publicUrl: http://localhost:8789
    allowedOrigins:
      - http://localhost:8789
    auth:
      provider: local
      ownerId: owner
```

Set `LILAC_NATIVE_LOCAL_USERNAME`, `LILAC_NATIVE_LOCAL_PASSWORD_HASH` and
`LILAC_NATIVE_SESSION_SECRET` in the existing process environment or credential configuration. The
password hash must use Argon2id; the session signing secret must contain at least 32 bytes. Keep these
values outside core-config and source control. Local authentication has one configured owner and no
user creation endpoint. Restarting Core invalidates its local sessions.

Start Core normally and open `http://localhost:8789`. Discord credentials are optional when the native
surface is enabled. The listener defaults to loopback and remains disabled on existing installations.
Native web uses port 8789 by default; GitHub webhooks use 8787 and the operator console uses 8788.
For a remote installation, put the native listener behind HTTPS and set `publicUrl` and
`allowedOrigins` to the externally visible origin. Auth uses the configured public URL; arbitrary
forwarded headers cannot change it.

For frontend development, run `bun run dev:web`. Vite proxies `/api` and WebSocket upgrades to
`http://127.0.0.1:8789`; `LILAC_WEB_BACKEND_URL` overrides that development target. Add the development
origin, normally `http://localhost:5173`, to `allowedOrigins`.

## Design system

Open `/design-system`, or use the palette button in the sidebar, to inspect the real UI components
with synthetic examples. The page requires no login and makes no requests for conversations or
configuration. It includes dark/light themes, thread states, messages, composer, attachment previews,
code blocks, controls, overlays and layout. The input-required thread state is a visual specimen;
the native question capability remains unimplemented.

## Clerk

Choose Clerk per installation with `surface.native.auth.provider: clerk`. Configure the owner's native
`ownerId`, Clerk `ownerProviderUserId` and `clerkIssuer`. Browser sessions do not require a `clerkOAuthClientId`. Set
`CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in the server environment. `CLERK_JWT_KEY` is optional.
Only the publishable key reaches the browser. The web build does not embed installation credentials.

Settings → Account embeds Clerk's profile and security controls, including connected accounts.
Local-password installations keep the name and avatar editor. Thread preferences and the access
summary are in Settings → Options.

The owner adds existing Clerk accounts to the native user directory and shares threads with read or
edit access. Signing in does not enroll an account. The web app has no registration or onboarding
flow. The CLI's administrator login and an application's end-user account are separate identities.

The owner sees all threads and config. Other users see only their threads. Restricted users can
operate threads they started but cannot edit another starter's thread. Runs use the starter's tool
and data authority. Human author attribution remains separate.

## Conversation behavior

New conversation opens a local draft. Typing or attaching files adds it to the sidebar; the server
thread is created on the first Send. Draft text survives reloads, while unsent files must be reattached.
The composer supports basic Markdown formatting through Plate. Enter sends; Shift+Enter continues
writing. Attachments appear as inline file chips. Drafts restored after reload require missing files
to be reattached or removed before sending. Sidebar rows show the starter and activity time; rename,
archive and delete replace the timestamp on hover or focus. A completed indicator remains until the
latest settled turn is visible in the foreground tab. Working and failed runs have separate states.

The thread's model selection applies to new full turns. Active runs retain their selected model.
Sending while a run is active steers by default; follow-up mode queues a full turn. Cancel drops
queued follow-ups. Users can remove queued entries but cannot reorder or edit them.
Custom commands sent during an active run automatically queue as follow-ups, including when the
composer was set to steering. They use the selected next-run model and execute at the start of that
new full turn.

Rewind targets a full user turn. It cancels active work, removes that turn and later history, and puts
the original text into the composer. Steering messages are not rewind targets. Rewind does not undo
external tool effects.

Attachments upload over HTTP. Sending accepts the message while upload continues; execution waits
for all file resources. Resource access follows the file's original thread, including when another
thread references it. Text previews return at most 64 KiB, with a truncation indicator for larger
files and an error for binary data. Local and SSH filepath previews read only that prefix of the
latest file and show an error when it is gone.

Markdown links and images accept retained `resource://r1_<128-bit-id>` references. They use the
authenticated resource endpoint and preserve the original resource's access rules. Transient
`resource://t1_` references and explicit SSH URIs are not supported in Markdown.

Settings > Deployment controls response streaming for the instance. Paragraph publishes text at
blank-line boundaries. Full publishes the
buffered text at model-step completion or tool handoff. Clients never receive token-by-token text.
Compaction and activity remain explicit display events. Native structured questions are unsupported.

Old-message selection and storage retention are separate settings:
`oldMessageSelectionMaxAgeMs` and `storageRetentionMaxAgeMs`. Both default to `null`, which disables
them. Replay history has its own bounded retention; an expired replay cursor replaces the visible
window and leaves older history available for hydration.

## Settings and updates

The owner manages title generation, response streaming, old-message selection age, storage retention,
and whether cross-thread sends trigger a run in Settings > Deployment. These settings persist in the
native database. On first startup after upgrading, Core imports their existing `surface.native`
values once without rewriting the YAML file. Later YAML edits do not override database settings.
Saves reject stale revisions. New title jobs, output attempts, selections, and retention passes use
the latest settings; active output attempts keep their original streaming mode.

Core and MCP configuration editors are also owner-only. Save validates and atomically updates the
selected file, using revisions to reject concurrent edits. Core keeps its existing reload behavior. MCP
Save writes the document; Reload applies it through the existing MCP registry. The UI does not edit
`.env` or credential files. Listener and authentication settings take effect when Core restarts.

The owner can change the agent's display name and upload a PNG, JPEG, WebP or GIF avatar up to 2 MiB.
These settings persist in the native service-user record; the service identity remains `lilac`.
Authenticated participants see the same identity across threads. Avatar URLs include a content
revision and use the browser's private cache; changing the avatar changes its URL.

The browser caches versioned app assets and scoped conversation projections separately. Private
API responses never enter the service worker cache. Logout clears cached conversation data. An app update
offers a Reload button; drafts remain on the device until sent or cleared.

## Temporary operator console

The container includes `lilac-tui`. From the installation directory, run:

```sh
docker compose exec --user root lilac lilac-tui
```

The installer offers "Talk to Lilac now" after deployment. Terminal-only installation needs a model
provider but no Discord, local password, or Clerk account. Web and Discord can be configured separately.

Each invocation creates one temporary owner conversation. Ctrl+Q exits, cancels active work, and deletes
the conversation using native deletion. If the terminal disappears, heartbeats stop and Core deletes the
conversation after 30 seconds. Reconnecting within that grace period keeps the same invocation alive.
Core cleans abandoned conversations before recovering agent work after restart. Temporary conversations
stay out of the web sidebar and search. Normal deletion and resource-retention rules apply; this is not
secure erasure of databases, logs, provider records, or backups. Files created by tools and external
side effects remain.

The console uses the existing native protocol and agent runner. Its separate HTTP/WebSocket listener
binds only to container loopback on port 8788, which is not published. Every request requires the root-only
`/run/lilac/operator-token` in an authorization header. Startup rotates that token; Core receives its
hash. The authenticated identity is the configured native owner. Tools still execute with the Core
service user's authority, never the terminal client's root identity.

There is no saved login, disk conversation cache, remote URL option, thread browser, or standalone TUI
release. The image's Bun runtime loads the root-owned console and dependencies. Local password and Clerk
web authentication continue to work independently. The legacy Clerk OAuth-client configuration is no
longer needed by the terminal.

Enter sends; Shift+Enter adds a line; Ctrl+C cancels work; Ctrl+Q exits. Ctrl+M selects a model and Ctrl+K
shows queued inputs. Use `$` or `/skill:` for skills and `/` for commands. `:help` lists the remaining
terminal commands. `:attach /path/to/file` reads a file inside the container. The console renders plain
text and strips terminal control sequences. It does not read the host clipboard.

For source development, `bun run dev:tui` connects to the same local operator endpoint. It requires
access to the operator token, just like the container command.

## Diagnostics and compatibility

See [verification evidence and limits](native-surface-verification.md) for deployment, authentication,
terminal/browser checks and the previous performance baseline.

Backend, shared clients and display projection use native protocol version 1. Update the server and
clients together. Older web tabs retain assets until reload; terminal clients report an incompatible
response instead of interpreting another protocol version.

Debug logging under `surface:native:metrics` records connection IDs, application-frame byte counts,
bootstrap duration, replay kind/resets, queue pressure and handoff failures. Request and thread IDs
correlate output commits with socket enqueue timing. This timing ends at the server's socket send,
not at client rendering. Byte counters exclude TLS and WebSocket framing overhead. Metric fields
omit credentials and conversation bodies.

## Surface tools

Native surface tools accept both `native:<threadId>` and the bare thread ID returned by listings.
Use `native:<threadId>` as the canonical session ID. `surface.sessions.list` paginates through all
readable active threads, subject to its requested limit. Set `archived: true` to list archived threads.
Message reads and lists include display names and reply context. Lilac's projected replies support
editing, deletion and reactions, including replies created before explicit author metadata was added.

`surface.messages.send` creates a separate message. `attachment.add_files` attaches a file to the
active response. Both copy files into managed blob storage and expose native resource attachments;
the original local file can then be removed. Active-response attachments participate in output replay,
checkpoint rollback and thread rewind. A canceled response retains attachments already published.

Recent agent writes include projected responses and tool-sent messages. Startup restores missing links
for historical responses whose native input records identify the owning request. It cannot infer the
owner of older standalone tool messages that have no request link.

`conversation.thread.search` and automatic recall use the same summary and embedding index for
Discord and native conversations. Both origins search all retained native threads and allowlisted
Discord conversations. Native ownership and sharing grants do not restrict these agent memory reads;
they still control native UI access and conversation modification. Deleted, rewound, pending-mutation,
and ephemeral native content is excluded. Explicit `participantId` filters remain available; automatic
participant filtering applies only within Discord when the request originates there.

Search supports lexical, semantic, and hybrid retrieval with shared ranking and `minScore` behavior.
Use `surface: native` or `surface: discord` to restrict a search. Compact results, metadata, reads, and
automatic recall include `surface`. Native conversation-memory IDs use `native:<threadId>` and can be
passed directly to `conversation.thread.read`. Summarization maintenance uses the shared runner and
supports native IDs, dry runs, force, clear, and embedding refresh. Structured questions remain unavailable.

## Persistence and rollback

Back up `native-surface.db` together with Core's transcript, resource, request-delivery and agent-run
stores and managed blob data. Use the normal coordinated shutdown or a consistent SQLite backup;
copying a live database without its WAL can lose accepted work.

Native input receipts and upload readiness are durable before execution admission. Native output
uses a managed nonexpiring event topic; projection receipts make replay idempotent. Agent-run
checkpoints record the output frontier they cover, so restart retains the committed prefix and removes
abandoned output. External tool effects still have the existing at-least-once recovery behavior.

See [MIGRATIONS.md](../MIGRATIONS.md) before downgrading. Older builds do not understand native refs,
resource origins or native recovery checkpoint fields. Drain work and keep a consistent backup before
switching binaries.


## Conversation links

Use **Copy link** in a native conversation card's context menu, or right-click a native or Discord
message's copy button. A normal click still copies the message content. Paste a copied link into the
composer to insert an inline reference with the conversation's icon and title. Missing titles fall
back to the session ID. Title autocomplete is not included.

Click a reference to open a read-only tab in the right panel. Message links highlight the source
message and allow paging toward older and newer messages in its conversation. Session links open
at the latest messages. The context menu offers **Open in main view**, **Copy link**, and **Open in
Discord** where available. A response split across Discord messages links to its first source
message. Rows without a source message offer **Copy conversation link** instead.

Native previews update while open. Discord previews use retained agent history, not a live channel
fetch. Missing messages keep an external-open fallback. Existing membership and owner-only external
history rules apply to links. The agent receives session coordinates for session links, and the
conversation thread ID plus source message coordinates for message links when locally resolvable.
Referenced message content is not automatically inserted into the prompt.
