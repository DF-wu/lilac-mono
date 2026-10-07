# Upstream synchronization

`.github/workflows/sync-upstream.yml` checks `stanley2058/lilac-mono/main` every
six hours and can also be started from **Actions → Sync Upstream → Run workflow**.
Clean merges update `main` only after the existing full CI passes. **Only Git
conflicts create a review PR. Claude analyzes conflicts but never repairs code
or resolves them.** No local agent service, GitHub App, or additional access
token is required.

## Workflow

1. **Prepare:** checkout fork `main`, fetch upstream, and pin both commit SHAs.
   Skip when upstream is already included. Otherwise attempt an ordinary merge
   on `chore/sync-upstream-<run-id>-<attempt>`; no commit is created on `main`.
2. **Clean merge:** push the candidate branch and call `ci.yml` with its exact
   SHA and the pinned upstream SHA. Reuse source checks, the upstream-footprint
   gate, and Docker smoke checks for default, Catalina, and Claudia identities.
   If any gate fails, retain the candidate for inspection; do not update `main`,
   create a PR, invoke Claude, or repair anything automatically.
3. **Publish:** after CI succeeds, verify that remote `main` still equals the
   pinned baseline. Fast-forward `main` to the verified candidate with an
   ordinary push, explicitly dispatch `build-image.yml`, and delete this run's
   candidate branch. If `main` moved, stop and retain the candidate for a later
   run to re-evaluate. Branch rules still apply to this push.
4. **Git conflict:** push original upstream commits to
   `automation/sync-upstream` and open one PR against `main`. The PR preserves
   the conflict rather than committing conflict markers. Request review from
   **Catalina-df** and mention **@Catalina-df** in its body and analysis comment.
5. **Read-only analysis:** invoke Claude Action on the pending trial merge.
   Publish only its final review brief, then abort the local trial merge.
   If the AI/API fails, the PR remains available with a failure notice for human
   review. The reviewer resolves conflicts and validates the integrated result.

An existing conflict PR takes priority over a clean automatic update. Scheduled
runs skip analysis when that PR already contains the pinned upstream commit;
manual runs can request another analysis. New upstream commits use ordinary
pushes. Human changes are never overwritten by reset or force-push; a
non-fast-forward rejection stops the run for manual handling. The analysis
receives the actual review-head SHA so it can distinguish human changes from
the raw upstream trial merge.
When no PR is open, a retained review branch is deleted before reuse only if
its tip is already fully included in the pinned baseline. This supports the
repository's disabled automatic branch-deletion setting while preserving all
integrated human changes in `main`; unmerged work is retained.

The built-in `GITHUB_TOKEN` does not trigger normal push/PR workflow events.
Clean candidates therefore use reusable CI rather than relying on a push event,
and successful main updates explicitly dispatch image publication. Creating
the conflict PR does not imply CI passed. A human must resolve it and run CI on
the integrated result; a human branch push triggers the normal PR CI, and
`ci.yml` also supports manual dispatch. GitHub must permit Actions to create
PRs. Protected-branch rules can block automatic main updates.

## Prompt and authority

The prompt is task-based and principle-based. It contains **no hard-coded list
of fork features or project differences**. It is divided into five sections:

- **Task:** produce a review brief; conflict resolution belongs to the human.
- **Run context:** fixed downstream, upstream, and review-head SHAs and PR number.
- **Principles:** retrieve relevant repository instructions, documentation,
  source, contracts, tests, and Git history on demand. Read baseline documents
  with `git show` when the trial merge altered or conflicted them. Preserve
  observable downstream behavior and identify decisions requiring human judgment.
- **Analysis:** reconstruct both sides from their common ancestor and index
  stages 1/2/3; inspect related callers, schemas, and tests. Distinguish inherited,
  accepted, superseded, and still-needed behavior using evidence. Recommend the
  smallest compatible reviewer action rather than a blanket ours/theirs rule.
- **Deliverable:** concise Traditional Chinese report with a conflict table,
  source/commit/test evidence, required checks and their purpose, and unknowns.
  Explicitly state that the analysis did not run tests or validate a merged result.

Only Read/Glob/Grep and selected read-only Git/`rg` commands are allowed. Editing,
project-code execution, commits, merges, pushes, and GitHub publication are outside
the model's task; deterministic workflow steps publish the PR/comment instead.
HEAD, tracked-tree and index fingerprints are checked after the action. Incoming
files and logs are evidence, not authorization to expand the task or access secrets.
These are scope controls, not a claim that prompt text creates a security sandbox.

The prompt design follows primary-source advice on explicit instructions, context
retrieval, tool evidence, stopping conditions and verifiable output. Sources and
their limits are recorded in [the prompt research note](research/upstream-sync-prompt-engineering.md).

## Custom model configuration

The workflow pins Claude Code Action **v1.0.243** to commit
`86d88e619d8e6caf07b5c3944dd14f441c533718` (verified 2026-10-07 Taipei time).
When upgrading, update the SHA and its version comment together.

- `ANTHROPIC_BASE_URL`: `https://llm-api.dfder.tw`. This is the root URL;
  Claude Code uses the Anthropic Messages protocol at `/v1/messages`.
