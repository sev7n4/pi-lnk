# 授权自动生成卡片：用户级 / 系统级可配置授权开关设计（规格）

> 语义说明：用户可见概念统一为「**授权 / 收回授权**」；代码机制层（approval tiering、治理门）仍称「闸门」，指「是否等待人工确认」的技术裁决，与产品语义分离。

> 状态：**已上线（2026-11-22）**——PR #974 → master `7a140a5f`（CI 4/4 绿）→ 部署 run `45042096920`（web + API 均 success）；生产 CDP 复测结论见 §9  
> 计划：`docs/superpowers/plans/2026-11-22-generation-auto-approve-gate.md`  
> 日期：2026-11-22  
> 范围：`apps/web` 设置面、`apps/server` 审批分级、`services/pi-runtime` 确认等待  
> 上游规格：`2026-11-02-p1d-approval-tiering-design.md`（审批分级 P1-D）、`2026-10-06-selection-as-default-reference-design.md`（指代≠授权）



---

## 0. 结论先行（决策建议）

**可以做，而且几乎不需要造新东西**：项目里已经有一条完整、被测试锁死的「免确认自动生成」链路（P1-D 审批分级），只是判定源写死在部署级 env、且只对文本生效。要做的不是新建"开关系统"，而是**把判定源从单一 env 白名单升级为「系统总闸 + 用户偏好 + 介质风险」的合取判定，再把 auto 分支补齐到图片/视频/音频**，UI 挂到现有的设置页与移动端「我的」页。

| 决策点                        | 建议                                                                                                                                                                 | 理由                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 「闸门」到底是哪个门                 | 只授权**用户授权门**；提议单飞门、服务端治理门**不可关**                                                                                                                                   | 后两者是防重复提议与事务完整性护栏，关了会丢更新/死循环                                                       |
| 默认状态                       | **默认未授权（每次确认）**；作用域限定为 image/video/audio；text 保持现状免确认                                                                                                              | 现状 text 已默认 auto（零成本、用户预期即时），这样定义「默认未授权」与今天行为一致，零回归                                |
| 用户级开关存哪                    | **账号级：`UserAiPreferences` 加列**，走 `/provider/bootstrap` + `/provider/preferences`                                                                                   | 服务端已有「判定权在 SSOT、客户端不可传入 tier」纪律（service:1489）；localStorage 只能做 UI 记忆，不能当裁决源        |
| 系统级开关存哪                    | **env 总闸**（复用 `GENERATION_AUTO_APPROVE` 范式），admin 可视化列 P2                                                                                                          | 秒级止血、无需发版；项目无 ConfigService，env 是现成系统级通道                                           |
| 开关主入口                      | **确认卡上的「以后自动生成」快捷开关**为主，设置页为管理入口                                                                                                                                   | 用户在每次被打断的那一刻最有动机切换，设置页是被动入口                                                        |
| 授权后的代价                     | 必须同时提供「已授权徽标 + 一键收回授权 + 可撤销」                                                                                                                                       | 否则用户不知道自己授权了自动执行，会丧失信任；自动生成放大消耗，需接成本可见性                                            |
| **徽标/刹车放哪（2026-11-23 再修订）** | **不放在画布顶栏**，也**不放在 composer 正上方**：改为 composer **工具行内的单枚琥珀图标**（15px 盾牌+闪电，与提议卡同一枚图形）；移动端统一到同一图标，底部状态带里的文字徽标删除 | 2026-11-22 版把状态做成系统层通栏徽标（8 字 + 独立按钮），占 composer 正上方的黄金视觉位 ⇒ 用户投诉「对话页被污染」。iOS/macOS 极简口径：**状态属于对象**（agent 的行为模式 ⇒ 挂 composer），且**用图形不用文字块**。详见 §10 |

---

## 1. 第一原则：吃满上游、不重复造轮子

**声明**：任何新增判据 / 工具 / 数据字段 / 引擎，立项前必须过三判据——① 等价物检索；② 接线优先于新建，判据锚到既有结构化数据面；③ 禁造数 / 禁自报。本节逐项给出结论。

### 1.1 等价物检索结论表

| 候选等价物                                                                                            | 真实路径                                                                                                                                                        | 结论                   | 本方案如何接线                                                   |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------- |
| **P1-D 审批分级 + auto 短路全链路**                                                                       | `apps/server/src/agent/agent-canvas-tools.service.ts:4435-4443,1495-1517`；`services/pi-runtime/src/tools/canvas-write.ts:505-514`                           | ✅ 直接复用（核心）           | 不新建确认/免确认机制，只替换 `isAutoApproveMediaType` 的判定源、扩 auto 分支介质 |
| `GENERATION_AUTO_APPROVE` env 白名单                                                                | 同上 `:4436`（默认 `'text'`，置空=全人工）                                                                                                                              | ✅ 直接复用为系统总闸          | 保留语义，升级为三态/增加总闸开关                                         |
| `ASK_USER_BLOCKING` / `PI_RUNTIME_PLAN_GATE` / `PI_RUNTIME_PROPOSE_GATE`                         | `services/pi-runtime/src/runtime-config.ts:274,314,326`                                                                                                     | ✅ 复用为部署级 kill switch | 不改，作为最外层总闸兜底                                              |
| `UserAiPreferences` + `/provider/bootstrap` `/provider/preferences`                              | `apps/server/prisma/schema.prisma:164-188`；`provider.service.ts:280-298,515-593`；`web/src/services/provider-api.ts:120-121`                                 | ✅ 复用（需加列）            | 加 `autoApproveGenerations` 布尔列；前端 draft 三处同步；账号级跨设备       |
| `usePreferences`（localStorage 单例）                                                                | `apps/web/src/composables/usePreferences.ts:9-47`                                                                                                           | ⚠️ 仅做 UI 记忆          | 只缓存上次选择用于首屏渲染，裁决仍以服务端返回为准（禁客户端自声明 tier）                   |
| env kill switch 范式（默认 on/off）                                                                    | `apps/server/src/agent/agent.service.ts:2627-2667`                                                                                                          | ✅ 复用写法               | `!== 'off'` / `=== 'on'` 两种默认值范式照抄                        |
| `startTextGeneration` / `startImageGeneration` / `startVideoGeneration` / `startAudioGeneration` | `agent-canvas-tools.service.ts`（auto 分支当前只调 text）                                                                                                           | ✅ 复用已有执行函数           | auto 分支补介质分派，吃 P0-1 dedup + epoch 断言，零新增幂等键               |
| 手写 `role="switch"` + L2/L3 令牌                                                                    | `web/src/components/mobile/ProfilePane.vue:154-165,316-345`；`skills/SkillDiscoverPanel.vue:372-375,536-540`                                                 | ✅ 直接复用 CSS 模式        | 44×26 轨道，开=`--lnk-accent`、关=`--lnk-border-subtle`         |
| `ProfilePane` 设置二级卡 / `SettingsPage` / `ProviderConfigDialog`                                    | `web/src/components/mobile/ProfilePane.vue:127-173`；`web/src/pages/SettingsPage.vue:45-118`；`web/src/components/canvas/ProviderConfigDialog.vue:43,603-612` | ✅ 复用为入口              | PC 挂 Preferences Tab，移动挂设置二级卡，不新建设置容器                     |
| admin `el-switch` + `AdminAuditLog`                                                              | `web/src/pages/admin/AdminRoutesPage.vue:55-58`；`schema.prisma:701-714`                                                                                     | ✅ 复用（P2）             | 系统级可视化配置 + 审计，非首刀                                         |

**检索结论**：无需新建开关基础设施、无需新建确认卡、无需新建前后端通道、无需新建幂等键。**唯一新增是一个 DB 布尔列与一个纯判定函数。**

### 1.2 禁造数 / 禁自报约束

- 闸门状态**不得**由前端请求参数声明（`propose_generation` 入参不得带 `autoApprove`）——沿袭 service:1489 已有纪律「agent/客户端不可传入 tier」。
- 免确认结果必须有服务端客观证据：返回 `status==='generating' && autoApproved===true` 才短路（canvas-write.ts:510 双条件），不得用「提示词里写了自动生成」当证据。

---

## 2. 现状取证：闸门到底是什么

代码里是**三层正交机制**，不可混为一谈：

| 层        | 名字                                                 | 真实实现                                                                                                                                                                                                               | 关掉会怎样                      |
| -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| ① 用户授权门  | 前端确认卡 + runtime 阻塞等待                               | `web/src/components/canvas/ProposeConfirmOverlay.vue:94-99`（可见判据：时间线 `pending_confirm` ∥ 节点 status）；`pi-runtime/src/tools/canvas-write.ts:530-532`（`registry.waitForUser`，`answered`=确认、`aborted`=取消、`timeout`=超时） | **本方案要配置的就是这一层**           |
| ② 提议单飞门  | `propose-gate.ts` latch/pending/in-flight 三臂       | `services/pi-runtime/src/gate/propose-gate.ts:123-136`                                                                                                                                                             | 关掉会重复提议、生成风暴 —— **必须保留**   |
| ③ 服务端治理门 | 事务内读最新 + `applyCanvasActions` + `stagedActions` 退让 | `apps/server/src/sessions/canvas-op-write.ts:82-99`；`canvas-write-governance.test.ts:7-11`                                                                                                                         | 关掉会丢更新 —— **必须保留，与用户确认无关** |

