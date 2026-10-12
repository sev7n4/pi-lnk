# 工具结果质量信号层设计规格（P0 契约 + P1 信号 listener）

> Status: DRAFT → 待用户评审
> Date: 2026-10-12
> 输入: `docs/agent/tool-result-quality-signal-gap.md`（缺口分析 §3.6/§8/§9/§十）
> 决策记录: 架构方案 C（混合）经三视角推导选定；规格覆盖 P0+P1，实施分两批（P0 先、P1 后，各自独立 PR + 验证）
> 校对基准: feat/tool-details-contract-p0 @ Task 1 提交（result-signal.ts），偏差见附录 A

## 1. 目标 / 非目标

**目标**

- G1（P0）：P0 范围 8 文件 / 15 工具（§3.6 清单）获得类型化 `details` 契约——每工具族显式 `TDetails` 泛型 + 类型守卫 + 机检脚本。
- G2（P1）：信号 listener 按 tier 治理（gen / write_light / graph_batch / destructive / read 共 5 个 tier），对异常结果注入自解释短告警；成功静默。
- G3：为已知生产病例提供可判读信号——agnes 429（retryable 不可判读）、canvas-write 缺 confirmed、get_canvas_summary 局部当全量（静默答错）。

**非目标**

- delete-nodes before_tool 审批（数据驱动，误删率 metrics 触发才立项）。
- confidence / freshness 字段（YAGNI：规则推断 confidence 制造虚假信任；freshness 待 web 工具病例出现再做）。
- session 级信号持久化 / transform_context 重注入（压缩丢告警为已知限制，V2 由 metrics 触发）。
- `terminate` / `prepareArguments` / checkpoint 恢复（P3，replay 幂等性评估前置）。
- present / skill / ui_command tier 不进信号层；被拦/参数错类结果不覆盖（`drive/tools.ts` 不经过 after_tool，其 block reason 自带可感知文本）。

## 2. 契约层设计（P0）

### 2.1 通用信号 schema

```ts
export interface ToolResultSignal {
  status: "ok" | "partial" | "failed";
  /** 规则启发式（§5 映射表）：true ⇒ 模型应退避重试而非改 prompt。 */
  retryable?: boolean;
  truncated?: boolean;
  /** read 类工具：防「局部当全量」静默答错（get_canvas_summary 病例）。 */
  coverage?: "full" | "partial" | "empty";
  errorCode?: string;
}
```

裁定（相对缺口分析报告稿的三处收紧）：

- **砍 `tier` 字段**：tier 已有注册面单一事实源（`tiering.ts`），信号内重复携带违反 SSOT；listener/metrics 需要时查表补。
- **砍 `affectedNodeIds`**（评审拍板）：节点明细已存在于 `details.actions`——它是 Nest `extractCanvasActions` 唯一认的前端实时通道（PR #65 踩过「actions 丢失导致画布不更新」）。另开 id 数组 = 第二条重复数据源 + 日志膨胀风险。V1 只留 `affectedCount`。
- ⭐ **实现护栏**：`affectedCount` **必须由工具直报**，**禁止从 `actions` 反推**——`actions` 与受影响对象非 1:1（一条 action 可覆盖批量），反推会得出错误计数，属「从既有信号推断而非报事实」反模式。
- **status 枚举取 `ok|partial|failed`**：`failed` 比 `error` 更明确，且不与 vendor `isError: boolean` 语义纠缠。

### 2.2 工具族 TDetails 契约（8 文件 / 15 工具）

