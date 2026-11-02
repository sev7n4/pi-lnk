# SP-E · 画布并发写入底座（canvasVersion CAS）设计规格 v1

> ⛔ **本规格已作废（2026-11-02）。** 请阅读 [v2](./2026-11-02-sp-e-canvas-write-cas-design-v2.md)。
>
> 作废原因：v1 取证于 P1-C 写路径治理（C0/C1a/C1b/C2a，#667~#670）落地之前，
> 其收益主体（用户整块 PUT）已进入弃用期（`canvas_put_deprecated` 打点，C2② 计划关闭），
> 契约对象、写者矩阵、rebase 重放表、文件清单均与 `d407ad98` 实况不符。
> v2 的核心修正（含 agent 侧「观测替代拒绝」）见 v2 §0 变更摘要表。
>
> v1 的 CAS 原语 / 迁移方案 / bump 守卫三块骨架由 v2 保留。

---

以下为 v1 原文（仅存档，不再评审）：

状态：待评审（brainstorming 产出，2026-10-28）
前置：SP-A 批量布局（已上线）/ SP-B 对齐（已上线）/ SP-C 视口恢复（已上线）/ SP-D 连线校验（已上线，#610 + ADR-0014）
分支约定：实现走 feature 分支 + PR + squash merge；本轮**同时动后端与前端**，须走 `prisma migrate deploy`。

> 范围声明：本规格是 SP-E 的**第一子项**（并发写入底座）。原路线图的 SP-E 含「canvasVersion CAS + stage 暂存 UI + 校验对齐 + 回合 checkpoint」，本轮只做 CAS 与冲突可观测，其余拆为后续子项（见 §12）。

## 1. 目标

1. 不再发生「客户端用旧版本整块覆盖服务端新版本」：携带过期 `expectedVersion` 的 `PUT /sessions/:id` 返回 409 且不落库。
2. 冲突不再静默：每次 CAS 失败产生冲突计数与日志（`sessionId / surface / expected / actual`）。
3. 新增写 canvasData 的落点不会漏掉版本 bump：静态守卫测试转红。

（其余章节从略——事实基础已被 v2 §3 重取证取代，全文见 git 历史该文件的前一版本。）
