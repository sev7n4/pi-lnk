# spawn_subagent 契约补全：D2 子任务单据 + non-block 模式 + 契约面修正 设计规格

> 状态：已立项（2026-11-14）
> 输入：2026-11-13 生产复测后对照「行业四问」（适用场景/工作模式/结果回收/任务描述）的缺口分析
> 上游规格：`2026-10-10-c4-subagent-design.md`（C4 原始设计）、`2026-11-12-spawn-subagent-trigger-strategy.md`（触发策略 + #841 P4）、`2026-11-12-spawn-baseline-fix-plan.md`（已落地 PR #858）
> master 锚：`16e4fc99`

## 1. 背景：四问对照出的 6 缺口

C4 基线修复（PR #858）后 spawn_subagent 已实现首次真实生产调用。对照行业通用 subagent 规范四问，缺口如下：

| # | 缺口 | 严重度 | 对应问 |
|---|---|---|---|
| G1 | 子任务无持久单据：只活在内存 promise，pod 滚动更新即蒸发，中断无法取证/恢复（spawn-subagent.ts:70-74 注释已诚实承认「跨进程闭环要等 D2」） | P1 | Q3 |
| G2 | 只有 block 同步模式：模型无法派多路调研并行跑、自己继续做别的 | P1 | Q2 |
| G3 | L3 技能零点名：skills/ 无 spawn_subagent 相关技能，description 是唯一发现通道 | P1 | Q1/Q4 |
| G4 | task 仅自由字符串：背景/问题/报告形态混在一行，无结构化字段 | P2 | Q4 |
| G5 | plan-gate 拦 spawn_subagent（tier=write_light），而调研最常发生在 plan 期——#841 已判 F5 时机错位（P4 待做） | P2 | Q1 |
| G6 | 报告截断静默 slice（20k 无标记）；报告形态无契约，全凭子代理自由发挥 | P3 | Q3/Q4 |

## 2. 目标 / 非目标

**目标**：三把刀补齐上述 6 缺口，全部零破坏（block 路径行为不变、前端零迁移、协议 additive）。

**非目标**：
- 不做子代理流式进度上报（进度仍= tool_start/tool_end 生命周期，前端零改动）
- 不做子代理写画布（白名单红线不动）
- 不做跨 pod 的子任务恢复执行（重启后只能取证「interrupted」，不能续跑——续跑属 D2 二期）
- 不改 SUBAGENT_TOOL_WHITELIST / 并发上限 2 / 超时 5min / 预算 30 turn 的值

## 3. 总体设计：三刀

| 刀 | 内容 | 缺口 | 改动面 |
|---|---|---|---|
| **B 契约面** | task 结构化 + 默认报告骨架 + plan-gate 豁免 + 截断标记 | G4/G5/G6 | spawn-subagent.ts、plan-gate.ts、session-manager.ts、gate/subagent.ts（类型） |
| **C L3 技能** | `skills/research-delegate/` + wiring 守卫 | G3 | skills/ 新目录、skills 测试 |
| **A D2 单据 + non-block** | SubtaskLedger（JSONL 落盘）+ coordinator background 模式 + `collect_subagent_result` 工具 | G1/G2 | gate/subtask-ledger.ts（新）、gate/subagent.ts、spawn-subagent.ts、tools/config.ts、metrics.ts、index.ts |

实施顺序 **B → C → A**（B 最快见效、A 依赖面最大；单 PR 三 commit 分段）。

## 4. 刀 B：契约面

### 4.1 task 结构化（G4）

`spawn_subagent` 参数从单 string 扩为（additive，全部向后兼容）：

```ts
parameters: Type.Object({
  task: Type.String({ description: "要查什么（核心问题清单，越具体越好）" }),
  background: Type.String({ description: "背景补充（已读过什么/已试过什么/相关约束），可选" }),
  reportFormat: Type.String({ description: "期望的报告结构与重点，可选；缺省用内置骨架" }),
  mode: /* 刀 A 引入，刀 B 预留描述位不实现 */,
}),
```

