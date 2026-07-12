# generate.image third-party providers

This document describes how Lilac's built-in `generate.image` tool selects image
models, how to point it at a third-party OpenAI-compatible image API, and how
parameter defaults are applied.

## Goals

- Keep the existing built-in aliases (`nanobanana-2`, `gpt-5-image`, ...).
- Allow operators to pin third-party models through config.
- Reuse the AI SDK provider stack instead of inventing a second HTTP image client.
- Fail closed on invalid model specs at config parse time.

## Architecture

```
tools.generate.image config
        │
        ▼
 model resolution  ──►  built-in alias descriptors
        │               or explicit provider/model factories
        ▼
 parameter policy  ──►  global defaults → profile defaults → caller input
        │
        ▼
 model quirks      ──►  e.g. gpt-image-2 size normalization
        │
        ▼
 AI SDK generateImage(providerOptions, size, aspectRatio, ...)
```

Credentials and base URLs remain runtime environment configuration. YAML owns
policy: which models are allowed, which defaults apply, and optional `useWhen`
guidance for agents.

## Environment

| Variable | Required for third-party image | Purpose |
|---|---|---|
| `OPENAI_COMPATIBLE_BASE_URL` | yes | Endpoint root, usually ending in `/v1` |
| `OPENAI_COMPATIBLE_API_KEY` | provider-dependent | Auth header for the compatible API |

An API key alone is not enough. Lilac treats `openai-compatible` as configured
only when `OPENAI_COMPATIBLE_BASE_URL` is non-empty, because there is no safe
default image endpoint.

Official providers continue to use their existing env vars (`OPENAI_*`,
`OPENROUTER_*`, `XAI_*`, Vercel gateway vars, etc.).

## Config (`core-config.yaml`, configVersion 2)

```yaml
configVersion: 2

tools:
  generate:
    image:
      # Empty => built-in alias fallback order.
      # Non-empty => allowlist + default order.
      models:
        - "openai-compatible/gpt-image-2"
        - "openai-compatible/nanobanana"
      defaults:
        size: "1024x1024"
        maxRetries: 2
        options:
          quality: "standard"
      profiles:
        "openai-compatible/gpt-image-2":
          useWhen: "Final high-fidelity product images and text-heavy layouts."
          defaults:
            size: "1024x1024"
            options:
              quality: "high"
```

### Model spec grammar

Accepted values:

1. Built-in aliases:
   `gpt-5-image`, `nanobanana`, `nanobanana-2`, `nanobanana-pro`,
   `grok-imagine-image`, `grok-imagine-image-pro`
2. Explicit provider specs: `<provider>/<model-id>` where provider is one of
   `openai`, `openai-compatible`, `openrouter`, `xai`, `vercel`

Examples:

- `openai-compatible/gpt-image-2`
- `openai-compatible/acme/image-model` (model ids may contain `/`)
- `openrouter/google/gemini-3.1-flash-image-preview`
- `openai/gpt-image-1.5`
- `xai/grok-imagine-image`

Invalid examples rejected at parse time:

- `typo-provider/model`
- `openai-compatible/`
- empty strings

### Parameter precedence

1. `tools.generate.image.defaults`
2. `tools.generate.image.profiles.<model>.defaults`
3. Caller tool input (`size`, `aspectRatio`)
4. Provider / AI SDK defaults for anything still unset
5. Model-specific local normalization (currently `gpt-image-2` size rules)

Use only one of `size` or `aspectRatio`. For OpenAI-compatible gateways, `size`
is usually safer because the AI SDK openai-compatible image adapter forwards
`size` and `providerOptions`; portable `aspectRatio` may not be forwarded.

### Provider options

`options` may be written as:

- shorthand: `{ quality: "high" }` → wrapped under the resolved namespace
- namespaced: `{ openaiCompatible: { quality: "high" } }`
- Vercel alias: `{ vercel: { ... } }` is canonicalized to `{ gateway: { ... } }`

### Seed

Portable `seed` is **not** part of the `generate.image` contract. The pinned
`@ai-sdk/openai-compatible` image adapter does not reliably forward AI SDK
`seed` into `/images/generations` request bodies. Advertising seed would imply
determinism Lilac cannot guarantee. If a gateway needs a seed-like field, put
the provider-native key under `options` after verifying the upstream schema.

## Runtime behavior

### Model selection

1. If the tool call passes `model`, that exact string is used.
   - When `tools.generate.image.models` is non-empty, the requested model must
     appear in the list.
2. If `model` is omitted, Lilac walks configured `models` in order and picks the
   first available model.
3. If `models` is empty, Lilac uses the built-in alias fallback order and still
   allows explicit `provider/model` requests for configured providers.

### Tool discovery

`generate.image` is advertised when at least one default model resolves **or**
an explicit image provider is configured. That means an operator can configure
only `OPENAI_COMPATIBLE_BASE_URL` and still discover the tool; the caller must
then pass `model=openai-compatible/<id>` unless defaults are listed.

`Default models: none` in help output is therefore not always a misconfiguration.
Check `Explicit model specs` as well.

### gpt-image-2 normalization

For model ids ending in `gpt-image-2`:

- sides must be positive and ≤ 4096
- dimensions are rounded to 16-pixel multiples
- total pixels are clamped to the provider limit without unbounded loops
- `aspectRatio` is converted to a concrete `size` before the request is sent

Warnings of type `parameter-adjusted` are returned alongside the image result.

## Operator checklist

1. Set `OPENAI_COMPATIBLE_BASE_URL` (and key if required).
2. Set `configVersion: 2`.
3. Add `tools.generate.image.models` entries using valid grammar.
4. Optionally set defaults/profiles for size and provider options.
5. Restart core / tool-bridge so config reloads.
6. Verify:
   - `tools --help generate.image`
   - `tools generate.image --model=openai-compatible/<id> --prompt='...' --output=json`

## Failure modes

| Symptom | Likely cause |
|---|---|
| Config parse error: unsupported image model spec | Typo in provider prefix or alias |
| `Default models: none` and explicit specs also none | Missing provider env or empty config |
| Requested model not listed in tools.generate.image.models | Allowlist is non-empty and call used another model |
| No default image generation model is configured | Provider ready, but models list empty and caller omitted model |
| Provider HTTP 4xx about size/quality | Missing profile defaults such as `size` / `options.quality` |

## Non-goals

- A second raw HTTP image client inside Lilac
- Encoding every third-party gateway's full size matrix in core
- Guaranteeing portable seed determinism across providers

## Related files

- `apps/core/src/tool-server/tools/generate.ts`
- `apps/core/src/plugins/builtin/server-tools.ts`
- `apps/tool-bridge/create-plugin-manager.ts`
- `packages/utils/core-config/{types,v1,v2}.ts`
- `packages/utils/config-templates/core-config.example.yaml`
- `packages/utils/prompt-templates/TOOLS.md`
- `PROJECT.md`, `MIGRATIONS.md`
