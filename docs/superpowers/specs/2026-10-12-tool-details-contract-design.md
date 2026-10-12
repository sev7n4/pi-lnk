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
- **砍 `affectedCount`**：属各工具族 details 的派生值（`affectedNodeIds.length`），放族级契约（§2.2），不进通用 signal。
- **status 枚举取 `ok|partial|failed`**：`failed` 比 `error` 更明确，且不与 vendor `isError: boolean` 语义纠缠。

### 2.2 工具族 TDetails 契约（8 文件 / 15 工具）

| 工具族 | 文件 | TDetails 必填字段（通用 `_signal` 之外） |
|---|---|---|
| gen | generation.ts（run_image/video/text/prompt/audio_generation、propose_generation、grid_slice_image） | `modelUsed: string`、`generationParams: Record<string, unknown>`、propose_generation 另有 `confirmed: boolean`（gate 消费中，保留） |
| write_light | canvas-write.ts、arrange-nodes.ts | `affectedNodeIds: string[]`（派生 affectedCount）、canvas-write 错误路径保留 `{ok, confirmed}` |
| graph_batch | canvas-write.ts（render_canvas_view 路径） | 沿用现有 `canvasCommands` 契约，仅补 `_signal` |
| destructive | delete-nodes.ts、remove-edges.ts | `affectedNodeIds: string[]` + `actions`（resultWithActions 既有，保留） |
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
  - **工具产出**（可信源头的事实字段）：status 原始判定、errorCode（含 `error_code` 归一）、coverage、affectedNodeIds、modelUsed。
  - **单点映射表**（`result-signal.ts`，工具侧 helper 调用）：status 归一 + retryable 判定——retryable 在工具侧随 `details._signal` 落地（Task 1 形态），映射表常量供 listener 复用，禁止第二份拷贝。
  - **listener 推断**（P1，单点可测）：短告警文本生成、tier 查表、truncated 终判（依赖 capToolResult 后的最终 content；工具预填值为缺省，listener 可覆写）。
- 映射表所在模块 `result-signal.ts` 为**单点**：工具侧 helper 与 P1 listener 复用同一模块，禁止第二份拷贝。

## 4. 信号 listener 设计（P1）

- **注册序硬约束**：必须注册在 `tool-result-budget`（capToolResult）**之后**——`HookMap` 多 listener 为链式 replace（`hooks.ts`），后注册者看到前者的 patch；截断检测依赖最终 content 状态。
- **注入纪律**：成功（status=ok 且无 truncated/coverage 告警）**零注入**；异常才前置一行自解释短告警，15-30 token 预算，格式 `⚠️[<tier>] < errorCode 或现象> <模型应做的动作>`，例：`⚠️[gen] rate_limited 可退避重试`。格式必须自解释——系统提示预算仅剩 3 字符，禁止在 prompt-registry 加解读规则。
- **注入位置**：模型可感知文本 → `content` 前置；结构化信号 → `details._signal`（模型不读 details，供 UI/metrics/hook 链消费）。
- **handler 容错**：listener 内部 try/catch 全包 + metrics 计数 `handler_error`（防静默死亡——本项目事故家族），失败时工具侧 `details._signal` 仍在（优雅降级，见 §1 决策依据）。

## 5. 错误分类映射表（单点常量）

| 输入（errorCode/status 归一后） | status | retryable | 依据 |
|---|---|---|---|
| rate_limited / too_many_requests / 429 | failed | **true** | agnes-video 病例：可退避重试 |
| upstream_timeout / timeout / 5xx / 503 | partial | **true** | 代理黑洞 45s 病例 |
| empty_result | partial | false | 结果为空重试同参无意义，提示改参 |
| invalid_params / validation | failed | false | 改参重试 |
| fallback_pending | partial | false | 换模型重试编排中 |
| unknown / 缺失 | failed | **false（保守）** | agnes errorCode=unknown 教训：不可判读时不鼓励盲目重试 |

