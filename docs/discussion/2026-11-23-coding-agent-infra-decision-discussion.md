# Coding agent 编码能力是否作为基础设施：决策与 runToolCall 证伪记录

> 方向/决策来源（2026-11-23）。性质：**已结项 —— 决策来源**。
> 本文记录一次「看起来该做、核实后发现不该做」的立项裁决，重点留存 `runToolCall` 编排复用提案的证伪链，供后续同类提案对照。
> 零代码改动、零部署。

## 1. 问题与背景

用户提问：顶级智能体（Claude Code / Codex / WorkBuddy）都有底层 coding 能力，能拉高能力上限、让模型在推理中衍生自动化程序编排各类工具。本项目基于上游 `pi-agent-core`，是否应升级底座，把 coding agent 的自动化能力作为基础设施打造？

## 2. 总体裁决

**不做底座级升级。** 把用户口中的「编码能力」拆成两件事：

| 概念 | 本质 | 本项目裁决 |
|---|---|---|
| **A · coding agent** | 面向软件工程的产品形态，载体是文件系统 + shell + 代码库 | ❌ 不是本项目形态（产出是画布图，不是代码仓库） |
| **B · code-as-action / programmatic tool calling** | 工具调用范式：模型写一段代码在沙箱里编排工具，只回传结果 | ⚠️ 上游已内置原语，但收益结构与本项目场景不匹配、代价打在治理命门上 |

分档结论：A 档（吃满上游已给的东西）→ **撤销 `runToolCall` 编排复用部分**（见 §4）；B 档（条件化 opt-in 后端）前置条件未满足；C 档（raw shell / codemode 碰写工具）为红线。

## 3. 等价物检索结论表（第一原则）

第一原则三判据：① 等价物检索 ② 接线优先于新建 ③ 禁造数/禁自报。逐项结论：

| # | 候选能力 | 上游/项目等价物（代码核实） | 结论 |
|---|---|---|---|
| 1 | 代码执行引擎 | 上游 `Shell` / `ExecutionEnv`（`dist/harness/types.d.ts:296-303`）、`createBashTool`；`pi-codemode` 生态源码在 `vendor/earendil-works/pi/packages/codemode/` | **已存在**，无需造 |
| 2 | 程序化工具编排 | 上游 `runToolCall`（`dist/agent-loop.d.ts:47`），README:516 称经它调工具时 `beforeToolCall/afterToolCall` 生效 | **已存在但与本项目 harness 不互通**，见 §4 |
| 3 | 并行/批量工具批次 | 上游 `toolExecution:"parallel"` 为默认值；本项目主动改 `sequential`（`session-manager.ts:1523-1529`），测试钉住（`session-manager.tool-execution.test.ts:54-63`） | **存在但有意关闭** |
| 4 | 任务编排/子代理 | `spawn_subagent`/`collect`、barrier 回注、plan/todo/task-state、workflow-recipe | **已存在且闭环** |
| 5 | 生成/写画布治理 | `transactGovernedCanvasOps`、`generation-gate`、`plan-gate`、`canvas-id-binding`、auto-approve | **已存在**，是红线来源 |
| 6 | 工具内部的「工具调工具」 | 项目内生产代码零命中；上游范本在 `vendor/.../examples/mcp-codemode/tools.ts:83-102`（`createNestedToolRunner`）、`vendor/.../coding-agent/src/core/nested-tool-calls.ts:130-248` | **项目内无、上游有范本但属另一套体系** |

## 4. 核心证伪：`runToolCall` 编排复用为什么不适用

> 提案最初判断：「把 `runToolCall` 的『工具调工具且 hooks 生效』用在现有 hook 链，减少 hook 间手工胶水，是纯接线、零风险」。
> 核实后**推翻**：它不是纯接线，接进来会让项目治理门全部失效。

### 4.1 三条硬证据（均可复现）

**E1 — `runToolCall` 属低层 AgentLoop 体系，不是 harness 方法。**

`dist/agent-loop.d.ts:24-47`：独立顶层函数，签名 `(toolCall: AgentToolCall, options: RunToolCallOptions) => Promise<AgentToolCallOutcome>`；`options.beforeToolCall/afterToolCall` 来自 `AgentLoopConfig`。JSDoc 原文：

> Run one tool call through the same steps as a model-issued call ... `Emits no events and adds no messages.` Tools that call other tools use this so the hooks ... apply to those calls too.

取证：`grep -rn "runToolCall" <pkg>/dist/harness` → **零命中**；`harness/agent-harness.d.ts` 的 `AgentHarness` 接口无 `callTool`/`runToolCall`（只有 `lane()/getTools()/setTools()/hooks/events`）。

**E2 — 两套 hook 体系不互通（决定性）。**
项目所有治理门注册在 `harness.hooks.on("before_tool"/"after_tool")`（`services/pi-runtime/src/index.ts:115-144, 215-260`、`gate/plan-gate-wiring.ts:197-207`、`gate/propose-gate.ts:127-139`、`tools/canvas-id-binding.ts:240-266`），由 harness 的 lane 运行时分发（`<pkg>/dist/harness/runtime/drive/tools.js`）。而 `runToolCall` 只跑 `RunToolCallOptions.beforeToolCall/afterToolCall`（AgentLoopConfig 的 hook）。harness 目录对 agent-loop **零 import**（`grep -rn "from.*agent-loop" <pkg>/dist/harness --include="*.js"` → 空）。

⇒ README 说的「hooks 照样生效」对本项目**不成立**：接 `runToolCall`，`before_tool` 上的 plan-gate / generation-gate / propose-gate / canvas-id-binding 一个都不会触发。这正是本项目治理命门（AGENTS.md 变更影响面矩阵第一条、P1-C）。

