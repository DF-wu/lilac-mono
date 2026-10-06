# Tool image implementation plan

**Goal / spec:** Independently fix https://github.com/DF-wu/lilac-mono/issues/79.

**Architecture:** Transform only the OpenAI-compatible outgoing V4 prompt. Lift tool image files into a user image message after the contiguous tool reply group, retaining textual results and image provenance. Keep canonical transcript and filesystem contracts unchanged. Compaction is tracked independently in #80 and another branch.

**Tech stack:** Bun 1.4.2, AI SDK 7, OpenAI-compatible 3.0.30.

**Constraints:** No new dependencies, configuration, persisted data, or production changes. Separate commits, branch pushes, PRs, and Codex review requests are authorized by the user on 2026-10-06. Preserve unrelated main-worktree modifications. Execute inline under existing authorization.

- [x] Add `packages/utils/tests/openai-compatible-tool-images.test.ts`, using `getModelProviders()` and mocked HTTP responses. Assert tool text excludes Base64, user image URLs preserve data, parallel replies precede images, and text-only results remain unchanged. Cover streaming/nonstreaming and callable/languageModel/chatModel resolution.
- [x] Run `bun run --filter=@stanley2058/lilac-utils test -- tests/openai-compatible-tool-images.test.ts`; observe Base64-in-tool-text failures before implementation.
- [x] Add `packages/utils/openai-compatible-tool-images.ts`, a typed pure prompt transformation and `wrapLanguageModel` middleware. Preserve non-image parts and provider options; delegate image data interpretation to the existing SDK user-file converter. Preserve other provider factories through `Object.assign`.
- [x] Wire the wrapper in `packages/utils/model-provider.ts`; focused tests pass.
- [x] Request read-only independent review of tool-result ordering, history replay and provider compatibility; no blocking findings.
- [x] Run `bun run check` on this isolated branch after removal of all compaction changes. Typechecks, static and architecture lanes pass; overall check fails on three baseline failures independently reproduced on clean origin/main (bash-safety codes, host skill discovery, native operator gateway).
- [x] Update #79 with final scope and verification evidence. Utils: 527 pass, 0 fail. Changes remain undeployed; final commit and PR verification follows.

## PR preparation (2026-10-06)

- User authorized separate commits, pushes, PRs, and Codex review requests.
- Fresh workspace suite: 527 pass / 0 fail using Bun 1.4.2.
- Independent pre-PR review found no blocking issues.
- Added multi-round history replay coverage: 9 image tests pass. Current official multipart-tool option requires newer SDK and verified tool-role endpoint support; retained the scoped user-image fallback.
