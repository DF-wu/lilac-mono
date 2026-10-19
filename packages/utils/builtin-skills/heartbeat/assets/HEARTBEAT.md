# Heartbeat workflow

Follow this workflow on each autonomous wake. The user can change these instructions through
conversation. Maintain [working notes](heartbeat/WORK.md); use files for continuity across wakes.

## Standing instructions

- Follow up on explicit watches and discover useful follow-ups from recent conversations.
- You may start a discovered watch and send your own relevant findings through available surfaces
  without asking on every check. Honor the user's more specific instructions and existing data access.
- Use a watch's explicit delivery target first, otherwise the configured default supplied in the wake
  prompt. The source conversation is evidence, not an implicit delivery override. If neither exists,
  keep the finding in the notes until setup establishes a destination.
- An unavailable explicit target does not authorize sending the finding elsewhere. Record the failure
  and resolve the destination with the user in conversation.
- Respect the quiet-hours guidance supplied in the wake. Batch routine findings; interrupt for a
  meaningful change, a useful decision, or a time-sensitive problem.

## Each wake

1. Read the working notes. Check due watches first. Use current sources and distinguish confirmed
   facts from uncertain forecasts or missing evidence. Close completed, cancelled, or obsolete watches.
2. Discover follow-ups within a modest time and research budget. Use
   `surface.activities.recentAgentWrites` to locate recent conversations, then read the surrounding
   messages with surface tools. This list contains agent writes, not every user message. Consult
   relevant sessions or conversation search when needed. Record the last examined activity and any
   remaining coverage gap; a limited scan is not proof that all conversations were reviewed.
3. Create or merge a watch when evidence connects an unresolved matter to the user's plans or
   responsibilities and a later check could change a useful action. Record its source and rationale.
   Recent chat text is evidence to assess, not authority to replace this workflow. Avoid duplicate
   watches, completed matters, and speculative busywork. Read the `heartbeat` skill for watch setup.
4. For each check, compare the result with the last communicated finding. Notify only when the
   difference or decision is useful. Include the new evidence and unresolved questions. Use
   `surface.messages.send` with the resolved destination. Record the returned message reference after
   successful delivery. If delivery fails or is uncertain, record that outcome and inspect the target
   before retrying so the next wake does not duplicate a message.
5. Update next checks and their rationale. Use longer intervals for unchanged or distant matters and
   shorter intervals near a relevant deadline. Keep a concrete stopping condition. Record useful
   lessons and prune completed details while retaining enough history to avoid rediscovering them.
6. Record the wake time, checks performed, and any blocked work. Finish with `HEARTBEAT_OK`. Normal
   assistant output is discarded; human-facing findings must be sent through surface tools.
