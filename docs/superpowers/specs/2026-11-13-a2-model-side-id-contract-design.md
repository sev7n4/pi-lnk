# A-2' · todo_write 模型侧 id 契约——实施规格

> 日期：2026-11-13 · 状态：**spec/plan 已落档，实施待单独授权**（代码刀纪律：CI 全绿停合并前等授权）
> 上位锚：路标规格 `2026-11-11-task-planning-engineering-roadmap-design.md` §11（十项语义裁决 + 三项拍板）+ §11.4（立项门禁）+ C-1 spec §8.6（前置观测判据）。
> 依赖链（§11.4）：C-1（§8.6 观测，资产已随 C-1b 落地）→ **A-2'（本刀）** → C-2（acceptance 引用稳定 id，依赖本刀，不并行）。

## 1. 立项门禁证据（§11.4：须引用 §8.6 观测基线数据或触发捷径证据）

**触发捷径成立——生产 identity 断裂实证（2026-11-13 全库只读取证）**：

- 数据面：`AgentEvent` type=tool_call 且 toolName=todo_write，生产全库 **53 条快照 / 6 线程 / 47 个相邻快照对**。
- **4 次 identity 断裂**（相邻快照对中「语义同项 content 微变」：启发式 sim≥0.5 + 人工核对全部成立），全部集中在线程 `cmwcxs37a00hhpa011rurftwg`，且全部发生在 in_progress 任务上：

| # | gSeq 对 | sim | 旧 content | 新 content | 形态 |
|---|---|---|---|---|---|
| 1 | 18364→19763 | 0.971 | 补全剩余2张核心图表（CAPEX对比图、DeepSeek影响力图） | 补全剩余2张核心图表（CAPEX对比图✓、DeepSeek影响力图⏳） | **进度符号写进 content** |
| 2 | 19763→20760 | 0.971 | （同上 ⏳ 形态） | （同上 ⏳→✓） | **进度符号写进 content** |
| 3 | 22196→22704 | 0.590 | 为《AI投资真相》视频生成完整旁白配音轨（约20分钟） | 为《AI投资真相》视频生成配音轨（已完成）+ BGM配乐轨（生成中） | 真实任务编辑（拆子任务） |
| 4 | 22704→23088 | 0.853 | 为《AI投资真相》视频生成配音轨（已完成）+ BGM配乐轨（生成中） | 为《AI投资真相》视频生成配音轨（进行中）+ BGM配乐轨（进行中） | **状态措辞写进 content** |

- 按现行 `reduce()` 语义（content 逐字匹配，`task-state.ts:43-50,55-56`），这 4 对全部触发：**旧 id 删除 + 新 id 新增 + structureChanged=list 事件 + 前端卡片抖动**——其中 3/4 是纯进度标注重写（任务语义完全未变），属系统性反模式（模型在 status 字段之外用 content 传进度细节）而非偶发。
- 断裂率 4/47 ≈ **8.5%**（快照对口径；编辑发生即断裂，无需多轮累积）——§8.6 触发捷径「断裂率异常偏高或真实误删形态」的前半句成立。
- 诚实边界：本样本 4 次均为 identity 断裂（旧任务语义全部存活），未观测到「误删」（任务真丢）——与 §11.2 裁决 7 的推证一致（断裂为主，误删是断裂的极端面）。

## 2. 现行语义基线（master `task-state.ts` 130 行 + `todo.ts` 117 行逐行核实）