**E3 — 工具签名不兼容，接线实为新建适配层。**

| 体系 | 执行签名 | 位置 |
|---|---|---|
| harness（项目在用） | `executeToolCall(call, gate, onUpdate, toolContext, invocation, context)` → `tool.execute(id, args, onUpdate, toolContext, invocation, context)`（6 参） | `<pkg>/dist/harness/execution/tools.js:56,62` |
| agent-loop（`runToolCall`） | `prepared.tool.execute(id, args, signal, onUpdate)`（4 参） | `<pkg>/dist/agent-loop.js:572` |

把 `LnkpiTool`（`AgentHarnessTool`，6 参）塞进 `options.tools`：第 3 参 `signal` 被当 `onUpdate`、第 4 参函数被当 `toolContext`，`toolContext/invocation/context` 全丢 —— `LnkpiToolContext.sessionId/piSessionKey/storeScopeKey`（`tools/types.ts:35-76`）取不到，画布工具 404。要接必须写 6→4 参适配 + `Context`→`AgentContext` 映射 + harness hook 桥接三件套 = **新建引擎适配层**，违反第一原则「接线优先于新建」。

补充：`runToolCall` 的 `beforeToolCall`（`BeforeToolCallResult`）只有 `block/reason/terminate`，**不能改 args**（`<pkg>/dist/types.d.ts:44-52`），而 `canvas-id-binding` 的 rewrite 依赖 harness 的 `applyBeforeToolDecision` 重校验替换参（`<pkg>/dist/harness/execution/tools.js:37-54`），平移不过去。且 `runToolCall` "emits no events"，不产 harness `tool_start/tool_end`，前端事件账本与 SSE 时间线不受益。

### 4.2 patch 边界

`patches/@earendil-works__pi-agent-core@0.99.2.patch` 全文只改 `harness/execution/tools.js`（加回 `addedToolNames`）、`harness/runtime/drive/tool-placement.js`、`dist/types.d.ts`、`package.json` exports，**不碰 agent-loop** ⇒ 上述均为原版 0.99.2 行为。

## 5. 修正后的 A 档与三路线裁决

向用户给出三条路线并请其拍板：

| 路线 | 内容 | 性质 | 裁决 |
|---|---|---|---|
| ① 撤销 `runToolCall` 部分 | A 档改为「确认真正零风险的上游复用」；gate 的手工 `get-node` 直连保留（纯函数 + fail-closed，无等价工具可不造适配层地替代）；parallel 维持关闭（有意设计，测试钉住）；codemode 只做可行性调研 | 真·零风险 | ✅ **用户采纳** |
| ② 先建适配层 PoC | 新增 `tool-call-bridge.ts`（6→4 参 + Context 映射 + hook 桥接），单测证明桥接后 hook 生效 | 新建 + 中风险 | ❌ 违反第一原则，治理门仍需额外接线 |
| ③ 跳过 A 档转 B 档 | 直接做条件化 opt-in 后端设计 | 另起炉灶 | ❌ 沙箱与 hooks 继承前置条件未满足 |

**A 档最终产出**：本文（证伪记录）+ 下述重启判据；**不动代码、不动测试、不动提示词**。

## 6. 重启评估判据

以下三条**同时**满足才重新评估「编码能力基础设施化」，缺一不重启：

1. 生成 API 成本占比降到 token 往返成本以下（当前大头是 image/video/audio 生成，不是上下文 token）；
2. 出现「批量确定性操作」（一次重排 N 节点、跨节点不变量校验）成为用户主线，而非创造/判断密集型任务；
3. 上游 codemode 的 hooks 继承有生产级证据且脱离实验标签，或与 harness hook 体系有官方桥接。

## 7. 业界对照（仅方向参照，非项目判据）

Claude Code v2.1.323（2026-11-17）上线实验性 Code Mode（环境变量 opt-in、默认关闭，只支持本地终端直连，不支持 Agent SDK / headless / 云平台）。外部评测给出的 token/账单收益集中在 MCP 批量取数与跨文件批处理；判断密集型任务收益缩水，弱模型（Haiku 级）在文件任务上反而更贵。官方将「中间过程难逐步拦截、可观测性下降、安全边界从 permission prompt 移到 sandbox」列为代价。⇒ 与本项目「生成成本高、创造判断密集、HITL 确认门为核心价值」的场景结构不同，收益不可平移。

## 8. 取证命令附录

```bash
CORE=<pnpm store>/@earendil-works+pi-agent-core@0.99.2*/node_modules/@earendil-works/pi-agent-core
# E1 签名
sed -n '24,47p' "$CORE/dist/agent-loop.d.ts"
# E2 两套执行签名
grep -n "executeToolCall\|call.tool.execute" "$CORE/dist/harness/execution/tools.js"   # :56 :62（6 参）
grep -n "\.execute(" "$CORE/dist/agent-loop.js"                                        # :572（4 参）
# E3 harness 对 agent-loop 零引用
grep -rn "from.*agent-loop\|require.*agent-loop" "$CORE/dist/harness" --include="*.js"  # 空
grep -rn "runToolCall" "$CORE/dist/harness"                                             # 空
# 项目治理门注册面
grep -rn "hooks.on(\"before_tool\"\|hooks.on('before_tool'" services/pi-runtime/src
# 项目内生产代码无 runToolCall / vm / eval
grep -rnE "runToolCall|eval\(|new Function\(|vm\.runIn|createBashTool" \
  apps/server/src services/pi-runtime/src packages/agent/src | grep -v '\.test\.ts:'   # 空
```
