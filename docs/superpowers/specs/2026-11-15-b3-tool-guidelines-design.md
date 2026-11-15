# B-3 · 工具引导一等化 — 独立立项规格

- **状态**：设计稿·待评审（B-1/B-2/B-3 基座 spec §6 队列首刀；D1 顺序 B-3 → B-1 → B-2）
- **上游锚**：基座 spec §3；vendor `earendil-works/pi` **0.99.2**（干净树核实，2026-11-15）
- **⚠️ 本文对基座 §3 做两处证伪修正**（对抗性复审发现，见 §1）——设计按修正后事实重构，基座 §3 的「直接逐字迁移」路线**不可执行**。

---

## 0. 摘要（修正后）

基座 §3 预设「上游 tool 级 `promptGuidelines` 随工具集自动增删、按段承载、不占 L6」。复审证明该原语在 pi-runtime 的 harness 路径上**不可达**，且 registry 中试点工具专属条文实量极小。本刀修正为：**沿 LnkpiTool 既有扩展字段先例自建 `promptGuidelines` 字段 + 在 `composeSystemPrompt` 经既有 `appendPromptBlocks` 模式渲染 `<tool_guidelines>` 段**（消费端一等化，非上游原语移植），registry 等量删除试点条文。主价值是**结构解耦**（引导随工具定义单源、修复 B-4「规范-实现漂移」），token 收益是次要小额。

---

## 1. 对抗性复审：基座 §3 两处证伪

### 1.1 证伪①：上游原语在 pi-runtime harness 路径不可达

- `promptSnippet`/`promptGuidelines` 字段声明于 **coding-agent** 的 `ToolDefinition`（`packages/coding-agent/src/core/extensions/types.ts:573`），消费者是其 `AgentSession`：收集进 `_toolPromptSnippets/_toolPromptGuidelines`（`agent-session.ts:3460-3475`）→ `_rebuildSystemPrompt`（:1643）→ `buildSystemPromptSections`（`system-prompt.ts`）按段承载。
- **pi-runtime 走的是 agent-core 的 `AgentHarness.create`**（`session-manager.ts:1076`，`HarnessFactory = AgentHarness.create`），不是 coding-agent `AgentSession`。agent-core harness 对 systemPrompt 的处理是**直通求值**：`generation.ts:61-65` —— `typeof config.systemPrompt === "string" ? config.systemPrompt : config.systemPrompt(ctx, context)`，求值结果直接作为请求 systemPrompt，**完全不经过段机制**。
- 即便切到 coding-agent 路径也救不了：`buildSystemPromptSections` 在 `customPrompt` 分支（:143）只产 `preamble` 段，`tools`/`rules`（即 toolSnippets/toolGuidelines 的承载段）**不渲染**——pi-runtime 恰好恒传自定义静态 prompt。
- **结论**：「逐字迁移到 `promptGuidelines` 字段」会导致迁移文本从系统提示**整体消失**。基座 §3 设计路线作废。

### 1.2 证伪②：「纪律条文最重」不实——迁移实量极小

- 全 registry（12 规则文件）扫描：试点三工具（todo_write / propose_plan / ask_user）的专属条文**只有** `task_tool.md`（正文 ~130 字符，覆盖 todo_write+propose_plan 两行式纪律）与 `media_tool_policy.md` 1 处提及。`ask_user` 在 registry **零条文**。
- 纪律主体的真实位置：**工具 `description`（TypeBox schema，随 active 工具定义随请求下发，不占 L6）** 与 `skills/task-decomposition/SKILL.md`（A-3 刀已加纪律③分流）。
- **结论**：B-3 的 token 收益天然有限（L6 只减 ~130 字符）。「L6 余量贴线」是 registry 全局的既有事实，不是试点条文造成的；本刀对它的贡献是小额、非解药。

### 1.3 修正后的价值主张

1. **结构解耦（主价值）**：工具使用引导单源落在工具定义，工具增删/隐藏/分层（tiering）时引导自动跟随——这是 B-4「规范-实现漂移」的结构性修复，与基座动机一致。
2. **L6 小额余量**：task_tool.md 条文迁出（~130 字符），`scripts/prompt-lint.ts` 机器数可证。
3. **不承诺行为提升**（基座诚实边界 3 保留）：行为结论待 C-1 干净跑批基线。

---

## 2. 设计（修正后）

### 2.1 字段：LnkpiTool 扩展 `promptGuidelines?: string[]`

