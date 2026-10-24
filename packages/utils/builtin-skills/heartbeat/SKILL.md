---
name: heartbeat
description: Set up or verify heartbeat, watch an event, and run proactive follow-ups. Use on heartbeat wakes, when a conversation identifies a later check, or when the user replies to a proactive update, resolves or corrects an ongoing matter, changes a commitment, or refers to ongoing work missing from context.
---

# Heartbeat

Use the existing heartbeat lane and editable Markdown files. Core supplies periodic idle wakes; the
files define the work. A watch's next-check time is evaluated on the next available wake, not an
exact-time delivery guarantee.

## Choose a route

- When enabling heartbeat, verifying delivery, or changing its default destination, read
  [references/setup.md](references/setup.md).
- When an installation still uses heartbeat-owned `HEARTBEAT.md`, inbox handoffs, or a
  monolithic `WORK.md` with full watch histories, read
  [references/migration.md](references/migration.md) before changing that setup. Preserve its work.
- When creating or changing a watch, follow the watch instructions below.
- When a conversation answers a proactive question or changes an ongoing matter, follow
  "Reconcile a conversation" below, including when the watch is missing from current context.
- On a heartbeat wake, read the active `HEARTBEAT.md` and follow its workflow. Read the index and only
  the topic files needed for due checks or the current matter. Do not reload setup or migration
  instructions on every wake.

## Create or change a watch

1. Read the active workflow and `heartbeat/WORK.md` under the prompt directory. The system prompt
   identifies that directory; in the stock container it is `/data/prompts`. Verify lane setup if it
   has not been established. Configuration alone does not prove a wake or delivery succeeded.
2. Read the relevant conversation and matching topic file. Search matching archived outcomes before
   creating or reopening a watch. Merge with an existing watch for the same responsibility.
   Record the source message, whether the user requested the watch or the agent discovered it, why it
   matters, current evidence, next check and its rationale, notification criteria, and when to stop.
   Keep these details in `heartbeat/topics/<topic>.md`; add a short route in `WORK.md`.
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

## Reconcile a conversation

1. Consult `heartbeat/WORK.md` in the active prompt directory and read the matching topic file.
   If absent, search `heartbeat/archive/` for the topic, source thread, or notification reference.
   When context is missing, retrieve the linked notification or source conversation through surface
   tools. Ask a focused question only if the relevant matter remains ambiguous after lookup.
2. Apply the user's answer to that matter. Accept their account of their own actions as user-confirmed
   evidence. Distinguish completion from a request to stop following up; either can end a watch.
   Keep corrections and preferences scoped to the matter they described.
3. Re-read the entry and make a targeted update before finishing the turn. Record the changed
   understanding, the current conversation reference, and the remaining next check or reason for
   completion/stopping. Preserve unrelated entries and explicit delivery targets. A closed watch
   needs no next check. Apply "Keep notes current" below when closing it. Materially new evidence
   may reopen completed work; a watch the user stopped stays stopped until they ask to resume it.
4. Acknowledge the result after the edit succeeds. If the notes are unavailable or the edit fails,
   state that the watch update is still pending. If no matching watch exists, continue the conversation
   and use the creation route only when further monitoring is warranted. Reconciliation does not
   require enabling heartbeat or rerunning setup.

## Keep notes current

- Treat `heartbeat/WORK.md` as a routing table: one short entry per unresolved topic, its next action
  and check time or explicit condition for resuming, and a link to `topics/<topic>.md`. Keep the latest
  discovery cursor and coverage gap in a short separate section. Replace the previous wake summary.
- Keep each topic file as a current snapshot. Retain its objective, source and origin, authorization
  boundaries, delivery instructions, relevant facts and uncertainties, latest check, next check and
  rationale, notification criteria, last communicated finding and reference, and stopping condition.
  Keep failed or uncertain delivery and pending findings until resolved.
- Replace superseded facts and instructions. An unchanged check updates the last-check and next-check
  fields. Link detailed evidence in reports or source conversations instead of accumulating check
  histories, repeated constraints, or transcripts. Keep only lessons that affect the next action.
- When a topic completes, expires, or is cancelled, remove its route from `WORK.md` and its active
  topic file in the same update. First save a concise outcome and source references in
  `heartbeat/archive/<topic>.md` when they prevent duplicate work or explain a decision, including
  user-stopped watches. Delete disposable notes. Preserve unresolved notification delivery as active
  work until it is resolved or the user cancels it.
- Search archives for a matching matter when reconciling a conversation or considering a new watch.
  Load only matching records; archives are outside routine wake context.
- Re-read files before targeted edits and preserve unrelated work. Finish an update with valid topic
  links, a next action or resume condition for each active route, and settled topics removed.

## File ownership

The built-in [workflow](assets/HEARTBEAT.md) and [routing index](assets/WORK.md) are starter assets.
Active copies belong to the user and can be customized through conversation. Keep operational lessons
with their watch; promote a lesson into standing instructions only when feedback or repeated evidence
supports it. Silence from the user alone is not evidence of a preference.