prompt 组装（导出供测试）：

```ts
export const DEFAULT_REPORT_FORMAT =
  "结论先行（先给核心判断，再分节展开论据）；末尾必须附「来源」清单（每条含来源名与链接/出处），无法核实的说法标注「未核实」。";

export function composeSubagentPrompt(task: string, background?: string, reportFormat?: string): string {
  const parts = [task.trim()];
  if (background?.trim()) parts.push(`【背景】${background.trim()}`);
  parts.push(`【期望报告形态】${(reportFormat ?? DEFAULT_REPORT_FORMAT).trim()}`);
  return parts.join("\n");
}
```

组装在 **spawn 工具层**完成（execute 内），runSubagent 不感知——block/background/ledger 预览天然一致。

### 4.2 plan-gate 豁免（G5，#841 P4 落地）

```ts
// gate/plan-gate.ts
export const PLAN_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["todo_write", "spawn_subagent"]);
```

理由：调研是 plan 期的输入而非写操作；子代理白名单物理只读，豁免无副作用面。`collect_subagent_result`（刀 A）tier="read" 天然不在 `PLAN_GATED_TIERS`，无需豁免。

### 4.3 截断标记（G6 前半）

`session-manager.ts` runSubagent 内（约 :3308）：

```ts
const raw = await this.extractSubagentReport(lane);
const truncated = raw.length > SUBAGENT_REPORT_MAX_CHARS;
const report = raw.slice(0, SUBAGENT_REPORT_MAX_CHARS);
// 各 return 点的 outcome 对象追加 truncated（undefined 时不写字段 = additive）
```

`SubagentOutcome` 增加 `truncated?: boolean`；spawn 工具 result 透传。超时/fork 段早退路径（report=""）不带 truncated。

### 4.4 报告骨架（G6 后半）

由 4.1 的 `DEFAULT_REPORT_FORMAT` 兜底实现：模型不给 reportFormat 时子代理 prompt 自动含骨架。**不改子代理 system prompt**（basePrompt 转发链零触碰）。

## 5. 刀 C：L3 research-delegate 技能

`skills/research-delegate/SKILL.md`（仿 html-craft 格式）：

- frontmatter：`name: research-delegate` / `version: "1.0.0"` / description 含触发词族（调研/研究/探索/多源核对/联网查资料）+ 强制加载句 + 不适用边界（要改画布/生成内容时不适用，主代理自己做）
- 正文五节：何时使用（触发词族+判据：探索过程不值得占主窗口）/ 派发前检查（改画布？生成？→ 不派）/ task 三段写法模板（要查什么/背景/报告形态，对应 spawn 工具三参数）/ mode 选择（block 默认；并行多路对比调研用 background+collect，刀 A 落地后）/ 结果整合纪律（引用子代理结论须带来源；报告与画布事实冲突时以画布为准）
- 尾部 `## 工具可用性` 小节（R5 段落级纪律）
- wiring 守卫 `services/pi-runtime/src/skills/research-delegate.wiring.test.ts`（仿 html-craft.wiring.test.ts 三段：loader 可发现+触发词 / description 完整性>100 字 / 正文硬约束关键句）

⚠️ deploy.yml 不含 skills/ ⇒ 本刀随刀 A 一起手工 dispatch runtime-deploy。

## 6. 刀 A：D2 子任务单据 + non-block

### 6.1 SubtaskLedger（新文件 `gate/subtask-ledger.ts`）

JSONL append-only，路径 `join(dataRoot, "subtasks.jsonl")`，dataRoot 与 `runtime-config.ts:147` 同口径解析（`PI_RUNTIME_DATA_DIR ?? cwd/.pi-runtime-data`），生产落在 PVC（持久）。

