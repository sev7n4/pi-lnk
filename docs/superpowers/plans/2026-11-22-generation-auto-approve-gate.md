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

### UI 迭代三（2026-11-23）：胶囊去描边 · 文案收敛为 `[auto]` · 移动端统一

**触发**：用户对 §11 上线的 PC 胶囊提三问（外框能否去掉 / 关闭态「自动生成」是否误导 / 移动端为何只有图标）。
**拍板（用户原话）**：「去掉【自动生成】，更干净。自动生成改成 [auto]。自动生成和每次先问，放在弹出的卡片上去说明即可。」
⇒ 一个拍板**同时消解三问**：胶囊不再带中文长文案 ⇒ 宽度大降 ⇒ 两端可真复用同一枚。

**取证（先量后改）**：
- **Q1 外框**：像素扫描证明截图里的紫框是**标注工具**画的（紫色 `(108,86,184)` 横贯整行，UI 无紫色元素）；但胶囊**本体确有 0.5px 琥珀描边**（x=678 连续竖带 `(66,60,26)`→`(86,77,33)`）⇒ 去的是它。
- **Q2 误导**：关闭态胶囊文字实测**纯灰 `(108,108,110)`**（`--lnk-text-muted`）⇒ 那是低对比度的**功能名**，读不出「现在是关的」；「用户确认」主语不清 ⇒ 改用 `[auto]` 标记 + 文案下沉。
- **Q3 移动端**：**生产页真实替换实验**（CDP，非估算）—— 430/390/360px 放得下 83px 与 100px 文字胶囊（裸条高恒 80px）；仅 320px 换行（80→112px），**模型 chip 截断让位后即不换行**（模型名 82→69px）。⇒ §11「四件套会散架」的判断被实测证伪。

**改动**：
| 文件 | 改动 |
|---|---|
| `AutoApproveControl.vue` | 胶囊文字「自动生成」→ **`[auto]`** 标记（`--lnk-font-mono` 11px 琥珀）；开启态**去 0.5px 琥珀描边**（保留柔底 + 琥珀字 + 实心盾）；**删移动端 icon-only 分支**，两端共用同一枚胶囊（移动端**不带箭头**）；关闭态**零文字** |
| `AutoApprovePanel.vue` | 说明段补「每次先问」括注 ⇒ 「自动生成 / 每次先问」状态对照在浮层卡片里成型 |
| `AgentSideRail.vue` | 移动裸条窄屏让位：模型 chip 链式 `min-width:0`（`params` / `dock-ghost-ctl` / `span` 三级） |
| 测试 | `AutoApproveControl.test.ts`（改写 7 例）、`AgentSideRail.autoApproveEntry.test.ts`（改 2 条 + 新增 3 条 §12 守卫） |

**验证**：定向 **35/35 PASS**；`vue-tsc -b` **0 错误**；`verify-agent-rail-gates` **11/11 PASS**；**变异 7 例全部转红**（M1 恢复描边 / M2 塞回中文长文案 / M3 关闭态也显示 `[auto]` / M4 恢复 icon-only 分支 / M5 丢掉「每次先问」/ M6 `[auto]` 改非 mono / M7 删窄屏让位规则体）。

**本轮踩到的三个坑（已入规格 §12.4 与守卫注释）**：
1. **变异只替换部分出现点 ⇒ 假绿**：M5「每次先问」在面板里出现 **2 处**，只改 1 处守卫不转红 ⇒ 改为**全量替换** + 守卫断言**出现次数**（`split(...).length - 1 === 2`）。
2. **守卫只查「消失」不够**：M4 删掉 `data-testid="auto-approve-trigger"` 后仍能分叉出**别的 testid** 的第二枚触发器 ⇒ 补**正向断言**（胶囊按钮与 testid 各**只出现 1 次**）。
3. **守卫只查选择器字符串会假绿**：M7 把选择器改名后原字符串仍是子串 ⇒ 断言改为落到**规则体**（`min-width: 0` 真的存在）。

**诚实边界**：① 纯前端改动（服务端判定/DB/偏好 API 零改动）⇒ §9.2 活体对照结论继续适用；② 移动端胶囊的**实机视觉**与 320px 截断效果需生产走查实证；③ 关闭态胶囊**零文字**后的可发现性依赖图形与箭头，未做真人可发现性测试；④ audio 介质仍未活体（沿用 §9.3）。

### 上线与生产复测（2026-11-23，UI 迭代三）

