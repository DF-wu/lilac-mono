# Set up and verify heartbeat

Use this route when enabling the lane or checking its operation. Read the `customize-lilac` skill's
Core configuration reference for the deployed parser, safe configuration edits, and reload procedure.
Resolve the actual `DATA_DIR`; preserve unrelated configuration and customized prompt files.

## Establish the destination

If no default is configured, ask: “Where should the default heartbeat output go?” Native is optional.
The default supports `discord`, `github`, and `native`; `telegram` is not accepted by this setting.
Resolve the answer through `surface.help`, `surface.sessions.list`, and `surface.messages.list` as
needed. Save a concrete target as `surface.heartbeat.defaultOutputSession: <client>/<sessionId>`.
For native `dm`, resolve it and save the concrete thread ID returned in `meta.session.channelId`.
For Discord, distinguish a thread from its parent channel. Preserve an existing default unless the
user asks to change it. An explicit watch destination does not replace the installation default.

## Establish the files and cadence

1. Inspect the active `HEARTBEAT.md`, `heartbeat/WORK.md`, and relevant `AGENTS.md` instructions.
   For monolithic working notes or the legacy ownership/inbox protocol, use [migration.md](migration.md).
2. Create missing files from the skill's assets. Preserve existing instructions and watches. Agree
   through conversation on changes to discovery or outreach preferences; the starter workflow allows
   inferred watches and agent-authored findings on relevant ongoing responsibilities.
3. Enable `surface.heartbeat.enabled`. Keep an existing cadence; otherwise the current default is
   `*/30 * * * *`. The scheduler uses five-field cron. Check the deployed scheduler's timezone before
   translating a requested wall-clock time. `softQuietHours.timezone` controls quiet-hour guidance,
   not the cron timezone. Preserve explicit quiet-hour and model settings.
4. Validate and reload the configuration using the customization reference. The heartbeat service
   reloads config on its ticks; enabling need not restart Core. A previously scheduled timer keeps its
   old due time until that tick observes the new config, so shortening the cadence may not speed up
   the first verification wake.
   Keep the existing idle policy: active external requests and the recent-activity quiet period can
   defer a wake. A next-check timestamp in Markdown is checked at the next available wake.

## Verify in stages

- **Configured:** The active config parses, heartbeat is enabled, the destination resolves, and both
  files are readable. Check `surface.activities.recentAgentWrites` and read a referenced conversation.
  An empty activity list may be legitimate; an unavailable tool or inaccessible target is a gap.
- **Executed:** Add a temporary watch due now, with a unique test label and a stop-after-one-success
  condition. Observe a real scheduled wake in heartbeat logs/transcripts and its update to `WORK.md`.
  If convenient, temporarily use a minute cadence and restore the original after the test. Do not
  claim a manual rehearsal proves the scheduler ran. If the current conversation keeps the lane busy,
  finish the turn and have the user return after the idle window.
- **Delivered:** Have that test watch send one clearly labeled setup message to the chosen target.
  Verify the returned reference against a message read, or obtain the user's confirmation. A successful
  model turn alone does not prove delivery. Close the test watch and restore temporary settings.

Summarize each stage as verified or pending, the default destination, and any watch overrides. If a
stage cannot be observed yet, explain the concrete next check instead of claiming setup is complete.