**已有免确认能力（关键发现）**：

- `agent-canvas-tools.service.ts:4435-4443`：`GENERATION_AUTO_APPROVE` 默认 `'text'`，逗号分隔白名单，置空 = 全人工（部署级回滚开关）。
- `agent-canvas-tools.service.ts:1495-1517`：命中白名单 ⇒ 不落 `pending_confirm`，直调 `startTextGeneration`，返回 `autoApproved:true`。
- `canvas-write.ts:505-514`：tool 识别 `autoApproved && status==='generating'` ⇒ 不进阻塞等待，记 `onProposeOutcome('auto_approved', true)`。
- ⚠️ **v1 只实现 text**：注释 service:1490-1491 明说「env 配其他介质不生效（保守）」。所以「全介质免确认」需要补 start-* 分支，不是改个开关就行。
- ⚠️ 其他 kill switch：`ASK_USER_BLOCKING`（关=非阻塞 v1）、`PI_RUNTIME_PLAN_GATE`、`PI_RUNTIME_PROPOSE_GATE`，默认全开、部署级重启生效、无 UI、无用户粒度。
- ⚠️ `GENERATION_AUTO_APPROVE` 未写入 charts/.env.example，靠代码默认静默生效 —— 本方案应顺手补运维可见性。

**一句话**：免确认链路早已存在且被测试锁死，缺的是「谁能决定、在哪决定、用户能否自己决定」。

---

## 3. 产品方案

### 3.1 闸门作用域（先划边界）

「授权自动生成」在产品上必须拆成两句话，写进 UI 文案与文档：

- ✅ 授权后：**生成卡片不再等你点「确认生成」，由 agent 自动执行**。
- ❌ 授权后**不是**：agent 获得全局写授权——删除、覆盖、参数变更等其他写操作仍按原路径确认；也不绕过画布治理、参考图绑定校验、stagedActions、配额。

**授权只管「是否等待人」，不管「是否合法写入」，也不扩大写范围。**

> **语义拍板（2026-11-22）**：用户可见概念从「关闭确认闸门」改为「**授权 agent 自动化执行**」。理由：①正向委托框架（授权=赋予、可收回）优于负向放弃框架（关闸门=拆保护）；②与项目原生交互契约对齐——AGENTS.md 已定义「指代 ≠ 授权（写操作仍走确认门）」，「授权」是本仓库区分「指着说」与「允许做」的既有权词；③避免用户误以为所有写操作都免确认。技术字段 `autoApproveGenerations` 保留（避免无谓迁移），用户可见文案统一为「授权 / 收回授权」。

作用域限定：**图片 / 视频 / 音频卡片的生成确认**。文本卡片维持现状（零成本、即时预览、默认 auto），不纳入本开关——这样"默认未授权"与今天的产品行为逐字节一致。

### 3.2 三层优先级模型（核心公式）

```
autoApprove =
    systemGateAllowsAuto                    // 系统总闸：env / admin，默认允许
 && !systemForceManual                      // 系统强制人工（最高优先级，覆盖用户选择）
 && userPrefersAuto                         // 用户级：UserAiPreferences 账号级偏好
 && mediaTierPermits(mediaType)             // 风险分级：介质白名单 / 成本阈值
 && noHardBlock                             // missing_refs / stagedActions / 配额不足等硬门禁
```

**优先级语义**：

- 系统级 = **上限与总闸**：管理员可「强制全人工」（此时用户开关置灰，附原因文案）；也可设「默认自动」作为新用户初始值。
- 用户级 = **个人偏好**：在系统允许的范围内生效；用户随时可切回确认模式，无需管理员介入。
- 风险分级 = **不可越权的下限**（已拍板）：用户级授权作用域 = `image + audio`；**video 不对用户级开放**，仅系统 `auto_all` 放行；text 不纳入本开关（经 tier 白名单维持现状 auto）。
- 硬门禁 = **与闸门无关的独立门**：参考图未绑定（`missing_refs`）、stagedActions 在场、配额不足，任何模式下都 fail-closed。

### 3.3 状态机与默认值

| 层级    | 键                                                                                     | 默认     | 关闭/开启含义                            |
| ----- | ------------------------------------------------------------------------------------- | ------ | ---------------------------------- |
| 系统总闸  | `GENERATION_APPROVAL_MODE`（建议 `full_manual` / `tiered` / `auto_all`，默认 `tiered` 兼容现状） | tiered | full_manual=强制全人工；auto_all=允许全介质自动 |
| 系统白名单 | `GENERATION_AUTO_APPROVE`（保留，默认 `text`）                                               | text   | tiered 模式下逐介质放行                    |
| 用户偏好  | `UserAiPreferences.autoApproveGenerations`（枚举 `manual` / `auto`，默认 `manual`）        | manual | 未授权/已授权；已授权作用域 = image + audio                          |
| 会话临时  | 不落库，P2 可选                                                                             | —      | 「本次会话自动」便于试用                       |

**关键**：用户默认值 `manual` + 系统默认 `tiered(text auto)` ⇒ 新用户体验与今天完全一致，无需迁移、无行为回归。

### 3.4 授权模式的护栏（没有这些就不要上线）

1. **可见**：**在对话侧的 composer 工具行内**出现一枚 15px 琥珀图标（盾牌+闪电，实心态 = 已开启；未授权时**不渲染** ⇒ composer 逐像素不变）。**不放画布顶栏**，也**不放 composer 正上方**（理由见 §10）。
   - **PC 细节**：图标走 composer 工具行既有宿主（`.agent-dock-actions`，模型选择右侧、发送键左侧）；**不进系统层容器**（系统层 = 画布视图全隐的「进层即默认安全」区，而授权态是与输入行为直接相关的常驻状态，须在画布视图也可见）；**不新增白名单类**；24×24 无背景块，hover 才出琥珀柔底 ⇒ 默认态零色块。
   - **移动端**：与 PC **共用同一 composer DOM**（裸条 `display:contents` 摊平）⇒ 一处改动两端生效；**底部状态带不再承载授权态**（授权不是节点状态；且状态带只在「生成中/待确认」时出现 ⇒ 空闲时用户看不到也点不到撤回，而「随时能自己踩刹车」是硬要求）。
   - **同款图形贯穿两处**：提议卡内 = 开启入口（线框态）；composer 工具行 = 状态 + 刹车（实心态，点击即收回）。
2. **可收回**：点 composer 工具行那枚图标**单击即收回**（极简口径：不弹模态确认框），toast 带单动作「撤销」可一秒反悔；另在 composer 发送按钮复用既有「停止生成」语义（`DockGenerateButton`，AgentSideRail.vue:4584-4592）。
3. **可撤销**：自动生成的卡片保留 `autoApproved:true` 标记与 `proposalEpoch`，复用现有撤销/重提链路，不做新撤销系统。
4. **成本可见**：授权模式下的生成继续走现有 usage / cost 事件（`LaneSnapshotProjection.stats.usage`），设置项文案提示「授权后生成会直接消耗额度」。
5. **硬门禁不绕过**：`missing_refs` 短路行为完全保留（canvas-write.ts:480-504），stagedActions 在场一律 fail-closed。

---

## 4. 开关 UX 设计

### 4.1 开关本体（复用现有模式，零新建组件）

```vue
<button type="button" role="switch" :aria-checked="autoApprove"
        :aria-label="autoApprove ? '收回授权，恢复每次确认' : '授权自动生成，后续卡片不再逐次确认'"
        class="auto-approve-switch" @click="toggle">
  <span class="auto-approve-knob" />
</button>
```

CSS 直接复用 `ProfilePane.vue:316-345`：轨道 44×26、关=`--lnk-border-subtle`、开=`--lnk-accent`、旋钮=`--lnk-text-on-accent`，`--lnk-duration-fast` / `--lnk-ease-standard`。  
**令牌硬约束**：只用 L2/L3；开态优先 `--lnk-accent-subtle` + `--lnk-accent-text`；**禁用** `--lnk-hi-bg` / `--lnk-hi-text`（随主题翻转，禁用于选中态）。focus-visible 2px `border-focus` 外环 + 2px offset；移动端命中区 ≥44px。

### 4.2 五个触点（分工不同）

