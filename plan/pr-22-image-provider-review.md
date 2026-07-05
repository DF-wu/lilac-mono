# PR #22 Feature Review: Third-Party Image Provider Support

日期：2026-07-05

Branch：`feat/image-provider-base-url`

PR：`https://github.com/DF-wu/lilac-mono/pull/22`

## 1. 審查結論

這個 feature update 的設計方向是正確的：`generate.image` 沒有新增第二套圖片 HTTP client，而是重用 repo 既有的 AI SDK provider abstraction，並把「第三方 OpenAI-compatible endpoint」與「預設圖片模型順序」分別放在環境變數與 `core-config.yaml`。

我用 feature 影響面做了全專案交叉審查，確認以下路徑彼此一致：

- provider wiring：`packages/utils/model-provider.ts`
- env parsing：`packages/utils/env.ts`
- core config v1/v2/type：`packages/utils/core-config/*`
- built-in tool plugin wiring：`apps/core/src/plugins/builtin/server-tools.ts`
- tool server runtime path：`apps/core/src/tool-server/create-tool-server.ts`
- image tool implementation：`apps/core/src/tool-server/tools/generate.ts`
- prompt/tool docs：`packages/utils/prompt-templates/TOOLS.md`
- README / config template / env example
- focused tests and config drift tests

沒有發現阻斷性 correctness bug。主要 residual risk 是 live third-party provider endpoint 沒有在本環境實際打出去；目前驗證的是 Lilac 端的 provider/model resolution、config parsing、tool exposure、typecheck、lint、format、build 和 tests。

## 2. Feature 要解決的問題

原本 `generate.image` 主要依賴 Lilac 內建 alias，例如：

- `nanobanana-2`
- `nanobanana-pro`
- `gpt-5-image`
- `grok-imagine-image-pro`
- `grok-imagine-image`
- `nanobanana`

這些 alias 很適合「Lilac 已知的模型」：

- 可以做本地 validation，例如 aspect ratio / size / mask 支援。
- 可以封裝 provider fallback，例如 `gpt-5-image` 先走 OpenAI，沒有 OpenAI 時再走 OpenRouter。

但第三方 OpenAI-compatible image provider 的模型常常不在 Lilac 內建清單中。這次 feature 的目標是讓 operator 可以用：

```txt
openai-compatible/{provider-image-model-id}
```

直接指定第三方 provider 的圖片模型。

## 3. 最小心智模型

把這個 feature 想成兩個開關：

```txt
┌──────────────────────────────────────────────────────────────────┐
│ Runtime Secret / Endpoint                                         │
│                                                                  │
│   OPENAI_COMPATIBLE_BASE_URL=https://provider.example/v1          │
│   OPENAI_COMPATIBLE_API_KEY=...                                  │
│                                                                  │
│   這回答：「request 要送去哪裡？用什麼 key？」                    │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ Operator Policy / Default Model Order                             │
│                                                                  │
│   tools:                                                         │
│     generate:                                                    │
│       image:                                                     │
│         models:                                                  │
│           - "openai-compatible/{provider-image-model-id}"         │
│                                                                  │
│   這回答：「agent 沒指定 model 時，預設先用哪個？」               │
└──────────────────────────────────────────────────────────────────┘
```

這樣拆分的理由：

- endpoint/key 是部署秘密與 runtime endpoint，適合放 env。
- default model order 是 operator policy，適合放 config。
- operator 可以不動 secret，只調整 agent 預設模型順序。
- operator 也可以不改 config，只在單次 tool call 傳 `model` 測試新模型。

## 4. 架構圖

### 4.1 Before

```txt
Agent / tools CLI
      │
      ▼
generate.image
      │
      ▼
Built-in alias resolver
      │
      ├─ nanobanana-2 ───────────────▶ OpenRouter imageModel(...)
      ├─ nanobanana-pro ─────────────▶ OpenRouter imageModel(...)
      ├─ gpt-5-image ─┬──────────────▶ OpenAI image(...)
      │               └──────────────▶ OpenRouter imageModel(...)
      └─ grok-imagine-* ─────────────▶ xAI image(...)
```

特性：

- alias 穩定、易教 agent 使用。
- Lilac 可以做本地 capability validation。
- 不適合快速接入未知第三方 image model。

### 4.2 After

