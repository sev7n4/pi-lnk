# 历史失败分窗与「忽略/不再提示」设计规格（2026-11-10）

状态：已拍板（用户选「降级为历史标记 + 忽略/不再提示」组合），实施中
适用：会话 `cmw56hqit00nck801povzca3e` 等所有含历史失败节点的工作流
校验：`pnpm verify-spec-figures --file <本文>`（本文无图，R1–R8 不适用）、`pnpm verify-claims`（未改规范体系，仅登记 `docs/README.md`）

> 一句话：**黄条不是"生成失败"本身，而是每次加载会话时把早已终结的失败重新激活成"本次失败"**。本刀把「活跃失败提示」限定为本次会话内真实发生的失败；历史失败只保留静态、诚实、可重试的标记，并允许用户忽略。

---

## 1. 目标（3 条以内，均可验收）

1. **G1 止血**：重新打开含历史失败节点的工作流时，`ElMessage` 失败黄条数量从 4 降为 **0**；真实发生的本次生成失败仍然弹（判据可证伪，见 §11）。
2. **G2 诚实降级**：历史失败节点仍以静态标记呈现「生成失败 · 可重试」，保留重试入口、诊断抽屉入口与完整失败原因/退费信息；**不伪装成成功、不隐藏事实**。
3. **G3 用户可控**：静态标记提供「忽略/不再提示」，点击后写 `failureScope: 'dismissed'` 到节点 data 并持久化，刷新后不再出现活跃提示；忽略不删除节点、不删记录、不改退费事实。

---

## 2. 范围（含明确不做）

**做**

- 回滚 PR #815（Layer 3「失败但有产物→按已生成」），恢复干净的失败渲染语义（详见 §3）。
- `apps/web` 前端：新增 `failureScope` 节点 data 契约、历史失败降级判据、静态占位文案、忽略按钮与持久化，以及加载期对账的尊重。
- 行为级测试 + 变异测试 + 回归、`vue-tsc -b`、PC canvas 棘轮、design-token 守卫。
- 本规格 + 实施计划 + 生产复测 runbook，`docs/README.md` 登记。
- 生产端到端复测：浏览器带鉴权真实打开目标会话，核对黄条数、静态标记、重试入口、忽略后刷新不复发。

**明确不做**

- **不改生产数据库**：不重分类、不删除 `GenerationRecord`、不动 `Session.canvasData` 的历史记录（忽略只写前端节点 data，经既有 `saveCanvas` 通道，属产品既有行为，不新开 DB 列）。
- **不改后端 / 不新增接口 / 不新增 DB 列 / 不改提示词与工具分层**：本刀纯前端渲染与节点状态治理。
- **不改 `package.json`**：`deploy.yml` 的 `push.paths` 含它，只加 script 也会触发一次生产发布。
- **不改 `docs/agent/*` 规范体系章节名**（`verify-claims` 判据 2 按名引用）。
- **不碰并行会话 PR #816 的 3 份文档**（`pr5-mobile-shell-scope-spike.md` 与收敛审计 spec/plan）。
- **不追溯改写历史验收结论**：`2026-11-10.md` 工作日志按「只追加」回填 #815 证伪，本规格不删改既有文档结论。
- **不把真失败渲染成"已生成"**：#815 的语义在本刀明确废止。

---

## 3. 与既有规格与 PR 的关系