```ts
export interface SubtaskSpawnRecord {
  type: "spawned"; callId: string; sessionKey: string;
  taskPreview: string;         // 前 200 字符，防账本膨胀
  mode: "block" | "background"; ts: number;
}
export interface SubtaskTerminalRecord {
  type: "terminal"; callId: string; status: SubagentStatus;
  turns: number; durationMs: number; truncated?: boolean;
  reportChars: number; report: string; ts: number;  // report 全文（≤20k）随行落盘
}
```

API：`append(record)`（mkdir -p + appendFileSync）/ `replay()`（逐行 JSON.parse，坏行跳过不抛；同 callId 后行覆盖前行）。构造函数接受目录参数；目录不可写时 append 静默降级（catch 后置 `degraded` 标志，不阻断主流程——账本是观测设施不是关键路径）。

### 6.2 SubagentCoordinator 扩展（`gate/subagent.ts`）

```ts
constructor(private ledger?: SubtaskLedger) {}

tryRun(key, task, opts?: SubagentRunOpts & { mode?: "block" | "background" }):
  | { ok: true; promise: Promise<SubagentOutcome>; callId: string }
  | { ok: false; reason: "not_attached" | "concurrency_full" };
```

- **callId 恒生成**（crypto.randomUUID()，block/background 都有）——block 的 tool_result 也带 callId，取证/collect 通用
- spawn 时 `ledger.append(spawned)`；promise settle（catch 兜底转 outcome 之后）`ledger.append(terminal)` + 释放槽位
- background：不 await；进程内 `#inFlight: Map<callId, Promise>`、`#settled: Map<callId, Outcome>` 登记后立即返回
- `collect(callId)` 判定顺序：in-flight → `{status:"running"}`；settled → 终态+report；磁盘 replay（进程生命周期内懒执行一次，terminal 记录回填 settled）→ 终态；**spawned 无 terminal（重启蒸发）→ `{status:"interrupted"}`**；全无 → `{status:"unknown"}`
- block 路径行为不变（await + return outcome），只是多 callId + 账本记录

### 6.3 工具层（`spawn-subagent.ts` + `tools/config.ts`）

- spawn：`mode` 参数（"block"|"background"，默认 block）；background 分支返回 `{ok:true, callId, status:"running", hint:"已后台派发，可先做其他事，再用 collect_subagent_result 查询结果"}`；metrics.spawned 照打（受理口径不变）
- 新工具 `collect_subagent_result`（同文件导出 `createCollectSubagentTool`）：`tier:"read"`、params `{callId}`、coordinator 存在即随 spawn 一并注册（config.ts 两处 spawnTools 数组）；返回 `{ok, callId, status, report?, usage?}`；status=interrupted/unknown 时附 hint「子任务记录不存在或已随进程重启丢失，请重新派发」
- 白名单不动：子代理不可 spawn/collect（嵌套禁令与现状一致）
- metrics：新增 `pi_runtime_subagent_collect_total{status}`（observeSubagentCollected）

### 6.4 接线（`index.ts`）

```ts
const subtaskLedger = new SubtaskLedger(
  join(process.env.PI_RUNTIME_DATA_DIR ?? join(process.cwd(), ".pi-runtime-data"), "subtasks.jsonl"),
);
const subagentCoordinator = new SubagentCoordinator(subtaskLedger);
```

（dataRoot 解析与 runtime-config.ts:147 保持同一表达式，注释互相锚定。）

### 6.5 恢复语义（诚实边界）

| 场景 | collect 结果 |
|---|---|
| 后台跑着 | running |
| 本进程跑完 | 终态 + report |
| pod 重启，账本有 spawned 无 terminal | **interrupted**（不续跑，提示重新派发） |
| 账本无此 callId | unknown |

block spawn 的中断归因仍由 Nest 账本（turn_interrupted）承担，D2 是 pi-runtime 侧的第一层闭环，不替代 Nest 账本。

## 7. 兼容性与回滚

