# `isMobileLayout` 读取域逐处搬 · 第二批设计规格（路线 ③ 第 4 刀）

状态：方向已批准（2026-11-09 22:10 用户选定「第 4 刀 C 类 3 处」）
前置：`docs/ops/2026-11-09-is-mobile-layout-scope-runbook.md` §6 四条准入；第一批规格/计划/runbook/证据；母规格 §10 / §15.9；Phase 3 结项规格 §4
实施计划：`docs/superpowers/plans/2026-11-09-is-mobile-layout-migration-batch2.md`
真值基线：`e743c469becb61e4186cbf9c1963a37f431a8048`（写作时 `gh api` true master；推送前重新核对 + `MASTER_MOVED_SAFE`）
分支约定：feature 分支 + PR + squash；推送全走 `gh api` Git Data API

## 0. 配图索引

本文档只有结构图，一律 Mermaid 内嵌，无像素附件。

| 编号 | 形式 | 内容 | 位置 | 用途 |
| --- | --- | --- | --- | --- |
| 图 1 | 内嵌 Mermaid `flowchart TD` | true master 上 15 点有效读取的四类分派、第二批把 C 类 3 处改为 `!isDesktopDock` 后上限 15→12、行为级等价性出口与冻结边界 | §5 | 作为「为什么本批能降到 12 而不是 13、为什么模板区读取归零仍是零行为变更」的验收基准 |

## 1. 目标（3 条以内，均可验收）

1. **按 true master 重取证并逐条分类 15 点**：并行窗口已把 master 从 `f7ea1c5b` 推进到 `e743c469`（#800 重建 rebase / #803 / #804），必须先重新精算剥离注释后的有效读取点，确认仍是 15/15、`MAX_ALLOWED = 15`、方向判据在位，再逐行列出四类分布。
2. **第二批搬 C 类 3 处并收紧棘轮到 12**：把模板区仅剩的 3 处肯定读取改成 `!isDesktopDock`，**不新增派生定义、不新增读取点**，有效读取点 15 → 12，`MAX_ALLOWED` 同步从 15 降到 12（V3 方向判据双处同步）；模板区 `isMobileLayout` 归零。
3. **行为级等价性证明（零行为变更）**：新增真实 mount 契约测试，在 PC（`matchMedia.matches=false`）与移动（`matches=true`）两端断言三处锚点对应的 DOM 形态（移动历史抽屉、移动 dock 面板 class、桌面专属锚点）与搬迁前完全一致；变异验证能精确 RED。

## 2. 范围（含明确不做）

**做**：

- 改 `apps/web/src/components/agent/AgentSideRail.vue`：模板 3 处 `isMobileLayout` → `!isDesktopDock`（移动历史抽屉 `v-if`、面板 `:class` 三元、`:mobile-enter-newline` prop）。
- 改 `scripts/verify-is-mobile-layout-scope.py`：`MAX_ALLOWED` 15 → 12，V3 方向判据里的硬编码同步。
- 新增 `apps/web/src/components/agent/AgentSideRail.mobileDockDerived.test.ts`（行为级 mount 契约）。
- 新增 13 章规格、实施计划、runbook、证据；**只追加**第一批证据 §9 登记前序风险锚消解；合并后 Issue #755 只追加回填。
- 变异测试 ≥ 6 组；`vue-tsc -b`；CI 三必需；生产发布后的 bundle 级复测。

**明确不做**：