| 来源 | 关系 | 本刀动作 |
| --- | --- | --- |
| PR #811（P1，master `141d5d97`） | 加载期对账 + 诚实错误码 `interrupted`；其待办清单里的「Layer3 历史/当前失败分窗（解决旧失败每次打开都弹横幅）」正是本次目标 | 承接该条，按原始定义落地；不改 P1 已上线代码 |
| PR #815（master `1ccb1105`） | 把 Layer 3 重定义为「失败但有产物→按已生成」，**前提被生产证伪** | **回滚**：4 文件恢复到 #815 父提交 `eda0308c` 的内容 |
| PR #816（master `ea509049`，当前 HEAD） | docs-only 路线③收口裁决，3 文件 | 不碰；回滚与实现都基于它之后的新 master |
| `docs/superpowers/specs/2026-11-04-generation-terminal-projection-design.md` §5.3 | 终态投影 / 失败 toast 去重键（recordId 维度） / 取消语义走 `errorCode` | 复用其判据与去重键，不重写；本刀只在转移判据增加"前序失败终态"抑制 |
| `docs/superpowers/specs/2026-11-09-prod-cdp-smoke-runbook-design.md` + `scripts/prod-cdp-smoke.mjs` | 生产只读 CDP 冒烟：`mintJwt` 从容器 `JWT_SECRET` 自签、`localStorage.token` 注入、PC 视口 PREFLIGHT | 端到端复测复用该入口，不新造鉴权旁路、不写生产数据 |
| `AGENTS.md` / `docs/agent/delivery.md` / `docs/agent/docs.md` / `docs/design/Design_system.md` | 分支纪律、测试纪律、文档登记、令牌 SSOT | 全程遵循；新增 UI 只消费 L2/L3 令牌 |

### 3.1 #815 回滚的精确边界

`compare eda0308c...ea509049` 只有 7 个文件：`#815` 的 4 个 + `#816` 的 3 份 docs。回滚只把下列 4 个文件的 blob 换成 `eda0308c` 的版本，`#816` 的 3 份 docs 保持当前 master 内容：

- `apps/web/src/utils/generationDiagnostic.ts`
- `apps/web/src/pages/CanvasPage.vue`
- `apps/web/src/utils/generationDiagnostic.test.ts`
- `scripts/fixtures/pc-canvas-legacy-manifest.json`（`CanvasPage.vue` 行数 6824→6815）

回滚后 `CanvasPage.vue` 回到 6815 行、manifest 同步，本刀实现从该干净基线出发。`MASTER_MOVED_SAFE` 判据：新分支树与真实 master 树的差异集合 = 上述 4 个路径，parent = 真实 master。

---

## 4. 生产取证与根因（本次修复的事实基础）

### 4.1 取证方式

CVM（`deploy-cvm`，容器 `lnkpi-api`）内用 `@prisma/client` 直查 `/app/apps/server/data/lnkpi.db`（容器无 `sqlite3` CLI），**只读**，未改任何生产数据。前端源码一律以 `gh api` 拉真实 master blob 核对，不信本地脏工作区。

### 4.2 数据事实

| 项 | 实测 |
| --- | --- |
| 目标会话 4 条 `failed` GenerationRecord | `url=null`；metadata 顶层 key **无任何产物字段**（无 `urls`/`image`/`url`/`mediaInfo`/`text`）；`userMessage="上游超时，请稍后重试"`、`errorCode="upstream_timeout"`；带 `refundedPoints`/`refundReason` |
| 对应 4 个画布节点（`Session.canvasData`，共 25 节点） | `status="failed"`、`url/images/content=null`、`errorCode="upstream_timeout"`、`errorMessage=null`；`generationRecordId` 与 record 一一对应；`record.nodeId` 与节点 id 完全一致 |
| 全局 `upstream_timeout` 记录 | 92 条；**带任何产物 URL 的 0 条**；92/92 带 `refundedPoints`；88 `failed` + 4 `fallback_pending`；跨 2026-07-20 ~ 11-08 |
| 全局所有失败态记录 | 1580 条（1221 `failed` + 359 `fallback_pending`）；**带产物的 0 条** |

⇒ 这是 **4 次真实失败**（上游超时、无产物、积分已退），不是"生成成功被误标失败"。#815 的 `recordHasUsableOutput` 在全部现有生产数据上恒为 `false`，是死代码；若其分支真被触发，反而会把已退费的真失败渲染成"已生成"，属不诚实。

### 4.3 根因链（逐跳可核对）

