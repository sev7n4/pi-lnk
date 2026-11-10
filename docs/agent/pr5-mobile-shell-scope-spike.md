# PR5 移动画布壳层 · 范围设计 Spike（路线 ③ 收口）

> 类型：**范围设计 spike**（非 13 章规格）。目的：在起草正式规格前把边界锁死。
> 关联：路线 ③ `isMobileLayout` 棘轮（#799/#801/#806/#808 已闭环，有效读取 21→11）。
> 真值基线：`gh api` 取的 true master（2026-11-10 重取 `AgentSideRail.vue` 与 `useAgentDock.ts` 实证）。

## 0. 定位与背景

路线 ③ 把 `AgentSideRail.vue` 的 `isMobileLayout` 有效读取从 21 压到 11，结构性胜利已拿到：

- **单一绑定**（L234 `const { isMobileLayout } = useAgentMobileLayout()`）
- **单一派生**（L236 `const isDesktopDock = computed(() => !isMobileLayout.value)`）
- **一道 `MAX_ALLOWED=11` guardrail**（任何新直读都会 CI 红，回归在构造上被锁死）

剩余 8 处全为**移动端表现逻辑**，不该在棘轮里"重定向"（改 `!isDesktopDock` 是伪收益，PR5 来了又得搬/删），而应"搬走或删除"——整批移交 PR5 移动壳层。

**关键新发现（2026-11-10 重取 true master 实证，推翻早先"从零建壳"假设）：**

- `MobileCanvasShell.vue` **已存在**（`apps/web/src/components/mobile/MobileCanvasShell.vue`）。
- `useAgentMobileLayout.ts` **已存在**（L234 正是用它的），`composable` 自取布局的契约改造零新增依赖。
- `components/mobile/` 已有 `MobileTopBar.vue` / `MobileNodeEditorSheet.vue` / `MobileCanvasCreateFab.vue` 等成熟移动组件。

⇒ PR5 不是"从零建壳"，而是**扩展既有壳（6 迁移）+ 契约改造（1）+ 删死代码（1）**，规模比预期小，属中号 PR 量级，不是大 initiative。

## 1. 真值基线：`AgentSideRail.vue` 当前 `isMobileLayout` 读取点（11，grep 实证 master）

| 行 | 代码形态 | 分类 | PR5 处置 |
|---|---|---|---|
| L234 | `const { isMobileLayout } = useAgentMobileLayout()` | 绑定（地板，不动） | — |
| L236 | `const isDesktopDock = computed(() => !isMobileLayout.value)` | 派生（地板，不动） | — |
| L469 | `getIsMobileLayout: () => isMobileLayout.value` | 冻结内 expose（agent 外部契约，不动） | — |
| L737 | `railHiddenByTab` computed：`isMobileLayout.value && (mobileAppTab===...)` | 移动 computed | **迁进壳层** |
| L839 | `watch(isMobileLayout, ...)` 移动过渡（移动端恒 open） | 移动 watcher | **迁进壳层** |
| L859 | `useAgentDock({ ... isMobileLayout })` | 契约参数 | **改造：dock 自取 `useAgentMobileLayout()`，去参数** |
| L1005 | `if (isMobileLayout.value) floating.value = false`（`openPanel`） | 移动行为 | **迁进壳层** |
| L1253 | `if (isMobileLayout.value && v.trim()) composerExpanded.value = true`（`watch(input)`） | 移动行为 | **迁进壳层** |
| L1264 | `if (isMobileLayout.value) composerExpanded.value = true`（`onComposerFocusIn`） | 移动行为 | **迁进壳层** |
| L1272 | `if (!isMobileLayout.value) return`（`onComposerFocusOut`） | 桌面守卫 | **删（PC-only 下恒为真）** |
| L1295 | `mobileBarIdle` computed：`isMobileLayout.value && (mobileBarShape==='idle'...)` | 移动 computed | **迁进壳层** |

> 注：早先记录曾把残留点误记为 `L1217/L1228/L1236/L1259`，已核实为漂移错号（那几行经 grep 验证**不含 `isMobileLayout`**）。以本表 grep 实证为准。

**分类合计**：绑定 1 + 派生 1 + 冻结内 1 + 迁移 6 + 契约 1 + 删除 1 = 11。PR5 完成后预期：`AgentSideRail` 仅保留绑定/派生/冻结内/契约（dock 自取后 `isMobileLayout` 在 SFC 内的"直读"降为绑定+派生+冻结内 3，加上 dock 内部自取 1 = 4）；6 迁移 + 1 删除使总数降到 **4**。

## 2. 四条必须回答的范围问题（本 spike 产出）

### Q1 什么进壳层（6 处迁移：L737/L839/L1005/L1253/L1264/L1295）

这 6 处是移动态 `composerExpanded` / `mobileBarIdle` / `railHiddenByTab` 与移动过渡行为。需定"壳层如何消费"：

- **(a) 壳层自持移动态（推荐）**：`MobileCanvasShell` 直接 `useAgentMobileLayout()` 自算 `isMobileLayout`，在壳内维护 `composerExpanded` / `mobileBarIdle` / `railHiddenByTab` 等移动专属态；`AgentSideRail` 在 PC 模式下不再持有这些态。移动态本就是壳的专属语义，且 hook 已存在可复用，避免 `AgentSideRail` 继续当"移动态中转站"。
- **(b) 壳层接收透传**：`AgentSideRail` 算好移动态经 props/emits 传给壳。

