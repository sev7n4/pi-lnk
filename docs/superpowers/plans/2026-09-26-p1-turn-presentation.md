# P1 回合呈现层 Implementation Plan（状态行 + 时间线 + thinking/skillId 透传）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## §0 图形声明

本文档无任何示意图（无 SVG/Mermaid/图片），为纯文字实现计划。

**Goal:** 交付 P1 呈现层：状态行（实时秒数/waiting_user 收口/失败态/token 实耗）、时间线认知负荷控制（默认折叠+注册表人话化+动效节拍）、thinkingLevel 逐请求透传、dock skillId→forceSkills 转接；回合摘要行。

**Architecture:** 后端增量集中在 Nest（`pi-events.ts` 新增 usage 提取、`agent.service.ts` 透传 thinkingLevel/skillId、`TRACE_PERSIST_EVENT_TYPES` 增 `turn_usage`）与 pi-runtime（create body 增 `thinkingLevel`，会话级覆盖默认档位）；前端增量集中在执行过程渲染层（`executionTraceReducer.ts` 增 usage 字段、新增 `toolPresentation.ts` 纯映射注册表、SideRail/Panel/FloatingWindow 三消费方同步）。数据全部由现有事件流派生，不碰 pi-agent-core vendor、不碰 before_tool Gate。

**Tech Stack:** NestJS（apps/server）、Vue 3 + Pinia（apps/web）、fastify（services/pi-runtime）；web/server 测试 vitest，**pi-runtime 测试 node:test**（包约定，勿用 vitest）。

**Spec:** `docs/discussion/2026-09-25-turn-presentation-design.md`（四层呈现模型 + D1-D5 决策 + §6 验收标尺）；skillId 转接决策见 `docs/superpowers/plans/2026-09-25-execution-trace-observability.md` 后继章节「P1 补充（2026-09-26 拍板）」。

## Global Constraints

- `vendor/earendil-works/pi/` 只读；pi-agent-core tool execute 6 参签名不得改。
- ThinkingLevel 合法枚举（vendor `packages/agent/src/types.ts:301`）：`"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`。
- 老 LangGraph 路径（streamFromRuntime）行为不得回归；其事件可能无 toolCallId。
- 前端 tool/thinking 事件消费方 4 处（SideRail/Panel/FloatingWindow/executionTraceReducer）必须同步改造。
- pi-runtime 测试框架是 node:test（`node:test` + `assert/strict`），测试文件用 `.test.ts` 且 `/** @vitest-environment node */` 不适用——照抄 `session-manager.forced-skills.test.ts` 的写法。
- 本机执行：vitest/tsc 用 `./node_modules/.bin/vitest` 直启（npx 卡代理）；长命令 run_in_background；git push/gh 失败重试。
- conventional commits，每 Task 独立提交；分支按 `using-git-worktrees`。
- pi-runtime 部署走 `docs/ops/RUNBOOK-pi-runtime-deploy.md`，**同 tag 重推必须 --no-cache**（runbook 警示）。
- UI 文案简体中文。

## Review Focus

1. **thinking=false 时不得发 thinkingLevel:"off" 以外的值，且默认档位行为不变**（未传 thinkingLevel 的旧 Nest → DEFAULT_THINKING_LEVEL=medium 兜底）——Task 1 测试 T1-3 钉死。
2. **skillId 与文本 /skill 命令同时出现**：显式文本命令优先，skillId 不叠加——Task 2 测试 T2-2 钉死。
3. **skillId 未知名**：fail-soft 按普通消息发送，不 500 不空回复——Task 2 测试 T2-3 钉死。
4. **message_end 缺 usage / usage 数值异常**（0、负数、非数字）：非法值按 0 处理；**本回合从未出现 usage → agent_end 不发 turn_usage**（前端不渲染 tokens 段，杜绝「消耗 0 tokens」误导）；出现过 usage → 全零也发——Task 3 测试 T3-2 钉死。
5. **多轮同 sessionId**：createSessionReplacingStale 重建会话，thinkingLevel 每轮随新会话生效；prompt 阶段不得再改档位（harness thinkingLevel 仅 create 时可设）——Task 1 实现注释钉死。
6. **刷新回放**：turn_usage 持久化后 replay 不产生重复摘要行——Task 3（持久化幂等）+ Task 6（reducer 幂等）共同覆盖。
7. **waiting 假阳性**（chipSet 基于 assistantText 片段匹配，流式途中即命中）：propose pending_confirm 一票通过，纯文本 chip 需文本静默 ≥2s——Task 4 测试 resolveWaiting 钉死。

---

### Task 1: thinkingLevel 逐请求透传（Nest → pi-runtime create）

**Files:**
- Create: `apps/server/src/agent/pi-runtime/thinking-level.ts`
- Modify: `apps/server/src/agent/pi-runtime/thinking-level.test.ts`（同 Task 创建）
- Modify: `apps/server/src/agent/agent.service.ts`（chatConversation → streamFromPiRuntime → ensurePiSession 透传）
- Modify: `apps/server/src/agent/pi-runtime/pi-runtime.client.ts`（createSession body 增 thinkingLevel）
- Modify: `services/pi-runtime/src/index.ts`（create body 增 thinkingLevel，白名单校验）
- Modify: `services/pi-runtime/src/session-manager.ts`（create opts 增 thinkingLevel，覆盖 DEFAULT_THINKING_LEVEL）
- Test: `services/pi-runtime/src/session-manager.thinking-level.test.ts`（新建，node:test）

