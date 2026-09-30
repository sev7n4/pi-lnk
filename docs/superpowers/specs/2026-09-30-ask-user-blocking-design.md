# ask_user / propose_generation 阻塞式改造设计（B 层）

> 状态：**已确认（2026-09-30 用户审阅通过，§10 五项确认点均按推荐默认）**
> 前置讨论：2026-09-30 会话；上游能力调研（vendored pi v0.85.1 steer/agent-loop 实证）
> 关联 spec：`2026-09-28-ask-user-tool-design.md`（非阻塞 v1，本 spec 是其架构升级）

## §0 图表声明

本文档**无图表**。所有流程以时序文字描述，无 Mermaid/ASCII 图，`pnpm verify-spec-figures` 无需图形校验项。

## §1 背景与问题

现行 ask_user 是**非阻塞**设计（`services/pi-runtime/src/tools/ask-user.ts:34`）：

- execute 立即返回卡片 → agent 结束 turn → 用户点选回填为**下一轮** user message → 新 turn 重新思考。
- 好处：turn 短、状态简单；坏处：**模型不能在同一轮里「先问再想再继续」**，多步任务每遇确认点就断一轮，执行轨迹割裂、上下文重启成本高。

对标 WorkBuddy / Claude Code 的 AskUserQuestion：**阻塞式**——agent 在工具内挂起等待用户回答，同一 turn 内继续。本 spec 把 ask_user 与 propose_generation 统一改造为阻塞式。

### 上游能力实证（2026-09-30）

- vendored pi v0.85.1 的 agent loop 天然支持长驻工具：tool execute 返回 pending promise，loop `await` 它（`vendor/.../agent/src/agent-loop.ts`）；生产先例 `run_video` 11 分钟长驻 turn 已验证 SSE 链路。
- `Agent.steer()`（agent.ts:283）是「运行中插话」，消费点在 turn 边界（agent-loop.ts:168/195/257），**不会打断正在执行的工具**——与「停下来等必需输入」语义正交，登记 P3（§9）。

## §2 目标 / 非目标

**目标**

1. ask_user：同 turn 内等待用户回答，答案作为工具返回值直接进模型上下文。
2. propose_generation：同 turn 内等待画布确认（用户在画布点确认/取消），确认后 agent 可直接调 run_* 出图，无需用户再发一条「出图」。
3. 有界阻塞：默认 30min 超时降级（turn 不无限挂起）。
4. 全链路可回退：env 开关切回非阻塞 v1 行为。

**非目标**

- steer 运行中插话透传（P3，§9）
- pi-runtime pod 崩溃后的 pending 恢复（§6.5 明确不做）
- 同会话多 pending 并发（pi loop 串行，仅防御性支持）

## §3 已拍板决策（2026-09-30 用户确认）

| ID | 决策 |
|---|---|
| B-1 | 超时语义：**有界阻塞 + 超时降级**（默认 30min，`ASK_USER_TIMEOUT_MS` 可调）；超时 resolve「用户未响应」→ agent 自主决策；迟到回答走既有跨轮链路 |
| B-2 | 改造范围：**ask_user + propose_generation 统一阻塞确认机制** |
| B-3 | 实现方案：**A（pi-runtime 内 pending-tool 注册表）**；B（steering 注入）语义不符不做；C（前端伪阻塞）不作独立方案，由 B-5 回退开关承担降级 |
| B-4 | resolve 不 reject：超时/中止/拒绝一律以**带哨兵的正常返回值**交还模型 |
| B-5 | 回退开关：`ASK_USER_BLOCKING=off` → 两工具退回非阻塞 v1 行为（env 秒级止血，符合 D-ζ' 纪律） |
| B-6 | 多问题卡片：**点选与提交分离**，卡片生命周期绑定 pending；单问题单选即点即发，多问题全部作答后自动提交（修复「点完第一个卡片消失」缺陷，§4.5） |

## §4 架构设计

### 4.1 组件与职责（3 处新增）