1. 打开历史会话 → `loadSession` 从服务端 `canvasData` 恢复 4 个 `status="failed"` 节点；watch 的"初次拉取不弹 toast"保护要求 `prev === undefined`，但此时 **prev 存在且为 `failed`**，保护不适用。
2. `loadSession` 末尾 `void reconcileMissingGenerationRecords()`：4 个节点都满足"有 `generationRecordId` 且无 `url`/`images`/`content`"，且 `record.nodeId` 与节点 id 一致 ⇒ 全部命中 `patchTargets`。
3. `buildStudioRecordPatch(node, record)` 对失败记录算出 `status: NODE_GENERATION_STATUS.error`（`failed → error`），并写 `errorMessage = getRecordFailureMessage(record)`，即 `meta.userMessage`「上游超时，请稍后重试」。
4. CanvasPage 的 `watch(nodes 快照)` 观察到 `failed → error` 边；`shouldToastForFailure(prev, cur)` 只在 `prev?.status === 'error'` 或 `'completed'` 时抑制，`prev='failed'` 不抑制 ⇒ 返回 `true`。
5. `useGenerationFailureToast.onNodeError` 弹出 `ElMessage({ type:'warning' })`，文案 `${title} 生成失败：${msg}`（title 为「女性和黑猫合影」等）⇒ **4 条黄条**。
6. 去重 `toasted` Set 由 `onScopeDispose` 清理，页面重载即重建 ⇒ **每次重开会话必然重弹**。

⇒ 病灶不在"记录是不是失败"，而在**加载期对账把历史终态失败重新解释成"本次转移到 error 的新失败"**（P1 记录的"五写者多重解释病灶"在 toast 边的延续）。

### 4.4 上一轮验证失败的原因（流程教训）

上一轮"生产复测"只验证了「代码已部署」（bundle 专属 token 命中）+ **假定的**数据形态，既没有端到端渲染复现，也没有把判据函数跑在真实记录上，就宣告闭环。以后凡"按数据形态分支"的修复，必须先用真实记录求值判据，且以用户实测/浏览器取证为准。

---

## 5. 规范与判据（可复用规则）

| 编号 | 规则 | 可验收方式 |
| --- | --- | --- |
| R1 | **不伪装成功**：任何失败节点不得因渲染治理被改成 `completed` 或"已生成" | 行为级测试 + 生产 DOM 取证 |
| R2 | **活跃提示只属于本次失败**：`shouldToastForFailure` 必须同时满足「next 是 error」「prev 不是失败终态」「next 未标记 historical/dismissed」 | 行为级用例 + 变异（去掉任一抑制条件即 RED） |
| R3 | **加载期对账不得重新激活历史失败**：`buildStudioRecordPatch` 对已从服务端恢复的失败终态节点，不得产生 `failed → error` 转移、不得写 `errorMessage` | 纯函数用例 + 变异 |
| R4 | **事实可查**：降级后失败原因、退费信息、重试与诊断入口仍在（历史面板 / 诊断抽屉 / 节点角标） | 端到端复测 DOM 断言 |
| R5 | **忽略不删数据**：`dismissed` 只改节点 data 的一个字段，不删节点/记录、不改 status/退费 | 状态变更表 + 测试 |
| R6 | **判据能真的失败**：新增用例必须做变异测试；变异不 RED 先怀疑伪变异与判据自匹配恒绿 | §11 变异清单 |
| R7 | **只追加**：历史工作日志与既有规格的状态回填只允许字符级 insert | 推前 `SequenceMatcher` 核对 |
| R8 | **端到端为准**：宣告闭环前必须浏览器带鉴权真实打开目标会话，禁止以"bundle 含代码 + 推断数据"代替 | runbook §4 |

---

## 6. 架构与契约

### 6.1 节点 data 契约：`failureScope`

