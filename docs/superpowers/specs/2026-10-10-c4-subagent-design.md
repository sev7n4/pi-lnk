# C4 子代理（只读 Explore 型）设计规格

| 项 | 值 |
|---|---|
| 版本 | v1.2.0（implemented；v1.0.1 补网络出口裁决 §3.3/§4-8，v1.1.0 补 §5-8 白名单逐项断言，v1.2.0 实现收口） |
| 状态 | 已实现（feat/c4-subagent → PR 待合并；实现与 spec 的两处有意偏差见 §7） |
| 日期 | 2026-10-10 |
| 上游 | `2026-10-09-task-management-module-design.md` §3 C4 |
| 决策人 | 用户（七项拍板，见 §4） |

## 1. 背景与动机

任务管理模块对标调研（总体设计 §1）L4 层 = 并行执行 / 子代理 / 专家团。WorkBuddy 实测证据：子代理是高频形态（Agent/Task 工具 + subagent_type 全家桶），用户问题中「派个代理去查/研究」类诉求真实存在。

pi-runtime 现状：单 session 单 run 串行对话，模型遇到「大范围调研」只能靠自身上下文硬扛（挤占主对话窗口、把中间探索过程全部写进主 transcript）。C4 一期引入**只读 Explore 型子代理**：模型可派发一个带独立上下文窗口的子会话做调研，只把最终报告带回主对话——主对话窗口不被探索过程污染，调研深度不再受主窗口预算挤压。

**为什么现在做**：C1（任务卡）/C2（轮次硬边界）/C3（Plan 确认门）已全部上线，per-run 钩子范式（run_start/turn_start/run_end/before_tool/before_run_end）与规模控制机制（turnBudget、watchdog 结算）齐备，子代理的规模三件套可直接复用，无需新建机制面。

## 2. 目标 / 非目标

**目标（一期）**
1. `spawn_subagent` 工具：模型自主派发只读子代理，同步阻塞返回最终报告。
2. 严格只读白名单硬边界（架构保证，非 prompt 约束）。
3. 规模三件套硬编码默认：并发 2（全局）/ turn 预算 30 / 单次 run 超时 5min。
4. 结果回流：报告 = 工具返回值（跨压缩存活同 C1 机制）；事件流透出子代理卡片；子 transcript 落盘持久化但不建查看 UI。
5. 子代理内保留 C1 现状 todo_write（fork session 隔离，不污染主会话）。

**非目标（一期明确不做）**
- 异步派发 + 通知机制（不做协议预留位，见 §4-6）。
- 子代理完整 transcript 的前端查看面（数据落盘，UI 等派发率数据）。
- fork 裁剪 / 上下文压缩（成本痛了再设计，见 §4-7）。
- C1-B id 化清单（依赖环裁决，见 §4-5）。
- 可写工具 / 专家团 / 用户显式发起 UI。

## 3. 设计

### 3.1 触发与工具形态

新增 `spawn_subagent` 工具，注册进 pi-runtime 工具面（`tools/config.ts`），ALWAYS_ON（被点名才常驻的同款规则不适用——派发是模型自主行为，常驻暴露成本低，入参 schema 自说明）。

```
入参：{ task: string }            // 任务描述（模型自己写清楚背景与期望产出）
出参：{ report: string, usage: { turns, durationMs } }
```

- 派发语义：模型在任意轮次调用 → 同步阻塞至子代理结束 → `report` 作为工具结果进入主对话。
- 报告与普通工具结果同构 ⇒ 跨压缩存活、前端零迁移、协议零新增（三个设计原则全收）。

### 3.2 上下文载体：纯 fork（裁决 A）

子会话经 vendor `SessionRepo.fork()`（实证：`vendor/.../agent/src/harness/session/types.ts:600`）复制主对话历史。

- 子代理带着「当前在做什么、刚讨论过什么」的背景做调研，质量优先——一期派发率未知，先保证核心变量（调研质量）成立。
- token 成本由三件套天然设上限（并发 2 × 预算 30 × 超时 5min）。
- 裁剪（截到最近 N 轮）是二期机制：等真实数据出现成本痛点再设计截断语义，一期不做任何预留。

### 3.3 工具边界：严格只读白名单 + 网络出口单列

子代理会话注入工具时按**白名单过滤**，非 prompt 约束。边界按**副作用面**三类划分，不按「读/写文件」二分：

