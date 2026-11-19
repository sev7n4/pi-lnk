# 设置入口层级修正与外观主题区分 · 实施计划（v2 返工）

> 对应规格：`docs/superpowers/specs/2026-11-19-model-settings-relocation-theme-distinction-design.md`
> 基线：`origin/master` = `9472bc9b`（v1 PR #957 已合并）。所有改动走独立 worktree。

## Global Constraints
- 第一原则：吃满上游、接线优先于新建、禁造数/禁自报。规格 §0 等价物检索结论表为准。
- **不碰主仓工作区**（在他人 `docs/task-planning-roadmap` 分支且大量未提交改动）。全部在 worktree 操作。
- 组件只消费 L2/L3 令牌；选中态禁 `hi-bg/hi-text`，用 `accent-subtle/accent-text/accent-border`。
- 每刀 TDD：失败测试 RED → 实现 → GREEN → 提交。守卫锁规则本体非接线表象。
- 测试用 node24（`source ~/.nvm/nvm.sh && nvm use 24`）；vitest 带 `--maxWorkers=1 --no-file-parallelism`。
- 每提交前 `git status` 必须干净（除本次目标文件）。
- 合并前必核 `compare base...head` 触碰面；squash 后核合并树 == CI 验证 head 树。

## Review Focus
- R2 的守卫反转是否真锁死「不再回退到 Profile Tab」——变异测试必须能转 RED。
- 外观缩略预览是否真的两主题恒定（`stamp-*`/`surface-signature` 不变式），而不是随主题翻转。
- `setTheme` 是否复用现有 watch 链路（无第二个真相源、无模块级副作用）。
- `/settings` 路由与旧 `/profile?tab=settings` 的兼容：后者应自然回落到 account（不报错、不留死链）。

---

### Task 1 · 新增 /settings 路由 + SettingsPage 骨架（R1 部分）
1. **失败测试**：新建 `SettingsPage.test.ts`，用 `vi.resetModules()` 动态 import（复现 DOM 真相源），断言：页面有唯一 h1「设置」、`theme-option-light`/`theme-option-dark`/`open-model-settings` 三个 testid 存在、未登录调 `openLogin`。跑 → RED。
2. **实现**：
   - `router/index.ts` 在 `/profile` 块后插入 `/settings` 路由（lazy import `SettingsPage.vue`）。
   - 新建 `apps/web/src/pages/SettingsPage.vue`：外壳对齐 ProfilePage（`max-w-3xl px-6 py-10` + 返回按钮 `data-testid="settings-back"` + `<h1>`）；`onMounted` 登录守卫；先放占位（外观/模型配置行留空 div 带 testid）。
   - mock `ProviderConfigDialog` 避免弹层副作用。
3. **GREEN** 后提交：`feat(web): add /settings route and standalone settings page shell`。

### Task 2 · useCanvasTheme 加 setTheme（R2）
1. **失败测试**：`SettingsPage.test.ts` 加用例——动态 import 后调 `setTheme('light')`，断言 `<html data-theme>` = light、`.dark` class 移除、localStorage `lnkpi-canvas-theme`=light。跑 → RED（无 setTheme 导出）。
2. **实现**：`useCanvasTheme.ts` 加 `function setTheme(value: CanvasTheme) { theme.value = value }`，返回对象加 `setTheme`。不动 watch/applyTheme。
3. **GREEN** 后提交：`feat(web): expose setTheme in useCanvasTheme`。

### Task 3 · 外观双选项 + 选中态（R1 视觉核心）
1. **失败测试**：`SettingsPage.test.ts` 加：两选项 `aria-pressed` 反映当前主题；点击 light 选项 → `setTheme('light')` 生效；选项 class 含不变式令牌类（浅 `stamp-face-on-signature`、深 `surface-signature`）与 accent 选中态类。跑 → RED。
2. **实现**：设置页外观卡片渲染两个 `<button>`：
   - 每个含缩略条 div（浅/深各用对应的不变式令牌任意值类，如 `[background:var(--lnk-stamp-face-on-signature)]`）。
   - `:aria-pressed="theme === 'light'"`；`:class` 选中时加 `[border-color:var(--lnk-accent-border)] [background:var(--lnk-accent-subtle)] text-accent-text`。
   - `@click="setTheme('light')"` / `setTheme('dark')`。
   - 超小示意条用 `stamp-ink-on-signature` / `text-on-signature`。
3. **GREEN** 后提交：`feat(web): render distinguishable light/dark theme options in settings`。

### Task 4 · 模型配置行接弹层（R1 收口）
1. **失败测试**：`SettingsPage.test.ts` 断言点 `open-model-settings` → `showModelSettings` 变 true（通过 stub 的 `modelValue` prop 观察）。跑 → RED。
2. **实现**：设置页加模型配置行按钮 + `<ProviderConfigDialog v-model="showModelSettings" />`（从 `@/components/canvas/ProviderConfigDialog.vue` import）。
3. **GREEN** 后提交：`feat(web): wire model config dialog into settings page`。