```txt
Agent / tools CLI
      │
      ▼
generate.image
      │
      ├──────────────────────────────────────────────┐
      │                                              │
      ▼                                              ▼
Built-in alias resolver                     Explicit provider/model resolver
      │                                              │
      │                                              ├─ openai-compatible/{model}
      │                                              ├─ openrouter/{model}
      │                                              ├─ openai/{model}
      │                                              ├─ xai/{model}
      │                                              └─ vercel/{model}
      │                                              │
      ▼                                              ▼
Local validation + fallback                  AI SDK provider.imageModel/image
      │                                              │
      └───────────────────────┬──────────────────────┘
                              ▼
                       AI SDK generateImage(...)
                              │
                              ▼
                  output file + MIME type result
```

重點是「新增 explicit resolver」而不是取代 built-in resolver。這讓兩種模型使用方式有清楚分工：

| 使用方式 | 適合場景 | Lilac 是否做本地 capability validation | 是否支援 provider fallback |
| --- | --- | --- | --- |
| `gpt-5-image` / `nanobanana-2` 等 alias | Lilac 已知模型 | 是 | 是 |
| `openai-compatible/{model-id}` | 第三方或臨時測試模型 | 否，交給 upstream provider | 否，指定哪個就用哪個 |

## 5. Runtime 流程圖

### 5.1 Tool listing flow

```txt
tool server /list
      │
      ▼
Generate.list()
      │
      ├─ 讀 runtime config
      │      │
      │      └─ tools.generate.image.models
      │
      ├─ 如果 models = []
      │      │
      │      └─ 使用 DEFAULT_IMAGE_MODEL_FALLBACK_ORDER
      │
      ├─ 解析每個 image model spec
      │      │
      │      ├─ built-in alias 可用？加入 Default models
      │      │
      │      └─ explicit provider/model 且 provider configured？加入 Default models
      │
      ├─ 掃描已配置 explicit providers
      │      │
      │      └─ 例如 openai-compatible/<model-id>
      │
      └─ 決定是否曝光 generate.image
             │
             ├─ 有 default model：曝光
             ├─ 沒 default model，但有 explicit provider：也曝光
             └─ 兩者都沒有：不曝光
```

為什麼「有 provider 但沒有 default model」仍曝光？

```txt
OPENAI_COMPATIBLE_BASE_URL 已設定
tools.generate.image.models 沒設定
      │
      ▼
agent 仍能看到 generate.image
      │
      ▼
description 告訴 agent 可傳：
openai-compatible/<model-id>
```

這是刻意設計。它讓 operator 可以先設定第三方 endpoint，再用單次 `model` 指定方式測 provider，不需要每測一個模型就改 config。

### 5.2 Tool call flow

```txt
generate.image call
      │
      ▼
parse input with imageGenerateInputSchema
      │
      ▼
getModelProviders()
      │
      ▼
resolveAvailableImageModels(configured/default model specs)
      │
      ▼
pickImageModel(...)
      │
      ├─ caller 有傳 model？
      │      │
      │      ├─ 已在 configured defaults 中：使用該 model
      │      │
      │      ├─ 是 explicit provider/model 且 provider configured：即時建立 model
      │      │
      │      └─ 其他：丟出可讀錯誤
      │
      └─ caller 沒傳 model？
             │
             ├─ 使用第一個 available default model
             ├─ 沒 default 但有 explicit provider：要求 caller 傳 model
             └─ 完全沒有 provider：提示設定 provider/config
```

這裡最重要的設計點是：

```txt
caller-supplied model 可以 bypass tools.generate.image.models
```

這不是放寬錯誤，而是支援「一次性指定第三方模型」的必要能力。否則 operator 每要測一個 third-party model 都必須改 config 並 reload。

## 6. 解析規則

### 6.1 Explicit provider/model spec

格式：

```txt
{provider}/{model-id}
```

目前允許的 provider：

- `openai`
- `openai-compatible`
- `openrouter`
- `xai`
- `vercel`

這份 allowlist 不是隨意擴大，而是限定在 repo 已經透過 AI SDK wired、且有 image factory 的 provider。

### 6.2 只切第一個 slash

`parseProviderModelSpec()` 只切第一個 `/`：

```txt
openai-compatible/acme/image-model
│                 └──────────────── model id 保持 acme/image-model
└ provider
```

