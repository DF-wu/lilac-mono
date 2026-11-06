# Tool-result image compatibility: official evidence

Research date: 2026-10-06. Scope: assess issue #79's provider-local image lifting middleware against first-party documentation and the installed SDK source. No live private-provider capability test was performed.

## Finding

The helper uses the AI SDK's documented middleware API and produces an OpenAI Chat Completions-compatible representation: text tool replies retain their call IDs, while actual image inputs travel in a synthetic user message. This is a locally designed compatibility fallback, with a semantic tradeoff: the image's tool origin survives as descriptive text rather than a structured tool-result association. It does not establish that the deployed private `deepseek-v4.1-flash` route accepts or understands images.

No official AI SDK cookbook or middleware example recommending this exact tool-image-to-user-message transformation was found in the reviewed official middleware, multimodal-tool-result, and image-prompt documentation. The documented native path is `toModelOutput` returning multimodal content to a provider/API that supports it. Do not describe the local lifting algorithm as an official prescribed recipe.

## AI SDK middleware is appropriate for both call modes

The [official middleware documentation](https://ai-sdk.dev/docs/ai-sdk-core/middleware#implementing-language-model-middleware) says:

> `transformParams`: Transforms the parameters before they are passed to the language model, for both `doGenerate` and `doStream`.

It also requires `specificationVersion: 'v4'` and defines `wrapLanguageModel` as returning a new model incorporating middleware. The existing helper uses those supported interfaces. The installed `ai@7.0.22` source, `src/middleware/wrap-language-model.ts`, lines 63–71, 81–94, and 97–110, confirms `doGenerate` and `doStream` each invoke the parameter transformation before calling the underlying model. [First-party source](https://github.com/vercel/ai/blob/main/packages/ai/src/middleware/wrap-language-model.ts).

This verifies the interception mechanism, not the model's vision capability or semantic equivalence after changing a message role.

## Chat Completions tool text versus user images

The [official OpenAI Node SDK schema](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts), also present in installed `openai@7.10.0`, defines:

```ts
interface ChatCompletionToolMessageParam {
  content: string | Array<ChatCompletionContentPartText>;
  role: 'tool';
  tool_call_id: string;
}
interface ChatCompletionUserMessageParam {
  content: string | Array<ChatCompletionContentPart>;
  role: 'user';
}
```

`ChatCompletionContentPart` includes `ChatCompletionContentPartImage`; the tool-message content type does not. Thus generic OpenAI Chat Completions cannot represent an image as a native image content part in a tool reply using this schema. Sending JSON text that happens to contain base64 image bytes satisfies a text-tool-message shape but does not make those bytes a vision input.

Installed `@ai-sdk/openai-compatible@3.0.30`, `src/chat/convert-to-openai-compatible-chat-messages.ts`, lines 235–265, handles `output.type === 'content'` with `JSON.stringify(output.value)` and emits `{ role: 'tool', tool_call_id, content: contentValue }`. [First-party adapter source](https://github.com/vercel/ai/blob/main/packages/openai-compatible/src/chat/convert-to-openai-compatible-chat-messages.ts). This is a lossy modality mapping for images; it is not evidence that the adapter violates the text tool-message protocol. Version-specific conclusions here come from the installed package, not an assumption that a mutable upstream branch is identical.

The local helper replaces only image `file` parts with text notices in the tool result, keeps tool names and call IDs, and appends the corresponding image/file parts to a user message after the contiguous tool-reply run. Nonimage tool content remains in the tool reply. It constructs a new provider prompt instead of modifying the canonical transcript. These are direct observations of `packages/utils/openai-compatible-tool-images.ts`, not upstream guarantees. Label text provides provenance to the model but does not restore the native role/call-ID relationship of an image tool output.

## Official native alternatives

The [AI SDK multimodal tool-result documentation](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling#multi-modal-tool-results) states:

> Multi-modal tool results are experimental and supported by Anthropic, OpenAI, and Google (Gemini 3 models).

> AI SDK Core tools have an optional `toModelOutput` function that converts the tool result into a content part.

Its screenshot example returns `{ type: 'content', value: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: output.data } }] }` from `toModelOutput`. Provider support remains API-specific: this does not promise support from every OpenAI-compatible Chat adapter.

Installed `@ai-sdk/openai@4.0.42`, `src/responses/convert-to-openai-responses-input.ts`, lines 1176–1241, maps tool-result image `file` parts into `input_image`, including data URLs and external URLs, as `function_call_output` content. [First-party Responses converter](https://github.com/vercel/ai/blob/main/packages/openai/src/responses/convert-to-openai-responses-input.ts). Native Responses tool-output images preserve the tool association when the actual endpoint and model support that API. A migration to Responses is an architectural alternative, not a prerequisite for a bounded Chat adapter fix.

## Newer compatible-adapter option does not remove endpoint requirements

The current [official compatible-provider documentation](https://ai-sdk.dev/providers/openai-compatible-providers) exposes `supportsMultiPartToolContent`, defaulting to `false`. It explicitly says to enable it only when the provider accepts content arrays in messages with the `tool` role; otherwise multipart results are stringified for OpenAI Chat compatibility. The installed pinned `@ai-sdk/openai-compatible@3.0.30` does not expose that setting. This option concerns Chat Completions, not Responses. An SDK upgrade alone would not fix the default serialization, and enabling the extension requires verified endpoint support. The bounded fix therefore keeps the existing dependency versions and uses user image parts. No exact release introducing the option or live private-endpoint support is asserted.

## DeepSeek: published vision support does not prove the private route

The current [official DeepSeek Vision guide](https://api-docs.deepseek.com/guides/vision) says:

> The `deepseek-flash` model accepts images alongside text.

It names legacy `deepseek-v4-flash-vision-exp` as an accepted retired alias served by the latest Flash model, and shows user-message `image_url` data URLs with `base_url=https://api.deepseek.com`. The Restrictions section says:

> Images are supported in `user` messages only. Images in `system` or `assistant` messages return a `400` error.

The page's image limits include JPEG/PNG/GIF/WebP; 48 MiB request body; 32 MiB per inline/external image; 600 images per request; and dimension/total-byte limits. These restrictions describe that official endpoint and named model, not an undocumented private deployment. The lifting helper uses the documented user role for Chat image input, subject to the actual provider's implementation and limits.

There is an official documentation inconsistency worth preserving: [DeepSeek's Chat create schema](https://api-docs.deepseek.com/api/create-chat-completion) describes `tool.content` as a string or image-bearing content array, with `image_url` and `file` blocks, while the Vision guide says images are supported in user messages only. This suggests a provider-specific multimodal tool extension in the schema, but those conflicting sources do not justify asserting operational Chat tool-image support without checking the endpoint. It also must not be generalized to the narrower OpenAI Chat tool-message schema.

The [official DeepSeek Responses guide](https://api-docs.deepseek.com/guides/responses_api#image-input) is explicit and supplies an example:

> `input_image` parts may also appear in the `output` of `function_call_output` / `custom_tool_call_output` items, so the model can receive images produced by your tools.

```json
{"type":"function_call_output","call_id":"fc1","output":[{"type":"input_image","image_url":"data:image/png;base64,<BASE64_DATA>"}]}
```

Its published model is `deepseek-flash`. Neither guide documents the deployed private name `deepseek-v4.1-flash`; its routing, vision support, Responses support, and tool-image extensions remain unverified. Middleware cannot create vision capability in a text-only model or force a proxy to forward image content.

As a separate issue #80 caveat, the [DeepSeek Responses compatibility table](https://api-docs.deepseek.com/guides/responses_api#compatibility-details) marks `context_management`, `previous_response_id`, `conversation`, and `truncation` unsupported and says unsupported parameters are silently ignored. Do not infer server-side OpenAI compaction support from Responses wire compatibility.

## Claims suitable for the proposed fix

- Supported mechanism: AI SDK V4 `transformParams` applies to streaming and nonstreaming model calls.
- Chat wire compatibility: retain text tool replies/call IDs and supply image inputs through user image parts.
- Semantic compromise: synthetic user image messages carry textual tool provenance, rather than native image tool-result structure.
- Provider limitation: generic compatible-adapter JSON serialization does not expose tool-result bytes as vision inputs; this is not itself a text-wire-protocol violation.
- Capability limitation: private upstream vision support is unverified; published DeepSeek support applies to specific documented models/endpoints.
- Native alternative: `toModelOutput` plus a provider/API with multimodal tool-result support, including the inspected OpenAI Responses adapter, avoids role lifting when available.