**Interfaces:**
- Consumes: 前端已发 `thinking: boolean`、`thinkingEffort?: 'high' | 'max'`（AgentSideRail.vue:1658-1662，本任务不改前端）；pi-runtime `SessionManager.create(id, opts)`。
- Produces: 纯函数 `mapThinkingLevel(thinking: boolean | undefined, effort: 'high' | 'max' | undefined): "off" | "medium" | "high"`；pi-runtime create body 可选 `thinkingLevel?: string`；`SessionManager.create` opts 增 `thinkingLevel?: ThinkingLevel`。Task 7 验收依赖本任务。

- [ ] **Step 1: 写失败测试（Nest 纯函数）**

`thinking-level.test.ts`（vitest，server 包）：

```ts
import { describe, expect, it } from 'vitest'
import { mapThinkingLevel } from './thinking-level'

describe('mapThinkingLevel（P1 thinking 透传）', () => {
  it('T1-1: 关闭 → off；开 + high → medium；开 + max → high；开但无 effort → medium', () => {
    expect(mapThinkingLevel(false, 'high')).toBe('off')
    expect(mapThinkingLevel(undefined, undefined)).toBe('off')
    expect(mapThinkingLevel(true, 'high')).toBe('medium')
    expect(mapThinkingLevel(true, 'max')).toBe('high')
    expect(mapThinkingLevel(true, undefined)).toBe('medium')
  })
})
```

映射决策（D-T1）：老 UI effort 只有两档，对齐 PR #20 的 medium 默认——high→medium、max→high（xhigh/max 档位对 agnes 网关支持未验证，保守不上）。

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/server && ./node_modules/.bin/vitest run src/agent/pi-runtime/thinking-level.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现纯函数 + Nest 透传链**

`thinking-level.ts`：

```ts
/** 老契约（thinking:boolean + thinkingEffort:'high'|'max'）→ pi ThinkingLevel。
 * 映射决策 D-T1：high→medium（与生产默认档一致）、max→high；关闭恒 off。 */
export function mapThinkingLevel(
  thinking: boolean | undefined,
  effort: 'high' | 'max' | undefined,
): 'off' | 'medium' | 'high' {
  if (thinking !== true) return 'off'
  return effort === 'max' ? 'high' : 'medium'
}
```

`agent.service.ts`：`streamFromPiRuntime` 签名第 7 参增 `thinkingOpts?: { thinking?: boolean; thinkingEffort?: 'high' | 'max' }`；`ensurePiSession` 调用处（agent.service.ts:685）opts 增：

```ts
      thinkingLevel: mapThinkingLevel(thinkingOpts?.thinking, thinkingOpts?.thinkingEffort),
```

`ensurePiSession` 的 opts 类型同步增 `thinkingLevel?: 'off' | 'medium' | 'high'` 并透传给 `createSessionReplacingStale`。chatConversation 的 pi 分支（agent.service.ts:248）调用处传 `{ thinking, thinkingEffort }`（函数入参已存在，现被丢弃）。`streamFromRuntime` 老路径不动。

`pi-runtime.client.ts`：`createSessionReplacingStale` 的 body 构造增 `...(opts?.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {})`（照 attachments 等既有可选键写法）。

- [ ] **Step 4: pi-runtime 侧（node:test）**

新建 `services/pi-runtime/src/session-manager.thinking-level.test.ts`：

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveThinkingLevel } from "./session-manager.js";

describe("resolveThinkingLevel（P1 thinking 透传）", () => {
  it("合法档位透传；非法值与缺省回落 DEFAULT_THINKING_LEVEL", () => {
    assert.equal(resolveThinkingLevel("off"), "off");
    assert.equal(resolveThinkingLevel("high"), "high");
    assert.equal(resolveThinkingLevel("bogus" as never), DEFAULT_SENTINEL);
    assert.equal(resolveThinkingLevel(undefined), DEFAULT_SENTINEL);
  });
});
```

`DEFAULT_SENTINEL` 即 `DEFAULT_THINKING_LEVEL` 导出值——从 session-manager.ts 追加 `export`（现 const 未导出）并在测试顶部 import 断言相等。

`session-manager.ts` 实现与接线：

```ts
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** 会话级 thinking 档位：Nest 显式传入且合法时覆盖 env 默认（多轮同 sessionId 重建会话即生效）。 */
export function resolveThinkingLevel(level?: string): ThinkingLevel {
	if (level && THINKING_LEVELS.has(level)) return level as ThinkingLevel;
	return DEFAULT_THINKING_LEVEL;
}
```

`create` opts 增 `thinkingLevel?: string`，harness options 的 `thinkingLevel: DEFAULT_THINKING_LEVEL`（session-manager.ts:181）改为 `thinkingLevel: resolveThinkingLevel(opts.thinkingLevel)`。`index.ts` create 路由 body 透传 `thinkingLevel: request.body?.thinkingLevel`。

注意：harness thinkingLevel 仅 create 时可设，prompt 阶段不可改——多轮换档靠 createSessionReplacingStale 重建（现有机制），在实现处加一行注释说明。

- [ ] **Step 5: 全量测试 + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/server && ./node_modules/.bin/vitest run
cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && ./node_modules/.bin/tsc --noEmit && node --test src/session-manager.thinking-level.test.ts
```

