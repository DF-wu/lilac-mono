# #80 official-source assessment

Checked 2026-10-06. This note assesses `fix/current-input-compaction`; it does not change production behavior.

## Conclusion

The fix is a reasonable application-level compaction preflight correction. It does not implement, or claim to be mandated by, an OpenAI/AI SDK compaction standard. The protected current-input boundary is an existing Lilac policy; the fix applies that same boundary before starting threshold compaction. With an empty eligible historical prefix, threshold compaction becomes a no-op instead of a fatal null-selection error. Actual provider overflow continues through the existing overflow path and still fails if protected input cannot be reduced.

## What the official sources establish

1. OpenAI defines a context window as the maximum tokens used in a request, including input, output and reasoning. A local threshold is not permission to exceed the model's context limit. Source: [Conversation state — Managing the context window](https://developers.openai.com/api/docs/guides/conversation-state#managing-the-context-window).
2. OpenAI provides Responses-specific server compaction using `context_management` and `compact_threshold`, and a standalone `/responses/compact` endpoint. These are separate API workflows from Lilac's local summary selection. Source: [Compaction](https://developers.openai.com/api/docs/guides/compaction).
3. The standalone compact input must itself still fit within the model context window, and its output must be carried forward as-is. The server-compaction guide also warns against manually pruning when using `previous_response_id`. Source: [Standalone compact endpoint](https://developers.openai.com/api/docs/guides/compaction#standalone-compact-endpoint) and [Server-side compaction](https://developers.openai.com/api/docs/guides/compaction#server-side-compaction).

## What is engineering judgment

The fetched official documents do not specify Lilac's `currentCanonicalStart`, which prefix a local summary must select, or a required failure for an empty local eligible prefix. Keeping the existing protected input and skipping a soft trigger with no eligible content is our engineering choice, not a quotation of an official recommendation. It prevents the observed local failure without making any API contract change.

Skipping this trigger does not reduce context size. If the next request exceeds actual provider limits, it may still fail. A strategy for irreducibly large current requests is separate work; this fix does not silently discard input or declare overflow recovered.

## Implementation and evidence

- `packages/agent/auto-compaction.ts` validates the existing maximum suffix boundary before threshold preflight and checks zero before starting compaction. The overflow branch does not use that threshold-only skip.
- `packages/agent/tests/auto-compaction.test.ts` covers high usage/start=0 completion, historical-prefix summarization without current input in the summary, true overflow failure and invalid boundary rejection.
- Independent branch verification: 59 focused compaction tests and all 531 agent tests pass on Bun 1.4.2. Typecheck, static and architecture checks pass; local overall repo check exposes separately reproduced baseline failures documented in #80. GitHub CI on `ecc1d764` passed all five jobs, including Source checks and Upstream footprint.

These tests establish local behavior, not a provider guarantee about requests that exceed its context limit.

## Integration status

[PR #82](https://github.com/DF-wu/lilac-mono/pull/82) merged on 2026-10-06 as `9a3d93d4789e973ce20d60785604846112234435`, closing [issue #80](https://github.com/DF-wu/lilac-mono/issues/80). Codex reviewed the final PR head `ecc1d764` without major findings. This establishes repository integration; no production deployment or provider-overflow recovery guarantee is asserted.