| 工具族 | 文件 | TDetails 必填字段（通用 `_signal` 之外） |
|---|---|---|
| gen | generation.ts（run_image/video/text/prompt/audio_generation、propose_generation、grid_slice_image） | `modelUsed: string`、`generationParams: Record<string, unknown>`、propose_generation 另有 `confirmed: boolean`（gate 消费中，保留） |
| write_light | canvas-write.ts、arrange-nodes.ts | `affectedCount: number`、canvas-write 错误路径保留 `{ok, confirmed}`（`textRaw` 路径现为 `details: undefined`，须补齐） |
| graph_batch | canvas-write.ts（render_canvas_view 路径） | 沿用现有 `canvasCommands` 契约，仅补 `_signal` |
| destructive | delete-nodes.ts、remove-edges.ts | `affectedCount: number` + `actions`（resultWithActions 既有，保留不动） |
| read | canvas-read.ts（get_canvas_summary） | `coverage: "full"\|"partial"\|"empty"` + `scope: string`（枚举了哪些节点/边被采样） |
| present | present-result.ts、propose-plan.ts、ask-user（随批类型对齐） | 沿用 `{ok, canvasCommands, truncated?}`，仅 TDetails 显式化 |

- 每族导出类型守卫 `isGenDetails` / `isWriteDetails` / `isDestructiveDetails` / `isReadSummaryDetails`（守卫校验必填字段存在性与类型，不校验 `_signal`——后者由 `isToolResultSignal` 独立守卫）。
- `_signal` 键名带下划线前缀：与工具自有业务键区隔，避免未来工具声明自有 `signal` 键冲突（框架注入键约定）。

### 2.3 机检脚本

`scripts/verify-tool-details-contract.ts`（对齐既有 `verify-tool-contract.ts` 形态）：

1. 清单校验：§2.2 的 8 文件与实际修改文件一致（image-refine.ts 无直接 return 点，由 generation.ts 流路覆盖——仅校验其存在清单内）。
2. 守卫存在性：每族导出的 `isXxxDetails` 可被 import 且类型正确。
3. 必填字段：AST 或类型层校验 TDetails 泛型已显式（禁 `unknown` 缺省）。
4. `_signal` 键名规范：grep 断言 `details.signal`（无下划线）在 8 文件中零命中。

## 3. 工具侧产出（P0）

- 统一 helper `withSignal(base, signal)`：包装 execute 返回值，展开保留全部既有 details 键（`actions`/`confirmed` 是消费方契约，绝不能丢）。
- 信号来源分工（方案 C 核心）：
  - **工具产出**（可信源头的事实字段）：status 原始判定、errorCode（含 `error_code` 归一）、coverage、**affectedCount（工具直报）**、modelUsed。
  - **单点分类层**（`result-signal.ts`，工具侧 helper 调用）：status 归一 + retryable 判定——retryable 在工具侧随 `details._signal` 落地（Task 1 形态）；**retryable 判据复用 vendor 分类器薄适配层**（§5），本地域分类（empty_result/invalid_params/fallback_pending/coverage）同模块单点，禁止第二份拷贝。
  - **listener 推断**（P1，单点可测）：短告警文本生成、tier 查表、truncated 终判（依赖合并 after_tool listener 截断后的最终 content；工具预填值为缺省，listener 可覆写）、**请求数 vs 生效数对账**（§4，event.args 原生携带）。
- 分类所在模块 `result-signal.ts` 为**单点**：工具侧 helper 与 P1 listener 复用同一模块，禁止第二份拷贝。

## 4. 信号 listener 设计（P1）