- block 路径外部行为不变（除 additive 的 callId/truncated 字段），前端零迁移
- ledger 未注入（纯文本/旧测试路径）时全链 no-op
- 回滚 = 镜像回退旧 tag；账本文件遗留无害（只增不改）
- L6 预算零新增（L2 规则未动，description 不进预算）

## 8. 观测与验收判据

1. `pi_runtime_subagent_spawned_total`（口径不变）+ 新增 `pi_runtime_subagent_collect_total{status}`
2. 生产 PVC 出现 `subtasks.jsonl`，block spawn 后有 spawned+terminal 两条记录
3. background 派发 → 同回合 collect(running) → 终态 collect 拿到 report
4. plan 期（propose_plan 未决）可成功 spawn（豁免生效）
5. 磁盘 12 条规则/预算 3197/3200 不变（prompt:lint 守卫）
6. wiring：loader 发现 research-delegate、description 触发词齐、正文关键句齐

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 后台子任务挤占并发槽（2 槽被 background 占满 ⇒ 后续 block spawn 拒绝） | hint 已写明 fail-soft 自行兜底；模型可先 collect 释放 |
| 账本膨胀（report 全文 ≤20k/条） | append-only + 预览截 200 字；量级估算：百次调研 < 5MB，可接受 |
| 模型滥用 background 把 collect 拖到回合尾 | description/skill 明确「派发后先做别的，结束前必须 collect」；未 collect 的 running 任务随回合结束丢失并在账本留 spawned 无 terminal（取证可见） |
| 豁免后 plan 期被滥用派发 | 子代理白名单物理只读，无副作用面 |

## 10. 交付期静态门禁补正（2026-11-14 追加，只追加不改上文）

三刀实现与单元/集成测试全绿后，跑 `verify-tool-tiering` 抓到两处**新增工具登记缺口**（只跑 `tsc` + 测试不会发现）：

| 门禁 | 检出 | 根因 |
|---|---|---|
| A1（红线） | `collect_subagent_result` 落在延迟集，却被 L3 `skills/research-delegate/SKILL.md` 按名字点名 | 模型读完 skill 直调 ⇒ 吃 vendor 硬编码 `Tool ... is unavailable`，且 `tool_search` 触发率实测 0 ⇒ 无恢复路径 |
| A5（展示覆盖） | 运行时工具未在 `apps/web/.../toolPresentation.ts` 的 `TOOL_PRESENTATION` 登记 | 前端时间线会落 `⚙ 调用 collect_subagent_result` 自曝兜底 |

裁决（与 `spawn_subagent` #858 提回常驻同一准绳）：

1. `collect_subagent_result` 进 `ALWAYS_ON_TOOL_NAMES`，与 `spawn_subagent` 同段。除「被点名 ⇒ 必须常驻」外，还有第二条硬理由：它是 background 模式**唯一**的结果回收入口，spawn 已常驻 ⇒ 按 `tiering.ts` 文件头「常驻不得给延迟工具的领域凑部分答案」铁律必须同处。
2. `TOOL_PRESENTATION` 补 `{ icon: '📥', verb: '收取子代理结果' }`（与 `spawn_subagent` 的「派生子代理」对望），`presentToolStep` 对 running/done 两态都返回该人话短语。
3. `tiering.test.ts` 按 AGENTS.md「新增工具须显式声明归属」补 `spawn_subagent` / `collect_subagent_result` 两项登记，并把两者加入「核心链路工具必须常驻」回归锁。

**验收判据（追加到 §8 第 7 条）**：`verify-tool-contract` / `verify-tool-tiering` / `verify-spec-figures` 三门禁 0 错误；`collectRuntimeToolNames()` 派生清单对 `TOOL_PRESENTATION` 覆盖缺口为空；`tiering.test.ts` 常驻锁含这两个工具。

> 这一节的教训：**新增运行时工具的最小闭环不止「注册 + 测试」，还包括分层归属、展示注册表、静态门禁三处**。本项目已有机检守卫，但必须显式跑，不能只靠单测。
