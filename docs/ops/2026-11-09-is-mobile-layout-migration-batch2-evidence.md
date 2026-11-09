# `isMobileLayout` 逐处搬第二批 · 证据（2026-11-09）

> 规格：`docs/superpowers/specs/2026-11-09-is-mobile-layout-migration-batch2-design.md`
> 计划：`docs/superpowers/plans/2026-11-09-is-mobile-layout-migration-batch2.md`
> 运行手册：`docs/ops/2026-11-09-is-mobile-layout-migration-batch2-runbook.md`

## 1. 取证基线与重取证

- 写作时 `gh api` true master **`e743c469becb61e4186cbf9c1963a37f431a8048`**，blobs 4930。并行窗口已从 `f7ea1c5b` 前移 3 提交：`5ca09b1d`（#800 重建 rebase onto #799）/ `a1671752`（#803）/ `e743c469`（#804），最近生产发布 `42626713021` success，health/web 200。
- 从 true master 取回三个目标文件并逐文件核裸 blob sha：`AgentSideRail.vue` `a50c6dd775c8`（278931 B）、`verify-is-mobile-layout-scope.py` `d17cb6adafab`（9828 B）、`AgentSideRail.desktopDockDerived.test.ts` `02e348f2983c`（5728 B）。实测**本地三文件与 master 逐字节相等** ⇒ 取回过程未覆盖任何未提交工作。
- 剥离注释后有效 `isMobileLayout` 读取点 **15 / `MAX_ALLOWED = 15`**，V3 方向判据 `^MAX_ALLOWED = 15$` 在位；master CI `42626712920` 的 `Verify agent rail contract gates` / `Verify isMobileLayout scope` / 两条删除域棘轮全 success ⇒ **第一批成果零回退**。
- 15 点分类（剥注释后行号）：A 唯一来源 L234 / 派生定义 L236 / C 模板肯定 3（L2984、L3014、L3747）/ D 脚本逻辑 10（L469、737、839、859、1005、1013、1217、1228、1236、1259）。
- ⚠️ 原始文件里 C 类对应 **L2987 / L3017 / L3930**（剥注释会压缩行号）⇒ 实现脚本按内容锚点定位，不用行号。
- `isDesktopDock` 在 true master 上消费点 **9**（第一批 7 + #800 两处 Teleport），定义 1 处。

### 1.1 前序风险锚消解（只追加状态回填）

第一批证据 §8 曾登记「并行 open PR #800 疑似产物压平损坏、若合入会撞 `MAX_ALLOWED = 15`」。实测并行窗口按建议重建 TRUE MASTER 源码 + rebase onto #799（head `cb5beeb5` / CI `42606222774` 全绿 / squash `5ca09b1d`），两处新 Teleport 写成 `:disabled="isDesktopDock"`，**主动复用第一批派生**；冻结契约 11 项恢复，#803 / #804 已发布。第一批证据 §9 登记该状态，§1–§8 历史时点结论原样保留。

## 2. 行为级 RED → PASS

```text
# 搬迁前（基线，真实 mount）
✓ ① PC 端：三桌面锚点各 1 / 无移动 dock / 打开历史后无移动抽屉
✓ ② 移动端：三桌面锚点各 0 / 移动 dock 1 / 打开历史后抽屉 1
× ③ 源码契约：模板区不得残留任何 isMobileLayout 读取
✓ ④ 冻结边界：defineExpose 11 项与 getIsMobileLayout 契约零改写
→ 3 passed / 1 failed（精确 RED，非崩溃）

# 搬迁后
Test Files  8 passed (8) / Tests 41 passed (41)
```

- 相关回归集 8 文件：`mobileDockDerived`(4) / `desktopDockDerived`(4) / `dockLayout`(3) / `mobileLivePin`(10) / `canvasRefEntry`(4) / `defineExpose`(4) / `mobileMaskTabbar`(8) / `askInline`(4)。
- 环境补齐：移动端 `useAgentDock` 触发 `ResizeObserver`（stub）、Teleport 到 body（统一从 `document.body` 查询）、面板 `v-show`（子元素常在 DOM）、PC 端先做有效性断言防「两端都不存在」假绿；`openThreadHistory()` 的 `fetchThreads()` 网络噪声用 `.catch(() => {})` 隔离，不吞 DOM 断言。
- 搬迁后实测：模板区 `isMobileLayout` **0**、`!isDesktopDock` **3**、`isDesktopDock` 总消费 **12**、有效读取点 **12**。

## 3. 门禁收紧

```text
BEFORE Shell 读取点 15 <= 15，方向判据在位
AFTER  Shell 读取点 12 <= 12，方向判据在位
VERDICT ALL_PASS
三条棘轮：ALL_PASS / ALL_PASS NO_DELETE_TARGET / ALL_PASS NO_MERGE_NO_DELETE_TARGET
```

`MAX_ALLOWED = 12` 与 V3 的 `re.search(r'^MAX_ALLOWED = 12$', impl, re.M)` **双处同步**；只改一处会假红或恒绿（M3 实证）。

## 4. 变异测试 6/6