- **注册序硬约束**：必须注册在既有**合并 after_tool listener（`index.ts:85`，内含 propose 记录 + 体积观测 + capToolResult 截断）之后**——`HookMap` 多 listener 为链式 replace（`hooks.ts:305-324`：每个 handler 收到 `{...event, ...current}`），后注册者看到前者的 patch；截断终判依赖最终 content 状态。
- **⭐ 对账判据（write/destructive 主校验）**：`after_tool` event 原生携带 **`args`**（HookMap 实证）——listener 用「请求数 vs 生效数」判读副作用是否发生：如 `delete_nodes` 的 `args.ids.length` vs `details.affectedCount`，`canvas-write` 的批量请求数 vs `affectedCount`。比「count>0」强：能识别「部分生效」（请求 5 生效 3）。
- **注入纪律**：成功（status=ok 且无 truncated/coverage 告警）**零注入**；异常才注入一行自解释短告警，15-30 token 预算，格式 `⚠️[<tier>] <现象> <模型可考虑的动作>`，例：`⚠️[gen] rate_limited 可退避重试`。格式必须自解释——系统提示预算仅剩 3 字符，禁止在 prompt-registry 加解读规则。
- **注入位置 = 尾部追加**（评审拍板，与 `tool-result-budget.ts:117` 既有惯例一致）：追加到最后一个文本块末尾。理由：① 不破坏可解析 content（部分工具 content 是 JSON）；② 不改变 UI 渲染位置；③ 模型最后读到的内容权重最高。叠加顺序固定：「正文 → 截断 marker → 信号行」。
- **注入通道分工**：模型可感知文本 → `content`（尾部追加）；结构化信号 → `details._signal`（模型不读 details，供 UI/metrics/hook 链消费）。
- **⭐ details patch 护栏（整字段替换陷阱）**：vendor 聚合是**整字段替换不是深合并**（`hooks.ts:315`）——listener 的 details patch 必须 `{...event.details, _signal}` **展开合并**，否则抹掉前序 listener 的 details patch。golden case / 单测锁定此行为。
- **⭐ patch 面纪律**：`after_tool` patch 还能改 `usage`/`terminate`/`isError`（HookMap result 类型实证）——**本 listener 显式禁止触碰这三个字段**，只改 content + details（改 isError 会干扰 gate 的错误判读，改 terminate 会直接终止 agent loop）。
- **kill switch 接线形态**：按 `loadRuntimeConfig(process.env)` 既有惯例——新增 `resultSignals` 配置项，`hookCfg.resultSignals === false` 时 listener 不注册（镜像 `toolResultBudget === false` / `trustBoundary !== false` 门控风格）；一次解析，不在 handler 内读 `process.env`。
- **读非类型化 event 字段**：一律用既有 `readStringField` / `readBooleanField`（hook-contract.ts）fail-soft 助手（`index.ts:90` 惯例），禁 `as` 强转——event.args/details 类型为 `JsonValue`，上游不保证结构。
- **⭐ handler 容错（靠 vendor 原生遥测，不自建计数）**：vendor 对每个已注册 handler 发 `pi.harness.hook` 遥测 span（`telemetry.ts:453`），`pi.hook.outcome` ∈ {completed, skipped, blocked, failed}，handler 抛错自动标 failed——**静默死亡已被原生覆盖**。本 listener 注册时携带 registration 元数据（`pi.hook.registration_id: "lnkpi.result-signals"`）使 span 可识别；另 `HookErrorReporter` 是 harness 构造注入点，若构造处暴露则接线转发到 metrics（可选加固）。自有 metrics 只留领域信号（§6）。失败时工具侧 `details._signal` 仍在（优雅降级）。

## 5. 错误分类（复用 vendor 原生分类器 + 本地域分类单点）

**核心决策：不自建 retryable 映射表，复用 vendor `isRetryableAssistantError`**（`@earendil-works/pi-ai` `utils/retry.ts`——**已是 pi-runtime 声明依赖**，package.json:15）。理由：① vendor pattern 远比手写 Set 丰富（429/5xx/timeout/network/socket/websocket/stream-ended/gRPC `ResourceExhausted` + 明确 retry-guidance 文本）；② ⭐ **它区分「429 瞬时限流（retryable）」vs「429 配额/计费耗尽（`insufficient_quota`/`out of budget`/`billing` → 不可重试）」——这正是 agnes 429 病例的正确判据**；③ vendor 更新 pattern 时自动继承，消除双份漂移。

**薄适配层**（`result-signal.ts` 单点，唯一接触 vendor 分类器的地方）：

```ts
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
// 该函数只读 stopReason + errorMessage 两个字段 → 合成形状调用，类型上合法：
const retryable = isRetryableAssistantError({ stopReason: "error", errorMessage: rawText } as AssistantMessage);
```

**分类输出（三态语义保持，但判据被 vendor 锐化）**：

