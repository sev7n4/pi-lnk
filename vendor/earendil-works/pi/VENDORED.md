# VENDORED: earendil-works/pi

| 项 | 值 |
|---|---|
| 上游 | https://github.com/earendil-works/pi |
| 版本 | **v0.85.1**（tag 对应 commit `d981de1` "Release v0.85.1"） |
| vendor 日期 | 2026-09-23 |
| 决策依据 | 讨论文档 §10 D-γ / spec D-γ'（vendor + pin + patch） |
| npm 对应包 | `@earendil-works/pi-agent-core@0.85.1`、`@earendil-works/pi-ai@0.85.1`（当前 packages/* 经 npm 安装使用） |

## 纪律（D-γ' / A.5.4）

1. **此目录是只读镜像**：业务适配一律上推到 L2（`packages/agent` lnkpi-extension）或 L3，**禁止直接改 vendor 内文件来迁就业务**。
2. **patch 流程（M2 阶段才启用）**：确需 patch 时，每个 patch 必须是 `vendor/earendil-works/pi/.patches/NNNN-*.patch` 独立文件 + 在本文件登记（目录名对齐 spec §12）；升级时按序重放。
3. **upmerge 通道**：上游发布新版本时，评估间隔 ≥ 3 个 minor 版本触发季度评审（spec §13 项 3）。
4. vendor 目录**不进 pnpm workspace**（避免源码被 workspace 构建/测试误扫），运行时统一走 npm 固定版本。

## 目录说明

`packages/`：agent（AgentHarness/Lane/session，~5954 行 harness 核心）、ai（模型抽象 + 50+ provider）、coding-agent（CLI，我们不用其 CLI 只可参考）、chord / protocol / server / tui / client / session-backends / telemetry / evals。
