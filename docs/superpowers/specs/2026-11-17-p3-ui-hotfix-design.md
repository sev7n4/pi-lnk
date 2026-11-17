# P3 真机四缺陷修复 · 设计规格

> 立项日期：2026-11-17。状态：**已上线闭环（PR #945，合并 `8bb1e946`，2026-11-17 完成）**。
> 实施结论：F1 移动端技能 sheet 复用 attach-card 底部抽屉 CSS（fixed/z90/safe-area）；F2 SkillDiscoverPanel 加 `builtinSkills` prop 渲染只读内置分区（数据来自宿主 dockSkills，零 fetch，无开关/卸载）；F3 DiscoverPane 改 emit + MobileSheet 承载技能中心（market tab）；F4 slash 去 slice(0,8)。
> 验收：web 关键 46/46 + 全量 4353/4353（2 文件因基底同步时序首轮失败、补齐后 22/22 全绿）；双 vue-tsc/tsc 干净；变异 N1–N5 全 5/5 RED。部署/生产 CDP 复测待单独授权。
> 前序：`2026-11-17-p3-import-chip-manage-design.md`（PR #938 合 `8ebf962e` 已上线）——本刀修其真机暴露的四缺陷，**不新增后端端点、不碰 pi-runtime**。
> 遵循：AGENTS.md「第一原则——吃满上游、不重复造轮子」（§7 附逐项等价物检索结论表）。
> 取证方式：生产 CDP（账号 17279698608，session `cmwjhglas012bqo01klyuturd`），2026-11-17 实测，四缺陷全部复现。

## 1. 背景与取证证据（逐缺陷）

| # | 用户现象 | 生产 CDP 实测根因 | 定级 |
|---|---|---|---|
| D1 | 移动端 composer 点 `+`→【技能】不弹技能清单卡片（PC 可以） | sheet 的 Teleport 与 attachCard 同走 `to="body" :disabled="isDesktopDock"`，但**只有 attach-card 有移动端 CSS 覆盖**（`position:fixed;left/right:12px;bottom:0;z-90`）。`skill-sheet-card` 停在 `absolute bottom-full left-0 z-30`：实测 Teleport 到 BODY 后 `rect.y=-382`（整块在视口上方、不可见），遮罩 z85 又高于它。PC 因不 Teleport、在面板内相对定位，故正常 | 缺陷 |
| D2 | PC 点【管理技能】弹窗卡片无数据 | 面板只读 `skillApi.mine()`：实测 `/skills/mine` code0 但 `count=0`、`/skills/catalog`=0、`/skills/runtime`=11。即"已安装技能"是真 0，11 个内置技能在 runtime 层、从不进 mine。截图 "已安装技能（0）/还没有已安装技能" 是**真实状态**，非渲染 bug | 产品边界问题（用户裁定按业界最佳实践修） |
| D3 | 移动端【发现】页点技能没反应 | `DiscoverPane.onSoonClick('skills')` 确实 toggle `skillsOpen=true`、面板也渲染（`panel:true`），但技能入口在社区流之后（`rect.y=1388`，视口 844），点击后**不滚动、面板在视口外**（`inViewport:false`）；且只展开内嵌面板，不是用户期望的"进技能市场" | 产品交互问题 |
| D4 | `+`→技能见 11 个，`/` 只见 8 个 | `MentionInput.vue:104` slash 候选硬编码 `.slice(0, 8)`；`+` sheet 的 11 个来自同一 `dockSkills`，被这一刀砍成 8。PC/移动同源同症状 | 缺陷 |

## 2. 业界调研结论（D2/D3 拍板依据，一手来源）