| 组件 | 位置 | 职责 |
|---|---|---|
| **PendingToolRegistry** | pi-runtime 新文件 `src/pending-registry.ts` | 内存注册表 `Map<sessionKey, Map<callId, PendingEntry>>`；`waitForUser(sessionKey, callId, toolName)` 返回 pending promise；`answer()` / `timeoutAll()` / `abortAll()` 驱动 resolve |
| **回答端点** | pi-runtime `POST /sessions/:id/answers`（index.ts 新路由） | body `{callId, answer, answerId}` → 按 sessionKey+callId resolve；**幂等**：未知 callId / 重复 answerId 返回 `{ok:true, deduped:true}`（HTTP 200，不报错——回答端点必须让前端重试安全） |
| **透传端点** | Nest `POST /api/agent/sessions/:sessionId/answers`（agent.controller.ts） | canvasSessionId → sessionKey 用 **#76 SSOT 映射**（`getCanvasSessionId` 反向查询；canvasSessionId 是对话面板持有的 key，pi-runtime 注册表键是 `toSessionKey` 产物）→ 调 pi-runtime.client 新方法 `answer()` |

**工具改造**（两个，均注册时注入 registry 实例）：

- `ask_user`（ask-user.ts 重写 execute）：
  1. emit 卡片（canvas_command 通道不变，前端卡片 UI 复用）
  2. `B-5` 开关 on → `await registry.waitForUser(...)` → 用户答案序列化为工具 text 返回（`{answered:true, values}`）；off → 现行为（立即返回，D1-D5 语义不变）
  3. callId = pi tool execute 签名首参（toolCallId），一张卡片一个 callId，卡片内多问题打包一次回答
- `propose_generation`（generation.ts）：
  1. 现行为保留：after_tool 记录提议 + 画布节点 `pending_confirm`（SSOT 不变，画布仍是确认动作发生地）
  2. B-5 on → execute 在 emit 后**追加等待**：轮询画布 SSOT（复用 nest-client `get_node`，2s 间隔，带 jitter）直到节点离开 `pending_confirm`（→ approved resolve）或被删除/变 rejected（→ 拒绝 resolve）

### 4.2 关键设计点：propose_generation 的 resolve 信号源

确认动作发生在**画布**而非对话流（产品现状 + generation-gate 以画布为 SSOT），因此：

- **不新建对话流确认卡**，画布确认 UX 不变（用户习惯保持）
- resolve 信号 = 轮询节点 status：`pending_confirm` → 继续；`completed/approved/生成中` → 放行；`rejected`/节点消失 → 用户拒绝
- 轮询开销可控：只有阻塞中才轮询，30min 上限 × 2s ≈ 900 次单节点查询（轻量 read，可接受；若观测超标再升级为 Nest 推送，本期不做）

### 4.3 generation-gate 联动（必须改，否则阻塞确认后出图被拦）

gate 的「同轮自批拦截」依据 = after_tool 记录的提议 turn 号 vs run_* 调用 turn 号（`gate/generation-gate.ts`）。阻塞化后 propose_generation 与 run_* 在**同一 turn**，现逻辑会误拦。调整：

- 提议记录增加 `confirmed: true` 标记（阻塞确认 resolve 时写入）
- gate 判定：提议记录 `confirmed === true` → 视同跨轮确认，放行（V-γ 预算逻辑不变）
- B-5 off 时记录不带 confirmed → 现行为完全不变

### 4.4 registry 生命周期细节

- **键**：sessionKey（`toSessionKey` 产物，与 session-manager 一致）；Nest 透传时完成映射，pi-runtime 内不做二次解析
- **容量**：pi loop 串行 → 理论每会话 ≤1 pending；仍按 Map<callId> 防御性支持多入口
- **超时**：PendingEntry 建 30min timer；超时 resolve `{__sentinel:"timeout"}` 并清理条目；工具层把哨兵翻译为人类可读文本（「用户未响应，请基于现有信息自主决策」）——模型看到的是正常工具结果，不是错误
- **abort 联动**：session-manager `abort()`（:751）追加调用 `registry.abortAll(sessionKey)` → resolve `{__sentinel:"aborted"}` → 工具返回「用户已中止」→ agent loop 自然停
- **sweeper 误杀防线（必须）**：`sweepOnce`（session-manager.ts:601）按 `lastActivityAt + sessionTtlMs` 回收——**30min 阻塞等待期无 activity，若 TTL≈30min 会在等待中被误杀**（TTL 曾因科学计数法事故被调小，防线必须代码级）。改法：sweep 跳过「registry 该会话有 pending」的条目（`sweepOnce` 查询 registry.hasPending(sessionKey)）；registry 持有 sessionManager 引用或反之，取注入方向：**registry 注入 session-manager**（registry 是后建组件，避免环依赖）

