# 架构审视：propose 全链路断裂的根因与治本方案（执行权收编）

> 2026-10-29 · 起因：真机回归（thread cmvtadc5w009ap901qxfpcelz，「生成一只老虎，推荐风格构图」）
> ⚠️ **本文已被红队审核修订**：见 `2026-10-29-agent-authority-model-redteam-review.md`（v2 定稿：三权归一 + 挂起持久化 + 事件注入）。本文保留为 v1 推理留痕，其中「L1 runtime 自起生成」「终态走 notify→followUp」两处已被修正，「notify→followUp=上游正统」须降级为自建映射。
> 方法：重读上游 pi-agent 源码（packages/agent harness、coding-agent extensions）+ 生产取证
> （SQLite 事件流 / nginx access log / GenerationRecord）+ 行业交互模型对照。
> 结论先行：**这不是四个 bug，是一个架构缺陷的四种表现——「确认」与「执行」的责权被拆到两个进程。**

---

## 1. 生产事故重放（证据链摘要）

| 时刻 | 事件 | 证据源 |
|---|---|---|
| 16:34:11 | 用户发消息，主 SSE 开流 | nginx |
| 16:34:40 | ask_user（风格/构图）→ 用户作答 ✓ | DB 事件流 |
| 16:34:49 | upsert_media_node：**prompt 已写入节点 data 并落库** | DB |
| 16:34:59 | propose_generation：Nest 内部端点置**服务端 SSOT** pending_confirm；客户端可见的 `update_node{pending_confirm}` 挂在 tool_result 上**延迟下发** | DB + canvas-write.ts `withWriteSignal` |
| ~16:35:1x | 用户点「定位」切画布 → 客户端节点仍是 draft → 无确认/取消面、磁贴不渲染提议内容 | 前端门控逻辑 |
| 16:35:31 | **主 SSE 断开**（切页/网络）；客户端 16:35:35 标记「生成失败·网络连接不稳定」——**误报**，服务端 run 活着 | nginx + 前端失败归因 |
| 16:35:40 | 用户点对话内联卡「确认生成」→ POST /answers 201 ✓ | nginx |
| 16:35:40→16:48:40 | runtime `waitForGenerationTerminal` **空轮询 13 分钟**（capMs=780s）等一个从未启动的生成 | canvas-write.ts + DB |
| 16:39:10 | SSE 重连回放，卡片仍 pending；16:41:24 再点确认 → 404（callId 已消费） | nginx |
| 16:48:40 | cap 到期 → timeout → tool_result「生成仍在进行（已等待 13 分钟）」 | DB |
| 16:48:46 | 模型回复「已提交生成请求，正在处理中」（虚假陈述）→ turn_settled | DB |

`GenerationRecord` 零行 = 生成请求从未启动。期间画布页每 3s 的 PUT /sessions（整份替换）把服务端 pending_confirm 反复盖回 draft。

## 2. 上游 pi 的交互模型（源码考古，修正此前的模糊引用）

1. **「工具内阻塞等待用户」是上游正统模式**。coding-agent 的 extension API：`ctx.ui.confirm/select/editor`（`extensions/runner.ts:445`、`types.ts:138`）——工具/hook execute 内 `await` 一个由宿主 UI 兑现的 Promise。我们的 ask_user（`registry.waitForUser`，/answers → registry.resolve HTTP 桥接）是这一模式的正确移植。**ask_user 链路没有架构问题。**
2. **上游回合编排原语**：lane 的 `steer`（运行中注入）/ `followUp`（回合外排队开新一轮）/ `waitForIdle` / `resume`。我们 2026-10-18 落地的 `notify-generation → followUp`（session-manager.ts:2202，生成终态时 Nest 推送、无等待者则入 followUp 队列开新回合通报模型）**就是上游 followUp 语义的正确使用，且已经建成**。
3. **`drive/deferred.ts` 是模型 API 侧的延迟补全轮询**（stopReason="deferred" 的续拉），与工具审批无关，勿混淆。

**上游没有的模式**：一个阻塞工具等待*另一个进程*去做它自己该做的事，再用启发式轮询去猜「对方做了没有」。

## 3. 行业不变量

Claude Code 的 permission prompt、Codex 的 approval flow：**审批门在工具生命周期内部——批准后由同一个工具继续执行动作，结果回到模型**。没有任何成熟 agent 把「启动被批准的工作」委托给客户端 UI，再用状态轮询去猜结果。

## 4. 根本缺陷：一个，不是四个

**propose_generation 把「确认」与「执行」拆到两个进程：**

- runtime 等确认（registry 竞臂），但**信任前端**去启动生成（历史不变量「确认动作只存在于画布节点」= CanvasPage `handleAgentGenerateNode` = confirmProposeWait + `generateForNode`，生成启动器是前端）；
- 确认后 runtime 空轮询 13 分钟等一个**自己没启动的任务**（2026-10-18「回合挂住等终态」）。