| 触点              | 位置                                                                                                                                                                     | 职责  | 为什么                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------ |
| **主入口（场景内·PC + 移动）** | 对话时间线 proposal 卡 `AgentTurnTimeline.vue` 操作区（「落锚生成 / 调整 / 取消」同区）追加一枚图标 | 转化 | **该组件是 PC 与移动共用的唯一宿主**（唯一引用方 `AgentSideRail` 同时服务 PC 侧栏与移动端 dock）⇒ 一处改动两端生效；PC 唯一场景入口（画布 `ProposeConfirmOverlay` 已于 #972 整体退场，见下「与 #972 的交叉」）。移动端**不再**在 `MobileNodeStatusBar` 另开一条（该条只留状态 + 跳转） |
| 管理入口（PC）        | `/settings` → 模型配置弹层 `ProviderConfigDialog` 的 `preferences` Tab                                                                                                        | 治理  | 已有偏好分区，无需新建设置页                                                                 |
| 管理入口（移动）        | `ProfilePane` → 「设置」二级卡，紧邻触感反馈开关                                                                                                                                       | 治理  | 已有开关范式与落点                                                                      |
| **状态/刹车（2026-11-23 修订）** | **PC + 移动共用**：composer 工具行内单枚图标（`AgentSideRail.vue` `.agent-dock-actions` 内，模型选择右侧、发送键左侧）；移动端裸条 `display:contents` 摊平 ⇒ 同一 DOM | 可见性 + 刹车 | 「状态属于对象」：agent 的行为模式挂在 composer 自身的工具行，紧邻发送键 = 「按下去会发生什么」的语义邻位。**不进系统层容器**（该容器在画布视图全隐，而授权态须在画布视图也可见）。详见 §10 |
| 系统入口（P2）        | admin 配置页 `el-switch` + `AdminAuditLog`                                                                                                                                | 运营  | 全局强制人工 / 灰度，需审计                                                                |

**为什么不放画布顶栏（2026-11-22 修订，基于代码取证）**：

1. **没有独立对话页**：`router/index.ts:11-26` 只有 `/workflow`（品牌页 `WorkflowPage.vue:121-130`）和 `/workflow/:sessionId`（`CanvasPage`）；画布与 `AgentSideRail` 同页并排，且侧栏被 `flex-row-reverse` 翻到**左侧**（`CanvasPage.vue:6224-6228`）。创作交互的物理中心一直在对话侧栏。
2. **移动端顶栏没有恒定宿主**：`MobileTopBar.vue:103-135` 随 `tab` 变形（chat=分享会话、canvas=适应画布），形态切换在**底部 TabBar**（`MobileTabBar.vue:21-26`），顶栏不固定属于对话或画布；`useAgentMobileLayout.ts` 只返回单布尔，真正三态在 `CanvasPage.vue:5976-6008`（`mobileCanvasView` / `mobileCanvasImm` / `mobileAppTab`）。
3. **纯画布满屏态连 composer 都隐藏**：`AgentSideRail.vue:4843-4848` 的 CSS 在 `is-canvas-view` 下隐藏 header/chat-wrap，`.is-canvas-imm` 再隐藏 input-dock——正如你判断的「移动端画布页更多是查看生成内容」，此时顶栏徽标只会是无人操作的死状态。
4. **历史裁决不允许**：`AgentSideRail.vue:3943-3947` 明确记录 2026-10-31 用户裁决「等待状态行整条退役，只保留 SSE 对话流，等待呈现由时间线内联 proposal 与画布确认面承载」。顶栏从未承载生成状态；新增顶部模式条等于开倒车。
5. **有现成更好的宿主**：PC `.agent-system-layer` 有硬约束「新增系统层卡片必须放进本容器」（`AgentSideRail.vue:3923-3928`，防三次漏登事故）；移动 `MobileNodeStatusBar` 已是「状态 + 多动作」同构胶囊（`bottom: calc(dock-h + tabbar-h + safe-area + 22px)`、`z-index:55`、44px 触控、`.is-primary` accent 三件套）。两处都零新建容器。


**与 #972「决策面收归对话页」的交叉（2026-11-22 master 已落地，本规格同步对齐）**：

`docs/superpowers/specs/2026-11-22-conversation-only-decision-surface-design.md` §3.3 已点名本规格并给出改写指令：

- PC 场景内入口**从 `ProposeConfirmOverlay` 改挂 `AgentTurnTimeline` proposal 卡操作区**（该 overlay 已于 #972 整文件删除，静态守卫 `CanvasPage.decisionSurface.test.ts` 断言其不存在）——本规格不得再触碰画布确认面。
- 移动场景内入口随 **共用组件 `AgentTurnTimeline`** 一并覆盖（该组件是 PC 与移动的唯一共同宿主）⇒ 不在 `MobileNodeStatusBar` 另开一条。
- 本规格的**状态落点在 2026-11-23 修订**（PC/移动统一到 composer 工具行图标，见 §10）；这是对 #972「决策面收归对话页」的顺延——决策面在对话页，状态面也回到对话页自己的 composer 侧。

|  |  |  |
| --- | --- | --- |
**承载面互斥规则（2026-11-23 修订：授权态已迁出状态带）**：移动底部状态带现有 `MobileSaveStatus` 与 `MobileNodeStatusBar` 互斥（`MobileCanvasShell.vue:357-375`，判据 `hasNodeTaskState = generatingCount > 0 || pendingNodes.length > 0`）。**授权态不再并入该条**——它不是「节点状态」，且该条只在有节点任务时出现（空闲时用户看不到授权态、也点不到撤回）。迁出后，原「徽标仅在状态带可见时出现，否则破坏 `MobileSaveStatus` 互斥」的妥协条件**一并消失**（状态带回归「节点状态」单一职责，互斥判据回到原样）。授权态的新落点见 §10.2。

### 4.3 文案（遵守 Design_system §4：动词开头、克制、第二人称、说出后果）

- 开关标题：**授权自动生成**
- 未授权说明：**未授权。每张卡片生成前都会先问你。**
- 已授权说明：**已授权。agent 生成卡片时不再等待确认，会直接消耗额度。可随时收回授权。**
- 提议卡快捷项：**授权后续自动生成** → 2026-11-23 起视觉上**不出现文字**（icon-only），文案退到 `title` / `aria-label`（可访问性不降级）
- 对话侧状态：**已授权自动生成** → 2026-11-23 起视觉上为**单枚琥珀图标**（无文字块），`aria-label` = 「已授权自动生成，点击收回授权」，点击即收回（toast 带「撤销」可反悔）
- 系统强制态（置灰）：**管理员已开启强制确认，当前无法授权自动生成。**
- 禁止用「确定 / 取消」；危险后果必须说出（「直接消耗额度」）。

---

## 5. 入口设计（贴现有代码落点）

- **PC**：头像菜单 → 设置（已存在，`AccountUserMenu.vue:41-45,133-141`）→ `SettingsPage.vue:101-118` 的「模型配置」行 → `ProviderConfigDialog` 的 `preferences` Tab 新增一行开关。不新增路由、不新增弹层。
- **移动**：`MobileCanvasShell.vue:377` 承载的 `ProfilePane.vue:127-173`「设置」二级卡，在触感反馈开关下方新增一行。遵循移动端编排归壳的规则，不新建 `*Mobile*` 组件。
- **场景内（PC 对话侧唯一入口）**：`AgentTurnTimeline.vue` proposal 卡操作区追加「以后自动生成」次级项（与「落锚生成 / 调整 / 取消」同区）；画布侧**不再有确认面**（#972 已删 `ProposeConfirmOverlay`）。点击即写服务端偏好，不阻断本次确认流程（本次仍需确认，下次生效）——避免"点了却还弹"的错觉，文案说清「下次生效」。
- **场景内（移动）**：无需单独落点——提议卡由共用组件 `AgentTurnTimeline` 渲染（PC/移动同一 DOM），图标自动覆盖两端。
- **状态/刹车（2026-11-23 修订）**：composer 工具行内单枚图标（PC/移动同一 DOM）；**不进系统层容器**、**不进底部状态带**、**不新增画布顶栏元素**（两端顶栏保持现状）。详见 §10。
- **系统级**：P0 用 env；P2 复用 `AdminRoutesPage.vue:55-58` 的 `el-switch` + audit 范式做可视化。

---

## 6. 架构方案

### 6.1 裁决点必须在服务端（最重要的架构判断）

**不能**只在前端隐藏确认卡：runtime 的 `registry.waitForUser` 仍在阻塞，30min timeout 后返回「未确认」，用户看到的是卡消失但生成没发生。

**必须**让 Nest 在 `/agent/internal/propose-generation` 时就判出 auto，返回 `status:'generating', autoApproved:true`，runtime 走既有短路（canvas-write.ts:510）。这条链路已经存在，零跨服务改动。

判定函数建议（纯函数 + 单测友好）：

```ts
private resolveAutoApprove(input: {
  userId: string; mediaType: string; nodeType: string;
  missingRefs: boolean; staged: boolean;
  prefs: { autoApproveGenerations: 'manual' | 'auto' };
  env = process.env,
}): { auto: boolean; reason: 'user_auto' | 'tier_whitelist' | 'system_off' | 'forced_manual' | 'hard_block' }
```

- 判定顺序：**硬门禁 → 系统强制人工 → 系统总闸 → 用户偏好 → 介质白名单**（fail-closed 优先）。
- `userId` 来自 runtime 内部调用的 `input.userId`（canvas-write.ts:472），沿用现有可信通道；**不新增客户端传参**。
- `reason` 用于日志与 `onProposeOutcome` 归因，保证观测分母不失真。