### Task 5 · 头像菜单加「设置」一级项（R3）
1. **失败测试**：`AccountUserMenu.test.ts` 加：菜单含 data-testid `account-settings` 的按钮、文案「设置」、点击后 `router.push` 收到 `/settings`、位于「退出登录」之前。跑 → RED。
2. **实现**：`AccountUserMenu.vue` 加 `openSettings()`（closeMenu + push('/settings')）；在「个人资料」按钮后、「退出登录」前插按钮。
3. **GREEN** 后提交：`feat(web): add settings entry to account user menu`。

### Task 6 · 移除个人中心设置 Tab（R4，反转）
1. **失败测试**：`ProfilePage.test.ts` 删除 v1 加的两个 settings 用例与 stub mock；新增反向断言——`?tab=settings` 时页面无 `profile-settings-panel`、activeTab 回落 account。`settings-domain-tokens.test.ts` 的 R2 改为反转判据（见 Task 7）。跑 → RED（ProfilePage 仍有 settings Tab）。
2. **实现**：`ProfilePage.vue` 删 imports（ProviderConfigDialog/ThemeToggle）、`ProfileTab` 回退两值、`activeTab` 删 settings 分支、`showModelSettings` 删、tab 列表删 settings、`panel-settings` 整块删、`<ProviderConfigDialog>` 删。
3. **GREEN** 后提交：`refactor(web): remove settings tab from profile page (moved to /settings)`。

### Task 7 · 守卫改写 + 新增外观判据（R5）
1. 改 `settings-domain-tokens.test.ts`：
   - R1（竖轨无 open-settings）、R3（弹层 --neo- 归零）、R4（A11y 标题 id）保留。
   - R2 反转为：`ProfilePage.vue` 不含 `panel-settings`；`router/index.ts` 含 `/settings`；`AccountUserMenu.vue` 含 `account-settings` + `push('/settings')`；`SettingsPage.vue` 含三 testid。
   - 新增 R5：设置页用 `stamp-face-on-signature`/`surface-signature`/`accent-subtle`/`accent-text`，且外观选中行不含 `hi-bg/hi-text`。
2. **GREEN** 后做**变异自检**（spec DoD 5）：
   - 变异 a：往 `ProfilePage.vue` 塞回 `panel-settings` → R2 反转移 RED → 还原。
   - 变异 b：把设置页 `stamp-face-on-signature` 改成普通 surface → R5 转 RED → 还原。
   - 变异 c：删 `AccountUserMenu` 的 `push('/settings')` → R2 转 RED → 还原。
   - 变异 d：塞回 `--neo-` 到弹层 → R3 转 RED → 还原。
   - 每个变异后用 `git diff` 确认零残留。
3. 提交：`test(web): guard settings relocation, theme distinction, and no-regression`。

### Task 8 · 门禁 + 静态脚本行数同步
1. 跑静态脚本实测是否行数漂移：
   - `python3 scripts/verify-pc-canvas-legacy-scope.py`
   - `python3 scripts/verify-pc-visual-regression.py`
   - 若报 router/Profile 行数漂移，按实测值同步 `scripts/fixtures/pc-canvas-legacy-manifest.json`（v1 教训：只写实测值，不改其他）。
2. 视觉守卫回归：`vitest run src/styles/design-token.test.ts src/styles/theme-usage.test.ts src/styles/palette-parity.test.ts src/styles/text-token-guard.test.ts src/styles/settings-domain-tokens.test.ts`。
3. 定向测试汇总：ProfilePage / SettingsPage / AccountUserMenu / ThemeToggle / CanvasPage.mobileEntryWiring / ProviderConfigDialog / 5 守卫。
4. 类型检查：`pnpm --filter @lnkpi/web exec vue-tsc -b`。
5. 全绿后 `git status` 干净 → 进入部署链。

### Task 9 · PR → CI → 合并 → 部署 → 生产复测
1. 推分支（git push；502 则 REST blob→tree→commit→ref，blob 用大写 `-F content=@file`）。
2. PR body 四必填；盯 CI 三 required + `Verify spec figures`。
3. 失败先读日志定位（v1 教训：行数漂移、blob 字面化）。
4. squash 合并 → 核合并树 == CI head 树 → 盯 deploy web-only。
5. 生产取证：新 chunk 命中 `theme-option-light`/`设置`（头像菜单）/`/settings` 路由特征串；用旧串对照确认 chunk 正确。
6. CDP 目视走查：同一会话内切深浅主题，截图确认双选项选中态区分清晰（主题跨脚本会丢，必须单会话）。
7. 收尾清理 worktree/分支，写工作日志。

## Self-Review
- 每刀有失败测试先行与真实命令 ✓
- 守卫反转锁死返工不回退 ✓
- 令牌用不变式 L2 + accent 稳定色，符合硬规则 ✓
- setTheme 复用 watch 链路，无第二真相源 ✓
- 覆盖 v1 成果零回归（竖轨/弹层/移动端）✓