| 取值 | 含义 | 何时写入 | 活跃提示 | 占位呈现 |
| --- | --- | --- | --- | --- |
| 缺省 / `active` | 本次会话内真实发生的失败 | 生成失败写者不写该字段（保持缺省，兼容存量） | 允许（转移判据成立时） | 既有失败呈现不变 |
| `historical` | 从持久化画布恢复的历史失败 | 加载期对账 `buildStudioRecordPatch` 命中失败终态节点时 | **禁止** | 「生成失败 · 可重试」静态标记 + 忽略按钮 + 重试/诊断入口 |
| `dismissed` | 用户已显式忽略 | 点击忽略 → `patchNodeData` + `saveCanvas` | **禁止** | 极简占位（不删节点、不删记录） |

**兼容性**：存量节点没有该字段 ⇒ 视为 `active`；但加载期对账会把它升级为 `historical`（这正是本刀目标）。不新增 DB 列、不改 `Session.canvasData` 的 schema，字段随既有 `saveCanvas` 的整份画布 JSON 持久化。

### 6.2 三处判据（单一事实源）

| 判据 | 落点 | 输入 | 输出 |
| --- | --- | --- | --- |
| `isFailureTerminalStatus(status)` | `apps/web/src/utils/incompleteNode.ts`（与 `nodePlaceholderText` 同处） | status | `failed`/`error`/`fallback_pending` ⇒ true |
| `shouldToastForFailure(prev, next)` | `apps/web/src/composables/useGenerationFailureToast.ts`（既有纯函数，扩展） | 前后快照（含 `failureScope`） | 是否弹 toast |
| `nodePlaceholderText(status, generatingText, scope?)` | `apps/web/src/utils/incompleteNode.ts`（既有纯函数，扩展） | status + scope | 占位文案 |
| `resolveHistoricalFailurePatch(nodeData, record)` | `apps/web/src/utils/historicalFailure.ts`（新增） | 节点 data + 对账记录 | 历史失败降级 patch / `null` |
| `resolveDismissFailurePatch(nodeData)` | 同上 | 节点 data | `{ failureScope: 'dismissed' }` / `null`（只对 `historical` 失败终态开放） |

`shouldToastForFailure` 的完整抑制表（新增两条，其余沿用 §5.3 既有契约）：

| 条件 | 结果 | 理由 |
| --- | --- | --- |
| `next.status !== 'error'` | false | 既有 |
| `isCancellation(next)` | false | 既有 |
| `prev?.status === 'error'` 或 `'completed'` | false | 既有 |
| **`isFailureTerminalStatus(prev?.status)`** | **false** | 新增：失败终态之间的转移不是新失败（加载期对账 `failed→error` 即此） |
| **`next.failureScope === 'historical' \| 'dismissed'`** | **false** | 新增：历史/已忽略节点永不弹活跃提示 |
| 其余（生成中/上传中/空闲 → error 且 scope 缺省） | true | 真实本次失败，保留 |

两道抑制是**分层防御**而非冗余：R3 保证对账不产生转移，R2 保证即使别的写者产生转移也不弹。任一被去掉，另一条用例必须转红（§11 M1/M2）。

### 6.3 数据流

```
loadSession → nodes(prev=failed)
   ↓ reconcileMissingGenerationRecords (仅此处调用 buildStudioRecordPatch)
buildStudioRecordPatch 命中失败终态
   ↓ patch = { status: 保持 failed, failureScope:'historical', generationRecordId, errorMessage: null }
patchNodeData → 节点 data（无 error 转移、无 errorMessage）
   ↓ watch 快照：prev=failed, next=failed ⇒ shouldToastForFailure=false
CanvasNodeImage/Audio/Video 占位区：nodePlaceholderText(failed, _, historical) = 「生成失败 · 可重试」
NodeTaskCornerActions：显示「忽略」按钮（scope=historical），保留重试/诊断入口
   ↓ 用户点忽略
dismissNodeFailure(nodeId) → resolveDismissFailurePatch → patchNodeData(dismissPatch) → saveCanvas() → 刷新不复发
```

---

## 7. 主场景规格（逐项可验收）