（若 pi-runtime package.json 的 test script 与上述不同，以 script 为准——但 node:test 框架不变。）

Expected: 全绿。

```bash
git add apps/server/src/agent/pi-runtime/thinking-level.ts apps/server/src/agent/pi-runtime/thinking-level.test.ts apps/server/src/agent/agent.service.ts apps/server/src/agent/pi-runtime/pi-runtime.client.ts services/pi-runtime/src/index.ts services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-manager.thinking-level.test.ts
git commit -m "feat(agent): dock 深度思考开关逐请求透传 pi-runtime thinkingLevel"
```

---

### Task 2: dock skillId→forceSkills 转接（Nest 侧）

**Files:**
- Modify: `apps/server/src/agent/agent.service.ts`（chatConversation pi 分支 + streamFromPiRuntime）
- Modify: `apps/server/src/agent/agent.service.pi-runtime.test.ts`（追加用例）

**Interfaces:**
- Consumes: `parseSkillCommand`（skill-command.ts 已有）、`PiRuntimeClient.listSkills()`（P0 Task 5 已有）、chatConversation 入参 `skillId?: string`（现被 pi 分支丢弃）。
- Produces: `resolveForceSkills(skillId: string | undefined, userMessage: string, known: { name: string }[] | null): { forceSkills?: string[]; promptText: string }` 纯函数；streamFromPiRuntime 第 7 参区域与 Task 1 的 thinkingOpts 并列为第 8 参 `skillId?: string`（或并入同一 opts 对象，实现时二选一并在提交信息注明）。

- [ ] **Step 1: 写失败测试**

`agent.service.pi-runtime.test.ts` 追加（导出纯函数便于直测；若该文件以服务级 mock 为主，则把纯函数放 `skill-command.ts` 同目录新文件 `resolve-force-skills.ts` 并在其测试文件直测——按既有文件组织习惯，两处任一，测试断言不变）：

```ts
describe('resolveForceSkills（P1 skillId 转接）', () => {
  const known = [{ name: 'ecommerce-product-photo' }, { name: 'listing-copy' }]

  it('T2-1: skillId 命中白名单 → forceSkills=[name]，promptText 保持原消息', () => {
    const out = resolveForceSkills('ecommerce-product-photo', '帮我做白底图', known)
    expect(out).toEqual({ forceSkills: ['ecommerce-product-photo'], promptText: '帮我做白底图' })
  })

  it('T2-2: 文本 /skill 命令优先，skillId 不叠加', () => {
    const out = resolveForceSkills('listing-copy', '/skill ecommerce-product-photo 白底图', known)
    expect(out).toEqual({ forceSkills: ['ecommerce-product-photo'], promptText: '白底图' })
  })

  it('T2-3: skillId 未知名 fail-soft → 无 forceSkills，原文发送', () => {
    const out = resolveForceSkills('no-such-skill', '帮我做白底图', known)
    expect(out).toEqual({ forceSkills: undefined, promptText: '帮我做白底图' })
  })

  it('T2-4: 无 skillId 无命令 → 原样', () => {
    expect(resolveForceSkills(undefined, '你好', known)).toEqual({ forceSkills: undefined, promptText: '你好' })
    expect(resolveForceSkills('listing-copy', '帮我做白底图', null)).toEqual({ forceSkills: undefined, promptText: '帮我做白底图' })
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/server && ./node_modules/.bin/vitest run src/agent/
```

Expected: FAIL（resolveForceSkills 未导出）。

- [ ] **Step 3: 实现**

```ts
/** P1 skillId 转接：dock 技能选择器 → forceSkills；文本 /skill 显式命令优先，未知名 fail-soft。 */
export function resolveForceSkills(
  skillId: string | undefined,
  userMessage: string,
  known: Array<{ name: string }> | null,
): { forceSkills?: string[]; promptText: string } {
  const cmd = parseSkillCommand(userMessage)
  if (cmd && known?.skills_check_ok !== false && cmd.name) {
    // 命令名合法性由调用方已校验的 known 判定（见下）；此处仅负责优先级与降级
  }
  // 实现：cmd 命中 → 走 P0 既有逻辑（校验+promptText 替换）；否则 skillId 命中白名单 → forceSkills
}
```

（实现时展开为无占位版本，逻辑：①`parseSkillCommand(userMessage)` 命中 → 沿用 P0 Task 5 分支（含 listSkills 校验与 rest 替换）；②否则 `skillId?.trim()` 且 `known?.some(s => s.name === skillId)` → `{ forceSkills: [skillId], promptText: userMessage }`；③其余 → `{ forceSkills: undefined, promptText: userMessage }`。函数签名去掉上面草稿里的 `skills_check_ok` 杂质，`known` 类型即 `Array<{ name: string }> | null`。）

`streamFromPiRuntime` 内：把 P0 的内联 `/skill` 解析段（agent.service.ts:697-707）替换为调用 `resolveForceSkills`，`listSkills()` 结果传入；chatConversation pi 分支把 `skillId` 传入 streamFromPiRuntime。老路径 `streamFromRuntime` 不动。