| 类别 | 一期处理 | 例子 |
|---|---|---|
| 本地只读 | ✅ 进白名单 | canvas 读族 / read_document / recall_memory / 列表族（以 `tiering.ts` 实际分类为准） |
| **网络出口（net-egress）** | ✅ **显式裁决进白名单**（裁决 8，§4） | `web_search` / `web_fetch` |
| 状态写入 | ❌ 物理不在工具表 | 写域 / gen / destructive / `save_memory` |

- 白名单硬边界 = 架构保证：写域工具物理不在子代理工具表，模型「想写也调不到」。
- `spawn_subagent` 自身不进白名单（禁止嵌套派发，一期不做子代理树）；`ask_user` 不注入（子代理不与用户交互，避免多会话并发确认卡撞车）。

**网络出口（web_search / web_fetch）的专项裁决与风险记录**：

- **进白名单的理由**：①护栏三层已成熟且子代理继承零新增——应用层 private IP 校验 + 超时/字节上限（`tools/web.ts` isPrivateIPv4）、Tavily 服务端代理隔离（SSRF 面在 Tavily 侧消解）、netpol egress 白名单兜底（DNS rebinding 为已记录余留风险）；②调研型 Explore 的核心价值就是联网查资料；③若只禁子代理联网而主会话可查，会逼模型在主对话里自己查——**恰好污染 C4 要保护的主窗口**，违背立项初衷。对标 Claude Code：Explore/Plan 子代理包含 WebSearch/WebFetch。
- **风险 1（数据出域）**：fork 复制了完整主对话历史，子代理生成的 search query 理论上可能携带对话中的敏感内容。业界普遍接受该风险（query 是模型生成的摘要性文本，天然最小化；Claude Code 同款暴露面）；一期记录该面不做强隔离，靠 §5-8 审计可观测。
- **风险 2（不可信内容入域/间接注入）**：网页内容 → 子代理报告 → 主会话，是间接注入通道。缓解：报告作为**数据**回流（工具结果 role 边界，主会话 prompt 既有防御不变）+ 报告长度上限（一期 20k 字符，与 `FETCH_MAX_CHARS` 同量级）。
- 不对标 Codex 严派（read-only 默认断网）：其护的是不可信沙箱环境；我们子代理与主会话同信任域、护栏同款，断网收益低于调研能力损失。

### 3.4 规模三件套（硬编码紧默认）

| 项 | 值 | 实现 |
|---|---|---|
| 并发 | 2（**全局**，跨会话共享） | 全局信号量；第 3 个并发 spawn 请求 fail-soft 报错（「子代理并发已满，稍后重试」），不排队不挂起 |
| turn 预算 | 30 / 子 run | 复用 C2 turnBudget 状态机（`gate/turn-budget.ts`），实例化参数覆盖，机制零新增 |
| 单 run 超时 | 5min | 复用 stall watchdog 结算路径（cancelRun + forceSettleLaneOperation + userAborted 语义） |

- 全部**硬编码不可禁用**（无 env、无 kill switch）：三件套是安全边界不是功能开关；「可关不可破」原则此处取「不可破」。kill switch 语义收口：`spawn_subagent` 工具注册整体受既有工具面开关管理，但三件套本身无旁路。
- 硬停行为：超预算/超时的子 run 按 C2 同款结算，spawn 工具返回 fail-soft 报告（「子代理达轮次上限，已回收，部分发现如下：…」——若子会话已有部分产出则附带），不抛异常打断主 run。

### 3.5 结果回流与透出

- **报告**：工具返回值（§3.1）。
- **事件卡片**：子代理生命周期经既有事件管道透出（spawned → running → completed/failed，含耗时/turn 数/摘要），C1 任务卡同族形态，前端零迁移。
- **transcript**：fork 子 session 是 jsonl repo，落盘天然持久化——采集层零成本；一期不建查询 UI，审计盲区刻意保留，等派发率数据说话。
- **用量**：子代理 LLM 用量沿用既有 session 级回流管道；实现计划须实证管道按 sessionId 还是 threadKey 聚合，确保子代理用量**不丢总量**（若按 sessionId 聚合则子会话单列、metadata 标 parentSessionId，不做静默合并）。

### 3.6 与 C1/C2/C3 的关系

