# PI-Lnk

> **PI-Lnk** — 把当前 lnkpi 项目的画布 / Studio / 侧栏业务能力 + 工具能力，与 [earendil-works/pi](https://github.com/earendil-works/pi) 的 agent core 内核组合在一起的下一代产品。

## 这是什么项目

PI-Lnk 是 **lnkpi 的 fork**，但**内核从自研 LangGraph Runtime + 自研 `@lnkpi/agent` 切换到 `@earendil-works/pi-agent-core`**。

目标：
- 释放 pi 的极简 agent core（agent loop ~857 行 / Agent class ~607 行）+ skills 系统 + sessions 系统 + tool proxy + 插件 / skills / package 生态
- 保留 lnkpi 已有的全部业务能力：无限画布、Studio、RefChip、Vision Provider、侧栏素材、Skill 选择器
- 砍掉 26000+ 行自研 runtime / harness 代码，让商业化演进不再被自研工程债务卡住

## 项目状态

| 维度 | 状态 |
|---|---|
| 仓库初始化 | ✅ 完成（2026-09-19） |
| 内核选型 | ✅ `@earendil-works/pi-agent-core` v0.85.1 |
| 业务能力迁移范围 | 待评估（见 [讨论文档 §6](./docs/discussion/2026-09-19-pi-lnk-migration-discussion.md)） |
| 第一个 spec / plan | ⏳ 未开始（讨论先行；按用户指示暂不写 spec / plan） |

## 第一个资产

[📄 **docs/discussion/2026-09-19-pi-lnk-migration-discussion.md**](./docs/discussion/2026-09-19-pi-lnk-migration-discussion.md)

这是 PI-Lnk 项目的**第一份正式文档**，记录了：
- 7 个核心决策（已拍板）
- 当前 lnkpi agent 栈的分层拆解（LOC + 职责）
- earendil-works/pi 的真实架构（基于源码，不是基于文档宣传）
- 层 ↔ 包 映射 + 改动矩阵
- F1–F9 + 9 spec 能力覆盖分析
- 复杂度评估 + 影响分析 + 风险与回退

## 后续路径

按用户当前指令：
- ❌ 不写 spec
- ❌ 不写 plan
- ✅ 持续讨论、拆解、可行性 / 复杂度 / 影响分析
- ✅ 等讨论收敛后再进入 spec / plan 阶段