- [ ] **Step 4: 全量测试 + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/server && ./node_modules/.bin/vitest run
```

Expected: 全绿（P0 的 skill-command.test.ts 用例不回归）。

```bash
git add apps/server/src/agent/agent.service.ts apps/server/src/agent/agent.service.pi-runtime.test.ts
git commit -m "feat(agent): dock 技能选择器 skillId 转接 pi-runtime forceSkills（文本命令优先）"
```

---

### Task 3: Nest turn_usage 事件（usage 提取 + 持久化）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts`（extractUsage + createUsageAccumulator）
- Modify: `apps/server/src/agent/pi-runtime/pi-events.test.ts`
- Modify: `apps/server/src/agent/agent.service.ts`（streamFromPiRuntime 接入 + TRACE_PERSIST_EVENT_TYPES 增 `turn_usage`）

**Interfaces:**
- Consumes: pi `message_end` 事件 data 为 `{ message, entryId? }`（vendor harness.md:1153），`message.usage` 形如 `{ input, output, cacheRead, cacheWrite, cost? }`（vendor models.ts calculateCost 读 `usage.input/cacheRead/cacheWrite`，缺 usage 为 undefined）。
- Produces: UI 事件 `{ type: 'turn_usage', data: { inputTokens: number; outputTokens: number } }`——**仅当本回合出现过至少一条带 usage 的 message_end 时**在 agent_end 前恰发一次（从未出现则不发，前端不渲染 tokens 段，杜绝「消耗 0 tokens」误导）；inputTokens 口径 = `usage.input + usage.cacheRead + usage.cacheWrite`（对齐 vendor models.ts:892 calculateCost）。`createUsageAccumulator(): { feed(event: PiRuntimeEvent): UiEvent | null }`——Task 6 前端显示依赖。

- [ ] **Step 1: 写失败测试（pi-events.test.ts 追加）**

```ts
describe("turn_usage（P1 状态行）", () => {
  const msgEnd = (usage?: Record<string, unknown>) =>
    ({
      type: "message_end",
      ts: 1,
      data: { message: usage ? { usage } : {} },
    }) as never;

  it("T3-1: 多条 message_end 累积（inputTokens=input+cacheRead+cacheWrite），agent_end 触发一次", () => {
    const acc = createUsageAccumulator();
    expect(acc.feed(msgEnd({ input: 100, cacheRead: 40, cacheWrite: 10, output: 20 }))).toBeNull();
    expect(acc.feed(msgEnd({ input: 50, output: 30 }))).toBeNull();
    const done = acc.feed({ type: "agent_end", ts: 1, data: {} } as never);
    expect(done).toEqual({ type: "turn_usage", data: { inputTokens: 200, outputTokens: 50 } });
  });

  it("T3-2: 从未出现 usage → agent_end 不发 turn_usage；出现过 usage → 全零也发", () => {
    const accNone = createUsageAccumulator();
    accNone.feed(msgEnd());
    expect(accNone.feed({ type: "agent_end", ts: 1, data: {} } as never)).toBeNull();
    const accZero = createUsageAccumulator();
    accZero.feed(msgEnd({ input: 0, output: 0 }));
    expect(accZero.feed({ type: "agent_end", ts: 1, data: {} } as never)).toEqual({
      type: "turn_usage",
      data: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("T3-3: 无 message_end 直接 agent_end → 不发（null）", () => {
    const acc = createUsageAccumulator();
    expect(acc.feed({ type: "agent_end", ts: 1, data: {} } as never)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/server && ./node_modules/.bin/vitest run src/agent/pi-runtime/pi-events.test.ts
```

Expected: FAIL（createUsageAccumulator 未导出）。

- [ ] **Step 3: 实现 pi-events.ts**

```ts
export interface TurnUsage {
	inputTokens: number;
	outputTokens: number;
}

function extractUsageDelta(event: PiRuntimeEvent): TurnUsage | null {
	if (event.type !== "message_end") return null;
	const usage = (event.data as { message?: { usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown } } })
		.message?.usage;
	if (!usage || typeof usage !== "object") return null;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
	// 口径对齐 vendor models.ts:892 calculateCost：inputTokens = input + cacheRead + cacheWrite
	const inputTokens = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
	return { inputTokens, outputTokens: num(usage.output) };
}

/** P1 状态行：message_end.usage 逐条累积，agent_end 前折叠为一次 turn_usage 事件。
 * 仅当本回合出现过至少一条带 usage 的 message_end 才发（seenUsage 门）——区分
 * 「上游没回 usage」（不显示 tokens 段）与「usage 真为 0」（显示 0），杜绝误导。 */
export function createUsageAccumulator(): {
	feed(event: PiRuntimeEvent): UiEvent | null;
} {
	let input = 0;
	let output = 0;
	let seenUsage = false;
	return {
		feed(event: PiRuntimeEvent): UiEvent | null {
			const delta = extractUsageDelta(event);
			if (delta) {
				seenUsage = true;
				input += delta.inputTokens;
				output += delta.outputTokens;
				return null;
			}
			if (event.type === "agent_end") {
				if (!seenUsage) return null;
				return { type: "turn_usage", data: { inputTokens: input, outputTokens: output } };
			}
			return null;
		},
	};
}
```

`agent.service.ts`：import `createUsageAccumulator`；`streamFromPiRuntime` 主循环内（thinkingUi 同位置）：