映射表为 `Set`/常量单点维护（result-signal.ts），golden case 锁定（§6）。

## 6. 运维面（P1）

- **kill switch**：`PI_RUNTIME_RESULT_SIGNALS=off` → listener 不注册（契约层类型化零运行时成本，不受开关影响）。回滚 = 环境变量一行，无 schema 迁移。
- **metrics**：`pi_runtime_result_signal_total{tier, status}` ——兼活性探针（静默死亡可观测）；`handler_error` 单独计数。
- **eval golden cases（3 条，必配，无 eval 的信号层 = 又一个没人盯的静默层）**：
  1. agnes 429 会话 → 信号 `failed/retryable:true` + content 出现退避提示。
  2. canvas-write 返回缺 confirmed → 信号 partial + 重试提示。
  3. get_canvas_summary 局部采样 → 信号 `coverage:"partial"` + content 告警。
- **生产验收探针**：一次真实 429 会话中 retryable 信号可见（logs/metrics）。

## 7. 生命周期与已知限制

- V1 全部信号为 **turn 级**（随 tool_result 进上下文，轮次结束即随消息压缩）。
- **已知限制**：上下文压缩可能丢弃异常告警——接受，V2 由 metrics 触发后再做 transform_context 重注入（届时评估 checkpoint/invocation memo 复用，勿自建轮子）。
- P0 批次与 P1 批次可独立上线、独立回滚：P0 是纯类型层（tsc 强制 + 机检），P1 是运行时行为（kill switch 可关）。

## 8. 验收标准

| 批次 | 验收 |
|---|---|
| P0 | tsc 全绿；`verify-tool-details-contract.ts` 全过；15 工具 TDetails 显式（grep 断言无 `TDetails = unknown` 缺省）；既有测试（含 hook-contract/tiering）零回归 |
| P1 | 3 条 golden case 全绿；kill switch off 后逐字节回退（diff content 无信号文本）；metrics 活性探针上线；注册序断言（listener 注册位置在 capToolResult 之后的机检或测试） |

## 附录 A：Task 1 已提交代码校对裁定（feat/tool-details-contract-p0 · result-signal.ts）

| # | Task 1 现状 | 规格裁定 | 动作 |
|---|---|---|---|
| 1 | `ToolResultSignal` 无 tier 字段 | §2.1 裁定砍 tier（SSOT） | ✅ 一致，无需改 |
| 2 | status 枚举 `ok\|partial\|failed` | §2.1 取 failed | ✅ 一致（设计稿 error 已按此修正） |
| 3 | `withSignal` 写入键为 `details.signal` | §2.2 定 `_signal`（框架注入键约定） | ⚠️ 改键名为 `_signal`（helper + 测试 + future 消费方） |
| 4 | `signalFromUpstream` 含 retryable 映射 | §5 映射表单点，listener 复用 | ✅ 一致（映射表常量补 §5 的 empty_result/invalid_params 分支） |
| 5 | `signalFromUpstream` 的 fallback_pending→partial/retryable:false | §5 同 | ✅ 一致 |
| 6 | `affectedCount`/族级 TDetails/守卫族 | 属 Task 2-5 范围 | Task 1 未涉及，正常 |

## 附录 B：决策记录

- 2026-10-12 流程纠偏：用户指出「规格 → 计划 → 实施」顺序，此前跳过规格直接写计划并实施 Task 1，已暂停并保留代码作校对基准。
- 2026-10-12 方案决策：架构方案 C（混合）——用户授权代为拍板，三视角（vendor 架构约束 / Codex 工程纪律 / 产品 ROI）独立推导收敛；A（纯 listener 推断）因 after_tool 覆盖洞 + handler 静默死亡被否，B（工具内全量产出）因 8 份拷贝漂移被否。
- 2026-10-12 规格范围：P0+P1 一份规格（用户选定），实施分两批。
