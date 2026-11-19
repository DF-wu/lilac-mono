# Fork maintenance review — 2026-10-22

Baseline: fork `728658f9506c864ab8754b8d50f39803dde8f9ca` already contains upstream
`4f7eedb80dece58c79369b62210574ea869bbae6`. The review covers the surviving fork diff,
including fork-owned modules and the upstream-file footprint. This work is maintained in
`DF-wu/lilac-mono`; it is not an upstream contribution.

## Direction and classification

The fork extends the upstream runtime while following its ownership and lifecycle rules.
Telegram remains the largest product difference. OpenAI search, the compatible image-script
provider, generic compatible Chat image handling, and the external media example remain useful
extensions. Native chat, proactive heartbeat, reply permalinks, and the image script runner are
inherited capabilities and must not be described as fork inventions.

The structured image tool and its routing configuration were already retired before this
review. The current runner needs only the small `providers.openaiCompatible` extension; this
review does not restore the old tool or introduce another image abstraction.

## Findings and corrections

| Finding | Correction and regression coverage |
| --- | --- |
| Telegram connected its producer during adapter-ingress registration, before dependent consumers were ready. | Retain shared lifecycle ownership and defer polling/outbox publication until routing, workflow, relay, and paused-runner consumers are installed; exercise an update emitted during startup. |
| Deferring the whole Telegram connection allowed durable consumer replay before the adapter's identity and local store existed. | Initialize the adapter before consumer delivery, then start ingress after consumers are installed; cover restart delivery with an adapter that enforces initialization. |
| Telegram router completion was dropped by its stop-only request-ingress handle. | Supervise unexpected termination through existing runtime failure handling; distinguish shutdown from subscription failure. |
| Router directive parsing and targeted menu commands ignored the username discovered by `getMe`. | Use the configured username or the adapter's resolved identity consistently; test omitted `botUsername`. |
| Streamed assistant messages lost their reply link when written to the Telegram index. | Preserve the existing reply metadata through output recording; test user → assistant → user chain traversal. |
| Same-second message edits could retain the same Telegram conversation revision; edit activity did not advance `updated_at`. | Make revisions content-sensitive and include modification time in activity; test stale-search invalidation and edit timing without changing stored schemas. |
| Authenticated restricted native tool calls treated `thread` and `native:thread` as different destinations. | Normalize with existing native session helpers at both authorization gates; test actual Surface calls and continued rejection of other threads. |
| The custom-media example returned raw values and threw expected failures after upstream adopted real Level 2 Results. | Return `Result.ok` / `Result.err` with the current failure contract; exercise the built plugin through Core's hook. The only added dependency is the approved `better-result@3.0.1`. |
| Custom-media edit uploads had unnamed image and mask parts. | Supply multipart filenames while retaining existing validation and routing; inspect requests at a local provider fixture. |
| Malformed provider base64 escaped the image SDK as `InvalidCharacterError` and was treated as a plugin defect. | Return the existing retryable `PROVIDER_ERROR` Result for that decoding failure; test source and bundled callables while preserving unrelated DOM exceptions and Panic identity. |
| A completed Responses envelope with only failed hosted searches was accepted as an empty success. | Reject the failed search as unavailable so the existing fallback chain runs; retain successful empty searches and legacy calls without a status. |
| V2 runtime accepted singular OpenAI provider aliases that the generated editor schema rejected. | Derive each version's alias enum from its own provider items; keep v1 frozen and test runtime/editor agreement. Move fork search schemas and their inferred tuning type to `core-config/openai-web-search.ts`. |
| The watchdog restart behavior was already upstream; the surviving fork patch only added unused timer injection. | Restore the exact upstream implementation and remove its footprint entry; retain the existing runtime-control tests. |
| Migration guidance named the wrong backup directory and attributed the Docker migration gate to Core startup. | Document `.migration-backups/blob-storage-v5-v25`, coordinated version checks, and the actual startup script/entrypoint owners. Add the missing compatible-tool-image behavior to both fork inventories. |

The review distinguishes documented runtime invariants from heuristic cleanup. The watchdog
removal is a simplification; the other code corrections address reproduced contract or
existing-functionality failures. No new Telegram parity feature is part of this maintenance.

## Retained boundaries and residual work

- Telegram still uses long polling, one memory thread per chat/topic, and its existing allowlists.
  Heartbeat default destinations, interactive questions, transcription, and additional surface
  operations keep their documented limitations.
- Compatible tool-image lifting remains a provider-view adaptation. It does not rewrite canonical
  history or establish a gateway model's vision capability.
- Protected-current-input compaction, nonstandard-finish tool calls, Redis subscription cleanup,
  origin-session authority, GitHub publication guidance, and container identities remain fork patches
  where the fixed upstream does not provide equivalent behavior.
- The automatic legacy blob migration remains a one-way Docker entrypoint operation with the
  existing backup and version rules. This review changes its documentation, not its stored format.
- Streamed reply metadata follows the existing finish-triggered indexing path. Historical missing
  links and abort-only inline output are not backfilled by this change.
- Restricted surface calls with exactly matching literal IDs can still fall through to an explicitly
  selected different client. Independent review confirmed this predates the native alias fix;
  changing that cross-surface authority policy remains a separate decision.
- Verification uses local fixtures; it does not establish live Telegram, hosted-search, image,
  video, or private gateway availability.

## Verification

Validation used the repository-pinned Bun 1.4.2 and an isolated local Redis instance.
The final `bun run check` ran without source changes during the run:

- Generated-schema freshness, typechecks, lint, formatting, and architecture checks passed;
  the architecture suite passed all 113 tests. Lint retains four pre-existing unused-variable warnings.
- Root tests passed all 24 cases. Core passed 4,187 tests, including the new regressions, with
  two failures also present before this review: native `operator-integration.test.ts` could not
  bind its required port while the host was already listening on `8788`, and the fuzzy-search
  assertion in `tool-server-skills.test.ts` was affected by the host's global skills.
- `bun run test:lint-rules` passed all 68 Bun tests and its Node rule tests separately, because
  the workspace-test failure prevents the combined check from reaching that step.
- Expanded Telegram/workflow regressions passed 544 tests. A final independent lifecycle review
  passed another focused 120-test run and found no introduced P1/P2 issue. Retained Redis delivery
  is simulated in the real-adapter/local Bot API fixture; native Core startup also passed against
  isolated Redis.
- The standalone custom-media example passed 23 tests, typecheck, build, and formatting. Core's
  full suite exercised the rebuilt bundle through the actual Level 2 plugin hook.
- Strict footprint validation against `4f7eedb8` passed: 115 allowed upstream-file differences,
  zero unlisted, and zero stale. The retired watchdog file matches upstream exactly.

The full repository check therefore remains red for the two baseline host-dependent tests;
the fork PR records this limitation rather than claiming a completely green local run.