- §11.1 表全部复核成立（content 唯一匹配续 id / content 一字之差即断裂 / 重复 content 第二次判新项 / 快照缺席项删除 / 纯重排零事件 / **模型侧 schema 无 id 且 renderTodoBlock 不渲染 id**）。
- 补充基线：`pickLatestSnapshot`（播种侧）**已按带 id 形态工作**（`task-state.ts:96` 要求 `typeof o.id === "string"`，无 id 快照条目被跳过）——A-2' 不动播种侧；系统侧内存 store 一直是 `TodoItemWithId`（id=plan-N 由 counter 分配，不回收）——**A-2' 只是把这个既有 id 透出给模型并让 reduce 优先消费**，无状态迁移问题。
- **模型 id 可见性（自我审核补强，2026-11-13）**：todo 动态块在 `session-manager.assembleDynamicBlocks`（`:2335-2349`）**每轮 LLM 请求重新求值**（store 非空即注入，非仅 compact 时）——renderTodoBlock 加 id 后模型**每轮都有稳定 id 视图**，首次引用无「必幻觉」问题；summarize 紧凑回执不带 id 的保留（拍板 3）与该可见性自洽。
- `propose_plan` 复用同一条写管道（`overwriteTodos`，C3 裁决「不做两步组合」）——schema 改动只动 `todo_write` 侧，propose_plan 的 steps schema **不加 id**（§5.4）。

## 3. 语义裁决落地（§11.2 十项逐条 → 实现形态）

### 3.1 schema（裁决 6）：`todos:[{id?, content, activeForm?, status}]`

`todo.ts` todoSchema 的 item 增可选字段：

```ts
id: Type.Optional(Type.String({
  description: "任务项 id（当前清单已存在的 plan-N）。变更已有任务时带上对应 id：身份保留，content 可改写（重命名）。新增任务省略 id。",
})),
```

- 只校验「存在于当前快照」，不锁 `plan-N` 格式（裁决 6 原文：runtime 未来换语义 id 无需动契约）。
- **类型面（自我审核补强）**：`TodoItem` 接口无 id——新增 `TodoItemInput = TodoItem & { id?: string }`；`reduce(next: readonly TodoItemInput[])` 与 execute params 类型同步（`TodoItemWithId` 输出形态零变化）。
- 工具 `description` 的第 4 条「内容一经提交请勿改写（字面匹配用于追踪状态）」同步改写为 id 语义（带 id 可改写重命名；未带 id 项 content 用于匹配）。工具 description 属 pi-runtime 动态侧（48k 预算），无 L2 硬线；见 §6 风险 1 关于 prompt-registry 点名文本。

### 3.2 reduce 语义（裁决 2/4）：id 优先，content 兜底

```ts
for (const item of next) {
  if (item.id !== undefined) {
    const matched = prevById.get(item.id);          // 幻觉 id 已在 execute 层硬拒，此处为防御分支
    if (matched && !usedIds.has(matched.id)) {
      usedIds.add(matched.id);
      out.push({ ...item, id: matched.id });        // 身份锁定：content 变 = 重命名，identity 存活
      if (matched.status !== item.status) updates.push(...);
      // content 变化 ⇒ structureChanged（list 事件），与裁决 5「带 id 重命名仍发 list」一致
    } else {
      structureChanged = true; out.push({ ...item, id: `plan-${counter++}` });
    }
  } else {
    // content 兜底（裁决 4，现行不变）：唯一匹配续 id / 多匹配取首个未占用 / 零匹配新项
  }
}
```

- `usedIds` 防双用保留；prevById 与 prevByContent 两索引并存。
- **重复 id 分界（自我审核补强）**：同一调用内两项带同一 id = usedIds 兜底域（裁决 2 原文「防双用保留」）——第二项判新项（非拒绝）；前置校验只拒「id 不存在于当前快照」（§3.3）。两域不重叠。
- **updates 互斥注**：重命名 + status 同变 ⇒ structureChanged ⇒ list（updates 空）——现行三分法互斥语义自洽，无需新分支。
- **dropped-incomplete 告警同步修**：现行按 content 判「未完成项从 next 消失」（`todo.ts:70-76`）——id 重命名场景旧 content 消失会误报；改为「按 id 或 content 都对不上才计 dropped」。

### 3.3 幻觉/已删除 id ⇒ 工具级硬拒绝（拍板 1）

`execute` 在调 `overwriteTodos` 前置校验：提交项中每个带 id 的 id 必须在当前快照 id 集内；否则返回：

```ts
return {
  content: [{ type: "text", text: `调用被拒绝：id 不存在于当前任务清单（${offending}）。当前合法 id：\n${snapshot 摘要（id+content+status 每行一项）}\n请带正确 id 重发，或对新增项省略 id。` }],
  isError: true,
};
```

