# Lilac Documentation

這裡收錄 root README 以外的操作與設計文件。`README.md` 是本 repository 的規範入口與 canonical 文件；首次使用請先閱讀 [`../README.md`](../README.md)。繁體中文翻譯請見 [`../README.zh-TW.md`](../README.zh-TW.md)，再依需求進入下列主題。

語言入口：[`English README (canonical)`](../README.md) · [`繁體中文翻譯`](../README.zh-TW.md) · [`English documentation index`](./README.md)

## Fork 與架構

| 文件 | 內容 |
| --- | --- |
| [`fork-differences.zh-TW.md`](./fork-differences.zh-TW.md) | 本 fork 與 upstream 的現行差異、限制、同步政策與已 upstreamed 貢獻 |
| [`../PROJECT.md`](../PROJECT.md) | Core 的持久架構、名詞、workspace 擁有權、信任邊界與持久化指南 |
| [`../MIGRATIONS.md`](../MIGRATIONS.md) | Core config 與儲存格式的 migration contract |
| [`core-config-migrations.md`](./core-config-migrations.md) | 跨 config 版本的手動 `core-config.yaml` 升級，含本 fork 的 v2 keys |
| [`architecture-blob-publication-design.md`](./architecture-blob-publication-design.md) | 可恢復的 workflow artifact publication 設計紀錄：擁有權與並行決策 |

## Deployment 與 Surfaces

| 文件 | 內容 |
| --- | --- |
| [`docker-deployment.md`](./docker-deployment.md) | Docker/Compose、operator token、持久化、UID、安全邊界與診斷 |
| [`native-surface.md`](./native-surface.md) | Native Web surface：認證、設定、操作與臨時 operator console |
| [`telegram-surface.md`](./telegram-surface.md) | BotFather、allowlists、群組、forum topics、workflow、對話記憶、驗證與限制 |
| [`telegram-feature-parity.zh-TW.md`](./telegram-feature-parity.zh-TW.md) | Telegram 與 Discord 的能力對照：router 重寫對齊了什麼、每個剩餘差異的原因與所需改動，以及 Telegram 獨有的優勢 |
| [`github-reply-permalinks.md`](./github-reply-permalinks.md) | GitHub issue/PR body 與 comment reply permalink contract |

## Generation 與 Extensions

| 文件 | 內容 |
| --- | --- |
| [`generate-image-openai-compatible.md`](./generate-image-openai-compatible.md) | 結構化 `generate.image` 的內部結構與 per-alias provider 路由（含 OpenAI-compatible endpoint） |
| [`web-search-openai.md`](./web-search-openai.md) | 以 OpenAI Responses `web_search` 工具執行 `web.search`：中介模型拿到什麼、對話模型收到什麼、設定與限制 |
| [`../PLUGIN_AUTHORING.md`](../PLUGIN_AUTHORING.md) | Level 1/Level 2 external plugin contract、lifecycle 與權限 |
| [`../examples/plugins/custom-media/README.md`](../examples/plugins/custom-media/README.md) | 可部署的 OpenAI-compatible image/video plugin 範例 |
| [`skill-authoring.md`](./skill-authoring.md) | Skill 格式、discovery 與撰寫指引 |
| [`claude-code.md`](./claude-code.md) | Claude Code provider：認證、tools、continuation 與儲存 |

## Applications

| 文件 | 內容 |
| --- | --- |
| [`installation.md`](./installation.md) | 引導式安裝程式：系統需求、setup、provider 認證、重新設定與 release overrides |
| [`computer-use.md`](./computer-use.md) | 可選的 computer-use desktop gateway 與 runner：建置、Core 設定、agent 使用與驗證 |

## Contributors

| 文件 | 內容 |
| --- | --- |
| [`../AGENTS.md`](../AGENTS.md) | Repo commands、測試規則與 TypeScript conventions |
| [`../packages/remote-fs-runner/README.md`](../packages/remote-fs-runner/README.md) | Core SSH tools 使用的 remote filesystem helper |

> [!NOTE]
> `plan/` 是設計與執行紀錄，`ref/` 是 read-only reference repositories。兩者都不是一般操作文件的入口。
