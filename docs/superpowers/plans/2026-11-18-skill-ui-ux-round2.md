# 技能 UI/UX 二轮优化 · 实施计划

> 规格：`docs/superpowers/specs/2026-11-18-skill-ui-ux-round2-design.md`（**已上线**，2026-11-18）。
> 范围：全部 ∈ apps/web（零生产代码、零新组件、零新依赖）⇒ web-only 部署。
> 分支：从最新 master 另开 `fix/skill-ux-round2`（worktree）。
> 复用资产：MobileSheet 基座 / displayNameFromDesc / 既有三组件本体——第一原则禁新建。

## 0. 复用资产清单

| 任务 | 复用资产 | Self-built 仅限 |
|---|---|---|
| R1 | 既有 nowrap+ellipsis 样式（只补约束链） | CSS 若干行 + 守卫断言 |
| R2 | MobileSheet 单滚动容器（m-sheet-body 现成） | `.skill-pick-sheet` 变体类 1 个 + CSS 覆盖 |
| R3 | MobileSheet 基座 + isDesktopDock 判定（与 + sheet 同模式） | Teleport 分支包装 |
| R4 | AgentSideRail 同源 dockSkills 数据面 | 1 个 prop 接线 + 空态文案 |
| R5 | displayNameFromDesc（constants/agentSkillMap.ts） | 2 个消费点接线 |
| R6 | 既有 Modal 弹层家族样式 | PC 分支容器 |

## 1. 任务拆解

### T1 · R1 卡宽爆破（P0）
- T1.1 `SkillPickSheet.vue`：`.pick-item/.pick-text/.pick-name/.pick-desc` 补 `min-width: 0`；`.skill-sheet-card`（AgentSideRail PC 分支）加 `max-width: min(92vw, 560px)`。
- T1.2 `SkillDiscoverPanel.vue`：`@media (max-width: 639px)` 网格改 `minmax(0, 1fr)`；`.manage-summary` 所在 flex 链补 `min-width: 0`。
- T1.3 守卫测试：fs-scan 锁 `minmax(0, 1fr)` 与 `min-width: 0` 存在、锁 `max-width: min(92vw, 560px)`；禁回退裸 `1fr`。
- 判据：fs-scan 绿 + CDP 双端卡宽断言（PC ≤560 / 移动 ≤366）。

### T2 · R2 滚动死区（P0）
- T2.1 `SkillPickSheet.vue` 加 `embedded` 变体（MobileSheet 场景由 AgentSideRail 移动分支传入）：`.embedded .sheet-body { overflow-y: visible; overscroll-behavior: auto; }`（滚动权移交 m-sheet-body）；PC 分支不变。
- T2.2 守卫测试：fs-scan 锁变体规则存在；`AgentSideRail.skillSheetMobile.test.ts` 补断言（移动分支传 embedded、PC 分支不传）。
- 判据：CDP 触摸滑动 dy=−320 → `.m-sheet-body.scrollTop > 0`（修复前恒 0 的死区消除）。

### T3 · R3 管理技能弹层移动端化（P1）
- T3.1 `AgentSideRail.vue` 管理弹层 Teleport 内容加双分支：移动端包 `MobileSheet`（title=管理技能，max-height 82vh），PC 保留现居中 Modal。
- T3.2 守卫测试：双分支断言 + `!isDesktopDock` 消费点计数更新（防回归）。
- 判据：移动端弹层贴底+把手；PC 几何不变（CDP 断言 720×606 基线）。

### T4 · R4 技能中心接内置区（P1）
- T4.1 `MobileCanvasShell.vue` 技能中心 `SkillDiscoverPanel` 补 `:builtin-skills`（与 AgentSideRail dockSkills 同源；数据获取方式对齐 PC 侧，禁造数）。
- T4.2 市场空态文案补引导（「内置技能已列于下方」）。
- 判据：CDP 发现页链路可见「内置技能（11）」分区且卡可点开详情。

### T5 · R5 显示名统一（P2）
- T5.1 `SkillDiscoverPanel.vue` 内置卡 label + `SkillDetailSheet` 标题消费 `displayNameFromDesc`。
- 判据：CDP 抽样 3 卡中文短名；无裸 slug。

