# B-1/B-2/B-3 上游原语移植三刀 — 立项规格

- **状态**：设计稿·待评审（路标 v1.3 冻结后的细化产物；docs-only，未 commit / 未推 PR）
- **归属**：任务管理工程主线 → 阶段 B「吃满上游」→ §7 立项队列第 3 项（B-4 已合 #867，本三刀为队列剩余）
- **上游锚**：路标 §5.2 阶段 B①②③；§18.1 支柱① 半缺口；vendor `earendil-works/pi` **0.99.2**（干净树核实，2026-11-15）

---

## 0. 摘要

路标缺口 **G3「上游原语未吃满」**。三原语在 vendor 0.99.2 全部存在，本项目消费度呈「1/3 已吃」：

| 原语 | vendor 锚（0.99.2 实测） | 项目现状 |
| --- | --- | --- |
| `lane.setActiveTools(toolNames, ctx)` | `coding-agent/src/core/extensions/loader.ts:424`、`types.ts:507`（declared set = 模型可见集） | ✅ 已消费但仅子代理工具集（`session-manager.ts:3280`）；**门禁态只读切换未用** |
| `appendCustomEntry(customType, data)` | `coding-agent/src/core/session-manager.ts:1290`（CustomEntry 落 transcript，父子链 + leaf 前推） | ❌ 零消费 |
| tool 级 `promptSnippet` / `promptGuidelines` | `agent-session.ts:3462-3475`（收集 `_toolPromptSnippets/_toolPromptGuidelines`）→ `system-prompt.ts:21-22`（`toolSnippets`/`toolGuidelines` 独立承载段） | ❌ 零消费（工具引导全在 prompt-registry 条文，L6 余量贴线） |

三刀各自独立 spec→plan→implementation；本文件是三刀的共同立项基座（现状锚 + 边界 + 共同裁决）。

---

## 1. B-1 · 门禁态工具声明集收缩（setActiveTools 只读切换）

**动机**：plan-pending / 生成等待期间，写工具仍 declared → 模型看得见、调了被 before_tool 拦 → 浪费一轮调用 + 拒绝回执噪声。声明集收缩让模型**根本看不到**写工具，结构性减少无效回合。

**设计要点**：
1. `plan-gate` 进入 `pending` 时：`setActiveTools(当前集 − 写工具)`；`execute/keep/timeout/aborted` 终态时还原（幂等，防泄漏）。
2. **与 tiering 的 SSOT 冲突是本刀最大风险**：`tools/tiering.ts` 注释自认「与官方 wrapper 的 setActiveTools 差集通道等价」——两通道同写 declared set 会互相踩。裁决：**tiering 保持唯一持有者**，plan-gate 通过 tiering 暴露的「门禁态 overlay」声明收缩，不直接调 `lane.setActiveTools`（单写者纪律）。
3. prompt cache 代价：声明集变化使前缀失效（上游 driver 注释：跨工具集 cache_read 不可比）。门禁态是短窗（等用户确认），cache 打散可接受；**常规轮次不切**（仅门禁进出两刀）。
4. fork 还原陷阱既有注记（`session-manager.ts:620`：fork 带来源会话全量 lane config）——还原路径必须以 fork 后快照为准，不得跨会话还原。

**验收锚**：pending 期模型 transcript 无写工具 schema；终态还原后全量恢复；tiering 状态机测试全绿；cache 中断仅发生在门禁进出。

## 2. B-2 · 任务契约一等化（appendCustomEntry 注入）

**动机**：当前任务契约（todo snapshot / plan decision）靠**事件投影 + prompt 注入**两路旁路承载；compaction 后投影易失（交付清单「compaction 存活」证据至今欠 8 项中的关键项）。CustomEntry 落 transcript 本体，天然被 compaction/fork/resume 携带。

**设计要点**：
1. `todo_write` / `propose_plan` execute 落 snapshot 后 `appendCustomEntry("lnkpi.task", { snapshot, diff, decision? })`——一次注入，消费端（EntryProjector 族，vendor `session-backends/sqlite-node`）按 customType 投影回任务卡。
2. **不做 delta API、不改 entry 结构**（路标 No-Go：patch vendor）；CustomEntry.data 是自由 JSON，零上游改动。
3. 与既有 SSE 投影双轨并行一个观察期（投影层读 transcript 而非内部 store），验证一致后切换 SSOT。
4. 大小上限：snapshot 超 32KB 截断打点（防 transcript 膨胀），截断可观测。

