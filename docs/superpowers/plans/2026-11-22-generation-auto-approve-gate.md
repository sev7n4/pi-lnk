# 授权自动生成卡片：实施计划（P1 判定源 + P2 UI）

> 规格：`docs/superpowers/specs/2026-11-22-generation-auto-approve-gate-design.md`（已拍板 2026-11-22）
> 日期：2026-11-22
> 依赖：master `0c167cfb`（#972 决策面收归对话页已落地）——本计划 P2 触点已按该规格 §3.3 改写，**不触碰画布确认面**。
> 分支：`feat/generation-auto-approve-gate-20261122`（基于最新 master 开 worktree，主工作区有他线未提交改动，零接触）
> 第一原则：吃满上游、不重复造轮子——唯一新增 = 1 个 DB 列 + 1 个纯判定函数 + 1 个小 composable；其余全接线。

## 拍板结论（规格 §8）

- 用户级授权作用域 = `image + audio`；**video 仅系统 `auto_all` 放行**；text 不纳入开关（tier 白名单维持现状 auto）。
- 用户偏好 `UserAiPreferences.autoApproveGenerations`：`manual`（默认）/ `auto`，账号级跨设备。
- 系统级 `GENERATION_APPROVAL_MODE`：`tiered`（默认，兼容现状）/ `full_manual` / `auto_all`；admin 可视化 P3 不搭车。

## 判定公式（服务端 SSOT，proposeGeneration 内）

```
auto = mode!=='full_manual'
     && ( mode==='auto_all'
          || tierWhitelist.includes(mediaType)          // env GENERATION_AUTO_APPROVE，缺省 'text'
          || (mode==='tiered' && pref==='auto' && mediaType∈{image,audio}) )
```
- env 白名单短路在前：text 缺省命中时**零 DB 读**（只有候选 user_auto 才读 prefs）。
- 硬门禁（missing_refs / B1 生成中守卫 / stagedActions）在判定之前/之外，任何模式 fail-closed。
- 客户端传入的任何 auto 参数一律忽略（沿袭 service:1489 纪律）。

## P1 后端（先红后绿）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `apps/server/prisma/schema.prisma` + `prisma/migrations/20261122120000_generation_auto_approve_prefs/migration.sql` | `UserAiPreferences` 加 `autoApproveGenerations String @default("manual")`（字符串避免 enum 迁移风险；ALTER TABLE ADD COLUMN ... DEFAULT 'manual' NOT NULL） |
| 2 | `apps/server/src/provider/provider.service.ts` | `PreferencesPublic`/`toPublicPreferences`/`UpdatePreferencesInput`/透传白名单循环 + 值校验（`manual|auto`，否则 BadRequest）；`ensurePreferences` 新建行走 schema 默认 |
| 3 | `apps/server/src/provider/provider.controller.ts` | `UpdatePreferencesDto` 加 `@IsOptional() @IsIn(['manual','auto'])`（⚠️ ValidationPipe 剥无装饰属性，必须写透传回归测试） |
| 4 | `apps/server/src/agent/agent-canvas-tools.service.ts` | ①`AccountGenPrefs`+`autoApproveGenerations`（HARDCODE 'manual'；`loadAccountGenPrefs` 映射 `row.autoApproveGenerations \|\| 'manual'`）；②`resolveAutoApprove(mediaType, userId)` 替换 `isAutoApproveMediaType`（env 短路→候选 user_auto 才读 prefs）；③propose auto 分支泛化：`epoch+1 落节点（不带 status）→ switch(node.type) 调 startText/Image/Video/AudioGeneration`（audio 透传 `input.params`，与手动确认通道「input.\* ?? node.data.audio\*」同语义）；返回 `autoApproved:true`（+`autoReason` 观测字段） |
| 5 | `apps/server/.env.example` | 补 `GENERATION_APPROVAL_MODE` / `GENERATION_AUTO_APPROVE` 注释条目 |
| 6 | `apps/web/src/services/provider-api.ts` | `ProviderPreferencesPublic` 加 `autoApproveGenerations: 'manual' \| 'auto'`（`UpdatePreferencesInput`=Partial 自动获得） |

