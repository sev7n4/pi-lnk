# 设计规格：propose 确认证据化 + ask_user 澄清决策矩阵

- 日期：2026-10-13
- 状态：已拍板（用户 2026-10-13 02:57 同意评判结论并授权实施 + 生产取证）
- 关联事故：会话 `cmv51vwpu0008p801hxaxcf8m`（2026-10-12 23:30–23:33，「生成一只大灰狼」→「需要皮克斯风格」）
- 同类前案：`cmus6ha64001dk601lzsymqfa`（2026-10-06，stale draft flush 方向）

## 0. 问题定义

| # | 典型问题 | 现象 |
|---|---|---|
| Q1 | ask_user 澄清语义未编码 | turn1「生成一只大灰狼」未触发 ask_user；用户期望「风格等关键参数应被澄清或显式默认」 |
| Q2 | propose 虚假确认 | turn2 改风格：`set_node_text` 错写 `content` 字段、`propose_generation` 未等用户确认即返 `confirmed:true`、零生成、模型却回复「画布正在出图中」；提示词未更新、无新卡片 |

## 1. 三轮取证结论（评判资产，用户已确认）

### 1.1 Q2 根因链（五步叠加，终审成立）

1. `set_node_text{content}` 错字段：图节点生成提示词在 `data.prompt`，皮克斯文本被写进 `data.content`（生产 DB 节点现状 + 工具 trace args 双重实证）。
2. `set-node-content` 隐式副作用：`agent-canvas-tools.service.ts:1305` 写 content 时强制 `status:'completed'` —— 纯文本编辑污染生成状态机；该副作用**回显进 tool_result**，模型最终 thinking 原文「节点状态显示为 completed…现在新的生成已启动」证明错误结论是被工具结果**授权**的。
3. 前端 L2 守卫漏 modify 流：`shouldSyncProposePending` 只放行 `''/draft`（`proposeWaitActions.ts:28`），节点为 completed 时 pending_confirm 同步被跳过，本地留 stale 终态。
4. 全量 autosave 盖写 SSOT：`PUT /api/sessions/:id` 整份替换 canvasData（`sessions.service.ts:51`）；nginx 取证：23:32:40 一次 PUT（1127B）落在 propose 等待窗口内，是窗口内**唯一**能把 SSOT 从 pending_confirm 翻回 completed 的写者（`proposeGeneration` 无条件写 pending_confirm 且 `applyOrStage(stage=false)` 直接落库，写入失败备择假设已排除）。
5. 确认证据规则歧义：`canvas-write.ts:397` 轮询把**任何**非 pending/非 draft 状态当作「已确认自起生成」；completed 恰是旧生成的合法终态 ⇒ 虚假 confirmed:true。

**因果闭合证据**：GenerationRecord 全会话仅 1 条（turn1）；turn2 窗口零 `/answers`、零生成 POST（nginx access.log-20261013 全量核查）。

**诚实残余**：PUT 载荷未直接观测（nginx 不记 body），「:40 PUT 携带 stale completed」是排除全部替代代码路径后的演绎；executionEvents 无时间戳，propose 精确时长不可测。

### 1.2 Q1 定性（终审）

- `ask_user` 在常驻工具集（`tiering.ts:137` ALWAYS_ON，`session-manager.ts` 经 `buildToolEnsemble` 装配），turn1 可调未调。
- 规则 16 原文「**内容类**关键信息缺失…先调 ask_user」经 contentHash 逐字节复算（复刻 `loader.ts:138/228` 算法 = `ca9c170c7ae0`）确认在 turn1 系统提示词内；但「风格」不在「内容类关键信息」字面范围 ⇒ **模型未违规，是「风格要不要问」的产品语义从未被编码**。
- `ask-user.ts:46-47` 注释实证：2026-10-03 已因同一模型（agnes-2.5-flash）0 次调用修过一次 description ⇒ **提示词层对该模型的约束力已被生产证伪两次**，解法重心必须是机制编码（schema / tool_result），不是继续加条文。

### 1.3 契约级新发现（二轮）

propose 成功结果**无 `reason` 字段**：`/answers` 真确认与轮询推断产出的 tool_result 逐字节相同，模型无法区分「用户真确认」与「状态被误读」；成功话术「生成已由画布启动」在零生成时照样断言。

### 1.4 行业最佳实践对比（三轮取证，含官方原文）

