# spawn_subagent 契约补全（D2 + non-block + 契约面）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三刀补齐 spawn_subagent 六缺口：契约面（task 结构化/plan 豁免/截断标记/报告骨架）、L3 research-delegate 技能、D2 子任务单据 + non-block 模式。

**Architecture:** 刀B 在工具层组装结构化 prompt（runSubagent 不感知）；刀C 纯资产 skills/ + loader wiring 守卫；刀A 在 SubagentCoordinator 引入 JSONL 账本（PVC 持久）与 background/collect 双工具语义，block 路径行为不变。

**Tech Stack:** TypeScript（pi-runtime，node:test + tsx）、typebox、node:fs JSONL。

**Spec:** `docs/superpowers/specs/2026-11-14-subagent-contract-d2-nonblock-design.md`

## Global Constraints

- block 路径外部行为不变（additive 字段除外）；前端零迁移
- `SUBAGENT_TOOL_WHITELIST` / 并发 2 / 超时 5min / 预算 30 turn 数值不动
- L2 prompt 规则与 L6 预算零改动（prompt:lint 须维持 3197/3200）
- 子代理不可 spawn/collect（嵌套禁令不动）
- 测试基建：pi-runtime 用 `node --import tsx --test`；apps/server 用 nvm node24 + vitest `--maxWorkers=1 --no-file-parallelism`
- 交付：干净快照 + `gh api` REST 推单 PR；**每个 commit 的 base_tree 必须用上一 commit 的 tree**；推后 `compare` 核验 file_count；**合并/部署停授权门**（触发 runtime-deploy，且 skills/ 不在 deploy.yml paths ⇒ pi-runtime 须手工 dispatch）

## Review Focus

1. **后台任务挤占并发槽**：2 槽被 background 占满时，block spawn 应 fail-soft 拒绝并给 hint（不挂起）→ Task 6 测试钉
2. **pod 重启后 collect**：spawned 无 terminal 记录 ⇒ `interrupted`（不是 unknown、不能误报 running）→ Task 6 测试钉
3. **豁免后 plan 期派发**：planPending 时 spawn_subagent 放行、gen 类工具仍拦 → Task 2 测试钉（双向）
4. **截断边界**：raw == MAX 不截、raw == MAX+1 截且 `truncated:true` → Task 3 测试钉
5. **账本坏行**：replay 遇非法 JSON 跳过不抛 → Task 5 测试钉

---

## File Structure

```
services/pi-runtime/src/
  gate/subtask-ledger.ts            # [新建] D2 JSONL 账本（刀A）
  gate/subtask-ledger.test.ts       # [新建]
  gate/subagent.ts                  # [改] coordinator background/collect/ledger + SubagentOutcome.truncated
  gate/subagent.test.ts             # [改]
  gate/plan-gate.ts                 # [改] PLAN_EXEMPT_TOOLS += spawn_subagent
  gate/plan-gate.test.ts            # [改]
  tools/spawn-subagent.ts           # [改] 结构化参数 + compose + mode 分支 + collect 工具
  tools/spawn-subagent.test.ts      # [改]
  tools/config.ts                   # [改] 注册 collect 工具
  session-manager.ts                # [改] truncated 计算（约 :3308）
  metrics.ts                        # [改] collect 计数
  index.ts                          # [改] ledger 接线
  skills/research-delegate.wiring.test.ts  # [新建]
skills/research-delegate/SKILL.md   # [新建]
docs/superpowers/{specs,plans}/2026-11-14-subagent-contract-d2-nonblock-*.md  # [新建]
```

---

### Task 1（刀B）: task 结构化 + 默认报告骨架

**Files:**
- Modify: `services/pi-runtime/src/tools/spawn-subagent.ts`
- Test: `services/pi-runtime/src/tools/spawn-subagent.test.ts`

**Interfaces:**
- Produces: `composeSubagentPrompt(task: string, background?: string, reportFormat?: string): string`、`DEFAULT_REPORT_FORMAT: string`（Task 7 spawn 分支复用）

