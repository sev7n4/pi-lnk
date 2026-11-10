# PR5 画布世界两处 `isMobileLayout` 残留 · 定位重构可行性 Spike（主线 §11 收口）

> 状态：**已完成裁决（2026-11-10，PM + 架构师）** — 结论 `NO_GO_FOR_MIGRATION`（两处均不搬）
> 类型：**范围设计 / 可行性 spike**（非 13 章规格），对应 `docs/superpowers/specs/2026-11-10-pr5-mobile-isMobile-layout-convergence-design.md` §11 第 2 项钦定动作
> 真值基线：true master `0e7dd154bd000b35c5aba19302b431bfa113820b`（2026-11-10 17:30，`gh api` 取源码逐行核对）
> 关联：路线 ③ 收口裁决（PR #816，`ea509049`）；`docs/agent/pr5-mobile-shell-scope-spike.md`（已 superseded）；设计 `docs/design/2026-10-19-mobile-canvas-ux-redesign.md` §6.1/§6.5
> 前序教训：早先 spike 未核真值即假设「6 迁移 + 1 改造 + 1 删死代码」，被 #816 收敛审计证伪。本 spike **先取证再判**，不预设可搬。

---

## 0. 定位与背景

收敛规格 §11 把「VueFlow 胶囊 / 空态 2 处残留」登记为**独立可行性 spike**，其唯一来源是一行注释：

> `MobileCanvasShell.vue` L10–13：「画布世界（VueFlow + 胶囊 MobileCanvasTopControls + 空态 mobile-canvas-empty）仍由 CanvasPage 承载——胶囊包在 VueFlow 的 `<Panel>` 内、空态 absolute 在 canvasArea 内，依赖 VueFlow 内部定位，不能搬出。**这两处 isMobileLayout 残留留待后续定位重构**（已在 PR 描述标注）。」

本 spike 要回答的只有一个问题：**这两处残留是否真的存在、是否值得搬进壳层**。结论先行：**一处已消解，一处不可搬**，`MAX_ALLOWED=11` 保持不动，§11 该项关闭。

---

## 1. 真值取证（全部对 true master，可复现）

| # | 证据 | 判据 / 命令 | 结果 |
|---|---|---|---|
| 1.1 | `MobileCanvasTopControls.vue` 组件文件 | `gh api repos/sev7n4/pi-lnk/git/trees/<M>?recursive=1 --jq '.tree[].path' \| grep -i topcontrols` | **0 命中**。全树只剩 `CanvasBottomLeftControls.vue`；组件已在 2026-10-27 三页顶栏重构删除（plan `2026-10-27-mobile-web-three-page-topbar-redesign.md` L59 明示「无桌面用途则删除组件」） |
| 1.2 | 胶囊不得回潮有静态守卫 | `CanvasPage.mobileChromeHygiene.test.ts:46` | `expect(page).not.toMatch(/<MobileCanvasTopControls[\s\S]*?\/>/)`；同行注释「浮动 ⤢ 实例已从 CanvasPage 移除（上提至 MobileTopBar）；**注释里的旧名不计**」 |
| 1.3 | ⤢ 上提有规格与测试双证 | 规格 `2026-10-27-mobile-web-three-page-topbar-redesign.md:125`；`CanvasPage.viewport.test.ts:16` | ⤢ 从浮动胶囊**上提至顶栏右侧**，经 `fit-view` → 壳层 → `useVueFlow().fitView()`；测试注释逐字复述 |
| 1.4 | 所谓「胶囊残留」的真实代码 | `CanvasPage.vue:6388` | `<Panel v-if="!isMobileLayout" position="bottom-right">` 内装 **`CanvasBottomLeftControls`（PC 专属）**。这是 **PC 工具条的移动端隐藏门控**，不是移动端胶囊；`v-if="!isMobileLayout"` 是正确且必要的 |
| 1.5 | 空态结构 | `CanvasPage.vue:6404–6414`、CSS `6697–6719` | `<div v-if="isMobileLayout && mobileAppTab === 'canvas' && !nodes.length" class="mobile-canvas-empty">`，`position:absolute; inset:0; pointer-events:none`，挂在 `canvasAreaRef` 容器内；文案分支依赖 `mobileCanvasImm` |
| 1.6 | 空态被静态契约逐字钉死 | `CanvasPage.mobileEntryWiring.test.ts:148–155` | `expect(page).toMatch(/v-if="isMobileLayout && mobileAppTab === 'canvas' && !nodes\.length"/)` + `data-testid="mobile-canvas-empty"` + 文案断言。**搬走即 RED** |
| 1.7 | 壳层的坐标系与 props | `CanvasPage.vue:6570–6575`；`MobileCanvasShell.vue:94–135` | 壳层是 **fixed、挂载在 canvasArea 容器外**（注释：「避免被画布 transform 影响避让计算」）；props 有 `mobileAppTab` / `hasNodes`，**无 `mobileCanvasImm`**（壳层头部 L15–17 明示 view/imm 仍是 CanvasPage 内部状态） |
| 1.8 | 读取点计数口径 | `grep -c isMobileLayout` on true master | `AgentSideRail.vue` 12 行（含 L837 注释 1 行；guardrail `strip_comments` 后 **有效 11**）、`CanvasPage.vue` **26 行/26 次**。收敛规格 §5 表记 Rail 11 / CanvasPage 28 为**历史审计口径**，差 2 处未在源码逐字命中；按纪律**不追溯改写历史结论**，仅此登记 |

