---
name: heartbeat
description: Set up or verify proactive heartbeat checks, watch an event, keep the user posted in a thread, or maintain ongoing follow-ups. Use during heartbeat wakes and when a conversation identifies something worth checking later.
---

# Heartbeat

Use the existing heartbeat lane and editable Markdown files. Core supplies periodic idle wakes; the
files define the work. A watch's next-check time is evaluated on the next available wake, not an
exact-time delivery guarantee.

## Choose a route

- When enabling heartbeat, verifying delivery, or changing its default destination, read
  [references/setup.md](references/setup.md).
- When an installation still uses heartbeat-owned `HEARTBEAT.md`, inbox handoffs, or archives, read
  [references/migration.md](references/migration.md) before changing that setup. Preserve its work.
- When creating or changing a watch, follow the watch instructions below.
- On a heartbeat wake, read the active `HEARTBEAT.md` and follow its workflow. Its linked working notes
  are the continuity between wakes. Do not reload setup or migration instructions on every wake.

## Create or change a watch

1. Read the active workflow and `heartbeat/WORK.md` under the prompt directory. The system prompt
   identifies that directory; in the stock container it is `/data/prompts`. Verify lane setup if it
   has not been established. Configuration alone does not prove a wake or delivery succeeded.
2. Read the relevant conversation and merge with an existing watch for the same responsibility.
   Record the source message, whether the user requested the watch or the agent discovered it, why it
   matters, current evidence, next check and its rationale, notification criteria, and when to stop.
   Use the example in the working notes as a convention, not a machine schema.
3. Capture delivery separately from the evidence source. “Keep me posted here” means the current
   concrete thread, even if a different channel is the default. Resolve aliases with surface tools
   and save the returned surface/client and concrete session/channel ID. Use free-form delivery
   instructions for timing, tone, or batching. Without an explicit override, use the configured
   default. An unavailable explicit destination remains a delivery problem to resolve with the user;
   retain the finding there in the notes instead of silently redirecting it.
4. Re-read before editing, preserve unrelated watches, and make a targeted file edit. Ordinary
   conversations may edit both workflow and working notes. Report what is being watched, where
   updates will go, and the next intended check, including any setup still unverified.

When research reveals a useful later check, offer to track it if the user has not requested a watch.
During heartbeat, the standing discovery instructions may authorize starting a watch without another
question. Inferred watches are best effort; explicit watches are recorded commitments subject to the
lane's availability. Access to a source does not make every topic in it a user responsibility.

## File ownership

The built-in [workflow](assets/HEARTBEAT.md) and [working notes](assets/WORK.md) are starter assets.
Active copies belong to the user and can be customized through conversation. Keep operational lessons
with their watch; promote a lesson into standing instructions only when feedback or repeated evidence
supports it. Silence from the user alone is not evidence of a preference.