| 组 | 变异 | 期望 | 实测 |
| --- | --- | --- | --- |
| M1 | 抽屉条件 `!isDesktopDock` → `isDesktopDock` | 行为级 ①/② RED | `3 failed \| 1 passed`，命中 `PC 不得渲染移动历史抽屉` + `移动端必须能打开对话历史抽屉` |
| M2 | 只还原 L2987 一处为直读 | ③ RED + 门禁 V3 RED | `1 failed \| 3 passed` + `Shell 读取点 13 超过上限 12` |
| M3 | 只把 `MAX_ALLOWED` 常量抬回 15 | 门禁 V3 RED，vitest 绿 | `上限常量来源丢失`，`4 passed (4)` |
| M4 | 删掉一个 `defineExpose` 项 | 行为级 ④ RED | `1 failed \| 3 passed`，`defineExpose 缺项` |
| M5 | 脚本区行注释写 `isMobileLayout` | 全绿（不误报） | `4 passed (4)` + 门禁 ALL_PASS |
| M6 | 新增一处 `isMobileLayout.value` 读取 | 门禁 V3 RED，vitest 绿 | `Shell 读取点 13 超过上限 12`，`4 passed (4)` |

`MUTATIONS 6/6`、`ALL_LOCAL_MATCH True`（三个目标文件恢复后裸 blob sha 全等）、6 组 `crashed=False`。⭐ **无伪变异**：M1 反转的是真实渲染条件而非改标识符，M4 删 expose 项保持组件可运行，脚本显式检测 `Transform failed` / `SyntaxError` / `Cannot find module` 防崩溃伪造 RED。

## 5. 全量门禁

| 门禁 | 结果 |
| --- | --- |
| `vitest run` 行为级 4 用例 + 相关回归 8 文件 | **41/41 PASS** |
| `vue-tsc -b` | **exit 0** |
| `verify-is-mobile-layout-scope.py` | `VERDICT ALL_PASS`（12 <= 12） |
| `verify-phase4-delete-scope.py` | `VERDICT ALL_PASS NO_DELETE_TARGET` |
| `verify-pc-canvas-legacy-scope.py` | `VERDICT ALL_PASS NO_MERGE_NO_DELETE_TARGET` |
| `pnpm verify-spec-figures --file <本规格>` | **0 error / 0 warning** |
| `pnpm verify-spec-figures`（全量 220 篇） | **0 error / 2 个既有历史 warning**，不归因本刀 |
| `pnpm verify-agent-rail-gates` | **11/11** |
| `pnpm verify-claims` | **7/7** |
| `python3 scripts/verify-web-upload.py` | **13/13** |

⚠️ **两项本地红，均非本刀引入，如实登记**：

1. `pnpm verify-links` 本地 **exit 1**，4 条硬断链**全部**来自 `outputs/sp-e-stage0-append-pack.md`（本地 `?? outputs/` 未提交，远端 master 该路径 404）；另有 25 条既有历史路径引用失效（按 ADR-0008 登记不改）。CI checkout 不含该未提交文件，master CI `42626712920` 的 `Verify markdown links` 步骤实测 success。
2. `apps/web` 下 `tsc --noEmit` **exit 2**，报 5 个 `@/pages/admin/*.vue` + 1 个 `NeoBaseNode.vue` 找不到模块，来自主仓长期脏工作树（本地缺文件）；本仓 CI 的实际编译路径是 `vue-tsc -b`（exit 0）与 `Build monorepo`，不把本地 `tsc` 结果当本刀判据。

## 6. 实现期修正（只追加，不改写规格 §1–§13）

1. ⭐ **`MAX_ALLOWED = 15` 在门禁脚本里出现 2 处**：常量行与 V3 正则字面量 `r'^MAX_ALLOWED = 15$'` 都含该子串，粗粒度 `str.replace` 会让 `count == 1` 断言失败（首版脚本在此中止，文件未被改动）。修法：先按带 `r'^…$'` 前缀的唯一锚点改正则，再按 `\nMAX_ALLOWED = 15\n` 独立行改常量，最后断言 `'MAX_ALLOWED = 15' not in t`。
2. **剥注释后行号 ≠ 原始文件行号**：规格/证据里的 C 类行号是门禁 `strip_comments` 输出行号（L2984/L3014/L3747），原始文件为 L2987/L3017/L3930。实现脚本改用内容锚点，避免按行号误改。
3. **M5 注释只能写脚本区**：③ 的 `templatePart(src)` 用原始文本从 `<template>` 起切，模板区注释写 `isMobileLayout` 会直接 RED；脚本区 `//` 行注释则被门禁 `strip_comments` 剥离，可作对照绿。

## 7. 诚实边界

- 本刀**不宣称** 15 点全部搬迁（剩余 12 点：A 1 + 派生 1 + D 10）、**不宣称**布局分支移出 Shell、**不宣称**新增 required check、**不宣称**像素或真机视觉复测。
- 行为级测试覆盖三处锚点对应的 PC / 移动 DOM 形态，不是像素 diff；A-6 真机复测仍是独立窗口待办。
- 本刀零改动母规格、`ci.yml` 挂载行、`package.json`、`deploy.yml`、`presentation/**`、`packages/shared/**`、`pc-visual-baseline.json`。
- `deploy.yml` 的 `push.paths` 含 `apps/web/**` ⇒ 合并会触发一次 web-only 生产发布；发布 success、bundle 五证与合并树核对结果按前例（第一批 PR #801）另开只追加回填 PR 登记，本节不预先宣告通过。