```ts
        const usageUi = usageAccumulator.feed(event)
        if (usageUi) {
          executionEvents.push({ type: 'turn_usage', data: usageUi.data })
          yield usageUi as AgentStreamEvent
        }
```

`TRACE_PERSIST_EVENT_TYPES`（agent.service.ts:55 附近）集合追加 `'turn_usage'`。usageAccumulator 在函数开头与 thinkingAccumulator 并列创建。

- [ ] **Step 4: 全量测试 + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/server && ./node_modules/.bin/vitest run
```

Expected: 全绿。

```bash
git add apps/server/src/agent/pi-runtime/pi-events.ts apps/server/src/agent/pi-runtime/pi-events.test.ts apps/server/src/agent/agent.service.ts
git commit -m "feat(agent): pi 链路 turn_usage 事件（message_end usage 汇总 + 持久化）"
```

---

### Task 4: 前端状态行（实时秒数 + waiting_user 收口 + 失败态）

**Files:**
- Create: `apps/web/src/components/agent/turnStatusBar.ts`（纯状态计算）
- Modify: `apps/web/src/components/agent/turnStatusBar.test.ts`（同 Task 创建）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（streaming footer 区接入）
- Modify: `apps/web/src/components/agent/AgentPanel.vue`、`AgentFloatingWindow.vue`（同一行文案，轻量接入）

**Interfaces:**
- Consumes: `ExecutionTraceState`（steps/turnStartedAt）、`agent.isStreaming`、SideRail 既有 `chipSet` computed、store 新增 `proposePendingConfirm` 标志（tool_result name==='propose_generation' 且 result.status==='pending_confirm' 时置位，新回合重置）与 `lastTextDeltaAt`（最近一次 text_delta 时间戳）。
- Produces: ①`turnStatusLine(input: { isStreaming: boolean; turnStartedAt?: number; now: number; waiting: boolean; lastFailed?: string }): { text: string; mode: 'running' | 'waiting' | 'failed' } | null`——`running` → `生成回复中 · Ns`、`waiting` → `等待你确认`（秒数冻结）、`failed` → `生成失败 · <原因摘要>`；②`resolveWaiting(input: { isStreaming: boolean; proposePendingConfirm: boolean; chipSet: string | null; textIdleMs: number }): boolean`——**waiting 判定收紧**（防流式途中 chipSet 片段命中假阳性）：`isStreaming && (proposePendingConfirm || (chipSet !== null && textIdleMs >= 2000))`；③`failureReason(err: unknown): string`——error→人话映射（401→「渠道密钥无效」、403→「渠道无权限」、429→「额度或频率受限」、含 timeout/aborted→「上游响应超时」、其余→「生成失败，请重试」），`lastFailed` 来源即此映射（非 JSON 工具摘要）。Task 6 摘要行复用 `turnStartedAt`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { turnStatusLine, resolveWaiting, failureReason } from '@/components/agent/turnStatusBar'

describe('turnStatusLine（P1 状态行）', () => {
  const t0 = 1_000_000
  it('running：秒数随 now 跳动', () => {
    expect(turnStatusLine({ isStreaming: true, turnStartedAt: t0, now: t0 + 3400, waiting: false }))
      .toEqual({ text: '生成回复中 · 3s', mode: 'running' })
  })
  it('waiting：文案切换且秒数冻结', () => {
    expect(turnStatusLine({ isStreaming: true, turnStartedAt: t0, now: t0 + 9000, waiting: true }))
      .toEqual({ text: '等待你确认', mode: 'waiting' })
  })
  it('failed：带原因摘要，isStreaming 可已为 false', () => {
    expect(turnStatusLine({ isStreaming: false, turnStartedAt: t0, now: t0 + 2000, waiting: false, lastFailed: '渠道密钥无效' }))
      .toEqual({ text: '生成失败 · 渠道密钥无效', mode: 'failed' })
  })
  it('非流式无失败 → null（不渲染状态行）', () => {
    expect(turnStatusLine({ isStreaming: false, turnStartedAt: t0, now: t0, waiting: false })).toBeNull()
  })
})

describe('resolveWaiting（P1 waiting 收紧）', () => {
  it('propose pending_confirm 一票通过（即使文本仍在静默前）', () => {
    expect(resolveWaiting({ isStreaming: true, proposePendingConfirm: true, chipSet: null, textIdleMs: 0 })).toBe(true)
  })
  it('纯文本片段 chip 需文本静默 ≥2s（防流式途中假阳性）', () => {
    expect(resolveWaiting({ isStreaming: true, proposePendingConfirm: false, chipSet: 'copy', textIdleMs: 300 })).toBe(false)
    expect(resolveWaiting({ isStreaming: true, proposePendingConfirm: false, chipSet: 'copy', textIdleMs: 2500 })).toBe(true)
  })
  it('非流式恒 false；无 chip 且无 propose 恒 false', () => {
    expect(resolveWaiting({ isStreaming: false, proposePendingConfirm: true, chipSet: 'plan', textIdleMs: 9999 })).toBe(false)
    expect(resolveWaiting({ isStreaming: true, proposePendingConfirm: false, chipSet: null, textIdleMs: 9999 })).toBe(false)
  })
})

describe('failureReason（P1 失败人话）', () => {
  it('状态码与超时映射；未知兜底', () => {
    expect(failureReason({ status: 401 })).toBe('渠道密钥无效')
    expect(failureReason({ status: 429 })).toBe('额度或频率受限')
    expect(failureReason(new Error('request timeout'))).toBe('上游响应超时')
    expect(failureReason('boom')).toBe('生成失败，请重试')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && ./node_modules/.bin/vitest run src/components/agent/turnStatusBar.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`turnStatusBar.ts` 三个纯函数（`turnStatusLine` 如上测试所示，不重复贴；另两个）：

```ts
/** waiting 收紧：propose pending_confirm 一票通过；文本片段类 chip 需静默 2s
 * （detectAgentChipSet 基于 assistantText 片段匹配，流式途中即可能命中——假阳性防线）。 */
