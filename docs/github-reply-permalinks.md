# GitHub Reply Permalinks

## Purpose

GitHub relay replies include an `In reply to ...` reference. The reference is
rendered as a clickable permalink to the referenced issue or pull request body,
or to the specific issue comment. This lets readers navigate directly to the
source without searching for an internal message ID.

## Existing Reference Contract

This feature keeps the existing `GithubMsgRef` and event-bus contracts
unchanged:

- `channelId` is `<owner>/<repo>#<thread-number>`.
- An issue or pull request body reference stores the thread number in
  `messageId`.
- A comment reference stores the GitHub issue-comment database ID in
  `messageId`.

`messageId` therefore has two established meanings. The URL builder must
first determine which target is referenced before choosing the GitHub anchor.
Keeping this decision at the GitHub output boundary avoids changes to relay
snapshots, reanchoring, the event bus, and adapter boundaries.

## URL Construction

`githubMessageUrl({ sessionId, messageId, issueId })` parses the repository and
thread number from `sessionId`, then creates this common base URL:

```text
https://github.com/<owner>/<repo>/issues/<thread-number>
```

The target-specific rules are:

| Target | Detection | Result |
| --- | --- | --- |
| Issue or pull request body | `messageId === thread number` and `issueId` is available | `<base>#issue-<issue database id>` |
| Issue or pull request body | `messageId === thread number` and `issueId` is unavailable | Bare `<base>` URL |
| Issue comment | `messageId !== thread number` | `<base>#issuecomment-<comment database id>` |

GitHub accepts the `/issues/<number>` base for pull requests as well. It
redirects to the pull request URL while preserving the fragment, so the
reference does not need to carry an additional issue-or-PR discriminator.

Repository components and comment IDs are encoded before being placed in the
URL. The numeric thread number and body issue ID originate from the parsed
GitHub reference/API response.

## API and Performance

GitHub uses different object identities for body and comment anchors:

- `#issue-<id>` requires the issue or pull request database ID.
- `#issuecomment-<id>` uses the existing issue-comment database ID.

`getIssue()` now exposes the issue database `id`. The output stream calls
`getIssue()` only when the reply target is the thread body. Comment replies use
their existing `messageId` directly and do not add an API request.

If the body lookup fails to provide an ID, permalink generation falls back to
the bare thread URL. The resulting reply remains readable and points to the
correct issue or pull request without emitting an invalid anchor.

## Validation

The URL helper is covered by `apps/core/tests/github/github-ids.test.ts`.
`apps/core/tests/surface/github/github-output-stream.test.ts` additionally
covers the production output path: body replies look up the issue database ID,
comment replies avoid that lookup, and failed body lookups fall back to the
thread URL. The adapter contract suite verifies the injected GitHub API boundary.

Current validation on `main`:

- focused GitHub helper, output-stream, and adapter tests — 36 passed
- `bunx tsc -p apps/core/tsconfig.json --noEmit` — passed
- `bun run fmt:check` — passed

## Future Schema Option

A coordinated schema change could add an explicit target kind and canonical
`html_url` to `GithubMsgRef`. That would remove the current `messageId`
overload and avoid the body lookup, but it would require synchronized changes
across the event bus, relay snapshots, reanchoring, and adapter boundaries.
This feature deliberately preserves the current contract and limits canonical
URL generation to the GitHub output boundary.
