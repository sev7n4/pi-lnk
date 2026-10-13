# 生成失败恢复与运动提示词质量设计（②③④）

- 日期：2026-10-13
- 状态：待评审
- 来源 case：画布 `cmv51vwpu0008p801hxaxcf8m`（图生视频 10s，propose 确认后生成失败，agent 无感知，节点静默红点）
- 关联问题编号：② 端到端交付断裂 ③ 视频提示词不专业 ④ 失败缺决策卡（⑤ 费用展示**不在本规格**，单独 PR）

---

## 1. 现状事实（全部经代码核实）

| # | 事实 | 出处 |
|---|---|---|
| F1 | propose_generation 阻塞确认发生在 turn **内**（双臂 race：SSOT 2s 轮询 + registry `/answers`）；确认后工具文案「生成已由画布启动，不要对该节点调用 run_*」 | `services/pi-runtime/src/tools/canvas-write.ts:365-472` |
| F2 | 确认后生成所有权移交前端 canvas 路径，agent turn 正常收尾结束 | `apps/web/src/composables/useNodeGeneration.ts`（generateForNode） |
| F3 | 服务端 studio 在生成终态落 `failed` + 退款（`failed_refund`），**Nest 是失败的第一知情者** | `apps/server/src/studio/*`（studio.fallback.test.ts、generation-reaper.service.ts） |
| F4 | 失败到达前端的唯一通道是轮询（GenerationPollTask），落到节点 `errorMessage` + 红 `!` 徽章；**无 toast、无动作卡、无 agent 回注** | `useNodeGeneration.ts:255-748` 各 error 收口点 |
| F5 | server 侧不存在任何「生成终态 → agent」通知通道（全仓搜索无命中） | — |
| F6 | 宿主注入对话的既有正道：turn 进行中 `runs/steer`（vendor steer lane）、新 turn `chat/conversation`；skill 注入正道 `forceSkills`（dock skillId / 斜杠命令） | `agent.controller.ts:419/531`、`agent.service.ts:581/1214`、`resolve-force-skills.ts` |
| F7 | 视频运动提示词方法论**已存在**：drama-motion-video 六段式（frame lock / subject lock / 单一运镜 / 单一动作 / 环境次运动 / prohibitions），铁律「图管外观，prompt 管时间」 | `skills/drama-motion-video` |
| F8 | F7 方法论在 case 中未被触发：触发描述写的是 drama 场景词（「把分镜变成视频」），口语化「用这个图片做一个10s」不匹配；且 skill 归属是宿主显式注入，模型无自选通道 | `skills/drama-motion-video` frontmatter、`resolve-force-skills.ts` |
| F9 | prompt-registry 预算 3197/3200（余量 3 字符）⇒ **加 registry 规则是死路** | `prompt-registry/PROMPT_SPEC.md` §5 |
| F10 | 失败信息已结构化：`short.userMessage` / `short.errorCode` 随轮询就绪 | `useNodeGeneration.ts:264-267` |
| F11 | **失败恢复体系主体已存在**（审核发现，初版规格漏核）：诊断抽屉三段式、错误码文案映射、红点直落诊断 tab、原参数重试角标、换模型一键重试、退款透明 | `MediaInspectorDrawer.vue`、`generationDiagnostic.ts`、`retryRecommendation.ts`、`NodeTaskCornerActions.vue` |
| F12 | skills index 仅常驻 name+description 清单，**模型无 skill 自选机制**；注入 100% 靠宿主 `forceSkills` | `session-manager.ts:2646-2649`、`resolve-force-skills.ts` |
| F13 | vendor `after_tool` 支持 patch 工具结果（既有 capToolResult 先例）；`before_tool` 支持改 args / block | `index.ts:90-117`、vendor `hooks.ts:157-184` |
| F14 | `runs/events` 是 30s idle 短流且无连接注册表 ⇒ 在线态不可直接观测，需代理判据 | `agent.controller.ts:472-503` |
| F15 | `followUp`/`steer` 是纯透传（不走 Nest prompt 管线）；二者同边界竞争时 followUp 被延后 | `agent.service.ts:581-617` |
| F16 | server 无全局 ValidationPipe ⇒ `chat/conversation` 加 `origin` 字段不会被 400（实现时仍核对 DTO 无手工白名单） | `apps/server/src`（无 useGlobalPipes） |

## 2. 设计原则（吃满上游与行业实践，不重复造轮子）