| 产品 | 内置技能 vs 用户已安装 | 管理界面形态 |
|---|---|---|
| **WorkBuddy**（官方文档 `workbuddy.cn/docs/.../Skills-Market`） | 技能板块明确二分：「技能市场」（推荐/SkillHub/套件，一键装） vs 「已安装」（本地装/传/建，可直接调用）；内置 20+ 技能包随产品走、自动命中，不占"已安装"列表 | 统一技能板块 = 市场 + 已安装两区；启用/关闭状态记用户全局配置、多端同步；**关闭 ≠ 卸载**（只暂停模型调用，文件与开关记录保留） |
| **Claude Code**（`/plugin` 官方管理器） | `/plugin` 只有 Installed / Discover / Marketplaces 三 tab；内置能力根本不进插件管理器；插件技能用 `plugin-name:skill-name` 命名空间隔离 | 单一管理器，多 tab（含 Errors 加载错误栏）；install/enable/disable/uninstall 都是插件级，支持 user/project 双 scope |
| **Codex**（`learn.chatgpt.com/docs/customization`） | 内置是优先级最低的系统层（`~/.codex/skills/.system/`），用户技能在 `~/.codex/skills/`，跨目录不混进一个管理列表；渐进式披露（元数据常驻 + 正文命中才读） | 无单一 GUI 管理页；技能按目录层级发现，遵循就近优先 |

**共识**：内置（平台提供、常驻/自动命中）与用户已安装（可开关/卸载、随账号同步）是**两个真边界**，不混列为同一种"已安装"。统一入口内用 tab/分区并置，而非把内置伪装成用户资产。

## 3. 拍板结论

- **D2**：不把内置技能塞进 `/skills/mine`（会让平台路由依赖的可卸载、伪造数据、违反"吃满上游"）。在管理页「我的技能」top 增一个**只读「内置技能（11）」分区**，数据直接复用宿主传入的 `dockSkills` 里的内置项（= `runtimeSkillsToInstalled` + `AGENT_SKILLS` 来源），标注"平台提供 · 常开 · 不可停用"，**无开关/无卸载**。用户已安装技能仍走开关/卸载/批量（现成端点）。市场 tab 不变。
- **D3**：移动端发现页点技能 = **打开同一个技能中心**，以底部 sheet 形态弹出（与 `+` 技能 sheet 同形态），默认落「技能市场」tab；撤掉内嵌展开。
- **D1/D4**：纯修复，无语义变更。

## 4. 范围

### 4.1 做
- F1：给 `skill-sheet-card` 补移动端 CSS 覆盖（fixed 底部抽屉 + z-90 + safe-area），与 attach-card 同款模式。
- F2：`SkillDiscoverPanel` 增可选 prop `builtinSkills`（默认 `[]`），mine 视图顶部渲染只读内置技能分区；`AgentSideRail` 管理弹层与移动端发现 sheet 均传 `dockSkills` 进去。
- F3：`DiscoverPane` 技能入口改为打开底部 sheet 承载 `SkillDiscoverPanel`（initial-tab=`market`），替代内嵌展开。
- F4：`MentionInput` slash 候选去掉 `.slice(0, 8)`（或提到与 dock 全量一致），`/` 与 `+` 候选数一致（生产实测 11）。

### 4.2 明确不做
- 不改任何后端端点/字段、不改 pi-runtime（不触发 runtime-deploy）。
- 不做行内 token 胶囊（仍二期）、不做 zip/url/github 导入 UI、不做"去上架"发布线。
- 不给内置技能加开关/卸载（违反边界 + 无对应后端语义）。
- 不改 `mergeAgentSkills` / `resolveForceSkillsMulti` 既有过滤语义。

## 5. 关键设计（吃满上游）

| 能力 | 复用（吃满） | 禁止 |
|---|---|---|
| 内置技能清单 | 宿主 `dockSkills`（#929 单一事实源）经 prop 传入，面板只读消费 | 面板内另拉 `/skills/runtime` 或硬编码 11 个名字 |
| 浮层/sheet 容器 | `+` 技能 sheet 同款 Teleport + attach-menu-backdrop + neo-popover；移动端沿用 attach-card 底部抽屉 CSS | 新造浮层机制、新 modal 组件 |
| 管理面板 | `SkillDiscoverPanel` 单组件加 prop（E8 两端受益） | 另起 `SkillManagePanel` 平行组件 |
| 已安装技能操作 | `skillApi.mine/setEnabled/uninstallBatch/remove`（现成） | 新增端点/字段 |
| slash 候选 | `slashSkillOptions`（与 `+` 同 dockSkills 源） | 新造第二份技能候选列表 |

