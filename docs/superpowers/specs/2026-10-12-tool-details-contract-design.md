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
  - **单点映射表**（`result-signal.ts`，工具侧 helper 调用）：status 归一 + retryable 判定——retryable 在工具侧随 `details._signal` 落地（Task 1 形态），映射表常量供 listener 复用，禁止第二份拷贝。
  - **listener 推断**（P1，单点可测）：短告警文本生成、tier 查表、truncated 终判（依赖 capToolResult 后的最终 content；工具预填值为缺省，listener 可覆写）。
- 映射表所在模块 `result-signal.ts` 为**单点**：工具侧 helper 与 P1 listener 复用同一模块，禁止第二份拷贝。

## 4. 信号 listener 设计（P1）

- **注册序硬约束**：必须注册在 `tool-result-budget`（capToolResult）**之后**——`HookMap` 多 listener 为链式 replace（`hooks.ts`），后注册者看到前者的 patch；截断检测依赖最终 content 状态。
- **注入纪律**：成功（status=ok 且无 truncated/coverage 告警）**零注入**；异常才注入一行自解释短告警，15-30 token 预算，格式 `⚠️[<tier>] <现象> <模型可考虑的动作>`，例：`⚠️[gen] rate_limited 可退避重试`。格式必须自解释——系统提示预算仅剩 3 字符，禁止在 prompt-registry 加解读规则。
- **注入位置 = 尾部追加**（评审拍板，与 `tool-result-budget.ts:117` 既有惯例一致）：追加到最后一个文本块末尾。理由：① 不破坏可解析 content（部分工具 content 是 JSON）；② 不改变 UI 渲染位置；③ 模型最后读到的内容权重最高。⚠️ 与 listener 注册序约束（§4 首条）叠加时注意：截断已追加过 marker，信号在其后再追加，顺序为「正文 → 截断 marker → 信号行」。
- **注入通道分工**：模型可感知文本 → `content`（尾部追加，见上条）；结构化信号 → `details._signal`（模型不读 details，供 UI/metrics/hook 链消费）。
- **handler 容错**：listener 内部 try/catch 全包 + metrics 计数 `handler_error`（防静默死亡——本项目事故家族），失败时工具侧 `details._signal` 仍在（优雅降级，见 §1 决策依据）。

## 5. 错误分类映射表（单点常量）

| 输入（errorCode/status 归一后） | status | retryable | 依据 |
|---|---|---|---|
| rate_limited / too_many_requests / 429 | failed | **true** | agnes-video 病例：可退避重试 |
| upstream_timeout / timeout / 5xx / 503 | partial | **true** | 代理黑洞 45s 病例 |
| empty_result | partial | false | 结果为空重试同参无意义，提示改参 |
| invalid_params / validation | failed | false | 改参重试 |
| fallback_pending | partial | false | 换模型重试编排中 |
| unknown / 缺失 | failed | **缺省不写（= 未判明）** | 评审拍板：见下方三态语义 |

**retryable 三态语义（评审拍板）**

- `retryable: true` **仅在确知可重试时写**（429 / 5xx / timeout 类）。
- `retryable: false` **仅在确知不可重试时写**（invalid_params / empty_result）。
- **缺省 = 未判明**（unknown 或上游未给 errorCode）：listener 注入 hedge 文本——「⚠️[gen] 上游失败原因未判明；若是瞬时故障，退避重试或换模型通常有效」。既不断言不可重试（会掐掉 agnes 429 这类退避可成的场景），也不鼓励盲重试（避免无效重试循环）。

依据：vendor `after_tool` 的 patch **只能改 content/details/isError，不能改已发生的副作用**——信号本质建议性、无强制路径（`tool-result-budget.ts:16-17`）。既然无法机械阻止重试循环，极性选择的唯一目标就是**陈述真实**，而非替模型断言。

⭐ **配套后续工单（不在 V1 建）**：`errorCode:"unknown"` 的出现次数进 metrics（§6），**用它驱动根因修复**——把上游 HTTP 429 在生成工具内归类为 `rate_limited`。信号层只负责如实暴露残余盲区，不越界替上游修分类。

映射表为 `Set`/常量单点维护（result-signal.ts），golden case 锁定（§6）。

## 6. 运维面（P1）

