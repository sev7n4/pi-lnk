# 对话页模型选择卡 iOS 化 · 实施计划

> 对应规格：`docs/superpowers/specs/2026-11-20-model-selector-sheet-config-design.md`
> 基线：当前工作区在他人 `feat/canvas-create-entry-ui-20261120` 分支且有未提交改动（Canvas 域令牌重构）——**不碰主仓工作区**，全部在独立 worktree（`git worktree add`）从 `origin/master` 开工。

## Global Constraints
- 第一原则：吃满上游、接线优先于新建、禁造数/禁自报。规格 §0 等价物种结论表为准。
- 组件只消费 L2/L3 令牌；选中态禁 `hi-bg/hi-text`，用 `accent-subtle/accent-text/accent-border`；零新 hex。
- 移动端编排归 `components/mobile` 壳层；不新增 PC 组件内 767px 补丁——本次是**删除** `neo-node.css` 旧补丁。
- 每刀 TDD：失败测试 RED → 实现 → GREEN → 提交；守卫锁规则本体非接线表象。
- 测试用 node24（`source ~/.nvm/nvm.sh && nvm use 24`）；vitest 带 `--maxWorkers=1 --no-file-parallelism`；`vue-tsc -b` 勿加 `--noEmit`；pnpm 须 `env -u NODE_OPTIONS`。
- 每提交前 `git status` 干净（除本次目标文件）；合并前核 `compare base...head` 触碰面；squash 后核合并树 == CI 验证 head 树。

## Review Focus
- AD2 配置页在**同一 Sheet 内切换**（非新浮层）——守卫要锁 `view` 状态与返回按钮，防退化为双层弹层。
- AD3 思考强度种子表：key 必须是 `catalogModelKeyFromValue`（与能力判定同源），且"切模型只种一次、运行时单值下传"要在代码注释和守卫里双锁。
- R1 给 MobileSheet 加插槽后，存量 8+ 调用点零回归（尤其技能卡手势守卫不能假绿）。
- R5 上下文窗口派生规则**单一真相源**：前端不得另写一份正则与服务端分叉。
- 令牌守卫要能证伪：把 accent 改回 `--neo-hi-bg` 必须转 RED。

---

### Task 1 · MobileSheet 基座扩展（R1）
1. **失败测试**：新建 `MobileSheet.test.ts`，断言：传 `showBack` 渲染 `data-testid="m-sheet-back"` 且点击 emit `back`；传 `headerActions` 插槽渲染内容；不传时两者不出现；`swipeToDismiss` 默认 true。跑 → RED。
2. **实现**：`MobileSheet.vue` props 加 `showBack?: boolean`、emit 加 `back: []`；header title 前加返回按钮（`--lnk-touch-target` 44×44、`aria-label="返回"`、`:lnk-radius-md`、active 用 `--lnk-pressed-overlay`）；close 前加 `<slot name="headerActions" />`。默认不渲染。
3. **GREEN** 后提交：`feat(web): add optional back button and header actions slot to MobileSheet`。

### Task 2 · 上下文窗口规则上移 shared（R5）
1. **失败测试**：新建 `contextWindowLabel.test.ts`（web），断言 `contextWindowLabel('ch_1::claude-...')='200K'`、`gpt-5='400K'`、`gemini='1M'`、未知='128K'；并与 server `resolveModelCapability` 交叉断言数值一致。跑 → RED（函数不存在）。
2. **实现**：`packages/shared/src` 导出 `CONTEXT_WINDOW_RULES` + `resolveContextWindow(modelValue): number` + `contextWindowLabel(): string`（200K/400K/1M/128K）；`apps/server/src/provider/model-capability.ts` 改为 import 该常量替换本地 `CONTEXT_WINDOW_RULES`，4 条既有单测须保持绿。
3. **GREEN** 后提交：`refactor(shared): hoist context window rules for single source of truth`。

### Task 3 · 思考强度按模型种子（R4）
1. **失败测试**：新建 `thinkingByModel.test.ts`，断言：按 `catalogModelKeyFromValue` 写读种子；切模型后查表种入；不支持模型强制 off；localStorage 旧值容错。跑 → RED。
2. **实现**：`usePreferences.ts` 加可选 `thinkingByModel`；`AgentSideRail.vue` 的 `setPlanningThinkingLevel` 增写种子副作用；`watch(planningModel)` 查表种入（能力门禁复用 `showPlanningThinkingControls`）；加动机注释（种子只在切模型时用一次）。
3. **GREEN** 后提交：`feat(web): remember thinking level per model as session seed`。

