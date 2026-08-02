# Telegram Surface

The Telegram surface lets you drive the agent from a Telegram client, in direct
messages, groups, and forum topics. It sits alongside the Discord and GitHub
surfaces and shares the same event bus, request router, and agent runner.

It is **disabled by default**. Nothing about an existing deployment changes
until you turn it on.

---

## 1. Create a bot

1. Message [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Choose a display name and a username ending in `bot`.
3. BotFather replies with a token shaped like `8792842071:AAF...`. Treat it as a
   password: anyone holding it controls the bot.

### Group privacy mode — read this before using groups

By default Telegram bots run with **privacy mode enabled**, which means that in
groups the bot only receives:

- messages that `@mention` it,
- replies to its own messages,
- commands (`/foo`, `/foo@yourbot`).

That maps naturally onto the router's `mention` session mode, and it is the safer
default. If you want the agent to see *every* group message (needed for the
router's `active` mode), disable privacy mode:

```
/mybots -> <your bot> -> Bot Settings -> Group Privacy -> Turn off
```

You must then **remove and re-add the bot to the group** for the change to take
effect. Verify with:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getMe" | jq .result.can_read_all_group_messages
```

`true` means privacy mode is off.

---

## 2. Find your chat ids

The surface **fails closed**: while `allowedChatIds` is empty the bot ignores
every chat. So you need the numeric ids up front.

Send a message to the bot (or in the group), then:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" \
  | jq '.result[].message.chat | {id, type, title, username}'
```

- Private chats have positive ids.
- Groups and supergroups have negative ids, e.g. `-1001234567890`.

`getUpdates` only returns updates the bot has not already consumed, so run this
**before** starting the runtime (long polling would drain the queue).

---

## 3. Configure

The Telegram section lives in `core-config.yaml` and requires
**`configVersion: 2`** — the v1 input shape is frozen and cannot describe it.

```yaml
configVersion: 2

surface:
  telegram:
    enabled: true
    tokenEnv: "TELEGRAM_BOT_TOKEN"
    # apiRoot: "http://127.0.0.1:8081"   # self-hosted Bot API server
    botName: "lilac"
    # botUsername: "Catalina_agentbot"   # resolved from getMe when omitted

    allowedChatIds:
      - "1001"              # your DM
      - "-1001234567890"    # a group
    allowedUserIds: []      # empty = any user inside an allowed chat

    outputMode: preview
    parseMode: html
    streamEditIntervalMs: 1500
    outputNotification: true
    commandMenu: true

    markdownTableRender:
      enabled: true
      style: unicode
      maxWidth: 50
      fallbackMode: list
```

Then set the token in the environment:

```bash
TELEGRAM_BOT_TOKEN=8792842071:AAF...
```

`compose.yaml` already forwards `TELEGRAM_BOT_TOKEN` into the container.

### Option reference

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `false` | The adapter is only constructed when true. |
| `tokenEnv` | `TELEGRAM_BOT_TOKEN` | Env var holding the bot token. |
| `botName` | `lilac` | Identity used for mention detection and prompt attribution. No spaces. |
| `botUsername` | — | The `@handle` without the `@`. Resolved from `getMe` on connect when omitted. |
| `allowedChatIds` | `[]` | **Fails closed.** Empty means the bot ignores every chat. |
| `allowedUserIds` | `[]` | Empty means no user-level restriction; the chat allowlist still applies. |
| `dbPath` | `<dataDir>/telegram-surface.db` | Local message index (see §7). |
| `apiRoot` | `https://api.telegram.org` | Bot API endpoint. Set this to use a [self-hosted Bot API server](https://core.telegram.org/bots/api#using-a-local-bot-api-server). Must be a full URL. Read once at connect, so a change needs a restart. |
| `outputMode` | `preview` | Cancellation behaviour only. Telegram edits the streamed message in place, so a **successful** run is identical in both modes. `preview` deletes the streamed messages when a request is cancelled; `inline` leaves the partial answer visible. |
| `parseMode` | `html` | `html` renders markdown as Telegram HTML; `plain` sends unformatted text. |
| `streamEditIntervalMs` | `1500` | Minimum gap between streaming edits. Minimum accepted value is 500. |
| `outputNotification` | `true` | `false` sends with `disable_notification`. |
| `commandMenu` | `true` | Publishes the custom-command menu via `setMyCommands` on connect (see §7). `false` leaves whatever menu the bot already has untouched. |
| `workingIndicators` | shared default | Streaming progress phrases. |
| `markdownTableRender` | enabled | Renders markdown tables as fixed-width blocks. |

Routing behaviour (mention vs active mode, the ML gate, debounce) is configured
under `surface.router` and applies to Telegram exactly as it does to Discord.
Session ids are documented in §5.

---

## 4. Run it

```bash
docker compose up -d
docker compose logs -f lilac | grep -i telegram
```

You should see:

```
Surface adapter connected  platform=telegram
telegram surface ready     botUsername=...
```

Health is exposed as a `telegram.ready` check on `/readyz`:

```bash
curl -s localhost:8080/readyz | jq '.checks[] | select(.name == "telegram.ready")'
```

If the surface is enabled but no token is present, the runtime logs a warning
and continues without Telegram rather than failing startup.

---

## 5. Session ids

| Chat kind | Session id | Example |
|-----------|------------|---------|
| Private / group / supergroup / channel | `<chat_id>` | `1001`, `-1001234567890` |
| Forum topic | `<chat_id>:<topic_id>` | `-1001234567890:7` |

Each forum topic is a **separate session**, so `surface.router.sessionModes` can
be configured per topic:

```yaml
surface:
  router:
    sessionModes:
      "-1001234567890:7":
        mode: active
```

A topic is only recognised when Telegram marks the message with
`is_topic_message`. Ordinary supergroup replies also carry a
`message_thread_id`, and keying off that alone would shatter one group into a
session per reply chain.

Request ids are `telegram:<session_id>:<message_id>`. Because a forum session id
already contains a colon, the message id is always the final segment.

---

## 6. Workflows and authorization

Telegram-origin workflows support durable progress cards, scheduled triggers, and
`waitForReply`. These paths deliberately retain the originating Telegram identity;
they are not a way to address an arbitrary chat.

### Progress cards and scheduled delivery

When `workflow.run.trigger` or `workflow.trigger.create` is called from an
authenticated Telegram request, its durable progress target is the current
Telegram session. An explicit Telegram `progress.client`/`progress.sessionId`
pair, when supplied, must identify that same session. Cross-chat and
cross-platform Telegram targets are rejected. The chat part of a forum-topic
session must also be present in the current `allowedChatIds`.

Authorization is not frozen when a schedule is created. The runtime reloads the
current config and checks `allowedChatIds`:

1. before a due schedule is committed as a workflow run, and
2. immediately before every progress-card send, edit, and deleted-card
   recreation.

Removing a chat from `allowedChatIds` therefore stops an existing schedule from
creating new runs for that chat and stops existing runs from sending or editing
cards there. A denied due trigger is normally skipped before claim. If permission
is revoked during the claim-to-fire race, the scheduler releases the claim. In
both cases no run is created, the due occurrence remains due, and a warning is
logged once per runtime process. Restoring the chat to `allowedChatIds` allows a
later scheduler reconciliation to retry it. Cancel the trigger explicitly if it
should never run again.

This delivery check intentionally uses `allowedChatIds`. `allowedUserIds` gates
inbound principals; a progress-card delivery targets a chat rather than acting as
a user.

### Waiting for a Telegram reply

A workflow that declares `resources.waits: ["reply"]` may call:

```js
const reply = await waitForReply({
  prompt: "Waiting for confirmation",
  timeoutMs: 86400000,
});
```

`prompt` is only a label in the durable progress view; it does not send a
separate Telegram message. The wait defaults to the run's authenticated origin.
If `platform`, `channelId`, or `fromUserId` is supplied, each value must still
match the originating Telegram platform, session, and user. A workflow without
an authenticated Discord or Telegram origin cannot create a reply wait.

Supplying `messageId` makes the match stricter: the incoming Telegram message
must be a direct reply to that message. Without `messageId`, the next message
from the authenticated originating user in that session can resolve the wait.
The resolved value has this shape:

```js
{
  platform: "telegram",
  channelId: "-1001234567890:7",
  messageId: "456",
  userId: "123456789",
  userName: "optional username",
  text: "confirmed",
  ts: 1893456000000,
}
```

A matching reply is reserved for the workflow while the wait is pending. After
consumption, an exact platform/session/message suppression record remains for
five minutes to cover ordinary adapter redelivery. While the workflow store and
suppression hook are available, one reply resumes the workflow exactly once and
does not also launch an unrelated agent request. Unmatched messages continue
through normal routing. If the suppression hook itself fails, the router logs
`router suppression hook failed; proceeding` and deliberately fails open into
normal routing rather than dropping the user message.

For the full workflow definition and trigger schemas, load the built-in
`workflow-authoring` skill.

---

## 7. Design notes and platform constraints

These are the Telegram behaviours the implementation works around. They are
worth knowing when reading logs.

**No history API.** Unlike Discord, the Bot API cannot fetch past messages — a
bot only ever sees updates delivered to it. Reply context, `listMsg`, and unread
tracking are therefore served from a local SQLite index at `dbPath`, populated as
messages arrive. A freshly-provisioned bot has no history of a chat, even one it
has been in for a while.

**Edit rate limits.** Telegram throttles `editMessageText` at roughly one call
per second per chat and rejects an edit whose content is unchanged. Streaming
therefore throttles to `streamEditIntervalMs` and skips no-op edits. A `429` is
retried once honouring `retry_after`.

**4096-character messages.** Long answers are split. Splits never land inside an
HTML tag, and an open `<pre>`/`<code>` block is closed before the break and
reopened after, so every message is independently valid.

**HTML rather than MarkdownV2.** MarkdownV2 requires escaping 18 reserved
characters and a single mistake fails the whole send. Telegram HTML needs three,
supports the formatting the agent actually emits, and degrades to plain text if
entities are malformed. The renderer only emits tags it generated itself, so
user or model text cannot break out of a code block or unbalance the markup.

**Reactions are write-mostly.** `setMessageReaction` accepts only a fixed emoji
set for bots, and there is no API to read a message's current reactions —
reactions arrive as update events only. Unsupported emoji degrade to 👍 rather
than failing the call.

**Long polling, not webhooks.** The adapter opens an outbound connection, so it
needs no public HTTPS endpoint and works behind NAT. Webhook ingress is not
implemented.

**The bot never sees its own messages.** Telegram does not echo a bot's own
sends back as updates, so anything the bot says has to be written into the local
index at the moment it is sent, or it is absent from history forever. Outbound
attachments are indexed under a synthetic body — `[image] chart.png`,
`[file] report.pdf` — because an attachment-only message carries no text of its
own. Without a row, a reply to the attachment resolves to nothing and the reply
chain truncates there; a label rather than an empty string means an agent
reading its own history can tell what it sent instead of seeing a message it
apparently left blank.

**Attachment batches fail forward, not atomically.** Each attachment is a
separate upload, and one that has returned is already visible in the chat and
cannot be recalled. When upload *n* fails, the run stops there: the uploads
before it keep their refs and are indexed as normal, and the ones behind it are
never attempted. Continuing past the failure would leave a gap in the sequence
(1 and 3 delivered, 2 missing) that is harder to read than a truncated prefix,
and the usual causes — rate limits, auth — would only recur on the next call.
The warning log carries `uploaded` and `total` counts so a partial batch is
distinguishable from a total one.

### Custom commands and the menu alias

Telegram's command grammar is `[a-z0-9_]{1,32}`, which the canonical
`lilac:<name>` form cannot satisfy — both `:` and `-` are illegal. Each custom
command is therefore also given a **menu alias**, `lilac_<name>` with hyphens
mapped to underscores, and that is what `setMyCommands` advertises:

| Command in `<dataDir>/cmds` | Menu entry | Typed form |
|---|---|---|
| `tarot` | `/lilac_tarot` | `/lilac:tarot` |
| `daily-standup` | `/lilac_daily_standup` | `/lilac:daily-standup` |

Both spellings resolve to the same definition and take the same arguments, so
`/lilac_daily_standup team=core keep it short` behaves exactly like the typed
equivalent. The `@botusername` suffix Telegram appends in groups is accepted.

Aliases are never truncated. A name longer than 26 characters cannot fit under
the prefix, so it is left out of the menu and logged as a warning — it stays
invocable by its typed form. Clipping would be worse than omitting: two long
names would collide on one alias. Command names cannot contain `_`, which is
what makes the hyphen mapping reversible and collision-free; if two candidates
ever did contend for one alias, the first in code-point order wins and the
other keeps its typed form.

The menu is rewritten on every connect, including to an empty list when no
commands are registered, so a removed command stops being advertised. Telegram
caps a menu at 100 entries; beyond that the list is trimmed and the omitted
commands are logged.

---

## 8. Verifying a change

Automated coverage does not touch `api.telegram.org`. A Telegram bot cannot send
messages to itself, so a fully automated real end-to-end test is impossible
without driving a user account over MTProto. Instead the suite runs the real
adapter against a **fake Bot API server** (`apps/core/tests/surface/telegram/fake-bot-api-server.ts`):

```bash
cd apps/core && bun test tests/surface/telegram/
```

To run the same suite in an isolated container — read-only repo mount,
`--network none`, scratch state in tmpfs, nothing written to the host:

```bash
docker/verify-telegram.sh
```

`--network none` is deliberate: it proves the suite has no hidden dependency on
the real Bot API.

For a real smoke test:

1. Configure your DM chat id and start the runtime.
2. Send the bot a message and confirm it replies with streamed edits.
3. Send a long prompt and confirm the answer splits across messages cleanly.
4. Press **Cancel** on a running request and confirm it stops.

### Development builds stay local; deployment goes through `main`

Images are only pulled from GHCR, and GHCR is only built from `main`
(`.github/workflows/build-image.yml` triggers on pushes to `main`). So the
deployment path is always **merge to `main`, then pull** — never a hand-built
image pushed to the registry, and never `workflow_dispatch` on a feature
branch, which would overwrite the `:catalina` and `:latest` tags the running
stack uses.

Before merging, build and exercise the branch locally in a throwaway container
instead:

```bash
docker build -t lilac-mono:telegram-verify .
docker/telegram-verify-stack.sh start      # separate Redis db, own volume, no published ports
docker/telegram-verify-stack.sh logs
```

Stop it before deploying for real — two pollers on one bot token produce
`409 Conflict`.

### Cleaning up afterwards

`telegram-verify-stack.sh stop` removes the container and its volume but leaves
the locally built image and any host-side helper processes. To clear everything
a verification session leaves behind:

```bash
docker/telegram-dev-cleanup.sh --dry-run   # show what would go
docker/telegram-dev-cleanup.sh             # container, volume, inject proxy, scratch dirs
docker/telegram-dev-cleanup.sh --all       # the above plus the ~2.8GB local image
```

The container, volume and image are matched by exact name — never by a wildcard
or a `docker prune` — and the running stack's container names (`lilac-mono-catalina`,
`lilac-mono-claudia`) are refused outright, so the script cannot take the
deployment down with the scratch environment.

Two targets cannot be matched by exact name and are not. The inject proxy is
found by its script path, and `/tmp` scratch directories are found by the five
`lilac-telegram-{it,menu,e2e,poll,outbox}-` prefixes the test suites `mkdtemp` under —
their random suffixes are never recorded, so there is nothing exact to match on.
If a second verification session or test run is in flight on the same host, this
script will clean up its proxy and scratch directories too. Run `--dry-run`
first when that is possible. The script reports each item as removed or failed
and exits non-zero if any removal failed, so a proxy that survives a failed
`kill` — still holding the bot token in its environment — is not reported as
cleaned up.

---

## 9. Troubleshooting

| Symptom | Cause |
|---------|-------|
| Bot never responds in a DM | The chat id is not in `allowedChatIds`. The allowlist fails closed. |
| Bot responds in DMs but not in a group | Privacy mode is on and the message did not mention or reply to the bot. See §1. |
| Bot responds to mentions but never to plain group messages | Same as above; `active` mode needs privacy mode disabled. |
| `telegram surface enabled but no token available` | `enabled: true` but the env var named by `tokenEnv` is unset. |
| Answers arrive all at once, not streamed | `streamEditIntervalMs` is high, or the answer was short enough to be a single send. |
| Formatting looks broken | Try `parseMode: plain` to isolate whether the HTML renderer is at fault, and report the input. |
| `409 Conflict` in logs | Two processes are polling the same bot token. Only one runtime may poll a given bot. |
| A due workflow schedule logs `progress target is no longer authorized` and creates no run | Its chat was removed from `allowedChatIds`. Restore the chat to retry the still-due occurrence, or cancel the trigger. |
| A reply resumes a workflow but does not start a normal agent response | Expected. A message matching a pending or consumed `waitForReply` is reserved for that workflow and suppressed from ordinary routing. |

---

## 10. What works, and what does not

The conversational path is complete: messages in, routing, streamed replies,
chunking, HTML rendering, reply-chain context, cancellation, custom commands and
their menu, outbound attachments, reactions, typing indicators, and history
served from the local index. Everything below is a gap in something *else* that
Discord has, stated precisely so nobody has to infer it from silence.

### Not implemented

- **Inbound attachments.** A photo or document *sent to* the bot reaches the
  agent as its caption text only; the media itself is dropped, and an
  uncaptioned photo does not start a run at all. Outbound attachments work.
  Tracked in [#42](https://github.com/DF-wu/lilac-mono/issues/42), which carries
  the agreed design.
- **Webhook ingress.** Long polling only.
- **A Telegram-side conversation search index.** Discord has a dedicated search
  store; Telegram relies on the shared transcript store.
- **Inline queries and business accounts.**
- **Voice/video note transcription.**

### Implemented, but behaves differently from Discord

These are platform consequences rather than omissions. They are listed because
code that assumes Discord semantics will be surprised.

- **Workflow progress cards use inline keyboards.** Pause, resume and cancel
  actions are projected to Telegram and consumed through the same durable
  workflow action store as Discord/GitHub. Callback data over Telegram's
  64-byte limit is omitted rather than truncated.
- **Level-2 surface tools are same-surface only.** A Telegram-origin request can
  list/read/send/edit/delete messages and add/remove reactions only in chats
  admitted by `allowedChatIds`. A Telegram principal cannot select Discord as
  the target client. Local file attachments, participant enumeration, message
  search, and reaction queries remain unsupported by these tools.

- **`listReactions()` always returns `[]`.** The Bot API delivers reactions only
  as update events; there is no endpoint to query a message's current
  reactions.
- **`removeReaction()` clears every reaction, not the named one.**
  `setMessageReaction` replaces the bot's whole reaction set, and a bot may hold
  only one reaction, so removal is all-or-nothing.
- **`sendMsg()` projects `content.actions`, but ignores `content.attachments`.**
  Actions become inline-keyboard buttons. The streaming output path delivers
  attachments normally; only the direct send path drops attachments.
- **History comes from a local SQLite index, not the platform.** A freshly
  provisioned bot has no history of a chat it has just joined, however long that
  chat has existed. A successful `readMsg()` therefore means the message is in
  the local cache, not that it still exists remotely. Direct edit/delete calls
  tombstone cache entries when Telegram confirms they are gone; workflow startup
  reconciliation probes unchanged cards with an edit and recreates a card
  immediately when that probe proves it was deleted. See §7.
