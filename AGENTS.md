# PI-Lnk 项目 Agent 开发规范

本项目 fork 自 [lnkpi](https://github.com/your-org/lnkpi)，
目标是**把内核从自研 LangGraph Runtime + 自研 `@lnkpi/agent` 切换到 [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) v0.85.1**。

## 当前阶段：讨论 / 拆解 / 可行性 / 影响分析

**严禁未经授权写代码或开分支**。当前阶段任务：阅读并基于
[`docs/discussion/2026-09-19-pi-lnk-migration-discussion.md`](./docs/discussion/2026-09-19-pi-lnk-migration-discussion.md)
进行讨论与拆解，**不写 spec / plan**（用户当前明确指令）。

## 核心规则（继承自 lnkpi）

- 任何创造性工作前 → `brainstorming` skill
- 任何 bug / 异常 → `systematic-debugging` skill
- 提交前 → `verification-before-completion` skill
- 写实现计划 → `writing-plans` skill
- 分支管理 → `using-git-worktrees` skill

## 已拍板的 7 个决策

详见讨论文档 §10。简要：

| ID | 决策 |
|---|---|
| D-α | pi-runtime 部署形态：**独立 Node 服务** |
| D-β | 迁移策略：**Strangler-fig**（先 chat/explore → atomic → marketing） |
| D-γ | pi 版本控制：**vendor 到 monorepo**（`vendor/earendil-works/pi/`） |
| D-δ | OAuth 接入：**默认关闭** |
| D-ε | 项目命名：**PI-Lnk**（包名 `@pi-lnk/*`） |
| D-ζ | 老 LangGraph Runtime：**保留 30 天回退开关** |
| D-η | 自研 `@lnkpi/agent`：**部分保留**（纯函数工具保留，prompt-modes 删除） |

## 仓库结构（当前最小骨架）

```
pi-lnk/
├── README.md                                              # 项目简介
├── LICENSE                                                # MIT
├── AGENTS.md                                              # 本文件
├── .gitignore
└── docs/
    └── discussion/
        └── 2026-09-19-pi-lnk-migration-discussion.md      # 第一资产（讨论文档 v1）
```

> **注意**：当前仓库还是空骨架，尚未 vendor pi、尚未创建 monorepo 工作空间、尚未实现任何代码。
> 按用户指令，**讨论完成后再开始实质开发**。
