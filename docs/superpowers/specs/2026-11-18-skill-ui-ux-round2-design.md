# 技能 UI/UX 二轮优化 · 设计规格

> 立项日期：2026-11-18。状态：**draft-review（待用户审）**。
> 事实基线：生产 master `02c0a956`（含一轮美化 #949–#951）。走查方式：CDP 无头浏览器真机仿真
> （移动端 390×844@3x 触摸仿真 / PC 1280×757），账号 cmrn3ghmt（已登录生产）。
> 证据截图：`.workbuddy/e2e-cdp/shots/r2-{mobile,pc}-*.png`；探针 `ux-r2-probe.mjs`（几何+手势逐项实测）。

## 0. 第一原则（最高约束）

**吃满上游、不重复造轮子**：本轮全部复用既有资产——`MobileSheet` 基座（把手/遮罩/safe-area/锁滚动/reduce-motion）、
`displayNameFromDesc`（中文显示名派生）、`SkillDiscoverPanel`/`SkillPickSheet`/`SkillDetailSheet` 组件本体。
**零新建组件、零新依赖**；全部改动是「约束修复 + 分支复用 + 数据接线」。

## 1. 走查实证（2026-11-18）

### 1.1 移动端 390×844（触摸仿真）

| # | 链路 | 实测几何/行为 | 判定 |
|---|---|---|---|
| P1 | `+` → 技能 sheet 滚动 | `.m-sheet-body` scrollHeight **725** / clientHeight **528**（可滚 197px）；内层 `.sheet-body`（SkillPickSheet）scrollHeight **668 == clientHeight 668**（无溢出的滚动容器）。**两次真实触摸滑动手势（手指上滑 320px/300px）后 m-sheet-body.scrollTop 恒 0**；touch-action:auto、双层均 `overscroll-behavior: contain` | ❌ **实锤**：触摸滑动死区，唯一滚动途径=拖右侧滑轨 |
| P2 | 技能 sheet → 管理技能 | 弹层 = 移动/PC 共用**居中 Modal**（card 359×675 圆角16 非底部弹层）；内置卡 grid 单轨 computed = **2011.78px**（首卡 w=2012，**横向溢出 5.2 倍屏宽**，文字横穿出屏）；卡名裸显英文 slug（drama-audio-design 等 7/11 个） | ❌ **实锤**：桌面 Modal + 网格爆宽双重缺陷 |
| P3 | 发现页 → 技能 → 技能中心 | MobileSheet 底部弹层（形态正确 390×287）；但**市场 tab=「暂无可用技能」**（生产 catalog `data:[]`）、**内置技能区不存在**（`MobileCanvasShell` 未传 `builtin-skills` prop）、我的=空态文案 ⇒ **整层无任何可点卡片**（死胡同）；唯一可达的卡详情弹层在「管理技能」Modal 内：SkillDetailSheet（MobileSheet 390×238）形态正确，但叠在桌面式 Modal 上双层错位，且详情文案含裸 slug | ❌ **实锤 + 新发现**：移动端技能中心是空壳，11 个内置技能在移动端不可见 |

### 1.2 PC 1280×757（对照基线）

| # | 链路 | 实测 | 判定 |
|---|---|---|---|
| B1 | `+` → 技能卡 | card **w=1772px（> 视口 1280）**，爆出屏幕右缘；纵向滚轮滚动正常（scrollTop 0→232=满程） | ❌ **新发现**：横向爆宽（一轮只验了纵向可见性，漏了宽度断言） |
| B2 | 管理技能弹层 | card 720×606 居中，内置 grid 两列 323px —— 桌面形态正确 | ✅ 基线 |
| B3 | 内置卡详情 | SkillDetailSheet 渲染为**全宽底部横条**（1280×214 MobileSheet 无 PC 适配）——桌面端形态可疑（待拍板） | ⚠️ 待拍板 |

## 2. 根因（4 项，全部有源码锚点）

| RC | 根因 | 锚点 |
|---|---|---|
| RC1 | `white-space: nowrap` + ellipsis 截断**无宽度约束链**（`.pick-desc` / `.manage-summary`）；移动端网格 override 用 `1fr`（=`minmax(auto,1fr)`，min 走 min-content=整行文本宽）⇒ 卡宽爆破 | `SkillPickSheet.vue:101`、`SkillDiscoverPanel.vue:502/495` |
| RC2 | **嵌套滚动容器死区**：内层 `.sheet-body` 是 `overflow-y:auto + overscroll-behavior:contain` 的滚动容器但无溢出 ⇒ 触摸手势被 contain 阻断链式传递，外层 `.m-sheet-body` 收不到 | `SkillPickSheet.vue:92` × `MobileSheet.vue:176-181` |
| RC3 | 管理技能弹层为双端共用居中 Modal（`w-[min(720px,92vw)]`），移动端无 MobileSheet 分支 | `AgentSideRail.vue:4442-4446` |
| RC4 | 移动端技能中心 `SkillDiscoverPanel` 未传 `builtin-skills` prop（PC 管理弹层有传）⇒ 双端信息不对称 | `MobileCanvasShell.vue:476` |

