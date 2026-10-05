# GitHub Reply Permalinks

## Purpose

GitHub issue comments have no native reply target, so relay replies carry an
`In reply to ...` prefix. The prefix is a permalink to the referenced issue or
pull request body, or to the specific issue comment, built on the configured
GitHub host. Readers navigate directly to the source instead of seeing an
internal message ID.

## Reference Contract

This feature keeps the existing `GithubMsgRef` and event-bus contracts
unchanged:

- `channelId` is `<owner>/<repo>#<thread-number>`.
- An issue or pull request body reference stores the thread number in
  `messageId`.
- A comment reference stores the GitHub issue-comment database ID in
  `messageId`.

`messageId` therefore has two established meanings. The URL builder resolves
them with the same convention `isGithubIssueTriggerId` uses elsewhere. Keeping
this decision at the GitHub output boundary avoids changes to relay snapshots,
reanchoring, the event bus, and adapter boundaries.

## URL Construction

`githubMessageUrl({ sessionId, messageId, webBaseUrl })` in
`apps/core/src/github/github-ids.ts` parses the repository and thread number
from `sessionId` and builds this base URL:

```text
<web base URL>/<owner>/<repo>/issues/<thread-number>
```

| Target                     | Detection                     | Result                                      |
| -------------------------- | ----------------------------- | ------------------------------------------- |
| Issue or pull request body | `messageId === thread number` | Bare thread URL                             |
| Issue comment              | `messageId !== thread number` | `<base>#issuecomment-<comment database id>` |

GitHub serves pull requests under `/issues/<number>` as well: it redirects to
`/pull/<number>` and preserves the fragment, so the reference needs no
issue-or-PR discriminator. The thread URL already opens at the body, so body
links carry no `#issue-<id>` anchor; that anchor would require the issue
database ID and an extra API request without changing where the reader lands.

Repository components and comment IDs are URL-encoded. GitHub renders the link
as `#<number>` or `#<number> (comment)` in the comment body.

`githubReplyPrefix(...)` wraps the URL as `In reply to <url>:` followed by a
blank line. Both call sites use it, so they cannot drift apart. When the
session id is not a GitHub thread (for example a mismatched persisted workflow
binding), the prefix keeps the bare message id instead of throwing, so the
workflow progress port still returns its failures as results.

## Host Resolution

`githubWebBaseUrl({ host, apiBaseUrl })` derives the web origin from the
configured GitHub auth, the reverse of `deriveApiBaseUrl`:

1. An explicit `host` wins: `github.com` yields `https://github.com`, any other
   value yields `https://<host>`.
2. Otherwise the API base URL's origin, with a leading `api.` dropped:
   `https://github.example.com/api/v3` yields `https://github.example.com`, and
   `https://api.github.com` yields `https://github.com`.
3. Otherwise `https://github.com`.

`getGithubWebBaseUrl()` in `github-api.ts` reads the stored auth secrets
(user token first, then GitHub App), which is where `host` and `apiBaseUrl`
are configured for GHES. It only reads the secret files and never mints a
token. The adapter passes the resolver into the output stream, which calls it
only when a reply target exists. No GitHub API request is made to build the
link, and an unreadable secret falls back to `https://github.com`.

## Call Sites

- `GithubOutputStream.finish()` prefixes agent replies started with a
  `replyTo` reference.
- `createGithubWorkflowProgressPort().send()` prefixes workflow progress
  messages that carry `replyToMessageId`.

## Validation

- `apps/core/tests/github/github-ids.test.ts` covers host derivation, both URL
  forms, and the prefix text.
- `apps/core/tests/surface/github/github-output-stream.test.ts` covers body and
  comment links, the configured host, and that the host is not resolved
  without a reply target.
- `apps/core/tests/surface/github/github-adapter.test.ts` covers the adapter
  wiring, the github.com fallback, and the workflow progress port.

## Future Schema Option

A coordinated schema change could add an explicit target kind and canonical
`html_url` to `GithubMsgRef`. That would remove the current `messageId`
overload and the host derivation, but it would require synchronized changes
across the event bus, relay snapshots, reanchoring, and adapter boundaries.
This feature deliberately preserves the current contract and limits permalink
generation to the GitHub output boundary.