- [ ] **Step 1: 写失败测试**（spawn-subagent.test.ts 顶部 describe 追加）

```ts
import { composeSubagentPrompt, DEFAULT_REPORT_FORMAT } from "./spawn-subagent.js";

describe("composeSubagentPrompt（刀B task 结构化）", () => {
	it("无 background/reportFormat 时只追加默认骨架", () => {
		const p = composeSubagentPrompt("调研 A vs B");
		assert.equal(p, "调研 A vs B\n【期望报告形态】" + DEFAULT_REPORT_FORMAT);
	});
	it("background 与自定义 reportFormat 都生效", () => {
		const p = composeSubagentPrompt("查 X", "已读过官方文档", "只要对比表");
		assert.ok(p.includes("【背景】已读过官方文档"));
		assert.ok(p.includes("【期望报告形态】只要对比表"));
		assert.ok(!p.includes(DEFAULT_REPORT_FORMAT));
	});
	it("空串字段跳过", () => {
		const p = composeSubagentPrompt("查 X", "  ", "");
		assert.ok(!p.includes("【背景】"));
	});
});
```

- [ ] **Step 2: 跑测试确认红**：`cd services/pi-runtime && node --import tsx --test src/tools/spawn-subagent.test.ts` → FAIL（模块无导出）
- [ ] **Step 3: 实现**（spawn-subagent.ts）

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

parameters 扩为：

```ts
parameters: Type.Object({
	task: Type.String({ description: "要查什么（核心问题清单，越具体越好）" }),
	background: Type.Optional(Type.String({ description: "背景补充（已读过什么/已试过什么/相关约束），可选" })),
	reportFormat: Type.Optional(Type.String({ description: "期望的报告结构与重点，可选；缺省用内置骨架（结论先行+来源清单）" })),
}),
```

execute 内 `const task = composeSubagentPrompt((p?.task ?? "").trim(), p?.background, p?.reportFormat);`（原空校验前移到 p?.task）。

- [ ] **Step 4: 跑测试确认绿**（全套 spawn-subagent.test.ts 13+3 通过）
- [ ] **Step 5: commit** `git add`（快照内不 commit，改用 REST 推链，见 Task 8）

### Task 2（刀B）: plan-gate 豁免 spawn_subagent

**Files:**
- Modify: `services/pi-runtime/src/gate/plan-gate.ts:75`
- Test: `services/pi-runtime/src/gate/plan-gate.test.ts`

- [ ] **Step 1: 写失败测试**（plan-gate.test.ts 追加）

```ts
it("P4 豁免：planPending 时 spawn_subagent 放行（调研是 plan 输入，#841 F5）", () => {
	// arrange：markPlanPending(key)（用既有测试同款装配）
	assert.equal(shouldBlockForPlan("spawn_subagent", "write_light", key), false);
});
it("双向：豁免只放 spawn_subagent，同 tier 的写类工具仍拦", () => {
	assert.equal(shouldBlockForPlan("arrange_nodes", "write_light", key), true);
});
```

- [ ] **Step 2: 红** → **Step 3: 实现**：`new Set(["todo_write", "spawn_subagent"])`（注释：#841 P4，子代理白名单物理只读）→ **Step 4: 绿**（全 plan-gate.test.ts）

### Task 3（刀B）: 截断标记

**Files:**
- Modify: `services/pi-runtime/src/gate/subagent.ts`（SubagentOutcome）、`services/pi-runtime/src/session-manager.ts`（约 :3308）、`services/pi-runtime/src/tools/spawn-subagent.ts`（结果透传）
- Test: `services/pi-runtime/src/tools/spawn-subagent.test.ts`（stub runner）

- [ ] **Step 1: 失败测试**：stub runner 返回 `"x".repeat(20_001)` 的 report → spawn block 结果 `truncated === true`；恰 20_000 → 无 truncated 字段
- [ ] **Step 2: 红**
- [ ] **Step 3: 实现**：

