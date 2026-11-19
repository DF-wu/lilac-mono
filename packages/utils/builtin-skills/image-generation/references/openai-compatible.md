# OpenAI-compatible endpoint

`providers.openaiCompatible` is the operator's OpenAI-compatible gateway (`OPENAI_COMPATIBLE_BASE_URL`, optional `OPENAI_COMPATIBLE_API_KEY`), such as new-api. It speaks the OpenAI Image API: `POST /images/generations` (JSON) and `POST /images/edits` (multipart). The gateway decides which models exist and how they are named, so list them first unless the user named one. A listed ID is not proof of image support; a model or parameter rejection comes back as the gateway's error. Sources: [image generation](https://developers.openai.com/api/reference/resources/images/methods/generate), [image edits](https://developers.openai.com/api/reference/resources/images/methods/edit).

For an OpenAI GPT Image model behind the gateway, follow the [OpenAI recipe](openai.md) for sizes, quality, and masks. For a Gemini image model behind new-api, pass the aspect ratio as a colon-form `size` such as `"16:9"`; new-api maps it to Gemini's aspect ratio. Other gateways may reject a non-`WxH` size.

## List models

```js
const provider = providers.openaiCompatible;
if (!provider) throw new Error("The OpenAI-compatible endpoint is not configured");
const response = await fetch(`${provider.baseURL}/models`, {
  headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
});
if (!response.ok) throw new Error(`Endpoint ${response.status}: ${await response.text()}`);
const result = await response.json();
console.log(JSON.stringify((result.data ?? []).map((model) => model.id)));
```

## Generate

Replace the model with one the endpoint serves. Gateways return either `b64_json` or a short-lived `url`; the recipe saves both and names the file from the returned bytes.

```js
import { resolve } from "node:path";

const provider = providers.openaiCompatible;
if (!provider) throw new Error("The OpenAI-compatible endpoint is not configured");
const response = await fetch(`${provider.baseURL}/images/generations`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
  },
  body: JSON.stringify({
    model: "gpt-image-2.5-sunburst",
    prompt: "A watercolor illustration of a mountain observatory",
    size: "1536x1024",
  }),
});
if (!response.ok) throw new Error(`Endpoint ${response.status}: ${await response.text()}`);
const result = await response.json();
const image = result.data?.[0];
const encoded = image?.b64_json
  ? Buffer.from(image.b64_json, "base64")
  : image?.url
    ? Buffer.from(await (await fetch(image.url)).arrayBuffer())
    : undefined;
if (!encoded) throw new Error("The endpoint returned no image");
const formats = [
  ["image/png", "png", (b) => b[0] === 0x89 && b.subarray(1, 4).toString() === "PNG"],
  ["image/jpeg", "jpg", (b) => b[0] === 0xff && b[1] === 0xd8],
  ["image/webp", "webp", (b) => b.subarray(8, 12).toString() === "WEBP"],
];
const format = formats.find(([, , matches]) => matches(encoded));
if (!format) throw new Error("Inspect the returned image format");
const [mimeType, extension] = format;
const path = resolve(`observatory-${crypto.randomUUID()}.${extension}`);
const bytes = await Bun.write(path, encoded);
console.log(JSON.stringify({ path, bytes, mimeType, usage: result.usage }));
```

## Edit or inpaint

Remove the mask append for an unmasked edit; append more named `image[]` blobs for multiple references. The mask applies to the first image. Explicit multipart filenames avoid Bun's unnamed-blob upload problem, which OpenAI-style endpoints reject.

```js
import { resolve } from "node:path";

const provider = providers.openaiCompatible;
if (!provider) throw new Error("The OpenAI-compatible endpoint is not configured");
const body = new FormData();
body.append("model", "gpt-image-2.5-sunburst");
body.append("prompt", "Replace the masked background with a sunset sky");
body.append("size", "1536x1024");
body.append("image[]", new Blob([await Bun.file("input.png").arrayBuffer()], { type: "image/png" }), "input.png");
body.append("mask", new Blob([await Bun.file("mask.png").arrayBuffer()], { type: "image/png" }), "mask.png");
const response = await fetch(`${provider.baseURL}/images/edits`, {
  method: "POST",
  headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
  body,
});
if (!response.ok) throw new Error(`Endpoint ${response.status}: ${await response.text()}`);
const result = await response.json();
const image = result.data?.[0];
const encoded = image?.b64_json
  ? Buffer.from(image.b64_json, "base64")
  : image?.url
    ? Buffer.from(await (await fetch(image.url)).arrayBuffer())
    : undefined;
if (!encoded) throw new Error("The endpoint returned no image");
const path = resolve(`edited-${crypto.randomUUID()}.png`);
const bytes = await Bun.write(path, encoded);
console.log(JSON.stringify({ path, bytes, usage: result.usage }));
```

The edit recipe assumes PNG output; reuse the format check from the generation recipe when the endpoint may return another format.
