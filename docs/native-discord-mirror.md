# Native conversation recording to Discord (DF fork)

This optional DF-wu fork feature records new native user-surface messages to one owner-provisioned
Discord incoming webhook. It is disabled by default. It does not use an agent transcript, expose a
configuration API, add a UI, or change any stored or wire format.
It works with any configured image user and native authentication provider; no deployment identity
or named account is required.

## Activation

1. The owner provisions an incoming webhook for an ordinary Discord text channel and puts its URL in
   the Core process's protected `LILAC_NATIVE_DISCORD_WEBHOOK_URL` environment variable. Provision this
   through the existing secret-management/deployment workflow; do not put the value in source control,
   command output, chat history, or configuration documents.
2. Pass that environment variable into Core, including through the container environment when using
   Docker. A host variable alone is insufficient if the container does not receive it. The accepted URL
   is HTTPS on `discord.com`, under `/api/webhooks/<id>/<token>` or
   `/api/v10/webhooks/<id>/<token>`, without query parameters, fragments or URL credentials.
3. On the next Core start, native ingress activates recording. No historical
   scan or backfill runs. Unset the variable to disable recording on the next start. Invalid values
   disable recording with a generic warning that contains no URL.

### Container and source setup

- **Source Compose (`compose.yaml`):** set `LILAC_NATIVE_DISCORD_WEBHOOK_URL` in the protected `.env`
  beside the Compose file, or supply it through the shell/deployment environment. Stock Compose forwards
  this variable into Core with an empty default; `.env.example` includes the optional key. Keep `.env`
  private (`chmod 600 .env`). Apply changed values by recreating the Core container; restarting an
  existing container alone does not reload Compose environment settings.
- **Guided installer:** set the same key in the installation's protected `secrets.env` (mode `0600`).
  The generated Core service already loads that file through `env_file`, including additional keys;
  no installer prompt or `core-config.yaml` entry is needed. Recreate the Core container from that
  installation directory after changing it. An explicit value under Compose `environment` overrides
  `env_file`, so remove any stale override when using this path.
- **Other Docker entrypoints:** explicitly pass the key to the Core container through your existing
  protected environment file or secret workflow. The image entrypoint preserves it while dropping to
  the configured service user. Image tag, container username and UID do not select this feature.
- **Direct source runs:** provide the key in the Core process environment using the normal protected
  environment workflow.

Keep the key empty or unset to leave recording disabled. Use an image/build containing this fork
feature. Do not print a resolved Compose configuration with real credentials during validation.
These instructions do not provision secrets, restart Core, or send a verification post automatically.
Forum/media channels and a `thread_id` destination are not supported in this first version.

## Content and source boundary

The observer runs after native display mutations persist and checks the committed replay row after
the outer SQLite transaction finishes. Rolled-back mutations are discarded. It covers accepted human
input, projected assistant output, delivered native surface sends, resource readiness and message
edits/removals. Projection receipts continue to deduplicate semantic output.

Only `text` and `data-resource` parts in the `ready` state are eligible. System messages, reasoning,
tool calls/results, activities, questions, workflow cards, compaction, actions, reactions, input-state
details, logs and other internal parts are excluded. Human messages must identify a native human user;
service-authored user inputs are excluded. Agent/subagent display streams and imported external output
(`externalRunId`) are excluded. Discord and Telegram conversation histories are never read or recorded.

The source boundary is the persisted **native destination thread**: a visible assistant message sent
there by the native surface adapter, including an authorized service/cross-surface notification, is
eligible. Its internal execution/source conversation is not read or mirrored. This records what the
native user actually sees without forwarding activity/tool metadata from the originating run.

Recording attaches at native ingress, after initial question recovery, output subscription setup and
deferred-send reconciliation. New mirror insertions must carry an original native creation timestamp
at or after activation; old semantic events retain their older timestamp and are skipped even when
their projection happens later. Existing messages first encountered through an edit are not backfilled.
New visible continuations and sends delivered after activation can be recorded in existing threads.

Ready attachments resolve through native thread authorization, upload ownership, byte limits and
terminal integrity verification. Discord receives multipart file bytes, never a resource URI or a
private download URL. Oversized/unavailable attachments get a generic omission marker. Pending, failed
and canceled resources are not uploaded. Live `/api/files/` links and `resource://` text references are
replaced by markers; a live-file link alone is not converted into an attachment.

## Delivery, edits and ordering

One process-local sender serializes requests across conversations. Pending edits to a message may
coalesce. Each Discord chunk identifies `native:<thread-id>`, the human/assistant author, native message
ID and part number. Text chunks stay below Discord's 2,000-character limit without splitting a UTF-16
surrogate pair. Edits update known webhook messages, shrinking content removes surplus chunks, and
native removals/retry resets retract known chunks. State is rechecked after attachment reads and rate
limit waits to avoid posting a superseded snapshot. A request already accepted by Discord can briefly
show stale content until the queued edit/delete arrives.

Ordering is **serialized mutation order**, not a reconstructed linear transcript: when an older message
grows after a later message has been posted, its new chunk appears below that later message. Stable
source/message/part headers identify the logical grouping. The sender does not delete and rebuild the
channel to move chunks. Mentions are disabled on creates and edits, and link embeds are suppressed.
The existing Discord ingress guard excludes bot/webhook posts from request admission, and recording
never consumes Discord events, preventing mirror self-ingestion.

HTTP requests have a 10-second deadline. Rate-limit replies honor `retry_after`/`Retry-After`, and
exhausted successful-response buckets honor `X-RateLimit-Reset-After`. There are at most three attempts;
waits beyond 30 seconds drop the update while retaining the destination cooldown. Confirmed 429s are
retryable; edits/deletes also retry HTTP 5xx responses. An uncertain create (network error, timeout or
5xx) is not blindly retried because Discord might already have created it. Redirects are rejected.
Response reads are capped at 64 KiB. Warnings contain fixed descriptions, not request URLs, response
bodies, resource references or captured exception messages.

## Limits and restart guarantees

This is best-effort recording, not an audit log or exactly-once delivery service. There is no durable
outbox, restart replay, recovery worker or persistent webhook-message map. A crash, shutdown, pruning,
overload or exhausted retry can lose changes; a crash after a create can leave an orphaned/duplicate
recording. Edits/deletes to messages from an earlier process are ignored. Failed retractions can leave
stale Discord content. Native retention/deletion is not a guarantee that Discord copies are erased.

Resources are deliberately bounded:

- The post-commit stage holds at most 128 commits and two million serialized UTF-16 code units.
  Oversized replay/reset changes reconcile only already tracked messages, without backfilling new ones.
- The sender holds at most 128 pending messages and tracks the most recent 512 message identities.
  Older identities lose edit/retraction support; overload drops updates without delaying native chat.
- Each tracked message keeps at most 128 allowlisted parts and 65,536 text code units. Longer content
  is truncated. Each message uploads at most ten files totaling 8 MiB; attachment reads have a deadline
  through opening, body consumption and terminal verification.

Stopping unsubscribes and aborts delivery, then waits for the current supervised operation to settle.
Native admission, projection and persistence never await the webhook. Delivery failures, queued
observer DB failures and listener exceptions are isolated from native chat.