```ts
// gate/subagent.ts
export interface SubagentOutcome {
	report: string; turns: number; durationMs: number; status: SubagentStatus;
	truncated?: boolean;  // report 原文超 SUBAGENT_REPORT_MAX_CHARS 被截尾时置 true
}
```

session-manager.ts 各 return 点（:3308-3320 区段）改为：

```ts
const raw = await this.extractSubagentReport(lane);
const truncated = raw.length > SUBAGENT_REPORT_MAX_CHARS ? true : undefined;
const report = raw.slice(0, SUBAGENT_REPORT_MAX_CHARS);
```

四个 outcome return 追加 `truncated`；fork 段早退（report=""）不带。
spawn 工具 completed 分支：`truncated: outcome.truncated === true ? true : undefined`。

- [ ] **Step 4: 绿**（spawn-subagent.test.ts + session-manager.subagent.test.ts + integration 全绿）

### Task 4（刀C）: research-delegate 技能 + wiring 守卫

**Files:**
- Create: `skills/research-delegate/SKILL.md`
- Create: `services/pi-runtime/src/skills/research-delegate.wiring.test.ts`

- [ ] **Step 1: 写失败测试**（仿 html-craft.wiring.test.ts 三段）

```ts
describe("research-delegate skill wiring", () => {
	it("discoverSkills 含 research-delegate 且 description 含触发词族", () => {
		const entry = discoverSkills(SKILLS_ROOT).find((e) => e.name === "research-delegate");
		assert.ok(entry, "research-delegate 未被 loader 发现");
		for (const word of ["调研", "spawn_subagent", "不适用"]) {
			assert.ok(entry.description.includes(word), `description 缺: ${word}`);
		}
	});
	it("description 完整（>100 字，防 parseSimpleYaml 截断回归）", () => { /* 同 html-craft 第二段 */ });
	it("正文含硬约束关键句（mode 选择/三段写法/来源标注/不派写操作）", () => {
		for (const needle of ["background", "reportFormat", "collect_subagent_result", "【期望报告形态】", "改画布"]) {
			assert.ok(body.includes(needle), `SKILL.md 缺关键约束: ${needle}`);
		}
	});
});
```

- [ ] **Step 2: 红** → **Step 3: 写 SKILL.md**（spec §5 五节 + `## 工具可用性` 尾节：spawn_subagent/collect_subagent_result 主代理常驻可用；子代理不可嵌套）→ **Step 4: 绿**

### Task 5（刀A）: SubtaskLedger

**Files:**
- Create: `services/pi-runtime/src/gate/subtask-ledger.ts` + `.test.ts`

**Interfaces:**
- Produces: `class SubtaskLedger { constructor(dir: string); append(r: SubtaskRecord): void; replay(): Map<string, TerminalState> }`，`SubtaskSpawnRecord` / `SubtaskTerminalRecord`（spec §6.1 形状）

- [ ] **Step 1: 失败测试**：tmpdir 往返（spawned→terminal 后 replay 拿到终态+report）；同 callId 两次 terminal 后行胜；坏行/空行跳过不抛；append 失败（目录变只读）不抛且 degraded=true
- [ ] **Step 2: 红** → **Step 3: 实现**（spec §6.1 代码：appendFileSync + 逐行 JSON.parse 容错 + `degraded` 标志）→ **Step 4: 绿**

### Task 6（刀A）: coordinator background / collect / 账本

