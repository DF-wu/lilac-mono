# OpenAI-Compatible Image Generation

Lilac can route the existing `generate.image` model aliases through one
OpenAI-compatible provider. This changes the request destination only. Existing
aliases, input validation, image editing behavior, and output handling remain
unchanged.

## Requirements

The provider must implement the OpenAI-compatible image endpoints:

- `POST /images/generations` for image generation
- `POST /images/edits` for image editing and masks

The configured base URL is prepended to those paths. For example, a base URL of
`https://provider.example.com/v1` results in requests to
`https://provider.example.com/v1/images/generations`.

The provider must accept the model IDs Lilac sends. By default these are the
canonical model IDs listed in [Model aliases](#model-aliases); use
`openaiCompatible.modelIds` to override the ID sent for individual aliases.

## Configuration

Image routing requires a v2 `core-config.yaml` and two existing environment
variables.

Set the provider in `$DATA_DIR/core-config.yaml`. `DATA_DIR` defaults to the
repository's `data/` directory.

```yaml
configVersion: 2

tools:
  generate:
    image:
      provider: openai-compatible
```

An optional `openaiCompatible` sub-object (v2-only, meaningful only when
`provider` is `openai-compatible`) restricts the served aliases and overrides
upstream model IDs:

```yaml
tools:
  generate:
    image:
      provider: openai-compatible
      openaiCompatible:
        # Optional allowlist of Lilac aliases the endpoint serves.
        # Omitted = all aliases.
        models: [nanobanana-2, gpt-image-2]
        # Optional per-alias upstream model-ID overrides.
        modelIds:
          nanobanana-2: gemini-3.1-flash-image-preview
```

Set the endpoint and API key in the environment of the core runtime or
standalone tool bridge:

```dotenv
OPENAI_COMPATIBLE_BASE_URL=https://provider.example.com/v1
OPENAI_COMPATIBLE_API_KEY=replace-with-your-api-key
```

The API key is sent as an `Authorization: Bearer` header. The endpoint is an
operator-controlled trust boundary: image prompts, source images, and masks are
sent to it when `generate.image` is called.

Restart the runtime or standalone tool bridge after changing environment
variables.

## Model aliases

Callers continue to use Lilac's existing aliases. In OpenAI-compatible mode,
Lilac sends the corresponding canonical model ID to the provider by default.

| Lilac alias | Default model ID sent upstream |
| --- | --- |
| `gpt-image-2` | `gpt-image-2` |
| `gpt-5-image` | `gpt-image-1.5` |
| `nanobanana` | `google/gemini-2.5-flash-image` |
| `nanobanana-2` | `google/gemini-3.1-flash-image-preview` |
| `nanobanana-2-lite` | `google/gemini-3.1-flash-lite-image` |
| `nanobanana-pro` | `google/gemini-3-pro-image-preview` |
| `grok-imagine-image` | `grok-imagine-image` |
| `grok-imagine-image-pro` | `grok-imagine-image-pro` |

`openaiCompatible.modelIds` overrides the upstream model ID per alias. For
example, `modelIds: { nanobanana-2: gemini-3.1-flash-image-preview }` sends
`gemini-3.1-flash-image-preview` (without the `google/` prefix) whenever a
caller selects `nanobanana-2`. Aliases without an override keep the default
from the table. Unknown alias keys are rejected at config parse time.

`openaiCompatible.models` declares which aliases the endpoint actually serves.
When present, the tool catalog advertises only those aliases, the default
fallback picks only among them, and requesting any other alias fails before an
HTTP request is sent. When omitted, all aliases are advertised and served.

All served aliases route through the same configured endpoint. Routing cannot
be split across endpoints per alias.

## Start the standalone tool server

Build and start the standalone tool bridge:

```bash
cd apps/tool-bridge
bun run build
bun index.ts
```

In another terminal, list the available tools and aliases:

```bash
./apps/tool-bridge/dist/index.js --list
```

Use `TOOL_SERVER_BACKEND_URL` when the bridge listens on a non-default address:

```bash
TOOL_SERVER_BACKEND_URL=http://127.0.0.1:42069 \
  ./apps/tool-bridge/dist/index.js --list
```

## Generate an image

```bash
./apps/tool-bridge/dist/index.js generate.image \
  --prompt="A rainy Taipei street at night" \
  --model=gpt-5-image \
  --size=1024x1024 \
  --output-dir=./output \
  --output=json
```

The command writes the generated image to the output directory and returns its
path, byte count, MIME type, requested Lilac alias, and provider warnings.

Alias-specific validation still applies. For example, unsupported GPT image
sizes and unsupported Grok mask combinations are rejected before an HTTP
request is sent.

## Edit an image

For structured inputs such as source images and masks, use a JSON input file:

```json
{
  "prompt": "Replace the background with a mountain lake",
  "model": "gpt-5-image",
  "inputImages": ["./input.png"],
  "maskImage": "./mask.png",
  "outputDir": "./output"
}
```

Run it with:

```bash
./apps/tool-bridge/dist/index.js generate.image --input=@edit-image.json --output=json
```

Lilac sends edits as multipart requests to `/images/edits`. The provider must
support the selected model and edit operation.

## Default routing

To restore the built-in provider-aware routing, set:

```yaml
tools:
  generate:
    image:
      provider: default
```

Omitting the field also defaults to `default`. In that mode, Lilac uses its
existing OpenAI, OpenRouter, and xAI provider selection behavior.

## Errors and fallback behavior

- If `provider` is `openai-compatible` but
  `OPENAI_COMPATIBLE_BASE_URL` is missing, tool discovery remains available,
  but an actual `generate.image` call fails before sending an HTTP request.
- Provider HTTP errors and malformed responses are returned to the caller.
- Lilac sends one generation attempt and does not retry through an official
  provider.
- Lilac does not automatically fall back to OpenAI, OpenRouter, or xAI after
  OpenAI-compatible routing is selected.
- `generate.video` remains independent of this image-provider setting.

## Aspect ratio forwarding

The OpenAI-compatible image API has no dedicated aspect-ratio parameter. For
the ratio-driven aliases (`nanobanana*` and `grok-imagine-image*`), Lilac
validates `aspectRatio` against the alias and then forwards it as a colon-form
`size` value on the wire, e.g. `"size": "16:9"`. No `unsupported: aspectRatio`
warning is produced.

How gateways handle the colon-form `size`:

- new-api maps a `size` containing a colon to Gemini's `aspectRatio` for
  Gemini image models, so `nanobanana*` aliases produce the requested ratio.
- xAI's image API has no size parameter, so grok-via-gateway ignores the value
  and `grok-imagine-image*` behaves as it does today.
- Gateways that reject non-WxH `size` values fail loudly with a provider
  error rather than silently producing the wrong ratio.

For `gpt-image-2` and `gpt-5-image`, Lilac converts `aspectRatio` into an
equivalent WxH `size` before the request, exactly as in `default` mode, so
those aliases never send a colon-form `size`.

## Troubleshooting

### The provider returns model-not-found

Confirm that the provider recognizes the model ID Lilac sends: the canonical
ID from the alias table, or the `openaiCompatible.modelIds` override when one
is configured. If the provider expects a different ID for an alias (for
example `gemini-3.1-flash-image-preview` without the `google/` prefix), map it
with `openaiCompatible.modelIds`. If the provider serves only some aliases,
list them in `openaiCompatible.models` so unavailable aliases are not
advertised or selected.

### The request returns 404

Check whether the base URL includes the provider's API version prefix, usually
`/v1`. Lilac appends `/images/generations` or `/images/edits` to the configured
base URL.

### Image generation is not using the third-party endpoint

Confirm all of the following:

1. `core-config.yaml` has `configVersion: 2`.
2. `tools.generate.image.provider` is `openai-compatible`.
3. The runtime process received `OPENAI_COMPATIBLE_BASE_URL` and
   `OPENAI_COMPATIBLE_API_KEY`.
4. The runtime was restarted after changing its environment.

### Image generation fails but video generation still appears

This is expected when the OpenAI-compatible image endpoint is missing or
invalid. Image-provider configuration does not control `generate.video`.
