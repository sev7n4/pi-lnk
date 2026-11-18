# 技能 UI/UX 美化 · 设计规格

> 立项日期：2026-11-18。状态：**implemented-review-pending（三条澄清已并入并落地，待内容审核 / PR / 部署授权）**。
> 范围：`apps/web` only（4 既有组件 + 1 个只读详情壳）；零 server / 零 pi-runtime / 零部署类型变化（走 web-only）。
> 三条澄清（开关语义 / 详情卡片 / composer 脏占位）已并入 §4.4–§4.6；跨层完整正文另立 P4（§8），不混进本刀。
> 取证：生产 CDP（测试号 17279698608 会话，390×844 + 1440×900）真实截图 + DOM rect，见 §1。
> 设计权威：`docs/design/Design_system.md`（墨流 Ink Flow）；令牌 SSOT `design-tokens.css`。
> 第一原则：吃满上游、不重复造轮子；等价物检索结论见 §3、§4.5、§4.6。

## 0. 第一原则（最高约束）

任何新增字段/组件/判据前过三判据：① 等价物检索 ② 接线优先于新建 ③ 禁造数/禁自报。
本规格三处「看似要新建」的点都经检索后被推翻或降级：中文名派生（§3）、`MobileSheet` 复用（§3）、
详情正文（§4.5 + §8：本刀只读既有数据面，正文由上游在 P4 补，Web 不做第二套解析）。

## 1. 现状取证（生产实测，非推测）

| 场景 | 实测数据 | 问题（iOS HIG 视角） |
|---|---|---|
| `/` slash 卡片 | 348×192，z20，白底圆角12；11 项只露 2–3 项；选中项 `#1a1a21` 黑底白字 | **Clarity**：深色选中块在浅色主题里对比过猛、破坏层级；显示名是英文 slug，描述灰字挤成多行；无分组标题、无选中数 |
| `+`→技能 sheet | 366×378，fixed z90，圆角16；12 项；无把手；选中"自动"整块黑底 | **Deference/Depth**：与 MobileSheet 表面语言不统一（缺拖拽把手）；首字母头像雷同、无辨识度；勾选是文字 ✓ 非圆形控件；管理入口是与列表同权重的描边按钮 |
| 管理技能页 | panel 329×814（超视口 844 被截）；内置 11 卡 2 列 142px；工具栏换行错乱 | **Clarity**：工具栏三控件挤一行 + "批量管理"掉第二行；卡片名截断成 `d...`/`实...`；头像紫色首字母千篇一律；内置边界靠"内置"描边章表达，弱 |
| 胶囊开关 | 32×18px，knob 14px | **触控**：远低于 iOS 44px 触控区与 Material 48dp；关闭态靠对比度不足的灰底 |

## 2. 设计目标（iOS 三原则 + 墨流体系）

1. **清晰 Clarity**：信息分层——显示名（中文）> 来源/描述 > slug；选中态用强调色淡底而非黑块；每项一屏可读。
2. **顺从 Deference**：内容优先——统一 MobileSheet 表面语言（拖拽把手 + 安全区 + 减速入场）；装饰退后，品牌紫只做点睛（≤10%，§墨流 §1）。
3. **层次 Depth**：真层级——sheet 用 `--lnk-shadow-lg`、卡片用 `--lnk-shadow-xs`、列表靠明度差；按钮 6 态齐全。

## 3. 等价物检索结论（推翻两处「看似新建」）

| 议题 | 直觉做法 | 检索发现（生产/源码实证） | 采纳方案 |
|---|---|---|---|
| 中文显示名 | 新建 slug→中文映射表 11 项（用户初选） | **label 已是单一事实源**：内置项（`AGENT_SKILLS`）有准确中文短名（如"实物产品视觉出图"），runtime 动态项 label 是 slug 但其 `description` 首句是中文名（如 `drama-audio-design` → "短剧/漫剧配音与声音设计"）。两者都已在 `dockSkills`，零新字段 | **零映射表 + label 优先**：label 含中文 → 直接用；label 是 slug → 从 desc 首个 `。` 前截取（无 `。` 再退换行），trim + 限长；**禁止按 `/` 或 `，` 切**（`短剧/漫剧…` 会被砍成 `短剧`）。CDP 实测修正：一律派生会把 `product-visual` 长描述显示两遍（§9 #8） |
| `+` sheet 容器 | 新建样式 | 现成 `MobileSheet.vue`（Teleport + 把手 + 遮罩 + safe-area + 减速 + 锁 body 滚动 + reduce-motion）已完美 | **复用 MobileSheet** 承载 skill-pick 内容，删自造 mask/card CSS |
| 管理页容器 | 新建 sheet | 现成 `MobileSheet`（发现页技能中心已用，F3 已上线） | 管理弹层也走 MobileSheet，两端统一 |
| 内置技能计数 | 前端硬编码 11 | `dockSkills` 已经是 runtime 单一事实源 | 直接用 `dockSkills.length` |