- **不搬**剩余 12 点（唯一来源 1、`isDesktopDock` 派生定义 1、脚本逻辑 10），留后续批次逐处降上限。
- **不新增** `isMobileDock` 或任何第二个 computed；不把读取藏进 composable 冒充架构收敛。
- 不改 `presentation/**` 与 `packages/shared/**`（门禁 V2 零容忍区）；不改 `useAgentMobileLayout()` 定义点位置（门禁 V4 唯一）。
- 不碰 `sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项冻结边界；不按功能簇拆；不改任何网络调用、CSS、props、emit、Teleport 结构。
- 不改母规格、`ci.yml` 挂载行、`package.json` / `deploy.yml` / `pc-visual-baseline.json`；不新建 required check。
- 不宣称 15 点全部搬迁、不宣称布局分支移出 Shell、不宣称像素或真机视觉复测。

## 3. 与既有规格的关系

- **承接**母规格 §10「仅 Shell 读布局断点」与 §15.4 第 3 项：`AgentSideRail.vue` 本身就是 Shell，读布局断点**合法**；本刀是 Shell 内把最后 3 处模板直读收口到第一批已建立的单一派生真源，**不宣称布局分支被移出 Shell**。
- **严格按** #793 runbook §6 四条准入：先分类、每批降上限、行为级契约 + 变异、冻结边界不动。
- ⭐ **方案差异显式登记（规格-实现漂移回填）**：第一批规格 §12 预告「第二批搬 3 处到 `isMobileDock` 语义派生，上限 15 → 13」。本刀改为 **`!isDesktopDock`、上限 15 → 12**。理由：第一批已定义 `isDesktopDock = computed(() => !isMobileLayout.value)`，故 `!isDesktopDock` 与模板自动解包的 `isMobileLayout` **严格等价**；复用既有派生既不新增 computed，也不新增读取点，比新增 `isMobileDock` 派生（会 +1 读取、净降 2）更优。第一批规格 §1–§13 的**历史时点结论不追溯改写**，本节为其后继状态。
- ⭐ **前序风险锚消解（只追加状态回填）**：第一批证据 §8 登记「并行 open PR #800 疑似产物损坏、若合入会撞 `MAX_ALLOWED = 15`」。实测并行窗口按建议重建 TRUE MASTER 源码 + rebase onto #799（head `cb5beeb5` / CI `42606222774` 全绿 / squash `5ca09b1d`），把两处新 Teleport 写成 `:disabled="isDesktopDock"`，**主动复用第一批派生**；冻结契约 11 项恢复，随后 #803 / #804 已发布。master CI `42626712920` 的 `Verify agent rail contract gates` / `Verify isMobileLayout scope` / 两条删除域棘轮全 success ⇒ 第一批成果零回退。本刀在第一批证据只追加 §9 登记该状态，不改写 §1–§8。
- **正交于**路线 ② 的删除域裁决（`NO_MERGE` / `DELETE_ACTION_CLOSED_NO_TARGET`）：本刀零文件相交，不改其 verifier 与母规格 §15.9。
- **不复活**母规格 §6.3「删 29 处 + 降级 PCDockShell」：Phase 3 结项 §4 已判定路线换轨。

## 4. 规范与判据（可复用）

- **判据 A（真值源）**：`AgentSideRail.vue` 必须从 `gh api` true master 取回后编辑；本次实测本地三个目标文件与 master 逐字节相等（`a50c6dd7` / `d17cb6ad` / `02e348f2`），但仍须逐文件核裸 blob sha。该路径是并行会话高频活跃改动区（3h 内 4 次合入）。
- **判据 B（严格等价）**：由 `isDesktopDock = computed(() => !isMobileLayout.value)` 可得 `!isDesktopDock === isMobileLayout.value`；模板中 ref 自动解包 ⇒ 三处替换在任何 `matchMedia` 取值下等价。禁止夹带第二条件，禁止改成不带 `!` 的 `isDesktopDock`。
- **判据 C（棘轮方向）**：`MAX_ALLOWED` 只降不升；V3 判据内的 `^MAX_ALLOWED = 12$` 必须与常量同步，否则「改了上限但方向判据没改」会假红或恒绿（第一批 M3 变异实证）。
- **判据 D（行为级而非仅源码级）**：测试必须真实 `mount(AgentSideRail)`，在两端 `matchMedia.matches` 下断言 DOM；`v-show` 面板保证子元素在 DOM 中，Teleport 目标须纳入 `document.body` 查询；PC 端先做有效性断言防空集假绿；移动端 `ResizeObserver` 需 stub。
- **判据 E（冻结边界）**：搬迁前后 `defineExpose` 11 项、`getIsMobileLayout` 契约、`sendMessage` / `handleEvent` / `canvas_command` 逐项零改写；由测试断言与推前逐路径 diff 双重守护。
- **判据 F（注释剥离与计数）**：计数前先 `strip_comments`；新写的 Vue 注释里不得出现 `isMobileLayout` 字面量，否则门禁计数漂移。
- **判据 G（生产发布）**：`deploy.yml` 的 `push.paths` 含 `apps/web/**` ⇒ 本刀必然触发 web-only 生产发布，必须配 bundle 级下钻复测 + `/api/health`；⭐ `isDesktopDock` 是 setup 局部 const，被 esbuild 压缩成短名，**生产 chunk 里字面量为 0 不代表未部署**，须用「chunk hash 变化 + setup 派生结构 + 渲染条件 + DOM 锚点 + health」五证。

## 5. 架构与契约（配结构图）

见 图 1：true master 上 15 点分四类，第二批只动「模板肯定」这一类；搬完后 Shell 只在脚本区读布局断点，模板区全部走 `isDesktopDock` 派生真源，上限随之从 15 降到 12。

**图 1 · 15 点分类、第二批收敛到 12 与等价性出口**

```mermaid
flowchart TD
  A["true master e743c469 15 点有效读取"] --> B["唯一来源 1 点 不可搬"]
  A --> C["派生定义 1 点 不可搬"]
  A --> D["模板肯定 3 点 本批"]
  A --> E["脚本逻辑 10 点 后续批"]
  D --> F["改为 !isDesktopDock 复用既有派生"]
  F --> G["模板区 isMobileLayout 归零"]
  G --> H["有效读取 15 降为 12"]
  H --> I["MAX_ALLOWED 15 降为 12 只降不升"]
  F --> J["真实 mount 两端 DOM 形态断言"]
  J --> K["PC 桌面锚点各 1 无移动 dock 无移动抽屉"]
  J --> L["移动 dock 1 移动抽屉 1 桌面锚点全隐"]
  K --> M["等价性 PASS 零行为变更"]
  L --> M
  B --> N["冻结边界 defineExpose 11 项零改写"]
  C --> N
  E --> N
  M --> O["web-only 发布 五证复测"]
  N --> O
```

*图 1 · 这张图说明第二批只搬 C 类 3 处、为何上限是 12 而不是 13（复用派生、不新增读取点），以及行为级测试如何覆盖 PC / 移动两端；验收时用变异证明「少了取反」「少替换一处」「上限被抬高」「冻结边界被改」都会精确 RED。*

**契约边界**：`isDesktopDock` 仍是 `AgentSideRail.vue` 的局部 computed，不出组件、不进 props、不进 expose；`useAgentMobileLayout()` 唯一定义点不动。

## 6. 主场景规格（逐项可验收）

- **S1 重取证**：从 `gh api` true master 取回 SFC 与门禁脚本，裸 blob sha 校验通过；剥离注释后有效读取点恰 **15**，四类分布逐行可核对（来源 1 / 派生 1 / 模板肯定 3 / 脚本逻辑 10）。
- **S2 搬迁完整性**：L2987 `v-if`、L3017 面板 `:class` 三元、L3930 `:mobile-enter-newline` 三处全部替换为 `!isDesktopDock`；模板区 `isMobileLayout` 字面量归零，`!isDesktopDock` 恰 3 处。
- **S3 棘轮下降**：`MAX_ALLOWED = 12` 且 V3 方向判据 `^MAX_ALLOWED = 12$` 同步；门禁 `VERDICT ALL_PASS`，`--json` 显示 Shell 计数恰为 12。
- **S4 PC 端形态（行为级）**：`.agent-resize-handle` / `.agent-subtitle` / `[title="收起助手"]` 各 1；`.agent-panel-mobile-dock` 0；调用 `openThreadHistory()` 后 `.thread-history-layer` 0。
- **S5 移动端形态（行为级）**：三个桌面锚点各 0；`.agent-panel-mobile-dock` 1；调用 `openThreadHistory()` 后 `.thread-history-layer` 1。
- **S6 冻结边界**：`defineExpose` 11 项、`getIsMobileLayout`、三个冻结命令在搬迁前后逐项相同。
- **S7 生产复测**：web-only 发布 success；`/api/health` `{"ok":true}`、web 200；bundle 五证确认三处替换已 live 且未回退并行改动。

## 7. 数据与状态变更

- 不新增 store 字段、不改接口、不动 DTO、不改路由、不改 CSS 变量名。
- **不新增**任何 computed / ref；只是把 3 个模板表达式换成对既有 `isDesktopDock` 的取反。
- `MAX_ALLOWED` 从 15 变为 12，是门禁的方向性收紧，不是放宽。
- 生产发布一次（web-only），API 构建按既有 workflow 跳过。

## 8. 纯函数与算法

- 等价关系：`isDesktopDock = computed(() => !isMobileLayout.value)` ⇒ `!isDesktopDock === isMobileLayout.value`，无副作用、无异步、无缓存失效差异。
- `strip_comments(src)` / `count_hits(text)` / `within_ratchet(count, limit)`：沿用既有门禁脚本，不做算法改动；只改常量与其方向判据字面量。
- 行为级测试用 `vi.stubGlobal('matchMedia', ...)` 分别返回 `matches:false` / `true`，其余 stub 沿用第一批 `desktopDockDerived.test.ts` 的 `mountRail()` 范式（pinia + memory router + sessions/provider/mermaid mock + `ResizeObserver` stub）。
- `openThreadHistory()` 是 `defineExpose` 暴露的既有方法，测试调用它把 `mobileThreadHistoryOpen` 置真以观测抽屉；其内部 `fetchThreads()` 的网络结果不影响形态判据，故 `.catch(() => {})` 只吞网络噪声，不吞 DOM 断言。

## 9. 文件级改动清单（按内容锚点定位，不用行号）

| 文件 | 动作 | 责任 |
| --- | --- | --- |
| `apps/web/src/components/agent/AgentSideRail.vue` | 修改 | 模板 3 处 `isMobileLayout` → `!isDesktopDock` |
| `scripts/verify-is-mobile-layout-scope.py` | 修改 | `MAX_ALLOWED` 15 → 12 + V3 硬编码同步 |
| `apps/web/src/components/agent/AgentSideRail.mobileDockDerived.test.ts` | 新增 | 行为级两端形态 + 契约 + 冻结边界断言 |
| `docs/superpowers/specs/2026-11-09-is-mobile-layout-migration-batch2-design.md` | 新增 | 本文 |
| `docs/superpowers/plans/2026-11-09-is-mobile-layout-migration-batch2.md` | 新增 | 实施计划 |
| `docs/ops/2026-11-09-is-mobile-layout-migration-batch2-runbook.md` | 新增 | 准入 / 变异 / 生产复测步骤 |
| `docs/ops/2026-11-09-is-mobile-layout-migration-batch2-evidence.md` | 新增 | 重取证、RED→PASS、变异、发布复测 |
| `docs/ops/2026-11-09-is-mobile-layout-migration-batch1-evidence.md` | **只追加 §9** | 登记 #800 风险锚消解与第一批成果零回退；§1–§8 原样保留 |

**零改动**：母规格、`ci.yml`、`package.json`、`deploy.yml`、`presentation/**`、`packages/shared/**`、`pc-visual-baseline.json`、路线 ② 全部交付文件、第一批规格/计划/runbook/测试/门禁脚本之外的任何产品代码。

## 10. 测试策略与验收标准

- **T1 行为级 RED→PASS**：先写 `AgentSideRail.mobileDockDerived.test.ts` ⇒ 改产品代码前精确 RED（4 用例中仅 ③ 源码契约失败，3 个形态/冻结用例先绿，证明基线正确）；改后 4/4 PASS。
- **T2 变异 ≥ 6 组**（临时改后恢复，恢复后核 3 个目标文件裸 blob sha 全等）：把 `!isDesktopDock` 写成 `isDesktopDock` ⇒ 行为级 RED；少替换一处 ⇒ 契约 RED；只把 `MAX_ALLOWED` 抬回 15 ⇒ 门禁 V3 RED；删 1 个 `defineExpose` 项 ⇒ 冻结边界 RED；Vue 注释写 `isMobileLayout` ⇒ 对照绿（门禁剥离注释）；新增一处读取 ⇒ 门禁 V3 RED。
- **T3 门禁**：`verify-is-mobile-layout-scope.py` `VERDICT ALL_PASS` 且计数 12；三条棘轮全绿；`verify-agent-rail-gates` 11/11；`verify-spec-figures` 本规格 0 error；`claims` / `links` / `web-upload` 回归。
- **T4 编译与测试**：`vue-tsc -b` exit 0；相关回归集（第一批 + 第二批 + 7 个既有文件）全 PASS；`pnpm -r build` 编译 `*.test.ts` ⇒ 断言禁 `as never`，推前 `npx tsc --noEmit`。
- **T5 交付**：推前逐路径 `MASTER_MOVED_SAFE` 核对；CI 三必需全 success；squash 后按真实 parent 核对合并树差异恰为改动路径、`MASTER_EQ_PRHEAD True`、`ALL_PARALLEL_KEPT True`；生产发布 success + bundle 五证 + health 200；Issue #755 只追加回填。
- **完成定义**：T1–T5 全绿 + 诚实边界登记。**不宣称** 15 点全部搬迁、**不宣称**布局分支移出 Shell、**不宣称**新增 required check、**不宣称**像素或真机视觉复测。

## 11. 风险

- **R1 并行工作树冲突**：`AgentSideRail.vue` 是并行窗口高频活跃区（3h 内 4 次合入、刚发布 #804）⇒ 从 true master 取回后编辑；推前核裸 blob sha，若前移则按 `MASTER_MOVED_SAFE` 重新取回重做，不追溯改写结论。
- **R2 等价性被写坏**：三处替换若漏了 `!` 会直接反转 PC/移动形态 ⇒ 行为级两端断言 + 「把取反删掉」变异锁死。
- **R3 上限方向被改坏**：V3 里 `^MAX_ALLOWED = 15$` 硬编码忘同步 ⇒ 用 S3 + M3 变异锁死（第一批 M3 曾因同时改两处而伪绿）。
- **R4 Teleport / v-show 误判**：面板与抽屉 Teleport 到 body，wrapper 查询取不到 ⇒ 统一从 `document.body` 查询，并加 PC 端有效性断言防「两端都不存在」假绿。
- **R5 注释计数漂移**：新 Vue 注释写 `isMobileLayout` 字面量 ⇒ 门禁计数变 16 假红 ⇒ 判据 F 显式禁止，并用 M5 对照绿验证 `strip_comments`。
- **R6 生产发布遗漏复测**：`apps/web/**` 触发 deploy ⇒ T5 强制 bundle 五证 + health，且核对零回退并行改动；⭐ 不得用 `isDesktopDock` 字面量命中与否判活（局部 const 被 mangle）。
- **R7 跨窗口发布覆盖**：并行窗口刚用生产做真机复测 ⇒ 用户已明确选定本刀方向即视为窗口让出；仍须核最近 deploy run 与 health，避免叠加发布窗。
- **R8 伪收敛**：把读取点「藏」进 composable 而不改变语义 ⇒ 本刀明确登记为 Shell 内 DRY 语义化，不宣称架构收敛完成。

## 12. 后续路线

1. **第三批**：脚本逻辑 10 处逐处搬（涉及 watch / composer / floating，风险高于模板层），每处独立降上限，须逐点补行为级契约；上限从 12 起逐批下降。
2. **路线 ②** 已裁决 `NO_MERGE`、删除动作终止；两刀零相交。母规格 Phase 4「删 PC 冗余渲染」功能仍 ⏳ 未闭环，本刀不宣称改变该状态。
3. **独立窗口**：PR #802（SP-E 决策门规格阶段 0，纯文档、CI 全绿、待归属确认）、PR #625（老规格）、A-6 真机复测；按用户既定口径不进主序列。
4. 冻结边界不变；不按功能簇拆。

## 13. 配图规范自检

- 图 1 为 Mermaid 内嵌 `flowchart TD`，非空且首行受支持；§0 索引列出图 1；图注为 `*图 1 · …*`；正文 §5 引用「图 1」两次以上。
- 无 PNG/JPG/SVG 附件，不触发 R6/R8。
- 本刀不改 `docs/superpowers/SPEC-CONVENTIONS.md`；`pnpm verify-spec-figures` 结果登记在证据文档。
