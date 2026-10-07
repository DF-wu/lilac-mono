# Decision auto-inject benchmark

Run on 2026-10-07 against retained production data. Active production configuration was unchanged.
Private messages, summaries, image bytes, and individual model answers stayed in memory; this report
contains aggregate results only.

## Recommendation

Use the AI SDK `experimental_decide` interface with native TypeSafe and OpenAI decision providers.
Keep Jev as the default. Luna adds image evaluation, but this replay does not justify replacing Jev
globally: Luna was slower and produced more incorrect selections at the original thresholds.

The installed OpenAI SDK provider serializes decision state as text. `createOpenAIDecisionModel`
preserves the SDK's question mapping and rewrites image-bearing requests to native `input_text` and
`input_image` parts. Putting an image URL into the state JSON alone would not send vision input.
See the [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions) and
[AI SDK decision guide](https://ai-sdk.dev/docs/ai-sdk-core/decisions).

This is a provisional Luna text preset. Jev's scoped defaults retain the original values.
Luna's scoped defaults use this preset; image thresholds still need further evaluation.

```yaml
conversation:
  thread:
    autoInject:
      enabled: true
    autoInjectMode: decision
    decisionAutoInject:
      model: [typesafe/jev-1.13.0, openai/gpt-6-luna]
      limit: 3
      candidateLimit: 30
      semanticFallback: true
      jev:
        recallMinProbability: 0.7
        durableSubjectMinProbability: 0.6
        casualMaxProbability: 0.6
        relevanceMinProbability: 0.6
      luna:
        recallMinProbability: 0.5
        durableSubjectMinProbability: 0.6
        casualMaxProbability: 0.3
        relevanceMinProbability: 0.8
```

This list selects Jev for text and Luna when the latest message has an image. The array is not a retry
chain. For Luna on every request, use `[openai/gpt-6-luna]`. `OPENAI_API_KEY` authenticates Luna, with
optional `OPENAI_BASE_URL`; Jev uses `TYPESAFE_AI_API_KEY`. Only the selected model needs credentials.
Legacy `autoInjectMode: jev`, `jevAutoInject`, single model strings, flat thresholds, and bare Jev model
IDs still parse. Explicit scoped thresholds override legacy flat values.

## Text replay

The replay used 80 distinct native requests with nonempty historical lexical shortlists, producing
2,350 candidate judgments. Candidates used the production any-term FTS query, excluded the current
thread, and required both the thread end and summary update to precede the request. State contained
up to 4,000 characters of authored text. Each decision evaluated the existing three gates and one
question per candidate, with at most 30 candidates and three selections.

Both providers ran against the same inputs with retries disabled. Four workers ran concurrently.
An independent `gpt-6.1-sol` Responses call with low reasoning effort labeled the gates and candidate
relevance. These are model judgments, not human labels or proof of probability calibration.

Threshold selection used 53 requests. Every third request was held out, leaving 27 for comparison.
The grid covered recall and durable thresholds `0.5, 0.6, 0.7, 0.8, 0.9`; casual maxima
`0.3, 0.4, 0.5, 0.6, 0.7`; and relevance thresholds `0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95`.
Selection maximized F0.5, weighting precision more than recall. A positive label required a relevant
candidate and a positive recall gate or a durable, non-casual message.

| Held-out result, 27 requests       | Jev, original thresholds | Luna, original thresholds | Luna, text preset |
| ---------------------------------- | -----------------------: | ------------------------: | ----------------: |
| Correct selections                 |                        5 |                         8 |                 7 |
| Incorrect selections               |                        2 |                         8 |                 4 |
| Missed relevant candidates         |                       16 |                        13 |                14 |
| Precision                          |                    71.4% |                     50.0% |             63.6% |
| Recall                             |                    23.8% |                     38.1% |             33.3% |
| F0.5                               |                    0.510 |                     0.471 |             0.538 |
| Messages with incorrect selections |                        1 |                         4 |                 3 |

| Decision call, all 80 requests | Jev 1.13.0 | GPT-6 Luna |
| ------------------------------ | ---------: | ---------: |
| p50 latency                    |     226 ms |     354 ms |
| p95 latency                    |     278 ms |     692 ms |
| Reported input tokens          |    476,894 |    759,443 |
| Failed calls                   |          0 |          0 |

At the [documented Luna decision price](https://developers.openai.com/api/docs/guides/decisions)
of $0.10 per million input tokens, the 80 Luna decision calls cost approximately $0.076. This excludes
the independent labeling calls and Jev calls. Latencies cover decision calls, not the full recall path.

## Attached-image replay

Twelve additional native requests had cached image attachments and historical lexical candidates,
producing 360 candidate judgments. The replay read existing stored attachments through the blob store,
verified their content, and generated JPEG previews capped at 1,024 pixels per dimension in memory.
Luna and the independent judge received those previews; Jev received the authored text. All 12 Luna
calls succeeded.

| All 12 image requests              | Jev, original thresholds | Luna, original thresholds | Luna, text preset |
| ---------------------------------- | -----------------------: | ------------------------: | ----------------: |
| Correct selections                 |                        0 |                         1 |                 0 |
| Incorrect selections               |                        0 |                         5 |                 4 |
| Missed relevant candidates         |                        6 |                         5 |                 6 |
| Messages with incorrect selections |                        0 |                         2 |                 2 |

Jev p50/p95 was 248/334 ms; Luna with images was 760/1,157 ms. Luna reported 124,836 input tokens.
The four held-out image requests had no positive reference labels, so this sample cannot establish
image recall quality or validate a separate threshold preset. Do not tune image thresholds from it.

A separate live pixel control used identical state and question text with a synthetic red square and
a green square. Luna returned `P(red) = 1` for red and `P(red) = 0` for green, confirming that the
adapter sends usable image input.

## Limits

The replay exercised native requests and lexical candidates. It did not measure Discord participant
filtering, semantic fallback, full request latency, or the effect of injected context on final replies.
Results depend on the retained corpus and the independent model's labels. The held-out set is small.

The implementation loads attached images through existing scoped resource access, even when the main
agent model cannot accept images. It enforces existing inline media byte limits and the endpoint's
128-image limit. Jev continues to evaluate text only. Image failures skip automatic injection for that
request. Shortlisting still uses authored text; image-only messages do not run automatic recall.

Before choosing Luna as a production default, use more image-bearing examples with relevant historical
threads and human labels. The current evidence supports an opt-in Luna path with a provisional text
preset.