为缝合这个拆分，系统长出**四个补偿机制**，全是同一缺陷的症状：

| # | 补偿机制 | 症状 |
|---|---|---|
| 1 | SSOT 轮询臂 + draft×2 启发式 + stale_status fail-closed | runtime *猜*前端启动没启动 |
| 2 | 前端 L2 本地同步（propose-wait-start emit → 本地置节点 pending_confirm） | 因服务端 update_node 延迟到 tool_result 才下发，前端只能自己补状态；#635/#637 误判为死代码删除 → 本次画布确认面消失 |
| 3 | notify-generation 抑制逻辑 | 工具持有等待期要抑制推送，防双报 |
| 4 | 提示词禁令 + gate runs===0 拦截 run_* | 模型最自然的动作（自己启动生成）被硬拦 |

服务端 internal `propose-generation` 端点本就有写 SSOT 的能力（置 pending_confirm 证明这点）——它同样有能力直接启动生成，却没做。

## 5. 治本方案（三层）

### L1 治本：执行权收编（propose confirmed 后由服务端自起生成）

- registry 返回 `answered` → **runtime 直接调 Nest 生成启动 API**（与前端 `generateForNode` 消费同一服务端入口；runtime 已有 nest-client 通道）。
- 启动成功后工具**立即返回**「生成已启动」——**不等终态**。终态报告走已建成的 `notify-generation → followUp` 推送（正统上游模式），删除抑制逻辑（不再有「工具在等」与推送竞争）。
- 一次性消灭：轮询臂全部启发式（draft×2/stale_status/404 容忍）、capMs 13 分钟持有与假文案「生成仍在进行」、「确认必须在画布节点」不变量、内联卡接生成链的前端补丁需求、移动端无确认入口问题（**内联卡只 POST /answers 从此变正确**）。
- run_* 禁令可降级为「优先 propose_generation」的引导性规则。

### L2 一致性：服务端状态变更即时广播

- internal propose-generation 置 pending_confirm 时**同步广播** `update_node` 给在线客户端（SSE 事件通道已存在），不再搭 tool_result 便车。客户端从此不需要任何本地状态仿真，L2 emit 永久不需要复活。
- saveCanvas 整份替换 PUT 的盖写防护收进服务端（服务端拒绝对 pending_confirm 节点的 draft 降级写入）；前端 mergeNodeData 守卫保留为纵深防御。

### L3 体验：流断 ≠ turn 失败

- waiting_user 挂起期 SSE 断开，客户端不得标记 turn 失败（turn 事实存活；等待态已由 timeline part 单一真相呈现）。
- SSE 重连对账：/answers 404 → 将对应 part 翻终态而非留 pending。

## 6. 被否决的备选

- **X：前端内联卡接 handleAgentGenerateNode**（此前 P0-1 提案）：维持双执行者 + 轮询启发式，且每个新入口（小程序/API/子代理）都要重复接生成链。否。
- **Y：模型 answered 后自己 run_***：run_* 的 gate/幂等语义与 propose 节点绑定不一致，prompt 禁令有存在理由。半否（可作为 L1 内部实现细节：runtime 内部复用 run_* 的 Nest 调用路径，但非模型层调用）。
- **Z：回滚 #635/#637**：恢复 blockingWait 等僵尸镜像，与等待态单一真相主线相悖。否。

## 7. 影响面

| 层 | 改动 |
|---|---|
| pi-runtime canvas-write.ts | 删轮询臂/竞臂/capMs 持有；answered 后接生成启动 API；立即返回 |
| pi-runtime session-manager | notify-generation 抑制逻辑简化（可整体移除该路径的抑制分支） |
| Nest | propose-generation 端点增加生成启动（或 runtime 直调生成端点）；pending_confirm 即时广播；saveCanvas 服务端盖写防护 |
| web | 内联卡确认保持只 POST /answers（语义自然变正确）；overlay 移动端门控可放开（可选）；删 waiting 期 turn 失败标记；/answers 404 对账翻终态 |
| 兼容 | `PI_RUNTIME_GEN_TERMINAL_WAIT_MS` 保留为过渡开关（极小值≈新行为） |

## 8. 自审（充分性/遗漏）

- ask_user 链路不动（已对齐上游 Promise 模型）。
- cancel 路径（decline / clear-propose）不受影响：取消本就无需执行权。
- 多节点并发 propose：执行权在 runtime 单点，天然避免前端多入口竞态。
- 遗留风险：notify-generation 依赖 Nest 侧生成终态回调已建成（late-generation-notify.ts），L1 上线前需验证其可靠性与幂等。