const WAITING_TEXT_IDLE_MS = 2000
export function resolveWaiting(input: {
  isStreaming: boolean
  proposePendingConfirm: boolean
  chipSet: string | null
  textIdleMs: number
}): boolean {
  if (!input.isStreaming) return false
  if (input.proposePendingConfirm) return true
  return input.chipSet !== null && input.textIdleMs >= WAITING_TEXT_IDLE_MS
}

/** error → 人话（来源：SSE error 事件 data / 请求异常；禁用 JSON 工具摘要）。 */
export function failureReason(err: unknown): string {
  const status = (err as { status?: number } | null)?.status
  if (status === 401) return '渠道密钥无效'
  if (status === 403) return '渠道无权限'
  if (status === 429) return '额度或频率受限'
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '')
  if (/timeout|timed?\s*out|abort/i.test(msg)) return '上游响应超时'
  return '生成失败，请重试'
}
```

SideRail 接入：streaming footer 处新增状态行节点——`waiting = resolveWaiting({ isStreaming, proposePendingConfirm: agent.proposePendingConfirm, chipSet: chipSet.value, textIdleMs: Date.now() - agent.lastTextDeltaAt })`；`lastFailed` 取本回合 error 经 `failureReason` 的结果（store 增 `turnError` ref，error 事件/请求异常时置位、新回合重置）。store 增 `proposePendingConfirm`（tool_result 分支：name==='propose_generation' 且 result.status==='pending_confirm' 置位）与 `lastTextDeltaAt`（text_delta 分支更新时间戳），新回合重置。秒数用组件内 `nowSec = ref(Date.now())` + `setInterval(1s)`（streaming 期间启动、结束清除，onUnmounted 兜底清理）。Panel/FloatingWindow 复用同一 computed 的 `text`（无 interval 的静态秒数可接受，注释注明三窗口秒数可能不同步属预期）。

- [ ] **Step 4: 全量测试 + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && ./node_modules/.bin/vitest run
```

Expected: 全绿。

```bash
git add apps/web/src/components/agent/turnStatusBar.ts apps/web/src/components/agent/turnStatusBar.test.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/AgentPanel.vue apps/web/src/components/agent/AgentFloatingWindow.vue
git commit -m "feat(web): 回合状态行——实时秒数/等待确认收口/失败人话"
```

---

### Task 5: 工具展示注册表 + 认知负荷折叠 + 动效节拍

**Files:**
- Create: `apps/web/src/components/agent/toolPresentation.ts`
- Modify: `apps/web/src/components/agent/toolPresentation.test.ts`（同 Task 创建）
- Modify: `apps/web/src/components/agent/executionTraceReducer.ts`（步骤 label 经注册表翻译）
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`、`AgentPanel.vue`、`AgentFloatingWindow.vue`（默认折叠头行 + 展开交互 + stagger CSS）

**Interfaces:**
- Consumes: `ExecutionStep`（kind/status/label/meta.args——P0 已有）。
- Produces: `presentToolStep(step): { icon: string; label: string }`（注册表映射，未知工具兜底 ⚙ 调用 {name}）；`timelineHeadline(trace): string`（`N 步 · 最新：<icon> <label>`）；`collapsedDefault = true`（v1 不做用户偏好持久化）。注册表条目按设计 §2 表格逐条落（load_skill ⚡ 加载技能 / get_canvas_summary 🔍 感知画布 / upsert_media_node ✏️ 创建节点 / propose_generation 🖼️ 提议生成 / run_ 前缀 🎨 生成 / cancel_generation ⏹ 取消生成 / 兜底 ⚙）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { presentToolStep, timelineHeadline } from '@/components/agent/toolPresentation'
import { createExecutionTrace, applyToolCall } from '@/components/agent/executionTraceReducer'

describe('toolPresentation（P1 注册表）', () => {
  it('注册表命中：读工具人话化', () => {
    expect(presentToolStep({ kind: 'tool', label: '调用 get_canvas_summary', status: 'done', startedAt: 0, meta: { toolName: 'get_canvas_summary', args: '3 个节点' } }))
      .toEqual({ icon: '🔍', label: '感知画布 · 3 个节点' })
    expect(presentToolStep({ kind: 'tool', label: '', status: 'running', startedAt: 0, meta: { toolName: 'propose_generation', args: '2 个节点' } }))
      .toEqual({ icon: '🖼️', label: '提议生成 · 2 个节点' })
  })
  it('run_ 前缀与未知工具兜底', () => {
    expect(presentToolStep({ kind: 'tool', label: '', status: 'done', startedAt: 0, meta: { toolName: 'run_image_generation' } }).icon).toBe('🎨')
    expect(presentToolStep({ kind: 'tool', label: '', status: 'done', startedAt: 0, meta: { toolName: 'mystery_tool' } }))
      .toEqual({ icon: '⚙', label: '调用 mystery_tool' })
  })
  it('timelineHeadline：N 步 · 最新一步人话', () => {
    const trace = createExecutionTrace()
    applyToolCall(trace, 'get_canvas_summary', { status: 'ok' }, { args: '3 个节点' })
    applyToolCall(trace, 'propose_generation', { status: 'pending_confirm' }, { args: '3 个节点' })
    expect(timelineHeadline(trace)).toBe('2 步 · 最新：🖼️ 提议生成 · 3 个节点')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && ./node_modules/.bin/vitest run src/components/agent/toolPresentation.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现注册表 + 头行 + 三消费方折叠**

`toolPresentation.ts`：注册表 `TOOL_PRESENTATION: Record<string, { icon: string; verb: string }>`（设计 §2 六条 + 兜底）；`presentToolStep` 拼 `verb · args`（args 空则只 verb，完成态加注册表完成文案列——实现按设计表「完成态文案」第三列，running 态用动词短语）；`timelineHeadline` 取 `trace.steps.filter(kind!=='phase')` 计数与最后一步。三个组件：执行过程区域包一层 `expanded` ref（默认 false），折叠时只渲染头行 `<div class="agent-trace-head">`，点击 toggle；步骤列表项加 `style="animation-delay: {i*60}ms"` 的 stagger 入场 class 与 done ✓ 过渡 class（纯 CSS keyframes，加在组件 `<style scoped>`）。

- [ ] **Step 4: 全量测试 + 提交**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && ./node_modules/.bin/vitest run
```

