# B-2 · 任务契约一等化（CustomEntry 账本单源）实施计划

> 立项基座：`docs/superpowers/specs/2026-11-15-b123-upstream-primitives-design.md` §2（裁决继承：不做 delta API、不 patch vendor、32KB 上限、SSE 双轨观察期）。
> 本 plan 是 §2 的实施细化，含 2026-11-16 上游 API 复核取证与**方案收缩裁决**。

## 0. 摘要

把任务契约（todo 快照 / plan decision）的 transcript 写入从「toolResult details 的副作用」升级为 **`appendCustomEntry("lnkpi.task", …)` 一等写入**，读取侧 `pickLatestSnapshot` / `pickLatestPlanDecision` 以 customType 为**首选源**、toolResult details 反扫降级为观察期 fallback。模型视图注入路径**零改动**（C1 §3.4 每轮 systemPrompt 重求值已跨压缩存活）。

## 1. 现状架构取证（2026-11-16 @ master `cd5da2c1`）

### 1.1 已解决的部分（不重做）

| 环节 | 现状实现 | 位置 |
|---|---|---|
| 模型视图跨压缩 | systemPrompt **每轮重新求值**，动态块实时读内存 store，store 非空即注入 todo 块（独立预算 5%） | `session-manager.ts` `assembleDynamicBlocks` → `composeEntryAndObserve` |
| 进程重启重建 | 重连/重启时 `lane.findEntries({oldestFirst})` 全 ledger 反向扫描播种（`pickLatestSnapshot` / `pickLatestPlanDecision`） | `session-manager.ts:1503-1514` |
| compaction 读取无碍 | `findEntries` 返回 **ledger**（实测可读 `type:"compaction"` entry）⇒ cut 前条目仍可反扫 | `session-manager.ts:1916-1920` 佐证 |

⇒ 基座 §2 假设的「compaction 后投影易失」对**模型视图**与**进程内重建**两条路均已被 C1 §3.4 化解。**EntryProjector 注册（模型视图投影）不再需要**——避免历史 custom entry 逐条投影堆积上下文，方案据此收缩。

### 1.2 真实缺口（本刀净增量）

1. **写入形态脆弱**：重建源 = toolResult `details` 的**副作用**，需三层防御式兼容（`{toolName,details}` / `{result:{details}}` / `{message:{…}}` 包裹层）——vendor entry 形态漂移即断。症状史：P1-2（spec 2026-11-11-propose-plan-visibility-design.md §8）propose_plan 经 overwriteTodos 落清单**不写 todo_write transcript 条目**，重启后任务卡消失，被迫加 P0 形态兜底 `details.todo.snapshot` / `details.plan.steps`。
2. **非单源**：plan decision / todo 快照的 SSOT 名义上是 transcript，实际是「工具返回值的偶然形态」；进程内 store（`todo.ts:35`、`plan-gate.ts:22` 的 Map）是运行态缓存，无一等账本记录。

## 2. 上游 API 取证（vendor 0.99.2 @ node_modules）

| 原语 | 签名 | 位置 |
|---|---|---|
| `appendCustomEntry` | `(customType: string, data: JsonValue \| undefined, context: Context) => Promise<string>` | `agent-harness.d.ts:642`、`runtime/lane.d.ts:111`、`session/types.d.ts:443`（harness / lane 双入口） |
| `EntryProjector` | `(entry: CustomEntry, context: Context) => AgentMessage[] \| undefined \| Promise<…>` | `session/types.d.ts:50`；注册于 `AgentHarnessOptions.entryProjectors: Record<string, EntryProjector>`（`agent-harness.d.ts:634`） |
| 投影行为 | `buildSessionContext` 对 custom entry 按 `entryProjectors[entry.customType]` 投影，未注册则跳过（模型不可见） | `session/context.js` `buildSessionContext` |
| compaction 截断 | `buildContextEntries`：compaction 后视图 = `[compaction entry, ...之后 entries]`——**cut 前 custom entry 不进模型视图**（但留 ledger） | `session/context.js` `buildContextEntries` |
| cut point | custom entry 是合法 cut point；`getMessageFromEntryForCompaction` 对 custom 不进摘要消息与 retainedTail | `compaction/compaction.js:54,205-228` |