> 复现基线：`M=0e7dd154bd000b35c5aba19302b431bfa113820b`；`gh api "repos/sev7n4/pi-lnk/contents/<path>?ref=$M" --jq '.content' | base64 -d`。本地主仓工作树长期脏，本 spike **不采信任何本地源码读数**。

---

## 2. 可行性裁决

### 2.1 残留 ①「VueFlow 内胶囊」= **伪目标（已消解）**

2026-10-27 三页顶栏重构已把 ⤢ 上提至 `MobileTopBar`、浮动胶囊组件删除，并有静态守卫防回潮。当前 `<Panel v-if="!isMobileLayout">` 是 **PC 专属工具条**，与「移动端胶囊」无关，也不是可迁移对象。

⇒ **NO-GO**。§11 里「胶囊」这一半待办应予**注销**，不是"留待后续"。

### 2.2 残留 ②「空态」= **不可搬（架构约束成立）**

| 约束 | 说明 |
|---|---|
| 定位坐标系 | 空态 `absolute; inset:0` 依赖 `canvasAreaRef`；壳层 fixed 且在容器外，搬入后 `inset:0` 变成贴全屏，覆盖顶栏/页签/FAB，且不受画布 transform/裁剪约束 |
| 真源边界 | 文案分支依赖 `mobileCanvasImm`（CanvasPage 内部状态，壳层明确不接收）；搬入须新增 prop 回写真源，违反「壳层只订阅它真正用到的状态」 |
| 契约成本 | `mobileEntryWiring.test.ts:148` 逐字钉死 `v-if` 在 CanvasPage；搬入须改守卫，属行为面改动而非零风险重构 |
| 真机风险 | 设计 §4.2 L220–222 记录过底部锚定 `absolute`→`fixed` 整类缺陷（＋FAB 掉出可见区）；把空态改 `fixed` 会重进该雷区 |
| 收益 | 仅减少 1 处 `isMobileLayout` 模板门控（26→25），`MAX_ALLOWED` 针对的是 `AgentSideRail`（11），**对棘轮零收益** |

⇒ **NO-GO**。壳层注释「依赖 VueFlow 内部定位，不能搬出」的**判断本身是对的**，错的是它把已删除的胶囊也算成残留。

### 2.3 被否决的「条件可搬」选项

- **抽成 `MobileCanvasEmpty.vue` 放 `components/mobile/`，仍由 CanvasPage 挂载**：符合 AGENTS.md 规则 4，但只是模板瘦身 ~10 行，`isMobileLayout` 读取点不减、壳层边界不变、静态契约仍要同步 ⇒ 收益不抵风险，且与「棘轮停在 11、不追求归零」的 #816 裁决相悖。**不做**。
- **改 `fixed` 放进壳层**：见 2.2 真机风险，否决。

### 2.4 主线条目处置

- 收敛规格 §11 第 2 项：由「开放 spike」→ **「已裁决关闭（NO_GO_FOR_MIGRATION）」**，状态以只追加方式回填。
- `MAX_ALLOWED=11` **保持不动**；不改 `verify-is-mobile-layout-scope.py`；不改任何产品行为。
- §11 另外两项（A-6 真机复测、未来 AgentSideRail 移动形态重构）不在本 spike 范围，状态不变。

---

## 3. 规格-实现漂移清单（本 spike 的实质产出）

三处注释仍描述「胶囊仍在」，与代码及静态守卫**直接矛盾**。这正是 #816 踩过的坑：错误文档会诱导后续会话继续磨不存在的对象。

| # | 位置 | 现状文本（摘要） | 与真值矛盾点 |
|---|---|---|---|
| D1 | `MobileCanvasShell.vue` L10–13 | 「VueFlow + 胶囊 MobileCanvasTopControls + 空态…胶囊包在 `<Panel>` 内…**这两处**残留留待后续定位重构」 | 胶囊组件已删除；`<Panel>` 内是 PC 工具条；残留实为 1 处且裁决不可搬 |
| D2 | `CanvasPage.vue` L6386–6387 | 「移动端隐藏（由 `MobileCanvasTopControls` 顶部胶囊接管）」 | ⤢ 已上提到 `MobileTopBar`，不是胶囊接管 |
| D3 | `CanvasPage.vue` L6572–6573 | 「画布世界（VueFlow + 胶囊 + 空态）仍在此页承载；胶囊/空态因依赖 VueFlow 内部定位暂留」 | 胶囊已不存在；空态是已裁决保留，非「暂留待重构」 |