### 6.2 数据流（零新建通道）

```
用户切开关 → PUT /provider/preferences → UserAiPreferences 落库（账号级）
agent propose_generation → runtime POST /agent/internal/propose-generation (带 userId)
  → Nest resolveAutoApprove(查 UserAiPreferences + env + 硬门禁)
  → auto: 落 proposalEpoch + 直调 start-* → 返回 autoApproved:true
  → runtime 短路，不 waitForUser，记 auto_approved
  → 卡片 status=generating（用户看到已授权徽标 + 生成中）
  → 落库仍走 applier / 治理门（完全不变）
manual: → pending_confirm → SSE waiting_user → 确认卡 → /answers → 原链路
```

### 6.3 接线清单（逐文件）

| # | 文件 | 改动 | 刀次 |
|---|---|---|---|
| 1 | `apps/server/prisma/schema.prisma` | `UserAiPreferences` 加 `autoApproveGenerations String @default("manual")`（用字符串枚举避免 PG enum 迁移风险） | P1 |
| 2 | `apps/server/src/provider/*`（dto / service / controller） | bootstrap 暴露字段 + updatePreferences 白名单透传（⚠️ ValidationPipe 剥无装饰 DTO 属性，必须写透传回归） | P1 |
| 3 | `web/src/services/provider-api.ts` + `useProviderBootstrap.ts` | draft 字段 + patchPreferences | P1 |
| 4 | `agent-canvas-tools.service.ts` | `resolveAutoApprove` 纯函数替换 `isAutoApproveMediaType`；补 image/video/audio auto 分支（复用 start-*）；保留 missing_refs 短路与 epoch 不变式 | P1 |
| 5 | `services/pi-runtime/src/tools/canvas-write.ts` | **不改**——既有短路判据（`autoApproved===true && status==='generating'`）逐字节沿用，跨服务零改动（因此本刀无需部署 pi-runtime） | — |
| 6 | `AgentTurnTimeline.vue` | 对话时间线 proposal 卡授权图标（**PC + 移动共用组件**，一处改动两端生效）；写入偏好，本次确认流程不变（**不碰画布确认面——#972 已删 `ProposeConfirmOverlay`**） | P2 |
| 6b | `apps/web/src/composables/useAutoApproveGeneration.ts`（**本方案唯一新增前端文件**） | 薄接线：读 `useProviderBootstrap().preferences.autoApproveGenerations`；写走 `providerApi.updatePreferences`（部分字段 PUT）+ `patchPreferences`；**不新建通道、不缓存 localStorage** | P2 |
| 7 | `SettingsPage.vue` / `ProviderConfigDialog.vue` / `ProfilePane.vue` | PC/移动设置开关（管理入口） | P2 |
| 7b | `AgentSideRail.vue` composer 工具行（`.agent-dock-actions` 内） | 已授权图标 + 收回（单击即收回 + toast 撤销）；24×24 零背景块；**不进系统层容器**、**不建白名单类**；**顶栏零改动** | P2 |
| 7c | `MobileNodeStatusBar.vue` | **2026-11-23 修订：授权徽标迁出**（该条回归「节点状态」单一职责）；移动端状态与刹车由 7b 的共用 composer DOM 承担；**顶栏零改动** | P2 |
| 8 | `apps/server/.env.example`（env 由 Nest api 消费，真源 `/opt/lnkpi/.env`） | 补 `GENERATION_APPROVAL_MODE` / `GENERATION_AUTO_APPROVE` 可见性 | P1 |
| 9 | admin 配置页 + audit | 系统级可视化与强制人工 | P2 |

### 6.4 不可越权的不变量（写进测试）

1. 服务端治理门、stagedActions 退让、P0-1 dedup、proposalEpoch 重提语义：**任何模式下不变**。
2. `missing_refs` 硬门禁：auto 模式下仍 fail-closed（复用 canvas-write.ts:480-504 短路）。
3. 前端传入的 `autoApprove` 参数：服务端**一律忽略**（防自声明提权）。
4. auto 短路双条件：`status==='generating' && autoApproved===true` 缺一不可。
5. 默认行为回归：新用户 + 默认 env ⇒ text auto、image/video/audio 仍确认。

---

## 7. 分刀计划与测试锁

| 刀 | 内容 | 验收判据（TDD 先红后绿） |
|---|---|---|
| **P0 规格** | 本文件拍板（作用域、默认值、优先级公式） | 决策表逐项确认 |
| **P1 判定源升级（后端）** | `resolveAutoApprove` + UserAiPreferences 列 + provider 通道 + image/video/audio auto 分支 | `approval-tier.test.ts` 新增：user_auto 全介质生成、system forced_manual 覆盖、missing_refs 不被绕过、客户端参数被忽略、默认行为不变；变异守卫锁**规则本体**而非仅接线 |
| **P2 UI 与入口** | 对话时间线 proposal 卡授权图标（PC+移动共用）+ PC/移动设置开关 + composer 工具行状态图标与刹车（**顶栏零改动**） | `AgentTurnTimeline.authorizeAuto.test.ts` / `AgentSideRail.autoApproveToggle.test.ts` 落点守卫 / `MobileNodeStatusBar.authorizeAuto.test.ts` 迁出守卫 / `AutoApproveGlyph.test.ts` / `design-token.test.ts` / `settings-domain-tokens.test.ts` |
| **P3 系统级可视化** | admin el-switch + audit + env 可见性 | admin 页开关与审计日志回归 |

**纪律**：遵循仓库分支纪律（先开分支）、vitest nvm node24 + `--maxWorkers=1 --no-file-parallelism`、`vue-tsc -b` 不加 `--noEmit`；改令牌必跑 `design-token.test.ts`；合并后按 prod 复测纪律做 web/runtime 部署与生产走查（CDP PC 先点 `.agent-fab`、移动用单会话触摸仿真）。

---

## 8. 诚实边界与拍板结论

1. **已拍板（2026-11-22，产品负责人裁决，用户授权全链推进）**：
   - ① **text 排除在本开关外**：维持现状默认 auto（经 tier 白名单），零回归；用户级授权只作用于 image/audio。
   - ② **video 不放给用户级**：用户级授权作用域 = `image + audio`；video 仅系统 `auto_all` 模式放行（成本放大，运营决策而非个人偏好）。
   - ③ **系统级 P0 用 env 三态** `GENERATION_APPROVAL_MODE`（`full_manual` / `tiered` 默认 / `auto_all`）；admin 可视化 + 审计留 P3，本轮不搭车。
2. **未实现**：`thinkingByModel` 仍只在设计文档（本次不搭车）；`ModelConfigPanel` 组件名在源码不存在，实际是 `ProviderConfigDialog`。
3. **风险**：auto 分支补 image/video/audio 会放大成本消耗，必须与配额/成本护栏同刀上线；`UserAiPreferences` 加列需 DB 迁移 + DTO/Public 类型/前端 draft 三处同步，漏一处即静默丢字段。
4. **不做**：不新建 Switch 组件、不新建设置页、不新建前后端通道、不引入 ConfigService、不改服务端治理门、**不在画布顶栏加任何状态元素**（两端顶栏保持现状）。

> 本规格不写 ALL_PASS。闭环判据以上线后生产复测为准。

---

## 9. 上线与生产复测结论（2026-11-22）

### 9.1 链路状态

| 环节 | 证据 |
|---|---|
| PR / 合并 | #974 → master `7a140a5f`（squash），CI **4/4 绿**（spec figures / rollback guard / monorepo build / API image） |
| 部署 | run `45042096920`：`Deploy web` success、`Build API` success（镜像 `lnkpi-api:7a140a5f…`，`/api/health` ok）；pi-runtime **零改动零部署**（既有短路判据逐字节沿用） |
| web 产物 | 线上 chunk 命中 `useAutoApproveGeneration-*.js`、`ProviderConfigDialog.*`、`AgentTurnTimeline.*`（含「授权自动生成」文案） |
| DB 迁移 | `UserAiPreferences.autoApproveGenerations` 列由 `prisma migrate deploy` 落库——**间接强证据**：bootstrap 能回读 `auto`/`manual`（Prisma schema 缺列会直接 500）；SSH 不可用，未做 sqlite 只读直查 |

### 9.2 CDP 生产走查（探针 `.workbuddy/e2e-cdp/`）

- **主探针 `generation-auto-approve-probe.mjs`：12/12 PASS**——PC 偏好 Tab 开关（`role=switch`、44×26、初始 `aria-checked=false`）、授权后 `aria-checked=true` 且 **服务端 bootstrap 回读 `auto`**、对话侧系统层徽标（`.agent-system-layer` 内，491×54，非 0×0 假绿）+「收回授权」、收回后回读 `manual` 且徽标消失；移动端「我的→设置」开关 + 授权/收回往返。> ⚠️ 该结论基于**图标化之前**的 UI（通栏文字徽标 + 长文字按钮）；2026-11-23 图标化后旧 testid 已移除，须重跑探针（见 §10.5）。
- **活体对照 `autoapprove-p6-own-session.mjs`：7/7 PASS**——两个**独立自有会话**同题对照：
  - 未授权：agent「设置生成参数…**提交给用户确认**」⇒ 提议卡 `pending_confirm` + 「落锚生成」按钮，**0 积分消耗**；
  - 已授权：agent「已创建节点并**启动生成**…状态：生成中（**自动批准**）」⇒ **零待确认卡**，`已生成 1 张 · 12s · 已结算实耗 33 积分`，画布实出图。