**结论**：`data` 是自由 JSON（零 vendor 改动）；ledger 天然被 fork/resume/compaction **账本级**携带（视图级截断不影响 `findEntries` 反扫）；投影 API 本刀不用。

## 3. 设计

### D1 写入一等化（after_tool wiring 挂点）

`plan-gate-wiring.ts` 既有 `after_tool` 挂点扩展：`toolName ∈ {todo_write, propose_plan}` 且执行成功时
`harness.appendCustomEntry("lnkpi.task", payload, context)`。

payload 形态（自由 JSON，版本化）：

```jsonc
{
  "v": 1,
  "kind": "todo" | "plan",
  "snapshot": TodoItemWithId[],        // kind=todo，或 propose_plan execute 落的清单
  "decision": "keep" | "execute",      // kind=plan（propose_plan 终态）
  "diff": { added, removed, statusChanged }  // 服务端已派生（todo.ts overwriteTodos 返回），直传
}
```

- 写入失败 **fail-open**（console.warn + metric），不阻断 run——账本写入是增强不是正确性依赖。
- 复用 `after_tool` 而非改工具层：不动 `todo.ts`/`propose-plan.ts`，wiring 层统一挂（`details` 已在 event 里，`context` 可达 harness）。

### D2 大小上限

payload 序列化超 **32KB** ⇒ 截断快照至可容纳的最新条目数 + 打点 `pi_runtime_task_entry_truncated_total`（counter，带 `kind` 标签）。防 transcript 膨胀，截断可观测。

### D3 读取单源化（首选 custom，fallback 反扫）

`task-state.ts` `pickLatestSnapshot` 与 `plan-gate.ts` `pickLatestPlanDecision` 增加识别：

1. **首选**：`entry.type === "custom" && entry.customType === "lnkpi.task"` → 按 `kind` 取 `snapshot` / `decision`（`v !== 1` 忽略并 warn）。
2. **fallback**：现有 toolResult details 三层反扫**原样保留**（观察期；退场判据见 §5）。
3. 反向扫描「最新条目胜出」语义不变：custom 与 toolResult 混存时按 ledger 时间序取最后一条命中。

### D4 观测

- `pi_runtime_task_entry_total{kind="todo"|"plan"}`：一等写入计数。
- `pi_runtime_task_entry_truncated_total{kind}`：截断计数。
- 复用既有 `pi_runtime_toolset_gate_narrow_total`（B-1）不动。

### D5 明确不做（No-Go 继承 + 收缩裁决）

- ❌ EntryProjector 注册（模型视图投影）——§1.1 已证不需要；注册反而引入历史堆积。
- ❌ delta API / vendor entry 结构改动。
- ❌ 动 SSE/UI 投影通道（Nest 侧任务卡有自己的事件流，双轨观察期不对 UI 做切换）。
- ❌ 模型视图注入路径改动（assembleDynamicBlocks / dynamic-budget 零触碰）。

## 4. 验收锚

1. **compaction 前后重建一致**：单测构造 ledger（todo_write → 若干轮 → compaction entry → 更多轮），rehydrate 后 snapshot 与 compaction 前最新一致。
2. **fork/resume 单源重建**：custom entry 在 ledger，反扫含 custom 分支后 restart 播种不再依赖 toolResult 形态。
3. **写入可观测**：mock harness 断言 `appendCustomEntry` 调用形态（customType/payload/失败 fail-open）。
4. **截断守卫**：>32KB payload 断言截断 + metric。
5. 全量 `node --import tsx --test` + `tsc --noEmit` + 变异自检（砍 after_tool 写入分支 / 砍 pickLatest custom 分支各须 RED）。

## 5. 诚实边界

- **双轨观察期退场判据**：生产 ledger 中 custom entry 连续覆盖 ≥7 天窗口内全部 todo_write/propose_plan 终态（抽样 `findEntries` 机检）后，才允许删 toolResult details fallback。观察期内两源不一致时**打点不告警**（`pi_runtime_task_entry_mismatch_total`），人工裁决。
- payload 内 snapshot 为**全量覆写**（C1 语义），账本体积随写次数线性增长——32KB 单条上限兜底单条，不清历史（ledger 压缩交给 vendor compaction 生命周期，不在本刀自作主张清理）。
- 触发面含 plan-gate-wiring（B-1 刚上线）——本刀合入后 B-1 生产观测（`toolset_gate_narrow_total`）基线重新对齐一次。