原因是 upstream model id 本身常帶 namespace，例如：

```txt
openrouter/google/gemini-3.1-flash-image-preview
openai-compatible/acme/image-model
```

如果用 `split("/")` 後只拿第二段，就會把 upstream namespace 截斷，造成錯誤 model id。

## 7. Config 設計

### 7.1 Universal config shape

`UniversalCoreConfig` 新增：

```ts
tools: {
  generate: {
    image: {
      models: string[];
    };
  };
}
```

這讓 core runtime 內部永遠可以用同一種 shape 讀取圖片模型設定，不需要每次都判斷 config version。

### 7.2 v2 input schema

v2 支援：

```yaml
tools:
  generate:
    image:
      models:
        - "openai-compatible/{provider-image-model-id}"
```

`models` 是 ordered default list，且會去重：

```txt
input:
  [A, A, B]

parsed:
  [A, B]
```

去重保留第一次出現的順序，原因是 default order 本身就是 operator policy，後面重複的同一模型沒有新增資訊。

### 7.3 v1 shape frozen

repo 指示要求 v1 config input shape frozen，所以這次沒有把 `tools.generate.image.models` 加進 v1 schema。

v1 只在 parse 到 universal config 時補 fallback：

```ts
generate: {
  image: {
    models: [],
  },
}
```

這樣同時達成：

- v1 使用者的 config input 不破壞。
- core runtime 內部拿到的 universal config shape 一致。

## 8. Provider 設計

### 8.1 為什麼使用 AI SDK provider

這次 feature 沒有手寫：

```txt
fetch(OPENAI_COMPATIBLE_BASE_URL + "/images/generations")
```

而是使用：

```txt
createOpenAICompatible(...)
provider.imageModel(modelId)
AI SDK generateImage(...)
```

理由：

- repo 已經在 `packages/utils/model-provider.ts` 集中管理 provider 初始化。
- AI SDK 已提供 image model interface。
- 避免 tool 層維護第二套 HTTP body、response parsing、error handling。
- 與 text model 的 provider mental model 保持一致。
- 之後如果 AI SDK 調整 image request format，Lilac 比較可能跟著 dependency 升級受益。

### 8.2 OpenAI-compatible 必須有 base URL

`openai-compatible` 和 `openai` / `openrouter` 不同。

```txt
openai:
  有官方預設 endpoint 概念

openrouter:
  有明確 provider package / endpoint 設定

openai-compatible:
  沒有安全預設 endpoint
```

所以 `isConfiguredProvider("openai-compatible")` 要求：

```txt
OPENAI_COMPATIBLE_BASE_URL 必須存在
```

只有 API key 不夠，因為 code 不知道 request 應該送到哪裡。

### 8.3 imageModel 優先，image fallback

explicit resolver 的策略：

```txt
provider.imageModel(modelId) 先用
provider.image(modelId)      作為 fallback
```

原因：

- OpenAI-compatible 和 OpenRouter 的 AI SDK surface 是 `imageModel()`。
- OpenAI / xAI / Vercel gateway 這類 provider 可能提供 `image()` convenience method。
- 用 feature detection 避免用 `as any`，也符合 repo TypeScript guideline。

## 9. Failure Modes

### 9.1 未設定 provider

```txt
model = "openai-compatible/acme-image"
OPENAI_COMPATIBLE_BASE_URL 未設定
```

結果：

```txt
Requested model 'openai-compatible/acme-image' is not available...
explicit providers: none
```

這是正確行為。沒有 endpoint 時不能假裝模型可用。

### 9.2 有 provider，無 default model，呼叫時沒傳 model

```txt
OPENAI_COMPATIBLE_BASE_URL 已設定
tools.generate.image.models = []
generate.image call 沒有 model
```

結果：

```txt
No default image generation model is configured.
Set tools.generate.image.models or pass model as one of:
openai-compatible/<model-id>
```

這也是正確行為。工具可被 discover，但 caller 必須選模型。

### 9.3 explicit model 沒有本地 capability validation

```txt
model = "openai-compatible/vendor-model"
aspectRatio = "21:9"
```

Lilac 不會先擋掉這個 input。是否支援交給 upstream provider。

