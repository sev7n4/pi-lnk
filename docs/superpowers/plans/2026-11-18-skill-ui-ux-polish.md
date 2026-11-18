# 技能 UI/UX 美化 · 实施计划

> 规格：`docs/superpowers/specs/2026-11-18-skill-ui-ux-polish-design.md`（approved，含三条澄清 §4.4–§4.6）。
> 范围：apps/web only；零 server/pi-runtime。分支：`feat/skill-ui-ux-polish`（worktree，2026-11-18 从当前基线开出以承载未提交改动；推 PR 前按最新 master 重建基线与 PR 面）。
> 第一原则：每任务标注复用资产，禁止重复造轮子；禁造数/禁自报。
> 完整 SKILL.md 正文属 P4 跨层刀（规格 §8），本计划只落实只读详情壳。

## 0. 复用资产清单

| 任务 | 复用（不新建） | 仅新增 |
|---|---|---|
| T1 `/` 卡片 | `MentionInput.vue` 现有 `neo-popover`/`activeOptions`/键盘导航；`getAgentSkill` desc | 显示名派生纯函数 + 选中态/尺寸 CSS |
| T2 `+` sheet | `MobileSheet.vue` 现成基座；`BrandPatternAvatar`；`SkillPickSheet` 现有 emit/data-testid | 用 MobileSheet 重排 skill-pick 内容 |
| T3 管理页 | `SkillDiscoverPanel.vue` 现有结构/API；`dockSkills` 单一事实源 | 工具栏重排 + 卡片布局 + 空态文案 |
| T4 开关 | `.mine-switch` 现有 role=switch/setEnabled 契约 | 尺寸/热区/配色 CSS + 语义文案 |
| T5 门禁 | `design-token.test.ts` 现成守卫；既有 vitest 测试文件 | 判据测试 + 变异 |
| T6 详情壳 | `MobileSheet.vue` 基座 + 卡片已加载数据（dockSkills / mine / catalog） | 薄只读 `SkillDetailSheet.vue` + 管理页卡片点击接线 |
| T7 placeholder | `agentInputPlaceholder()` 纯函数 + 既有 computed 优先级链 | 文案收敛 + 旧断言改写 |

## 1. 任务拆解

### T1 · `/` slash 卡片标签化
- T1.1 `agentSkillMap.ts` 或 MentionInput 内加 `displayNameFromDesc(desc)`：取**首个 `。` 前**（无 `。` 退首个换行），trim + 限长；**禁按 `/` / `，` 切**（`短剧/漫剧…` 会被砍成 `短剧`）；失败回退 slug。纯函数 + 单测含 `短剧/漫剧` 用例。
- T1.2 MentionInput `activeOptions` 传入的 label 改走派生显示名（不破坏 `slash-select` 载荷 id）。
- T1.3 CSS：选中态去黑底改 `--lnk-hi-bg`/hi-text；项高 `--lnk-touch-target`；`max-h` 48vh；加"技能 · N"小标题。
- **判据** U1；**变异** M-U1。

### T2 · `+` sheet 移动端复用 MobileSheet（PC 仍锚定 popover）
- T2.1 `AgentSideRail.vue`：移动端分支用 `<MobileSheet title="选择技能" :subtitle="已选 N">` 承载 `<SkillPickSheet>`；PC 分支保留 `.skill-sheet-card` 锚定 popover + 自己的 44px 关闭头；保留 `toggle/clear/manage/close` 接线与 data-testid。
- T2.2 `SkillPickSheet.vue`：去掉自身 mask/head/close（交给两个宿主），只留 list + foot；图标换 `BrandPatternAvatar` 分类色标；勾选改圆形；管理入口提为主操作样式。
- T2.3 同步 F1 守卫：删移动端 `.skill-sheet-card` fixed CSS，`AgentSideRail.skillSheetMobile.test.ts` 改写为「移动端命中 MobileSheet / PC 仍命中 skill-sheet-card」。
- **判据** U2；**变异** M-U2。

### T3 · 管理技能页布局
- T3.1 空态文案重写（"平台提供内置技能…"）。
- T3.2 工具栏 flex 稳定两行（搜索/import/batch 同一行；批量计数仅批量态第二行）；禁止意外第三行换行。
- T3.3 卡片：移动端单列（`grid-template-columns:1fr`，`@media(min-width:640px)` 才 2 列）；名称 2 行内完整；头像 `BrandPatternAvatar` 分类色标；内置标签语义化。
- **判据** U3。

