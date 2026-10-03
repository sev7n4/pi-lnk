# ADR-0002: 工作流交换格式是对外契约

| 字段 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-07-09（首版）/ 2026-10-03 补录 |
| 决策者 | 项目发起人 |

## 背景

外部 AI Agent（WorkBuddy、Codex 等）需要把「一段工作流」导入 pi-lnk 画布。
这要求一个**交换格式**：外部能生成，pi-lnk 能校验并渲染成节点。

关键问题：这个格式是**内部实现细节**，还是**对外承诺的契约**？

2026-10-03 清理 `docs/` 时差点把它连带删掉（当时 `adr/`、`mockups/` 等三个目录被删），
这次补录正是为了把"它不能删"这个判断固化下来。

## 考虑过的方案

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| 内部类型随手定义 | 快 | 外部无法稳定对接，格式一改就炸 | ❌ |
| **独立交换格式 + 校验函数 + 示例**（选中） | 外部可依赖、可验证 | 格式演进需要兼容策略 | ✅ |
| 直接复用画布内部 schema | 无额外维护 | 内部重构必然破坏外部 | ❌ |

## 决定

1. **独立于内部实现**：`docs/workflow/README.md` 定义格式，**不随内部重构而变**。
2. **校验函数公开**：`@lnkpi/shared` 的 `validateWorkflow`，
   消费方包括 `useWorkflowExchange.ts`（web）、`compositionLint.ts`（shared）、`agent-canvas-tools.service.ts`（server）。
3. **必须带可运行示例**：`docs/workflow/examples/minimal-workflow.json`（2 节点 1 边轻量版）、
   `recipe-planner-eval.json`。
4. **与 `export_pack` 导出路径保持一致** —— 导入与导出必须往返对称，否则用户会导出去却导不回来。

## 后果

**正面**
- 外部 Agent 有稳定接入点，不受我们内部重构影响
- 有校验函数 + 示例，接入方能自测
- 双向对称（导入 ↔ 导出）

**负面 / 代价** ❗
- **格式演进必须维护向后兼容** —— 这是对外承诺的代价
- 删除 `docs/adr/` 那次差点误删它，说明"契约"没有物理标记，容易被当成普通文档清理

**将来要注意**
- 改这个格式前，先确认是否需要升版本号，而不是直接改
- 清理 `docs/` 时，`workflow/` 与 `prompt-registry/` 同属**不可删**资产

## 关联

- 格式定义：`docs/workflow/README.md`
- 实现：`packages/shared/src/canvas/workflowExchange.ts`、`compositionLint.ts`