**(a) 隐含架构决策**：若移动端完全由壳接管，则 `AgentSideRail` 应成为 **PC-only 组件**——这正是 L1272 死代码删除的前提（见 Q2）。

**(a) 的配套改动**：`composerExpanded` / `mobileBarShape` / `mobileAppTab` 等状态当前由 `AgentSideRail` 持有并被模板/子组件消费，迁进壳层的"状态所有权转移"必须配套改 `CanvasPage.vue` 的移动入口接线（已有 `CanvasPage.mobileEntryWiring.test.ts` 等，改动须同步）。**spike 须先定 Q1 才能定 Q2/Q3 的最终计数。**

### Q2 什么留 PC-only 变死代码（1 处删除：L1272）

`if (!isMobileLayout.value) return` 在 `onComposerFocusOut`（焦点失焦处理器）里。

- 若 Q1 使 `AgentSideRail` 成为 **PC-only**（移动端由壳渲染）→ 该 guard 恒为真 → **删除**（须核对 L1273+ 是否整段移动专属收起逻辑一并迁/删）。
- 若 `AgentSideRail` 在移动端仍渲染 → 该 guard 是活代码，**不能删**。

⇒ Q2 直接依赖 Q1 的架构决策，不可独立定。

### Q3 壳与 dock composable 的契约（L859）

- 现状：`useAgentDock` 接收 `isMobileLayout: Ref<boolean>` 参数（`useAgentDock.ts:25/33`），内部 `panelTeleported` / `asidePanelWidth` / `ensureMobileDockRO` / `toggleFloating` / `startDrag` / `startResize` 等多处消费。
- 目标契约：`useAgentDock` **自取** `useAgentMobileLayout()`（composable 调 composable，已可行），从 `AgentDockState` 接口移除 `isMobileLayout` 字段；`AgentSideRail` L857-859 不再传该参数。
- **波及面已核实**：`useAgentDock` 全局**仅 1 个生产调用方**（`AgentSideRail.vue:857`）+ 测试（`useAgentDock.test.ts:43`）。改造低危，但须同步改 `useAgentDock.test.ts`（移除参数传入用例、新增"dock 内部自取布局"契约用例）。

### Q4 质量闸门（A-6 真机复测）

任何移动变更落地前，**必须过 A-6 真机复测**（移动端裸条/抽屉/composer 伸展/焦点交互）。A-6 是 PR5 的**合并前置**，不是事后补。

## 3. 验收判据草案（供正式规格采纳）

1. `AgentSideRail.vue` 的 `isMobileLayout` 有效读取：绑定 1 + 派生 1 + 冻结内 1 + 契约 1（dock 自取）= **4**；6 迁移 + 1 删除使总数从 11 降到 4。
2. 行为级 RED→PASS：真实 `mount(AgentSideRail)` + PC/移动两端 DOM 形态 + 冻结边界 11 项（L469 不变）+ 移动态在壳内正确（新增 `MobileCanvasShell` 用例）。
3. 变异测试 ≥ N 组：含 L859 契约变异（dock 不取布局 ⇒ RED）、L1272 删除变异（删后移动焦点回归 ⇒ RED）。
4. `verify-is-mobile-layout-scope.py` 的 `MAX_ALLOWED` 从 11 下调到 4（正则 `^MAX_ALLOWED = 4$` 与常量行**先正则后常量**双处同步，防子串双命中——前序教训）。
5. CI 三必需 + 生产 web-only 发布 + bundle 五证 + A-6 真机。

## 4. 风险

- **R1（高）** Q1 架构决策未定就动手 ⇒ 返工。spike 必须先定 Q1，正式规格前完成 brainstorm。
- **R2（中）** 状态所有权转移波及 `CanvasPage.vue` 移动入口（已有 `mobileEntryWiring` 等测试，改动须配套）。
- **R3（中）** L1272 删除依赖 Q1；若误删活代码 ⇒ 移动端焦点交互回归。
- **R4（低）** `useAgentDock` 虽仅 1 生产调用方，但契约改造须同步 `useAgentDock.test.ts`。
- **R5（低，前序教训）** guardrail `MAX_ALLOWED` 调整必须与 verifier 正则 + 常量双处同步。

## 5. 明确不做（范围外）

- 不碰 `sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项冻结边界。
- 不执行母规格 §9 字面"删 PC 冗余渲染"——已 adjudicate `NO_DELETE_TARGET`（见 `phase4-delete-scope-rebaseline-design.md`），删除刀按 §9 字面**终止**。
- 不新建 required check；不碰 `deploy.yml`。

## 6. 推进建议

1. 本 spike 经用户确认后，按 superpowers 纪律（`brainstorming` → `writing-plans`）起草正式 13 章规格。
2. 正式规格按路线 ③ 纪律逐 PR 实施（每刀：规格/计划 → 行为级 RED→PASS → 变异 → 门禁 → 生产复测 → 证据回填）。
3. 当前窗口动作（本 spike + Phase 4 关闭）均**零产品代码、零发布风险**（`deploy.yml` 的 `push.paths` 不含 `docs/`）。

## 7. 诚实边界

- 本 spike 是**范围设计**，不是已实施方案；不宣称任何迁移/删除已完成。
- 不宣称"12 点全搬"（路线 ③ 已停在 11，剩 8 移交 PR5）；不宣称布局已移出 Shell（待 PR5 决策）。
- 母规格 §9 删除刀 `NO_DELETE_TARGET` 结论成立，删除域功能**无待办**。