### P1 测试锁（`agent-canvas-tools.approval-tier.test.ts` 扩写 + `provider.service.test.ts` / controller 透传回归）

既有用例按新契约改写 1 条：`GENERATION_AUTO_APPROVE=text,image` 下 image 现在**走 auto**（tier_whitelist，v1 保守注释失效）——行为判据移交新契约，不是放宽。

新增用例（锁规则本体，非仅接线）：
1. 默认 env + 默认 pref(manual)：text auto、image/video/audio 人工（**零回归基线**）。
2. pref=auto（mock prefsFindUnique 带 `autoApproveGenerations:'auto'`）：image → generating+autoApproved、audio → generating+autoApproved（params 透传到 startAudioGeneration）、**video 仍人工**。
3. `GENERATION_APPROVAL_MODE=full_manual` + pref=auto：text/image 全人工（系统强制覆盖用户）。
4. `GENERATION_APPROVAL_MODE=auto_all` + pref=manual：video 也 auto（系统级放开）。
5. `GENERATION_AUTO_APPROVE=''`（tiered）+ pref=auto：text 仍人工（白名单空=部署回滚，用户偏好不越权），image/audio auto。
6. missing_refs 短路在 auto 判定之前：image + sidebarImageCount>0 + localRefs=[] + pref=auto ⇒ `confirmed:false reason:missing_refs`（不被 auto 绕过）。
7. auto 后手动 start-image 携带同纪元 ⇒ 不 409（epoch 断言贯通，复用既有不变式）。
8. 重提 epoch 继续递增（image auto ×2 ⇒ epoch=2）。
9. provider：`updatePreferences({autoApproveGenerations:'auto'})` 落库并回读；非法值 400；DTO 无装饰属性被剥的透传回归。

## P2 前端 UI（先红后绿）

| # | 文件 | 改动 |
|---|---|---|
| 7 | `apps/web/src/composables/useAutoApproveGeneration.ts`（新，唯一新增 composable） | 薄接线：读 `useProviderBootstrap().preferences.autoApproveGenerations`；`setAutoApprove(v)` 走 `providerApi.updatePreferences` + `patchPreferences`（乐观写，失败回滚）；**不新建通道、不缓存 localStorage** |
| 8 | `apps/web/src/components/canvas/ProviderConfigDialog.vue` preferences Tab | PC 管理入口：开关行「授权自动生成」+ 说明文案（复用 ProfilePane switch CSS 模式 44×26，令牌 `--lnk-accent`/`--lnk-border-subtle`） |
| 9 | `apps/web/src/components/mobile/ProfilePane.vue` 设置二级卡 | 移动管理入口：触感反馈开关下方新增一行同款 switch |
| 10 | `apps/web/src/components/agent/AgentTurnTimeline.vue` proposal 卡操作区 | PC **唯一**场景内快捷项「授权后续自动生成」（与「落锚生成/调整/取消」同区，次级按钮，写偏好后提示「下次生效」，本次确认流程不变）。**不碰画布确认面**——#972 已删 `ProposeConfirmOverlay.vue`，静态守卫 `CanvasPage.decisionSurface.test.ts` 断言其不存在 |
| 11 | `apps/web/src/components/mobile/MobileNodeStatusBar.vue` | 移动场景内：与「去对话处理」同条加次级项（#972 已删「确认/拒绝」两钮，无并列冲突）；徽标并入既有 `hasTask` 判据——`auto && 无节点任务` 渲染「已授权自动生成 · 收回授权」，有任务时共存不抢决策按钮 |
| 12 | `apps/web/src/components/agent/AgentSideRail.vue` `.agent-system-layer` 层末 | PC 徽标「已授权自动生成」+「收回授权」按钮；新增白名单类 + system-layer 守卫测试更新（遵守 3923-3928 纪律）；**两端顶栏零改动** |

### P2 测试锁