1. **终态事件是确定性事实，恢复动作是宿主职责**（对齐仓库铁律「状态担保 = 确定性事件」）。Codex / Claude Code / WorkBuddy 的共同形态：后台任务终态 → 宿主把结构化通知注入对话 → agent 在新回合里消化。我们不发明新机制，复用 F6 的两条正道。
2. **确定性路由优先于模型自觉**。③ 的教训不是「模型不会写」，是「方法论没被送到现场」。载体按确定性排序：工具描述（100% 在场）> after_tool 事实触发 > 关键词启发式。
3. **先核存量再提增量**。本次审核的教训：PR1 初版 70% 在重造已存在的诊断体系（F11）。任何「缺 X」的断言先搜代码库。
4. **ask 卡是决策原语，失败恢复同理**：只在需要用户做选择的终态出现，且每个选项都是可执行动作（不是纯告知）。
5. **无动作的注入是浪费**：用户离线不注入 turn（省 token），由 PR1 的诊断入口兜底——用户回来自行发起诊断。
6. **预算红线不可越**：所有行为约束走工具描述 / skill 正文 / 宿主注入，不碰 prompt-registry（F9）。

## 3. 方案总览：三期 PR，可独立上线

| 期 | 内容 | 改动面 | 治哪个问题 |
|---|---|---|---|
| **PR1** | 复用既有诊断体系，只补两个增量：失败 toast（收口）+ 诊断抽屉「让 Agent 诊断」入口 | 纯前端 | ④（立即止损，用户点「让 Agent 诊断」即恢复端到端） |
| **PR2** | 运动提示词质量：工具描述契约（主）+ after_tool 上下文纠偏（主）+ forceSkills 启发式（可选后置） | pi-runtime + eval | ③ |
| **PR3** | 生成失败 agent 回注：终态事件 → followUp / system-origin turn | Nest + web | ②（完整闭环） |

依赖关系：PR1 无依赖先行；PR2 独立；PR3 依赖 PR1 的诊断入口作为离线兜底语义（先有「不注入也有出口」，回注才敢做限流）。

---

## 4. PR1：失败Toast 与 Agent 诊断入口（复用既有诊断体系，只补两个增量）

### 4.0 审核修正（2026-10-13）：初版 PR1 = 70% 重复造轮子

核实发现**失败恢复体系的主体已存在**（初版规格未核即写，属编造需求）：

| 已存在（必须复用，禁重造） | 出处 |
|---|---|
| 诊断抽屉三段式（结论 → 动作 → 技术详情，2026-10-08 与用户拍板） | `MediaInspectorDrawer.vue:200` |
| 错误码 → 人类可读文案映射 `DIAGNOSTIC_CODE_LABELS` + `generationDiagnostic.ts`（userMessage / errorCode / refundedPoints / generationRecordId） | `utils/generationDiagnostic.ts` |
| 红/黄节点图标点击直落诊断 tab | `MediaInspectorDrawer.vue:83` |
| 原参数重试（节点角标，与生成中同位置同交互） | `NodeTaskCornerActions.vue:113` + `CANVAS_NODE_RETRY_KEY` |
| 换模型一键重试（候选推荐 + 健康投影 + 同渠道语义；欠费/不可重试码显式留白不渲染） | `retryRecommendation.ts` + `MediaInspectorDrawer.vue:277-314,668` |
| 退款积分透明展示 | 同上 |
| Toast 基建 | element-plus `ElMessage`（全站通用） |

⇒ 初版的「失败决策卡」「错误码映射表」「换模型动作」全部推翻。**PR1 真正的增量只有两个**：

### 4.1 增量一：失败 Toast（收口点唯一）

`useNodeGeneration.ts` 的 error 终态散落 8+ 处 patch 点。新增单一收口函数 `settleNodeError(nodeId, short)`：patch errorMessage/errorCode（现状不变）+ 一条 `ElMessage.warning`：

> 「{节点标题} 生成失败：{short.userMessage}」，点击 → 打开该节点诊断抽屉（复用 MediaInspectorDrawer，直落诊断 tab，即 `:83` 既有行为）。

**只加不改**：失败语义零回归，既有测试全绿为前提。Toast 5s 自动消失；同一节点短时间重复失败只 toast 一次（防刷屏，收口函数内去重）。

### 4.2 增量二：「让 Agent 诊断」入口

在诊断抽屉「动作」段（既有三段式的第二段）追加第三个动作按钮（前两个是原参数重试 / 换模型重试的既有呈现区）：