### T4 · 胶囊开关规范与语义文案
- T4.1 `.mine-switch` 51×31 / knob 27 / 触控热区 44（伪元素扩展）/ 实色关闭态；内置卡无开关。
- T4.2 `aria-label` 写清「停用后不再自动生效，也不出现在 + / / 列表」语义；副标题区分启用/停用；`role=switch`/`aria-checked`/`setEnabled` 契约不变。
- **判据** U4/U6；**变异** M-U4/M-U6。

### T5 · 门禁与验收
- T5.1 U1–U4/U6–U8 判据写入对应 `.test.ts`（静态 DOM/CSS 断言 + 纯函数单测）。
- T5.2 5 条变异逐个注入→跑判据→完整 stdout 确认 RED→还原 hash 校验。
- T5.3 定向 vitest + `vue-tsc -b` + `design-token.test.ts` 全绿；**web 全量交 CI**（本机 4 核限制，见 `docs/agent/delivery.md`）。
- T5.4 合并后 web-only 部署 + 生产 CDP 五场景复测（390px + 1440px，含「点卡片看详情」）。

### T6 · 技能详情只读壳（用户 Q2 本刀部分）
- T6.1 新增 `components/skills/SkillDetailSheet.vue`：薄只读组件，props 接收 name/desc/source/version/trust/enabled/builtin，`close` emit；零 fetch、零新字段、零正文占位骨架（P4 才补正文）。
- T6.2 `SkillDiscoverPanel.vue` 三类卡片（内置/自定义/市场）在非批量态整卡可点打开详情；开关/回滚/卸载 `@click.stop` 保持；批量态点击仍 = 勾选。
- T6.3 data-testid `skill-detail-sheet` + `skill-detail-open`；复用 `MobileSheet` 的把手/遮罩/safe-area（若面板已被宿主 sheet 包覆则用现成 Teleport，不在面板内再造 mask）。
- **判据** U7；**变异** M-U7（移除卡片点击入口或详情组件引用）→ U7 RED。
- 等价物检索：`AgentRefDetailSheet.vue` 是画布引用详情，语义不同不复用；`MobileSheet.vue` 复用为容器（同一套 sheet 交互）。

### T7 · Composer 占位收敛（用户 Q3）
- T7.1 `agentSkillMap.ts`：`agentInputPlaceholder(skill)` 有 skill → `补充描述…`；无 skill → `AGENT_INPUT_PLACEHOLDER_AUTO` 不变。
- T7.2 `AgentSideRail.vue` 优先级链不改；只消费新文案。
- T7.3 `agentSkillMap.test.ts` / `agentSkillMap.keyboard.test.ts` 旧断言改写为「不含技能名、不含 @」+ 无技能分支保留 `@`。
- **判据** U8；**变异** M-U8。

## 2. 门禁矩阵

| 门 | 命令 | 条件 |
|---|---|---|
| 判据 | vitest 显式文件列表，node24 `--maxWorkers=1 --no-file-parallelism` | U1–U4 / U6–U8 全绿 |
| 变异 | 逐条注入 + 完整 stdout 断言 AssertionError + 还原 | M-U1/M-U2/M-U4/M-U6/M-U7/M-U8 全 RED，无模块解析假红 |
| 令牌守卫 | `design-token.test.ts` | 零新增裸 hex/rgba，全绿 |
| 类型 | `vue-tsc -b apps/web/tsconfig.json` | 干净 |
| 全量 | CI `Build monorepo` job | 本地只跑定向，不假报全量 |

## 3. 提交与部署边界（分阶段授权）

1. 本阶段（已完成）：落地 T1–T7 + 本地定向门禁全绿（含 6 条变异 RED + hash 还原），规格/计划回填"已实施待合"；未开 PR / 未合并 / 未部署。
2. 合并阶段（单独确认）：REST 推 PR，推前核 master 触碰面零交集；CI 4/4；合并树 == CI head tree；逐路径 KEPT。
3. 部署阶段（单独确认）：web-only（push 自动分流或补派带 `deploy_web_only=true`）；判据产物 chunk 含新标记；生产 CDP 五场景复测。
4. 收尾：docs 终态回填，关单；P4 完整正文另开刀。

## 4. 诚实边界

- 零 API 契约变化：开关语义不变只改文案；placeholder 只改展示文案；详情壳只读复用已加载数据。P3 hotfix 的 skillSheetMobile 测试需随基座统一更新，不破坏其防回潮意图。
- displayName 是 desc 首句派生，不是新增数据字段——若 golden description 改了，显示名自动跟随（单一事实源）。
- 完整 SKILL.md 正文数据面不具备（detail 无 body / runtime list 无 content），按规格 §8 走 P4；本刀详情壳不放假正文、不造骨架。
- 不写 `ALL_PASS`；变异判 RED 用完整 stdout，禁 `| tail` 吃退出码、禁伪变异。
