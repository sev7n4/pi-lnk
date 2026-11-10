# `isMobileLayout` 第三批（D 类第一批）证据 · 路线 ③ 第 5 刀

> 配套：`docs/superpowers/specs/2026-11-10-is-mobile-layout-migration-batch3-design.md`
> 真值基线：`ecf4ee0dd1aa36cec6db79bbad6a630de1ce622f`（仅 PR #802 纯文档合入前移，SFC/门禁 blob 不变）
> 本文件为执行时状态回填；Task 6 实测值已填入 §1–§7，§8 为执行期只追加状态。

## 1. 重取证（true master 取回 + 裸 blob sha）

- SFC / 门禁脚本 / 本刀测试 的 master blob sha 与本地取回 sha **全部全等（MATCH）**：

  | 工件 | blob sha（local == remote） |
  | --- | --- |
  | `apps/web/src/components/agent/AgentSideRail.vue` | `3c92d44479fa` |
  | `scripts/verify-is-mobile-layout-scope.py` | `4090197e1f2a` |
  | `apps/web/src/components/agent/AgentSideRail.closePanelDock.test.ts` | `cfcb6cc53d42` |
  | `docs/superpowers/specs/2026-11-10-is-mobile-layout-migration-batch3-design.md` | `268ed2581ef4` |
  | `docs/superpowers/plans/2026-11-10-is-mobile-layout-migration-batch3.md` | `3d63f1354624` |
  | `docs/ops/2026-11-10-is-mobile-layout-migration-batch3-runbook.md` | `3625ab3eaee1` |

- 剥离注释后有效读取点（本刀**执行前**基线）：**12 = 绑定来源 1 / 派生定义 1 / 冻结内 1 / D 类 9**（规格 prose 曾误写「D 类 10」，实测为 9，验证数值 11/14 正确不归因）。
- 本刀搬走 D 类 1 处（`closePanel` L1013）→ **执行后有效读取点 = 11 = 绑定 1 / 派生 1 / 冻结内 1 / D 类 8**（剩 L737/L839/L859/L1005/L1217/L1228/L1236/L1259 等 8 处）。

## 2. RED → PASS

- 改前（源码仍直读 `isMobileLayout`）：`Tests 1 failed | 4 passed (5)`（仅用例 ③ 源码契约失败）。
- 改后（`closePanel` 改用 `!isDesktopDock`）：`Tests 5 passed (5)`。
- 回归集 9 文件全 PASS（含既有第二批 `mobileDockDerived.test.ts` 等）。

## 3. 变异（6 组）

| ID | 注入 | 期望 | 实测 | 判据 |
| --- | --- | --- | --- | --- |
| M1 | `!isDesktopDock` → `isDesktopDock`（语义反转） | RED | 2 failed | 行为级 + 源码契约 |
| M2 | 还原 `isMobileLayout` 直读 | RED | RED（行为级 + V3 方向判据双转红） | 方向判据 |
| M3 | `MAX_ALLOWED` 抬回 12 | RED | V3 RED | 棘轮门禁 |
| M4 | 删 `newAgentSession` 冻结键 | RED | 1 failed | 冻结边界 |
| M5 | 注释内写 `isMobileLayout` 字面量 | GREEN_CTRL | 对照绿（验证非伪绿） | 控制组 |
| M6 | 新增一处 `isMobileLayout` 读取 | RED | V3 RED | 棘轮门禁 |

- `MUTATIONS 6/6`；`ALL_LOCAL_MATCH True`。M5 为对照绿，证明门禁对「注释写字面量」不误判（非伪绿）。

## 4. 门禁与编译

- `verify-is-mobile-layout-scope.py`：**`VERDICT ALL_PASS`**，Shell 读取点 `11 <= 11`，方向判据（`r'^MAX_ALLOWED = 11$'`）在位；`isDesktopDock` 总消费 ≥ 14。
- `vue-tsc -b`：exit 0。
- `agent-rail-gates`（冻结 `defineExpose` 11 项）：11/11。
- `spec-figures`：本规格 0 error（全量 2 warning 为历史遗留，非本刀引入）。