理由是第三方 provider 的能力矩陣不穩定，而且每個 provider 可能不同。若 Lilac 強行用本地規則判斷，反而會錯擋新模型。

## 10. Code Review Map

### 10.1 `apps/core/src/tool-server/tools/generate.ts`

審查重點：

- `CONFIGURABLE_IMAGE_PROVIDER_IDS` 限定 explicit provider/model 的 provider 範圍。
- `isConfiguredProvider()` 對 `openai-compatible` 要求 base URL。
- `parseProviderModelSpec()` 保留 model id 內部 namespace。
- `createExplicitProviderImageModel()` 用 type guard 檢測 `imageModel()` / `image()`。
- `resolveConfiguredImageModelSpecs()` 保留 `models: []` 的歷史 built-in fallback 行為。
- `resolveAvailableImageModels()` 先解析 built-in alias，再解析 explicit specs。
- `pickImageModel()` 支援 caller-supplied model bypass default list。
- `Generate.list()` 在「有 provider 但無 default model」時仍曝光 `generate.image`。
- `Generate.callGenerateImage()` 和 list 使用同一套 resolver，不會出現 list 說可用但 call path 用另一套規則的問題。

結論：通過。

### 10.2 `packages/utils/core-config/*`

審查重點：

- `UniversalCoreConfig` 有新欄位，runtime 可穩定讀取。
- v2 schema 有 `tools.generate.image.models`。
- v2 default 是 `[]`。
- v2 去重保留順序。
- v1 input schema 未新增 key，符合 project rule。
- v1 to universal 補 `generate.image.models = []`。

結論：通過。

### 10.3 `apps/core/src/plugins/builtin/server-tools.ts`

審查重點：

- `Generate` 由 singleton 改成接收 runtime config getter。
- 模式與 `ContentInspect` 類似。
- 如果 runtime 有 `getConfig`，可拿到 reload 後的新 config。
- 如果只有 static `config`，會 fallback 成 async getter。

結論：通過。

### 10.4 Docs and prompts

審查重點：

- `README.md` 說明第三方 image provider 用法。
- `.env.example` 說明 `OPENAI_COMPATIBLE_*` 可供 `generate.image` 使用。
- `core-config.example.yaml` 顯示 ordered default model list。
- `TOOLS.md` 讓 agent prompt 知道可以傳 `openai-compatible/<provider-image-model-id>`。
- `PROJECT.md` 補 mental model。

結論：通過。

### 10.5 Tests

審查重點：

- image generation tests 覆蓋 default fallback、configured order、explicit model spec、model id containing slash、unconfigured provider。
- config versioning tests 覆蓋 v1/v2 default shape。
- drift test 確認 example config 可 parse。
- earlier isolated validation 覆蓋 full monorepo tests/build/typecheck/lint/format/ci。

結論：通過。

## 11. Decision Record

### Decision A：不用新 HTTP client

選擇：

```txt
AI SDK provider abstraction
```

不選：

```txt
generate.image 自己組 OpenAI-compatible HTTP request
```

理由：

- 減少 duplicated protocol code。
- 延續 repo 已有 provider abstraction。
- 保持 text/image provider setup 一致。
- 降低第三方 provider response shape 差異造成的維護成本。

### Decision B：default image model order 放 config

選擇：

```yaml
tools.generate.image.models
```

理由：

- default model order 是 operator policy。
- config 比 env 更適合表示有順序的模型選擇策略。
- 可以 version、diff、review。

### Decision C：explicit spec 使用 `provider/model-id`

選擇：

```txt
openai-compatible/{model-id}
```

理由：

- 與 repo 既有 text model shorthand 類似。
- agent prompt 容易教。
- model id 可保留 provider namespace。
- future provider 可以用同一種語法擴充。

### Decision D：built-in alias 和 explicit spec 並存

選擇：

```txt
alias path + explicit path
```

理由：

- alias 保留 Lilac 對已知模型的 validation/fallback 能力。
- explicit spec 保留第三方 provider 的速度與彈性。
- 兩者服務不同需求，不應互相取代。

## 12. Teaching Walkthrough

假設你要把一個第三方 OpenAI-compatible image API 接進 Lilac。

### Step 1：設定 endpoint

```dotenv
OPENAI_COMPATIBLE_BASE_URL=https://provider.example/v1
OPENAI_COMPATIBLE_API_KEY=...
```