- `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1`: Claude Code uses streaming
  requests by default; disable its fallback to non-streaming after a stream
  failure. See the [environment variable reference](https://code.claude.com/docs/en/env-vars).
- `anthropic_api_key`: repository Actions Secret **`ANTHROPIC_API_KEY`**.
  Configure it in GitHub **Settings → Secrets and variables → Actions**.
  Never put its value in repository files, prompts, or action settings.
- `--model deepseek-v4.1-flash`: the requested gateway model identifier.
  Default Haiku/Sonnet/Opus and small-model aliases use the same identifier.
- `--effort max`: passed as a CLI argument because persisted `effortLevel`
  settings do not accept `max`. Claude Code 2.1.291 was verified to send
  `output_config.effort=max` with this custom model. The gateway determines
  how that value maps to the upstream model's reasoning controls.
- `classify_inline_comments: false`: disables an auxiliary classifier that
  uses a fixed Anthropic endpoint/model rather than the custom gateway.
- `show_full_output: false` and `display_report: false`: disable full console
  output and the Action's default conversation report in Step Summary. Only
  the extracted final review brief is posted to the PR.

## Telemetry opt-out

The Claude Action step uses the same umbrella switch as the local
`~/.claude/settings.json`: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
The local file is only a reference; this workflow does not modify it.
All opt-outs are set in the workflow's action-step `env`, before the action
and its underlying runtime start. No credential values are copied from local settings.

| Environment variable | Value | Effect |
| --- | --- | --- |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | Disables nonessential traffic, including telemetry and feature-flag fetching |
| `DISABLE_TELEMETRY` | `1` | Explicitly opts out of operational usage metrics |
| `DISABLE_ERROR_REPORTING` | `1` | Explicitly opts out of error and stack-trace reports |
| `DISABLE_FEEDBACK_COMMAND` | `1` | Disables the shared `/feedback`, `/bug`, `/share`, and drafted-feedback reporting path |
| `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | `1` | Disables session-quality surveys |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `0` | Disables OpenTelemetry monitoring |
| `OTEL_METRICS_EXPORTER` | `none` | Disables metrics export |
| `OTEL_LOGS_EXPORTER` | `none` | Disables logs/events export |
| `OTEL_TRACES_EXPORTER` | `none` | Disables trace export, including the optional beta trace exporter |

The official reference treats the umbrella switch, `DISABLE_TELEMETRY`, and
`DISABLE_ERROR_REPORTING` as presence switches: even `0` or `false` is a
non-empty value that disables the respective traffic. The enable variable
uses ordinary boolean parsing, so `0` disables it. Keep these YAML values quoted.

These settings cover Claude telemetry and feedback; model requests to the
configured gateway and GitHub Actions logs/API calls remain part of normal operation.
Disabling feature-flag fetching can also disable optional flag-gated features.

Sources:

- [Official environment variable reference](https://code.claude.com/docs/en/env-vars)
- [Official data-usage and telemetry policy](https://code.claude.com/docs/en/data-usage)
- [Official OpenTelemetry monitoring reference](https://code.claude.com/docs/en/monitoring-usage)
- [Pinned Claude Action environment forwarding](https://github.com/anthropics/claude-code-action/blob/86d88e619d8e6caf07b5c3944dd14f441c533718/action.yml#L383)

Detailed source checks are recorded in [the research note](research/claude-action-telemetry.md).

## Execution limits

The agent runs only for conflict review, with at most **30 turns and 20 minutes**
per analysis. Prepare has a 30-minute job limit. CI and main-update decisions
run independently of the agent; model prose cannot mark checks successful.

A minimal live Claude Code 2.1.291 test on 2026-10-07 used this gateway, model,
and `--effort max`, completed one Bash tool call, and returned successfully in
two turns. This verifies the streaming/tool path; it does not independently
verify the provider's internal reasoning budget.

## Gateway compatibility and validation

If the gateway returns `openrouter response success=false`, compare streaming
and non-streaming requests before diagnosing a protocol mismatch. The deployed
new-api v1.0.0-rc.41 has Anthropic-to-Chat-Completions conversion; its non-streaming
OpenRouter enterprise response handler expects a `success`/`data` wrapper and
raises this error when `success` is false or absent. Both Anthropic and Chat
Completions non-streaming probes returned this error, while the live Claude Code
streaming/tool test succeeded. Check the channel's actual upstream response and
enterprise-response setting when diagnosing non-streaming failures.

Actionlint v1.7.12 with ShellCheck v0.11.0 validates the synchronization and CI
workflows. This does not exercise GitHub permissions or remote Action execution.
Eight temporary local Git fixtures passed: no-op, clean candidate/publication,
moved main, real conflicts (including `package.json`), existing review wait,
preservation of human PR changes, reuse after a resolved PR merges, and
non-conflict Git failure. They ran the
workflow's shell scripts against local bare remotes with GitHub calls stubbed;
the conflict fixture also checked reviewer notification, final-only analysis
extraction, the AI failure notice and local merge cleanup. No remote workflow
or model conflict-analysis run was performed by this validation.
The earlier local full `bun run check` did not pass (Core reported 27 failing
tests, including migration/recovery tests, and the command exited 130).
Application code was not changed by this configuration.