| 机制 | 子代理内行为 | 理由 |
|---|---|---|
| C1 todo_write | 注入，全量覆写模式照旧 | fork session 隔离，子清单不污染主会话；过程透明化支持主对话 steer |
| C2 turnBudget | 生效，预算参数 30 | 同一状态机实例化，机制零新增 |
| C3 plan-gate | **不注册** propose_plan、不注册 gate 钩子、不播种 | 只读子代理无写可拦，gate 无意义；ask_user 确认卡不注入（§3.3） |
| watchdog | 生效，超时 5min | 同一结算路径 |

## 4. 关键裁决记录（用户拍板，2026-10-10）

1. **触发 = 工具化自主派发**：模型自主 + 前端只透出，与 C1/C3 范式一致。
2. **工具边界 = 严格只读白名单**：架构硬边界，非 prompt 约束；拒绝「继承全量 + prompt 约束」与「预留可写开关位」。
3. **三件套 = 硬编码紧默认**（并发 2 / 预算 30 / 超时 5min）：宁紧勿松，等真实流量再调；拒绝 env 可配（不做半开语义面）。WorkBuddy 对标（并发 20 / 30min / 500 turns）原则照抄数值不抄。
4. **回流 = 报告 + 卡片，transcript 静默落盘不建 UI**：验证期资产压到最薄；fork 子 session 天然落盘，二期加查看面无需改采集。
5. **C1-B 不拉起，子代理内用 C1 现状**：总体设计「C4 依赖 C1-B id 化」在只读语义下是伪依赖（子代理不写共享状态，产出=报告），依赖环自动消解；C1-B 触发条件（并行清单需求真出现）未证实，不提前立项。
6. **同步阻塞返回，不预留异步位**：验证期不建编排基础设施（通知机制/pending 状态机/并发调度器）；「预留 background 参数」是伪灵活——未来异步的真实形态现在想象不准，届时扩工具 schema 即可。
7. **载体 = 纯 fork**：调研质量优先于 token 成本；裁剪是二期机制，有真实成本 case 再设计语义。
8. **网络出口进白名单（宽派）**：web_search/web_fetch 显式裁决进子代理白名单（2026-10-10 追问拍板）——护栏三层已成熟零新增、调研核心价值、主会话可查而子代理禁查会反向污染主窗口；风险两面（出域/入域）记录见 §3.3，不对标 Codex 严派（同信任域 + 护栏同款，断网收益低于调研损失）。

## 5. Review Focus（实现计划的测试面）

1. **fork 正确性**：子代理上下文含主对话历史（faux 集成断言子会话首 prompt 前可见主对话内容）。
2. **白名单硬边界**：子代理工具表物理缺写域工具（断言工具注册表，非 prompt）；`spawn_subagent` 不在白名单（无嵌套）。
3. **并发 2 全局闸**：第 3 个 spawn fail-soft 报错不挂起；不同会话的 spawn 共享同一计数。
4. **预算/超时硬停**：预算 30 超限复用 C2 结算（userAborted 不进错误率）；5min 超时同路径；spawn 返回 fail-soft 不打断主 run。
5. **用量不丢**：子代理 usage 汇入主会话统计或单列 metadata（按 §3.5 实证结论），断言总量守恒。
6. **C3 旁路**：子代理内 propose_plan 不注册、plan-gate 钩子不注册、不播种。
7. **异常隔离**：子代理 LLM 上游失败 → spawn 返回错误报告，主 run 正常继续；子代理 transcript 落盘完整。
8. **白名单内容断言**：本地只读族 + `todo_write` + `web_search`/`web_fetch` 在子代理工具表；`save_memory`/写域/`ask_user`/`spawn_subagent` **不在**（逐项断言注册表，防「猜名单」空集假绿）。web 工具调用经事件管道透出可审计（tool_start 同款）。
9. **主 run 不回归**：子代理存在期间主会话 SSE 事件流正常（卡片 + 主对话事件不串线）；C1/C2/C3 既有测试全量不回归。

## 6. 里程碑

- **一期（本 spec 范围）**：§3 全部 + §5 测试面。
- **二期候选（各有触发条件，均未立项）**：fork 裁剪（成本 case 出现）/ 异步派发（并行调研需求出现）/ transcript 查看面（审计需求 + 派发率数据）/ C1-B（并行清单需求出现）/ 可写白名单扩展（Explore 语义被证实有价值后评估）。

## 7. 与总体设计的关系

