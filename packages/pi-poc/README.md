# @pi-lnk/pi-poc — N2 PoC Spike

验证 [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) v0.85.1 承载 PI-Lnk 四流
（atomic / chat / explore / marketing）的 5 个关键假设。对应讨论文档 A.6 与 spec R16。

## 验收清单

| # | 假设 | 验证方式 | 对应硬骨头 |
|---|---|---|---|
| C1 | Nest 宿主能起 pi 会话 + custom tool | `canvas_draft` 工具模拟 canvas 服务代理（service token 模式） | F7 |
| C2 | `before_tool` hook = 工具级 HITL 确认门 | 标题含 `BLOCK` 的 canvas 调用被拦截 | Sidebar 确认门 |
| C3 | `transform_context` = system-reminder 注入位 | 每回合向 systemPrompt 追加 `<system-reminder>` | F2 上下文管理 |
| C4 | 双 Lane 并行（explore 后台 + main 前台） | 两条 lane 同时 prompt + `waitForIdle` | F9 |
| C5 | 嵌套 Agent 实例 = subagent 自建最小方案 | `delegate_subtask` 工具内起子 harness | H2 工程量重估（R16） |

## 运行

```bash
# 在 worktree 根目录
pnpm install --filter @pi-lnk/pi-poc

# 1. 无凭据时先做 API 面验证（tsc 全量类型检查，本机已通过）
pnpm --filter @pi-lnk/pi-poc typecheck

# 2. live run（生产同源 Agnes AI Hub 中转，key 经环境变量注入、不落盘）
AGNES_API_KEY=sk-... pnpm --filter @pi-lnk/pi-poc poc
# 可选 AGNES_BASE_URL（默认 https://apihub.agnes-ai.cn/v1，与 lnkpi 生产 LNKPI_OPENAI_* 同源）
```

## ✅ 2026-09-23 live run 结果（agnes-2.5-pro）

| 检查点 | 结果 |
|---|---|
| C1 custom tool（canvas 代理） | ✅ 调用 1 次生效 |
| C2 before_tool HITL 门 | ✅ BLOCK-me 被拦截 1 次，模型自动改用合规标题重试成功 |
| C3 transform_context 注入 | ✅ 每回合注入 `<system-reminder>`（96→170 字符） |
| C4 双 Lane 并行 | ✅ main + explore 同时 ok，waitForIdle 无死锁 |
| C5 嵌套 subagent | ✅ 模型自主调用 delegate_subtask，子 harness 跑通 |

## 已知事实（typecheck 阶段实测）

- `NodeExecutionEnv` 需从 `@earendil-works/pi-agent-core/node` 子路径导入
- 模型可用列表用 `modelRuntime.getAvailable()`（`snapshot` 是 private）
- `lane.prompt(text, undefined, context)` —— string 重载要求 images 参数占位
- 工具 execute 必须返回 `details`（可为 undefined）
- 自定义工具 schema 用 `typebox@1.3.7` 的 `Type.Object`，execute 第 5 参是 `AgentHarnessToolInvocation`（含 durable replay memo）

这些是讨论文档 A.6 之外新增的 API 细节，写 L2 `lnkpi-extension` 时直接复用本包代码。