這一步只讓 Lilac 知道「有一個 provider 可以送 request」。

### Step 2：選擇是否設定 default model

如果你希望 agent 不傳 `model` 也能直接用：

```yaml
configVersion: 2

tools:
  generate:
    image:
      models:
        - "openai-compatible/acme-image-model"
```

如果你還在測，不想固定 default：

```yaml
configVersion: 2

tools:
  generate:
    image:
      models: []
```

`models: []` 代表保留 built-in fallback。若只有 third-party provider 可用，agent 仍會看到 tool，但呼叫時要傳 explicit `model`。

### Step 3：呼叫工具

```json
{
  "prompt": "Generate a clean product photo on a white background",
  "model": "openai-compatible/acme-image-model"
}
```

Call path：

```txt
model string
   │
   ▼
parse provider/model
   │
   ▼
provider = openai-compatible
modelId  = acme-image-model
   │
   ▼
providers["openai-compatible"].imageModel("acme-image-model")
   │
   ▼
AI SDK generateImage(...)
```

## 13. Validation Matrix

| Area | What was checked | Result |
| --- | --- | --- |
| Config v1 compatibility | v1 input schema remains frozen; universal fallback added | Pass |
| Config v2 parsing | `tools.generate.image.models` parses and dedupes | Pass |
| Provider setup | OpenAI-compatible provider uses existing `createOpenAICompatible` | Pass |
| Explicit model parsing | only first `/` is split | Pass |
| Provider configured guard | unconfigured provider cannot create explicit image model | Pass |
| Tool listing | default models and explicit provider specs are surfaced | Pass |
| Tool calling | caller-supplied explicit model can bypass defaults | Pass |
| Built-in behavior | `models: []` preserves historical fallback order | Pass |
| Docs | README/env example/config template/prompt docs updated | Pass |
| Live third-party endpoint | not executed in this environment | Not covered |

## 14. Commands Already Used For Validation

The earlier isolated validation ran in a temporary copied workspace and then removed the temp directory:

```bash
bun install --frozen-lockfile
cd apps/core && bun run build:remote-runner
cd apps/tool-bridge && bun run build
cd apps/acp-controller && bun run build
cd apps/core && bun test tests/tool-server-image-generation.test.ts
cd packages/utils && bun test tests/core-config.versioning.test.ts tests/core-config.drift.test.ts
bun test
bun run typecheck
bun run lint
bun run fmt:check
bun run ci
```

Latest focused validation after adding code comments:

```bash
bun run fmt
bun run lint
cd apps/core && bun test tests/tool-server-image-generation.test.ts
cd packages/utils && bun test tests/core-config.versioning.test.ts tests/core-config.drift.test.ts
bunx tsc -p apps/core/tsconfig.json --noEmit --pretty false
bunx tsc -p packages/utils/tsconfig.json --noEmit --pretty false
bun run fmt:check
git diff --check
```

## 15. Remaining Risk And Follow-Up

Residual risk：

- 本環境沒有實際呼叫第三方 OpenAI-compatible image provider 的 live endpoint。
- 不同 provider 對 `size`、`aspectRatio`、`inputImages`、`maskImage` 的支援可能不同。
- explicit provider/model path 刻意不做本地 capability validation，所以 provider-side error 是預期行為的一部分。

建議 follow-up：

- 若有實際第三方 endpoint，可以加一個 manual smoke test record，記錄 provider、model id、支援的 options。
- 若未來有某個第三方 provider 成為常用 provider，可以再把它升級成 built-in alias，補上本地 validation 與更友善的錯誤訊息。

## 16. Final Assessment

這個 PR 的 feature update 是正確且符合 repo 架構的。它保留既有 built-in image aliases 的穩定性，同時增加第三方 OpenAI-compatible image provider 的彈性；它也遵守 core config versioning 規則，避免 v1 schema drift，並透過測試覆蓋主要 edge cases。

最重要的是，這次改動把「模型怎麼被選到」和「request 怎麼被送出」分開：

```txt
config 決定 default model order
env 決定 provider endpoint/key
generate.image 決定 alias/explicit spec resolution
AI SDK provider 決定 image request implementation
```

這個責任切分清楚，後續維護成本低，也讓 agent 和 operator 的使用方式保持可教、可測、可擴充。
