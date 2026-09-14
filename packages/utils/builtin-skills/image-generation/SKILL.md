---
name: image-generation
description: Generate or edit images with generate.image using the fork's structured model aliases and optional OpenAI-compatible routing.
---

# Image generation

Use `tools --help generate.image` to inspect the available model aliases. The tool accepts structured
arguments for prompts, model selection, dimensions, reference images, masks, and the output directory.

## Model aliases

When the user does not choose a model, let the tool use its configured fallback order. Common aliases
include `gpt-image-2`, `gpt-5-image`, `nanobanana-2`, `nanobanana-pro`, and
`grok-imagine-image`. The live tool catalog is authoritative because operators can restrict aliases.

## Execute

Call the tool with a prompt and optional structured fields:

```json
{
  "prompt": "A precise product photograph on a neutral background",
  "model": "gpt-image-2",
  "aspectRatio": "1:1",
  "outputDir": "/tmp/images"
}
```

Use `inputImages` for edits or variations and `maskImage` for inpainting. `maskImage` requires at least
one input image. Use only one of `size` or `aspectRatio`. The tool chooses a fresh output filename and
returns its path, MIME type, model, warnings, and provider metadata.

With `tools.generate.image.provider: openai-compatible`, every enabled alias routes only through the
configured compatible endpoint. There is no official-provider fallback or automatic retry. Inspect the
saved image before attaching it, and do not blindly repeat a paid request after an uncertain outcome.