| 输入 | status | retryable | 判据 |
|---|---|---|---|
| 有错误文本，vendor 判瞬时可重试（429 限流/5xx/timeout/network 类） | failed/partial | **true** | vendor RETRYABLE pattern |
| 有错误文本，vendor 判配额/计费耗尽（`insufficient_quota`/`billing` 类） | failed | **false** | vendor NON_RETRYABLE pattern——换渠道而非退避 |
| 无错误文本 / vendor 不识别 | failed | **缺省不写（= 未判明）** | 评审拍板三态语义（下） |
| empty_result（本地域事实） | partial | false | 重试同参无意义，提示改参 |
| invalid_params / validation（本地域事实） | failed | false | 改参重试 |
| fallback_pending（本地域事实） | partial | false | 换模型重试编排中 |

**职责边界**：vendor 分类器只判「上游错误文本的可重试性」；`empty_result`/`invalid_params`/`fallback_pending`/`coverage` 是**本地域事实**（工具自己知道），仍由 `result-signal.ts` 单点判定——两者不重叠，禁止在工具文件里第三处写分类逻辑。

**retryable 三态语义（评审拍板，保持）**

- `retryable: true` **仅在确知可重试时写**（vendor 判瞬时类）。
- `retryable: false` **仅在确知不可重试时写**（vendor 判配额/计费类 + 本地域 invalid_params / empty_result）。
- **缺省 = 未判明**：listener 注入 hedge 文本——「⚠️[gen] 上游失败原因未判明；若是瞬时故障，退避重试或换模型通常有效」。既不断言不可重试，也不鼓励盲重试。

依据：vendor `after_tool` 的 patch **只能改 content/details/isError，不能改已发生的副作用**——信号本质建议性、无强制路径（`tool-result-budget.ts:16-17`）。既然无法机械阻止重试循环，极性选择的唯一目标就是**陈述真实**，而非替模型断言。

⭐ **配套后续工单（不在 V1 建）**：`errorCode:"unknown"` 的出现次数进 metrics（§6），**用它驱动根因修复**——把上游 HTTP 429 在生成工具内归类为 `rate_limited`（归类后错误文本带 "rate limit" 字样，vendor 分类器即自动判 true）。信号层只负责如实暴露残余盲区，不越界替上游修分类。

## 6. 运维面（P1）

- **kill switch**：`PI_RUNTIME_RESULT_SIGNALS=off` → listener 不注册（契约层类型化零运行时成本，不受开关影响）。接线形态按 §4：`loadRuntimeConfig` 一次解析为 `hookCfg.resultSignals === false` 门控。回滚 = 环境变量一行，无 schema 迁移。
- **metrics（命名按 `observe*` 既有惯例，对齐 `observeToolResult`/`observeToolResultTrim`）**：`metrics.observeResultSignal(tier, status)` ——领域信号活性探针；`metrics.observeResultSignalUnknown(toolName)`——`errorCode:"unknown"` 单独计数（驱动 §5 配套的上游 429 分类修复工单）。**handler 失败不靠自建计数**：vendor `pi.harness.hook` span（`pi.hook.registration_id="lnkpi.result-signals"`，outcome=failed）原生覆盖（§4）。
- **eval golden cases（4 条，必配，无 eval 的信号层 = 又一个没人盯的静默层）**：
  1. agnes 429 会话 → 信号 `failed/retryable:true` + content 出现退避提示。
  2. canvas-write 返回缺 confirmed → 信号 partial + 重试提示。
  3. get_canvas_summary 局部采样 → 信号 `coverage:"partial"` + content 告警。
  4. ⭐ errorCode 缺失/unknown → **retryable 缺省不写 false** + content 注入 hedge 文本（锁住 §5 三态语义，防回归成保守 false）。
- **生产验收探针**：一次真实 429 会话中 retryable 信号可见（logs/metrics）。

## 7. 生命周期与已知限制

