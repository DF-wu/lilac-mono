# Core Config Migrations

This guide records manual `core-config.yaml` changes between config versions. The current field-level
reference is
[`packages/utils/config-templates/core-config.example.yaml`](../packages/utils/config-templates/core-config.example.yaml).

Lilac parses `core-config.yaml` through a versioned parser into one universal runtime config shape. The
application consumes only the universal shape.

## Versioning Rules

- New generated configs include `configVersion`.
- Existing configs with omitted `configVersion` are treated as `configVersion: 1`.
  The version dispatcher also selects v1 for `null`, but the v1 literal schema rejects it; omit the
  key or use numeric `1` / `2`. Strings such as `"2"` fail version validation.
- Lilac does not auto-upgrade config files at startup.
- Versioned parsers own defaults for their version.
- New behavior-changing defaults apply only to configs on the version that introduced them.
- If a newer field cannot be represented safely in an older version, that field requires the newer
  `configVersion`.

## Validation, units, and reload boundaries

The runtime parser logs and ignores most unknown keys. This is not a guarantee that a typo is safe:
known fields with invalid types/ranges fail, explicitly removed fields fail with migration guidance,
and `blobStorage` objects are strict (unknown adapter keys fail). Unknown model option names produce
separate warnings and are not proof that a provider supports a value. Plugin config payloads are
opaque to Core and may have their own plugin validation. The editor's generated JSON Schema is a
separate validation layer; the versioned parser is the runtime authority.

Friendly units are field-specific, not a feature of every `*Ms` field:

| Fields (v2 input) | Accepted values |
| --- | --- |
| `tools.output.maxPreviewBytes`, `artifactMaxBytesPerSession`; `tools.media.maxInlineBytesPerPart`, `maxInlineBytesTotal`; `surface.telegram.inboundMedia.maxBytesPerAttachment`, `maxBytesPerRequest` | Positive integer bytes or `B`, `KB`, `MB`, `GB`, `KiB`, `MiB`, `GiB` strings |
| `tools.output.artifactTtl`, `tools.web.firecrawl.queueTtl` | Positive integer milliseconds or `ms`, `s`, `m`, `h`, `d`, `w`, `mo` strings |
| `agent.transcriptRetention.maxAge`, `surface.discord.attachmentCache.ttl` | The same positive duration values, or `"unlimited"` |
| `agent.transcriptRetention.maxRequests` | Positive integer count, or `"unlimited"` |
| Legacy native initial-import `oldMessageSelectionMaxAgeMs`, `storageRetentionMaxAgeMs` | The same positive duration values, or `null` (no age limit) |
| Router `activeDebounceMs`, `activeGate.timeoutMs`; heartbeat `quietAfterActivityMs`, `retryBusyMs`; agent `idleTimeoutMs`, retry `baseDelayMs`, `maxDelayMs`; Telegram `streamEditIntervalMs` | Integer milliseconds only; field-specific ranges apply |

Unit suffixes are case-sensitive, with no spaces: `1.5MiB` and `3s` are valid when they normalize to
integer values. `mo` is exactly 30 days; decimal byte units use powers of 1000, binary units powers of
1024. `"unlimited"` applies only to the retention fields listed above. Counts, token thresholds,
concurrency, and widths are integers without unit suffixes. See
[`friendly-units.ts`](../packages/utils/friendly-units.ts) and the
[v2 schema](../packages/utils/core-config/v2.ts).

Core watches the file, forces validation/reload, updates the current config and native catalog,
refreshes connected Discord/Telegram adapters, reloads tool plugins, and marks conversation
materialization dirty. Consumers observe changes at their next config read; this does not rebuild
startup resources or guarantee that an in-flight run changes settings. Transcript retention applies
on the next save. A failed reload is logged as a validation failure, not a successful application.

