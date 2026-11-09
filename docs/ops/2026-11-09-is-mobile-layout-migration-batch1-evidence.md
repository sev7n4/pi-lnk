# `isMobileLayout` 逐处搬第一批 · 证据（2026-11-09）

> 规格：`docs/superpowers/specs/2026-11-09-is-mobile-layout-migration-batch1-design.md`
> 计划：`docs/superpowers/plans/2026-11-09-is-mobile-layout-migration-batch1.md`
> 运行手册：`docs/ops/2026-11-09-is-mobile-layout-migration-batch1-runbook.md`

## 1. 取证基线

- 写作时 true master `2b6693c579ffb2931a84d1954e93fecf5617db91`；从 `gh api` Git Data API 取回 `AgentSideRail.vue` 并覆盖工作树，裸 blob sha `47885faf0d6e254c2a2c2d640b5ef18814d5b563` 校验通过（`RESTORED_FROM_MASTER True`）。
- 剥离注释后有效 `isMobileLayout` 读取点 **21**，逐行分类如下（行号为剥注释后行号）：

| 类 | 行号 | 内容摘要 |
| --- | --- | --- |
| A 唯一来源 | L208 | `const { isMobileLayout } = useAgentMobileLayout()` |
| B 模板否定 ×7 | L2265 | `'is-docked-open': open && !floating && !isMobileLayout` |
| | L2333 | `:style="floating && !isMobileLayout ? { ... } : undefined"` |
| | L2341 | `v-if="!isMobileLayout"` 的 `agent-resize-handle` |
| | L2351 | `:class="floating && !isMobileLayout ? 'cursor-move' : ''"` |
| | L2358 | `<p v-if="!isMobileLayout" class="agent-subtitle">lnk·π agent</p>` |
| | L2365 | 浮动窗口切换按钮 `v-if="!isMobileLayout"` |
| | L2387 | 收起按钮 `v-if="!isMobileLayout"` |
| C 模板肯定 ×3 | L2288 / L2318 / L3050 | 移动历史抽屉 / 面板 class / `mobile-enter-newline` |
| D 脚本逻辑 ×10 | L390 / L585 / L643 / L662 / L795 / L802 / L963 / L968 / L975 / L993 | expose getter / computed / watch / dock 参数 / composer / floating |

- 面板根为 `v-show="open && !railHiddenByTab"` 且 `open = ref(false)` ⇒ 子元素仍在 DOM 中，行为级断言可稳定观测。
- 七个模板否定命中在真实文件行 2950 / 3021 / 3029 / 3043 / 3052 / 3061 / 3083；替换前脚本断言模板区 `!isMobileLayout` 恰 7 处。

## 2. 行为级 RED → PASS

```text
# 搬迁前（基线）
✓ ① PC 端三个桌面专属 DOM 锚点均存在（有效性断言）
✓ ② 移动端三个桌面专属 DOM 锚点均不渲染
× ③ 源码契约：派生定义是纯否定，模板区不再出现 !isMobileLayout
✓ ④ 冻结边界：defineExpose 11 项与 getIsMobileLayout 契约零改写
→ 3 passed / 1 failed（精确 RED，非崩溃）

# 搬迁后
✓ src/components/agent/AgentSideRail.desktopDockDerived.test.ts (4 tests)
Test Files 1 passed (1) / Tests 4 passed (4)
```

- 环境补齐：移动端分支 `useAgentDock` 会 `new ResizeObserver(...)`，jsdom 无此全局 ⇒ 测试内 stub 一个空实现；这是测试环境补齐，不改产品语义。Teleport 到 body ⇒ 统一从 `document.body` 查询；PC 端先做有效性断言防「两端都不存在」假绿。
- 搬迁后实测：模板区 `isDesktopDock` 7 次、残留 `!isMobileLayout` 0 次、有效读取点 **15**。
- 相关回归集 7 个文件 **37/37 PASS**（`desktopDockDerived` / `dockLayout` / `mobileLivePin` / `canvasRefEntry` / `defineExpose` / `mobileMaskTabbar` / `askInline`）。
- `vue-tsc -b` exit 0。