- 不写入状态（拒绝调用零副作用、无 task_list 事件）——幂等。
- **校验键（自我审核补强）**：校验与 `overwriteTodos` 必须用同一 store 键（`toolContext.storeScopeKey ?? toolContext.sessionId`，C4 评审固化的取键约定）——子会话校验自己的作用域。
- `AgentToolResult{isError:true}` 契约已有真实失败先例与回归锁（`session-manager.toolmetrics-realharness.test.ts` 锁死 vendor→session-manager→ToolMetrics 错误维度穿透）。
- 错误回执必附完整合法 id 清单（防误伤设计，拍板 1 原文）；不做限流（单次自纠回路足够）。

### 3.4 renderTodoBlock 加 id（拍板 3）

`- [x] plan-3 content`（mark 与 content 之间插 id）。summarize 紧凑回执不带 id 的现行设计保留（裁决 3 残余风险条款：模型把 id 写进给用户看的回复属文本风格面，实测再调）。

### 3.5 事件不变面（裁决 5）：零破坏

list/updates/零事件三分法不动，不加新事件类型。带 id 重命名仍发 list（content 集合变化）⇒ 前端零改动。

### 3.6 边界（裁决 10）

id 不跨工具（子代理派发引用、assumptions 引用属后续刀 A-3）；不做 delta API；不做依赖排序。

## 4. 观测配套（§19 冻结拍板：A-2' 立项必含两项观测）

1. **§8.6 断裂率正式化**：A-2' 上线后 C-1b identity 追踪继续跑（只观测不计分），C-1c 基线档案记录「上线前 8.5%（4/47）→ 上线后」对比——价值证明闭环。
2. **硬拒绝自纠成功率**：todo_write isError 回执后模型下一轮重发是否成功。取证面 = tool-metrics（isError 维度已锁死）+ transcript 反查（同一 thread 内 isError 的 todo_write 之后是否存在带合法 id 的成功调用）。观测非阻塞，进 C-1c 基线档案。

## 5. 非目标（§11.2 裁决 10 + 冻结拍板）

- delta API / 增量 op（B 期另一刀，全量覆写红线不动）
- 依赖排序、跨工具 id 引用（A-3 assumptions[] 另立项）
- propose_plan 的 steps schema 加 id（**明确不做**：计划提议天然是新项集，加 id 反引入「计划项引用旧任务 id」歧义）
- 抬 STATIC_BUDGET_CHARS（AGENTS.md 红线第 3 条，须人工决策）
- C-2 acceptance（依赖本刀，后续单独立项）

## 6. 风险与工程约束

