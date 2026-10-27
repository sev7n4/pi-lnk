# 门面收敛 hotfix（v2.2 修订落地）实施计划

> 配套规格：`docs/superpowers/specs/2026-10-26-project-gallery-consolidation-design.md`（**v2.2**）
> 上游已完成：v2.1 架构（PR #614 `3364a1a6`，已合 master + 生产部署 + prod 取证四层通过）。
> 本计划只落地 v2.2 判定的四件事：**D9 修订 / D6 幽灵链接恢复 / D11 按钮落点 / D12 空态三态**，并修复真机实测的四类 bug。
> ⚠️ **分支前提**：当前工作分支 `feat/multi-device-unified-thread` 早于 #614（其工作树仍见 `useMySessions`），不可用。本计划必须从 `origin/master`（`3364a1a6`）起新分支，例如 `fix/gallery-v22-hotfix`。

## 0. 真机问题 → 根因 → 本计划任务 映射

| 真机现象（bug） | 根因（代码级） | 对应规格 | 本计划任务 |
|---|---|---|---|
| ① 品牌页点锚进不了创作首页（直接进项目） | `useEnterCreation` 有项目时直跳 `/workflow/:id`，创作首页无正向入口；原 D9「零项目直建进对话」也与用户拍板不符 | D9 修订（§6.3 图4） | **T1** |
| ② 返回按钮位置未清晰定义（创作首页↔品牌页冲突） | 设计层缺按钮落点判据 | D11（§6.5 图5） | **T4** |
| ③ 画布点返回闪列表后空白 + 12 控制台错误 | 返回 `/canvases` 时 `list()` 在连接饥饿下失败/竞态，空态未兜底；失败后续渲染报错 | D12（§6.6）+ bug③ 加固 | **T2 / T5** |
| ④ 刷新后误报「还没有项目」+ 多个「新建项目」按钮 | `CanvasesPage` 空态只判 `mgr.filtered.length`，不区分 list 失败与真无项目；「新建项目」顶栏 + 空态内各一处 | D12（§6.6） | **T2** |

## 1. 任务清单

### T1 · D9 点锚落点修订（`useEnterCreation.ts`）
- **文件**：`apps/web/src/composables/useEnterCreation.ts`
- **改动**：`enterCreation` 的「有项目 / 零项目」分支**按 `allowImplicitCreate` 旗帜分流**——本次只改「手势侧」，「自动分发侧」保持。两条路径共源（INV-5 唯一进入逻辑），**不是并列的两处改动，而是同一分支的两个互斥落点**：
  - **手势侧**（`allowImplicitCreate: true` = 点锚 / `SignatureHero @create`）：无论有无项目统一 `navigate('/canvases')`：
    - 有项目 → 创作首页列表（修复 bug① 创作首页无正向入口）。
    - 零项目 → 创作首页空态，由空态内「新建项目」走 `ws.create()`（首建零摩擦改在列表空态触发，取消原「直建进对话」）。
  - **自动分发侧**（`allowImplicitCreate: false` = `WorkflowPage.vue` 一次性 `watch`）：**保持**原落点——有项目进最近项目（穿透、不创建）、零项目留品牌页。
  - list 失败兜底（记忆项目兜底仅手势路径生效）保留不动。
- **验收**：`enterCreation` 单测——手势路径（有/无项目）均落 `/canvases`；自动分发仍进最近项目；list 失败兜底仅手势路径生效。
- **依赖**：无。

### T2 · 创作首页空态三态（bug④，D12 §6.6）
- **文件**：`apps/web/src/pages/CanvasesPage.vue`
- **改动**：
  - 接入 `const { error: wsError, list: listProjects } = useProjectWorkspace()`（与 `mgr` 同源模块级 ref；`useProjectManager` 未 re-expose `error`）。
  - `v-else` 拆为两态：
    - **B 加载失败**：`wsError.value && mgr.projects.value.length === 0` → 显示「项目加载失败 · 重试」+ 重试按钮调 `listProjects()`；**不**显示「还没有项目」、**不**触发创建。
    - **C 真无项目**：`!wsError.value && mgr.projects.value.length === 0` → 「还没有项目」+ 新建引导。
  - 保留 `mgr.loading` 骨架态（态 A）。
  - **去重**：移除空态 `AppEmptyState` 内的「新建项目」`action` 按钮（顶栏已有一处，`data-testid="canvases-create"` 全局唯一）。
- **验收**：刷新有项目但因连接饥饿 list 失败时 → 显示失败-重试而非「还没有项目」；零项目 → 仅顶栏一处「新建项目」；`error && 非空清单` 时仍展示旧清单（不清空语义）。
- **依赖**：无（可与 T1 并行）。