- 点击 → composer 预填诊断消息并**等用户点发送**：「视频节点 {nodeId} 生成失败了（原因：{userMessage}，错误码：{errorCode}），帮我诊断并给下一步建议」。
- **预填不自动发送**：用户显式动作 = 意图表达，也自然规避 token 争议（与 §6 回注的限流哲学一致）。
- 数据全部来自既有 `diagnostic` ref（nodeId / userMessage / errorCode 已在抽屉内），零新增查询。

### 4.3 与 PR3 的边界

- PR1 = 用户**在场**时的完整恢复环（toast 看见 → 抽屉诊断 → 三动作收口），纯前端，可立即上线。
- PR3 = 用户**不在场/未点开**时的主动闭环（回注）。两者互补不重叠：PR3 的「离线 skip」分支正是靠 PR1 兜底。

---

## 5. PR2：运动提示词质量（③）

三个杠杆，全部零 prompt 预算消耗。

### 5.0 审核修正（2026-10-13）：两处错误论据

1. **「模型自匹配 skill」不存在**：skills index 只是常驻 system prompt 尾部的 name+description 清单（`session-manager.ts:2646-2649`），模型**没有自选调用机制**——skill 注入 100% 靠宿主 `forceSkills`（dock skillId / 斜杠命令，`resolve-force-skills.ts`）。初版「扩触发词覆盖模型自匹配」是无效论据，删除；扩 description 的实际收益仅限 dock 技能选择器的 UI 呈现，保留但不作为质量杠杆。
2. **关键词意图检测是启发式**，降级为可选增强（见 5.3），并明确标注判据与误报代价。

### 5.1 主杠杆 A：工具描述契约（pi-runtime，100% 确定在场）

`upsert_media_node` 与 `set_node_generation_params` 的 description 各追加一句：

> For video nodes with reference image(s), the prompt must describe ONLY motion (one camera move + one subject action + ambient secondary motion + prohibitions). Do NOT restate the frame's static appearance — the reference image already defines it.

工具描述从 turn 第一个 LLM 调用起就在上下文里（模型生成 upsert args 的那一刻就在场），不进预算。这是**唯一能在 prompt 落笔前 100% 确定抵达的契约载体**——初版把它当「辅杠杆」是排序错误。

### 5.2 主杠杆 B：after_tool 上下文纠偏（pi-runtime hook，确定性事件触发）

在 `index.ts:90` 既有 after_tool 合并 listener 内扩展（该 listener 已示范 patch 返回值：`index.ts:116` 的 `capToolResult`）：

```
after_tool: toolName === 'upsert_media_node' && !isError && args.type === 'video'
  → 工具结果追加一段 motion 契约提醒（图生视频纪律 + 六段式索引，≤300 字）
```

- **确定性**：触发条件是工具调用事实（video 节点创建），不是关键词。
- **时机价值**：upsert 是 upsert 语义——prompt 第一版写入后、propose 前还有多轮 LLM 决策（set_params / apply_attachments / 可再次 upsert 改写 prompt），纠偏文本在**下一次 LLM 调用**即可见，模型有真实自我修正窗口。
- **实现纪律**：注册序必须排在既有 capToolResult / 信号 listener 之后的约定已由 `result-signal-wiring.test.ts` 钉住；本次扩展进同一合并 listener 内部，顺序风险为零。纯函数（`isVideoNodeContractNeeded(args)`）可单测。

### 5.3 可选增强：宿主 forceSkills 注入（启发式，可后置）

`resolve-force-skills.ts` 扩展判定（**标注为启发式**）：

```
若 用户消息命中图生视频意图词表 && turnContext 附件非空 → forceSkills = ['drama-motion-video']
```

- 误注入代价 = 多花一份 skill 正文 token；漏注入 = 回到 5.1/5.2 兜底。与主杠杆是叠加关系不是依赖关系，**可在主杠杆上线并观测一周后再决定是否做**。
- 纯图生视频（无参考图）不强注六段式全文（frame lock 段不适用）：给 `withForcedSkills` 加 section 裁剪参数，skill 正文按 `##` 分节可裁。
- dock 技能选择器侧：`drama-motion-video` frontmatter description 扩面（图生视频 / 让图动起来 / 图片转视频），R5 段归属纪律不变。

### 5.4 回归判据与遥测

- **golden case 一条**（`services/pi-runtime/src/eval/`）：图生视频请求 → 断言产出 prompt 含运动词汇（运镜/动作词表命中）且不含静帧复述特征（「毛发细节」「高精度渲染」类外观词）。
- **遥测指标**（before/after 各观测一周）：视频一次成功率、同节点重试率、失败后「让 Agent 诊断」点击率。判收益看一次成功率抬升。