| # | 场景 | 期望 | 验收 |
| --- | --- | --- | --- |
| S1 | 重新打开目标会话（4 个历史失败节点） | 失败黄条 **0 条**；4 节点显示静态「生成失败 · 可重试」 | 端到端 DOM 计数 + 截图 |
| S2 | 打开后点击节点角标 ⓘ | 诊断抽屉能看到「上游超时，请稍后重试」与退费信息 | 端到端点开断言 |
| S3 | 点击节点重试 | 走既有重试链路，产生新 recordId；失败仍弹 1 条黄条 | 单元/行为级 + 端到端（可选，避免生产写时只做单元） |
| S4 | 本次会话真实生成失败 | 弹 1 条黄条（不是 0、不是重复 4 条） | 行为级用例 `generating→error` 转 true |
| S5 | 点「忽略」 | 该节点变 `dismissed`，静态标记变极简；其余 3 节点不受影响 | 行为级 + 端到端刷新 |
| S6 | 忽略后刷新会话 | 被忽略节点不再弹提示、保持极简；未忽略的 3 个仍是 `historical` 静态标记 | 端到端刷新取证 |
| S7 | 成功记录 / 生成中记录 | 回填与轮询行为完全不变（不因本刀产生回归） | 回归用例 + 定向测试 |

---

## 8. 数据与状态变更

| 层 | 变更 | 说明 |
| --- | --- | --- |
| 生产 DB | **无** | 不重分类 92 条 `upstream_timeout`、不改退费、不删记录 |
| `Session.canvasData` JSON | 节点 data 增 `failureScope` 字段 | 经既有 `saveCanvas` 整份画布持久化；schema 无变化 |
| `GenerationRecord` | **无** | 服务端权威状态不变 |
| 新增接口 / 端点 / 提示词 / 工具 | **无** | 纯前端 |
| 新增 npm script / `package.json` | **无** | 避免触发 `deploy.yml` 的 `push.paths` |

---

## 9. 纯函数与算法

**`nodePlaceholderText` 新增分支**（保持既有取值顺序：`incomplete` > `uploading` > `generating` > 默认）：

| status | scope | 返回 |
| --- | --- | --- |
| `failed` / `error` | `historical` | `生成失败 · 可重试` |
| `failed` / `error` | `dismissed` | `已忽略`（极简，不诱导操作） |
| `failed` / `error` | 缺省 / `active` | 既有默认「上传或等待生成」不变（活跃失败由 toast + 错误条承担） |
| 其余 | 任意 | 既有映射不变 |

⚠️ 该分支必须放在 `incomplete` 判定之后（后端 `incomplete` 语义优先，见模块头注释），且不得把 `generating` 误判。

**`buildStudioRecordPatch` 失败终态分支**（该函数当前只在 `reconcileMissingGenerationRecords` 内调用，是加载期对账专用）：

- 输入 `node.data.status` 已是失败终态且 `record.status ∈ {failed, error}` ⇒ 返回 `{ status: <保持原值>, failureScope: 'historical', generationRecordId: record.id, errorMessage: null }`，**不产生 `error` 转移、不写 `errorMessage`**。
- 若 `node.data.failureScope === 'dismissed'` ⇒ 保持 `dismissed`，不被覆盖回 `historical`。
- `completed` 记录分支、`parseRecordText` / `parseRecordUrls` / `mediaInfo` 回填分支**完全不变**。

**`resolveDismissFailurePatch` 忽略判据**（与降级判据同处 `utils/historicalFailure.ts`）：

- 仅 `failureScope === 'historical'` 且 `status` 为失败终态 ⇒ 返回 `{ failureScope: 'dismissed' }`；
- `dismissed` / 缺省 / `active` / 非失败终态 ⇒ `null`（页面级 provider 直接跳过，不写画布）；
- 只增加一个字段：不删节点、不改 `status`、不改产物与退费事实；失败原因/退费仍在诊断抽屉可查。

⚠️ 实现偏离说明：§10 初稿写「`dismiss` emit + 父组件 `@dismiss` 转发」。落地时改为复用既有
`CANVAS_NODE_*_KEY` 注入通道（新增 `CANVAS_NODE_DISMISS_FAILURE_KEY`），与 `cancel` / `retry`
完全同构——避免 5 处 `NodeTaskCornerActions` 标签 × 节点组件 × `NodeRenderer` × `CanvasPage`
四层事件转发；不新造全局事件总线，仍是「组件只把意图交给页面级 provider」的既有契约。