### T6 · R6 PC 详情弹层形态（P2，默认按推荐）
- T6.1 `SkillDetailSheet.vue` PC（`isDesktopDock`）走居中窄卡（max-w 480px），移动端保持 MobileSheet。
- 判据：PC 详情非全宽底条（宽度 ≤480）；移动端不变。

### T7 · R7 移动端卡片信息密度与触控整备（P1）
- T7.1 `SkillDiscoverPanel.vue` 内置卡「内置」badge 从 head 行移至 summary 行尾（移动端 head 只留 avatar+name+ⓘ，name 宽度恢复 ≥200px）。
- T7.2 我的卡 summary 移动端改两行结构：状态行 + 元数据行（slug · 版本 · 来源），`@media (max-width: 639px)` 分支覆盖；PC 保持单行。
- T7.3 `.act`（回滚/卸载）与 `.tab` 移动端 min-height 44px（触控目标 HIG 达标）。
- T7.4 守卫测试：fs-scan 锁 44px 规则 + badge 位置断言；CDP 断言 `.act` 高 ≥44、内置卡 name ≥200px、summary 两行无省略吞元数据。

### T8 · R8 分组导航裁决落地：不嵌套 Tab + sticky 分组头（P2）
- T8.1 `SkillDiscoverPanel.vue` 分组头 `.group-title` 加 sticky（移动分支生效或双端无副作用）：`position: sticky; top: 0; background: var(--lnk-surface-canvas); z-index 弹层内安全值`。
- T8.2 守卫测试：fs-scan 锁 sticky 规则存在；CDP 断言滚动时分组头吸顶可见。
- 裁决记录：**不引入二级 Tab/分段控件**（HIG 反嵌套导航；内容量级 11+ 少量，R2 修好滚动后长度非痛点；>30 技能时未来升级 filter chips，非本轮）。

### T9 · R9 触碰组件冗余代码清理（P2，最后执行）
- 范围红线：仅本轮触碰 5 文件（SkillPickSheet / SkillDiscoverPanel / SkillDetailSheet / AgentSideRail 技能段 / MobileCanvasShell 技能中心段），**不做全仓清扫**。
- T9.1 死样式盘点：对 5 文件 `<style>` 逐 class grep 模板与守卫测试引用，产出「候选删除清单」（class + 引用计数 + 判定），零引用且无守卫引用才可删。
- T9.2 死状态/方法盘点：vue-tsc noUnusedLocals + 模板引用核对（script 中未被模板使用的 ref/function）。
- T9.3 一轮美化遗留排查：#949–#951 改造后被替代路径的残留样式/旧分支。
- T9.4 逐条删除 + 删除证据留痕（计划 §执行记录），每条删除后跑定向测试；全部完成后跑门禁矩阵全量。
- 红线：测试守卫引用的类名/选择器/testid 一律保留；语义不变才删，禁顺手重构。
- 判据：门禁全绿零回退 + CDP 双端回归不回退 + 删除清单在案。

## 2. 门禁矩阵

| 门 | 命令/方式 | 通过条件 |
|---|---|---|
| 单测 | `pnpm test:web`（nvm node24 + `env -u NODE_OPTIONS`） | 全绿 |
| 类型 | `vue-tsc -b` | 干净 |
| fs-scan 守卫 | 新增 T1/T2/T3/T7/T8 锁 | 全绿 |
| 变异自检 | M-R1（删 minmax(0,1fr) 回 1fr）/ M-R2（去 embedded 变体）/ M-R7（删 44px min-height）逐条 RED + sha256 还原 | 全 RED |
| CDP 真机回归 | `ux-r2-probe.mjs` mobile+pc 两轮 | §1 三问题判据全部翻绿 + PC 基线不回退 |

## 3. 提交与部署边界（分阶段授权）

1. 本阶段（审 PASS 后）：落地 T1–T9（T9 清理最后执行，避免清到半途又要改的代码）+ 门禁全绿。
2. 合并阶段（单独确认）：REST 推 PR（触碰面只含 apps/web + docs）→ CI → squash 合并。
3. 部署阶段：push 触发 deploy.yml 自动 web-only；判据=产物 chunk 新标记 + 生产 CDP 复测两轮走查全绿。
4. 收尾：规格/计划状态回填；生产取证记录。

## 4. 诚实边界