⇒ **核心命题「授权后 agent 自动生成、不再逐次确认」已在生产活体验证**；未授权零回归同时成立。

### 9.3 诚实边界（本刀未覆盖，不得当已验）

1. **audio 介质未活体跑**：有单测锁（image/audio 同分支 + `startAudioGeneration` 参数透传），但生产只实跑了 image。
2. **video 未活体验证**：设计上不对用户级开放；系统级 `auto_all` 路径有单测，生产 env 未设 `GENERATION_APPROVAL_MODE` ⇒ 走缺省 `tiered`，`auto_all` 未经生产实证。
3. **系统级 env 三态未在生产实操**（`full_manual` / `auto_all` / 白名单置空）——生产为缺省 `tiered`。
4. **跨设备同步未实证**：账号级偏好在单一浏览器 profile 内验证；「换设备同账号生效」依赖账号级存储语义，未做第二端复核。
5. **P3 admin 可视化按计划不做**（不搭车）。
6. **未验「授权本次仍需确认」提示语**：proposal 卡「授权后续自动生成」按钮已上线，但其「本次仍需确认 / 下次生效」文案只在未授权→点授权那一瞬出现，未被专门断言。

### 9.4 走查踩坑（沉淀给后续 CDP 探针）

- **默认会话属他人画布 ⇒ `agentReadOnly=true` ⇒ composer `disabled` 且 `rect 0×0`**：活体验证必须**自建自有会话**（`POST /api/sessions`）。
- **PC 端 agent 面板默认折叠**（`.agent-panel-shell` `display:none`）：发消息前必须点 `.agent-fab` 展开，否则 textarea 0×0、`Input.insertText` 静默失败（`len=0`）。
- **未授权轮会阻塞等确认**（runtime `waitForUser`）⇒ 同会话的第二条消息只会排队；授权/未授权对照**必须用两个独立会话**。
- **文本正则不能当判据**：agent 的 reasoning 摘要里会出现「…让用户确认…」，会被误判成确认请求；判据只认 DOM 事实（`[data-test="confirm"]` 计数、proposal 卡 `state-*`）与产出信号。
- **探针必须自带开跑归零**：上一轮若中途挂死，偏好会残留 `auto`，把下一轮「初始未授权」判据全部假失败。
- 服务端回读必须带 `Authorization: Bearer <localStorage.token>`（裸 `fetch` 会 401 ⇒ 假失败）。
- 本机 Chrome headless 实例**跨 Bash 调用会被环境清理**（`chrome-profile` 残留 `SingletonLock` 亦会阻止重启）⇒ 起 Chrome + 跑探针放同一次调用，并先清 `Singleton*`。

---

## 10. UI 迭代（2026-11-23）：从「文字徽标」到「图标」

### 10.1 问题诊断（用户投诉原文）

> 「当被授权自动生成后，在composer 上方这么宽一个常驻卡片，感觉对话页 composer 上面不干净，被污染的感觉。非常糟糕的设计。」
> 「针对提议生成卡片，【授权自动生成】，有没有考虑做成警示或强调类的图标设计？……而不是一个【授权自动生成】这么长的一个按钮。很丑，卡片显得很脏，内容太多。」

**病根**：用「文字块」承载了一个「开关状态」。

| 载体                                | 信息量        | 实际视觉重量                                                                    | 失衡点                                                                                          |
| --------------------------------- | ------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 系统层通栏徽标（8 字 + 独立按钮） | 「已开启，可关」 | 占 composer 正上方的**黄金视觉位**，且是页面唯一高饱和色块                        | 视觉重量 ≫ 信息量 ⇒ 对话页被「污染」                                                          |
| 提议卡里的「授权后续自动生成」按钮 | 一个开关动作    | 8 个字，把卡片撑宽、把次级动作的最大视觉面积占掉                                  | 同排「参数微调」「取消」都是 icon-btn，**只有它**是文字按钮 ⇒ 形状不统一，卡片显得脏          |

### 10.2 落点决策（iOS / macOS 极简口径）

1. **状态属于对象** ⇒ 挂在 **composer 工具行**（`.agent-dock-actions`，模型选择右侧、发送键左侧），不挂画布顶栏、不占 composer 正上方。
   - 红利：PC 与移动**共用同一 composer DOM**（移动端裸条 `display:contents` 摊平）⇒ 一处改动两端生效。
   - 移动端顺带删掉底部状态带里的文字徽标——授权状态不是「节点状态」，放节点状态带本就错位；且状态带只在「生成中/待确认」时出现，空闲时用户看不到也点不到撤回（而「随时能自己踩刹车」是硬要求）。
2. **颜色：琥珀 `--lnk-warning`，不用红色**。红色在 iOS/macOS 语义里 = 错误 / 破坏性，而「已授权」是用户自己的主动选择；琥珀才是「注意，agent 正在替你行动」。红色留给「收回」这个动作本身。`--lnk-warning` / `--lnk-warning-bg` / `--lnk-warning-border` **双主题已存在 ⇒ 零新令牌**。
3. **一套图形贯穿两处**：新增 `AutoApproveGlyph.vue`（盾牌 = 权限护栏 + 闪电 = 自动执行）。
   - 提议卡里 = 开启入口（线框态）；composer 工具行里 = 状态 + 刹车（实心态，点击即收回）。
   - 形状避让：闪电已被积分 chip 占用（`data-test="credit-chip"`）、推子已被参数微调占用。
   - 未开启也用琥珀描边 ⇒ 入口自带警示色动作的可发现性，不会被中性灰淹没。
4. **提议卡动作行形状纪律**：同排次级动作**一律 icon-only**；文案退到 `title` / `aria-label`（可访问性不降级，视觉零文字占位）。
5. **极简撤销**：单击即激活/收回 + toast 带单动作「撤销」（不弹模态确认框）——误点 3 秒内可反悔。

### 10.3 改动清单（逐文件）

