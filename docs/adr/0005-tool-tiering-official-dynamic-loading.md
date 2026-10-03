# ADR-0005: 工具分层对齐 pi 官方 Dynamic Tool Loading

| 字段 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-10-01（PR #100） |
| 决策者 | 项目发起人 |

## 背景

pi-runtime 里有 38+ 个工具 schema。原先的处理方式（自研方案）：

- 把"延迟工具名单 + 索引块"塞进 system prompt
- 让模型看到"需要某能力时先调load_tools"

生产 E2E 实证（0.0.29 / 0.0.30 两版）**这个方案是失败的**：

- 弱模型**无视引导直接调延迟工具**（名字就摆在 prompt 里）
- 于是吃 vendor 硬编码的 `"Tool X is unavailable"`，**且无恢复路径**
  （host 无法拦截：vendor `drive/tools.ts:686` 只把 active 工具传进 `prepareToolCall`，
  `before_tool` hook 在其后）
- 结果：模型放弃、请求静默失败

## 考虑过的方案

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| 全量 schema 进 prompt | 简单、模型全知道 | 随工具数单调增长，压缩砍不掉 | ❌ |
| 自研索引块 + load_tools（**已试过，失败**） | 理论上省token | 弱模型无视引导，且不可恢复 | ❌ |
| **对齐pi 官方 Dynamic Tool Loading**（选中） | 用vendor 原生能力，host 不 hack | 依赖 vendor 版本 | ✅ |

## 决定

1. **全部工具注册进 `config.tools`**，但**只有常驻集进 `activeToolNames`**。
   延迟工具"存在但不在 active"，vendor 不会把它们传给 provider。
2. **`load_tools` 的结果携带名单**，由 vendor 的
   `AgentToolResult.addedToolNames` → `tool-placement.ts` 自动并入 `activeToolNames`
   并广播 `config_update`，**自该转录点起持续可用**。
3. **host 不碰运行态**：不做"拦截 + 改写 active 名单"这类 hack。
4. 常驻集清单要**按实际使用频次**维护，而非拍脑袋。

## 后果

**正面**
- 弱模型不会再"看到名字就调"然后吃 unavailable —— 因为它根本看不到延迟工具的 schema
- 机制由 vendor 维护，upmerge 时跟着走
- 不需要在 host 侧 hack，减少与vendor 的耦合

**负面 / 代价** ❗
- **依赖 vendor 0.0.31+ 的该模式**（0.0.29/0.0.30 教训的直接来源），换版本需重新验证
- 工具数继续增长时，常驻集要重新划线（这是持续的维护成本）
- 需要理解 vendor 的 `config.tools` / `activeToolNames` 两层语义

**将来要注意**
- 升级 pi 版本时，**重点回归工具分层** —— 这是已知易碎点
- 新增工具时明确归入常驻还是延迟，别都塞进常驻
- `before_tool` hook 在 `prepareToolCall` **之后**，别指望它拦"调了不该调的工具"

## 关联

- PR：#100（对齐官方模式）、#102（tool_search metrics 观测）
- 实现：`services/pi-runtime/src/tools/tiering.ts`、`config.ts`
- 前置上下文：ADR-0001（vendor pi 作为内核）
