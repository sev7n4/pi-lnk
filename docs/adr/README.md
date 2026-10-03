# ADR 目录说明

## 是什么

**ADR = Architecture Decision Record（架构决策记录）**，记录**「为什么这么定」**，
而不是「做了什么」。

- **该写 ADR**：有明确取舍、影响面跨模块、将来会有人问"当初为什么不用另一种做法"
- **不该写 ADR**：bug 修复、纯实现细节、可以一眼看懂的代码变更

判断标准：**半年后有人问"为什么是这样"，你希望有一条记录能直接回答吗？**

## 当前清单

| ADR | 状态 | 决策 |
|---|---|---|
| [0001-vendor-pi-as-kernel.md](./0001-vendor-pi-as-kernel.md) | Accepted | vendor pi 作为唯一对话内核，pin 上游 tag + 禁业务 patch |
| [0002-workflow-exchange-as-contract.md](./0002-workflow-exchange-as-contract.md) | Accepted | 工作流交换格式是对外契约，独立于内部实现长期保留 |
| [0003-prompt-registry-as-single-source.md](./0003-prompt-registry-as-single-source.md) | Accepted | 提示词走注册表资产（.md），禁止在代码里硬编码 |
| [0004-three-state-vision-capability.md](./0004-three-state-vision-capability.md) | Accepted | 视觉能力用三态函数声明，禁止正则猜测 |
| [0005-tool-tiering-official-dynamic-loading.md](./0005-tool-tiering-official-dynamic-loading.md) | Accepted | 工具分层对齐 pi 官方 Dynamic Tool Loading，不用自研索引块 |
| [0006-single-socket-transport-for-queue.md](./0006-single-socket-transport-for-queue.md) | Accepted | SSE 单连接 + lastEventId 续传，拒绝轮询/双通道 |
| [0007-deploy-tag-equals-commit-sha.md](./0007-deploy-tag-equals-commit-sha.md) | Accepted | 镜像 tag = master commit 短 sha，停用语义版号 |
| [0008-docs-index-over-doc-edits.md](./0008-docs-index-over-doc-edits.md) | Accepted | 283 份历史文档只建索引不改正文 |
| [0009-vendor-capability-first.md](./0009-vendor-capability-first.md) | Accepted | pi-runtime 开发必须先查 vendor 能力面，禁止自研等价物 |

## 模板

新建 ADR 时复制 `0000-template.md`，字段：

```markdown
# ADR-NNNN: <决策一句话>

| 字段 | 值 |
|---|---|
| 状态 | Proposed / Accepted / Superseded by ADR-XXXX |
| 日期 | YYYY-MM-DD |
| 决策者 | |

## 背景
什么问题逼出了这个决策？当时的约束是什么？

## 考虑过的方案
| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|

## 决定
我们选了什么。

## 后果
**正面**：获得了什么
**负面 / 代价**：付出了什么（❗ 诚实写，这比假装没有成本有用）
**将来要注意**：什么情况下应该重新审视这条决策
```

## 状态流转

`Proposed` →（讨论通过）→ `Accepted` →（被新决策取代）→ `Superseded by ADR-XXXX`

**ADR 一旦 Accepted 不删不改** —— 它记录的是当时的判断。后来变了就写新 ADR 并把旧的标为 Superseded。
这与 `superpowers/` 里的 spec/plan 不同：那些是活的设计文档，会随实现更新；ADR 是决策快照。

## 与其他文档的关系

| 文档类型 | 回答什么 | 会更新吗 |
|---|---|---|
| **ADR** | 为什么这么定 | 不更新（被取代就标 Superseded） |
| spec（`superpowers/specs/`） | 这次要做什么设计 | 会，随实现演进 |
| plan（`superpowers/plans/`） | 怎么一步步做 | 会，任务打勾 |
| [INDEX.md](../superpowers/INDEX.md) | 有哪些文档、什么状态 | 每次新增文档重跑 |

## 什么时候写

触发时机（不是事后补，是当时写）：

- 引入/替换一个核心依赖（如 vendor pi）
- 定义对外接口或交换格式
- 选择了一条"看起来绕但更稳"的路（如 tag 用 sha 不用语义版号）
- 拒绝了某个"更简单"的方案，且理由不 obvious
- 踩坑后确立了"以后禁止这样做"的纪律（如 cherry 在 squash 下不可靠）