| Restart boundary | Operational effect |
| --- | --- |
| `blobStorage` adapter and storage/credential configuration | The blob store is created once. Restart after a verified data cutover; a YAML edit does not migrate objects. |
| Native `enabled`, `host`, `port`, `publicUrl`, `installationId`, `allowedOrigins`, `auth`, and authentication environment secrets | Listener, installation and authenticator are startup resources. Restart and update proxy/container mappings as needed. |
| Discord `tokenEnv`, `dbPath`, `memberPresence` | Connection token, store and gateway intents are established at startup. Restart. |
| Telegram `enabled`, `token`, `apiRoot`, `dbPath`, `commandMenu` | Connected adapters pin old values during reload and log restart requirements. A disabled/skipped adapter is not created on reload. Restart. |

Telegram authorization/rendering settings reload on the connected adapter. Its bot identity/username
is established on connection; reconnect/restart when changing that identity. Native deployment
settings instead belong to the database after their first import; see the final section.
Evidence: [`create-core-runtime.ts`](../apps/core/src/runtime/create-core-runtime.ts),
[`telegram-adapter.ts`](../apps/core/src/surface/telegram/telegram-adapter.ts), and
[`native/runtime.ts`](../apps/core/src/surface/native/runtime.ts).

## Retired batch configuration

