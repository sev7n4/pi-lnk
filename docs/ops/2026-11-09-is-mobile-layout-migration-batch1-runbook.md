# `isMobileLayout` 逐处搬第一批 · 运行手册

> 规格：`docs/superpowers/specs/2026-11-09-is-mobile-layout-migration-batch1-design.md`
> 计划：`docs/superpowers/plans/2026-11-09-is-mobile-layout-migration-batch1.md`
> 行为级测试：`apps/web/src/components/agent/AgentSideRail.desktopDockDerived.test.ts`
> 门禁：`scripts/verify-is-mobile-layout-scope.py`（上限 21 → 15）
> 真值基线：写作时 `2b6693c579ffb2931a84d1954e93fecf5617db91`（`gh api` true master）

## 1. 本刀搬什么

| 区域 | 搬迁前 | 搬迁后 |
| --- | --- | --- |
| 模板 7 处否定读取 | `!isMobileLayout` × 7 | `isDesktopDock` × 7 |
| 派生定义 | 无 | `const isDesktopDock = computed(() => !isMobileLayout.value)`（1 处读取） |
| Shell 有效读取点 | 21 | **15** |
| 门禁上限 | `MAX_ALLOWED = 21` | `MAX_ALLOWED = 15`（V3 方向判据同步） |

**21 点分类**（逐处搬准入 1，剥离注释后实测，行号为 true master 剥注释后行号）：

| 类 | 点数 | 行号 | 本批处理 |
| --- | --- | --- | --- |
| A 唯一来源 | 1 | L208 `const { isMobileLayout } = useAgentMobileLayout()` | 不动（门禁 V4 要求） |
| B 模板否定 | 7 | L2265 / L2333 / L2341 / L2351 / L2358 / L2365 / L2387 | ✅ 全部搬 |
| C 模板肯定 | 3 | L2288 / L2318 / L3050 | 后续批 |
| D 脚本逻辑 | 10 | L390 / L585 / L643 / L662 / L795 / L802 / L963 / L968 / L975 / L993 | 后续批 |

搬完后剩余 15 点 = A 1 + 新派生定义 1 + C 3 + D 10。**不宣称 21 点已全部搬迁**，也不宣称布局分支移出 Shell；本批是 Shell 内的 DRY 与语义化。

## 2. 判据

| 组 | 判据 | 失败含义 |
| --- | --- | --- |
| ① 行为级 PC | `matchMedia.matches=false` 时 `.agent-resize-handle` / `.agent-subtitle` / `[title="收起助手"]` 各恰 1 个 | 空集假绿 / 桌面形态丢失 |
| ② 行为级移动 | `matches=true` 时三者各 0 个 | 派生定义错误 / 移动端混入桌面 UI |
| ③ 源码契约 | 派生定义是纯否定；模板区零 `!isMobileLayout`；`isDesktopDock` ≥ 7 次 | 少替换一处 / 定义夹带第二条件 |
| ④ 冻结边界 | `defineExpose` 11 项 + `getIsMobileLayout` + 三个冻结命令零改写 | 触碰冻结边界 |
| 门禁 V3 | Shell 计数 15 <= 15 且 `^MAX_ALLOWED = 15$` 在位 | 上限被抬高 / 方向判据失同步 |
| 门禁 V2 / V4 | Content 与 shared 零读取；`useAgentMobileLayout()` 定义点唯一 | 布局断点下沉 / 来源分裂 |

⭐ **行为级测试的三个环境前提**：面板用 `v-show`（不是 `v-if`）且 `open = ref(false)` ⇒ 子元素仍在 DOM 中；面板 Teleport 到 `body` ⇒ 查询必须覆盖 `document.body`（`wrapper.find()` 会漏）；移动端分支的 `useAgentDock` 会 `new ResizeObserver(...)` ⇒ jsdom 无此全局，必须 stub。三者都是测试环境补齐，不改变产品语义。

## 3. 运行