- R2 的 iOS Safari 真机惯性/橡皮筋细节以根因消除 + 仿真验收为准，上线后建议真机复核一次。
- 市场目录为空是运营数据面，不在本轮；R4 只保证「有内置技能可看可点」。
- 不写 ALL_PASS；每项验收以 CDP 几何断言为准，禁目测自报。

## 5. 执行记录（2026-11-18 实施）

### T9 删除清单（grep 取证后删除，模板/测试双零引用）
| 文件 | 删除项 | 证据 |
|---|---|---|
| SkillDiscoverPanel.vue | `.rows`（`.cards, .rows` 并集声明拆分） | 模板 0 处 class="rows"；测试 0 引用 |
| SkillDiscoverPanel.vue | `.row`（同上拆分保留 `.card`） | 模板 0 处；M1-3 重构后遗留 |
| SkillDiscoverPanel.vue | `.row-head` | 模板 0 处 |
| SkillDiscoverPanel.vue | `.badge-on` / `.badge-off` | P3 重构（开关替代启用 badge）后遗留；模板/测试双 0 引用 |
- 其余 4 文件（SkillPickSheet/SkillDetailSheet/AgentSideRail 技能段/MobileCanvasShell 技能中心段）逐 class 核对：零死样式；AgentSideRail 旧内联 loadDockSkills 随 R4 重构删除（并入 useDockSkills）。

### 变异自检（完整 stdout 存 /tmp/m-{r1,r2,r7}.out，sha256 还原一致）
- M-R1 `minmax(0,1fr)`→裸 `1fr`：RED（2 failed / 25）。
- M-R2 删 `.skill-pick-sheet.embedded .sheet-body` 规则：首轮**假绿**（判据未锁该规则）→ 补 SkillPickSheet.test R2 判据（锁 CSS 规则 + prop 契约）后复验 RED（1 failed / 13）。
- M-R7 删 `.act,.install,.tab` 44px 规则：RED（1 failed / 25）。

### 新增判据资产
- 新文件：`composables/useDockSkills.ts` + `.test.ts`（3 判据）；`AgentSideRail.manageSheetMobile.test.ts`（4 判据）；`SkillDetailSheet.desktop.test.ts`（2 判据）。
- 扩展：`SkillPickSheet.test.ts`（R1/R2）、`AgentSideRail.skillSheetMobile.test.ts`（R1/R2）、`AgentSideRail.mobileDockDerived.test.ts`（C 类消费点计数 4→5）、`SkillDiscoverPanel.test.ts`（U3 同步 + 二轮 6 判据；钉住移动分支 mock 防 R6 分支失配）。

## 6. 部署终态与生产取证（2026-11-18）

- PR #953：触碰面恰 17 路径（5 组件 + 8 测试 + 1 组合式 + 2 docs + 1 useDockSkills），CI 4/4 绿；squash 合并 `8a23882e`，**合并树==CI 验证树 `a610a04c`**，17 路径 KEPT。
- deploy.yml push 自动触发：**Deploy web SUCCESS / Build API skipped**（web-only 分流正确）；产物核验 `skill-detail-sheet-desktop` / `sum-status` / `embedded` / `92vw,560px` 全中（CanvasPage-BAQSu4i7.js），`minmax(0,1fr)` 在 CSS。
- 生产 CDP 复测（119.29.173.89:8888，合并后产物）：
  - 移动端 390×844 触摸：+ 技能 sheet **触摸滑动 0→197 满程**（死区根除实锤）、pickW 360≤366、管理弹层 MobileSheet（desktop modal absent）卡 328px、卡名 210px、badge 在 summary 行、嵌套详情 MobileSheet 390×238、裸 slug=0、技能中心内置 11 卡可见、分组头 sticky 吸顶（标题 y==容器 top 220）。
  - PC 1280×757：技能卡 **560×530 fitsViewport**（原 1772 爆宽根除）、内层滚轮滚动 auto 保留、管理 Modal 720×606 两列 323px 基线不变、详情居中窄卡 **480px**（mobileSheetAbsent=true）。
- 探针资产：`.workbuddy/e2e-cdp/ux-prod-probe.mjs`（全链）+ `prod-mobile-ab.mjs`（A/B 链补测）。
- 诚实边界：iOS 真机惯性/橡皮筋需真机复核一次；市场目录空为运营数据面。