## 3. 门禁收紧

```text
BEFORE 21 hits 2 / regex hits 1
AFTER  15 hits 2 / regex hits 1
PASS V3  Shell 读取点 15 <= 15，方向判据在位
VERDICT ALL_PASS
```

`MAX_ALLOWED = 15` 与 V3 的 `re.search(r'^MAX_ALLOWED = 15$', impl, re.M)` **双处同步**；只改一处会假红或恒绿（M3 实证）。

## 4. 变异测试 6/6

| 组 | 变异 | 期望 | 实测 |
| --- | --- | --- | --- |
| M1 | `isDesktopDock` 定义改成 `computed(() => true)` | 行为级 RED | `vitest_red=True`，gate 仍绿 |
| M2 | 少替换一处模板（还原 `!isMobileLayout`） | 行为级 RED | `vitest_red=True`，gate 亦 V3 RED |
| M3 | 只把 `MAX_ALLOWED` 常量抬回 21 | 门禁 V3 RED | `VERDICT HAS_FAILURE V3`，vitest 仍绿 |
| M4 | 删掉一个 `defineExpose` 项 | 行为级 ④ RED | `vitest_red=True`，gate 仍绿 |
| M5 | 脚本区注释写 `!isMobileLayout` | 全绿（不误报） | `vitest_red=False`，`gate=True` |
| M6 | 新增一处 `isMobileLayout.value` 读取 | 门禁 V3 RED | `VERDICT HAS_FAILURE V3`，vitest 仍绿 |

`MUTATIONS 6/6`、`ALL_LOCAL_MATCH True`（SFC / 门禁脚本 / 测试文件三项恢复后裸 blob sha 全等）。

⭐ **无伪变异**：M4 用「删一个 expose 项」而非「改名成未定义标识符」，避免编译崩溃伪造 RED；M5 注释写在脚本区，既验证 `strip_comments` 生效，又不触发 vitest ③ 的模板区断言。

## 5. 全量门禁

| 门禁 | 结果 |
| --- | --- |
| `vitest run` 行为级 4 用例 + 相关回归 7 文件 | 37/37 PASS |
| `vue-tsc -b` | exit 0 |
| `verify-is-mobile-layout-scope.py` | `VERDICT ALL_PASS`（计数 15 <= 15） |
| `verify-phase4-delete-scope.py` | `VERDICT ALL_PASS NO_DELETE_TARGET` |
| `verify-pc-canvas-legacy-scope.py` | `VERDICT ALL_PASS NO_MERGE_NO_DELETE_TARGET` |
| `pnpm verify-spec-figures --file <本规格>` | 0 error / 0 warning |
| `pnpm verify-spec-figures`（全量 216 篇） | 0 error / 2 个既有历史 warning，不归因本刀 |
| `pnpm verify-agent-rail-gates` | 11/11 |
| `pnpm verify-claims` | 7/7 |
| `pnpm verify-links` | 全绿（既有历史链接提示不归因本刀） |
| `python3 scripts/verify-web-upload.py` | 13/13 |

## 6. 实现期修正（只追加，不改写规格 §1–§13）

1. `ResizeObserver is not defined`：移动端分支触发 `useAgentDock.ensureMobileDockRO()` ⇒ 测试内补 stub，否则移动用例是**环境崩溃**而非形态断言失败。
2. `defineExpose` 切片初版从 `defineExpose({` 一直切到文件末尾，包含模板区 ⇒ 删掉一个 expose 项的 M4 变异不 RED（模板里仍有同名函数）。改为切到 `</script>`，M4 精确 RED。
3. M3 初版同时替换常量与方向判据正则 ⇒ 两者同步、V3 仍绿（伪变异）。改为只替换第一处常量，V3 精确 RED。
4. 冻结边界测试 ④ 的 `EXPOSE_KEYS` 为实测 11 项：`newAgentSession` / `openThreadHistory` / `closeThreadHistory` / `openPanel` / `closePanel` / `setComposerInput` / `addAttachment` / `reconcileFromNodes` / `confirmProposeWait` / `cancelProposeForNode` / `addFromCanvasNodes`。

