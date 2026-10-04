# ADR-0001: vendor pi 作为唯一对话内核

| 字段 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-08-01（讨论文档定稿）/ 2026-10-03 补录 |
| 决策者 | 项目发起人 |

## 背景

项目 fork 自 lnkpi，原内核是**自研 LangGraph Runtime**（`services/agent-runtime`，Python，`:8000`）
+ 自研 `@lnkpi/agent` 包。维护成本高、能力弱（无 subagent、无 HITL 原生挂点）。

社区已有成熟的 agent 内核 [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi)，
自带 tool use / HITL hook / 上下文管理。核心问题是：**如何引入而不破坏现有 Nest 宿主架构？**

## 考虑过的方案

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| **替换**（一次性大重构） | 架构最干净 | 工期长、期间无法交付、风险集中 | ❌ |
| **并存**（LangGraph 保留，pi 旁路） | 可灰度、可回退 | 两套内核长期维护，能力分裂 | ❌ |
| **vendor + pin + 分层接入**（选中） | 可灰度、随时可退、代码在仓库内可读可改 | vendor 同步需人工 | ✅ |

## 决定

1. **vendor 到monorepo**：`vendor/earendil-works/pi/`，pin 上游 tag（当前 `v0.85.1`，commit `d981de1`），
   纪律写在 `vendor/earendil-works/pi/VENDORED.md`。
2. **禁止业务 patch**：只允许记录版本与来源。upmerge 时才能与上游对齐。
3. **分层接入**：pi 跑在独立的 `services/pi-runtime`（fastify，`:8100`），
   Nest 仍作宿主（`apps/server`），两者走 HTTP。
4. **LangGraph 彻底退役**（ADR 生效后的收尾）：`services/agent-runtime`、
   `Dockerfile.agent-runtime`、`deploy-agent-runtime.yml` 全部删除，
   `PI_RUNTIME_MODE=off` 语义改为**维护态关停**（不再代表"切回另一条链路"）。

## 后果

**正面**
- 拿到 pi 的 tool use / HITL / 上下文管理，且代码在仓库内可查
- 独立部署形态（K3s）+ 独立发布节奏，不牵动 Nest
- 保留回退可能（虽然最终没走并存路线）

**负面 / 代价** ❗
- **vendor 同步是人工活**：上游发版要评估（规则：≥3 个 minor 版本触发季度评审）
- **两套包名并存**：`@lnkpi/*`（多数）与 `@pi-lnk/*`（pi-runtime / pi-poc），D-ε 统一决策至今未完成
- **版本号易混**：上游 tag `0.85.1` / vendor 内部号 `0.0.3` / 历史镜像 tag `0.0.1~0.0.41` 三套并存，
  需专门写查询规范（见 [`docs/agent/architecture.md`](../agent/architecture.md)「pi 内核版本」节）

**将来要注意**
- 若上游 API 出现破坏性变更，评估「换内核」的成本，**不要**在 vendor 里打业务 patch 硬扛
- pi 至今**无 subagent 支持**（全仓 0 命中），需要 subagent 时只能 L2 自建

## 关联

- 讨论文档：`docs/discussion/2026-09-19-pi-lnk-migration-discussion.md`
- 实现 spec：`docs/superpowers/specs/2026-09-19-pi-lnk-fast-ramp-k3s-design.md`
- 部署形态（K3s Day-1 Minimal）见该 spec 决策表
