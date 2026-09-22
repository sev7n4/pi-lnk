# PI-Lnk 项目 Agent 开发规范

本项目 fork 自 [lnkpi](https://github.com/your-org/lnkpi)，
目标是**把内核从自研 LangGraph Runtime + 自研 `@lnkpi/agent` 切换到 [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) v0.85.1**。

## 当前阶段：PoC 验证 → Phase 0 启动

讨论与规格阶段已完成：

- **第一资产（讨论文档 v1.3）**：[`docs/discussion/2026-09-19-pi-lnk-migration-discussion.md`](./docs/discussion/2026-09-19-pi-lnk-migration-discussion.md)
  （§1–§11 主文 + 附录 A：A.4 业界先例 / A.5 目标架构借鉴蓝图 / A.6 落地方案草图）
- **实现侧 spec（Final v1.0）**：[`docs/superpowers/specs/2026-09-19-pi-lnk-fast-ramp-k3s-design.md`](./docs/superpowers/specs/2026-09-19-pi-lnk-fast-ramp-k3s-design.md)
  （16 章，Fast-Ramp Atomic-First + K3s Day-1 Minimal，P0+P1 硬截止 30 天）

当前任务：**N2 PoC spike**（5 天 timebox，验收 5 条见 spec 关联讨论文档 A.6），通过后进入 Phase 0（vendor pi + services/pi-runtime）。

## 核心规则（继承自 lnkpi）

- 任何创造性工作前 → `brainstorming` skill
- 任何 bug / 异常 → `systematic-debugging` skill
- 提交前 → `verification-before-completion` skill
- 写实现计划 → `writing-plans` skill
- 分支管理 → `using-git-worktrees` skill

## 已拍板决策（以 spec v1.0 为准）

详细版见 spec 第 3 章决策表；与讨论文档 §10 的差异：**D-α' 替换 D-α（K3s Day-1 Minimal）、D-β' 替换 D-β（Fast-Ramp Atomic-First，8 周 → 5-6 周，marketing 移出 v1.0）**。

| ID | 决策 |
|---|---|
| D-α' | pi-runtime 部署形态：**K3s Day-1 Minimal**（替换原 D-α 独立 Node 服务） |
| D-β' | 迁移策略：**Fast-Ramp Atomic-First**（先攻最难的 atomic，P0 shadow ≥7 天 + 7 项 KPI；marketing 移至 v1.1） |
| D-γ' | pi 版本控制：**vendor 到 monorepo**（`vendor/earendil-works/pi/`，pin v0.85.1 + patch 流程） |
| D-δ' | OAuth 接入：**v1.0 默认关闭**（v1.1 解锁条件见 spec） |
| D-ε | 项目命名：**PI-Lnk**（包名 `@pi-lnk/*`） |
| D-ζ' | 老 LangGraph Runtime：**保留 30 天回退开关**（4 级回退 + 归档） |
| D-η' | 自研 `@lnkpi/agent`：**部分保留**（纯函数工具保留，12 个 prompt-mode 全删 → slash command + skill） |

## 仓库结构（monorepo 已有代码）

```
pi-lnk/
├── apps/
│   ├── server/          # @lnkpi/server —— NestJS 服务端（pi-runtime 的宿主入口，F7 ProviderContext 所在）
│   └── web/             # Vue 3 前端
├── packages/
│   ├── agent/           # @lnkpi/agent —— 自研 agent（D-η'：纯函数工具保留，prompt-modes 删除）
│   └── shared/          # 共享包
├── services/
│   └── agent-runtime/   # 旧 LangGraph Runtime（Python，D-ζ' 保留 30 天回退后归档）
├── deploy/              # 部署脚本与配置
├── docs/
│   ├── discussion/      # 讨论文档（第一资产，v1.3）
│   └── superpowers/specs/  # 实现 spec（Final v1.0）
└── scripts/
```

> **注意**：pi 尚未 vendor（Phase 0 动作）。PoC spike 在独立分支/worktree 进行，不污染主干。
> 讨论文档 A.6 重要校准：**pi v0.85.1 无 subagent 支持（全仓 0 命中）**，subagent 需 L2 自建（嵌套 Agent 实例或复用 Lane），HITL 挂点用 `before_tool` hook，上下文注入用 `transform_context`。