Expected: 全绿（executionTraceReducer 存量用例不回归——reducer 本任务不改逻辑，翻译只在前端展示层）。

```bash
git add apps/web/src/components/agent/toolPresentation.ts apps/web/src/components/agent/toolPresentation.test.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/AgentPanel.vue apps/web/src/components/agent/AgentFloatingWindow.vue
git commit -m "feat(web): 执行过程默认折叠+工具注册表人话化+步骤动效节拍"
```

---

### Task 6: token 实耗显示 + 回合摘要行

**Files:**
- Modify: `apps/web/src/components/agent/executionTraceReducer.ts`（trace 增 `usage?: { inputTokens: number; outputTokens: number }`，applyTurnUsage 幂等覆盖）
- Modify: `apps/web/src/components/agent/executionTraceReducer.test.ts`
- Modify: `apps/web/src/stores/agent.ts`（turn_usage 事件 → applyTurnUsage）
- Modify: Task 4 的三组件（footer 追加摘要行）

**Interfaces:**
- Consumes: Task 3 的 `turn_usage` 事件；`replayExecutionTraceEvents`（P0 持久化回放）。
- Produces: `applyTurnUsage(trace, usage)`（重复调用覆盖不叠加——replay 幂等）；摘要行 `turnSummaryLine(trace): string | null`（done 后一次：`已创建 N 个节点 · 提议生成 M 张 · 用时 Ss · 消耗 X.Xk tokens`，数据源 steps（kind==='canvas' 计 add_node、toolName==='propose_generation' 计张数）+ totalMs + usage；无 usage 时省略 tokens 段）。

- [ ] **Step 1: 写失败测试（executionTraceReducer.test.ts 追加）**

```ts
describe('applyTurnUsage + turnSummaryLine（P1 摘要行）', () => {
  it('T6-1: usage 覆盖幂等（replay 不叠加）', () => {
    const trace = createExecutionTrace()
    applyTurnUsage(trace, { inputTokens: 100, outputTokens: 20 })
    applyTurnUsage(trace, { inputTokens: 100, outputTokens: 20 })
    expect(trace.usage).toEqual({ inputTokens: 100, outputTokens: 20 })
  })
  it('T6-2: 摘要行组装节点数/张数/耗时/tokens；无 usage 省略 tokens 段', () => {
    const trace = createExecutionTrace()
    trace.totalMs = 16000
    applyTurnUsage(trace, { inputTokens: 3000, outputTokens: 400 })
    // 预置：2 条 add_node canvas 步 + 1 条 propose_generation tool 步（测试内用 applyCanvasAction/applyToolCall 构造）
    expect(turnSummaryLine(trace)).toBe('已创建 2 个节点 · 提议生成 3 张 · 用时 16s · 消耗 3.4k tokens')
  })
  it('T6-3: replay 后摘要行完整（totalMs 取持久化事件重放结果，非回放时刻）', () => {
    const source = createExecutionTrace()
    applyToolCall(source, 'propose_generation', { status: 'pending_confirm' }, { args: '1 个节点' })
    applyTurnUsage(source, { inputTokens: 500, outputTokens: 100 })
    finalizeExecutionTrace(source)
    const replayed = createExecutionTrace()
    replayExecutionTraceEvents(replayed, collectEventsForReplay(source))
    finalizeExecutionTrace(replayed)
    expect(turnSummaryLine(replayed)).toBe(turnSummaryLine(source))
  })
```