### Task 4 · 模型选项抽 composable + 令牌清零（R2 前半 / R6）
1. **失败测试**：新建 `UniversalModelSelector.tokenGuard.test.ts`，锁源码零 `--neo-hi-bg/hi-text`、选中态用 accent 三件套；跑 → RED（旧令牌仍在）。
2. **实现**：把 `selectableOptions`/`current`/`unavailableTitle` 抽成 `useModelSelectorOptions` composable（纯逻辑），PC popover 消费它；选中态 class 改 accent 三件套；`UniversalModelSelector.test.ts` 5 组行为测试须保持绿。
3. **GREEN** 后提交：`refactor(web): extract model selector options and clear legacy tokens`。

### Task 5 · 模型卡双形态 + 配置页（R2 后半 / R3）
1. **失败测试**：新建 `AgentSideRail.modelSheetMobile.test.ts`，静态锁：`v-if="isDesktopDock"` 分支 + 移动 `<MobileSheet title="选择模型">` + `model-config-open` 设置按钮 + `view` 状态 + `show-back` + `contextWindowLabel` 只读行 + `neo-node.css` 无 `.dock-inline-card` 移动端 12px 块。跑 → RED。
2. **实现**：
   - `AgentSideRail.vue`：`agent-dock-params` 处分 PC `v-if="isDesktopDock"` / 移动 chip + MobileSheet；复用 Task 4 composable 渲染列表（可提 `ModelOptionRow.vue` 共享）。
   - Sheet header 右侧插槽放齿轮设置按钮（44×44、SVG、`data-testid="model-config-open"`、`aria-label="模型配置"`）。
   - 点设置 → `view='config'`；header 变返回 + "模型配置" + subtitle "当前模型：xxx"；配置页用 inset-grouped 卡（`--lnk-surface-base`/`--lnk-radius-xl`/`--lnk-border-subtle`）渲染思考强度三档（点选调 `setPlanningThinkingLevel`）与上下文窗口只读行（`contextWindowLabel(planningModel)`，无 chevron）。
   - 返回按钮 → `view='list'`；close/遮罩/下滑 → 关 Sheet 并复位 `view`。
   - `neo-node.css` 删 `:1437-1450` 的 `.dock-inline-card` 移动覆盖块。
3. **GREEN** 后提交：`feat(web): model selector mobile sheet with in-sheet config page`。

### Task 6 · 守卫回归 + 变异自检（R6）
1. 全量定向：`UniversalModelSelector.test.ts`、`AgentSideRail.thinking.test.ts`、`AgentSideRail.skillSheetMobile.test.ts`、`MobileSheet.test.ts`、新建 4 个守卫 + 5 视觉守卫（`design-token`/`theme-usage`/`palette-parity`/`text-token-guard`/`mobileVisualLanguage.guards`）+ server `model-capability.test.ts`。
2. **变异自检**（4/4 须转 RED）：
   - a. 把 `AgentSideRail` 移动分支的 `MobileSheet` 换回裸 popover → 双形态守卫 RED → 还原。
   - b. 把模型卡 accent 改回 `--neo-hi-bg` → 令牌守卫 RED → 还原。
   - c. 把思考种子 key 改成裸 modelValue（非 `catalogModelKeyFromValue`）→ 种子守卫 RED → 还原。
   - d. 把配置页上下文窗口行加 chevron + click → 只读守卫 RED → 还原。
   - 每个变异后 `git diff` 确认零残留。
3. 类型检查：`pnpm --filter @lnkpi/web exec vue-tsc -b`；shared/server tsc。
4. 提交：`test(web): guard model sheet dual-form, tokens, per-model seed, read-only window`。

### Task 7 · 门禁 + 静态脚本行数同步
1. 跑 `python3 scripts/verify-pc-canvas-legacy-scope.py`、`verify-pc-visual-regression.py`；若报 AgentSideRail / neo-node.css 行数漂移，按实测值同步 `scripts/fixtures/pc-canvas-legacy-manifest.json`（只写实测值）。
2. 全绿后 `git status` 干净 → 进入部署链。

### Task 8 · PR → CI → 合并 → 部署 → 生产复测
1. 推分支（git push；502 则 REST blob→tree→commit→ref，blob 用大写 `-F content=@file`）。
2. PR body 四必填；盯 CI 三 required + `Verify spec figures`。
3. squash 合并 → 核合并树 == CI head 树 → 盯 deploy web-only（必带 `deploy_web_only=true`，否则静默 skip）；判据=产物 chunk 含 `model-config-open` / `选择模型` 新特征串。
4. 生产 CDP 走查：**同一 CDP 会话内** `Emulation.setDeviceMetricsOverride` + reload（触摸仿真跨脚本会丢）；验证全宽 Sheet、设置进配置页、三档按模型记忆、上下文只读、下滑关闭；再切双主题各截图一次确认 accent 选中态稳定。
5. 收尾清理 worktree/分支，写工作日志。

