# Telegram Bot Surface Support

Status: **implementation complete and smoke-tested against real Telegram (2026-07-29)** — open follow-ups tracked under epic [#31](https://github.com/DF-wu/lilac-mono/issues/31) ([#42](https://github.com/DF-wu/lilac-mono/issues/42) inbound attachments, [#43](https://github.com/DF-wu/lilac-mono/issues/43) workflow progress cards/actions, [#44](https://github.com/DF-wu/lilac-mono/issues/44) Level-2 surface tools); not yet merged to `main`
Branch: `feat/telegram-bot-support`
Tracking: GitHub issues on `DF-wu/lilac-mono` (see [Issue Map](#issue-map))

This document is the single source of truth for the Telegram surface work: design
decisions, phase breakdown, progress log, and verification records.

---

## 1. Goal

Add Telegram as a first-class **surface** alongside Discord and GitHub, so the
agent runner can be driven from a Telegram client (DM and groups) with feature
parity close to the Discord surface.

Bot used for development: `@Catalina_agentbot` (id `8792842071`).

---

## 2. Decisions (agreed with repo owner)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Router strategy | **Surgically generalize the shared `bus-request-router`** | Full feature parity (mention/active modes, ML gate, debounce, reply-chain composition, attachments) instead of re-implementing them. Accepts a moderate upstream-merge cost. |
| D2 | Feature scope (v1) | Core conversation **+** cancel/control buttons **+** two-way attachments **+** advanced (forum topics, reactions, command menu) | Full parity target. |
| D3 | Verification | **Fake Bot API server in a container** for automated integration tests, plus one manual real-Telegram smoke test by the owner | Telegram bots cannot message themselves, so a fully-automated real E2E is impossible without a user account (MTProto). Fake server covers protocol behaviour; manual smoke covers reality. |
| D4 | Positioning | Self-use first, but **maintain PR-able quality** | Follow `AGENTS.md` conventions, keep shared-file diffs minimal and separable, ship docs + tests. |

### 2.1 Derived design decisions (no owner input needed)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D5 | Telegram library | `grammy` (stable 1.x) | TypeScript-first, actively maintained, runs on Bun, complete Bot API typings. Avoids hand-rolling the Bot API client. |
| D6 | Ingress mode | **Long polling** (`getUpdates`) by default; webhook mode deferred | Self-hosted container behind NAT; no public HTTPS endpoint required. Matches how the Discord gateway adapter behaves (outbound connection only). |
| D7 | Config version | `surface.telegram` added to **v2 schema only**, with defaults synthesised in the v1→universal parser | `AGENTS.md`: `coreConfigInputSchemaV1` is frozen. |
| D8 | Output format | Convert agent Markdown → **Telegram HTML** parse mode | HTML escaping is far more tractable than MarkdownV2's 18 reserved characters; malformed entities are recoverable by falling back to plain text. |
| D9 | Session id shape | `chatId` for normal chats, `chatId:threadId` for forum topics | Mirrors Discord's channel/thread split so router session modes keep working per-topic. |
| D10 | Request id shape | `telegram:<sessionId>:<messageId>` | Mirrors `discord:<channelId>:<messageId>`; keeps `parseRequestId` reply-target resolution uniform. |

---

## 3. Architecture study (what already exists)

The runtime is event-bus centric and *already* multi-surface:

```
Telegram/Discord client
        │  (adapter events)
        ▼
 SurfaceAdapter.subscribe ──► bridgeAdapterToBus ──► evt.adapter.message.created
                                                              │
                                                              ▼
                                                    bus-request-router
                                                     (gate / mode / compose)
                                                              │
                                                              ▼
                                                     cmd.request.message
                                                              │
                                                              ▼
                                                     bus-agent-runner (LLM)
                                                              │
                                                              ▼
                                                     out.req.<request_id>
                                                              │
                                                              ▼
                                        bridgeBusToAdapter ──► SurfaceOutputStream
```

Key existing facts that make this tractable:

- `AdapterPlatform` in `packages/event-bus/lilac-spec.ts` **already includes `"telegram"`**.
- `apps/core/src/shared/is-adapter-platform.ts` already accepts `"telegram"`.
- `SurfaceAdapter` / `SurfaceOutputStream` (`apps/core/src/surface/adapter.ts`) are
  platform-agnostic contracts.
- `bridgeBusToAdapter` already takes a `platform` parameter and the runtime already
  runs **two** relay instances (Discord + GitHub).

Key blockers that require the generalization work:

| Blocker | Location |
|---------|----------|
| `SessionRef` / `MsgRef` are a `discord \| github` union | `apps/core/src/surface/types.ts` |
| Relay platform annotated `"discord" \| "github"` (13 sites) | `apps/core/src/surface/bridge/subscribe-from-bus.ts` |
| Router drops non-Discord events outright | `bus-request-router.ts` (`platform !== "discord"`) |
| `toBusEvtAdapter*` mappers hardcode `platform: "discord"` | `apps/core/src/surface/discord/discord-adapter.ts` |
| Bot mention/name resolution reads `cfg.surface.discord.botName` | router + request-composition |

GitHub sidesteps all of this by publishing `cmd.request.message` directly from its
webhook handler. We deliberately do **not** copy that shortcut (per D1).

---

## 4. Telegram platform constraints to design around

| Constraint | Impact |
|------------|--------|
| Message text limit **4096 chars** | Output stream must chunk (Discord uses 2000). |
| Edit rate limits (~1 msg/s per chat; bursts throttled) | Streaming must throttle `editMessageText`, not edit per token. |
| `editMessageText` fails with `message is not modified` | Must dedupe identical edits. |
| Privacy mode ON by default (`can_read_all_group_messages: false`) | In groups the bot only receives mentions/replies/commands unless privacy is disabled in BotFather. Documented; `mention` mode is the natural default for groups. |
| MarkdownV2 escaping is hostile | Use HTML parse mode (D8) with a Markdown→HTML converter + plain-text fallback. |
| Forum topics carry `message_thread_id` | Session id must include it (D9). |
| Attachments are file_id based, download via `getFile` | Adapter must resolve `file_id` → bytes for inbound media. |

---

## 5. Phase breakdown

| Phase | Scope | Issue | Status |
|-------|-------|-------|--------|
| 0 | Branch, plan doc, tracking issues | [#31](https://github.com/DF-wu/lilac-mono/issues/31) | done |
| 1 | Generalize surface types + relay to 3 platforms | [#32](https://github.com/DF-wu/lilac-mono/issues/32) | done |
| 2 | `core-config` `surface.telegram` schema (v2 + v1 fallback) | [#33](https://github.com/DF-wu/lilac-mono/issues/33) | done |
| 3 | `TelegramAdapter` (grammY, long polling) | [#34](https://github.com/DF-wu/lilac-mono/issues/34) | done |
| 4 | `TelegramOutputStream` (throttled streaming, chunking, HTML) | [#35](https://github.com/DF-wu/lilac-mono/issues/35) | done |
| 5 | Platform-aware request router | [#36](https://github.com/DF-wu/lilac-mono/issues/36) | done |
| 6 | Attachments, cancel buttons, reactions, command menu | [#37](https://github.com/DF-wu/lilac-mono/issues/37) | done — registry-backed `lilac_<name>` menu aliases; inbound attachments deferred to [#42](https://github.com/DF-wu/lilac-mono/issues/42) |
| 7 | Runtime wiring in `create-core-runtime.ts` | [#38](https://github.com/DF-wu/lilac-mono/issues/38) | done |
| 8 | Tests: unit + fake Bot API integration in container | [#39](https://github.com/DF-wu/lilac-mono/issues/39) | done |
| 9 | Docs, container harness, final lint/fmt/typecheck/test | [#40](https://github.com/DF-wu/lilac-mono/issues/40) | done — real outbound smoke and two-part inbound verification completed 2026-07-29 (see [Verification record](#verification-record)) |

---

## 6. Issue map

| Issue | Title |
|-------|-------|
| [#31](https://github.com/DF-wu/lilac-mono/issues/31) | Epic: Telegram bot surface support |
| [#32](https://github.com/DF-wu/lilac-mono/issues/32) | P1: generalize surface types and output relay to three platforms |
| [#33](https://github.com/DF-wu/lilac-mono/issues/33) | P2: core-config `surface.telegram` schema (v2 + v1 fallback) |
| [#34](https://github.com/DF-wu/lilac-mono/issues/34) | P3: `TelegramAdapter` implementing `SurfaceAdapter` (grammY, long polling) |
| [#35](https://github.com/DF-wu/lilac-mono/issues/35) | P4: `TelegramOutputStream` with throttled streaming and HTML rendering |
| [#36](https://github.com/DF-wu/lilac-mono/issues/36) | P5: make `bus-request-router` platform-aware |
| [#37](https://github.com/DF-wu/lilac-mono/issues/37) | P6: attachments, cancel buttons, reactions, and command menu |
| [#38](https://github.com/DF-wu/lilac-mono/issues/38) | P7: wire the Telegram surface into `create-core-runtime` |
| [#39](https://github.com/DF-wu/lilac-mono/issues/39) | P8: tests — unit suite plus fake Bot API integration harness |
| [#40](https://github.com/DF-wu/lilac-mono/issues/40) | P9: documentation, container harness, and final validation |

---

## 6.1 Measured change surface (audit result)

A line-by-line audit of the platform coupling produced the following totals. Most
entries are mechanical (`platform: "discord"` → `platform: opts.platform`), but the
hard guards must be handled deliberately.

| Category | Approx. count | Notes |
|----------|---------------|-------|
| Hardcoded literals `platform: "discord"` | ~85 | Mechanical parametrization |
| Conditional branches `platform === "discord"` | ~40 | Needs per-platform feature decisions |
| Conditional guards `platform !== "discord"` | ~25 | Several **throw** on non-Discord |
| Type unions `"discord" \| "github"` | ~20 | Blocks compilation until widened |
| Platform-specific helpers (`parseDiscordMsgRef*`, `toBusEvtAdapter*`) | ~15 | Need dispatch or generalization |
| Request-id scheme | ~8 | Extensible by design |

**Hard guards that currently throw for non-Discord platforms** (must be cleared in Phase 5):

- `request-composition.ts:683` — `composeRequestMessages()`
- `request-composition.ts:855` — `composeRecentChannelMessages()`
- `request-composition.ts:1283` — `composeSingleMessage()`
- `bus-request-router/common.ts:244` — `parseDiscordMsgRefFromAdapterEvent()`

**Files outside the originally-scoped bridge layer that also carry the union** (folded into Phase 1/5):

- `apps/core/src/transcript/transcript-store.ts` (3 sites)
- `apps/core/src/workflow/workflow-progress-projector.ts` (6 sites)
- `apps/core/src/tool-server/request-message-cache.ts` (4 sites)
- `apps/core/src/tool-server/tools/surface.ts`
- `packages/plugin-runtime/types.ts`
- `apps/core/src/runtime/create-core-runtime.ts` (relay restore filter, workflow adapter map)

**Discord-only features to assess for Telegram parity** (relay `subscribe-from-bus.ts`):
reasoning status timers (lines 741, 931, 965, 1122, 1246) and output-message cleanup
(line 796) are currently gated to Discord. Telegram will opt in where the surface can
render the equivalent UI.

---

## 7. Progress log

### 2026-07-27

- Created branch `feat/telegram-bot-support` off `main`.
- Completed architecture study of the surface/bridge layer (Discord + GitHub adapters,
  bus bridges, router, relay, config parsers).
- Validated the development bot token via `getMe`: `@Catalina_agentbot`, privacy mode ON.
- Recorded decisions D1–D10 above.
- Wrote this plan.
- **Phase 1** (`de33ed8`): added Telegram session/message refs, widened the shared
  `SessionRef`/`MsgRef` unions, and generalized the output relay. Replaced the
  scattered `platform === "discord"` gates with two named capability predicates
  (`supportsStreamingProgressUi`, `supportsCreatedOutputCleanup`) and made
  `replyTo` resolution an exhaustive switch so a missing platform branch is a
  compile error. Telegram request ids parse from the last colon, since forum
  session ids embed one.
- **Phase 2** (`f7d71df`): added `surface.telegram` to `UniversalCoreConfig` and
  the v2 schema, with a synthesised disabled fallback for frozen v1 configs.
  A new test caught a real defect while writing it: Zod evaluates a literal
  `.default()` once at module load and hands it out by reference, so every
  parsed config shared the same nested arrays. Switched the v2 surface default
  to a lazy factory.
- **Phase 3** (`a610260`): `TelegramAdapter` over grammY long polling. Added a
  local SQLite index because the Bot API has no history endpoint — for Telegram
  this is not a cache but the only source of past messages.
- **Phase 4** (`2a88faf`): throttled output stream with edit dedupe, 4096-char
  tag-aware chunking, a markdown→HTML renderer that only emits tags it generated
  itself, 429 `retry_after` handling, and a plain-text fallback on entity errors.
- **Phase 5** (`62f4cf8`): made the request router platform-aware. Key
  simplification: one router instance runs per adapter, so the platform is a
  closure-level constant rather than something derived per message.
  `getDiscordFlags` became `getSurfaceFlags(raw, platform)`, reading the
  `raw.<platform>` envelope both adapters publish in the same shape.
- **Phase 7** (`be56ab1`): runtime wiring, gated on `enabled` + token presence,
  plus a `telegram.ready` health check and graceful-restart participation.
- **Phase 6 / docs** (`11cacec`): outbound attachment delivery, cancel button
  routed to `adapter.request.cancel` (it was reaching the workflow action
  resolver instead), and `docs/telegram-surface.md`.

#### Deviations from the original plan

- **Inbound attachments deferred** to [#42](https://github.com/DF-wu/lilac-mono/issues/42).
  Discord attachments ride on stable CDN URLs and `request-composition/attachments.ts`
  is built around that. Telegram needs `getFile` + an authenticated, expiring
  download, which calls for a platform-neutral resolution seam rather than a
  second URL scheme bolted onto the Discord path. Captions still reach the agent.
- **Two pre-existing failures on `main`** were found while establishing a baseline
  and filed as [#41](https://github.com/DF-wu/lilac-mono/issues/41): a typecheck
  error in `packages/mini-lilac-runtime` and a wall-clock-dependent heartbeat
  test. Neither is caused by this branch.

---

## 8. Verification record

### Automated

| Check | Command | Result |
|-------|---------|--------|
| Telegram suite | `bun test tests/surface/telegram/` (in `apps/core`) | **234 pass, 0 fail** across 11 files |
| Telegram suite, isolated container | `docker/verify-telegram.sh` | **pass** — read-only repo mount, `--network none`, tmpfs scratch |
| Config suite | `bun test` (in `packages/utils`) | **283 pass, 0 fail** |
| Full core suite | `bun test` (in `apps/core`) | **1535 pass, 1 fail** — the one failure is the pre-existing wall-clock-dependent heartbeat test ([#41](https://github.com/DF-wu/lilac-mono/issues/41)) |
| Workspace typecheck | `tsc --noEmit` per package | **clean**, except the pre-existing `packages/mini-lilac-runtime` error ([#41](https://github.com/DF-wu/lilac-mono/issues/41)) |
| Lint | `bun run lint` | **clean** |
| Format | `bun run fmt:check` | **clean** for all source; flags only `.omo/run-continuation/*.json`, an untracked scratch file written live by the local agent harness |

Test count moved from **1302 → 1536** in `apps/core`, and no Discord or GitHub test
required modification — the router generalization is behaviour-preserving.

### Integration coverage

A Telegram bot cannot message itself, so an automated end-to-end test against
the real API is impossible without driving a user account over MTProto. The real
`TelegramAdapter` is instead pointed at a local fake Bot API server
(`apps/core/tests/surface/telegram/fake-bot-api-server.ts`), which serves long
polls, records every call, and can be programmed to fail. 15 scenarios cover:

connect/identity · `allowed_updates` includes `message_reaction` · command menu
registration and opt-out · chat allowlisting · self-message loop guard · forum
topic session ids · streamed reply · chunk overflow · cancel button reaching
`adapter.request.cancel` · reaction mapping both directions · history served from
the local index · message CRUD · idempotent disconnect.

### Adversarial check of the HTML renderer

The renderer is the one security-sensitive component (it turns model output into
markup sent to a third party), so its claims were probed directly rather than
taken on trust:

| Input | Output | Verdict |
|-------|--------|---------|
| `<img src=x onerror=alert(1)>` | `&lt;img src=x onerror=alert(1)&gt;` | fully escaped |
| `[x](https://a.com" onmouseover="alert(1))` | `<a href="https://a.com&quot; onmouseover=&quot;alert(1)">x</a>` | quote escaped; stays one attribute |
| `[click](javascript:alert(1))` | `click` | link dropped, label kept |
| ` ```ts\n</code></pre>...\n``` ` | escaped inside the fence | no code-block breakout |
| unterminated fence | closed anyway | never unbalanced |

### Live verification against api.telegram.org

The fake Bot API can only confirm that the code does what *we believe* Telegram
wants. `scripts/telegram-live-smoke.ts` drives the real `TelegramOutputStream`
against the real API to confirm what Telegram actually accepts. Run:

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... bun scripts/telegram-live-smoke.ts
```

Result (2026-07-29, `c74ff2d`): **6/6 pass, 25 API calls, 0 failures**, and all
12 messages it created were deleted before exit.

| Check | Result |
|-------|--------|
| Markdown→HTML accepted (headings, bold/italic/strike, inline code, links with `&`, fenced code containing `<`/`&`/backticks, lists, blockquote) | pass — no entity rejection |
| 4096-char overflow splits into messages Telegram accepts | pass — 4 messages |
| Code block split across messages stays valid on both sides | pass — 4 messages, both accepted |
| Streaming edits at the shipped 1500ms interval avoid `429` | pass — 0 rejected |
| Cancel inline keyboard shape accepted | pass |
| Shrinking output actually removes surplus messages remotely | pass — 3 → 1 |

This closes the risk that the fake server was lying about entity validation,
the character limit, or rate limiting — the three places a fake is most likely
to be wrong.

### Parallel verification stack

`docker/telegram-verify-stack.sh` runs a Telegram-only runtime beside a live
deployment: separate Redis logical db, separate volume, no published ports, and
Discord allowlists emptied so the parallel instance stays inert on Discord.
Confirmed healthy against the operator's deployment:

```
telegram.ready : true   botUsername: Catalina_agentbot
discord.ready  : true   (allowlists empty — ignores all Discord traffic)
overall ready  : true
bus            : redis://…/15  (live bus is /5)
```

### Inbound verification

A Telegram bot cannot message itself or another bot, so the inbound half has no
fully automated path: driving it needs a human or a user account over MTProto.
It was verified in two parts.

**Part 1 — delivery, observed directly.** The operator sent two real messages.
Both were delivered by ordinary long polling and reached the router. This is the
only part that genuinely requires a person, and it is done.

That run also exposed the defect described below: both messages were *skipped*,
because the shared `toBusEvtAdapter*` mappers labelled every Telegram event as
Discord. See "Defect found by the live run".

**Part 2 — the rest of the chain, after the fix.** `scripts/telegram-inject-proxy.ts`
forwards every call to the real `api.telegram.org` and augments only
`getUpdates`, injecting one synthetic user message. Everything downstream is
real: real adapter, real bridge, real router, real agent runner, real model, and
the reply is rendered and delivered by the real API into the real chat.

Result (2026-07-29, verification container on `lilac-mono:telegram-verify`):

| Stage | Evidence |
|-------|----------|
| Update reaches the router as a DM | `isDm: true`, `textPreview: '用一句話說明你現在跑在哪個 surface 上。'` |
| Routed as a Telegram request | `requestId: 'telegram:547663716:34085'` |
| Discord relay correctly declines it | `reason: 'platform_mismatch'` |
| Agent runs | `agent run starting`, `evt.agent.output.delta.text` |
| Typing indicator | `sendChatAction -> ok` |
| Reply sent to the real API | `sendMessage -> ok` |
| Streaming edit applied | `editMessageText -> ok` |
| Relay completes | `reply relay finished { finalTextChars: 25 }` |

What this does **not** cover: that Telegram delivers user messages to the bot,
which Part 1 established independently.

### Defect found by the live run

The operator's real message was the only thing that caught this, and it is worth
recording because of what it says about the test strategy.

```
[bus-request-router] adapter.message.created
  sessionId: "547663716"  messageId: "33"
  mode: "mention"   isDm: false   mentionsBot: false
[bus-request-router] router.route.decision
  decision: "skip"  reason: "mention_mode_non_trigger"
```

`isDm: false` for a private chat was the tell. The `toBusEvtAdapter*` mappers —
shared by every adapter, since `bridgeAdapterToBus` calls them for whichever
adapter it is bridging — hardcoded `platform: "discord"`. So a Telegram event
was published as a Discord one, handed to the Discord router, which read
`raw.discord`, found no flags, and skipped it.

Every suite passed while this was broken:

- the adapter integration suite stops at the emitted `AdapterEvent`, one layer above
- the router suite starts by publishing bus events **directly** with `platform: "telegram"`, one layer below
- the live output-path smoke exercises only egress

The mapper between them was covered by nothing. Fixed in `40b3a97`; the gap is
closed by `telegram-end-to-end.test.ts`, which wires adapter → bridge → router
together and was confirmed to fail (5/5 red) without the fix.

One real message was worth more than 241 green tests here.

---

## 9. Non-goals / deferred

- Webhook ingress mode (only long polling in v1).
- Telegram inline queries / business accounts.
- Voice / video note transcription.
- Telegram-side conversation search index (the Discord surface has a dedicated
  SQLite search store; Telegram v1 relies on the shared transcript store only).