---

## 10. 文件级改动清单（按内容锚点定位，不用行号）

| # | 文件 | 锚点 | 改动 |
| --- | --- | --- | --- |
| 1 | `apps/web/src/utils/incompleteNode.ts` | `nodePlaceholderText` / `NODE_INCOMPLETE_STATUS` | 导出 `isFailureTerminalStatus`；`nodePlaceholderText` 增可选 `scope` 与失败终态文案分支 |
| 2 | `apps/web/src/composables/useGenerationFailureToast.ts` | `shouldToastForFailure` / `NodeErrorLike` / watch 快照透传 | 快照类型增 `failureScope`；转移判据增两条抑制；`onNodeError` 不变（文案不动） |
| 3 | `apps/web/src/pages/CanvasPage.vue` | `buildStudioRecordPatch` / `reconcileMissingGenerationRecords` / 失败 toast watch / `patchNodeData` | 失败终态降级分支；快照透传 `failureScope`；新增 `dismissNodeFailure(nodeId)`（复用 `patchNodeData` + `saveCanvas`） |
| 4 | `apps/web/src/components/canvas/NodeTaskCornerActions.vue` | `showError` / 模板 `.neo-task-chrome-row` | 增 `failureScope` prop；inject `CANVAS_NODE_DISMISS_FAILURE_KEY`；`historical` 时显示「忽略」按钮并调回调传 `nodeId`，`dismissed` 时隐藏活跃错误条 |
| 5 | `CanvasNodeImage.vue` / `CanvasNodeAudio.vue` / `CanvasNodeVideo.vue` / `CanvasNodeText.vue` | 占位区 `nodePlaceholderText(...)` 调用、`NodeTaskCornerActions` 标签 | `data` props 增 `failureScope?: string`；5 处标签透传 `:failure-scope`，3 处占位调用透传第三参 scope。`NodeRenderer.vue` 的 `:data="data"` 已是整体透传，实测无需改动 |
| 6 | `scripts/fixtures/pc-canvas-legacy-manifest.json` | 5 个 inventory 条目的 `lines` | 同步实现后实际行数：`CanvasPage.vue` 6815→6844、`CanvasNodeImage.vue` 253→256、`CanvasNodeVideo.vue` 311→314、`CanvasNodeAudio.vue` 280→283、`CanvasNodeText.vue` 181→185（**只改 `lines`，不动 `append_only_prefix_bytes`/`sha256`/`prod_refs`**）；棘轮 V1–V7 `ALL_PASS` |
| 7 | 测试 | 改 `incompleteNode.test.ts` / `useGenerationFailureToast.test.ts`；新增 `utils/historicalFailure.ts` + `.test.ts`、`components/canvas/NodeTaskCornerActions.historicalFailure.test.ts`（行为级 DOM）、`pages/CanvasPage.historicalFailure.test.ts`（页面接线静态契约） | 5 文件 / 62 tests 全绿，见 §11 |
| 8 | 文档 | 本规格 + `docs/superpowers/plans/2026-11-10-historical-failure-scope.md` + `docs/ops/2026-11-10-historical-failure-scope-prod-verify.md` + `docs/README.md` 登记 | docs-only 部分零发布风险 |

**UI 令牌约束**：新增「忽略」按钮只消费既有类名（`neo-task-elapsed` 提供底色/字号/圆角），`neo-node.css` 新增 `.neo-task-dismiss-btn` 仅含 `border` / `cursor` / `text-decoration` —— 零新增 hex / `rgba(` / `bg-[#`（`--neo-*` 属旧命名，禁止新增）；遵循 `Design_system.md` §2 三条硬规则；改完跑 `design-token.test.ts`。

---

## 11. 测试策略与验收标准