## 3. 二轮方案（R1–R9，分级）

### P0（阻塞操作，本轮必做）

**R1 · 卡宽爆破修复（双端，RC1）**
- `.pick-item` / `.pick-text` / `.pick-name` / `.pick-desc` 全链补 `min-width: 0`（flex 截断链）；`.skill-sheet-card` 加 `max-width: min(92vw, 560px)`。
- 移动端网格 override 改 `grid-template-columns: minmax(0, 1fr)`；`.manage-summary` 补 `min-width: 0` 约束链。
- 验收：CDP 断言 PC 卡宽 ≤ 560px、移动端卡宽 ≤ 390−24、`scrollWidth ≤ clientWidth`（双端零横向溢出）。

**R2 · 移动端滚动死区修复（RC2）**
- 单一滚动容器原则：内层 `.sheet-body` 在「宿主为 MobileSheet」时降级为纯内容流（去 `overflow-y:auto` + `overscroll-behavior`，由 `.m-sheet-body` 独担滚动）；PC 锚定卡分支保留内层滚动（其容器有界）。
- 实现：`.skill-pick-sheet` 根加 `in-mobile-sheet` 变体类（prop 或 `:host` 上下文判断，零新组件），CSS 变体覆盖。
- 验收：CDP 触摸滑动手势 dy=−320 后 `.m-sheet-body.scrollTop > 0`（原恒 0）；11 行全部可达 + 管理技能按钮进视口。

### P1（体验断层，本轮做）

**R3 · 管理技能弹层移动端底部弹层化（RC3）**
- 移动端复用 `MobileSheet`（title=管理技能，max-height 82vh）承载同一 `SkillDiscoverPanel`；PC 保留居中 Modal。判定复用 `isDesktopDock`，与 `+` sheet 同模式（零新组件）。
- 验收：移动端弹层贴底+把手+safe-area；卡宽断言通过；PC Modal 几何不变。

**R4 · 移动端技能中心接通内置区（RC4）**
- `MobileCanvasShell` 的 `SkillDiscoverPanel` 补传 `:builtin-skills`（与 AgentSideRail 同源 dockSkills 数据）；空市场态补「内置技能已列于下方 · 我的技能」引导文案。
- 验收：移动端技能中心可见「内置技能（11）」分区且整卡可点开详情；发现页链路不再死胡同。

### P2（文案与细节，本轮顺手做）

**R5 · 显示名统一（复用 `displayNameFromDesc`）**
- 管理卡 / 详情卡的 label 走同一中文显示名派生（label 含 CJK 直接用，slug 从 desc 首句派生），消灭裸英文 slug。
- 验收：grep 断言消费点全部过 `displayNameFromDesc`；CDP 抽样 3 卡均为中文短名。

**R6 · 详情弹层 PC 形态（待拍板项）**
- 现状 PC 内置详情=全宽底部横条。建议二选一：**（推荐）PC 居中窄卡**（max-w 480px 居中 Modal，同弹层家族）或维持底部横条。默认按推荐实现，用户可驳回。

**R7 · 移动端卡片信息密度与触控整备（P1）**、**R8 · 分组导航裁决（不嵌套 Tab，sticky 分组头）** 与 **R9 · 触碰组件冗余代码清理（范围红线见 §4.4）**：详见 §4.2 / §4.3 / §4.4。

## 4. 卡片尺寸 / 大小 / 布局审视（2026-11-18 二轮补充，用户追加评审项）

### 4.1 现状事实（源码级 + CDP 几何）

| 项 | 现状 | 评估 |
|---|---|---|
| 管理卡 padding/gap | `.manage-card` padding space-3(12px)、gap space-2；移动端单列满宽（内宽 ~318px） | ✅ 密度合理 |
| 卡名 | `.manage-name` flex:1 + min-width:0 + 2 行 line-clamp | ✅ 达标 |
| 内置卡 head | avatar + name + ⓘ(44×44✓) + 「内置」badge 同行——390px 下 4 元素挤一行，**name 被压到 ~180px** | ⚠️ badge 应移行 |
| 我的卡 summary | 状态+slug+版本+来源**四段元数据串单行 nowrap**（RC1）；即使 R1 修掉爆宽，仍会省略号吞掉版本/来源信息 | ❌ 移动端应改两行结构 |
| 回滚/卸载按钮 | `.act` padding space-1(4px) 纵向 ⇒ **按钮高 ~28-30px < 44px 触控目标（HIG 违规）** | ❌ 移动端必修 |
| 顶部 Tab | `.tab` 高 ~36px，略低于 44 | ⚠️ 顺手修 |
| 网格行高 | grid 默认 stretch 每行等高 | ✅ 无需处理 |

### 4.2 R7 · 移动端卡片信息密度与触控整备（P1，本轮新增）