## 6. 行为判据（F 系列）

| # | 判据 |
|---|---|
| F1 | 390px 视口点 `+`→技能，sheet `getBoundingClientRect` 落在视口内（y≥0 且 bottom≤innerHeight），遮罩 z85 < sheet z90；11 项可见 |
| F2 | 管理页「我的技能」视图顶部有只读「内置技能」分区，条目数 == dockSkills 中内置项数（生产 11），每项无 `mine-toggle`/无卸载按钮；已安装区仍走开关/卸载；数据源为 prop 传入，面板内零 `/skills/runtime` 调用 |
| F3 | 移动端发现页点技能 → 底部 sheet 弹出 SkillDiscoverPanel、默认 market tab、在视口内；原内嵌展开不再出现 |
| F4 | `/` 候选数 == `+` sheet 候选数（生产 11）；过滤匹配仍有效 |
| F5 | PC 端四行为不回退（sheet popover / 管理弹层 / `/` / 发送），design-token.test.ts + 双 vue-tsc 干净 |

## 7. 负例 / 变异（N 系列，转红判据）

| # | 变异 | 靶 |
|---|---|---|
| N1 | 删 skill-sheet-card 移动端 fixed 覆盖 | F1（rect.y 回 -382） |
| N2 | 内置分区改为面板内独立 fetch runtime | F2（零新数据源判据） |
| N3 | 内置分区渲染开关/卸载按钮 | F2（边界） |
| N4 | 发现页技能退回内嵌展开 | F3 |
| N5 | slash slice(0,8) 保留 | F4（候选数回 8） |

## 8. 诚实边界

- D2 的内置技能"只读"是**产品语义选择**（业界共识），非后端能力缺失；若未来产品要允许隐藏内置技能，需另立规格（新用户配置端点），本刀不做。
- D1 移动端 sheet 只修定位/层级；手势/swipe-to-close 不在本刀（沿用 attachCard 点遮罩收拢）。
- 生产环境 `/skills/catalog`=0（市场空）是真实数据状态，本刀不塞 mock 填充市场。

## 9. 等价物检索结论表（第一原则 · 逐项）

| 检索项 | 命令/方式 | 结论 |
|---|---|---|
| 移动端底部抽屉现成 CSS | grep `.attach-card` @media（AgentSideRail.vue:5786） | 已存在 fixed+z90+safe-area 模式 ⇒ F1 复用而非新造 |
| 内置技能数据源 | `dockSkills`（AgentSideRail.vue:963-968）+ `runtimeSkillsToInstalled` | 单一事实源现成 ⇒ F2 只读消费，禁二次拉取 |
| 管理面板组件 | `SkillDiscoverPanel`（被 AgentSideRail + DiscoverPane 双消费） | 单组件加 prop 即可 ⇒ 禁平行组件 |
| 技能 sheet 容器 | AgentSideRail 内 SkillPickSheet Teleport 块（4358-4382） | 现成 ⇒ F3 复用其形态，禁新 modal |
| slash 候选源 | `slashSkillOptions` = dockSkills map（AgentSideRail.vue:975-977） | 与 `+` 同源 ⇒ F4 只需删 slice，禁新列表 |

## 10. 依赖与部署

- 触发面：`apps/web` only（CSS + 组件 + composable 接线）→ `deploy.yml` web 分流；**不碰 server/pi-runtime**（可 `deploy_web_only=true` 补派，避免 API 无谓重建）。
- 验收：CDP 复测四场景（PC + 390px 移动）；web 全量单测 + vue-tsc；变异 N1–N5 全 RED。