- V1 全部信号为 **turn 级**（随 tool_result 进上下文，轮次结束即随消息压缩）。
- **已知限制**：上下文压缩可能丢弃异常告警——接受，V2 由 metrics 触发后再做。**V2 重注入通道点名 `before_run`**（HookMap 实证：`event.prompt → result.messages`，run 级原生注入通道——比 `transform_context` 更适合「未解决异常结果在 run 开始重述」；届时评估 checkpoint/invocation memo 复用，勿自建轮子）。
- P0 批次与 P1 批次可独立上线、独立回滚：P0 是纯类型层（tsc 强制 + 机检），P1 是运行时行为（kill switch 可关）。

## 8. 验收标准

| 批次 | 验收 |
|---|---|
| P0 | tsc 全绿；`verify-tool-details-contract.ts` 全过；15 工具 TDetails 显式（grep 断言无 `TDetails = unknown` 缺省）；既有测试（含 hook-contract/tiering）零回归 |
| P1 | 4 条 golden case 全绿（含 §4 details 展开护栏的单测锁定）；kill switch off 后逐字节回退（diff content 无信号文本）；metrics 活性探针上线（含 unknown 计数）；注册序断言（listener 注册位置在合并 after_tool listener 之后的机检或测试）；vendor 分类器适配层有单测（429 限流 → true / `insufficient_quota` → false / 无文本 → 缺省） |

## 9. 上游生态吸收点（P3 候选，V1 不启用）

> 评审第二轮从 vendor 源码吸收的两个思想，登记在此防遗忘；均由 metrics/病例触发才立项。

- **`retryAssistantCall`（`@earendil-works/pi-ai`）**：vendor 原生有界退避重试（指数退避 + abort 归一），其 `RetryCallbacks`（`onRetryScheduled`/`onRetryAttemptStart`/`onRetryFinished`）体现实践——**retry 事件必须可观测、绝不静默**，与我们「无静默重试」原则同构。P3 若做 gen 工具级退避重试，直接复用它 + callbacks 接 metrics，勿自建重试循环。⚠️ **计费谨慎**：gen 走内部端点，重试可能产生费用——启用前必须评估幂等性/计费语义（同 replay 工单）。
- **`AgentToolResult.usage`**：vendor 结果类型的原生字段（工具自身执行用量，**不进主上下文计费**）——gen 工具成本透传的未来载体，与 PR #350 cost 接线呼应（P3 候选）。

## 附录 A：Task 1 已提交代码校对裁定（feat/tool-details-contract-p0 · result-signal.ts）

| # | Task 1 现状 | 规格裁定 | 动作 |
|---|---|---|---|
| 1 | `ToolResultSignal` 无 tier 字段 | §2.1 裁定砍 tier（SSOT） | ✅ 一致，无需改 |
| 2 | status 枚举 `ok\|partial\|failed` | §2.1 取 failed | ✅ 一致（设计稿 error 已按此修正） |
| 3 | `withSignal` 写入键为 `details.signal` | §2.2 定 `_signal`（框架注入键约定） | ⚠️ 改键名为 `_signal`（helper + 测试 + future 消费方） |
| 4 | `signalFromUpstream` 含 retryable 映射 | §5 改为 vendor 分类器薄适配层 + 本地域分类单点；**unknown 必须缺省不写 false** | ⚠️ 重构：`RETRYABLE_CODES` Set 作废，改调 vendor `isRetryableAssistantError`（合成形状）；unknown/缺失分支当前返回 `retryable:false`，须按三态语义改为不写该字段 |
| 5 | `signalFromUpstream` 的 fallback_pending→partial/retryable:false | §5 本地域分类保留同判定 | ✅ 一致 |
| 6 | `affectedCount`/族级 TDetails/守卫族 | 属 Task 2-5 范围 | Task 1 未涉及，正常 |
| 7 | `signalFromUpstream` 读 `status`/`errorCode`/`error_code` 字段直读 | §4 惯例：读非类型化数据用 `readStringField`/`readBooleanField` fail-soft 助手 | ⚠️ 对齐：字段读取改走 hook-contract 助手，禁直读/强转 |

## 附录 B：决策记录