**Files:**
- Modify: `services/pi-runtime/src/gate/subagent.ts`、`gate/subagent.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `SubtaskLedger`
- Produces: `tryRun(key, task, opts?: SubagentRunOpts & { mode?: "block"|"background" })` 返回 `{ok:true; promise; callId}`（恒含 callId）；`collect(callId): {status:"running"} | {status:"unknown"} | {status:"interrupted"} | ({status: SubagentStatus} & SubagentOutcome & {callId})`；`constructor(ledger?: SubtaskLedger)`

- [ ] **Step 1: 失败测试**（subagent.test.ts 追加，stub runner 用可控 deferred）：
	1. block tryRun 返回 callId；settle 后 ledger 有 spawned+terminal 两记录
	2. background：立即返回 callId、collect→running、settle 后 collect→终态+report、槽位释放（active 回 0）
	3. **并发挤占**：2 个 background 占满后第 3 个 tryRun（block）→ `concurrency_full`，不挂起
	4. **重启取证**：新 coordinator（同 ledger 目录）collect 已 spawned 无 terminal 的 callId → `interrupted`
	5. 无账本 callId → `unknown`；ledger 缺省（旧构造）全链 no-op
- [ ] **Step 2: 红** → **Step 3: 实现**（spec §6.2：`#inFlight`/`#settled` 双 Map + settle 时 `ledger.append(terminal)` + 槽位 finally 释放 + 懒 replay）→ **Step 4: 绿**（原 subagent.test.ts 全套不回归）

### Task 7（刀A）: collect 工具 + spawn mode 分支 + 注册 + metrics + 接线

**Files:**
- Modify: `tools/spawn-subagent.ts`、`tools/spawn-subagent.test.ts`、`tools/config.ts:57/84`、`metrics.ts`、`index.ts:62`

- [ ] **Step 1: 失败测试**：
	1. spawn `{task, mode:"background"}` → `{ok:true, callId, status:"running", hint}`；metrics spawned +1
	2. `createCollectSubagentTool`：running callId → `{ok:true, status:"running"}`；终态 → report；`collect_subagent_result` 工具存在且 `tier==="read"`
	3. block 结果含 `callId`
- [ ] **Step 2: 红**
- [ ] **Step 3: 实现**：spawn execute 组合 Task 1 compose + mode 分支；`createCollectSubagentTool`（tier:"read"，label「收取子代理结果」，unknown/interrupted 附重派 hint）；config.ts 两处 `spawnTools` 数组改 `[createSpawnSubagentTool(...), createCollectSubagentTool(...)]`；metrics.ts 仿 `observeSubagentSpawned` 加 `observeSubagentCollected(status)` + render 行；index.ts 按 spec §6.4 接线
- [ ] **Step 4: 绿**（spawn-subagent.test.ts + subagent.test.ts + integration + plan-gate 全套）
- [ ] **Step 5: 全量回归**：`node --import tsx --test src/**/*.test.ts`（pi-runtime 全部）+ apps/server `vitest` 两套（assembler/loader/tiering 相关），确认 1817 基线无回归

### Task 8: 文档落快照 + REST 推 PR + 停授权门

- [ ] **Step 1**: 拷贝 spec/plan（本地 `docs/superpowers/{specs,plans}/2026-11-14-subagent-contract-d2-nonblock-*.md`）进快照 docs/
- [ ] **Step 2**: 逐路径 blob sha 比对 master（`16e4fc99`）确认改动集恰为：spawn-subagent.ts(+test)、plan-gate.ts(+test)、subagent.ts(+test)、subtask-ledger.ts(+test)、session-manager.ts、tools/config.ts、metrics.ts、index.ts、research-delegate.wiring.test.ts、skills/research-delegate/SKILL.md、docs×2
- [ ] **Step 3**: REST 推链 blob→tree→commit×3（刀B/刀C/刀A 各一 commit；**每个 commit base_tree = 上一 commit tree**）→ branch `spawn-contract-d2-20261114` → PR（正文落盘回读）
- [ ] **Step 4**: `compare` 核验 DELTA + 并行保留；CI 等绿；**停在合并前等用户授权**（合并后 Nest deploy.yml 自动触发 + pi-runtime 手工 dispatch + skills 随 dispatch 上线）