## 7. 诚实边界

- 本刀**不宣称** 21 点全部搬迁、**不宣称**布局分支移出 Shell、**不宣称**新增 required check、**不宣称**像素或真机视觉复测。
- 行为级测试覆盖的是 7 处锚点对应的 DOM 存在性（PC / 移动两端），不是像素 diff；A-6 真机复测仍为独立窗口待办。
- 本刀零改动母规格、`ci.yml` 挂载行、`package.json`、`deploy.yml`、`presentation/**`、`packages/shared/**`、`pc-visual-baseline.json`。
- `deploy.yml` 的 `push.paths` 含 `apps/web/**` ⇒ 合并会触发一次 web-only 生产发布，复测结果在 §8 只追加登记。

## 8. 执行时状态回填（2026-11-09，只追加）

### 8.1 合并与树核对

```text
CI run 42599820110     Verify spec figures / Build monorepo / Build API Docker image = 3/3 success
check-runs(head e53da64b)                                       3/3 success
PR #799 squash MERGED  cb244af9fb43eb7944f30ad9ce75c522fa66798c
REAL_PARENTS           ['83d59fb496e2aef65da9a121744c4eed7f22a8b4']  PARENT_OK True
DIFF_COUNT 7           EXACTLY_OUR_7 True   NO_OTHER True
MASTER_EQ_PRHEAD True  合并树 7 路径裸 blob sha 与 PR head 逐字节全等
ALL_PARALLEL_KEPT True（CI 期间 master 未前移）
```

⭐ **`ALL_LOCAL_MATCH False` 的诊断与处置**：合并脚本按本地工作树复核时只有 `AgentSideRail.vue` 不等。逐路径比对确认 `MASTER_EQ_PRHEAD True`（**远端交付正确**），漂移只发生在本地：并行会话给该 SFC 加了「2026-11-09 真机修复 #1：附件卡 Teleport 到 body」，其中两处 `:disabled="!isMobileLayout"` 新增 2 个读取点，本地门禁实测 `Shell 读取点 17 超过上限 15`。按纪律**不推送这份本地脏改动、不 `reset --hard` 覆盖他人工作**，门禁以 CI checkout 的远端源码为准（runbook §7）。

⚠️ **风险锚（留给后继刀）**：若该并行真机修复日后合入 master，两处新增读取会直接撞上 `MAX_ALLOWED = 15`。后继刀须二选一并显式声明：把它们一并收敛进 `isDesktopDock`，或在独立小刀里精算上调上限（上限只降不升是棘轮方向，上调必须给出充分理由 + 行为级测试 + 变异，不得静默放宽）。

### 8.2 生产发布复测

```text
deploy run 42601656878  head_sha = cb244af9…  conclusion success（4m03s）
  Detect changes            success
  Deploy web to CVM         success
  Build API on CVM          skipped   ← web-only 发布，符合预期
  Recover CVM only          skipped
health=200  {"ok":true,"service":"lnkpi-api",...}
web=200
dist/index.html mtime     2026-11-09 18:34:33 +0800（部署时刻）
```

**bundle 级下钻**（不把「字面量命中」当判据，下钻到懒加载 chunk 的 setup 段）：