## 4. 四个场景的优化规格

### 4.1 `/` slash 卡片（MentionInput.vue）
- 显示名：取 `desc` 首句中文名；slug 降级为副标题（保留可辨识，不裸显）。
- 选中态：`--lnk-accent-subtle`（淡紫底）+ `--lnk-accent-text`，**禁黑底**；⛔ **不用** `--lnk-hi-bg/hi-text`——那对随主题翻转，深主题会变黑底白字（§9 #9 CDP 实测）。右侧圆形勾选标（青色能量语义 `--lnk-energy` 点状，锚灯语义）。
- 尺寸：项高 ≥44px（`--lnk-touch-target`）；卡片 `max-h` 从 192px 提到 48vh（11 项一屏可滑更多）；顶部小结"技能 · N"。
- 配色/字号全走令牌；描述提炼为短语（≤1 行，`text-xs`）。

### 4.2 `+` 技能 sheet（SkillPickSheet.vue + AgentSideRail.vue）
- **双形态（自审修正）**：移动端用 `MobileSheet` 承载（拖拽把手 + 标题"选择技能" + 「已选 N」副标题 + 44px 关闭）；PC 端**保留锚定 popover**（`.skill-sheet-card`），不换成全宽底部 sheet——`MobileSheet` 的 `.m-sheet{width:100%}` 在 1440px 下会变成整屏底栏，是回归。两端共用同一个纯内容 `SkillPickSheet`。
- `SkillPickSheet` 自身去掉 mask/head/close，只留 list + foot；标题/关闭由两个宿主各自提供，避免双头双关闭。
- 列表项：左侧 28×28 圆角色标头像（`BrandPatternAvatar` 现成组件，seed=id，颜色按分类：`auto`/`drama-*`/`ecommerce-*`/`html-*`/`research-*`）；中文显示名 + 描述短语；右侧圆形勾选（选中的青色实心）。
- 底部【管理技能】提为主操作（`--lnk-accent` 文字 + 右箭头），与列表视觉分层。
- 保留全部 data-testid 与 emit 契约（`toggle`/`clear`/`close`/`manage`），端口不变；F1 的 `skillSheetMobile` 守卫从「移动端 fixed CSS」改写为「移动端走 MobileSheet + PC 仍锚定 popover」。

### 4.3 管理技能页（SkillDiscoverPanel.vue）
- **默认 tab 决策**：保持"我的技能"默认（理由见 §6 决策建议）；内置只读分区置顶，空态文案从"还没有已安装技能"改为"内置技能由平台提供，导入或安装后可在此管理"（**不写方位词**：内置分区在 DOM 中位于空态之上，"下方"是笔误，见 §9 自审补记 #6）。
- 工具栏重排为两行：第一行[搜索框 flex-1 + 导入 + 批量]，第二行仅批量态出现操作计数；消除换行错乱。
- 卡片：名称显示完整（放宽 ellipsis 阈值，2 行内）；内置卡 2 列 142px → 移动端单列自适应（`grid-template-columns: 1fr`，≥640px 才 2 列）；头像改 `BrandPatternAvatar` 分类色标。
- 内置边界：用"平台提供 · 常开"语义标签替代表情弱的描边章；明确无开关。