另有 `CanvasPage.mobileChromeHygiene.test.ts:45` 注释「注释里的旧名不计」——守卫作者**当年就知道注释没同步**，但只豁免、未回填，漂移由此固化。

### 建议回填（下一刀，逐行替换、行数不变）

```
D1 → 「画布世界（VueFlow + PC 工具条 Panel + 空态 mobile-canvas-empty）仍由 CanvasPage
       承载——PC 工具条包在 VueFlow 的 <Panel> 内、空态 absolute 在 canvasArea 内，
       依赖 VueFlow/canvasArea 定位，不能搬出。浮动胶囊已于 2026-10-27 上提至
       MobileTopBar 并删除组件（见 mobileChromeHygiene 守卫）；空态经
       pr5-canvas-overlay-residuals-spike.md 裁决 NO_GO_FOR_MIGRATION。」
D2 → 「PC 右下视口工具条：移动端隐藏（移动端 ⤢ 适应画布已于 2026-10-27 上提至
       MobileTopBar，不再有浮动胶囊）。…」
D3 → 「画布世界（VueFlow + PC 工具条 + 空态）仍在此页承载；空态因依赖 canvasArea
       定位经可行性 spike 裁决保留（见 MobileCanvasShell 头部注释）。」
```

> 注释修正改 `apps/web/**` ⇒ 命中 `deploy.yml push.paths` **会触发生产发布**，故作为**独立小 PR**，须按「合并窗口单独授权 + 生产复测」纪律执行；本 spike 刀不含代码改动。预期 esbuild 剥离注释 ⇒ bundle 内容零变化，可作为发布复测的强锚点。

---

## 4. 建议动作与主线下一步（PM/架构师拍板）

1. **本刀（docs-only，零发布）**：本 spike + 收敛规格 §11 只追加状态回填；CI 三必需 + 16 验证 step 全绿后 squash 合并。
2. **下一刀（代码注释回填）**：按 §3 精确替换 3 处注释，行数不变 ⇒ V2 行数漂移 ratchet 不受影响；改动前跑 `CanvasPage.mobileChromeHygiene.test.ts` / `mobileEntryWiring.test.ts` / `viewport.test.ts`（守卫作者已注明「注释里的旧名不计」，预期全绿）；推 PR 后**停在合并前等授权**。
3. **A-6 真机走查**：设计 §7 明示「合并上线 ≠ 验收完成」，T-1~T-5/T-7~T-8、I-2~I-7、V-1~V-6 尚待逐项跑，须 iOS Safari + Android Chrome 真机 + 带鉴权会话，**本环境无法替代真机，不宣称通过**。
4. **§6.5 两条待裁决**（PC `MultiSelectToolbar` 底部化规格内部冲突、形态×能力集拆分被配对方案阻塞）：属独立产品决策，本 spike 不擅自裁定。

---

## 5. 明确不做（范围外）

- 不把胶囊 / 空态 / PC 工具条迁入 `MobileCanvasShell`；不改壳层边界与 props。
- 不降低 `MAX_ALLOWED`、不改 `verify-is-mobile-layout-scope.py`、不动 `AgentSideRail.vue`。
- 不碰 `sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项冻结边界。
- 不执行母规格 §9 字面「删 PC 冗余渲染」（`NO_DELETE_TARGET` 已闭环）；不新建 required check；不碰 `deploy.yml`。
- 不碰 #815/#817/#818 那条形似但无关的「历史失败横幅」线（另一并行窗口在推进）。

---

## 6. 验收判据

- **AC1**：§1 表中 8 条证据均可由给定命令在 true master 复现；结论「胶囊已消解 / 空态不可搬」有代码 + 测试 + 规格三证。
- **AC2**：`MAX_ALLOWED=11` 不变，`verify-is-mobile-layout-scope.py` `ALL_PASS`（V3 `11 <= 11`）。
- **AC3**：收敛规格 §11 以只追加方式回填 `NO_GO_FOR_MIGRATION`，不改写原表格与历史结论。
- **AC4**：本刀 DELTA 恰为 2 个 docs 路径，`deploy.yml` 零新 run（零发布）。
- **AC5**：§3 漂移清单三处注释逐条给出可执行替换文本，下一刀无需重新取证。

---

## 7. 诚实边界

- 本 spike 是**可行性裁决**，不是已实施方案；**不宣称任何迁移/删除已完成**，也不宣称 §11 全部后续项关闭（仅第 2 项）。
- 「胶囊已消解」是 **master 源码 + 静态守卫 + 规格**三证结论，未做真机 UI 走查。
- 空态「不可搬」是**架构与收益裁决**，不是技术绝对不可能；若未来壳层坐标系重构（fixed → 画布内）再重新评估，须另起 spike。
- A-6 真机走查仍欠，本 spike 不替代、不宣称验收完成。