> **基线刷新注记（2026-11-14 交付期，只追加）**：Task 8 Step 2/3 写作时 master 为 `16e4fc99`；交付前 master 已并行前移到 `685bdb49`（#859–#866，36 路径）。按 MEMORY.md「master 前移」判据逐路径核验：14 个目标路径 `B==M`（前移零交集，净改动可直接复用），2 个路径 `metrics.ts` / `tools/config.ts` 与 #866 C-2a 重叠 ⇒ **基于新 master 重建**（保留 `pi_runtime_acceptance_total` 等并行改动后重放 collect edits），`ALL_PARALLEL_KEPT` / `LOST_COUNT=0`。推链 base 改为 `685bdb49`。

### Task 9: 交付期静态门禁补正（追加，spec §10）

**Files:**
- Modify: `services/pi-runtime/src/tools/tiering.ts`、`services/pi-runtime/src/tools/tiering.test.ts`、`apps/web/src/components/agent/toolPresentation.ts`、`docs/superpowers/{specs,plans}/2026-11-14-subagent-contract-d2-nonblock-*.md`

**背景**：三刀代码 + 全量单测/集成全绿后跑 `verify-tool-tiering` 抓到 A1（新工具落延迟集却被 skill 点名）+ A5（展示注册表漏登）。只跑 `tsc` + 测试不会发现，属交付期真实缺口。

- [x] **Step 1**: `ALWAYS_ON_TOOL_NAMES` 增 `collect_subagent_result`（理由 = 被 L3 点名 + background 唯一回收入口，与常驻 spawn 同段）
- [x] **Step 2**: `TOOL_PRESENTATION` 增 `{ icon: '📥', verb: '收取子代理结果' }`
- [x] **Step 3**: `tiering.test.ts` 补两项归属登记 + 常驻回归锁；`tiering.ts` 注释不写带引号的工具名（防 A2 幽灵项）
- [x] **Step 4: 绿**：三门禁 0 错误（常驻 38 / 延迟 19 / 展示覆盖 55）、`tiering.test.ts` 32/32、`collectRuntimeToolNames` 派生清单覆盖缺口为空、`presentToolStep` 两态均出「收取子代理结果」
- [x] **Step 5**: spec §10 + 本 Task 落档，改动集由 16 路径扩为 **19 路径**
- [x] **Step 6: 变异自检（守卫非恒绿）**：轻量副本上三变异 —— M1 把 `collect_subagent_result` 从 `ALWAYS_ON` 移除 ⇒ A1 RED（exit 1，报「工具分层漂移检出」）；M2 删 `TOOL_PRESENTATION` 条目 ⇒ A5 RED（exit 1）；M3 去掉 skill 里的点名 ⇒ 按数据形态正确放行（A1 不再触发，登记仍覆盖 A5）；还原后重新绿。判 RED 用完整 stdout 的 `exit code` + 漂移标记，不吃管道退出码。
- [x] **Step 7: 全量回归**：pi-runtime 全量 `1877/1877`（152 个测试文件）；三门禁 0 错误；`tiering.test.ts` 32/32；前端展示覆盖等价校验 `missing=[]`；`tsc --noEmit` 仅 1 个本地 vendor 0.85.1 陈旧类型假警报（`isError` 在 0.99.2 存在，CI monorepo 权威）。

> **推链形态注记**：Task 8 Step 3 原写「commit×3（刀B/刀C/刀A）」。交付期因 master 并行前移 + 门禁补正，改为**单 commit**（`base_tree` = 真 master `685bdb49`，只传 19 个改动路径）：等价 squash 结果，且规避多 commit `base_tree` 链的历史踩坑（#858 曾因误用 master tree 导致 `file_count:1`）。

**交付改动集（19）**：刀B 4（spawn-subagent.ts/+test、plan-gate.ts/+test）、刀C 2（SKILL.md、wiring.test.ts）、刀A 8（subtask-ledger.ts/+test、subagent.ts/+test、session-manager.ts、config.ts、metrics.ts、index.ts）、门禁补正 3（tiering.ts、tiering.test.ts、toolPresentation.ts）、docs 2。