### 5.5 明确不走的路

- ❌ prompt-registry 加规则（F9 预算锁死，且扩容须人工拍板）。
- ❌ before_tool 改写 args 替模型写 prompt（vendor 支持 args 改写——`hooks.ts:170`——但替写提示词是黑盒决策，质量不可审计，拒绝）。
- ❌ 只靠模型自觉（无任何载体时已证不可靠，F8）。

---

## 6. PR3：生成失败 agent 回注（②，端到端闭环）

### 6.1 架构

```
studio 落 failed 终态（F3，唯一真相点，含退款）
        │ 同事务后发 GenerationFailedEvent
        ▼
GenerationRecoveryDispatcher（Nest 新服务，纯函数决策核 + 副作用薄壳）
        │
        ├─ 会话有活跃 run ──→ POST pi-runtime followUp（复用 runs/followup，vendor followUp lane，尾随消费）
        ├─ 无活跃 run 且用户在线（agent SSE 连接存活）──→ 经 chat/conversation 发起 system-origin turn
        └─ 用户离线 ──→ 不注入（PR1 失败卡兜底）
```

- **决策核是纯函数**：输入（会话运行态、在线态、限流计数、失败记录）→ 输出（followUp / newTurn / skip + 理由），全分支可单测。
- **不新建通道**：followUp 与 conversation 都是既有端点（F6：`agent.controller.ts:444` / `:531`）；pi-runtime 零改动（followUp 走 vendor lane，新 turn 走既有 prompt 路径）。

### 6.0 审核修正（2026-10-13）：三个必须写进设计的实情

1. **「用户在线（SSE 连接存活）」初版是虚构判据**：`runs/events` 是 30s idle 短流（`agent.controller.ts:485-487`，断开是常态），且**无连接注册表**可查。替代设计：在 `runs/events` handler 记 `lastSeenAt`（一行，Session 维度），**5 分钟窗口内有连接 ≈ 页面开着**，作为在线代理判据。若嫌侵入，退化为「无在线门 + 收紧频率限流至 1 次/小时」——但首选前者（可观测性顺带）。
2. **followUp 是纯透传，不走 Nest prompt 管线**（`agent.service.ts:608-617` 只转发 pi-runtime）：无 turnContext 装配、无 retention 注入、无 finalizeTurn、无 persistCanvasEntities。**tradeoff 显式声明**：失败通知是短回复、无 canvas 实体变更，retention/持久化缺失可接受；但这意味着 followUp 路径不能承载任何需要写画布的恢复动作——若未来回注要触发实体操作，必须走 conversation 路径。
3. **steer 与 followUp 同边界竞争**（`agent.service.ts:601-603`）：同一收尾边界已有 steer 待消费时，followUp 被跳过、留在 inbox 等下一次 accept（`drainAfterRun` 兜底，不丢但延后）。⇒ 用户正在连续插话时，失败通知延后到其下一条消息之后——语义上正确（用户优先），写进限流表备注。

另需补两个映射（初版遗漏）：
- **record → session**：已具备——video 生成终态处 scope 含 `{ sessionId, nodeId, generationRecordId }`（`video-generation.orchestrator.ts:50`）。
- **session → threadKey**：`followUpPiRun` 用 `threadId?.trim() || sessionId`（`:615`）——dispatcher 需先查该画布会话的活跃 threadId（Nest threads 表已有，`upsertAgentThread`），查不到才回落 sessionId。

### 6.1.1 为什么是 followUp 而不是 steer（评审修正，2026-10-13）

初版误选 steer，论据「steer 天然排队不打断」不成立。vendor 两条队列的消费时机语义（`session-manager.ts:2084-2146`，boundary.ts:85-89/106/187）：

| | steer（插话） | followUp（尾随） |
|---|---|---|
| 消费点 | run 内**下一个 checkpoint 边界**即消费，同 run 再生成一代 | 仅**收尾边界**（`finishRunBoundary`）且本轮无 trigger 条目时消费 |
| 对在途任务 | **打断**——失败报告插进当前任务中间，污染在途推理上下文 | **不打断**——当前任务完整收尾后，同 operationId 续跑一代来处理失败 |
| 工具阻塞期（propose/ask_user 等待） | 阻塞结束后下一个边界消费 | 睡到收尾边界 = **恰好避开用户确认决策窗口**（失败报告不会插进正在做确认决策的 turn） |
| 入队时 run 恰好已结束 | `drainQueued` 兜底开轮（`:2116`） | 同样 `drainQueued` 兜底（`:2144`），**不会睡死** |