| 产品 | 机制 | 取向 |
|---|---|---|
| Claude Code AskUserQuestion | 结构化问卡：1-4 题、2-4 选项、"Other" 自动、**推荐项置首标 (Recommended)**、禁 meta 问题 | 「Only when blocked on a decision **genuinely the user's to make**: cannot resolve from the request, the code, or **sensible defaults**」 |
| Codex | 无结构化 ask 工具，**声明式假设** | 「Bias to action: do not end your turn with clarifications **unless truly blocked**」；假设不得导致任务偏航，会实质改变结果时 stop+报告 blocker；假设成立则**显式声明假设内容与理由** |
| pi-agent（vendor 0.85.1，源码核实） | **无任何 ask/elicitation 工具**；HITL 仅 steer/followUp 队列 + 权限确认 | 我们的 ask_user/propose 是超越上游的自建层，无上游实践可抄 |
| WorkBuddy AskUserQuestion | 与 Claude Code 同源 | 收集偏好 / 澄清歧义 / 路径抉择；推荐项置首 |

**收敛判据（三家共同点）**：猜错代价 > 打断代价才问。充分条件（任一）：① 决策本质上是用户的；② 无合理默认或默认间差异巨大；③ 不可逆/返工成本高。其余 → 做假设 + 显式声明 + 留改口通道。

### 1.5 用户拍板的生成参数决策矩阵

| 参数 | 档位 | 行为 |
|---|---|---|
| 主体/用途缺失 | **必问**（blocking） | ask_user，问卡带推荐项 + 推荐理由 |
| 风格/画风 | **偏好级** | 声明式默认：按领域默认生成并在回复与 propose 摘要**显式声明**；或问（技能可指定必问场景） |
| 尺寸/分辨率/画幅 | **领域默认** | 按场景知识填（电商主图 1:1、海报 2:3、视频 16:9…），不问，propose 摘要/dock 可见可改 |
| 张数/批量 | **领域默认** | 默认 1，批量由用户明说 |
| 模型选择 | **不问** | 会员档/质量策略默认 |

闭环形态（用户提出、本规格采纳）：决定问时，问卡**推荐项置首 + 说明推荐原因**，答完经 propose 回填节点 dock；相关联问题合并一张多题卡（≤4 题），禁止多轮审讯。

### 1.6 设计原则纲领（用户 2026-10-13 拍板收编）

> **「问卡是决策原语，不是默认动作；该问的问得漂亮（推荐+理由+多题卡+回填闭环），不该问的做得透明（默认+声明+可改口）。」**

逐半句与本规格交付物的映射（纲领可校验，不是装饰口号）：

| 纲领半句 | 实现锚点（已上线） |
|---|---|
| 问卡是**决策原语**，不是默认动作 | 规则 16 v1.5.0 前半：「缺主体/用途等阻塞信息或需择一时，先调 ask_user」；ask_user 工具描述：「不得问可合理默认的细节」 |
| 推荐 + 理由 + 多题卡 | P1-3 ask_user 描述（推荐置首 + 标注「（推荐）」+ 多问一卡）+ §1.5 闭环形态 |
| 回填闭环 | propose_generation 节点 dock 回填（既有机制，事故取证已证） |
| **默认**（不该问的） | 规则 16 后半：「风格/尺寸/张数按领域默认」 |
| **声明**（做得透明） | 同上「…并声明」：回复与 propose 摘要显式说出默认值 |
| **可改口** | 画布节点 dock/提示词随时可编辑重生成；P0-B 守卫保证等待期改写不被盖写 |

本纲领是双向防倒退护栏：防止实现倒退回「什么都问」（审讯式交互），也防止倒退回「不声明默认值就生成」（黑盒替代用户决策）。实现层已全覆盖，**本纲领不改任何代码**。

## 2. 技术方案

### P0-A propose 轮询只认正证据（runtime，`services/pi-runtime/src/tools/canvas-write.ts`）

- propose 执行开始先经 `get-node` 快照 `{generationRecordId, generationStartedAt}`。
- 轮询臂 confirmed 仅当：
  - `status === 'generating' | 'fallback_pending'`；或
  - `generationRecordId` 不同于快照；或
  - `generationStartedAt` 新于 propose 开始时刻（覆盖「极快完成已落 completed」竞态）。
- `completed/error/failed` 且**无**上述正证据 ⇒ `{confirmed:false, reason:'stale_status'}`，消息：「未检测到生成启动（节点状态为 X 但无新生成证据），不要声称已出图；请重新 propose 或请用户在画布节点确认。」
- `draft` 连续 ≥2 次 → rejected、404 → gone、错误容忍 ≤3 次：维持现状。
- `/answers` answered 臂维持最高优先级（唯一不依赖 SSOT 时序的确认路径）。
- **结果契约**：成功/失败均透传 `reason` + `evidence`；confirmed:true 的消息按证据来源区分（answered / generating / new_record），不再无条件断言「生成已由画布启动」。
- 兼容：画布侧直接生成无 /answers 的旧路径仍由「generating/新记录」正证据覆盖，行为不退化。