PR #983 → CI **3/3 绿**（`Build monorepo` + `Verify spec figures` + `Verify deploy auto-rollback guard`；web 全量 **557 文件 / 4626 用例全绿**，22min12s）→ squash 合并 master `aba000c2`。
**合并证据**：合并后 master 的 tree `69c3b6c6` == CI 验证 head 的 tree `69c3b6c6` ⇒ 合并树与 CI 验证树一致。
**部署**：push 命中 `apps/web/**` 触发条件 ⇒ deploy 自动触发，**success**。

**产物取证**（生产 chunk `CanvasPage-Cd21xSiS.js`）：`auto-approve-chip-auto` / `auto-approve-chip-caret` / `is-mobile` 均在；**`auto-approve-trigger` 出现 0 次**（旧 icon-only 触发器随本次发布消失）。

**主探针 28/28 PASS**（判据已按 §12 新形态改写，新增 P4e/P4f/P4g/P5d/M4b/P7c/P7d 七条）：

| 判据 | 实测值 |
|---|---|
| 开启态胶囊 | `text: "[auto]"`、`92×28`、`inDockActions: true` |
| **开启态描边** | `borderTopColor: rgba(0, 0, 0, 0)` ⇒ **无描边** |
| **胶囊中文文案** | `text: "[auto]"` ⇒ 长文案已清除 |
| **关闭态胶囊** | `text: ""`、`autoExists: false`、`bg: rgba(0,0,0,0)` ⇒ **零文字** |
| **移动端胶囊** | `isMobile: true`、`hasCaret: false`、`legacyTrigger: false`、`73×26` ⇒ **两端同一枚** |
| 浮层卡片 | 开启态「当前为自动生成：…」/ 关闭态「当前每次生成都会先问你（即「每次先问」）。…」 |
| 往返闭环 | `auto` → `manual` → `auto`，服务端回读一致 |
| 走查卫生 | 会话 `delete-status-200`；账号偏好收尾归零 `manual` |