判定：失败事件是**通知**不是**插话**，语义对齐 Claude Code / WorkBuddy 的 task-notification（从不打断在途回合，边界追加）。失败诊断非时敏（用户还看得到失败卡，可显式拉起诊断），用延迟换上下文干净，followUp 全场景占优。本方案不存在「失败必须立刻插话处理」的场景——若未来出现，那是 steer 的地盘，但当前不做。

### 6.2 system-origin 消息契约

```
[系统事件·生成失败] node={nodeId} record={generationRecordId}
reason={errorCode} detail={userMessage} refund={refundedPoints|none}
请：① 用一句话向用户说明失败原因与退款状态；② 给出下一步选项（改参数重试 / 换模型 / 放弃）；
不要对该节点调用 run_*，等待用户选择。
```

- 经 conversation prompt / followUp lane 进入 → 均自然入对话历史（`pi.pending.entry` 落盘，进程重启不丢），后续轮次可追溯（对比 T 层 dynamicBlocks 不进历史的语义：**失败事件必须进历史**）。followUp 续跑段的 UI 归属是当前 turn 的追加段，origin 样式可降级为普通回复（内容已含「系统事件」前缀，信息不丢）。
- 禁自动 run_* 由文案 + gate 双保险（gate 本就 fail-closed）。

### 6.3 限流与去重（防 token 失控）

| 规则 | 值 |
|---|---|
| 单条 record 注入次数 | ≤ 1（事件幂等键 = recordId） |
| 单 session 注入频率 | ≤ 2 次/小时（在线代理判据见 §6.0-1；若退化方案则收紧为 1 次/小时） |
| 同因连败 | 同一 nodeId 连续 2 次同 errorCode → 第 2 次只 followUp 简报，不再开新 turn |
| turn 进行中 | 一律走 followUp（收尾边界消费，不打断在途生成，见 §6.1.1）；注意 steer 竞争可能致延后（§6.0-3） |

### 6.4 UI 呈现

newTurn 路径：system-origin turn 在侧栏以**系统事件样式**渲染（非用户气泡；左侧竖线 + 「系统」标签），对齐 WorkBuddy task-notification / Claude Code hook 通知的形态。前端靠 prompt 元数据 `origin: "system"` 区分（`chat/conversation` 请求体加可选字段，透传到事件流）。
followUp 路径：**无 origin 元数据通道**（lane 消息是纯 user-role 文本，`agent.service.ts:595-599`），UI 归属为当前 turn 的追加段，样式降级为普通回复——内容已含「[系统事件·生成失败]」前缀，信息不丢。不为其发明元数据通道（YAGNI，见 §8）。

### 6.5 遥测与回滚

- 遥测：`generation_recovery_dispatch_total{path=followUp|newTurn|skip, reason}`、在线代理窗口命中率、回注后用户动作分布（重试/换模型/放弃）、回注 turn 的 token 消耗分布。
- 回滚：`runtime-config` 加 feature flag `generation_recovery_enabled`（默认 off，灰度开）；flag off 时行为与今天逐字节一致。

---

## 7. 验收清单

- [ ] PR1：`settleNodeError` 收口单测（8+ patch 点行为不变）；toast 出现 + 点击落诊断 tab；诊断抽屉动作段新增「让 Agent 诊断」（预填不自动发）；**MediaInspectorDrawer 既有 refund-retry 测试全绿**（防回归碰坏 S2-3）。
- [ ] PR2：工具描述改动过 `tiering.test.ts` 归属声明（仅描述变更，归属不变）；after_tool 纠偏纯函数单测 + 注册序不破坏 `result-signal-wiring.test.ts`；golden case 进 eval；`pnpm prompt:lint` 确认预算未动。
- [ ] PR3：决策核纯函数全分支单测（含 steer 竞争延后与 run 结束竞态两个边界）；flag off 回归 = 现状；限流三规则各有测试；`runs/events` lastSeenAt 落点不破坏既有 SSE 测试；system-origin 渲染样式快照。

## 8. 非目标

- ⑤ 费用/积分展示统一（单独 PR）。
- 成功终态不回注（节点本身即交付物；注入纯耗 token）。
- 自动重试生成（HITL gate 红线，永远由用户确认）。
- 纯文生视频的 prompt 质量规范（本期只管图生视频；文生视频方法论后续可复用同一 skill 注入通道扩展）。
- followUp 路径的 origin 元数据 / 系统事件样式（纯文本前缀已够用，不为一条通知发明通道）。
