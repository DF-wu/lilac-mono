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
- When an installation still uses heartbeat-owned `HEARTBEAT.md`, inbox handoffs, or archives, read
  [references/migration.md](references/migration.md) before changing that setup. Preserve its work.
- When creating or changing a watch, follow the watch instructions below.
- When a conversation answers a proactive question or changes an ongoing matter, follow
  "Reconcile a conversation" below, including when the watch is missing from current context.
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

## Reconcile a conversation

1. Consult `heartbeat/WORK.md` in the active prompt directory. Match the topic against active and
   completed entries using source threads and last-notification references. When context is missing,
   retrieve the linked notification or source conversation through surface tools. Ask a focused
   question only if the relevant matter remains ambiguous after lookup.
2. Apply the user's answer to that matter. Accept their account of their own actions as user-confirmed
   evidence. Distinguish completion from a request to stop following up; either can end a watch.
   Keep corrections and preferences scoped to the matter they described.
3. Re-read the entry and make a targeted update before finishing the turn. Record the changed
   understanding, the current conversation reference, and the remaining next check or reason for
   completion/stopping. Preserve unrelated entries and explicit delivery targets. A closed watch
   needs no next check. Retain a brief outcome and source references in completed watches so old
   evidence does not reopen it. Materially new evidence may reopen completed work; a watch the user
   stopped stays stopped until they ask to resume it.
4. Acknowledge the result after the edit succeeds. If the notes are unavailable or the edit fails,
   state that the watch update is still pending. If no matching watch exists, continue the conversation
   and use the creation route only when further monitoring is warranted. Reconciliation does not
   require enabling heartbeat or rerunning setup.

## File ownership

The built-in [workflow](assets/HEARTBEAT.md) and [working notes](assets/WORK.md) are starter assets.
Active copies belong to the user and can be customized through conversation. Keep operational lessons
with their watch; promote a lesson into standing instructions only when feedback or repeated evidence
supports it. Silence from the user alone is not evidence of a preference.