### 4.5 多问题卡片交互（结构性修复「点完第一个卡片消失」缺陷）

**现状缺陷**（v1 非阻塞，用户 2026-09-30 报告）：一次 ask_user 携带多个问题（schema 允许 1-4 个，`ask-user.ts:45`）时，点第一个选项即作为 user message 发送 → 卡片随消息到达被清 → 剩余问题来不及作答，模型只能下轮重问。

**v2 结构性修法**：点选与提交分离——

- **卡片生命周期绑定 pending 状态**，不再绑定「新 user message 到达」：pending 存在期间卡片常驻
- **单问题 + 单选卡片**：点选即提交（保持低摩擦，主路径不变）
- **多问题卡片**：点选只记录本地图答状态（选项高亮 + 已答标记），**全部问题作答后自动提交**；卡尾显示「2/3 已答」进度
- 多选（multiSelect）问题：点选后需显式「确认」钮（多选语义本就需要提交动作）
- 答案 payload 升级为批量：`{callId, answers: {[questionId]: value[]}}`——一次 POST 一次 resolve，与 registry 单 promise 模型对齐
- 部分作答 + 超时：只 resolve 已答部分 + 未答标记 `skipped:true`（模型可看到「用户答了风格但没答张数」）
- **连环提问**（模型连续多次调 ask_user）：阻塞化后天然串行——第一次 resolve 后模型才发起第二次，不会出现两张 pending 卡片并存；历史卡片置灰不可再点

## §5 数据流

### 5.1 ask_user 正常流

```
模型调 ask_user → execute: emit 卡片(SSE) → registry.waitForUser()
  → 用户作答（单问题即点即发 / 多问题答满自动提交）
  → 前端 POST /api/agent/sessions/:id/answers {callId, answers:{qid: value[]}}
  → Nest SSOT 映射 → pi-runtime /answers → resolve → execute 返回答案文本
  → agent loop 继续 → 模型同 turn 继续思考/行动
```

### 5.2 超时流

`30min timer 到 → resolve {__sentinel:"timeout", partial?} → 工具返回「用户未响应…自主决策」+ 已答部分（未答标 `skipped:true`）→ 模型继续 → 前端卡片置「已超时」（answer 端点对已清理 callId 幂等）→ 用户迟到点击 → Nest 发现无 pending → **降级为普通 user message 走新 turn**（复用既有链路，前端 sendMessage 逻辑不变）

### 5.3 用户输入路由规则（Nest，ask_user pending 期间）

- 用户在**对话输入框**打字且该会话有 pending ask_user → 按 answer 处理（自由文本 = 自定义回答，等价「其他」选项）
- 无 pending → 既有新 turn 链路
- 多问题 pending 且有未答问题时，自由文本填充到**首个未答问题**（等价「其他」），前端同步高亮；用户不想回答某个问题时卡内跳过钮置 `skipped`（提交时未答问题标 skipped，不阻塞提交）
- 实现位置：agent.service prompt 入口查 registry pending 状态（需 Nest 能查：pi-runtime 增 `GET /sessions/:id/pending` 轻量端点，或 /answers 的 404 语义 + 降级发送；**拍板：用 /pending 查询端点**，语义显式、避免「先试 answers 再降级」的双跳）

### 5.4 propose_generation 流

```
模型调 propose_generation → emit 卡片 + 节点 pending_confirm（现行为）
  → execute 轮询 SSOT → 用户画布点确认 → status 离开 pending_confirm
  → resolve {confirmed:true} → 提议记录 confirmed=true
  → 模型同 turn 调 run_* → gate 见 confirmed 放行 → 出图