（`collectEventsForReplay` 是测试辅助：把 source.steps 序列化为 P0 持久化 executionEvents 形态——按 `replayExecutionTraceEvents` 真实入参构造，实现时展开。若 replay 路径不还原 totalMs，则 `finalizeExecutionTrace` 增分支：steps 存在但 totalMs 未定且末步 endedAt 可用时以事件时间差兜底，并在测试钉死。）
})
```

- [ ] **Step 2: 运行确认失败 → Step 3: 实现 → Step 4: 全量测试**

（同前任务节拍：reducer 增 `usage` 可选字段与 `applyTurnUsage`/`turnSummaryLine` 导出；store 事件 switch 增 `case 'turn_usage': applyTurnUsage(lastAssistant 执行 trace, event.data)`——沿 thinking 事件同款接线；三组件 done 后渲染摘要行。张数取 propose_generation 的 args `N 个节点` 解析数字，或 result.status==='pending_confirm' 计 1——实现取 args 数字优先。）

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && ./node_modules/.bin/vitest run
```

Expected: 全绿。

```bash
git add apps/web/src/components/agent/executionTraceReducer.ts apps/web/src/components/agent/executionTraceReducer.test.ts apps/web/src/stores/agent.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/AgentPanel.vue apps/web/src/components/agent/AgentFloatingWindow.vue
git commit -m "feat(web): token 实耗显示与回合摘要行（节点/张数/耗时/tokens）"
```

---

### Task 7: 端到端验收与部署

**Files:**
- 只读核对：`docs/ops/RUNBOOK-pi-runtime-deploy.md`
- 无代码改动（验收不过回对应 Task 修复后重跑）

- [ ] **Step 1: 三包测试全绿**（web/server vitest；pi-runtime 按包约定 node:test）。
- [ ] **Step 2: `pnpm verify-spec-figures --file docs/superpowers/plans/2026-09-26-p1-turn-presentation.md`** Expected: PASS。
- [ ] **Step 3: pi-runtime 先部署**（Task 1 的 create body 变更向后兼容：旧 Nest 不发 thinkingLevel → DEFAULT 兜底）。按 runbook：rsync → docker build（**--no-cache**）→ helm `--set image.tag=<新版本>` → curl :30100/metrics healthy。之后 `docker exec` 验证 dist 含新代码（runbook 警示）。
- [ ] **Step 4: Nest + 前端过发布门**：merge master → dispatch deploy.yml → 三件套（镜像 sha+healthy / PI_RUNTIME_MODE=active / thread-verify PASS=16 FAIL=0）。
- [ ] **Step 5: 生产 usage 探针（Task 3 数据源实证）**：SSE 直探一轮真实对话，确认 `message_end` 事件的 `message.usage` 非空且 `turn_usage` 事件到达前端。**若 agnes 流式不回 usage**（OpenAI 流式需 `stream_options:{include_usage:true}`）：tokens 显示整体降级为不显示（状态行只留秒数、摘要行省略 tokens 段——T3 的 seenUsage 门已保证），并在计划执行记录中注明。
- [ ] **Step 6: 浏览器实测（对照设计 §6 标尺 1-8）**：①发送 1s 内「生成回复中 · 0s」跳动；②确认 chip 出现时状态行「等待你确认」且秒停；③dock 开深度思考 → 执行过程出现「深度思考」步骤且关掉后消失（T1 链路）；**开 max 档发一轮，确认上游接受 reasoning_effort=high 不 400**（D-T1 映射实证）；④dock 选技能 → 执行过程「已加载技能 · <名>」（T2 链路）；⑤默认折叠头行「N 步 · 最新：…」，展开逐条图标人话；⑥回合结束摘要行；⑦刷新回放完整；⑧失败态（可拔 BYOK key 构造 401）「生成失败 · 渠道密钥无效」。

## Self-Review 记录

- 规格覆盖：设计 §4 P1 两行全部条目 → Task 4（状态行四要素）、Task 5（折叠/注册表/动效）、Task 1（thinking 透传）、Task 6（usage+摘要行）；skillId 转接（2026-09-26 拍板）→ Task 2；验收标尺 1-8 → Task 7 Step 5。设计 §3「pi-runtime create body 增 thinking」由 Task 1 以 thinkingLevel 形式落地（增强：逐请求而非仅开关布尔）。
- 占位符扫描：Task 2 Step 3 给出完整逻辑分支文字与测试钉死行为；Task 6 Step 2-4 合并节拍但测试代码完整、数据源明确。无 TBD。
- 类型一致性：`mapThinkingLevel`（Task 1 定义、agent.service 消费）；`resolveThinkingLevel`（Task 1 pi-runtime 侧）；`resolveForceSkills`（Task 2 定义即用）；`turn_usage` data 形状 Task 3 产出 = Task 6 消费；`turnStatusLine`/`turnSummaryLine` Task 4/6 定义、Task 4/6 消费。
- Review Focus 六条 → T1-3（Task 1 Step 1 断言 off 兜底——补在实现注释与测试：`mapThinkingLevel(false,…)==='off'` 且 pi-runtime 非法值回落 DEFAULT，即 T1-3 由 resolveThinkingLevel 测试承载）、T2-2/T2-3（Task 2）、T3-2（Task 3）、Task 1 实现注释（多轮换档）、Task 3 持久化 + Task 6 覆盖幂等（T6-1）。