### 4.4 胶囊开关（SkillDiscoverPanel.vue `.mine-switch` + 通用）
- 尺寸 51×31、knob 27px（iOS UISwitch 标准）；触控热区 ≥44px（透明扩展命中区）。
- 开启 `--lnk-accent`、关闭 `--lnk-border-strong` 实色（不靠透明度）；disabled 用 `text-disabled` 实色。
- 内置技能无开关（只读分区保持）。
- **语义澄清（用户 Q1，代码实证）**：这是「用户已安装技能的启用/停用」，**不是自动触发开关**。`onToggle()` → `skillApi.setEnabled()` → `PATCH /skills/:id/enabled`（`skill-api.ts:125`）。关闭后：① 不进 `assembleSkillResources()`（`skills-resources.ts:41`）⇒ runtime 不加载、隐式自动调用被拒（`skills-pure.ts:203-205`）；② `mergeAgentSkills()` 过滤（`agentSkillMap.ts:84`）⇒ `+` / `/` 列表不再出现；③ 关闭 ≠ 卸载（`uninstalledAt` 不变）；④ 下一轮新会话生效。真正的自动触发由 frontmatter `disableModelInvocation` 与调用意图裁决控制。`+` sheet 的「自动」= 清空本次显式选择，与卡片开关正交。
- **文案落地（本刀）**：开关 `aria-label` 明确为「停用/启用 X（停用后不再自动生效，也不出现在 + / / 列表）」语义；卡片副标题区分「已启用 · 自动可用」/「已停用」。仅改文案，`setEnabled` 契约与 `role=switch`/`aria-checked` 不变。

### 4.5 技能详情入口 + 只读详情壳（用户 Q2）
- **现状实证**：`/` 与 `+` 只有 `label + 一行 desc`；`GET /skills/:id` 详情只有元数据（`skills.service.ts:497-522`），runtime `/skills` 只有 `name / description`——WorkBuddy 截图那种完整 SKILL.md 正文当前数据面拿不到。
- **本刀范围**：管理技能页 **「我的技能」tab 内**的三类卡片（内置只读区 / 用户自定义 / 来自市场**已安装**）在非批量态可点开一个**只读详情壳**，展示该卡已有的全量信息：显示名、完整 desc（不 ellipsis）、来源/版本/信任级别、启用状态。内置技能明确标「平台提供 · 常开 · 不可停用」，不显示不存在的版本/信任字段。`技能市场` tab 的目录卡不在本刀详情范围（数据形状不同，且当前 catalog=0）。零新增 API、零新字段、零正文伪造。
- **等价物检索结论**：现成 `MobileSheet`（Teleport + 把手 + 遮罩 + safe-area + reduce-motion）做基座；只在卡片壳内新增一个薄只读组件 `SkillDetailSheet.vue`（无状态、无 fetch、只有 `close` emit）。三处卡片共用同一组件，不在三个调用点复制详情 markup。批量态点击仍 = 勾选，开关/卸载仍 `@click.stop`，不改变既有交互契约。
- **嵌套 sheet 判据**：移动端技能中心本身已由 `MobileSheet` 承载（`MobileCanvasShell.vue:469-477`），详情壳复用 `MobileSheet` 会形成同 z-index 双层 Teleport；靠 DOM 后挂载覆盖在上层，body overflow 锁按「内层存 hidden / 内层卸载恢复 hidden / 外层恢复原值」成对嵌套，不会提前解锁。CDP 复测要专门点一次「移动端技能中心 → 我的技能 → 卡片详情 → 关闭详情」确认底层 sheet 仍在。
- **入口边界**：本刀只给「管理技能页卡片」开详情；`+` sheet 与 `/` 候选仍保持单选/胶囊 toggle，详情入口与完整正文一起放到 P4（§8），避免把技能选择流改造成导航流。
- **P4 预告**：完整 Markdown 正文由上游补数据（§8），Web 详情壳只加一个正文区，不重复解析 frontmatter。

