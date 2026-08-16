---
name: lilac-acp
description: Drive ACP harnesses through the local Lilac controller.
---

# lilac-acp

Use `lilac-acp` for detached prompt runs, session search, or bounded snapshots across OpenCode, Codex,
Claude, and Cursor ACP harnesses.

1. Confirm the target harness is launchable: `lilac-acp harnesses list`.
2. Find a session when continuing work:
   ```bash
   lilac-acp sessions list --directory /abs/path/to/repo --search "failing tests"
   ```
3. Load recent context when needed:
   ```bash
   lilac-acp sessions snapshot --directory /abs/path/to/repo --harness opencode --latest --runs 6 --max-chars 1200
   ```
4. Submit to a new session with `--harness`, or continue with `--session-id`, exact `--title`, or
   harness-scoped `--latest`:
   ```bash
   lilac-acp prompt submit --directory /abs/path/to/repo --harness opencode --text "Fix the failing tests" --wait
   ```
5. For a detached submission, use the returned `runId` with `prompt status`, `prompt result`,
   `prompt wait`, or `prompt cancel`.

Output is one JSON object by default; add `--output human` for terminal reading. A fully qualified session
reference is `<harness>::<remote-id>`; raw IDs and `--latest` require `--harness`. Prompt workers use a
non-interactive permission policy that prefers allow-always, then allow-once, so inspect the target and
working directory before submission.
