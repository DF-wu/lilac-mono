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
    port: 8787
    publicUrl: http://localhost:8787
    allowedOrigins:
      - http://localhost:8787
    auth:
      provider: local
      ownerId: owner
    outputStreaming: paragraph
```

Set `LILAC_NATIVE_LOCAL_USERNAME`, `LILAC_NATIVE_LOCAL_PASSWORD_HASH` and
`LILAC_NATIVE_SESSION_SECRET` in the existing process environment or credential configuration. The
password hash must use Argon2id; the session signing secret must contain at least 32 bytes. Keep these
values outside core-config and source control. Local authentication has one configured owner and no
user creation endpoint. Restarting Core invalidates its local sessions.

Start Core normally and open `http://localhost:8787`. Discord credentials are optional when the native
surface is enabled. The listener defaults to loopback and remains disabled on existing installations.
For a remote installation, put the native listener behind HTTPS and set `publicUrl` and
`allowedOrigins` to the externally visible origin. Auth uses the configured public URL; arbitrary
forwarded headers cannot change it.

For frontend development, run `bun run dev:web`. Vite proxies `/api` and WebSocket upgrades to
`http://127.0.0.1:8787`; `LILAC_WEB_BACKEND_URL` overrides that development target. Add the development
origin, normally `http://localhost:5173`, to `allowedOrigins`.

## Design system

Open `/design-system`, or use the palette button in the sidebar, to inspect the real UI components
with synthetic examples. The page requires no login and makes no requests for conversations or
configuration. It includes dark/light themes, thread states, messages, composer, attachment previews,
code blocks, controls, overlays and layout. The input-required thread state is a visual specimen;
the native question capability remains unimplemented.

## Clerk

Choose Clerk per installation with `surface.native.auth.provider: clerk`. Configure the owner's native
`ownerId`, Clerk `ownerProviderUserId` and `clerkIssuer`. A registered public `clerkOAuthClientId` is
only needed for OAuth clients such as the TUI; browser sessions work without one. Set
`CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` in the server environment. `CLERK_JWT_KEY` is optional.
Only the publishable key reaches the browser. The web build does not embed installation credentials.

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

`outputStreaming: paragraph` publishes text at blank-line boundaries. `complete` publishes the
buffered text at model-step completion or tool handoff. Clients never receive token-by-token text.
Compaction and activity remain explicit display events. Native structured questions are unsupported.

Old-message selection and storage retention are separate settings:
`oldMessageSelectionMaxAgeMs` and `storageRetentionMaxAgeMs`. Both default to `null`, which disables
them. Replay history has its own bounded retention; an expired replay cursor replaces the visible
window and leaves older history available for hydration.

## Settings and updates

Only the owner can open settings. Save validates and atomically updates the existing core or MCP
config, using revisions to reject concurrent edits. Core keeps its existing reload behavior. MCP
Save writes the document; Reload applies it through the existing MCP registry. The UI does not edit
`.env` or credential files. Listener and authentication settings take effect when Core restarts.

The owner can change the agent's display name and upload a PNG, JPEG, WebP or GIF avatar up to 2 MiB.
These settings persist in the native service-user record; the service identity remains `lilac`.
Authenticated participants see the same identity across threads. Avatar URLs include a content
revision and use the browser's private cache; changing the avatar changes its URL.

The browser caches versioned app assets and scoped conversation projections separately. Private
API responses never enter the service worker cache. Logout clears cached conversation data. An app update
offers a Reload button; drafts remain on the device until sent or cleared.

## Terminal client

The installer includes `bin/lilac-tui`. Run it against the same native server as the web app:

```sh
./bin/lilac-tui --url http://127.0.0.1:8787
```

From a source checkout, use `bun run dev:tui -- --url http://127.0.0.1:8787`.
`bun run build:tui` creates a standalone binary in `apps/tui/dist` for the current platform.
Use `--thread ID` to open a thread, `--no-cache` to disable transcript caching, or `--login`
to sign in again. Release artifacts pair the server and clients from the same commit.

The TUI uses OpenTUI/Solid and renders plain text. Markdown, tables, math and diagrams remain source
text; images are accepted as input and listed as attachments. Enter sends, Shift+Enter adds a line,
Ctrl+C cancels the run, and Ctrl+Q exits. Ctrl+T opens conversations, Ctrl+M opens models and Ctrl+K
shows the queue. Use `$` or `/skill:` for skills and `/` for commands. Tab inserts the selected
completion. `:help` lists commands for search, older history, queue removal, upload retry and rewind.
New conversations stay local until Send.

Use `:attach /path/to/file` for file and image input. Ctrl+V reads the host clipboard through OpenTUI
when supported. Over SSH that is the remote host's clipboard; use file paths or run the client locally
against the remote server. Sent attachments show progress while the composer remains usable.
The server waits for resources before starting work. Output strips terminal control sequences.

Local auth prompts for the fixed username and password. The password is never saved. Clerk opens a
browser using Authorization Code with PKCE and a temporary loopback callback. Register a public OAuth
client with required PKCE, redirect URI `http://127.0.0.1/callback`, and scopes
`openid profile offline_access`; set its ID in `surface.native.auth.clerkOAuthClientId`.
Enable JWT OAuth access tokens in Clerk. For SSH, run the client locally or arrange forwarding for
the callback port. This version does not implement a device-code fallback.

Credentials live under `$XDG_CONFIG_HOME/lilac/tui`, defaulting to `~/.config/lilac/tui`.
Conversation cache lives separately under `$XDG_CACHE_HOME/lilac/tui`, defaulting to
`~/.cache/lilac/tui`. Directories use mode 0700 and files use mode 0600. Atomic cache writes retain
at most 64 threads within 32 MiB. Corrupt or incompatible cache files reset from the server.
`:logout` invalidates the current token at the native server, revokes the Clerk refresh token when
applicable, and clears local credentials and the principal's cache. Clerk JWT access tokens remain
valid upstream until expiry; native logout blocks the current token for the running server process.

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
