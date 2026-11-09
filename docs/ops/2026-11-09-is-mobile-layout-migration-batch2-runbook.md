# `isMobileLayout` 逐处搬第二批 · 运行手册

> 规格：`docs/superpowers/specs/2026-11-09-is-mobile-layout-migration-batch2-design.md`
> 计划：`docs/superpowers/plans/2026-11-09-is-mobile-layout-migration-batch2.md`
> 行为级测试：`apps/web/src/components/agent/AgentSideRail.mobileDockDerived.test.ts`
> 门禁：`scripts/verify-is-mobile-layout-scope.py`（上限 15 → 12）
> 真值基线：写作时 `e743c469becb61e4186cbf9c1963a37f431a8048`（`gh api` true master）

## 1. 本刀搬什么

| 区域 | 搬迁前 | 搬迁后 |
| --- | --- | --- |
| L2987 移动历史抽屉 `v-if` | `isMobileLayout && mobileThreadHistoryOpen` | `!isDesktopDock && mobileThreadHistoryOpen` |
| L3017 面板 `:class` 三元 | `isMobileLayout` | `!isDesktopDock` |
| L3930 composer prop | `:mobile-enter-newline="isMobileLayout"` | `:mobile-enter-newline="!isDesktopDock"` |
| Shell 有效读取点 | 15 | **12** |
| 门禁上限 | `MAX_ALLOWED = 15` | `MAX_ALLOWED = 12`（V3 方向判据同步） |

⭐ **为什么是 12 而不是第一批规格 §12 预告的 13**：第一批已建立 `isDesktopDock = computed(() => !isMobileLayout.value)`，故 `!isDesktopDock === isMobileLayout.value`（模板 ref 自动解包）严格等价。复用既有派生**不新增 computed、不新增读取点**，比新增 `isMobileDock` 派生（会 +1 读取、净降 2）更优。第一批规格 §1–§13 是历史时点结论，按纪律不追溯改写，本刀规格 §3 显式登记该方案差异。

**15 点分类**（逐处搬准入 1，`gh api` true master 剥离注释后实测，行号为剥注释后行号）：

| 类 | 点数 | 行号 | 本批处理 |
| --- | --- | --- | --- |
| A 唯一来源 | 1 | L234 `const { isMobileLayout } = useAgentMobileLayout()` | 不动（门禁 V4 要求） |
| 派生定义 | 1 | L236 `const isDesktopDock = …` | 不动 |
| C 模板肯定 | 3 | L2984 / L3014 / L3747 | ✅ 全部搬 |
| D 脚本逻辑 | 10 | L469 / L737 / L839 / L859 / L1005 / L1013 / L1217 / L1228 / L1236 / L1259 | 后续批 |

⚠️ 上表 C 类行号是**剥注释后**行号；在原始文件里对应 **L2987 / L3017 / L3930**。实现脚本按内容锚点定位，不用行号。搬完后剩余 12 点 = A 1 + 派生 1 + D 10。**不宣称 15 点全部搬迁**，也不宣称布局分支移出 Shell；本批是 Shell 内的 DRY 与语义化。

## 2. 判据

| 组 | 判据 | 失败含义 |
| --- | --- | --- |
| ① 行为级 PC | `matchMedia.matches=false` 时三个桌面锚点各 1、`.agent-panel-mobile-dock` 0、打开历史后 `.thread-history-layer` 0 | 空集假绿 / 桌面形态丢失 |
| ② 行为级移动 | `matches=true` 时三个桌面锚点各 0、`.agent-panel-mobile-dock` 1、打开历史后 `.thread-history-layer` 1 | 派生取反写错 / 移动端混入桌面形态 |
| ③ 源码契约 | 模板区 `isMobileLayout` 零出现、`!isDesktopDock` 恰 3、派生定义仍是纯否定 | 少替换一处 / 漏了取反 |
| ④ 冻结边界 | `defineExpose` 11 项 + `getIsMobileLayout` + 三个冻结命令零改写 | 触碰冻结边界 |
| 门禁 V3 | Shell 计数 12 <= 12 且 `^MAX_ALLOWED = 12$` 在位 | 上限被抬高 / 方向判据失同步 |
| 门禁 V2 / V4 | Content 与 shared 零读取；`useAgentMobileLayout()` 定义点唯一 | 布局断点下沉 / 来源分裂 |

⭐ **行为级测试的四个环境前提**：面板用 `v-show`（不是 `v-if`）且 `open = ref(false)` ⇒ 子元素仍在 DOM 中；面板与抽屉 Teleport 到 `body` ⇒ 查询必须覆盖 `document.body`；移动端分支 `useAgentDock` 会 `new ResizeObserver(...)` ⇒ jsdom 无此全局，必须 stub；`openThreadHistory()` 内部 `await fetchThreads()` 的网络结果不影响「抽屉是否渲染」这一形态判据，故 `.catch(() => {})` 只吞网络噪声，不吞 DOM 断言。四者都是测试环境补齐，不改变产品语义。

## 3. 运行

```bash
# 行为级契约（本机 node v22 通过，nvm node24 亦可）
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run \
  src/components/agent/AgentSideRail.mobileDockDerived.test.ts \
  --config vitest.config.ts --maxWorkers=1 --no-file-parallelism

# 门禁（三条棘轮）
python3 scripts/verify-is-mobile-layout-scope.py
python3 scripts/verify-is-mobile-layout-scope.py --json
python3 scripts/verify-phase4-delete-scope.py
python3 scripts/verify-pc-canvas-legacy-scope.py

# 编译与全量门禁
cd apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vue-tsc -b
cd /Users/4seven/workspace/pi-lnk && env -u NODE_OPTIONS pnpm verify-agent-rail-gates
env -u NODE_OPTIONS pnpm verify-spec-figures --file docs/superpowers/specs/2026-11-09-is-mobile-layout-migration-batch2-design.md
env -u NODE_OPTIONS pnpm verify-spec-figures
env -u NODE_OPTIONS pnpm verify-claims
python3 scripts/verify-web-upload.py
```