### T3 · 品牌页回访幽灵链接（D6 恢复）
- **文件**：`apps/web/src/pages/WorkflowPage.vue`（渲染）、`apps/web/src/components/workflow/SignatureHero.vue`（保持纯品牌，不改 emit）
- **改动**：
  - `WorkflowPage` 已登录且 `useProjectWorkspace().resolveLastProjectId()` 存在时，于 `SignatureHero` 之下渲染一行幽灵链接「继续：<上次项目名>」。
  - 标题解析：mount 时按需 `list()`/`loadIfStale()` 取 projects 找 `lastProjectId` 对应项；标题未知时兜底文案「继续创作」。
  - 点击 `navigate('/workflow/:id')`（进项目·对话视图）。
  - 未登录 / 无记忆项目 → 不渲染（锚 CTA 仍是主仪式，不喧宾夺主）。
- **验收**：已登录有记忆项目 → 品牌页见幽灵链接且跳转正确；未登录 → 不渲染。
- **依赖**：无。

### T4 · 按钮落点复核与守卫（D11 §6.5 图5）
- **文件**：`apps/web/src/components/mobile/MobileTopBar.vue`、`apps/web/src/components/canvas/CanvasFloatingChrome.vue`、`apps/web/src/pages/CanvasPage.vue`（`backToCreationHome`/`goHome` 已正确，仅补测试）
- **改动（以复核+测试为主，代码若已符合则不改）**：
  - 移动 `MobileTopBar`：`tab==='chat'` 的 `≡` → `/canvases`；`tab==='canvas'` 仅 `⋯` 无返回（守卫测试确保不出现返回按钮）。
  - PC `CanvasFloatingChrome`：`@back` → `/canvases`（已符合，补测试）。
  - 字标/Logo → `/workflow`（返回品牌页，与「‹ 返回创作首页」区分）。
  - 移动 tabbar：画布视图下始终可见，`对话/画布` 仅切换项目页内两视图（不跳 `/canvases`/`/workflow`）。
- **验收**：D11 守卫测试覆盖上述落点；无「返回键位置不清」回归。
- **依赖**：无（可与 T1–T3 并行，属加固）。

### T5 · 返回创作首页加固 + 控制台错误排查（bug③）
- **文件**：`apps/web/src/pages/CanvasPage.vue`、`apps/web/src/composables/useProjectWorkspace.ts`
- **改动**：
  - 从项目页返回 `/canvases` 时，优先 `loadIfStale()`（复用已拉数据，不在连接饥饿的画布页重复排队），失败再落 §6.6 三态。
  - 排查返回后 12 条控制台错误来源（疑似 list 失败后的级联空渲染 / 空指针），加行为级守卫避免空白态报错（不靠 try-catch 吞错，定位真实根因后消除）。
- **验收**：画布点返回稳定进入创作首页列表（非空、无控制台报错）；连接饥饿下返回不闪空白。
- **依赖**：T2（共用 §6.6 三态与 `wsError`）。

### T6 · 测试与守卫总装
- **单测**：T1 `useEnterCreation` D9、T2 `CanvasesPage` 三态 + 按钮唯一、T3 幽灵链接渲染/跳转、T4 按钮落点。
- **grep 守卫**：`data-testid="canvases-create"` 全仓唯一；`useMySessions`/`sessionsApi.list`/`RecentProjectsStrip` 零引用（继承 v2.1）。
- **类型/构建**：`vue-tsc -b` 通过（noUnusedLocals 卡构建）。
- **依赖**：T1–T5。

### T7 · 合并 / 部署 / 生产复测
- 分支 `fix/gallery-v22-hotfix` → PR（squash）→ 合 master。
- 部署 Tencent Cloud；prod 取证四层（入口 chunk / 字面量 / CSS / 无头注入）。
- 真机复测四项：① 点锚进创作首页列表；② 返回键位置清晰（对话视图收口、画布不返回）；③ 画布返回不闪空白、无控制台错误；④ 刷新有项目不再误报、仅一处「新建项目」。
- **依赖**：T6。

## 2. 实施顺序（建议）

```
T1 (D9) ─┐
T2 (空态) ─┤
T3 (幽灵) ─┼─→ T6 (测试/守卫) ─→ T7 (PR/部署/复测)
T4 (按钮) ─┤
T5 (返回) ─┘   （T5 依赖 T2）
```

T1–T4 互不依赖可并行；T5 依赖 T2；T6 收口；T7 末置。

## 3. 不回退项（v2.1 已落地，禁止因本次 hotfix 改动）

- 单一数据源 `useProjectWorkspace`（INV-10）。
- 两门面：创作首页（列表=续作面）+ 对话页（纯净）；`ProjectPanel`/`RecentProjectsStrip` 已删。
- 微信式返回：对话页 → 创作首页；`sessionsApi.list` 已删。
- 主页纯品牌 + 锚（ADR-0012）。
