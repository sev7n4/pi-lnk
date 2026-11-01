# VENDORED: earendil-works/pi

| 项 | 值 |
|---|---|
| 上游 | https://github.com/earendil-works/pi |
| 版本 | **v0.99.2**（tag 对应 commit `005af57`）——harness（AgentHarness/Lane/drive）存续的**最后一个版本**，v1.0.0 起整体移除改由 Experimental 的 `pi-durable` 承接（升级审计 `.workbuddy/audit/upgrade-0.85.1-to-1.4.0.md`） |
| vendor 日期 | 2026-09-23（v0.85.1 初次）；2026-11-01（v0.99.2 升级，P1-A→P1-B 之间窗口） |
| 决策依据 | 讨论文档 §10 D-γ / spec D-γ'（vendor + pin + patch）；升级裁决=P1 总纲 §2 + 审计报告 |
| npm 对应包 | `@earendil-works/pi-agent-core@0.99.2`、`@earendil-works/pi-ai@0.99.2`（当前 packages/* 经 npm 安装使用） |

## npm 侧 pnpm patch 登记（运行时实际生效面）

v0.99.2 上游删除了 `addedToolNames` 中途激活机制（`tool-placement` 合并块 + `AgentToolResult`/`ToolResultMessage` 字段 + `execution/tools` 两处透传）——本仓 DTL（tool_search 延迟集激活，AGENTS.md 工具分层）依赖它，且生产 47 工具全常驻是「机制存在但未触发」状态，**不能因升级砍断下沉路线图**。故以 pnpm 官方 `patchedDependencies` 恢复（0.85.1 原样移植，登记在仓根 `patches/`）：

| patch 文件 | 内容 |
|---|---|
| `patches/@earendil-works__pi-ai@0.99.2.patch` | `ToolResultMessage` 恢复 `addedToolNames?: string[]` |
| `patches/@earendil-works__pi-agent-core@0.99.2.patch` | `AgentToolResult` 恢复字段 + `execution/tools.js` 两处透传 + `tool-placement.js` 恢复激活合并块/config_update 事件 |

升级到 v1.x（pi-durable 换轨）时这两枚 patch 随 harness 时代一并退役。

## 上游已知边界（0.99.2，实测登记）

- **drive 在 pre-LLM 相位收 cancel 的收尾缺口**：`lane.prompt` 的 run 已启动但尚未发起 LLM 调用时收到 context cancel（如 subagent `timeoutMs` 短于 fork+build 耗时），会留下未收尾状态并卡死**同一主会话**的下一轮 prompt（探针实锤：`turn_start` 后永不发起 LLM 调用；取消落在 LLM await 相位则一切正常）。生产默认 `SUBAGENT_TIMEOUT_MS=5min`，fork+build 远小于此 ⇒ 实际风险仅测试面；测试用例因此把压短的超时从 600ms 调到 1500ms（`session-manager.subagent.integration.test.ts` 有详注）。v1.x 换轨时随 harness 时代消失。

## 纪律（D-γ' / A.5.4）

1. **此目录是只读镜像**：业务适配一律上推到 L2（`packages/agent` lnkpi-extension）或 L3，**禁止直接改 vendor 内文件来迁就业务**。
2. **patch 流程（M2 阶段才启用）**：确需 patch 时，每个 patch 必须是 `vendor/earendil-works/pi/.patches/NNNN-*.patch` 独立文件 + 在本文件登记（目录名对齐 spec §12）；升级时按序重放。
3. **upmerge 通道**：上游发布新版本时，评估间隔 ≥ 3 个 minor 版本触发季度评审（spec §13 项 3）。
4. vendor 目录**不进 pnpm workspace**（避免源码被 workspace 构建/测试误扫），运行时统一走 npm 固定版本。

## 目录说明

`packages/`：agent（AgentHarness/Lane/session，~5954 行 harness 核心）、ai（模型抽象 + 50+ provider）、coding-agent（CLI，我们不用其 CLI 只可参考）、chord / protocol / server / tui / client / session-backends / telemetry / evals。
