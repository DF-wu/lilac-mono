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

Luna's scoped defaults use the tuned text preset from the [Luna precision tuning](#luna-precision-tuning)
replay. Jev's scoped defaults retain the original values. Image thresholds still need further evaluation.

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
        durableSubjectMinProbability: 0.5
        casualMaxProbability: 0.3
        relevanceMinProbability: 0.6
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

| Held-out result, 27 requests       | Jev, original thresholds | Luna, original thresholds | Luna, first preset |
| ---------------------------------- | -----------------------: | ------------------------: | -----------------: |
| Correct selections                 |                        5 |                         8 |                  7 |
| Incorrect selections               |                        2 |                         8 |                  4 |
| Missed relevant candidates         |                       16 |                        13 |                 14 |
| Precision                          |                    71.4% |                     50.0% |              63.6% |
| Recall                             |                    23.8% |                     38.1% |              33.3% |
| F0.5                               |                    0.510 |                     0.471 |              0.538 |
| Messages with incorrect selections |                        1 |                         4 |                  3 |

| Decision call, all 80 requests | Jev 1.13.0 | GPT-6 Luna |
| ------------------------------ | ---------: | ---------: |
| p50 latency                    |     226 ms |     354 ms |
| p95 latency                    |     278 ms |     692 ms |
| Reported input tokens          |    476,894 |    759,443 |
| Failed calls                   |          0 |          0 |

At the [documented Luna decision price](https://developers.openai.com/api/docs/guides/decisions)
of $0.10 per million input tokens, the 80 Luna decision calls cost approximately $0.076. This excludes
the independent labeling calls and Jev calls. Latencies cover decision calls, not the full recall path.

## Luna precision tuning

A second replay on 2026-10-07 found that the first Luna preset did not hold up on more data. It used
the same shortlist query, filters, and gate questions with up to 240 recent requests. 167 had lexical
candidates, and 163 completed for every provider and question variant. Luna refused one or two
questions in 4 requests. An independent `gpt-6.1-sol` call with medium reasoning
effort labeled 72 requests as gate-positive and 138 of 4,735 candidates as relevant.

Luna's candidate ranking was the problem. Thresholds alone could not fix it. Average precision
over candidates in gate-positive requests was 0.40 for Luna and 0.61 for Jev. Luna's ranking fell
off with lexical rank: 0.57 for shortlist positions 1-10, 0.24 for 11-20, and 0.17 for 21-30.
Splitting the 30 candidates across parallel calls returned identical probabilities, so Luna scores
each question independently, and position effects come from the shortlist order.

Luna now evaluates the first 10 shortlisted candidates and asks whether `candidate_thread` is "about
the same specific project, problem, or item that `message` is about." Jev keeps the original
question and all 30 candidates. Other wordings tested worse or similar: a stricter "specific facts
or decisions" question, a symmetric "same subject" question, and variants that combined sameness
with usefulness or excluded shared keywords.

| 160 requests with all variants     | Jev default | Luna, first preset | Luna, tuned |
| ---------------------------------- | ----------: | -----------------: | ----------: |
| Candidates evaluated               |          30 |                 30 |          10 |
| Correct selections                 |          29 |                 24 |          18 |
| Incorrect selections               |          15 |                 28 |           3 |
| Precision                          |       65.9% |              46.2% |       85.7% |
| Recall                             |       21.3% |              17.6% |       13.2% |
| Messages with incorrect selections |           9 |                 19 |           3 |

The tuned column uses the shipped thresholds on all 160 requests, so it overstates precision.
Three-fold cross-validation, with the thresholds tuned on two folds and scored on the third, gave
18 correct and 6 incorrect selections, or 75.0% precision. The same procedure gave 41.2% for the
original question with 30 candidates. Neighboring thresholds with the tuned question and 10
candidates stayed between 72% and 88% precision. Allowing 20 candidates dropped precision to 65.6%.
A wider grid that allowed gate thresholds as low as 0.3 and a casual maximum as low as 0.05
cross-validated worse, at 63.9%, so the shipped preset stays at the narrower grid's choice.

A paired rerun on the same 167 requests, with fresh labels, called Jev and tuned Luna one after the
other from the production deployment.

| Decision call                    | Jev, 30 candidates | Luna, 10 candidates | Luna, 30 candidates |
| -------------------------------- | -----------------: | ------------------: | ------------------: |
| p50 latency                      |             228 ms |              298 ms |              335 ms |
| p95 latency                      |             288 ms |              417 ms |              406 ms |
| p99 latency                      |             520 ms |              666 ms |              968 ms |
| Mean input tokens                |              5,887 |               3,663 |               9,639 |
| Requests with a refused question |                  0 |                   4 |                   4 |

Tuned Luna reached 76.2% precision and 13.6% recall on the fresh labels. At the same recall, Jev with
`relevanceMinProbability: 0.7` reached 88.9%: 16 correct and 2 incorrect selections. For text-only
requests, Jev is at least as precise as Luna at matched recall, and it is faster. Keep Luna for
image-bearing requests.

Each refusal covered one or two questions, not the whole request. The refused questions involved
benign security and network vocabulary, such as untrusted interfaces, API keys sent to an endpoint,
VPN routing, and traffic or usage limits. The AI SDK rejects a decision when any answer is a refusal,
so the evaluator converts a refused question to a "no": probability 0 for recall, durable-subject,
and candidate questions, and probability 1 for the casual question. A refusal cannot select a
candidate or open a gate, and the rest of the request still counts.

## Attached-image replay

Twelve additional native requests had cached image attachments and historical lexical candidates,
producing 360 candidate judgments. The replay read existing stored attachments through the blob store,
verified their content, and generated JPEG previews capped at 1,024 pixels per dimension in memory.
Luna and the independent judge received those previews; Jev received the authored text. All 12 Luna
calls succeeded.

| All 12 image requests              | Jev, original thresholds | Luna, original thresholds | Luna, first preset |
| ---------------------------------- | -----------------------: | ------------------------: | -----------------: |
| Correct selections                 |                        0 |                         1 |                  0 |
| Incorrect selections               |                        0 |                         5 |                  4 |
| Missed relevant candidates         |                        6 |                         5 |                  6 |
| Messages with incorrect selections |                        0 |                         2 |                  2 |

Jev p50/p95 was 248/334 ms; Luna with images was 760/1,157 ms. Luna reported 124,836 input tokens.
This replay predates the Luna tuning and used the original question with 30 candidates.
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
threads and human labels. The current evidence supports an opt-in Luna path with a tuned text
preset.