- 2026-10-12 流程纠偏：用户指出「规格 → 计划 → 实施」顺序，此前跳过规格直接写计划并实施 Task 1，已暂停并保留代码作校对基准。
- 2026-10-12 方案决策：架构方案 C（混合）——用户授权代为拍板，三视角（vendor 架构约束 / Codex 工程纪律 / 产品 ROI）独立推导收敛；A（纯 listener 推断）因 after_tool 覆盖洞 + handler 静默死亡被否，B（工具内全量产出）因 8 份拷贝漂移被否。
- 2026-10-12 规格范围：P0+P1 一份规格（用户选定），实施分两批。
- 2026-10-12 **带审评审拍板 3 处**（用户对①注入位置直接选定，对②unknown 语义、③affected 形态授权代为决策）：
  1. 注入位置 **尾部追加**（原设计写「前置」——与 `tool-result-budget.ts:117` 既有惯例冲突，且前置会破坏可解析 content / 改变 UI 位置）。
  2. unknown **缺省即未判明**，不写 `retryable:false`（依据：信号建议性无强制路径 ⇒ 陈述真实优先于替模型断言；保守 false 会掐掉 agnes 429 退避可成场景）。
  3. affected 契约 **只返 `affectedCount`**、不返 id 数组（依据：`details.actions` 已是 Nest/前端唯一实时通道，另开数组=重复数据源）；并加实现护栏：**禁止从 actions 反推 count**（非 1:1，反推必错）。
  - 附带产出：`errorCode:"unknown"` 计数 metrics → 驱动上游 429 分类修复（后续工单，不在 V1）；golden cases 由 3 条增至 4 条。
- 2026-10-12 **二轮评审（vendor 源码逐处取证）10 处修订 + 2 吸收点**（用户选定「全部落盘修订」）：
  1. ⭐ §5 不自建 retryable 映射表——**复用 vendor `isRetryableAssistantError`**（`@earendil-works/pi-ai`，已声明依赖；薄适配层合成 `{stopReason:"error", errorMessage}` 调用）。决定性理由：vendor 区分「429 瞬时限流 → true」vs「429 配额/计费耗尽（`insufficient_quota`/`billing`）→ false」，正是 agnes 429 病例的正确判据；vendor 更新 pattern 自动继承。
  2. ⭐ `after_tool` event 原生携带 `args` → write/destructive 主校验改为「请求数 vs `affectedCount`」对账（能识别部分生效）。
  3. ⭐ details patch 护栏：vendor 聚合是整字段替换（`hooks.ts:315`）→ listener patch 必须 `{...event.details, _signal}` 展开，单测锁定。
  4. ⭐ handler 失败不自建计数——vendor `pi.harness.hook` span（`outcome=failed`）原生覆盖；listener 带 `pi.hook.registration_id="lnkpi.result-signals"`；自有 metrics 只留领域信号（`observe*` 命名惯例）。
  5. kill switch 走 `loadRuntimeConfig` 的 `hookCfg.resultSignals === false` 门控（镜像 `toolResultBudget`/`trustBoundary` 风格），不在 handler 内读 env。
  6. 读非类型化 event 字段用 `readStringField`/`readBooleanField` fail-soft 助手，禁 `as` 强转。
  7. patch 面纪律：显式禁止触碰 `usage`/`terminate`/`isError`（改 isError 干扰 gate，改 terminate 会终止 agent loop）。
  8. 注册序表述修正：budget 在合并 after_tool listener（`index.ts:85`）内，listener 注册在其后。
  9. V2 重注入通道点名 `before_run`（run 级原生注入，优于 transform_context）。
  10. §3 分工微调：vendor 分类器判上游错误文本可重试性；`empty_result`/`invalid_params`/`fallback_pending`/`coverage` 为本地域事实仍单点判定，职责边界不重叠。
  - 吸收点（§9，P3 候选）：`retryAssistantCall` + `RetryCallbacks`（retry 事件必须可观测；启用前须评估计费幂等性）；`AgentToolResult.usage`（成本透传未来载体）。