- 内置卡「内置」badge 从 head 行移到 summary 行尾（390px head 只留 avatar+name+ⓘ 三元素，name 恢复 ~220px+）。
- 我的卡 summary 移动端改两行结构：第一行=状态（已启用/已停用），第二行=元数据（slug · 版本 · 来源），换行展示替代单行省略。
- `.act`（回滚/卸载）移动端 min-height 达 44px 触控目标；`.tab` 顶部导航同样补足。
- 验收：CDP 断言移动端 `.act` 高度 ≥44、内置卡 name 宽度 ≥200px、我的卡 summary 两行可见（无省略号吞元数据）。

### 4.3 R8 · 分组导航裁决：**不嵌套 Tab**（P2 落点，裁决记录）

**裁决：移动端管理页不引入二级 Tab / 分段控件。** 理由（iOS HIG + 产品判断）：

1. **嵌套导航反模式**：面板顶部已有一级 Tab（技能市场/我的技能），若在「我的」内再嵌 内置/自定义/市场 一层 Tab 或 segmented control，即两层导航叠加——HIG 明确反对嵌套 tab bar；切换成本 > 滚动成本。
2. **内容量级不支持**：当前内置 11 + 自定义少量，单列滚动总长度 ~1.5-2 屏，R2 修好滚动死区后「长度」不构成痛点；分组头已提供足够结构感。
3. **未来升级路径**（记录，不在本轮）：技能数 >30 时升级为**筛选 chips（全部/内置/自定义/市场）**——chips 是过滤语义（多区并显），不是切页导航，不破坏单列浏览流。

**本轮实际落点（轻量）**：移动端分组头 `sticky` 吸顶（滚过长列表时始终知道当前分区），配 `background: var(--lnk-surface-canvas)` 防透字。零新组件，纯 CSS。
- 验收：CDP 移动端滚动内置区→自定义区时分组头吸顶可见；PC 不受影响（sticky 仅移动分支生效或双端无副作用均可）。

### 4.4 R9 · 本轮触碰组件冗余代码清理（P2，本轮新增）

**范围**：仅限本轮触碰的 5 个文件——`SkillPickSheet.vue` / `SkillDiscoverPanel.vue` / `SkillDetailSheet.vue` / `AgentSideRail.vue`（技能 sheet 相关段） / `MobileCanvasShell.vue`（技能中心相关段）。**不做全仓清扫**（越界=风险面失控）。

**清理判据（逐条可证伪）**：
1. **死样式**：`<style>` 中声明但模板/子组件 0 引用的 class（逐一 grep 模板 + 渲染产物确认，非猜测）。
2. **死状态/死方法**：script 中未被模板引用且无副作用的 ref/function（vue-tsc noUnusedLocals + 人工核对）。
3. **一轮美化遗留**：#949–#951 改造后残留的旧类名/旧分支（如旧 sheet-close 测试锁的样式、被 MobileSheet 替代路径遗留的重复遮罩/把手样式）。
4. **重复声明**：同选择器重复定义、可合并的重复 token 引用。

**红线**：只删**可证明未使用**的代码；凡测试守卫（fs-scan/testid/断言）引用的类名与选择器一律保留；禁顺手重构结构（语义不变才删）。每删一处，删除前 grep 证据留痕进计划 §执行记录。

- 验收：清理后 `pnpm test:web` + `vue-tsc -b` 全绿（守卫零回退）；CDP 双端回归 §1 判据不回退；删除清单（文件+行+证据）记录在案。

## 5. iOS HIG 原则映射（评审视角）

| HIG 原则 | 本轮落点 |
|---|---|
| Bottom sheet 优先（移动端模态） | R3 管理技能 MobileSheet 化 |
| 单一手势语义 / 可预期滚动 | R2 单滚动容器 |
| 内容不可溢出安全区 / 尊重屏幕边界 | R1 卡宽上限 + minmax(0,1fr) |
| 文本截断用行数/省略号而非溢出画布 | R1 nowrap 约束链 |
| 44pt 触控目标 | R7 修复 `.act`(~30px)/`.tab`(~36px) 不足；既有达标项回归断言保留 |
| Reduce Motion / safe-area | MobileSheet 基座自带，复用即得 |

## 6. 改动面与部署边界

- 全部改动 ∈ `apps/web`（SkillPickSheet.vue / SkillDiscoverPanel.vue / AgentSideRail.vue / MobileCanvasShell.vue + 对应守卫测试）⇒ **web-only 部署**（deploy.yml push 自动分流，无需 runtime-deploy）。
- 零生产代码改动面（services/packages 不动）。

## 7. 诚实边界

- 生产技能市场目录当前为空（`/api/skills/catalog` = `[]`）：R4 修复「死胡同」，但市场有货与否是运营数据，不在本轮范围。
- 真实 iOS Safari 的橡皮筋/惯性细节无法在 CDP 仿真完全复刻；R2 验收以仿真手势 + 代码级根因消除为准，上线后需真机复核一次。
- 移动端 UA 仿真未改 navigator.userAgent（isMobileLayout 判定走视口宽度，已验证走移动分支）。
