# Lilac Documentation

這裡收錄 root README 以外的操作與設計文件。首次使用請先閱讀 [`../README.md`](../README.md)，再依需求進入下列主題。

## Fork 與架構

| 文件 | 內容 |
| --- | --- |
| [`fork-differences.md`](./fork-differences.md) | 本 fork 與 upstream 的現行差異、限制、同步政策與已 upstreamed 貢獻 |
| [`../PROJECT.md`](../PROJECT.md) | Core 與 Mini Lilac 的完整架構、名詞、資料流與設定模型 |
| [`../MIGRATIONS.md`](../MIGRATIONS.md) | Core config 與儲存格式的 migration contract |

## Deployment 與 Surfaces

| 文件 | 內容 |
| --- | --- |
| [`docker-deployment.md`](./docker-deployment.md) | Docker/Compose、operator token、持久化、UID、安全邊界與診斷 |
| [`telegram-surface.md`](./telegram-surface.md) | BotFather、allowlists、群組、forum topics、workflow、驗證與限制 |
| [`github-reply-permalinks.md`](./github-reply-permalinks.md) | GitHub issue/PR body 與 comment reply permalink contract |

## Generation 與 Extensions

| 文件 | 內容 |
| --- | --- |
| [`generate-image-openai-compatible.md`](./generate-image-openai-compatible.md) | 將 `generate.image` 路由到 OpenAI-compatible endpoint |
| [`../PLUGIN_AUTHORING.md`](../PLUGIN_AUTHORING.md) | Level 1/Level 2 external plugin contract、lifecycle 與權限 |
| [`../examples/plugins/custom-media/README.md`](../examples/plugins/custom-media/README.md) | 可部署的 OpenAI-compatible image/video plugin 範例 |

## Applications

| 文件 | 內容 |
| --- | --- |
| [`../apps/mini-lilac/README.md`](../apps/mini-lilac/README.md) | Mini Lilac 安裝與 first run |
| [`../apps/mini-lilac-server/README.md`](../apps/mini-lilac-server/README.md) | Mini server 設定、provider/auth、API 與 history recovery |
| [`../apps/mini-lilac-tui/README.md`](../apps/mini-lilac-tui/README.md) | Mini TUI options、keyboard model 與 rendering |
| [`../apps/acp-controller/README.md`](../apps/acp-controller/README.md) | `lilac-acp` build、session search 與 detached prompts |

## Contributors

| 文件 | 內容 |
| --- | --- |
| [`../AGENTS.md`](../AGENTS.md) | Repo commands、測試規則與 TypeScript conventions |
| [`../packages/remote-fs-runner/README.md`](../packages/remote-fs-runner/README.md) | Core SSH tools 使用的 remote filesystem helper |

> [!NOTE]
> `plan/` 是設計與執行紀錄，`ref/` 是 read-only reference repositories。兩者都不是一般操作文件的入口。