## Self-Review
- 每刀有失败测试先行与真实命令 ✓
- 守卫锁规则本体（双形态/令牌/种子 key/只读）非接线表象，变异自检逐个证伪 ✓
- 思考强度作用域经 Claude Code / Codex / WorkBuddy + 上游源码四方取证，混合模式有先例 ✓
- 上下文窗口只读且单一真相源（shared），不造用户字段、不动后端 ✓
- 零新增 hex、零翻转令牌、零第二套 sheet 皮肤 ✓
- 不碰主仓他人未提交改动，独立 worktree ✓

## Task 9 · PC 锚定卡同规范（2026-11-20 追加，生产走查反馈 + 用户拍板）
> 先在生产 CDP 走查后追加：移动端齿轮 0×0 修复（Task 6.5）+ 配置页 WorkBuddy 化（ce9dea09）已入 PR #967；本刀把 PC 对话页 composer 锚定卡拉齐同一规范。

1. **TDD 失败先行**（已完成 RED 确认）：
   - `useModelConfigView.test.ts`：状态机 list→config→thinking/context push/pop + reset（4 测）。
   - `ModelConfigPanel.test.ts`：两行 disclosure、`update:view` 导航、三档 aria-pressed + setThinking、只读上下文、令牌合规（8 测）。
   - `UniversalModelSelector.configView.test.ts`：缺省零变化 + 齿轮/二级页/返回/复位/齿轮显式尺寸（6 测）。
   - `AgentSideRail.modelSheetMobile.test.ts` 改写：配置页模板指向共用面板 + PC 接线断言。
2. **实现**：
   - 新增 `useModelConfigView.ts`（状态机单源）；`ModelConfigPanel.vue`（模板+样式单源，从 AgentSideRail 内联迁移）。
   - `UniversalModelSelector.vue`：可选 `configEnabled/thinkingSupported/thinkingLevel/readOnly/contextLabel` props + `set-thinking` emit + popover 标题头（返回/标题/齿轮 28×28）。
   - `AgentSideRail.vue`：PC 分支接线 config props；移动 Sheet 换用共用面板；样式迁移（删已迁类、补 `.model-sheet-muted`）。
3. **门禁**：定向 65/65 绿、`vue-tsc -b` 0、`verify-agent-rail-gates.py` 11/11、变异自检 2/2 RED（composable back 分支 + testid 锁本体）后零残留。
4. **部署与复测**：并入 PR #967 推送 → CI 绿 → squash 合并 → web-only 部署 → 生产 chunk 取证（新串 `pc-model-config-open` / `ums-header`）→ CDP 双端复测（PC 锚定卡配置页 + 移动端回归）。

## Task 10 · 列表行信息完备 + chip 收敛 + 倍率 + deepseek-v4 放行（2026-11-21，用户 6 点拍板）

1. **服务端**：`pricing.service.getActiveTextMultipliers()`（active 表 `text:*:in` 行 profitBpSnapshot → (10000+bp)/10000，2 位小数；PriceTable 缓存扩 `textProfitBp`）+ `PricingController.active()` 响应扩 `multipliers`；sqlite 集成测试 RED→GREEN（6/6）。
2. **shared**：`modelCapability.ts` 加 deepseek-v4 / deepseek-flash 模式（对齐 isDeepSeekV4Model），测试翻转（5/5）。
3. **前端**：`pricing-api.fetchActivePricingMultipliers()`（单飞缓存 + 失败空 map）；`useModelSelectorOptions` 加 `multiplier`（平台渠道 + text 模态限定，modelOptionName 小写归一匹配；visionCapable 模态门控迁入投影层；currentLabel 去渠道）；新增 `ModelOptionRow.vue`（PC/移动共用行）+ 挂载/令牌测试；PC popover 与移动 Sheet 接线（PC 经 attrs 透传 `.neo-popover-item`）；AgentSideRail chip 加 full-label title、删死样式。
4. **门禁**：定向 84/84 → 全量 + `vue-tsc -b` + rail-gates + 变异自检 → PR → CI → squash → 部署 → chunk 取证 → CDP 双端走查。