### 11.1 行为级用例（先写失败测试）

| 组 | 用例 | 期望 |
| --- | --- | --- |
| T1 | `shouldToastForFailure(prev=failed, next=error)` | **false**（本刀核心；改前为 true） |
| T2 | `shouldToastForFailure(prev=generating, next=error)` | true（真实失败不回归） |
| T3 | `shouldToastForFailure(prev=undefined, next=error)` | true 由 watch 的 `prev === undefined` 保护拦住（该保护属 CanvasPage，需单独断言） |
| T4 | `shouldToastForFailure(prev=failed, next=error, scope=historical)` | false |
| T5 | `shouldToastForFailure(prev=generating, next=error, scope=dismissed)` | false |
| T6 | `nodePlaceholderText('failed', _, 'historical')` | `生成失败 · 可重试` |
| T7 | `nodePlaceholderText('failed', _, 'dismissed')` | `已忽略` |
| T8 | `nodePlaceholderText('incomplete', _, 'historical')` | `未完成`（顺序不回归） |
| T9 | `buildStudioRecordPatch` 对历史失败终态节点 | patch 不含 `status:'error'`、不含 `errorMessage`、含 `failureScope:'historical'` |
| T10 | `dismissed` 节点再次对账 | 保持 `dismissed`，不被刷回 `historical` |
| T11 | `completed` 记录对账 | 产物回填不变 |
| T12 | 点「忽略」按钮 | 调注入的 `CANVAS_NODE_DISMISS_FAILURE_KEY` 回调且带正确 nodeId（行为级 DOM）；`resolveDismissFailurePatch` 只返回 `{failureScope:'dismissed'}`；`dismissNodeFailure` 走 `patchNodeData` + `saveCanvas`（页面静态契约） |

### 11.2 变异测试（必须 RED，逐条记录 exit≠0）

| # | 变异 | 应转红的用例 |
| --- | --- | --- |
| M1 | 删掉 `isFailureTerminalStatus(prev?.status)` 抑制 | T1 |
| M2 | 删掉 `next.failureScope` 抑制 | T4 / T5 |
| M3 | `buildStudioRecordPatch` 把失败终态仍映射为 `error` | T9 |
| M4 | `buildStudioRecordPatch` 对 `dismissed` 覆盖为 `historical` | T10 |
| M5 | `nodePlaceholderText` 把 `historical` 分支删掉 | T6 |
| M6 | `nodePlaceholderText` 把失败分支放到 `incomplete` 之前 | T8 |
| M3B | 页面删掉 `if (historicalPatch) return historicalPatch` 接线 | 页面静态契约（防「纯函数绿了但页面没接」） |
| M7a | 忽略按钮不调注入回调 | T12 |
| M7b | 忽略按钮传错 nodeId | T12 |
| M7c | 删掉 `dismissed` 隐藏活跃错误条 | T12 |
| M9 | `resolveDismissFailurePatch` 放开非 `historical` / 非失败终态 | T12 纯函数 |
| M8 | **伪变异对照**（改注释或无关字符串） | 必须仍全绿，用来证明判据锚点没自匹配恒绿 |

判据纪律（`delivery.md` §判据必须能真的失败）：验证脚本读真实源码、断言锚点不写在判据函数自身、退出码单独取、`git status` 推前为空。

### 11.3 本地与 CI

- 定向：`cd apps/web && ./node_modules/.bin/vitest run <5 个文件>`（`--maxWorkers=1 --no-file-parallelism`，nvm node24）；改组件后 `vue-tsc -b`。
- 5 个文件：`src/utils/incompleteNode.test.ts`、`src/utils/historicalFailure.test.ts`、`src/composables/useGenerationFailureToast.test.ts`、`src/components/canvas/NodeTaskCornerActions.historicalFailure.test.ts`、`src/pages/CanvasPage.historicalFailure.test.ts`。
- 变异脚本逐条注入真实实现源码并恢复原文；M8 伪变异（只改注释）在 5 文件全量上必须仍全绿，防判据自匹配恒绿。
- `pnpm -r build` / `npx tsc --noEmit`（CI 编译 `*.test.ts`，断言禁 `as never`）。
- `design-token.test.ts`、`scripts/verify-pc-canvas-legacy-scope.py` 三条棘轮 ALL_PASS。
- `pnpm verify-spec-figures`（新文档无图）、`pnpm verify-claims`（未改规范体系）。
- CI 三必需：`Verify spec figures` / `Build monorepo` / `Build API Docker image`；`Build monorepo` 内的 `pnpm test` step 须下钻看 `Errors` 与 `Exit status`。