- `LnkpiTool = AgentHarnessTool<LnkpiToolContext> & { tier, summary, … }`（`tools/types.ts:85`）——**已有同款扩展字段先例**（`summary` → `toolSummary` 回退 description）。加可选字段零 vendor patch，agent-core `AgentHarnessTool` 不受影响。
- 唯一写入点 = 工具定义文件（单写者纪律 D2 延续）；无第二条通道。

### 2.2 渲染：`composeSystemPrompt` 追加 `<tool_guidelines>` 段

- pi-runtime 已有同款承载模式：`composeSystemPrompt`（`session-manager.ts:3401-3411`）经 `appendPromptBlocks(base, [skills index])` 追加 skills 索引块——本刀在同一处追加第二块，**不引入新机制**。
- 渲染规则（对齐 vendor 段语义的等价实现，非照抄）：
  - 来源 = `toolEnsemble.registered` 全集的 `promptGuidelines`（**静态渲染**，见 §3 D-1）；
  - 每工具一节 `- <name>:` + 要点列表；无 guidelines 的工具不出现（对齐 vendor「无 snippet 不列出」语义）；
  - 段空（无任何工具声明 guidelines）时整段不出现——与 A-3「缺省键不出现」纪律一致。
- `skills index` 块与 `tool_guidelines` 块的拼接顺序固定（先 skills 后 guidelines），避免两块互扰缓存指纹。

### 2.3 迁移（等量置换）

| 迁移对象 | 动作 |
| --- | --- |
| `task_tool.md` 正文两行（todo_write 覆写纪律 + propose_plan 先行确认） | 逐字迁入 `todo.ts`/`propose-plan.ts` 的 `promptGuidelines`；registry 删该文件（或降为仅标题占位——见 §3 D-2） |
| `media_tool_policy.md` 的 1 处试点工具提及 | 仅当该提及属「工具专属」才迁；跨工具通用纪律**留在 registry**（基座分层纪律不变） |
| `ask_user` | registry 无条文可迁；本轮**不新增**引导（避免借刀扩写，保持等量置换可机检）——新增引导属后续内容刀 |

### 2.4 观测

不加新指标（基座 D4：B-3 以 prompt lint 余量数为准）；`prompt-lint` 前后余量对比写入 PR 正文即机检证据。

---

## 3. 裁决点（本 spec 提请评审拍板）

- **D-1 静态渲染 vs 动态渲染**：按 `registered` 全集静态渲染（cache 稳定，段内容不随 tiering/门禁变化）vs 按 `active` 渲染（token 省但 cache 随工具集变化打散）。**建议：静态**——B-1 将引入门禁态声明集收缩，若 guidelines 随 active 变，门禁进出会额外打断前缀缓存，与 B-1 的 cache 代价分析叠加；静态渲染使本刀对 cache **零新增扰动**。
- **D-2 registry 删除形态**：`task_tool.md` 整文件删除 vs 降为占位（保留 id/version 供引用追溯）。**建议：整文件删除**——MANIFEST 同步摘除；回溯走 git 历史，不留僵尸占位。
- **D-3 段名与格式**：`<tool_guidelines>`（XML 段，对齐 vendor 段风格）vs 裸文本块。**建议：XML 段**——与 vendor sections 命名习惯一致，1.0.0 upmerge 映射时更易对照（D3 基座裁决延续）。

## 4. 验收锚

1. `todo.ts`/`propose-plan.ts` 声明 `promptGuidelines`；`composeSystemPrompt` 渲染含等价迁移文本的 `<tool_guidelines>` 段（渲染单测：有/无/部分工具声明三形态）。
2. `task_tool.md` 从 registry 删除，`MANIFEST.yaml` 同步；`prompt-lint` 余量上升（前后数字写 PR 正文）。
3. registry loader / golden cases / tiering 全绿（等量置换不破坏静态 prompt 装配与 registryHash 校验）。
4. 变异自检 ≥2：① 删渲染块 → 渲染单测 RED；② 迁移文本不匹配 → 等量置换断言 RED。
5. 诚实边界：不承诺行为提升；D-1 若评审改选动态渲染，B-1 cache 分析需同步修订。

## 5. 诚实边界

- 本文两处证伪已同步标注基座 §3 的失效范围；基座 §6 B-3 状态行随本 PR 回填。
- 迁移实量小（~130 字符）——若评审认为小额收益不值一整刀，可裁「B-3 降级为随 B-1 顺带的小改」；但结构解耦价值独立于字数，建议维持独立小刀。
- 本 spec docs-only，不构成代码刀执行授权；实施须过 spec→plan→implement 门禁（干净树 + 全量测试 + 变异 + CI）。