### 4.6 Composer 占位收敛（用户 Q3）
- **根因**：`agentInputPlaceholder(activeSkill)`（`agentSkillMap.ts:100-103`）把「已选技能「X」— 描述编排需求，@ 引用画布节点…」塞进 placeholder；而技能胶囊已在输入区上方单独一行显示（AgentSideRail `:4130-4154`），`@` 引导又与 ◎ 按钮和键盘 `@` 重复 ⇒ 空态三处重复信息。
- **修复**：`agentInputPlaceholder(skill)` 在 skill 存在时返回短提示 **`补充描述…`**；无 skill 时保留 `AGENT_INPUT_PLACEHOLDER_AUTO`（`描述你的想法，或 @ 引用画布节点…`）。不再重复技能名、不再出现 `@`。
- **优先级不变**：`pickMode.active`（画布点选）> `agent.isStreaming`（排队）> `inputPlaceholder` > 默认；有引用芯片/技能胶囊时都不再回退到含 `@` 的长引导。
- **行为边界**：只改展示文案，不改 `selectedSkillIds`、发送载荷、胶囊 X 与 `/` 选中逻辑；同步更新 `agentSkillMap.test.ts` / `agentSkillMap.keyboard.test.ts` 的旧断言（从「含技能名」改为「不含技能名且不含 @」）。

## 5. 判据与变异

- U1：`/` 卡片选中态无 `#1a1a21`/裸黑底、不用随主题翻转的 `--lnk-hi-bg`（锁定 `--lnk-accent-subtle`）；显示名非英文 slug；项高 ≥44。
- U2：`+` sheet 用 MobileSheet（含把手 class）；圆形勾选；管理入口为主操作样式。
- U3：管理页工具栏**两行内稳定**（搜索+导入+批量同一 flex 行；批量计数仅在批量态独占第二行；不出现意外第三行换行）；内置卡移动端单列；名称非 `d...` 截断。
- U4：开关宽高 51×31；触控热区 ≥44；内置卡无 `.mine-switch`。
- U5（gate）：`design-token.test.ts` 全绿（禁新增裸 hex/rgba）；定向判据测试绿；`vue-tsc -b apps/web/tsconfig.json` 干净；**web 全量测试交 CI 门禁**（本机 4 核不具备全量条件，见 `docs/agent/delivery.md` §本地测试纪律）。
- U6：开关 `aria-label` 含「停用/启用」且不再暗示「自动触发」；卡片副标题区分启用/停用；`role=switch` + `aria-checked` + `setEnabled` 调用不变。
- U7：管理页三类卡片（内置 / 用户自定义 / 来自市场）非批量态可点开同一 `SkillDetailSheet`（`data-testid=skill-detail-sheet`）；只读、零 fetch、展示完整 desc；批量态点击仍为勾选，开关/卸载仍 `@click.stop`。
- U8：`agentInputPlaceholder(skill)` 返回值不含技能名、不含 `@`，等于 `补充描述…`；无技能时仍为 `AGENT_INPUT_PLACEHOLDER_AUTO`；`AgentSideRail` 优先级链不变。
- 变异：M-U1（选中态改回黑底）→ U1 RED；M-U2（sheet 换回自造容器）→ U2 RED；M-U4（开关改回 32×18）→ U4 RED；M-U6（开关文案改回裸「启用/停用」）→ U6 RED；M-U8（placeholder 恢复技能名）→ U8 RED。全 RED 且还原 hash 一致。
- 复核新增变异（§9 #7/#8/#9）：M-U3b（空态文案改回旧）→ U3 RED；M-U1c（displayName 改回一律派生）→ U1 RED；M-U1b（选中态换回翻转令牌 hi-bg）→ U1 RED。三条全 RED 且还原 hash 一致。

## 6. 管理页默认 tab 决策建议（用户要求以产品负责人给建议）

**建议：保持"我的技能"默认 + 内置只读分区置顶 + 空态文案重写。**

依据（一手资料 + 第一原则）：
1. **业界实践**：Claude Code `/plugins` 与 VS Code 扩展管理打开即「已安装置顶（带开关）+ 市场可用置底」的单一主视图——**"管理"入口的心智是"管我已有的"，不是"去逛"**。逛市场是另一条入口（发现页）。
2. **入口来源一致**：用户从 `+`→技能→管理进来，意图是"调整我选的技能"，落在 mine 符合来路；若落到 market（当前 catalog=0）反而扑空。
3. **吃满上游**：`dockSkills`（runtime 单一事实源）已把 11 内置技能同步到了管理页，置顶只读分区即解释了"我看到的技能从哪来"；这是既有数据面，不造数据。
4. **不掩盖真实现状**：mine=0 是用户没装自定义技能的真实状态，空态文案应说明现状 + 给下一步（§文案规范），而非假装市场有货。

