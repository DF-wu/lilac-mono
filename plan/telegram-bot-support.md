# Telegram Bot Surface Support

Status: **in progress**
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
| 1 | Generalize surface types + relay to 3 platforms | [#32](https://github.com/DF-wu/lilac-mono/issues/32) | pending |
| 2 | `core-config` `surface.telegram` schema (v2 + v1 fallback) | [#33](https://github.com/DF-wu/lilac-mono/issues/33) | pending |
| 3 | `TelegramAdapter` (grammY, long polling) | [#34](https://github.com/DF-wu/lilac-mono/issues/34) | pending |
| 4 | `TelegramOutputStream` (throttled streaming, chunking, HTML) | [#35](https://github.com/DF-wu/lilac-mono/issues/35) | pending |
| 5 | Platform-aware request router | [#36](https://github.com/DF-wu/lilac-mono/issues/36) | pending |
| 6 | Attachments, cancel buttons, reactions, command menu | [#37](https://github.com/DF-wu/lilac-mono/issues/37) | pending |
| 7 | Runtime wiring in `create-core-runtime.ts` | [#38](https://github.com/DF-wu/lilac-mono/issues/38) | pending |
| 8 | Tests: unit + fake Bot API integration in container | [#39](https://github.com/DF-wu/lilac-mono/issues/39) | pending |
| 9 | Docs, container harness, final lint/fmt/typecheck/test | [#40](https://github.com/DF-wu/lilac-mono/issues/40) | pending |

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

---

## 8. Verification record

_(populated during Phase 8/9)_

| Check | Command | Result |
|-------|---------|--------|
| | | |

---

## 9. Non-goals / deferred

- Webhook ingress mode (only long polling in v1).
- Telegram inline queries / business accounts.
- Voice / video note transcription.
- Telegram-side conversation search index (the Discord surface has a dedicated
  SQLite search store; Telegram v1 relies on the shared transcript store only).