| 项 | 部署前 | 部署后 |
| --- | --- | --- |
| CanvasPage chunk | `CanvasPage-kaBa-bVq.js` | `CanvasPage-D71wCzDt.js`（旧文件已被差量同步替换） |
| 三桌面锚点 | `agent-resize-handle` / `agent-subtitle` / `收起助手` 各 1 | 各 1（零丢失） |
| setup 段 | `{isMobileLayout:l}=or(),u=bo(),…` | `{isMobileLayout:l}=ar(),u=R(()=>!l.value),…` |
| resize-handle 条件 | `N(l)?U("",!0):(v(),y("div",{key:0,class:"agent-resize-handle"…` | `u.value?(v(),y("div",{key:0,class:"agent-resize-handle"…` |

⭐ `u=R(()=>!l.value)` 即 `const isDesktopDock = computed(() => !isMobileLayout.value)` 的 minified 形态；渲染条件由「对布局 ref 取反」变为「直接读派生 ref」，7 处替换已 live。`isDesktopDock` 字面量在新 chunk 中为 **0** —— setup 局部 const 被压缩成 `u`，**这是压缩策略而非未部署**，故取证以「setup 派生结构 + 渲染条件 + 三锚点 + chunk hash 变化 + health」五证为准，不谎报字面量命中。纯否定 computed 在该 chunk 中共 2 处，另一处属其他组件，不作为本刀判据。

### 8.3 诚实边界

- 本刀**不宣称** 21 点全部搬迁（剩余 15 点：A 1 + 新派生 1 + C 3 + D 10）、**不宣称**布局分支移出 Shell、**不宣称**新增 required check、**不宣称**像素或真机视觉复测。
- 生产复测是「部署成功 + 接口健康 + bundle 结构级」取证，**不是** CDP 五层冒烟，也不是 A-6 真机复测；两者仍是独立窗口。
- 本节为执行时状态回填，按「历史时点结论不追溯改写，只做只追加状态回填」原则原样保留 §1–§7。PR #625 / A-6 维持独立窗口。

## 9. 风险锚消解状态回填（2026-11-09 22:10，只追加）

> 本节只追加登记 §8 留下风险锚的**当前状态**；§1–§8 为历史时点结论，按纪律原样保留，不追溯改写。

- ✅ **并行 PR #800 已消解**：并行窗口重建 TRUE MASTER 源码 + rebase onto #799 ⇒ head `cb5beeb5` / CI `42606222774` 全绿 / squash `5ca09b1d`。两处新增 Teleport 写成 `:disabled="isDesktopDock"`（而非 `!isMobileLayout`），**主动复用第一批派生**；`useMobileKeyboardInset.ts` 单行压平与冻结契约缺失均已修复。随后 #803 / #804 键盘贴边迭代已发布。
- ✅ **第一批成果零回退**：master 前移 3 提交到 `e743c469becb61e4186cbf9c1963a37f431a8048` 后，从 true master 重取证实测有效读取点 **15/15**、`MAX_ALLOWED = 15`、V3 方向判据在位、模板区 `!isMobileLayout` 0、`isDesktopDock` 消费点 7→9；master CI `42626712920` 的 `Verify agent rail contract gates` / `Verify isMobileLayout scope` / 两条删除域棘轮全 success。compare 只动 4 文件，第一批其余 6 路径零变化。
- ⇒ §8 的「若该并行修复合入会撞 `MAX_ALLOWED = 15`」告警**未发生**：并行窗口按建议显式收敛了两处读取。该告警作为当时的有效风险识别保留，本节登记其后续结果。
- ⭐ **后继方案差异**：本文件 §7 与第一批规格 §12 预告「第二批上限 15 → 13（新增 `isMobileDock` 派生）」；实际第 4 刀改用 `!isDesktopDock`（严格等价、不新增读取点），上限 **15 → 12**。差异理由与验收见 `docs/superpowers/specs/2026-11-09-is-mobile-layout-migration-batch2-design.md` §3。
- 本节不宣告「21 点全搬」「母规格 Phase 4 功能闭环」「真机视觉复测」；PR #625 / A-6 仍为独立窗口。