- `useAutoApproveGeneration` 单测：读默认值 manual、写成功 patch、写失败回滚。
- `ProviderConfigDialog` / `ProfilePane`：开关渲染 + aria-checked + 点击调用 updatePreferences（mock api）。
- `AgentTurnTimeline` proposal 卡：快捷项存在、点击写偏好、本次仍 pending_confirm（三动作与页脚定位不受影响）。
- `MobileNodeStatusBar`：auto 无任务渲染徽标、有任务共存、与「去对话处理」同条、`MobileSaveStatus` 互斥不破坏（既有测试钉 `isMobileLayout:true` mock 纪律）。
- `AgentSideRail` system-layer 白名单守卫：新类进白名单，守卫测试同步。
- `design-token.test.ts` / `settings-domain-tokens.test.ts` 必跑（CI 棘轮按裸计数匹配含注释——**注释/文档串里禁止出现受看守 token 字面量**）。

## 执行链（本计划动刀顺序）

1. worktree：`git worktree add` 基于 gh api 确认的最新 master；node_modules 按铁律自建（主仓条目绝对软链 + `@lnkpi/{shared,agent}` 指 worktree packages）。
2. P1 红→绿→P2 红→绿；vitest=nvm node24 `--maxWorkers=1 --no-file-parallelism`；`vue-tsc -b`（勿加 --noEmit）；pnpm `env -u NODE_OPTIONS`。
3. gh api REST 推 PR（blob `-F content=@file`→tree(base_tree 只传改动路径)→commit→ref→PR）；推前 `compare base...master` 核触碰面。
4. 盯 CI 绿 → squash 合并（`-X PUT`）→ 部署：push 触发 deploy.yml（apps/server+apps/web 均在触发面）+ 环境审批 `POST pending_deployments` body `environment_ids:[23398119885]`；必要时手工 dispatch（web 补派必带 `deploy_web_only=true`）。
5. 生产取证：api 容器日志 `[approval_tier_bypassed]` + bootstrap  preferences 字段；DB 迁移生效（`docker cp` + sqlite3 mode=ro 只读验证列存在）。
6. CDP 复测：PC（先点 `.agent-fab`，防 rect 0×0 假绿）+ 移动（单会话 setDeviceMetricsOverride+reload，250ms 级采样）；判据=默认人工零回归 + 授权后 image/audio auto + video 仍人工 + 徽标/收回授权可见可用。

## 不做

不新建 Switch 组件、不新建设置页/路由、不新建前后端通道、不引 ConfigService、不改治理门/stagedActions/dedup/epoch 不变式、不动两端顶栏、video 不对用户级开放、admin UI 不搭车（P3）。

---

## 执行结果（2026-11-22 实跑）

### 链路

PR #974 → squash master `7a140a5f`；CI **4/4 绿**；部署 run `45042096920`：`Deploy web` success + `Build API` success（镜像 `lnkpi-api:7a140a5f…`，`/api/health` ok，API 侧 smoke 全过）。**pi-runtime 零改动零部署**。

### 实现与本计划的偏差（4 处，均为计划过时或收紧，非漏做）

| # | 计划原文 | 实际 | 原因 |
|---|---|---|---|
| 1 | migration `20261122120000_…` | `20261122130000_generation_auto_approve_prefs` | 与同批 migration 时间戳撞车顺延 |
| 2 | `row.autoApproveGenerations \|\| 'manual'` | `row.autoApproveGenerations === 'auto' ? 'auto' : 'manual'` | 收紧：脏值（如 `'true'`/`'AUTO'`）一律降级 manual，不因「非空即真」而越权放行 |
| 3 | `AgentSideRail` **新增白名单类** + 守卫测试 | **未新增白名单类**（白名单类仍为 0） | 规格 §3.4 修订后的口径：徽标随 `.agent-system-layer` 整体在画布视图隐藏（进层即默认安全），**不复活已退役的白名单类**（复活即新增一条需守卫测试的常驻面） |
| 4 | `MobileNodeStatusBar` 加「授权后续自动生成」快捷项 | 只做**徽标 + 收回授权**（与「去对话处理」同条容器内） | 移动端「去对话处理」进的是对话页时间线，那里才有 proposal 卡；状态带本身不在决策面，加快捷项无落点。授权入口由移动设置页承担 |