### 11.4 生产端到端复测（R8，闭环前置）

见 `docs/ops/2026-11-10-historical-failure-scope-prod-verify.md`：复用 `scripts/prod-cdp-smoke.mjs` 的自签 JWT + CDP 只读通道，真实打开目标会话，断言黄条数 0、静态标记 4 处、诊断抽屉可见失败原因、点忽略后刷新不复发；`LNKPI_SMOKE_WRITE=0`（默认）不写生产数据。**禁止以 bundle token 命中代替渲染取证**。

---

## 12. 风险

| # | 风险 | 缓解 |
| --- | --- | --- |
| R-1 | `buildStudioRecordPatch` 被非加载期路径复用，导致本次新失败也被降级 | 取证确认它当前只在 `reconcileMissingGenerationRecords` 内调用（CanvasPage 内部函数）；实施时再以 `os.walk` 复核零外部调用方；T2/T4 守住真实失败 |
| R-2 | 其它写者仍会产生 `failed→error` 转移 | `shouldToastForFailure` 的前向抑制是独立第二道防线（M1 证明可 RED） |
| R-3 | `CanvasPage.vue` 行数变化触发 PC canvas 棘轮 V2 | manifest 只改 `CanvasPage.vue.lines`，不动 mother spec 的 `append_only_prefix_bytes`/`sha256`（V5 只追加契约） |
| R-4 | 5 个使用方漏传 `failure-scope` / `@dismiss`，导致"有代码无效果" | 按 `delivery.md` §判据 5 用 `os.walk` 列出定义处与全部调用处；端到端 DOM 取证兜底 |
| R-5 | 新增 UI 破坏深浅主题 / 对比度 | 只消费 L2/L3 令牌；跑 `design-token.test.ts` |
| R-6 | 并行会话再前移 master | 每次推前用 `gh api` 取真实 HEAD、`MASTER_MOVED_SAFE` 逐路径裸 blob sha 比对；推后全树核对 `DELTA=改动路径` |
| R-7 | 浏览器缓存旧 chunk 造成"改了没生效"的错觉 | `index.html` `Cache-Control: no-cache` + chunk immutable 新 hash；复测前核对 index.html 引用的 chunk hash 与部署产物一致 |
| R-8 | 诚实性风险：把真失败"藏起来" | 事实仍可查（历史面板/诊断抽屉/节点角标），只停止活跃打扰；R1 明确禁止改成 `completed` |

---

## 13. 后续路线（本刀不做）

1. **写入侧根治**：上游返回产物即必须写回 `url`/`urls` 且不得标 `failed`；避免"生成成功但记录失败"在未来真实发生（#815 想防的场景，正确落点在写入侧而非渲染侧）。
2. **Layer0 上游超时事故**：92 条 `upstream_timeout`（跨 07-20~11-08）反映上游稳定性问题，属独立事故线，需 UpstreamProbe 数据与告警治理。
3. **92 条历史数据处置**：如需 retroactive 重分类为 `interrupted` 或批量清理，属**生产写**，须单独授权 + 备份 + 复测。
4. **忽略的撤销**：本刀 `dismissed` 无 UI 回退入口；若要"恢复提示"，二期补（数据字段已具备）。
5. **CDP runbook 常态化**：把本刀的黄条计数断言固化进 `scripts/prod-cdp-smoke.mjs` 的只读层，作为回归守卫（不挂 required check，理由见既有 runbook §2）。