- 总体设计 §3 C4 状态更新为「已立项（本 spec）」；「C4 依赖 C1-B」的依赖声明按 §4-5 裁决改记为「一期无依赖，C1-B 由并行清单需求独立触发」。
- 总体设计 §7 规则 2（upmerge ≥3 minor 全落点重映射）适用于本 spec 全部 vendor 锚点（fork API、事件类型、结算路径）。

## 8. 实现收口（v1.2.0，2026-10-10）

实现 = `feat/c4-subagent` 分支六提交（gate 常量/白名单/并发闸 → metrics 观测 → spawn_subagent 工具 + piSessionKey 上下文 → SessionManager.runSubagent → 端到端集成 → 本收口）。测试面：单测 9+28+5+3、集成 6，全量串行回归见 PR。

**与 spec 的两处有意偏差**（效果等价或更严，注释已在产码锚点）：

1. **超时机制**：spec §3.4 说「复用 stall watchdog 结算路径」，实现用 `withCancel` 子 context + `run.cancel()`——与主会话用户「停止」完全同路径，vendor 以 aborted 语义正常结算（不进错误率），无需 forceSettle（那是挂死兜底，超时 cancel 不挂死）。机制更薄，效果与 spec 意图一致。
2. **超限状态可区分**：spec 原案超限落 "failed"，实现经 settled 闸细分为 `budget_exceeded`（forceSettle 会把 run 折叠成正常 completed，run 终态不可信，settled 是权威信号）——metrics 由此可分型观测。

**实现期新增的三个 vendor 事实**（spec 未覆盖，均已写入产码注释 + 测试锁定）：

- fork 还原的盘上 lane config 带**来源会话**全量 activeToolNames（restore.ts 原样还原，seed 只对新建 lane 生效），与白名单 config.tools 不一致会撞 vendor generation 校验 `configured_tools_unavailable`（run 直接 failed）——修复 = build() 快照 `entry.subagentToolNames` + `lane.setActiveTools` 覆盖（写 fork 出的子会话存储，不触主会话）。
- `lane.prompt` 的 `result.ok` 只是 operation 信封（跑到终态），run 真实状态在 `result.value.status`（TerminalStatus：completed/declined/aborted/failed）——配置失败也是 ok:true+failed，读错会把失败静默报成 completed。
- 预算硬停/超时/取消都经 cancel(run.context) 表达，vendor 对在途 run 以 throw AbortError 结束——runSubagent catch 后按可见状态归类，绝不外抛（SubagentCoordinator 契约：promise 永不 reject）。

## 9. 评审收口（fresh reviewer 终审 → 修后合并，2026-10-10）

**C1（Critical，已修）**：todo/plan 内存 store 作用域与画布 id 解耦——新增 `entry.storeScopeKey`
（常规会话 = canvasSessionId ?? key 逐字节旧行为；子会话 = 自身 pi 键），贯穿 toolContext
（`storeScopeKey` 字段）、todo_write 写侧、动态块读侧、build 播种四处。修复前：主会话带
canvasSessionId（生产常态）时子 run 的 todo_write 直接覆写主会话 C1 清单，fork 隔离被击穿；
且既有测试全部不传 canvasSessionId——「测试绿功能死」典型，新增带 canvasSessionId 的回归测试。

**I1（已修）**：子会话跳过 plan-gate 钩子（`isSubagentSessionKey` 键形状判别，onSessionCreated
装配点跳过）+ 跳过 plan 播种（fork 快照回灌会回退主会话闸门决策）。裁决记录：plan-gate 是
主对话语义，子代理无 propose_plan（白名单排除），闸门对子无意义。

**I2（已修）**：主 run「停止」传播——spawn 工具透传 chordCtx.abortSignal → tryRun opts →
runSubagent 联动 run.cancel；用户中止归类 failed（非完成/超时/超限的诚实语义）。

**I3（已修）**：超时计时器起点提前到 fork 之前（原只盖 lane.prompt）；fork 传 run.context
可被 abort 打断，打断且已超时归类 timeout；build 段结束若已超时短路返回。残余暴露面 =
build 本地 IO 挂死（风险极低，注释留痕）。

**Minor 处置**：M1 abort 归类 failed（接受，注释留痕）；M2 死截断删除（截断唯一属主 =
runSubagent）；M3 budget 计数混同（接受，outcome 分型可对账）；M4 内容级 fork 断言已补
（子 run LLM 请求上下文含主对话文本）；M5 meta.json 指纹覆写（公共 fork 同病，接受）；
M6 跨会话共享计数已补测试（另一会话 spawn 同撞全局闸）。
