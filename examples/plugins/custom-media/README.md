# Custom Media Level 2 Plugin

This is a production-oriented external Level 2 plugin example. It registers
`custom-media.image` and `custom-media.video` without importing Lilac's private core runtime.
The committed `dist/index.js` bundles its runtime dependencies, so deployment does not require
installing packages.

The plugin uses one explicitly configured OpenAI-compatible endpoint. It never falls back to a
second provider or model. Image calls use AI SDK `createOpenAICompatible` and `generateImage` with
`maxRetries: 0`. Video calls use QuantumNous/new-api's OpenAI-compatible `POST /v1/videos`,
`GET /v1/videos/:id`, and `GET /v1/videos/:id/content` flow.

## Install

Build from source when changing the example:

```bash
cd examples/plugins/custom-media
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run build
```

Deploy the directory under the exact plugin id expected by `meta.id`:

```bash
mkdir -p "$DATA_DIR/plugins"
cp -R examples/plugins/custom-media "$DATA_DIR/plugins/custom-media"
```

Only `package.json` and `dist/index.js` are required in the deployed copy. Keep `src`, `tests`, and
the lockfile when developing the plugin.

## Credentials And Config

Credentials are read from environment variables. By default:

```bash
export OPENAI_COMPATIBLE_BASE_URL="https://new-api.example.com/v1"
export OPENAI_COMPATIBLE_API_KEY="..."
```

The base URL may omit `/v1`; the plugin adds it. URLs containing user-info, query parameters, or
fragments are rejected. Plugin config can override only the names of the environment variables:

```yaml
plugins:
  disabled: []
  config:
    custom-media:
      baseUrlEnv: CUSTOM_MEDIA_BASE_URL
      apiKeyEnv: CUSTOM_MEDIA_API_KEY
```

Literal `apiKey`, `baseURL`, or other credential-bearing config keys are rejected by the strict
schema. To expose these callables to a subagent profile, include both the plugin and callable IDs:

```yaml
agent:
  subagents:
    profiles:
      general:
        level2:
          plugins: [custom-media]
          callables: [custom-media.image, custom-media.video]
        network: true
```

Lilac checks external plugin freshness before Level 2 list and call handling. Verify discovery after
deployment or config changes:

```bash
tools --list
tools --help custom-media.image
```

## Models

Aliases and upstream routes are deliberately kept in `src/models.ts`, outside core:

| Alias | Route | Modality |
| --- | --- | --- |
| `gpt-image-2` | `gpt-image-2` | image |
| `gpt-5-image` | `gpt-image-1.5` | image |
| `nanobanana` | `google/gemini-2.5-flash-image` | image |
| `nanobanana-2` | `google/gemini-3.1-flash-image-preview` | image |
| `nanobanana-2-lite` | `google/gemini-3.1-flash-lite-image` | image |
| `nanobanana-pro` | `google/gemini-3-pro-image-preview` | image |
| `grok-imagine-image` | `grok-imagine-image` | image |
| `grok-imagine-image-pro` | `grok-imagine-image-pro` | image |
| `grok-imagine-video` | `grok-imagine-video` | video |

Each alias has a capability profile. Unsupported sizes, aspect ratios, masks, image counts, and
durations fail before any HTTP request. Omitting `model` chooses the documented default alias only;
it does not try fallback models.

## Calls

Generate an image:

```bash
tools custom-media.image prompt="A quiet harbor at dawn" model=gpt-image-2 aspectRatio=3:2 outputDir=./media
```

Edit an image:

```bash
tools custom-media.image prompt="Replace the sky with soft morning light" model=gpt-5-image inputImages=./input.png outputDir=./media
```

Generate a video, optionally from a local image:

```bash
tools custom-media.video prompt="A slow cinematic camera move" model=grok-imagine-video inputImage=./frame.png path=./media/clip.mp4 seconds=5 size=1280x720
```

`custom-media.video` defaults to a 10-minute operation timeout and a 256 MiB download bound. Both
can be lowered per call with `timeoutMs` and `maxDownloadBytes`; the hard schema maxima are 30
minutes and 512 MiB.

## File Safety

Local inputs are checked by file signature and bounded to 20 MiB per image. Outputs use mode `0600`
and exclusive creation; an existing filename produces `name (1).ext` instead of being overwritten.
Partial video downloads are removed on cancellation, provider failure, or size-limit failure.

In restricted public-session mode, virtual `/tmp` paths map exactly like core:

```text
/tmp/lilac-restricted/<sha256(sessionId).slice(0, 32)>
```

The tool returns virtual `/tmp/...` paths to the caller. Paths outside `/tmp`, missing session ids,
and restricted symlinks escaping the session directory are rejected.