| 文件                                                                                                     | 改动                                                                                          |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/web/src/components/agent/AutoApproveGlyph.vue`                                                      | **新增**：盾牌 + 闪电两段 path；`on` 控制线框/实心；纯展示、不持状态、不发事件            |
| `apps/web/src/components/agent/AgentSideRail.vue`                                                        | 删系统层通栏徽标（模板 + CSS + 依赖）；composer 工具行内新增单枚图标按钮（24×24、零背景块）  |
| `apps/web/src/components/agent/AgentTurnTimeline.vue`                                                    | 「授权后续自动生成」文字按钮 → 同一枚图标；已授权态不再 `disabled`（禁用就收不回授权）      |
| `apps/web/src/components/mobile/MobileNodeStatusBar.vue`                                                 | 删授权徽标（模板 + CSS + composable 依赖）⇒ 状态带回归「节点状态」单一职责                 |
| `apps/web/src/composables/useAutoApproveGeneration.ts`                                                  | `setAuthorized` 增加 `undoable` 选项（toast 内单动作「撤销」，反向写回服务端）              |
| `apps/web/src/styles/main.css`                                                                           | toast 内「撤销」按钮样式（`ElMessage` 内容节点在 body 下 ⇒ 不能 scoped，故放全局）          |
| `apps/web/src/components/agent/AutoApproveGlyph.test.ts`（新）                                           | 图标契约：形状 / 两态 / 令牌                                                               |
| `apps/web/src/components/agent/AgentSideRail.autoApproveToggle.test.ts`（新）                             | **落点守卫**：通栏徽标不得复活、图标契约、提议卡与 composer 同一枚图形                       |
| `apps/web/src/components/agent/AgentTurnTimeline.authorizeAuto.test.ts`（改写）                           | 图标化契约：icon-only、无长文字、已授权态可点（三动作不受影响）                              |
| `apps/web/src/components/mobile/MobileNodeStatusBar.authorizeAuto.test.ts`（改写为守卫）                  | 从「断言徽标存在」翻转为「断言徽标不存在」——防日后把通栏文字徽标塞回状态带                 |

### 10.4 守卫与变异验证

- 变异 1：图标默认态加背景块（= 用户投诉的污染回退）⇒ 守卫转红 ✅
- 变异 2：提议卡回退成长文字按钮（`icon-btn` → `btn-secondary`）⇒ 守卫转红 ✅
- 变异 3：去掉 `v-if="autoApproveAuthorized"`（未授权也常驻）⇒ 守卫转红 ✅
- `vue-tsc -b` 0 错误；`pnpm verify-agent-rail-gates` 11/11 PASS。

> ⚠️ 守卫写法纪律（本刀踩到）：**注释里禁止出现受看守的选择器字面量**——`not.toContain('agent-auto-approve-line')` 会被同文件注释里的同名类名误伤；`rule()` 辅助函数必须**只在 `<style>` 段内**搜索，否则模板注释/插值会把 `indexOf` 带偏（曾把 `{{ ... }}` 当成规则体）。

### 10.5 诚实边界

- 本次迭代**已在生产复测通过**（2026-11-23，master `1fa0a13e`）—— 见 §10.6。（§9.2 的 12/12 + 7/7 是**图标化之前**的结论，走的是旧通栏徽标与长文字按钮。）
- ✅ **探针判据已同步改写**（本地 `.workbuddy/e2e-cdp/generation-auto-approve-probe.mjs` 的 P4/P5 段）：旧 testid `agent-auto-approve-line` / `agent-auto-approve-revoke` 已从源码移除 ⇒ 改为断言 `.auto-approve-toggle`（在 `.agent-dock-actions` 内 / 有图形 / `is-on` / 尺寸 ≤32px / **旧徽标不得复活** / 点击即收回）。⇒ 上线后重跑该探针即可判定图标化未回归。
- ✅ **本地真机效果已实证**（本地生产构建 + 生产 API 代理，未合并代码）：PC 工具行 24×24 / 图标 15×15 / 背景 `rgba(0,0,0,0)` / 琥珀 `rgb(138,82,0)` / `is-on=true`；移动端裸条同款且 `legacyBar=false`；提议卡触控区 44×44 / 图标 16px / **`text=''`（零文字）** / `on=false`（线框）；两端 `legacy=false`。
- ⚠️ **生产复测时的环境前置（本刀踩到）**：① `apps/web/vite.config.js` 是被 git 跟踪的 tsc 编译产物且 vite 优先加载它；② `vite dev` 依赖增量优化会删 `node_modules/.vite/deps_temp_*` ⇒ 与沙箱批量删除守卫冲突（阈值 50）⇒ 改用 `vite build` + `vite preview`；③ 走查账号默认模型若已停用 ⇒ `sendMessage` 早退「当前规划模型已停用」⇒ **完全发不出消息**，须先切到可选模型。


### 10.6 生产复测结论（2026-11-23，master `1fa0a13e`）

**链路**：PR #978 → CI **4/4 绿**（含 web 全量 555 文件 / 4600 用例）→ squash 合并 `1fa0a13e`（**合并树 `3690e6c0` == CI 验证 head 树**）→ 部署 run `45061972240`：`Deploy web` success、`Build API` **skipped**（web-only 分流正确，本刀纯前端）。

**产物取证**：递归抓取线上 114 个 chunk，4 个标记全命中——`auto-approve-toggle`（CanvasPage chunk）、`auto-approve-glyph`（AgentTurnTimeline chunk）、两处 aria 文案。

**主探针 `.workbuddy/e2e-cdp/generation-auto-approve-probe.mjs` → 14/14 PASS**（较 2026-11-22 的 12 项新增 P4b/P4c）：

| 判据 | 实测 |
|---|---|
| P4 composer 工具行图标 | `w=24 h=24`、glyph `15×15`、`glyphOn=true`、**`text=''`（零文字）**、`inDockActions=true`、`aria="已授权自动生成，点击收回授权"` |
| P4b 旧通栏徽标未复活 | `legacyBanner=false`（对话页零污染） |
| P4c 视觉体量克制 | `24×24 ≤ 32px`（不占大位） |
| P5/P5b 收回闭环 | 点图标 ⇒ 服务端回读 `manual` ⇒ 图标消失 |
| P0–P3 / M1–M3 | 设置开关 44×26 `role=switch`、bootstrap 回读 `auto`/`manual`、移动端往返，全 PASS |

> ⚠️ 探针本轮同步改造：**自建自有会话**（`POST /api/sessions`）—— 旧默认 `SESSION_URL` 属他人画布 ⇒ `agentReadOnly` ⇒ input-dock 隐藏 ⇒ **composer 工具行不渲染 ⇒ P4 必然假失败**；走查结束删除会话。

**提议卡图标生产实证**（专项脚本，真实生成一触即发）：

| 项 | 实测 |
|---|---|
| 提议卡状态 | `pending_confirm`（含「待确认」徽标、消耗 33 积分） |
| 授权按钮 | 触控区 **44×44**、图标 **16px**、**`text=''`（零文字）**、`on=false`（**线框=未开启**）、颜色 `rgb(138,82,0)`、`aria="授权后续自动生成，本次仍需确认，下次生效"` |
| 同行元素 | `rowText="落锚生成"` ⇒ 与「落锚生成 / 参数微调 / 取消」**形状同构**，卡片不再被长文字撑开 |

**双主题**：浅色 `rgb(138,82,0)`（深琥珀）/ 深色 `rgb(251,191,36)`（亮琥珀）⇒ `--lnk-warning` 双主题自适应，**零新令牌**。

**诚实边界（剩余）**：① audio 介质未活体（沿用 §9.3）；② 本刀**未重跑活体对照 7/7**（P6 拆在独立脚本，逻辑未受本次前端改动影响，但未复跑）；③ `defaultTextModel` 停用缺陷属**既存产品问题**，本刀不修。

---

## 11. UI 迭代二（2026-11-23）：composer 入口改版「状态胶囊 + 锚定浮层」

> 触发：用户给出 WorkBuddy 权限胶囊的实现截图并问「可以考虑参考这个实现？或是你有更加好的方案」。
> 拍板：**采用参考实现的交互骨架**（工具行状态胶囊 + 锚定浮层承载说明与开关），但**不抄它的两处细节**（见 §11.2）。

### 11.1 与 §10 的关系

§10 把「文字块」降级成「单枚图标」，解决了「卡片撑脏 / 通栏污染」；但**图标态没有可点的说明入口**，收回授权只能靠盲点一个 15px 图形（可发现性差），且入口本身只在**已授权**时存在 ⇒ 「从哪儿开启」只能靠提议卡或设置页。

§11 在不推翻 §10 落点纪律（状态属于 composer 工具行 / 同一枚图形 / 琥珀语义）的前提下，把入口升级为**状态胶囊 + 锚定浮层**：

| 维度 | §10（已上线） | §11（本刀） |
|---|---|---|
| 入口 | 24×24 图标按钮（**仅已授权时渲染**） | PC：图标 +「自动生成」+ 箭头**胶囊**（**常驻**）；移动：icon-only 触发器 |
| 状态可读 | 图形实心/线框 | 图形（实心/线框）+ 配色（琥珀高亮/弱化）+ 浮层文案，三通道 |
| 说明文案 | 无（只有 title） | 浮层内**常驻说明**（作用域 + 后果），点开才占屏幕 |
| 收回路径 | 盲点图形即收回 | 浮层内开关（**双向同处**，开关本身就是状态真身） |
| 关闭态入口 | **不存在** | 胶囊常驻 ⇒ 从 composer 就能开启 |

### 11.2 参考实现：抄两处、不抄两处

**抄（值得借鉴）**

1. **状态归位到工具行的胶囊**：不占输入区上方、不做通栏卡片；图标 + 文字 + 状态一眼可读。
2. **说明与开关收进锚定浮层**：文案不常驻屏幕，点开才解释「开了会怎样」；开关就地提供**双向操作**（开 / 收回），不必再单找一个「撤回」入口。

**不抄（明确否决）**

3. **不抄暗红开关**：红色在 iOS/macOS 语义里 = 错误 / 破坏性，而「授权自动生成」是用户主动放权。沿用 §10 已定的琥珀 `--lnk-warning`（注意：agent 正在替你行动）。
4. **不抄「允许完全访问」式全局口径文案**：本能力只覆盖 **image + audio**，video 始终逐次确认 ⇒ 浮层文案必须写清作用域，否则构成越权承诺。

### 11.3 等价物检索结论表（第一原则）

> 判据：①等价物检索 ②接线优先于新建，锚已有结构化数据面 ③禁造数 / 禁自报。

| 需求 | 既有等价物（检索结果） | 结论 |
|---|---|---|
| 锚定浮层 | `.neo-popover`（`styles/main.css`）+ `useClickOutside`（思考档位菜单同款） | **接线**：复用既有表面语言与收起机制，禁新建浮层基座 |
| 移动端底部层 | `MobileSheet`（模型选择卡同款：PC 锚定 popover / 移动 Sheet） | **接线**：不新建底部层 |
| 触感开关 | `ProviderConfigDialog` / `ProfilePane` 两处**各一份**的 44×26 `role=switch` | **接线 + 收敛**：规格与 a11y 语义沿用；样式提升为 `styles/main.css` **共享段**（三处落点同一实现），并统一 ON 色 |
| 授权态读写 | `useAutoApproveGeneration`（服务端 SSOT） | **接线**：组件不持状态、不缓存 localStorage、不做本地判定 |
| 状态图形 | `AutoApproveGlyph`（§10） | **接线**：提议卡与胶囊同一枚图形，禁另画一套 |
| 文案单源 | 无 | **新建 1 个组件**（`AutoApprovePanel`）——同一段说明要出现在两个容器里，不新建就会复制文案 |
| 令牌 | `--lnk-warning` / `--lnk-warning-bg` / `--lnk-warning-border` / `--lnk-surface-canvas` / `--lnk-border-subtle` / `--lnk-border-focus` 双主题已存在 | **零新令牌**；禁 `--neo-*` 前缀、禁裸 hex/rgba |

### 11.4 形态与状态规格

| 项 | 规格 |
|---|---|
| PC 触发器 | 胶囊：14px 图形 + 12px 文字「自动生成」+ 10px 箭头（箭头随展开方向翻转）；高 28px |
| 关闭态 | 图形**线框**、文字 `--lnk-text-muted`、**无底色无边框**（hover 才出 `--lnk-surface-raised`） |
| 开启态 | 图形**实心**、文字/图形 `--lnk-warning`、柔底 `--lnk-warning-bg` + 边框 `--lnk-warning-border` |
| PC 容器 | 锚定浮层（`.neo-popover`），右对齐胶囊上沿，宽 272px |
| 移动触发器 | 24×24 icon-only（裸条纪律：＋ / 模型 / 发送 三件套，不加文字胶囊） |
| 移动容器 | 底部 Sheet（`MobileSheet`），标题「自动生成」+ 副标题「授权 agent 自动执行图片与音频生成」 |
| 面板内容 | 说明（作用域 + 后果）→ 分隔线 → `role=switch` 开关行 → 脚注「仅在可信任务中保持开启」 |
| 开关 | 44×26 轨道 / 20px 旋钮 / `role=switch` + `aria-checked`；ON = `--lnk-warning`；旋钮 `--lnk-surface-canvas`（深色主题下亮琥珀轨道 + 白旋钮对比仅 ≈1.7:1 ⇒ 必须随主题） |
| 提议卡 | 保留 §10 的 icon-only 盾牌入口（**当下这次**的上下文授权），与胶囊状态联动（同一枚图形 + 同一数据源） |

### 11.5 改动清单（逐文件）

| 文件 | 改动 |
|---|---|
| `apps/web/src/components/agent/AutoApproveControl.vue`（新） | 胶囊 / icon-only 触发器 + 锚定浮层（PC）/ 底部 Sheet（移动）；展开态、`aria-expanded`、click-outside（Sheet 内容纳入「内部」判定，否则点开关会顺手关掉 Sheet） |
| `apps/web/src/components/agent/AutoApprovePanel.vue`（新） | 面板单源：作用域说明 + 开关行 + 脚注（PC 浮层与移动 Sheet 各渲染一次，禁复制文案） |
| `apps/web/src/components/agent/AgentSideRail.vue` | 旧 icon-only 直收回按钮删除（含 CSS）；改挂 `<AutoApproveControl :desktop="isDesktopDock" :read-only="props.readOnly" />`；位置：模型 chip 之后、发送键之前；移动裸条 `order: 2` 规则改指组件根 |
| `apps/web/src/styles/main.css` | **共享段**：`.auto-approve-switch` / `.auto-approve-knob`（44×26 / ON=琥珀 / 旋钮随主题）——三处落点唯一来源 |
| `apps/web/src/components/canvas/ProviderConfigDialog.vue` | 删除自带开关样式（改走共享段）；ON 色由 `--lnk-accent` → `--lnk-warning` |
| `apps/web/src/components/mobile/ProfilePane.vue` | 同上（删除自带样式，ON 色统一） |
| `apps/web/src/components/agent/AutoApproveControl.test.ts`（新） | 行为契约：胶囊常驻 / 浮层说明与作用域 / 开关双向写回 / 移动 icon-only + Sheet / 只读禁用 |
| `apps/web/src/components/agent/AgentSideRail.autoApproveEntry.test.ts`（新，替代 `…autoApproveToggle.test.ts`） | 落点守卫 8 条：通栏徽标不得复活 / 旧直收回按钮不得复活 / 入口位置 / 胶囊两态外观 / 零新令牌 / 移动端纪律 / 同构图形 / 开关单一来源 |
| `apps/web/src/components/canvas/ProviderConfigDialog.authorizeAuto.test.ts` | 令牌断言对象改为共享段；新增「ON=琥珀、非 accent」与「弹层内不得自带定义」 |

### 11.6 守卫与变异验证

- 变异 M1：开启态胶囊不再琥珀（状态不可读）⇒ 守卫转红 ✅
- 变异 M2：浮层开关退化为普通按钮（收回/开启不再双向同处）⇒ 行为测试转红 ✅
- 变异 M3：面板说明丢掉「视频仍会逐次确认」（作用域丢失 ⇒ 越权承诺）⇒ 守卫转红 ✅（首跑只替换了 1/2 处 ⇒ 假绿，**全量替换后转红**，记此坑）
- 变异 M4：开关 ON 色改回 `--lnk-accent`（与胶囊琥珀分裂）⇒ 守卫转红 ✅
- `vue-tsc -b` 0 错误；`pnpm verify-agent-rail-gates` **11/11 PASS**（G4 会解析 `AgentSideRail.*.test.ts` 里的 `join(here, …)` 目标 ⇒ 跨目录引用必须写成单个字符串 `'../../styles/main.css'`，多段 `'..', '..'` 会被判 missing）。

### 11.7 诚实边界

- 本刀**只改前端呈现与入口形态**：服务端判定、`resolveAutoApproveTier`、DB 列、偏好 API **零改动** ⇒ §9.2 的活体对照结论（未授权 ⇒ 待确认卡；已授权 ⇒ 零待确认卡）继续适用。
- 移动端 Sheet 与 PC 浮层的**实机视觉**需生产走查实证（本刀未在生产验证）。
- 开关 ON 色由 accent 改琥珀是**全站可见变更**（PC 设置弹窗 / 移动「我的→设置」两处）⇒ 需走查确认不违和。
- 提议卡仍是 icon-only 入口（§10 形态），本刀未再动它 ⇒ 「当下这次顺手授权」与「全局状态」两个入口并存是有意保留。

### 11.8 生产复测结论（2026-11-23，master `b3e6ea66`）

**链路**：PR #980 → CI **4/4 绿**（`Build monorepo` 含 web 全量 **557 文件 / 4622 用例** + `vue-tsc`）→ squash 合并 `b3e6ea66`（**合并树 `dcf60934` == CI 验证 head 树**）→ 部署 run `45118473476`：`Deploy web to CVM` success、`Build API on CVM` **skipped**（web-only 分流正确——本刀纯前端，服务端零改动）。

**产物取证**：递归抓线上 119 个 chunk，`auto-approve-chip` / `auto-approve-popover` / `auto-approve-panel-switch` / `auto-approve-control` 各命中 1 处（`CanvasPage-C6MTGxv3.js`），文案「自动生成」命中 4 处。

**主探针 `.workbuddy/e2e-cdp/generation-auto-approve-probe.mjs` → 21/21 PASS**（P4–P5c 为本刀新增/改写）：

| 判据 | 实测 |
|---|---|
| P4 状态胶囊 | 在 `.agent-dock-actions` 内、文字「自动生成」、`w=100 h=28`、图形 14px 且**实心**（已授权态）、`aria-expanded=false`、`aria="自动生成 · 已开启，agent 生成图片与音频时不再逐次确认"` |
| P4b/P4d 旧形态未复活 | 旧通栏徽标 `false`、旧「单击即收回」icon-only 按钮 `false` |
| P4c 体量克制 | 胶囊 `100×28 ≤ 160×32`（不占大位） |
| P5 浮层 | 点胶囊 ⇒ 浮层展开（`aria-expanded=true`），说明含「图片与音频」与「视频仍会逐次确认」，开关 `role=switch` `44×26` |
| P5b/P5c 双向同处 | 浮层开关点一下 ⇒ 服务端回读 `manual`（胶囊同步退回弱化态 `chipOn=false`）；再点 ⇒ 回读 `auto` ⇒ **往返闭环** |
| P7 关闭态 | 胶囊 `is-on=false`、图形线框、`background=rgba(0,0,0,0)`、`border=rgba(0,0,0,0)`、字色 `rgb(90,100,120)`（弱化） |
| P7b 关闭态浮层 | 开关 `aria-checked=false`、说明「当前每次生成都会先问你…」 |
| M1–M3 移动设置 | 开关 `44×26`；点一下**翻转**服务端偏好（与起始态无关）、再点翻回 ⇒ 往返闭环 |
| M4/M5 移动 composer | 裸条是 **icon-only 触发器**（`text=''`、`24×24`、有图形、**PC 胶囊不出现**）；点开 ⇒ 底部 Sheet（同一份面板 + 开关 + 作用域说明） |
| P6 收尾归零 | 走查账号偏好复位 `manual`（不把「已授权」留在账号上）；走查会话已删（`delete-status-200`） |

**取证截图**：`gen-auto-approve-pc-popover.png`（PC 开启态浮层）、`gen-auto-approve-pc-chip-off.png`（PC 关闭态）、`gen-auto-approve-mobile-sheet.png`（移动底部 Sheet）。

**探针本轮两处改造（踩坑记录）**：
1. **移动段必须相对判定**：`M2/M3` 原按绝对值（期望 `auto`/`manual`）断言 ⇒ 与「前序 PC 段遗留状态」耦合；本刀 PC 段收尾改回 `auto` 后必然假失败。改为「点一下必须翻转、再点必须翻回」，与起始态无关。
2. 走查收尾新增**归零**（`PUT /api/provider/preferences` ⇒ `manual`）+ 走查会话删除，避免账号残留授权态。

**诚实边界（剩余）**：① 开关 ON 色改琥珀的**全站违和感**只在本能力三处落点看过（PC 设置弹窗 / 移动「我的→设置」/ composer 浮层），未做全站开关一致性评审；② audio 介质仍**未活体**（沿用 §9.3）；③ **活体对照 7/7 本轮未复跑**（服务端逻辑零改动，§9.2 结论继续适用）；④ 走查账号 `defaultTextModel` 停用属**既存产品缺陷**，本刀不修。

---

## 12. UI 迭代三（2026-11-23）：胶囊去描边 · 文案收敛为 `[auto]` · 移动端统一

> 触发：用户对 §11 上线的 PC 胶囊提三问 —— ①「按钮的外部矩形边框是否可以去掉？」②「关闭自动生成模式下，底部还是显示了『自动生成』的字——感觉会误导，是否应该改掉？」③「移动端 composer 里面的自动生成的为什么只有盾牌图标，为什么不和 PC 端保持一致，保持复用一套？而是刻意设计？」
> 拍板（用户原话）：**「去掉【自动生成】，更干净。自动生成改成 [auto]。自动生成和每次先问，放在弹出的卡片上去说明即可。」**
> ⇒ 该拍板**同时消解三问**：Q1 去描边、Q2 胶囊只留 `[auto]` 标记（长文案下沉到浮层卡片）、Q3 因胶囊不再带 4 字长文案而宽度大降 ⇒ 两端可真复用同一枚。

### 12.1 三问的取证结论（先量后改，禁凭印象）

| 问 | 取证 | 结论 |
|---|---|---|
| Q1「外部矩形边框」 | **像素扫描**（PIL 取样）：截图里的紫色矩形是**标注工具画的**（紫色 `(108,86,184)` 横贯整行 y=306，产品 UI 无紫色元素）；但胶囊**本体确有琥珀描边**（`.auto-approve-chip.is-on` 的 `border-color: var(--lnk-warning-border)`，x=678 一列连续 `(66,60,26)`→`(86,77,33)` 竖带） | 要去的是这条 **0.5px 琥珀边框** ⇒ 去掉 `border-color`，保留琥珀字 + 实心盾 + 柔底。**柔底 = 状态语义，描边 = 按钮语义**，去描边更干净 |
| Q2「关闭态显示『自动生成』误导」 | **像素扫描**：关闭态胶囊文字是**纯灰 `(108,108,110)`**（`--lnk-text-muted`）⇒ 关闭态那四个字是**低对比度的功能名**，扫过去读不出「现在是关的」；且「用户确认」主语不清（谁确认？） | 用户拍板：**胶囊上彻底不出现「自动生成」字样**，开启态只留 **`[auto]`** 标记；「自动生成 / 每次先问」两个表述**下沉到浮层卡片**（`AutoApprovePanel`）说明 |
| Q3「移动端为何只有图标」 | **生产页面真实替换实验**（CDP，非估算）：把移动端 trigger 换成 83px / 100px 文字胶囊占位，实测裸条高度 | 「四件套会散架」是 §11 当时凭感觉下的判断，**实测证伪**：430/390/360px 全部**不换行**（裸条高恒 80px）；仅 **320px** 换行（80→112px），且**模型 chip 让位截断**后即不换行（模型名 82→69px） |

### 12.2 修订规格

| 项 | 规格 |
|---|---|
| 胶囊（PC + 移动**同一枚**） | 图标（14px 盾牌+闪电）+ **`[auto]` 标记** + 箭头（PC only）。**不再出现「自动生成」中文长文案** |
| `[auto]` 标记形态 | `font-family: var(--lnk-font-mono)`（既有令牌，JetBrains Mono）+ 11px + 琥珀 `--lnk-warning`；方括号是**语义标记**（读作「开关已置 auto」），非装饰 |
| 开启态 | 图形**实心** + `[auto]` 琥珀 + 柔底 `--lnk-warning-bg`；**无 0.5px 描边**（本刀删除 `border-color`） |
| 关闭态 | 图形**线框** + **不显示任何文字**（关闭态若显示 `[auto]` 更误导 —— 直接等于宣称「已是自动」）+ 无底无框。胶囊宽度随状态变化（关闭态 ≈29px / 开启态 ≈68px），**切换发生在浮层打开时**（用户正在看浮层里的说明与开关）⇒ 宽度跳动可接受，不预留空位（预留会在视觉上留下"这里本来有字"的怪痕） |
| 浮层卡片（`AutoApprovePanel`） | 承接两个表述：**开关行标签 = 「自动生成」**（= 功能名），**说明段按两态分别写**（关闭态「当前每次生成都会先问你」/ 开启态「当前为自动生成：…」）——「自动生成」与「每次先问」在此处对照出现 |
| 移动端 | **与 PC 同一枚胶囊**（同一组件、同一文案、同一图形、同一 `[auto]`）；**不带箭头**（移动端开底部 Sheet，箭头语义与 PC 锚定浮层相反）；320px 及以下**模型 chip 让位截断**（`min-width:0` 链式 + 既有 `truncate`），保证裸条不换行 |
| 提议卡 | **不动**（§10 的 icon-only 盾牌 = 「当下这次」的上下文授权入口，与全局状态入口并存是有意保留） |

### 12.3 等价物检索结论表（第一原则）

| 需求 | 既有等价物（检索结果） | 结论 |
|---|---|---|
| 短标记字体 | `--lnk-font-mono`（`design-tokens.css:94`，既有令牌，`HtmlNodePreview` / `CanvasTaskHistoryPanel` / `AccountPanel` 已用） | **接线**：零新令牌 |
| 胶囊外壳 | `AutoApproveControl.vue` 的 `.auto-approve-chip`（§11 已建） | **接线**：改文案与描边，不新建 |
| 面板文案单源 | `AutoApprovePanel.vue`（§11 已建，两端各渲染一次） | **接线**：两个表述下沉到此 |
| 图形 | `AutoApproveGlyph.vue`（§10 已建，与提议卡共用） | **接线**：零改动 |
| 移动端让位 | 移动裸条已有 `flex-wrap: wrap` + 模型 chip 既有 `truncate`（`max-w-[140px]`） | **接线**：只需补 `min-width:0` 链式让位，不新建布局机制 |
| 授权态读写 | `useAutoApproveGeneration`（服务端 SSOT） | **接线**：组件不持状态 |
| 令牌 | `--lnk-warning` / `--lnk-warning-bg` / `--lnk-font-mono` / `--lnk-text-muted` 双主题已存在 | **零新令牌**；禁 `--neo-*`、禁裸 hex/rgba |

### 12.4 变更清单（逐文件）

| 文件 | 改动 |
|---|---|
| `apps/web/src/components/agent/AutoApproveControl.vue` | ① 胶囊文字「自动生成」→ `[auto]` 标记（mono 11px 琥珀）；② `is-on` 去掉 `border-color`（保留柔底 + 琥珀字 + 实心盾）；③ **删除移动端 icon-only 分支**，移动端改用同一枚胶囊（去箭头）；④ 关闭态文字区留空但保留占位宽度 |
| `apps/web/src/components/agent/AutoApprovePanel.vue` | 说明段两态文案对齐「自动生成 / 每次先问」对照；开关行标签保持「自动生成」 |
| `apps/web/src/components/agent/AgentSideRail.vue` | 移动端裸条让位：模型 chip `min-width:0` 链式（`params`/`model-btn`/`span`），320px 下截断让位不换行 |
| `apps/web/src/components/agent/AutoApproveControl.test.ts` | 改：胶囊文字 = `[auto]`；移动端**不再是 icon-only**；两态宽度一致 |
| `apps/web/src/components/agent/AgentSideRail.autoApproveEntry.test.ts` | 改/加守卫：`[auto]` 标记形态、**「自动生成」不得出现在胶囊上**、开启态**无 border-color**、移动端**与 PC 同一枚**、窄屏让位规则 |
| `apps/web/src/components/agent/AutoApproveGlyph.test.ts` | 不改（图形零改动） |

### 12.5 诚实边界

- 本刀**只改前端呈现**：服务端判定 / DB 列 / 偏好 API 零改动 ⇒ §9.2 活体对照结论（未授权 ⇒ 待确认卡；已授权 ⇒ 零待确认卡）继续适用。
- 移动端胶囊的**实机视觉**与 320px 截断效果需生产走查实证（本刀未在生产验证）。
- 关闭态胶囊**文字区留空**后，其可发现性依赖图形与箭头 ⇒ 未做用户可发现性测试（无真人测试场）。