1. **L2 静态预算硬线（余量 3）**：`STATIC_BUDGET_CHARS=3200` 只计 prompt-registry 静态段（rules/*.md），**不含 pi-runtime 工具 description 本体**（走 48k 动态侧）——本刀改 `todo.ts` description 无硬线风险；但若同步改 `prompt-registry/rules/task_tool.md` 点名文本（如说明 id 语义），须等长置换或精简（当前 todoTools 组合 3197/3200，余量 3）。**默认不改 task_tool.md**（工具 description 已承载 id 语义，点名文本零改动 ⇒ loader.test 计数 12 不动、Nest 单元零改动）。
2. **模型行为漂移**：id 通道上线后模型可能幻觉 id（此前 schema 无 id 字段不会发生）——硬拒绝回执 + 单次自纠是设计内的第一反应（拍板 1 理由 ②：显式错误优于静默失败）。
3. **重复 content 歧义**（裁决 2）：带 id 但 content 撞另一 item ⇒ id 为准，另一项走新项路径——测试须覆盖。
4. **旧会话兼容**：内存 store items 本就带 id；propose_plan 播种快照（details.plan.steps）也带 id（pickLatestSnapshot 同构消费）——零迁移。

## 7. 测试（裁决 9 扩展）

- 回归锁：task-state.test.ts 实际 17 例（裁决 9 写 13 例系拍板时点数字；含 P1-2 propose_plan 播种 5 例）+ todo.test.ts 5 例全绿；renderTodoBlock 行格式断言随拍板 3 同步更新（`[x] plan-1 起稿` 形态，含 session-manager.todo-resume.test.ts 集成断言）。
- 新增七例：①重命名保 id（content 变、id 存活、发 list）②幻觉 id 硬拒绝（isError + 回执含合法清单 + 零副作用）③部分 id + content 兜底混合 ④重复 content + id 消歧 ⑤usedIds 防双用保留（含同调用重复 id 判新项）⑥renderTodoBlock id 渲染 + dropped 告警重命名不误报 ⑦双项交换重命名仍发 list（变异自检补口：删除检测不触发场景，updates 会让前端漏刷 content）。
- **变异自检实录（守卫纪律）**：变异「重命名不置 structureChanged」首轮逃逸（删除检测兜底掩盖）⇒ 暴露 ⑦ 真实缺口并补测试转 RED；变异「id 匹配后回填旧 content」抓到 4 例 RED。恢复后 23/23 绿。
- L0 全量 eval 121/121 绿（golden-cases.test 断言消费 details 快照，details 形态不变）；pi-runtime 全量 1811+新例全绿（本机 0.85.1 运行时；isError 已核 0.99.2 类型定义存在，语义=「model sees content as an error result, like a thrown error」）。

## 8. 部署面

- 改动文件全部在 `services/pi-runtime`（todo.ts / task-state.ts + 测试）⇒ **deploy.yml 不含 services/pi-runtime ⇒ 合并后须手工 dispatch `runtime-deploy.yml`**（走 reviewer API 审批，#858 先例）。
- apps/server / 前端 / prompt-registry 零改动 ⇒ Nest 单元零发布、无 CI master run（ci.yml 触发面不含 services/pi-runtime）——权威证据=PR CI 全绿 + 合并树==head 树。
- 生产复测（合并部署后）：①§8.6 断裂观测 + 硬拒绝自纠成功率建档（§4）②真实多轮会话冒烟：todo_write 重命名场景 id 存活取证。

## 9. 状态与验收门

| 项 | 门 |
|---|---|
| 实施 | 本 spec + plan 授权后开工（单独授权纪律） |
| 合并 | CI 全绿 + 停合并前等授权 |
| 上线 | 合并树==CI head 树 + 手工 dispatch runtime-deploy + reviewer 审批 |
| 闭环 | 生产复测 §4 两项观测数据落 C-1c 基线档案前，勿宣告 ALL_PASS |

## 9. 审核补遗（2026-11-13，PR #863 review Important #1 修复）

- **删除检测升级为身份判定**：`reduce()` 删除检测由「content 集合启发式」改为 `prev.some((p) => !usedIds.has(p.id))`——prev 项存活当且仅当被某 next 项认领（id 通道或 content 兜底均写入 usedIds）。动机：重复 content 场景「按 id 删其一」（id 契约新使能的模型表达）在旧启发式下被静默吞掉（无 list 无 updates，store 保留全部项，回执与提交自相矛盾）。非重复场景与旧启发式逐场景等价（重命名/纯删/混合，审核代理逐场景核对）。
- 补测试 ⑧（按 id 删其一发 list）+ ⑧b（content 兜底认领重复项其一后另一项发 list）；变异自检「删除检测退回 content 启发式」RED（2 fail）→ 恢复 GREEN。全量 1814/1814 绿。
- Minor 留观测：拒绝回执「清单为空」分支无测试（路径平凡）；renderTodoBlock 行内 id 与 content 视觉粘连（content 以 plan-N 开头时，概率低，自纠回路兜底）。
- 审核裁定 Declined-to-judge 清单（均先于本 PR 存在或 spec 明文排除，executor 认可不动）：propose_plan 取键一致性（tc.sessionId vs storeScopeKey）、播种侧 pickLatestSnapshot 丢弃无 id 快照（§2 明文）、TodoSessionState.counter 死字段、content 兜底新项路径透传附加属性、todos 无 min/max 约束、行内 id token 成本（§4 观测）、硬拒绝自纠成功率（部署后建档）。
