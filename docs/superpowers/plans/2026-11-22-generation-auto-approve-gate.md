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