**备选（若你偏好单视图）**：把 market 并入 mine 页面下方（仿 Claude Code），取消 tab——但当前 catalog=0，合并后下方仍空，收益要等市场铺货才显现，故本轮不做。

## 7. 诚实边界与部署

- 零 API 契约变化：开关语义不变只改文案；placeholder 只改展示文案不改选择/发送；详情壳只读且复用已加载数据，不新增 fetch/字段。所有 emit/data-testid 契约保持（回归测试锁定）。
- 已知未闭环：完整 SKILL.md 正文不可见（数据面缺），按 §8 P4 单列；`+` sheet 与 `/` 候选本刀不开详情入口。
- 改动 `apps/web` ⇒ 合并后走 web-only 部署（push 自动分流或补派 `deploy_web_only=true`）；生产 CDP 复测四场景 390px + 1440px，新增「点管理页卡片看详情」场景。
- 不写 `ALL_PASS`（延续 M1 收口纪律）。

## 8. P4 规格（完整技能详情正文 · 独立刀，本刀不实施）

> 用户 Q2 的完整诉求「像 WorkBuddy 那样看完整 SKILL.md」需要跨层补数据，单列为 P4。此节只锁口径，不是本刀交付物。

- **数据真源**：已装技能取 `skillPackage.body`（`skills.service.ts` 已有列，当前 detail 未返回）；内置技能取 pi-runtime `SkillIndexEntry.dir` 指向的 SKILL.md（`loader.ts` 已有字段），由上游读文件返回 `content`。Web 不解析 frontmatter、不拼第二份正文（第一原则）。
- **最小改动面**：① `GET /skills/:id` detail 回包加 `body`（仍按 userId 隔离，已装技能才可见）；② pi-runtime `listSkills()` / 或新增 `GET /skills/:name/body` 暴露内置正文；③ Nest `/skills/runtime` 薄转发新增字段；④ Web 详情壳加只读 Markdown 正文区 + 复制按钮（可选），`+` sheet / `/` 候选同步开详情入口。
- **门禁**：server 定向测试 + runtime `node --import tsx --test` + web 判据 + 令牌守卫 + 类型；部署需 server/runtime 重启（runtime-deploy.yml 手工 dispatch，`--set-string` env 三处同步若涉及），生产 CDP 复测详情正文逐字可见。
- **诚实边界**：未补数据前不得在 UI 上暗示「可查看完整正文」；本刀详情壳只展示已有元数据与完整 desc，明确不显示正文区占位骨架以免造数。

## 9. 自审补记（2026-11-18，本轮新增）

按第一原则与项目纪律对 §1–§8 对抗复审，查出并当场修掉四处：

| # | 问题 | 修正 |
|---|---|---|
| 1 | §5 U3 原写「工具单行排布」，与 §4.3/计划的「两行」自相矛盾 | U3 改为「两行内稳定：搜索+导入+批量同行，批量计数仅批量态第二行，不出现第三行」 |
| 2 | §5 U5 原写「web 全量测试绿」，与 `docs/agent/delivery.md` §本地测试纪律冲突（本机 4 核不具全量条件） | U5/计划门禁改为「本地定向 + 类型 + 令牌守卫；web 全量交 CI Build monorepo」 |
| 3 | 计划 T1.1 原按 `。/，//` 切首句，`短剧/漫剧配音与声音设计` 会被砍成 `短剧`（已抽查 `skills/` 真实 description 确认） | 改为只按 `。` 切（无 `。` 退换行），加 `短剧/漫剧` 单测用例 |
| 4 | §4.5 原写「管理页每张卡片」含混，可能被理解成 `技能市场` tab 的目录卡（数据形状不同、当前 catalog=0） | 收敛为「我的技能 tab 三类卡片」，目录卡明确不在本刀；新增嵌套 MobileSheet 的 z-index/body-lock 判据与 CDP 场景 |
| 5 | §4.2 原计划两端都换 `MobileSheet`，但 `.m-sheet{width:100%}` 在 1440px 会变整屏底栏，PC 锚定 popover 被回归 | 改为移动端 MobileSheet / PC 保留锚定 popover，共用纯内容 `SkillPickSheet`；F1 守卫同步改写 |