- **kill switch**：`PI_RUNTIME_RESULT_SIGNALS=off` → listener 不注册（契约层类型化零运行时成本，不受开关影响）。回滚 = 环境变量一行，无 schema 迁移。
- **metrics**：`pi_runtime_result_signal_total{tier, status}` ——兼活性探针（静默死亡可观测）；`handler_error` 单独计数；`errorCode:"unknown"` 单独计数（驱动 §5 配套的上游 429 分类修复工单）。
- **eval golden cases（4 条，必配，无 eval 的信号层 = 又一个没人盯的静默层）**：
  1. agnes 429 会话 → 信号 `failed/retryable:true` + content 出现退避提示。
  2. canvas-write 返回缺 confirmed → 信号 partial + 重试提示。
  3. get_canvas_summary 局部采样 → 信号 `coverage:"partial"` + content 告警。
  4. ⭐ errorCode 缺失/unknown → **retryable 缺省不写 false** + content 注入 hedge 文本（锁住 §5 三态语义，防回归成保守 false）。
- **生产验收探针**：一次真实 429 会话中 retryable 信号可见（logs/metrics）。

## 7. 生命周期与已知限制

- V1 全部信号为 **turn 级**（随 tool_result 进上下文，轮次结束即随消息压缩）。
- **已知限制**：上下文压缩可能丢弃异常告警——接受，V2 由 metrics 触发后再做 transform_context 重注入（届时评估 checkpoint/invocation memo 复用，勿自建轮子）。
- P0 批次与 P1 批次可独立上线、独立回滚：P0 是纯类型层（tsc 强制 + 机检），P1 是运行时行为（kill switch 可关）。

## 8. 验收标准

| 批次 | 验收 |
|---|---|
| P0 | tsc 全绿；`verify-tool-details-contract.ts` 全过；15 工具 TDetails 显式（grep 断言无 `TDetails = unknown` 缺省）；既有测试（含 hook-contract/tiering）零回归 |
| P1 | 4 条 golden case 全绿；kill switch off 后逐字节回退（diff content 无信号文本）；metrics 活性探针上线（含 unknown 计数）；注册序断言（listener 注册位置在 capToolResult 之后的机检或测试） |

## 附录 A：Task 1 已提交代码校对裁定（feat/tool-details-contract-p0 · result-signal.ts）

| # | Task 1 现状 | 规格裁定 | 动作 |
|---|---|---|---|
| 1 | `ToolResultSignal` 无 tier 字段 | §2.1 裁定砍 tier（SSOT） | ✅ 一致，无需改 |
| 2 | status 枚举 `ok\|partial\|failed` | §2.1 取 failed | ✅ 一致（设计稿 error 已按此修正） |
| 3 | `withSignal` 写入键为 `details.signal` | §2.2 定 `_signal`（框架注入键约定） | ⚠️ 改键名为 `_signal`（helper + 测试 + future 消费方） |
| 4 | `signalFromUpstream` 含 retryable 映射 | §5 映射表单点，listener 复用；**unknown 必须缺省不写 false** | ⚠️ 改分类器：unknown/缺失分支当前返回 `retryable:false`，须按 §5 三态语义改为不写该字段 |
| 5 | `signalFromUpstream` 的 fallback_pending→partial/retryable:false | §5 同 | ✅ 一致 |
| 6 | `affectedCount`/族级 TDetails/守卫族 | 属 Task 2-5 范围 | Task 1 未涉及，正常 |

## 附录 B：决策记录

- 2026-10-12 流程纠偏：用户指出「规格 → 计划 → 实施」顺序，此前跳过规格直接写计划并实施 Task 1，已暂停并保留代码作校对基准。
- 2026-10-12 方案决策：架构方案 C（混合）——用户授权代为拍板，三视角（vendor 架构约束 / Codex 工程纪律 / 产品 ROI）独立推导收敛；A（纯 listener 推断）因 after_tool 覆盖洞 + handler 静默死亡被否，B（工具内全量产出）因 8 份拷贝漂移被否。
- 2026-10-12 规格范围：P0+P1 一份规格（用户选定），实施分两批。
- 2026-10-12 **带审评审拍板 3 处**（用户对①注入位置直接选定，对②unknown 语义、③affected 形态授权代为决策）：
  1. 注入位置 **尾部追加**（原设计写「前置」——与 `tool-result-budget.ts:117` 既有惯例冲突，且前置会破坏可解析 content / 改变 UI 位置）。
  2. unknown **缺省即未判明**，不写 `retryable:false`（依据：信号建议性无强制路径 ⇒ 陈述真实优先于替模型断言；保守 false 会掐掉 agnes 429 退避可成场景）。
  3. affected 契约 **只返 `affectedCount`**、不返 id 数组（依据：`details.actions` 已是 Nest/前端唯一实时通道，另开数组=重复数据源）；并加实现护栏：**禁止从 actions 反推 count**（非 1:1，反推必错）。
  - 附带产出：`errorCode:"unknown"` 计数 metrics → 驱动上游 429 分类修复（后续工单，不在 V1）；golden cases 由 3 条增至 4 条。