```

## §6 边界情况

1. **刷新/断线**：回答端点无状态 POST，刷新后卡片（P1-7 metadata 恢复）仍可点；SSE 走 #78 live 语义（不重放），turn 打开期间事件持续流；重连 lastEventId 路径不受影响
2. **迟到回答幂等**：pending 已清理（超时/abort）后 /answers 返回 200 `{deduped:true}`；前端据此把卡片置灰
3. **pi-runtime pod 崩溃**：registry 内存丢失 = turn 死亡，SSE 关闭 → 前端走既有错误链路（#81 错误三段式）→ 用户重新发起。**不做崩溃恢复**（上游 pi tool-durability roadmap，升级 vendor 白嫖）
4. **多 pending**：防御性支持（callId 区分）；abortAll/timeoutAll 按会话全清
5. **前端状态**：pending 期间「生成/停止」链路不混（①agent 对话流 cancel = /abort → abortAll；②画布出图停止钮不经 agent）；停止钮语义回归验证列入测试
6. **30min 期间用户关页面**：pi-runtime 持续等待；SSE 断开不影响 turn；用户回来重连即见当前状态

## §7 测试策略

| 层 | 用例 |
|---|---|
| registry 单测 | resolve 正常/超时/abort/幂等 dedupe/多 callId/sweeper 跳过 pending 会话 |
| pi-runtime 集成 | mock LLM：ask_user pending → POST /answers → 同 turn 续行（事件序列断言 agent 未 agent_end）；propose 确认轮询 → status 变更 → gate 放行 run_* |
| gate 单测 | confirmed 标记放行同 turn run_*；off 开关现行为回归 |
| Nest 单测 | canvasSessionId→sessionKey 映射；路由规则（pending→answer，无 pending→新 turn）；/pending 查询 |
| 前端 | 卡片作答 POST / 幂等置灰 / 超时态渲染 / 刷新后可答 / **多问题卡片：点选不高亮提交、答满自动提交、「2/3 已答」进度、multiSelect 显式确认钮 / 历史（非 pending）卡片置灰不可点** |

## §8 回退

- `ASK_USER_BLOCKING=off`：两工具 execute 走非阻塞分支（v1 代码路径保留），registry 不参与；Nest 路由规则同步关（输入一律新 turn）
- 部署顺序：pi-runtime 先上（helm `--reuse-values` + `--set image.tag` + 数字 env 用 `--set-string`）→ Nest → web；回退反序
- ⚠️ `ASK_USER_TIMEOUT_MS` 是数字 env，helm 必须 `--set-string`（rev 30-32 事故教训）

## §9 有意不支持 / P3 登记

| 项 | 结论 | 依据 |
|---|---|---|
| steer 运行中插话透传 | P3 | 库已支持（agent.ts:283），依赖本注册表 + §5.3 路由规则先行；上游正把 steering 做 durable inbox，晚做可白嫖 vendor 升级 |
| pod crash pending 恢复 | 不做 | 上游 tool-durability roadmap；崩溃=turn 死亡可接受 |
| 对话流内出图确认卡 | 不做 | 画布确认 UX 保持（§4.2）；搬面属产品决策非本期 |
| propose 确认 Nest 推送 | 不做 | 轮询够用（§4.2），观测超标再立项 |

## §10 审阅确认点（2026-09-30 用户确认：①-⑥ 全部按推荐默认）

① 超时默认 **30min** ✓
② propose 确认轮询间隔 **2s** ✓
③ pending 期间对话输入一律按 answer，自由文本填充首个未答问题 ✓
④ 回答端点幂等返回 200 ✓
⑤ sweeper 跳过 pending 会话（registry 注入 session-manager）✓
⑥ 多问题卡片 B-6 交互（即点即发 / 答满自动提交 / n/m 进度 / 跳过钮 / multiSelect 显式确认）✓