| 6 | §4.3 空态文案写"下方内置技能"，但内置分区在 DOM 中位于空态之上（`builtin-section` 在 `mine` 空态前），方位反了 | 去掉方位词，改为"内置技能由平台提供，导入或安装后可在此管理"；代码 + U3 判据 + 规格同步 |
| 7 | 落地核对发现 T3.1 空态文案**漏实现**（代码仍"还没有已安装技能"）——U3 原判据只锁工具栏/单列，未锁文案，导致门禁全绿但规格缺项 | U3 判据补锁新文案 + 禁旧文案；这是"测试全绿≠完整实现"的实证，纳入本次 T1–T7 复核 |
| 8 | **CDP 真机视觉对比**（本地改后 vs 生产旧版）暴露：`displayNameFromDesc` 一律从 desc 派生，把内置项 `product-visual`（准确短名"实物产品视觉出图"）覆盖成 24 字长描述，label 与 desc 显示几乎重复一整行 | 派生函数改为**label 优先**：label 含 CJK（可读名）直接用；仅 slug 从 desc 首句派生。`dockSkills` 中 AGENT_SKILLS 内置项有准确 label、runtime 动态项是 slug，两种来源各取所长；U1 单测补 product-visual 用例 |
| 9 | **CDP 截图**再暴露：选中项仍是黑底白字——`--lnk-hi-bg/hi-text` 是随主题翻转令牌（深主题=#17181d/#fff），design-tokens.css 明确标注"禁用于状态色"，U1 原判据只锁了"无 #1a1a21"没锁令牌选择，被翻转令牌绕过 | 选中态改用主题稳定的 `--lnk-accent-subtle` + `--lnk-accent-text`（MentionInput + SkillPickSheet 两处）；U1 判据补锁 accent 令牌 + 禁 hi-bg；§4.1/§5 同步。这是"令牌选错导致视觉未达标、静态判据只锁字面黑"的实证 |

自审后状态：规格与计划一致；三条澄清全有判据（U6/U7/U8）与变异（M-U6/M-U7/M-U8）；P4 跨层边界单列，不污染本刀部署面。T1–T7 复核经代码逐条核对 + CDP 视觉对比，发现并修复 #7/#8/#9 三处，修复后重新过门禁。

## 10. 实施记录（2026-11-18，待内容审核）

- 分支：`feat/skill-ui-ux-polish`（worktree）。因当前基线已有未提交的 M1 收口改动，分支从该基线开出承载全部未提交内容；推 PR 前须按最新 master 核触碰面并重建单 commit（禁在 master 直接提交）。
- 落地：T1–T7 全部完成。`/` 标签化卡片、`+` 移动端 MobileSheet / PC 锚定 popover、管理页两行工具栏 + 单列卡片、iOS 开关、开关语义文案、只读详情壳、composer 短占位。
- 门禁：定向 vitest（10 文件 174 测试，含 U1–U4/U6–U8 与受影响既有守卫）全绿；`design-token.test.ts` 99 绿；`vue-tsc -b apps/web/tsconfig.json` 干净；web 全量留 CI。
- 变异：M-U1/M-U2/M-U4/M-U6/M-U7/M-U8 逐个注入后判据均转红（exit≠0 且输出含 AssertionError / FAIL），每次还原后文件 sha256 与注入前一致。M-U7 首轮假绿（只断言正文文本、testid 改了仍绿）已补 testid 断言后重验转红——记录在案，防再犯。T1–T7 复核新增 M-U1b/M-U1c/M-U3b 三条同法验证全 RED + hash 还原一致。
- **CDP 真机视觉复核（2026-11-18，本地改后 5199 vs 生产旧版 8888，共用登录态）**：`/` 卡片、`+` 移动端 sheet、管理页详情壳、placeholder 收敛四场景逐项截图 + DOM rect 断言，暴露并修复 §9 #8/#9（显示名派生覆盖准确短名、翻转令牌致选中黑底）；修复后复测选中态=`rgba(91,76,230,0.12)` 淡紫底、`product-visual` 显示「实物产品视觉出图」、详情壳嵌套关闭后底层弹窗仍在。证据图 `e2e-cdp/shots/ui-polish-*.png`。
- 未做：未开 PR、未合并、未部署、未做生产 CDP；P4 完整正文仍待上游补数据。不写 `ALL_PASS`。