另：计划第 10 项「proposal 卡快捷项『授权后续自动生成』」**已实现并上线**（`AgentTurnTimeline.vue`，`data-test="authorize-auto"`）；其「本次仍需确认 / 下次生效」文案按规格写入。

### 复测结果

- **主探针** `.workbuddy/e2e-cdp/generation-auto-approve-probe.mjs` → **12/12 PASS**（PC 设置开关 + 服务端回读 + 对话侧徽标 + 收回授权 + 移动端往返）。
- **活体对照** `.workbuddy/e2e-cdp/autoapprove-p6-own-session.mjs` → **7/7 PASS**（双独立会话同题对照：未授权 ⇒ `pending_confirm` + 「落锚生成」+ 0 消耗；已授权 ⇒ 零待确认卡 + 「生成中（自动批准）」+ 12s 出图 + 实耗 33 积分）。
- 详见规格 §9（含**未覆盖边界**：audio 未活体、video/`auto_all`/env 三态未在生产实证、跨设备未二次复核、P3 不搭车）。

### 踩坑沉淀（已回写规格 §9.4）

默认会话属他人画布 ⇒ `agentReadOnly` ⇒ composer `disabled` 且 0×0（**必须自建自有会话**）；PC agent 面板默认折叠（**先点 `.agent-fab`**）；未授权轮阻塞等确认 ⇒ **对照必须用两个独立会话**；agent reasoning 里的「让用户确认」会让文本正则误判（**判据只认 DOM 事实**）；探针须**自带开跑归零**；服务端回读须带 `Authorization: Bearer`；本机 headless Chrome 跨 Bash 调用会被清理（**起 Chrome + 跑探针同一次调用**，先清 `Singleton*`）。

---

## UI 迭代执行结果（2026-11-23：从文字徽标到图标）

**触发**：用户投诉「composer 上方这么宽一个常驻卡片，对话页被污染」「『授权自动生成』这么长的一个按钮，卡片显得很脏」。诊断 = 用「文字块」承载了一个「开关状态」。

**方案与实现**（详见规格 §10）：

| 项 | 决定 |
|---|---|
| 落点 | composer **工具行**内单枚 15px 图标（模型选择右侧、发送键左侧）；**不进系统层容器**、**不进底部状态带**、**两端顶栏零改动** |
| 颜色 | 琥珀 `--lnk-warning`（双主题已存在 ⇒ **零新令牌**）；**不用红色**（iOS/macOS 语义里红 = 错误/破坏性，授权是用户自己的选择） |
| 图形 | 新增 `AutoApproveGlyph.vue`（盾牌+闪电，线框=未开启 / 实心=已开启）；**与提议卡同一枚图形**（跨位置可识别） |
| 提议卡 | 「授权后续自动生成」文字按钮 → icon-only，文案退到 `title`/`aria-label`；**已授权态不再 `disabled`**（禁用就收不回授权）⇒ 同一枚图标成为 toggle |
| 移动端 | 删掉底部状态带里的文字徽标 ⇒ 状态带回归「节点状态」单一职责；与 PC **共用同一 composer DOM**（裸条 `display:contents` 摊平）⇒ 一处改动两端生效 |
| 撤销 | 单击即激活/收回 + toast 带单动作「撤销」（不弹模态确认框） |

**改动文件**：`AutoApproveGlyph.vue`（新）、`AgentSideRail.vue`、`AgentTurnTimeline.vue`、`MobileNodeStatusBar.vue`、`useAutoApproveGeneration.ts`、`styles/main.css`；测试：`AutoApproveGlyph.test.ts`（新）、`AgentSideRail.autoApproveToggle.test.ts`（新）、`AgentTurnTimeline.authorizeAuto.test.ts`（改写）、`MobileNodeStatusBar.authorizeAuto.test.ts`（**翻转为守卫**）、`useAutoApproveGeneration.test.ts`（补 `undoable`）。

**本轮对 2026-11-22 偏差表的两处推翻**（原偏差 3、4 已不成立）：