The `batch` tool and expansion API are removed. Remove `batch` from explicit profile tool lists and
remove maintained `tools.batch.maxCalls` settings. That setting is still accepted and defaulted in
the universal shape solely for compatibility; it has no execution effect. Plugin `supportsBatch` and
`editTargets` are also inert compatibility fields. Ordinary tool calls run concurrently in groups
separated by mutation barriers; Bash calls may race. See
[`MIGRATIONS.md#batch-retirement`](../MIGRATIONS.md#batch-retirement).

## Web, tool output, and plugin policies

`tools.fsBackend` selects `fff` (v2 default, including `fuzzy_search`) or `node-rg` (without
`fuzzy_search`). New Level-1 toolsets use the current config; startup-only fff prewarming is not rerun
on reload. See [`builtin/local-tools.ts`](../apps/core/src/plugins/builtin/local-tools.ts) and
[`plugins/manager.ts`](../apps/core/src/plugins/manager.ts). `tools.web.extract.providers` is one ordered,
nonempty, deduplicated chain for both search and page extraction. Unconfigured providers are skipped.
Search retries the next configured provider on retryable failures; extraction also advances on
fallback-eligible content failures. Abort and terminal failures can end the chain. `openai` is
search-only and is skipped for page extraction.

`tools.web.fetch.mode` defaults to `auto` and can be overridden per call:

- `auto`: direct HTTP, then browser on failed/weak content, then providers for non-HTML content;
  retained browser content can be a final fallback.
- `fetch`: direct HTTP only.
- `browser`: browser only.
- `extract`: provider extraction with browser fallback on failure, except cancellation.
- `provider-only`: provider extraction without HTTP/browser fallback.

`web.extract` uses the provider chain without browser fallback. These modes do not select the search
provider. See [`tools/web.ts`](../apps/core/src/tool-server/tools/web.ts).

`tools.output` limits tool text in the model view and stores overflow as a scoped `resource://`
artifact. Its TTL/quota apply to transient tool-result artifacts, not all managed blobs. If artifact
storage fails, an overflow marker does not recover the full result. `tools.media` limits decoded
binary parts in the model view; oversized or unsupported parts degrade to markers. Telegram ingress
media has separate budgets. `tools.historicalResultPruning` rewrites old tool results in the model
view rather than deleting transcripts: it skips the latest human turn and protected tools, protects
a recent estimated-token budget, and only prunes when eligible output exceeds `minimumTokens`.
Evidence: [`tool-result-output-normalizer.ts`](../packages/tool-results/src/tool-result-output-normalizer.ts)
and [`bus-agent-runner.ts`](../apps/core/src/surface/bridge/bus-agent-runner.ts).

`plugins.disabled` contains built-in/external plugin IDs to suppress. `plugins.config` maps plugin IDs
to opaque plugin-owned payloads. External plugins are discovered in `<DATA_DIR>/plugins`; config
changes reload the tool/plugin manager and are subject to plugin lifecycle and validation. These
fields do not install packages. See [plugin authoring](../PLUGIN_AUTHORING.md) and
[`plugins/manager.ts`](../apps/core/src/plugins/manager.ts).

## Model examples and capabilities

Use one `models.def` mapping with slash-free alias keys and `provider/model` values. `comment` supplies
dynamic subagent selection guidance; `agentCanSelect: true` opts in an alias, without restricting static
profiles, slots, or human overrides. Alias guidance does not become a system-prompt instruction.
Entity comments are different: they do enter the configured-alias prompt overlay alongside alias/ID.
Keep them suitable for agent-visible context. See
[`prompt-overlays.ts`](../apps/core/src/surface/bridge/bus-agent-runner/prompt-overlays.ts).

Runtime provider families are `ai-sdk` and `claude-code`, not upstream vendors. An AI SDK head can
automatically switch between OpenAI, Anthropic, OpenRouter, and other AI SDK providers; it skips
`claude-code` candidates. A `claude-code` head never runs automatic fallback. Explicit selections
between these history families remain possible with lossy text replay. See
[`agent-composition.ts`](../apps/core/src/agent/agent-composition.ts) (`selectNextNativeModelFallback`). Use model options for
the selected provider: Anthropic adaptive thinking has no `budgetTokens`; that option belongs to
enabled thinking (the installed SDK permits omission). Vercel routing preferences belong to `gateway`, while OpenRouter reasoning belongs to
`openrouter.reasoning`. Keep options either flat or a namespace map; do not mix them. Generic
OpenRouter forwards `temperature`, while direct `openai` / `openaiCompatible` option schemas do not
accept it here. Model acceptance, credentials and upstream option support still need to be verified
for your endpoint. Keep the active `basePrompt` once; Codex uses it as Responses instructions
when `codex_instructions` is absent, and other providers prepend it to prompt files.

`models.capability.forceUnknownProviders` suppresses registry lookup, not explicit overrides or
provider calls. Explicit overrides can inherit from a resolvable model even for a forced-unknown
provider. Without `inherit`, Core does not implicitly merge a models.dev base: resolution needs
`limit.context`; a cost patch needs both `input` and `output`; a modalities patch needs `input`.
The v2 parser already enforces these requirements for manual overrides. Missing output limit becomes
`0`, and omitted costs/attachment/modalities remain unknown. Self-inheritance creates an override
cycle. Inherited partial patches can parse and still fail resolution when their base is unavailable.
Use `inherit` for partial patches and verify the inheritance target. Costs
are USD per million tokens. See [`model-capability.ts`](../packages/utils/model-capability.ts).

Heartbeat's default output accepts only `discord/<channel ID or alias>` or
`github/OWNER/REPO#NUMBER`, for example `github/DF-wu/lilac-mono#123`. Native/Telegram destinations are
not accepted by this field. The GitHub thread and adapter access must exist; parsing the prefix alone
is not an access check. See [heartbeat schema](../packages/utils/core-config/v1.ts) and
[`github-ids.ts`](../apps/core/src/github/github-ids.ts).

## Native web port

The native web listener now defaults to `8789`, reserving `8787` for the GitHub webhook and `8788`
for the container-local operator console. Version-2 defaults for `surface.native.publicUrl` and
`allowedOrigins` now use `http://localhost:8789`. Configs with native disabled stay disabled.

Explicit port, URL and origin values are preserved. To move an existing deployment, change
`surface.native.port` and the container side of its Compose port mapping together. If the browser's
public URL changes, also update `publicUrl`, `allowedOrigins` and any reverse-proxy destination.
The installer preserves existing deployment port mappings. No config-version bump is required.

## Decision auto-inject lane

Version 2 uses `conversation.thread.autoInjectMode: decision` and
`conversation.thread.decisionAutoInject`. Rename the old `jev` mode and `jevAutoInject` section.
Existing version-2 Jev settings still parse into the new runtime fields without changing thresholds.
If both sections exist, `decisionAutoInject` takes precedence. No config-version bump is required.

The decision lane uses a local shortlist and one call to judge whether past context helps and which
threads to inject. The `llm` lane remains the default. `autoInject.enabled` and
`filterCurrentParticipants` still apply to both lanes.

`decisionAutoInject.model` is an ordered, nonempty array. Configure
`[typesafe/jev-1.13.0, openai/gpt-6-luna]` to use Jev for text and Luna for image attachments.
Text selects the first entry. A supported image in the latest user message selects the first
image-capable entry; if none is configured, the first entry evaluates text only. PDFs alone do not
select Luna. This is routing, not a retry or failure fallback chain. Only the selected model needs
credentials. A single string and bare Jev model IDs remain supported as legacy input. TypeSafe uses `TYPESAFE_AI_API_KEY` and optional `TYPESAFE_AI_BASE_URL`; OpenAI uses
`OPENAI_API_KEY` and optional `OPENAI_BASE_URL`. The endpoint must support `/v1/decisions`.
Missing credentials and evaluation failures continue without injected metadata. A refused question
counts as "no" for that question. A zero recall threshold disables message gating.

OpenAI receives attached images as native inline image parts, independently of the primary agent's
image support. Jev evaluates text only. Shortlisting uses the latest authored text and up to three recent authored user messages; image-only
messages do not run automatic recall. Image preparation uses existing scoped resource access and inline
media limits. Images are kept in memory. No transcript or database migration is needed.

`decisionAutoInject` retains shared `limit`, `candidateLimit`, and `semanticFallback`. The four
probability thresholds now live under `decisionAutoInject.jev` and `decisionAutoInject.luna`.
TypeSafe Jev IDs use the `jev` scope; OpenAI Luna IDs use `luna`. Each scope has independent defaults.
Legacy flat thresholds apply to both scopes, and explicit scoped fields override them individually.
The default model list contains Jev only. Both recall thresholds default to zero, and relevance
thresholds default to 0.2 for Jev and 0.1 for Luna. The default candidate budget is 40. With
`semanticFallback: true`, lexical and semantic retrieval share that budget even when lexical matches
exist. Set it to false for lexical-only retrieval. Explicit configured values retain precedence.

## Native title model

Version 2 accepts `surface.native.titleModel`, defaulting to `fast`. Use `main`, `fast`, a configured
model alias, or an explicit `provider/model` reference. New native conversations keep their immediate
first-line fallback while this model generates a title without tools. An ambiguous initial title may
be refined once using the first user input and final assistant reply. Manual titles always win, and
model failures retain the current title. Existing conversations are not renamed.

The YAML field is now a legacy initial-import value only. Existing native deployment records use
Settings > Deployment, so editing YAML will not change their title model. No config rewrite is required.
Remove the field before using a parser that predates it.

## Image routes

`tools.generate.image.openaiCompatible` is replaced by two fields next to `provider`:
`tools.generate.image.models` (the alias allowlist, formerly `openaiCompatible.models`) and
`tools.generate.image.routes`, a map from alias to `<provider>/<model id>`. A former
`openaiCompatible.modelIds` entry becomes `routes.<alias>: openai-compatible/<model id>`. Routes also
accept `openai`, `openrouter`, and `xai`, so one alias can leave the compatible endpoint while the rest
follow `provider`. Configs that still contain `openaiCompatible` fail to parse with a message that names
the replacement; no config version bump is required. Older builds do not reject `models` and `routes` at
this level: they log them as unknown keys and ignore them while keeping `provider`, so a downgrade with
`provider: openai-compatible` silently advertises every alias with its canonical model ID. Move the fields
back under `openaiCompatible` before starting an older build.

## Image table style

Table rendering now accepts `style: image`. The default remains `unicode`, so existing configurations
keep their text rendering. In v2, set `surface.discord.markdownTableRender.enabled: true` and
`surface.discord.markdownTableRender.style: image`, with `outputMode: preview`,
`outputPreviewModeFinalStyle: plain`, and `outputPreviewModeFinalText: flat`, to send top-level tables as
PNG attachments. The image style falls back to Unicode text in other modes and on rendering failure.

The v1 parser also accepts `image` under `surface.discord.experimental.markdownTableRender.style`, but
v1's reply-chain output uses the Unicode fallback. No config version bump or automatic rewrite is
required. Older builds reject `image`; change the style to `unicode` or `ascii` before downgrading.

## v1

`configVersion: 1` is the initial versioned config contract and matches the defaults used before config
versioning was introduced.

To make an existing implicit v1 config explicit, add:

```yaml
configVersion: 1
```

No field migrations are required for v1.

## v2

`configVersion: 2` uses the universal runtime config field names directly and changes several defaults.

Field renames from v1:

- `tools.experimental_hashline_edit` -> `tools.editFile.hashline`
- `surface.discord.previewFinalOutputStyle` -> `surface.discord.outputPreviewModeFinalStyle`
- `surface.discord.experimental.markdownTableRender` -> `surface.discord.markdownTableRender`

Removed v2 fields:

- `agent.subagents.idleTimeoutMs`; subagent idle timeouts are derived from `agent.idleTimeoutMs` as
  `floor(2/3)`, with a `1000ms` minimum.
- `agent.subagents.defaultTimeoutMs` and `agent.subagents.maxTimeoutMs`; frozen v1 configs may still
  contain these legacy fields, but they are ignored during universal parsing.
- `surface.heartbeat.every`; both current versioned parsers reject it with migration guidance. Replace
  it with a five-field `surface.heartbeat.cron` expression before restarting.

New v2 fields:

- `surface.discord.outputPreviewModeFinalText`: final plain-text grouping after a preview. `flat`
  replies with the first final-answer chunk and sends later chunks directly; `reply-chain` preserves
  the v1 commentary-plus-final reply chain. It applies only when `outputMode: preview` and
  `outputPreviewModeFinalStyle: plain`. The v2 default is `flat`; frozen v1 configs use `reply-chain`.
- `agent.transcriptRetention.maxAge` and `.maxRequests`: completed request transcript retention limits;
  defaults to `180d` and `10000`. Each accepts a positive duration/count or `"unlimited"`. Changes are
  hot-reloaded and apply on the next transcript save. Frozen v1 configs receive the same universal
  defaults but cannot override them.
- `surface.discord.attachmentCache.ttl`: Discord ingress attachment cache lifetime; defaults to `30d`
  and accepts a positive duration or `"unlimited"`. Changes are hot-reloaded. Frozen v1 configs receive
  the same universal default but cannot override it.
- `blobStorage`: one Core managed-blob adapter. Omit it for the local store rooted below `DATA_DIR`, or
  configure `kind: local` with a required absolute `root`, or `kind: s3` with required `bucket`,
  `prefix`, `endpoint`, `region`, and environment-variable names for credentials. S3 also accepts an
  optional session-token environment-variable name and optional path-style addressing. Frozen v1
  configs receive the same universal local default but cannot set this field.
- `workflows.maxActiveRuns`: principal-blind global admission cap across all nonterminal workflow runs,
  including scheduled and generated subagent runs; defaults to `64`. Frozen v1 configs receive the same
  universal fallback but cannot override it.
- `agent.idleTimeoutMs`: primary agent inactivity timeout; defaults to `900000` (15 minutes). Active runs
  have no total runtime cap. Frozen v1 configs receive the same universal fallback but cannot override it.
- `tools.inspect.model`: configurable Gemini model for `content.inspect`; must start with `google/`.
- `tools.generate.image.provider`: the route for aliases without an explicit route, either the
  built-in provider preference (`default`) or the `openai-compatible` endpoint. The optional
  `tools.generate.image.models` allowlist limits the aliases advertised and considered for routing,
  and `tools.generate.image.routes` maps an alias to `<provider>/<model id>` (`openai`, `openrouter`,
  `xai`, or `openai-compatible`). Frozen v1 configs cannot configure these fields and receive
  `provider: default` with an empty `routes` map in the universal config.
- `tools.web.firecrawl`: optional process-local concurrency policy applied independently to Firecrawl
  fetch and search calls. When present, `maxConcurrency` defaults to `2` and `queueTtl` defaults to `3s`;
  when absent, Firecrawl calls remain unlimited.
- `tools.web.extract.providers` accepts `openai` in v2: `web.search` then runs the OpenAI Responses
  `web_search` tool with `OPENAI_API_KEY` (and `OPENAI_BASE_URL` when set) and returns the answer's URL
  citations followed by uncited retrieved sources. It is search-only; `web.extract` skips it and uses the
  next configured provider. `tools.web.openai.model` (default `openai/gpt-5-mini`) and
  `tools.web.openai.searchContextSize` (`low` | `medium` | `high`, default `medium`) tune the call.
  `model` is a `provider/model` spec: an `openai/...` model uses `OPENAI_API_KEY` / `OPENAI_BASE_URL`,
  an `openai-compatible/...` model uses `OPENAI_COMPATIBLE_API_KEY` / `OPENAI_COMPATIBLE_BASE_URL`,
  and any other provider leaves the `openai` provider unconfigured with a logged error. A bare model
  id from an existing config means `openai/<id>`. Set `model` to one your endpoint serves when the
  base URL points at a gateway. [`web-search-openai.md`](./web-search-openai.md) documents the full
  request and result contract. Cited URLs lose
  the `utm_source=openai` tag; cited `content` is explicitly labeled as an OpenAI-generated summary,
  not a page excerpt, and may combine cited sources. Date constraints are model instructions, not
  enforced publication-date filters.
  Frozen v1 configs cannot select this provider.
- `models.capability.overrides.<provider/model>.attachment`: optional manual override for model attachment
  input support.
- `conversation.thread.summarization.enabled`: default-false gate for background conversation thread
  summarization.
- `conversation.thread.summarization.model`: model used for conversation thread summaries; defaults to
  `fast`.
- `conversation.thread.summarization.concurrency`: number of threads to summarize concurrently inside one
  run; defaults to `1`.
- `conversation.thread.summarization.batchSize`: maximum threads processed by one periodic run; defaults
  to `32`. Manual runs remain unbounded unless they provide a limit. Frozen v1 configs receive the same
  universal fallback but cannot override it.
- `conversation.thread.summarization.includePromptContext`: default-false option to include `MEMORY.md`,
  `USER.md`, and optional `ENTITIES.md` as background-only summarization context.
- `conversation.thread.embedding.enabled` and `conversation.thread.embedding.model`: default-false
  semantic thread embedding generation using an AI SDK embedding model ref.
- `conversation.thread.autoInject.enabled`: default-false gate for request-time conversation thread
  metadata injection.
- `conversation.thread.autoInject.plannerModel`: optional model used for request-time auto-inject query
  planning; when unset, it inherits `conversation.thread.summarization.model`.
- `conversation.thread.autoInject.textPlannerModel`: optional model used instead of `plannerModel` when
  the composed request input contains only text. Image, PDF, and other non-text input continues to use
  `plannerModel`; when unset, all requests retain the existing planner selection.
- `conversation.thread.autoInject.minTextUnits`: minimum authored text mass before auto-injecting
  conversation thread metadata; defaults to `80`.
- `conversation.thread.autoInject.followUpMinTextUnits`: higher text-mass threshold after prior
  auto-injected thread metadata exists in the same conversation; defaults to `110`.
- `conversation.thread.autoInject.limit`: maximum injected search results; defaults to `3`.
- `conversation.thread.autoInject.minScore`: minimum final `conversation.thread.search` score for
  auto-injected metadata; defaults to `0.1`.
- `conversation.thread.autoInject.expansionMinConfidence`: minimum ranking confidence for optional
  auto-injected results after the single recall-floor result; accepts `0` through `1` and defaults to
  `0.57`. Frozen v1 configs receive the same universal default but cannot override it.
- `conversation.thread.autoInject.mode`: search mode (`hybrid`, `semantic`, or `lexical`); defaults to
  `hybrid`.
- `conversation.thread.autoInject.filterCurrentParticipants`: defaults to `false`; applies to both
  `llm` and `decision` lanes. With recovered participant IDs, Discord/Telegram origins recall
  same-platform threads involving any recovered participant plus Native threads, excluding the other
  messaging platform. Native origins and requests without recovered IDs continue without a participant
  filter, subject to normal candidate eligibility.
- `tools.output`: direct-result preview and transient artifact policy. Defaults to `40KiB`, `7d`, and
  `50MiB` per session.
- `tools.historicalResultPruning`: compatibility policy for rewriting old tool results. It defaults to
  disabled with the prior `40000`/`20000` token thresholds retained when enabled.
- `tools.media`: model-view inline binary limits. Defaults to `10MiB` per part and `20MiB` in total.
- `agent.retry`: transient upstream and replay-safe primary idle-timeout retry policy. Frozen v1 configs
  cannot configure it; the version-specific defaults are listed below.
- `agent.subagents.delegatePromptOverlay`: optional free-form guidance appended to the parent-visible
  `subagent_delegate` tool description.
- `agent.subagents.profiles.<profile>.reasoning` and `.fallback`: optional portable reasoning and ordered
  model fallback policy. A profile fallback takes precedence over the selected model slot or alias
  fallback.
- `agent.subagents.profiles.<profile>.level1`, `.level2`, `.network`, `.workspaceWrites`, `.execution`, and
  `.delegation`: native profile authority and behavior fields. Frozen v1 profiles cannot configure these
  fields and receive their historical built-in universal profiles.
- `models.def.<alias>.reasoning` and `.fallback`, `models.main.reasoning` and `.fallback`, and
  `models.fast.reasoning` and `.fallback`: portable reasoning plus flat ordered fallback chains. Entries
  are a model/alias string or an object with `model` and optional `reasoning`/`options`; v1 cannot configure
  fallback or portable reasoning.
- `models.def.<alias>.comment`: optional guidance shown when an agent selects a model for a subagent.
- `models.def.<alias>.agentCanSelect`: explicitly opts an alias into dynamic selection through
  `subagent_delegate`; defaults to `false`. It does not restrict static profiles, model slots, or explicit
  human overrides.
- `surface.discord.markdownMathRender`: Discord markdown math rendering policy. Defaults to
  `{ enabled: false, maxWidth: 50, fallbackMode: source }`; frozen v1 configs receive this disabled
  universal fallback but cannot configure it.
- `surface.telegram`: opt-in Telegram surface; `enabled` defaults to `false`, and the adapter is
  constructed only when it is `true` and `token` is set (otherwise startup logs a warning and skips the
  surface). `token` holds the Bot API token; a `tokenEnv` key is rejected with migration guidance, so
  copy the secret to `token`. `botName` defaults to `lilac` and must not contain
  spaces; `botUsername` is optional, must omit the leading `@`, and is resolved from `getMe` when unset.
  `allowedChatIds` fails closed when empty and `allowedUserIds` is an optional second gate; both hold
  string ids. `dbPath` and `apiRoot` (a full URL; the runtime defaults to `https://api.telegram.org`)
  are optional. `outputMode` (`inline` | `preview`, default `preview`), `parseMode` (`html` | `plain`,
  default `html`), `streamEditIntervalMs` (`500` through `60000`, default `1500`), `outputNotification`
  (default `true`), `workingIndicators` (at least one entry), `commandMenu` (default `true`), and
  `markdownTableRender` (`unicode` | `ascii` only, otherwise the Discord defaults) complete the surface.
  Frozen v1 configs receive the disabled universal fallback but cannot configure any of these fields.
- `surface.telegram.inboundMedia`: inbound photo and document delivery to the model. Defaults to
  `{ enabled: true, maxBytesPerAttachment: 5MiB, maxBytesPerRequest: 10MiB }`; the byte-size fields accept
  the suffixes listed below, and oversized media degrades to a metadata marker.

Local example:

```yaml
configVersion: 2
blobStorage:
  kind: local
  root: /var/lib/lilac/blobs
```

S3-compatible example:

```yaml
configVersion: 2
blobStorage:
  kind: s3
  bucket: lilac
  prefix: production/blobs
  endpoint: https://s3.example.com
  region: us-east-1
  accessKeyIdEnv: LILAC_S3_ACCESS_KEY_ID
  secretAccessKeyEnv: LILAC_S3_SECRET_ACCESS_KEY
  # sessionTokenEnv: LILAC_S3_SESSION_TOKEN
  # forcePathStyle: true
```

The bucket must already exist. Core does not create it or manage its lifecycle policy. Credentials are
read only from the named environment variables. To move an existing Core data set between local and S3,
stop Core, copy the whole blob store while preserving object IDs, verify all durable references, and
switch config only after verification, then restart Core. Reload does not replace the active adapter.
The persisted-data cutover is documented in
[`MIGRATIONS.md`](../MIGRATIONS.md#core-unified-blob-storage-clean-break).

Changed v2 fields:

- `agent.subagents.profiles.<profile>.execution` is `false | "restricted" | "native"`. `false` omits Bash,
  `restricted` exposes the virtual restricted Bash implementation, and `native` exposes trusted host Bash
  unless the surface is restricted. This intentionally replaces the earlier v2 boolean contract: change
  `true` to `native`; `false` remains valid.
- For a normal profile/slot selection, fallback precedence is profile, model slot, then the alias selected
  by that slot; an explicitly present empty chain suppresses lower-precedence inheritance. An explicit
  alias request override uses that alias's chain, while an explicit `provider/model` override has no
  fallback chain.
- Automatic model fallback exhausts each candidate's retry budget before moving on, can switch upstream
  vendors within `ai-sdk`, skips `claude-code` candidates, and is disabled for a `claude-code` head. There is no global fallback enable
  flag or switch cap. v2 model aliases must not contain `/`, and each `models.def.<alias>.model` must use
  `provider/model` format.

The field-specific unit table above lists accepted suffixes and exceptions. New v2 tool-output/media
and retention fields cannot be configured in frozen v1 input, which receives universal fallbacks;
existing v1 web/router/heartbeat configuration is still supported by its own schema.

Default changes from v1:

- `tools.fsBackend: fff`
- `tools.editFile.hashline: true`
- `tools.inspect.model: google/gemini-3.5-flash` (`configVersion: 1` always uses
  `google/gemini-3-flash`)
- `surface.discord.outputMode: preview`
- `surface.discord.outputPreviewModeFinalStyle: plain`
- `surface.discord.outputPreviewModeFinalText: flat`
- `surface.discord.outputNotification: true`
- `surface.discord.markdownTableRender: { enabled: true, style: unicode, maxWidth: 50, fallbackMode: list }`
- `agent.reasoningDisplay: detailed`
- `agent.retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 30000 }`; v1 universal
  parsing uses `{ enabled: false, maxRetries: 0, baseDelayMs: 2000, maxDelayMs: 30000 }`.
- Subagent idle timeouts derive from the primary agent timeout as `floor(2/3)`, with a `1000ms` minimum.
  This produces `600000` for the default `900000ms` primary timeout. Frozen v1 legacy timeout fields are
  ignored.
- The built-in `explore` profile includes restricted Bash; `general` and `self` use native Bash. Frozen v1
  profiles retain their historical no-Bash explore and native-Bash general/self behavior.

## Native deployment settings move to the database

Native startup imports `surface.native.titleModel`, `outputStreaming`,
`oldMessageSelectionMaxAgeMs`, `storageRetentionMaxAgeMs`, and `crossThreadSend` once into
the native database. After that, use Settings > Deployment. The old YAML keys are accepted
only as initial import values and may be removed after startup; they do not override database
settings, even after a restart. The import preserves the YAML file, including comments. The age fields
accept positive friendly durations or `null` (no limit); `outputStreaming` is `paragraph` or `complete`,
and `crossThreadSend.triggerRun` defaults to `true`. Listener/authentication settings remain in YAML
and require restart, as described above. See
[`MIGRATIONS.md`](../MIGRATIONS.md#native-deployment-settings).