**验收锚**：compaction 前后任务卡重建一致；fork/resume 后 snapshot 可从 transcript 单源重建；`pnpm verify-claims` 级机检守卫扫全目录。

## 3. B-3 · 工具引导下沉（promptSnippet/promptGuidelines）

**动机**：工具使用引导目前是 prompt-registry 规则条文（全局 L6 预算贴线，曾实测余量 25 字符）——**工具面变化时条文不跟随**，正是 B-4 定位的「规范-实现漂移」结构性根源。上游 tool definition 级 `promptSnippet`（一行摘要）/`promptGuidelines`（要点列表）随工具集自动增删、按段承载（`toolSnippets`/`toolGuidelines` 独立 section），不占 L6。

**设计要点**：
1. 先迁 3 个试点工具：`todo_write`、`propose_plan`、`ask_user`（C1-C3 自建核心，纪律条文最重）；每刀迁移量 = prompt-registry 对应条文的**删除量**（等量置换，L6 只减不增）。
2. 迁移判据：条文内容逐字搬运到 `promptGuidelines`，prompt-registry 删原条文；`prompt:lint` 实测余量上升可机检。
3. 分层纪律不变：跨工具通用纪律（如「全量覆写」）留 prompt-registry/Skill；**工具专属**引导才下沉。

**验收锚**：试点 3 工具的 registry 条文清零；L6 余量实测上升（机器数）；C-1 相关 case 行为跑批不退化（判据全绿）。

---

## 4. 三刀共同裁决

- **D1 顺序**：B-3 → B-1 → B-2。理由：B-3 零运行时风险（纯引导搬运）先拿 L6 余量；B-1 风险中（声明集切换）需 tiering 协议先行；B-2 依赖 B-1 后的门禁态稳定（CustomEntry 注入点在 execute 内，与 B-1 的 pending 态同窗口）。
- **D2 单写者**：declared set 唯一持有者 = tiering；CustomEntry 唯一写入点 = 工具 execute 内；prompt 段唯一来源 = tool definition。三处都不建第二条写通道。
- **D3 上游升级兼容**：三刀全部走 0.99.2 既有 API 面，不 patch vendor；1.0.0/`pi-durable` 迁移映射（阶段 C③）落地时本三刀 API 面纳入映射表核验清单。
- **D4 观测**：B-1 打 `pi_runtime_toolset_gate_narrow_total`；B-2 打 `pi_runtime_task_entry_append_total`（含 truncated）；B-3 以 prompt lint 余量数为准（复用既有机器数，不加指标）。

## 5. 诚实边界

1. vendor 锚点为 0.99.2 干净树核实，上游升级（1.0.0）后 API 面可能变——D3 已纳入映射预研，不在本三刀解决。
2. B-1 的 cache 代价是**定性判断**（上游注释佐证），未实测；立项 plan 需含一次门禁进出前后的 cache_read 对照观测。
3. B-3 迁移只保证「引导位置变化」，不承诺模型行为提升——行为结论须待 C-1 跑批（当前 DeepSeek 基线归因混杂，见 2026-11-15 daily log，不能作对照基线）。
4. 本文件 docs-only，不构成任何代码刀的执行授权；三刀各自过 spec→plan→implement 门禁。

## 6. 状态行（回填路标 §7 队列时用）

| 刀 | 状态 | 锚 |
| --- | --- | --- |
| B-1 声明集收缩 | 🟡 立项基座已落档（本文件 §1） | vendor loader.ts:424 / types.ts:507；tiering SSOT 冲突待 plan 裁决 |
| B-2 任务契约一等化 | 🟡 立项基座已落档（本文件 §2） | vendor session-manager.ts:1290；EntryProjector 族待 plan 细化 |
| B-3 工具引导下沉 | 🟡 立项基座已落档（本文件 §3） | vendor agent-session.ts:3462-3475 / system-prompt.ts:21-22 |