| 原偏差 | 现状态 |
|---|---|
| 3. `AgentSideRail` 未新增白名单类（徽标随系统层在画布视图隐藏） | **整条推翻**：徽标不再进系统层容器 ⇒ 「画布视图隐藏」不再是约束，改为「画布视图也须可见」；白名单类仍为 0（结论不变，但理由变了） |
| 4. `MobileNodeStatusBar` 只做徽标 + 收回授权 | **整条推翻**：徽标与撤回**全部迁出**该条（授权不是节点状态；且该条空闲时不出现 ⇒ 撤回入口不可达） |

**验证**：定向测试 **27/27 PASS**（5 文件）；`vue-tsc -b` 0 错误；`pnpm verify-agent-rail-gates` 11/11 PASS；**变异验证 3 例全部转红**（默认态加背景块 / 提议卡回退长文字按钮 / 去掉 `v-if`）。

**守卫写法纪律（本刀踩到，已记入规格 §10.4）**：① 注释里禁止出现受看守的选择器字面量（`not.toContain` 会被同文件注释误伤）；② 源码契约辅助函数 `rule()` 必须**只在 `<style>` 段内**搜索，否则模板注释/插值会把 `indexOf` 带偏。

**诚实边界**：本次 UI 改造**尚未在生产真机走查**（规格 §9.2 的 12/12 + 7/7 是图标化之前的结论）；旧探针的两个 testid（`agent-auto-approve-line` / `agent-auto-approve-revoke`）已从源码移除 ⇒ 探针判据须同步改写为 `.auto-approve-toggle` 后重跑。

### 上线与生产复测（2026-11-23）

PR #978 → CI **4/4 绿**（web 全量 555 文件 / 4600 用例）→ squash 合并 master `1fa0a13e`（**合并树 `3690e6c0` == CI 验证 head 树**）→ 部署 run `45061972240`：`Deploy web` success、`Build API` **skipped**（web-only 分流正确——本刀纯前端，零 API/DB 改动）。

- **产物取证**：线上 114 chunk 全抓，`auto-approve-toggle` / `auto-approve-glyph` / 两处 aria 文案 **4/4 命中**。
- **主探针 14/14 PASS**（较 12 项新增 P4b「旧通栏徽标未复活」/ P4c「视觉体量 ≤32px」）。
- **提议卡图标生产实证**：提议卡 `pending_confirm`；授权按钮 44×44 / 图标 16px / **`text=''`（零文字）** / 线框态 / `aria` 完整 / 与「落锚生成」同行同构。
- **双主题**：浅色 `rgb(138,82,0)`、深色 `rgb(251,191,36)` ⇒ `--lnk-warning` 自适应，零新令牌。
- **探针本轮改造**：必须**自建自有会话**（`POST /api/sessions`）——旧默认 `SESSION_URL` 属他人画布 ⇒ `agentReadOnly` ⇒ input-dock 隐藏 ⇒ composer 工具行不渲染 ⇒ P4 假失败；走查结束删会话。

**剩余诚实边界**：audio 未活体（沿用 §9.3）；**活体对照 7/7 本轮未复跑**（P6 在独立脚本，逻辑未受前端改动影响）；走查账号 `defaultTextModel` 停用属**既存产品缺陷**（发不出消息且无修复路径），本刀不修、仅记录。

### UI 迭代二（2026-11-23）：composer 入口改版「状态胶囊 + 锚定浮层」

**触发**：用户给出 WorkBuddy 权限胶囊的实现截图，问「可以考虑参考这个实现？或是你有更加好的方案」。拍板：采用参考实现的交互骨架，否决其暗红开关与全局权限口径（规格 §11.2）。

**方案与实现**（详见规格 §11）：