**窄屏实测（四档全不换行）**：430/390/360/**320**px 裸条高**恒 48px**、胶囊**恒 73px**、`overflow: false`。
⇒ **比 §12.1 预测更好**：§12.1 用中文占位测出 320px 会换行，但 `[auto]` 把胶囊压到 73px（比 83px 占位更窄）⇒ **320px 也不换行**，模型 chip 无需截断即让位。
⚠️ 采样纪律：430px 首次采样 `barH: null` 是**页面未就绪**，重采后为 48px ⇒ 判读必须区分「采样时机」与「换行」。

**`AutoApproveGlyph` 关闭态配色的裁定（量化，规格 §12.6.3）**：用真实令牌本地渲染（headless Chrome + PIL 像素扫描）测得**单看盾牌，两态琥珀量几乎相同（0.98x / 0.95x）且色值完全一致**（`#fbbf24` / `#8a5200`）⇒ 图形**不承载状态色差异**，状态全靠「线框 vs 实心 + 柔底 + `[auto]`」；两态合计视觉重量差 **3.4~3.6 倍**。
⇒ **裁定：图形零改动**。理由：① 状态可辨性不依赖颜色（三重信号已足，琥珀是**能力语义色**不是状态色）；② 同一枚图形也用于提议卡**授权入口**，改色会让同一图形两处含义分叉（违 §3.4）；③ 提议卡入口依赖琥珀描边保可发现性（§10 已定）；④ 零新令牌 / 零新分支。
⚠️ 诚实代价：关闭态孤立琥珀线框盾牌**可能被读成警示**；若日后真机反馈误读，再定向改**只在 composer 关闭态**的中性色变体（不动提议卡），而非现在无据改共享组件。

**本轮新增的两个环境坑**：
1. **`git fetch` 不可用**（`RPC failed; curl 52 Empty reply from server`）⇒ 按纪律改走 REST：用 `gh api git/blobs → git/trees(base_tree=master 最新 tree) → git/commits(parents=[master 最新 commit]) → git/refs → pulls` **基于最新 master 重建单 commit**（本刀 master 已前进到 #982，触碰面与我的 7 个文件**零交集**）。
2. **headless Chrome 跨 Bash 调用被清理** ⇒ `ECONNREFUSED 127.0.0.1:9222`；必须**同一次调用内**起 Chrome + 跑探针。另：`Runtime.evaluate` 的表达式须包成 `(async () => { ... })()`（否则多语句 `return` 失效，`ev` 返回 undefined）；`fetch` 须带 `AbortController` 超时（否则页面未就绪时挂死）。

### UI 迭代四（2026-11-23 傍晚）：开启态去柔底 · `Auto` 文案 · 移动端仅输入态可见

**触发**：用户对 §12 上线的胶囊提两条新反馈 —— ①「`[auto]`，去掉 `[]`，仅保留 "Auto"（首字母大写），**Auto 背景边框仍未去掉**——需去除背景边框」；②「移动端 composer 三态下，我理解不需要三态都可见，盾牌图标及 auto 入口，**仅输入态可见入口即可**」。
**本轮拍板（三项确认）**：① 开启态**完全去掉柔底**，只留琥珀字 + 实心盾；② `Auto` **保持 mono 等宽**；③ 移动端**仅非 idle 态可见**（有输入行时）。

**取证（先量后改 —— §12 已去描边，用户仍说"没去掉"，必须先定位）**：
- **生产 CDP 盒模型实测**：chip `border=1px solid rgba(0,0,0,0)` ⇒ **描边已透明**；但 `background=rgba(138,82,0,0.1)` ⇒ **柔底仍在**。`[auto]` span 本身 `bg=transparent` / `border=0px` ⇒ **span 无背景无边框**。
- **用户截图像素扫描**（998×340）：`[auto]` 文字区底色 `(41,38,23)` 与胶囊外**完全相同**，x=720..730 才是更亮的 `(64,58,29)` 柔底块 ⇒ **柔底范围 = 整个胶囊内区**（放大图确认）。⚠️ 判读纪律：初看易误判成"文字自带背景框"，实为胶囊柔底 ⇒ 修在 chip 层，不动 span。
- **⇒ §12「柔底=状态语义，保留」的判断被用户明确推翻**：开启态改为既无描边也**无柔底**，差异全靠「实心盾 vs 线框盾」+「`Auto` vs 无字」。
- **移动端三态（读 `composer/mobileBarLayout.ts` 的 `barShape()` = idle/stacked/queued）**：`is-idle` 时裸条**只剩 `＋` + 提示语**（输入行 / 模型 chip / 发送键全 `display:none`），而 auto-approve 入口**无 `v-if`、CSS 也无 idle 隐藏** ⇒ **唯一还杵着的功能项** = 违和感根源。⇒ idle 隐藏规则追加 `.auto-approve-control`（限 `.agent-panel-mobile-dock` 作用域 ⇒ PC 不受影响）。

**改动**：
| 文件 | 改动 |
|---|---|
| `AutoApproveControl.vue` | 开启态 `background: var(--lnk-warning-bg)` → `transparent`（hover 回中性面）；`[auto]` → `Auto`（保持 mono）；注释更新至 §13 |
| `AgentSideRail.vue` | `.is-idle` 隐藏选择器列表追加 `.auto-approve-control`；order 注释订正；模板注释更新至 §13 |
| `AutoApproveControl.test.ts` | 开启态断言 `[auto]` → `Auto`（2 处） |
| `AgentSideRail.autoApproveEntry.test.ts` | ④ 改为「开启态既无描边也**无柔底**」（规则体 + hover 双断言）；§12-1 断言 `>Auto</span>` 且不得再出现 `[auto]`；新增 §13-1 移动端 idle 隐藏守卫 |

**验证**：定向 **24/24 PASS**；`vue-tsc -b` **0 错误**；`verify-agent-rail-gates` **11/11 PASS**；**变异 5 例全转红**（M1 恢复柔底 / M2 `Auto` 改回 `[auto]` / M3 删掉 idle 隐藏项 / M4 去掉移动端作用域前缀（PC 误挂）/ M5 关闭态也显示 `Auto`），还原后 21/21 全绿。

**本轮踩到的两个坑（新增）**：
1. **`rule()` 助手只截 `{...}` 规则体，选择器列表不在体内** ⇒ 断言「idle 规则里含 `.auto-approve-control`」在规则体上**永远失败**（首跑 1 failed）。正解：拆成两步 —— ① 断言**完整选择器列表字符串**（正向，防假绿）；② 断言规则体含 `display: none`。
2. **跨行正则会把自己也吃掉**：想验证「PC 侧未被误挂」的 `not.toMatch(/…[^{]*…/)` 把**移动端那条规则本身**也匹配上了 ⇒ 误报 failed。正解：改为**按行判定作用域前缀**（命中行 + 上一行都必须含 `.agent-panel-mobile-dock`）。