### P0-B 服务端状态转移守卫（Nest，`apps/server/src/sessions/sessions.service.ts`）

- 整份 PUT 落地前逐节点比对：服务端节点 `status === 'pending_confirm'` 时，客户端载荷的 status 仅允许 `{pending_confirm, draft, generating}`（对应确认启动路径 `handleAgentGenerateNode` 的 patch 序列）；直接翻为 `completed/error/failed` ⇒ **字段级丢弃**（保留服务端值），不 409 整单。
- 正当性：pending_confirm 的合法出口 = 显式确认（→draft→generating）或 clear-propose 专用端点（→draft）；不存在 pending_confirm→completed 的合法直达。

### P0-C 前端等待期 PUT 剥离（`apps/web/src/pages/CanvasPage.vue`）

- propose 等待期（`wait.nodeId` 已知），autosave 序列化载荷时剥离该节点的 `status` 字段（其余字段照存）。前端守卫降级为第二道防线。

### P1-1 set-node-content 媒体拒写（Nest，`agent-canvas-tools.service.ts`）

- image/video/audio 节点拒收 content 写入：`BadRequestException('媒体节点正文不可写；改生成提示词请用 set_node_text 的 prompt 参数')`，fail-closed，把静默错写变成模型可自愈的显式报错。
- 文本类节点维持现状（`status:'completed'` 语义不动，避免回归）。

### P1-2 规则 16 三档决策矩阵（prompt-registry，预算中性改写）

- `media_tool_policy.md` 规则 16 **原地改写**（总长不增，L6 余量仅 3 字符）：
  「16. 继续干活前缺主体/用途等阻塞信息、或需用户在有限选项择一时，先调 ask_user（推荐项置首+说明理由，关联问题合一张卡）。风格/尺寸/张数等偏好参数：按领域默认并显式声明，不问。」
- 同步 6 处（磁盘 .md / MANIFEST contentHash / COMPOSED_IDS 不变 / FALLBACK_BY_ID 不变 / fallback 常量 WRITE_TOOLS_RULES / assembler 测试 EXPECTED），`pnpm prompt:lint` 全绿。

### P1-3 ask_user 描述增强（runtime，`tools/ask-user.ts`）

- 补两条约定：「有推荐时推荐项放首位并在 label 标注（推荐）+ description 说明推荐理由」「不得问可合理默认的细节（尺寸/张数/分辨率按场景默认并在回复中声明）」。

### P2 观测

- eval 场景（登记待批）：`style-unspecified-declare`（不问但须声明默认）、`params-default-fill`（propose 摘要含默认值）、`propose-no-false-confirm`（无生成不得声称出图）。
- 指标：ask_user 触发率、propose `confirmed` 按 reason 分布（`pi_runtime_propose_outcome_total{reason}`）。
  - **指标已实施**（实施计划 `docs/superpowers/plans/2026-10-13-propose-outcome-metric-p2.md`）：runtime /metrics 新增 `pi_runtime_propose_outcome_total{reason}`，结算单点 = Promise.race 后的 `outcome` + 早退路径 `nonblocking`；`stale_status:*` 白名单归一防 label 基数爆炸；工具层经回调观察者注入（不持 Metrics，2026-10-04 纪律不破）。
  - **ask_user 触发率不加新指标**：事件层 `tool_calls_total{tool="ask_user"}` 已存在，触发率派生即可。

## 3. 验收标准

1. 生产重跑事故场景（新画布「生成一只大灰狼」→「需要皮克斯风格」）：
   - turn2 工具 trace 显示 `set_node_text{prompt:…}`（media 拒写 content 后模型自愈）或 content 被拒 + 改走 prompt；
   - 节点 `data.prompt` = 皮克斯文本；
   - propose 不返虚假 confirmed（无 /answers、无生成时 reason ≠ confirmed）；
   - 模型回复不含「正在出图/已启动生成」类断言；
   - 生成 POST 仅在真实确认后出现。
2. `pnpm prompt:lint` 全绿；相关 vitest 全绿；关键修复配变异验证。
3. 画布侧直接生成（无 /answers）旧路径回归验证：确认→出图正常。

## 4. 部署与取证计划

- 分支：`fix/propose-confirm-evidence`（P0-A/B/C + P1-1）、`feat/clarify-decision-matrix`（P1-2 + P1-3），各自 PR、squash 合并。
- 部署：Nest api（compose `api` 重建）、pi-runtime（runtime-deploy，tag=master 短 SHA）、web 静态（:8888，BFS 枚举 chunk 判据）。
- 生产取证：DB trace + GenerationRecord + nginx 三路，断言见 §3。