- 行为级 4/4 PASS；相关回归 8 文件 41/41 PASS；门禁 `VERDICT ALL_PASS`，V3 详情 `Shell 读取点 12 <= 12，方向判据在位`。
- 门禁准入三问不变：零外部依赖 / 确定性 / 可失败。既有 `spec-figures` job 挂载行**不改**。

## 4. 四条坑

1. **`MAX_ALLOWED` 出现 2 处**：常量行 `MAX_ALLOWED = 15` 与 V3 正则字面量 `r'^MAX_ALLOWED = 15$'` 都含 `MAX_ALLOWED = 15` 子串。粗粒度 `str.replace('MAX_ALLOWED = 15', 'MAX_ALLOWED = 12')` 会同时改掉两处，或让 `count == 1` 断言失败。修法：先按带 `r'^…$'` 前缀的唯一锚点改正则，再按 `\nMAX_ALLOWED = 15\n` 独立行改常量。M3 变异（只抬回常量）精确 `V3` RED。
2. **注释计数与模板区划线**：`strip_comments` 剥离 `//` / `/* */` / `<!-- -->`，但 ③ 的 `templatePart(src)` 是**原始文本**从 `<template>` 起切 ⇒ 新 Vue 注释绝不能写 `isMobileLayout` 字面量，且只能写在脚本区（写模板区会直接让 ③ RED）。M5 在脚本区写行注释做对照绿，验证 `strip_comments` 生效。
3. **漏取反比漏替换更危险**：`!isDesktopDock` 写成 `isDesktopDock` 会让 PC/移动形态整体反转，且仍可能通过门禁。M1 用真实 mount 的两端抽屉/dock 断言钉住，不以门禁绿灯代替行为级。
4. **改名致崩溃不算判据转红**：M4 用「删一个 expose 项」保持组件可运行，不用未定义标识符让编译崩溃伪造 RED；脚本同时检测 `Transform failed` / `SyntaxError` / `Cannot find module` 判定 `crashed`。

## 5. 变异测试

临时改后恢复，恢复后核 3 个目标文件裸 blob sha 全等。6 组：

| 组 | 变异 | 期望 | 实测 |
| --- | --- | --- | --- |
| M1 | 抽屉条件 `!isDesktopDock` → `isDesktopDock` | 行为级 ①/② RED | `3 failed \| 1 passed`，命中两个抽屉断言 |
| M2 | 只还原 L2987 一处为直读 | ③ RED + 门禁 V3 RED | `1 failed \| 3 passed`，`Shell 读取点 13 超过上限 12` |
| M3 | 只把 `MAX_ALLOWED` 常量抬回 15 | 门禁 V3 RED，vitest 绿 | `上限常量来源丢失`，`4 passed (4)` |
| M4 | 删掉一个 `defineExpose` 项 | 行为级 ④ RED | `1 failed \| 3 passed`，`defineExpose 缺项` |
| M5 | 脚本区行注释写 `isMobileLayout` | 全绿（不误报） | `4 passed (4)` + 门禁 ALL_PASS |
| M6 | 新增一处 `isMobileLayout.value` 读取 | 门禁 V3 RED，vitest 绿 | `Shell 读取点 13 超过上限 12`，`4 passed (4)` |

`MUTATIONS 6/6`、`ALL_LOCAL_MATCH True`、全部 `crashed=False`。

## 6. 生产复测（本刀会触发发布）

`deploy.yml` 的 `push.paths` 含 `apps/web/**` ⇒ squash 合并必然触发一次 web-only 生产发布（`Deploy web to CVM` success、API 构建 skipped）。合入后按序执行：

1. `gh api repos/sev7n4/pi-lnk/actions/workflows/deploy.yml/runs?per_page=3` 确认本次 merge sha 的部署 success。
2. 直连生产，递归下钻懒加载 chunk，确认三处替换后的渲染条件已 live；`/api/health` 返回 `{"ok":true}`。
3. ⭐ **`isDesktopDock` 是 setup 局部 const，被 esbuild 压缩成短名** ⇒ 生产 chunk 里字面量为 0 **不代表未部署**。五证 = chunk hash 变化 + setup 派生结构 `u=R(()=>!l.value)` + 渲染条件 + DOM 锚点（三个桌面锚点各 1）+ health。
4. 核对合并树 `ALL_PARALLEL_KEPT True`，零回退并行改动；SSH 被沙箱拦时用 `curl --noproxy '*'` 直连。

## 7. 诚实边界

- 本刀**不宣称** 15 点全部搬迁、**不宣称**布局分支移出 Shell、**不宣称**新增 required check、**不宣称**像素或真机视觉复测。
- 生产复测是「部署成功 + 接口健康 + bundle 结构级」取证，不是 CDP 五层冒烟，也不是 A-6 真机复测。
- 门禁以 CI checkout 的远端源码为准；本地工作树脏状态不参与判据。本地 `pnpm verify-links` 的 4 条硬断链全部来自未提交的 `outputs/sp-e-stage0-append-pack.md`（远端 404），`apps/web` 下 `tsc --noEmit` 的缺文件报错来自主仓脏工作树，二者均非本刀引入，CI 实际编译路径 `vue-tsc -b` exit 0。
- 后续批次：D 类脚本逻辑 10 处逐处降上限（涉及 watch / composer / floating，风险高于模板层），每点独立行为级契约。