| 项 | 决定 |
|---|---|
| 入口 | PC：composer 工具行**状态胶囊**（14px 图形 +「自动生成」+ 箭头，模型 chip 之后 / 发送键之前）；移动：**icon-only 触发器**（裸条三件套纪律） |
| 容器 | PC 锚定浮层（复用 `.neo-popover` + `useClickOutside`）；移动底部 Sheet（复用 `MobileSheet`）——沿用模型选择卡「PC popover / 移动 Sheet」规范 |
| 状态三通道 | 图形（线框/实心）+ 配色（弱化/琥珀高亮）+ 浮层文案；胶囊**常驻** ⇒ 关闭态也有开启入口（§10 的图标只在已授权时渲染 ⇒ 无入口） |
| 双向同处 | 说明 + `role=switch` 开关都在浮层里 ⇒ 开 / 收回同一点；开关即状态真身 |
| 作用域 | 浮层文案写清「图片与音频免确认；视频仍逐次确认」（照抄参考的全局口径 = 越权承诺） |
| 颜色 | 琥珀 `--lnk-warning`（三处开关 ON 色统一由 `--lnk-accent` 改为琥珀；旋钮 `--lnk-surface-canvas` 随主题保对比） |
| 单一来源 | 面板文案/开关抽 `AutoApprovePanel.vue`（PC 浮层与移动 Sheet 各渲染一次，禁复制）；触感开关样式提升到 `styles/main.css` 共享段（PC 设置弹窗 / 移动设置 / 新浮层三处同一实现） |
| 不动 | 服务端判定、DB 列、偏好 API、提议卡形态（§10 的 icon-only 入口保留 = 「当下这次」的上下文授权，与全局状态入口并存是有意保留） |

**改动文件**：`AutoApproveControl.vue`（新）、`AutoApprovePanel.vue`（新）、`AgentSideRail.vue`、`styles/main.css`、`ProviderConfigDialog.vue`、`ProfilePane.vue`；测试：`AutoApproveControl.test.ts`（新）、`AgentSideRail.autoApproveEntry.test.ts`（新，替代 `…autoApproveToggle.test.ts`）、`ProviderConfigDialog.authorizeAuto.test.ts`（改）。

**验证**：定向测试 20/20 PASS（3 文件）；`vue-tsc -b` 0 错误；`pnpm verify-agent-rail-gates` 11/11 PASS；**变异 4 例全部转红**（M1 胶囊失去琥珀 / M2 开关退化普通按钮 / M3 说明丢作用域 / M4 ON 色回 accent）。

**本刀踩到的两个坑（已入规格 §11.6）**：① 变异只替换 1/2 处文案 ⇒ 守卫假绿，必须**全量替换**再判；② `verify-agent-rail-gates` 的 G4 会解析 `AgentSideRail.*.test.ts` 里的 `join(here, …)` 目标，跨目录引用必须写成**单个字符串**（`'../../styles/main.css'`），写成多段 `'..', '..'` 会被判 missing ⇒ 11/11 直接挂。

**诚实边界**：纯前端改动（服务端零改动）⇒ §9.2 的活体对照结论继续适用；但**移动 Sheet 与 PC 浮层的实机视觉**、**开关 ON 色改琥珀的全站违和感**需生产走查实证。

### 上线与生产复测（2026-11-23，UI 迭代二）

PR #980 → CI **4/4 绿**（web 全量 **557 文件 / 4622 用例** + `vue-tsc` 0 错误）→ squash 合并 master `b3e6ea66`（合并树 `dcf60934` == CI 验证 head 树）→ 部署 run `45118473476`：`Deploy web` success、`Build API` skipped（web-only 分流正确）。

- **产物取证**：线上 119 chunk，`auto-approve-chip` / `auto-approve-popover` / `auto-approve-panel-switch` / `auto-approve-control` 各 1 处命中。
- **主探针 21/21 PASS**：PC 胶囊（`100×28`、图形 14px 实心/线框可辨、弱化态 `bg=rgba(0,0,0,0)`）→ 点开浮层（说明含作用域 + `role=switch 44×26`）→ 开关点一下收回（服务端 `manual`、胶囊同步退态）→ 再点开回（`auto`）⇒ **双向同处、往返闭环**；移动端裸条 icon-only 触发器（`24×24`、零文字）+ 底部 Sheet 同一份面板。
- **收尾**：账号偏好复位 `manual`，走查会话已删。

**探针本轮两处改造（沉淀）**：① 移动段判据必须**相对**（点一下翻转、再点翻回），绝对值断言会与前序段遗留状态耦合 ⇒ 假失败；② 走查收尾必须**归零偏好 + 删会话**，否则残留授权态污染下一轮「初始未授权」判据。
