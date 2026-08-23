# Core Config Migrations

This guide records manual `core-config.yaml` changes between config versions. The current field-level
reference is
[`packages/utils/config-templates/core-config.example.yaml`](../packages/utils/config-templates/core-config.example.yaml).

Lilac parses `core-config.yaml` through a versioned parser into one universal runtime config shape. The
application consumes only the universal shape.

## Versioning Rules

- New generated configs include `configVersion`.
- Existing configs without `configVersion` are treated as `configVersion: 1`.
- Lilac does not auto-upgrade config files at startup.
- Versioned parsers own defaults for their version.
- New behavior-changing defaults apply only to configs on the version that introduced them.
- If a newer field cannot be represented safely in an older version, that field requires the newer
  `configVersion`.

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
- `tools.web.firecrawl`: optional process-local concurrency policy applied independently to Firecrawl
  fetch and search calls. When present, `maxConcurrency` defaults to `2` and `queueTtl` defaults to `3s`;
  when absent, Firecrawl calls remain unlimited.
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
- `conversation.thread.autoInject.mode`: search mode (`hybrid`, `semantic`, or `lexical`); defaults to
  `hybrid`.
- `conversation.thread.autoInject.filterCurrentParticipants`: optionally restricts search to threads
  involving any current participant; defaults to `false`. If enabled when no current participant identity
  can be recovered, auto-injection is skipped.
- `tools.output`: direct-result preview and transient artifact policy. Defaults to `40KiB`, `7d`, and
  `50MiB` per session.
- `tools.historicalResultPruning`: compatibility policy for rewriting old tool results. It defaults to
  disabled with the prior `40000`/`20000` token thresholds retained when enabled.
- `tools.batch.maxCalls`: maximum calls accepted by one batch; defaults to `8`.
- Batch now expands children into ordinary Level 1 tool calls. Enabled tools are batchable by default;
  plugin authors can set `supportsBatch: false` to opt out.
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
switch config only after verification. The persisted-data cutover is documented in
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
- Automatic model fallback exhausts each candidate's retry budget before moving on, stays within the head
  model's provider family, and is disabled for a `claude-code` head. There is no global fallback enable
  flag or switch cap. v2 model aliases must not contain `/`, and each `models.def.<alias>.model` must use
  `provider/model` format.

Tool byte-size fields accept `B`, `KB`, `MB`, `GB`, `KiB`, `MiB`, and `GiB`. Duration fields accept `ms`,
`s`, `m`, `h`, `d`, `w`, and `mo`; `mo` is a fixed 30 days. These fields cannot be configured in the
frozen v1 input shape, but v1 receives the same universal runtime defaults.

Default changes from v1:

- `tools.fsBackend: fff`
- `tools.editFile.hashline: true`
- `tools.inspect.model: google/gemini-3.5-flash` (`configVersion: 1` always uses
  `google/gemini-3-flash`)
- `surface.discord.outputMode: preview`
- `surface.discord.outputPreviewModeFinalStyle: plain`
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