```bash
# 行为级契约（nvm node24 亦可，本机 node v22 通过）
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run \
  src/components/agent/AgentSideRail.desktopDockDerived.test.ts \
  --config vitest.config.ts --maxWorkers=1 --no-file-parallelism

# 门禁
python3 scripts/verify-is-mobile-layout-scope.py
python3 scripts/verify-is-mobile-layout-scope.py --json

# 编译与全量门禁
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vue-tsc -b
env -u NODE_OPTIONS pnpm verify-agent-rail-gates
env -u NODE_OPTIONS pnpm verify-spec-figures --file docs/superpowers/specs/2026-11-09-is-mobile-layout-migration-batch1-design.md
python3 scripts/verify-pc-canvas-legacy-scope.py
python3 scripts/verify-phase4-delete-scope.py
```

- 行为级 4/4 PASS；门禁 `VERDICT ALL_PASS`，V3 详情 `Shell 读取点 15 <= 15`。
- 门禁准入三问不变：零外部依赖 / 确定性 / 可失败。既有 `spec-figures` job 挂载行**不改**。

## 4. 四条坑

1. **`MAX_ALLOWED` 双处同步**：V3 里还有 `re.search(r'^MAX_ALLOWED = 15$', impl, re.M)` 方向判据。只改常量不改正则会假红；只改正则不改常量会恒绿。M3 变异（只把常量抬回 21）精确 `V3` RED。
2. **模板区 vs 脚本区**：脚本区 `!isMobileLayout.value`（composer / watch）属后续批次；若被误替换会改变行为。本批只在 `<template>` 之后做字符串替换，替换前断言模板区恰 7 处。
3. **注释计数漂移**：新注释不得写 `!isMobileLayout` 字面量；M5 在脚本区写注释做对照绿，验证 `strip_comments` 生效且不影响门禁。
4. **改名致崩溃不算判据转红**：变异要删/改能保持组件可运行的内容（如删一个 expose 项），不能用未定义标识符让编译崩溃来伪造 RED。

## 5. 变异测试

临时改后恢复，恢复后核 3 个目标文件裸 blob sha 全等。6 组：

| 组 | 变异 | 期望 |
| --- | --- | --- |
| M1 | `isDesktopDock` 定义改成 `computed(() => true)` | 行为级 ②③ RED |
| M2 | 少替换一处模板（还原 `!isMobileLayout`） | 行为级 ③ RED + 门禁 V3 RED |
| M3 | 只把 `MAX_ALLOWED` 常量抬回 21 | 门禁 V3 RED |
| M4 | 删掉一个 `defineExpose` 项 | 行为级 ④ RED |
| M5 | 脚本区注释写 `!isMobileLayout` | 全绿（不误报） |
| M6 | 新增一处 `isMobileLayout.value` 读取 | 门禁 V3 RED |

## 6. 生产复测（本刀会触发发布）

`deploy.yml` 的 `push.paths` 含 `apps/web/**` ⇒ squash 合并必然触发一次 web-only 生产发布（`Deploy web to CVM` success、API 构建 skipped）。合入后按序执行：

1. `gh api repos/sev7n4/pi-lnk/actions/workflows/deploy.yml/runs?per_page=3` 确认本次 merge sha 的部署 success。
2. 直连生产，递归下钻懒加载 chunk，确认 `isDesktopDock` 与 7 处替换后的模板表达式已 live（bundle 级取证）；`/api/health` 返回 `{"ok":true}`。
3. 核对合并树 `ALL_PARALLEL_KEPT True`，零回退并行改动。
4. SSH 被沙箱拦时用 `curl --noproxy '*'` 直连；本机 HTTP 代理会拦 `127.0.0.1`。

## 7. 诚实边界

- 本刀**不宣称** 21 点全部搬迁、**不宣称**布局分支移出 Shell、**不宣称**新增 required check、**不宣称**像素或真机视觉复测。
- 行为级测试覆盖的是 7 处锚点对应的 DOM 存在性（PC / 移动两端），不是像素 diff；A-6 真机复测仍是独立窗口待办。
- 门禁以 CI checkout 的源码为准，本地工作树脏状态不参与判据。
- 后续批次：C 类 3 处（上限 15 → 13）、D 类 10 处（逐处降上限），每批独立 PR + 行为级测试 + 变异 + 生产复测。