## 5. 推 PR / CI / 合并树

- PR：**#808**，head `8b33cf99de7c28de949bf8d1c659c86038bada0a`，base `ecf4ee0dd1aa`，mergeable true。
- CI 三必需（run `42724791828`）：`Verify spec figures` success / `Build monorepo` success / `Build API Docker image` success。
- squash 合并 → master **`8c8a2dca6cc6525213129f4a4e4c5aa3fea13e53`**，单一 parent `ecf4ee0dd1aa`（PARENT_OK）。
- 合并树全树 blob 核对 6/6 MATCH，`FILES_CHANGED_VS_BASE 6`，`ONLY_OUR_6 True`（`MASTER_EQ_PRHEAD True` / `ALL_PARALLEL_KEPT True` / `NO_OTHER True`）。临时分支已删。

## 6. 生产复测（web-only 发布）

- 发布 run：**`42726377839`**（`Deploy to Tencent Cloud`），conclusion success。
  - `Detect changes` success / `Recover CVM only` skipped / `Deploy web to CVM` success / `Build API on CVM` skipped → **web-only 发布**（仅 `apps/web/**` 触发）。
- 健康：`curl /api/health` → `{"ok":true,"service":"lnkpi-api","timestamp":"2026-11-10T00:14:40Z"}`。
- 生产 bundle 五证（chunk `CanvasPage-8ibKst1i.js`，sha256 `49719b823d95dc15fc0cc2f828eb16f9bdb3ea52697675e854d36c0ea246d64f`）：
  1. **chunk hash 变更**：内容哈希命名 chunk，本刀改 `closePanel` 逻辑 ⇒ 哈希后缀相对 #807 部署变化（生产 bundle 不保旧 chunk，以内容哈希差异为证）。
  2. **派生结构在位**：`isMobileLayout:l`（setup 绑定）+ `R(()=>!l.value)`（`isDesktopDock` 单源派生），`u` 即 mangled `isDesktopDock`。
  3. **渲染/行为条件**：`closePanel` 生产形态 `function hr(){u.value&&($t.value=!1,a("expandedChange",!1))}` —— `u.value&&B` 与源码 `if(!isDesktopDock.value)return;B` 控制流等价（B 仅在桌面执行），emit `expandedChange` false 仅桌面。✅ 行为级等价。
  4. **DOM 锚点**：源级由 `closePanelDock.test.ts` 覆盖（PC 三桌面锚点各 1 / 移动 dock+抽屉），生产同源代码路径；**未做像素/真机视觉复测**。
  5. **health** ✅。
- 零回退并行改动：合并树 `ONLY_OUR_6 True` + web-only 发布仅动 `AgentSideRail.vue`，API 未变。

## 7. 状态回填

- Issue #755：只追加本刀闭环段（不改写历史验收）。
- `.workbuddy/memory/2026-11-10.md` 与 `MEMORY.md`：追加 #808 闭环段 + 索引更新。
- **诚实边界（不粉饰）**：
  - 不宣称 12 点全搬（剩 11：绑定 1 / 派生 1 / 冻结内 1 / D 类 8），留后续批逐处降上限，目标地板 2 = 绑定 1 + 派生 1。
  - 不宣称布局分支移出 Shell；不宣称新增 required check；不宣称像素/真机视觉复测。
  - 母规格 Phase 4「删 PC 冗余渲染」功能仍 ⏳ 未闭环。
  - 规格 prose 曾误写「D 类 10」，实测 9，验证数值正确不归因（已于 §1 更正）。

## 8. 执行时状态回填（append-only）

- 2026-11-10（执行期）：deploy run `42726377839` success（web-only）；生产五证齐（chunk hash / 派生结构 / `hr` 行为条件 / DOM 锚点源级 / health）；零回退。合并树 6/6 MATCH、`ONLY_OUR_6 True`。证据文档 §1–§7 回填完成；Issue #755 与 memory 追加待本 PR 推入后闭环。
