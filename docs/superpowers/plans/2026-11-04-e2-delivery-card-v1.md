# E2 交付卡（delivery-card v1）Implementation Plan

> ⭐ **状态（2026-11-04 拆分）**：本计划重构为 **E2-b**，凭 E2-a（[`2026-11-04-e2a-ghost-delivery-summary.md`](./2026-11-04-e2a-ghost-delivery-summary.md)，幽灵摘要先行）埋点数据准入，**暂不实施**。Task 5（埋点端点）已由 E2-a Task 3 提前承接。Task 1-4/6/7/9/10 的设计与代码骨架在 E2-b 实施时原样有效（尤其 Task 6 单调守卫是 E2-b 前置）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产物在对话流内可消费（交付卡四要素：锚/态/体/动作），终态子态精确表达，同回合多产物聚合组卡；回合外补拍经常驻订阅秒级原地翻正。

**Architecture:** 三栈单向扩字段——pi-runtime（NodeStatusData v2 类型 + 补拍 + 工具域元数据 + roundKey 盖戳）→ Nest（pi-events 白名单透传 + 小型埋点端点）→ web（mapNodeStatusV2 单调守卫 + 两个渲染纯函数 + 交付卡渲染 + 常驻订阅）。不新增事件类型与传输通道；`GenerationTerminalNotice` 零改动（评审裁决 1：roundKey 双通道分离）。

**Tech Stack:** TypeScript / Fastify（pi-runtime）/ NestJS + vitest（server）/ Vue 3 + vitest（web）。

**Spec:** `docs/superpowers/specs/2026-11-02-delivery-card-v1-design.md`（已评审拍板 2026-11-04：§5.5 补拍送达 = 常驻订阅消费面收窄；§7 修订 = GenerationTerminalNotice 不加字段）。执行者须同读规格与本计划。

## Global Constraints

- `NodeStatusData` 三态词表**不变**（generating/done/failed）；`terminalState` 是子态标注，绝不独立触发终态翻动（D-2）。
- `done` 唯一入口 = 有正据（url 或 summary）；timeout/fallback_pending 下发时 `status` 保持 `generating`（D-2）。
- 新增字段全部走事件 data 与 details 面，`content` 文本 JSON 不变长（D-4）。
- mapNodeStatusV2 的 status 单调守卫是**净新增**（前端无既有守卫）——补拍与 backfill 幂等性完全依赖它（§5.3 修正）。
- 工具活体回合 roundKey 由 session-manager 自动盖 `currentRunId`；补拍不携带（裁决 1）。
- 内联起播一律用户手势触发，禁 autoplay（§11.3）。
- 样式只用 `--lnk-*` 令牌，禁 `--neo-*` / 新增 hex（设计体系硬约束）；移动端浮层走 MobileSheet 基座。
- 测试纪律：vitest `--maxWorkers=1 --no-file-parallelism`（node24）；集成测试禁固定 sleep，一律 `vi.waitFor`。
- 推送纪律：git https 502 时走 REST Git Data API，blob sha 逐项核对；commit 只在 worktree。
- `services/pi-runtime/**` 有改动 ⇒ 合并后须手动 dispatch `runtime-deploy`。

## Review Focus

1. **status 回退**：SSE 重连重放/乱序补发时，晚到的 `generating` 不得把 `done` 卡打回 running——mapNodeStatusV2 单调守卫（Task 6 变异测试钉死）。
2. **补拍 vs 等待者竞态**：工具仍在等待时（hasGenerationWait=true）补拍必须被抑制——等待者自己会发终态，双源下发会产生 done→generating 抖动（Task 2 测试钉死）。
3. **补拍 vs backfill 并发**：常驻订阅补拍与 useGenerationPolling 回填同拍到达同一 part——单调守卫 + 幂等 upsert 保证不重复建卡（Task 6/9）。
4. **completed 无正据**：Nest 通报 completed 但 url 为空 ⇒ 不补拍 done（D-2 有正据才动），backfill 兜底（Task 2 测试钉死）。
5. **订阅泄漏**：常驻订阅双开 / 页面隐藏不断开 ⇒ 服务端连接堆积——单例守卫 + visibilitychange 强制断开（Task 9 静态契约 + 变异）。

---

### Task 1: pi-runtime — NodeStatusData v2 类型 + dispatchNodeStatus 盖 roundKey

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts:159-168`（NodeStatusData）、`:2143-2155`（dispatchNodeStatus）
- Test: `services/pi-runtime/src/session-manager.delivery-v2.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 `dispatchNodeStatus(canvasSessionId, data): number`；`entry.currentRunId`（既有字段，session-manager:1567 由 run_start 盖戳）。
- Produces: `NodeStatusData` 增可选字段 `kind?/mimeType?/durationMs?/posterUrl?/version?/roundKey?/terminalState?/summary?`；dispatch 后事件 data.roundKey 保证为「显式传入 || entry.currentRunId」。

- [ ] **Step 1: 写失败测试**

```ts
// services/pi-runtime/src/session-manager.delivery-v2.test.ts
import { describe, it, expect, beforeEach } from "vitest";
// 复用本仓既有 session-manager 测试的构建辅助（沿用其 import 路径与构造方式；
// 若既有测试以 makeManager 助手起会话，直接复用之，下方以 sm 指代已注册会话的实例）
import { SessionManager } from "./session-manager.js";

describe("NodeStatusData v2：roundKey 盖戳", () => {
  it("活体回合：未传 roundKey 时自动盖 entry.currentRunId", () => {
    const sm = new SessionManager({} as never);
    const seen: Array<{ type: string; data: Record<string, unknown> }> = [];
    sm.dispatchNodeStatus("cv1", { nodeId: "n1", status: "generating" });
    // 经 dispatch 管道断言：注册一个 listener 抓 node_status 事件
    // （沿用既有测试的 subscribe 助手；核心断言如下）
    // expect(seen.at(-1)!.data.roundKey).toBe("<currentRunId>")
  });

  it("显式 roundKey 优先，不被盖戳覆盖", () => {
    // sm.dispatchNodeStatus("cv1", { nodeId, status, roundKey: "explicit" })
    // expect(data.roundKey).toBe("explicit")
  });

  it("无 currentRunId（idle 会话）且未传 ⇒ roundKey 缺省（不伪造）", () => {
    // expect("roundKey" in data).toBe(false)
  });
});
```

测试骨架以本仓既有 `session-manager` 测试的真实构造方式为准（先 `grep -rn "new SessionManager" services/pi-runtime/src/*.test.ts` 找可复用助手，把上面三例落成真实可跑代码——事件捕获用 `sm.subscribe(threadKey, listener)` 抓 `node_status`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && ../../node_modules/.bin/vitest run src/session-manager.delivery-v2.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（roundKey 未盖戳）

- [ ] **Step 3: 最小实现**

```ts
// session-manager.ts — NodeStatusData 扩展（:159）
export interface NodeStatusData {
	nodeId: string;
	status: "generating" | "done" | "failed";
	url?: string;
	error?: string;
	// ── v2 交付元数据（2026-11-04 delivery-card-v1；全部可选，旧消费者逐字节忽略）──
	/** 交付卡渲染路由（done/failed 时尽量给）。 */
	kind?: "image" | "video" | "audio" | "text";
	/** 内联播放器编解码提示。 */
	mimeType?: string;
	/** 音视频时长（ms）。 */
	durationMs?: number;
	/** 视频首帧/音频封面。 */
	posterUrl?: string;
	/** 产物版本锚（D-3；上游根因包落地前空缺）。 */
	version?: number;
	/** 批次键：活体回合由 dispatchNodeStatus 自动盖 currentRunId；显式传入优先。 */
	roundKey?: string;
	/** running 的可见子态（D-2：绝不独立触发终态翻动）。 */
	terminalState?: "timeout" | "fallback_pending";
	/** text 产物首行摘要（≤80 字）。 */
	summary?: string;
}

// dispatchNodeStatus（:2143）——盖戳只此一处：
dispatchNodeStatus(canvasSessionId: string, data: NodeStatusData): number {
	let hits = 0;
	for (const entry of this.sessions.values()) {
		const key = entry.canvasSessionId ?? entry.id;
		if (key !== canvasSessionId) continue;
		entry.lastProgressAt = Date.now();
		// v2 裁决 1：活体回合批次键——显式传入优先，否则盖当前 runId；无 runId 不伪造。
		const stamped: NodeStatusData =
			data.roundKey || !entry.currentRunId
				? data
				: { ...data, roundKey: entry.currentRunId };
		this.dispatch(entry, { type: "node_status", ts: Date.now(), data: stamped });
		hits += 1;
	}
	return hits;
}
```

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令，Expected: PASS；另跑 `session-manager` 既有测试文件确认零回归）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/session-manager.ts services/pi-runtime/src/session-manager.delivery-v2.test.ts
git commit -m "feat(pi-runtime): NodeStatusData v2 类型扩展 + dispatchNodeStatus 自动盖 roundKey（E2 Task 1）"
```

---

### Task 2: pi-runtime — notifyGenerationTerminal 补拍 node_status v2

**Files:**
- Modify: `services/pi-runtime/src/session-manager.ts:2202-2226`（notifyGenerationTerminal）
- Test: `services/pi-runtime/src/session-manager.delivery-v2.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `NodeStatusData` v2；既有 `dispatchNodeStatus`、`hasGenerationWait(canvasId, nodeId)`。
- Produces: notify-generation 到达时（未抑制）在 followUp 之外同步派发补拍 node_status；返回值形态不变 `{ delivered, reason? }`。

- [ ] **Step 1: 写失败测试**（追加到 Task 1 测试文件）

```ts
describe("notifyGenerationTerminal 补拍（E2 §7）", () => {
  it("completed+url ⇒ 补拍 done（含 url、kind 映射），followUp 照旧", () => {
    // await sm.notifyGenerationTerminal(thread, { nodeId: "n1", status: "completed", url: "https://x/a.png", kind: "图片", recordId: "r1" })
    // 断言①：node_status 事件 status==="done" && url==="https://x/a.png" && kind==="image"
    // 断言②：followUp 仍被调用（简报轮不受影响）——按既有测试对 followUp 的观察方式断言
  });

  it("completed 无 url ⇒ 不补拍（D-2 有正据才动），followUp 照旧", () => {
    // 断言：无 node_status 事件；delivered===true
  });

  it("failed ⇒ 补拍 failed（error 透传）", () => {});

  it("工具等待期（hasGenerationWait 命中）⇒ 抑制：既不 followUp 也不补拍", () => {
    // 既有抑制语义不变：delivered===false, reason==="tool-wait-active"，且无 node_status
  });

  it("补拍不携带 roundKey（裁决 1：批次键双通道分离）", () => {
    // expect("roundKey" in 补拍事件.data).toBe(false)
  });
});
```

kind 映射表（Nest kindLabel 中文 → v2 enum）：`图片→image / 视频→video / 音频→audio / 文案→text`；未知值不传 kind（fail-soft，卡退化用节点 nodeType）。

- [ ] **Step 2: 跑测试确认失败**（同 Task 1 命令）

- [ ] **Step 3: 最小实现**（notifyGenerationTerminal 内，抑制分支之后、followUp 之前）

```ts
// 会话存在（require 已过）且工具未等待 ⇒ 补拍 v2（E2 §7）：
// - completed 且有 url ⇒ done（有正据才动，D-2）；completed 无 url ⇒ 不补拍（backfill 兜底）
// - failed ⇒ failed（error 透传）
// - 不携带 roundKey（裁决 1：批次键双通道分离，§5.5）
const KIND_MAP: Record<string, NodeStatusData["kind"]> = {
  图片: "image", 视频: "video", 音频: "audio", 文案: "text",
};
const kind = (data.kind && KIND_MAP[data.kind]) || undefined;
if (data.status === "completed" && data.url) {
  this.dispatchNodeStatus(canvasId, { nodeId: data.nodeId, status: "done", url: data.url, ...(kind ? { kind } : {}) });
} else if (data.status === "failed") {
  this.dispatchNodeStatus(canvasId, { nodeId: data.nodeId, status: "failed", ...(data.error ? { error: data.error } : {}), ...(kind ? { kind } : {}) });
}
```

- [ ] **Step 4: 跑测试确认通过** + 既有 notify/suppress 相关测试零回归

- [ ] **Step 5: Commit** `feat(pi-runtime): notify-generation 补拍 node_status v2（E2 Task 2，裁决 1 不携带 roundKey）`

---

### Task 3: pi-runtime — 工具域 v2 元数据 + terminalState 子态 + flag

**Files:**
- Modify: `services/pi-runtime/src/tools/generation.ts:142-157`（emitTerminalFromResult）、`:186-198`（runTool execute 内起手 emit）
- Test: `services/pi-runtime/src/tools/generation.delivery-v2.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 `emitNodeStatus(tc, data)`（generation.ts 内部助手）、`withGenSignal`。
- Produces: timeout/fallback_pending ⇒ 下发 `{status:"generating", terminalState}` 子态（现状是纯不下发）；done 补 kind/mimeType/durationMs/version/summary（fail-soft，源字段缺失即缺省）；env `PI_RUNTIME_DELIVERY_META=off` 时 v2 字段全部剥离。

- [ ] **Step 1: 写失败测试**（工具域单测沿用既有 generation 测试的 fake tc/emit 捕获方式；先 `ls services/pi-runtime/src/tools/*.test.ts` 找参照）

```ts
describe("emitTerminalFromResult v2", () => {
  it("data.status==='timeout' ⇒ 下发 {status:'generating', terminalState:'timeout'}（D-2 子态）");
  it("data.status==='fallback_pending' ⇒ 下发子态 fallback_pending");
  it("done：data 带 mimeType/durationMs ⇒ 透传；不带 ⇒ 缺省不伪造");
  it("kind 从工具名派生：run_image_generation→image / run_video_generation→video / run_music_generation→audio / run_text_generation→text");
  it("PI_RUNTIME_DELIVERY_META=off ⇒ 事件 data 不含任何 v2 字段（逐字节旧形态）");
  it("v2 字段注入不影响工具返回值（withGenSignal 形态不变）");
});
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 最小实现**

```ts
// generation.ts 顶部
const KIND_BY_TOOL: Record<string, NodeStatusData["kind"]> = {
  run_image_generation: "image", run_image_edit: "image", run_image_upscale: "image",
  run_video_generation: "video", run_music_generation: "audio", run_text_generation: "text",
  run_prompt_generation: "text",
};
function deliveryMetaEnabled(): boolean {
  return process.env.PI_RUNTIME_DELIVERY_META !== "off";
}
// v2 字段白名单剥离（flag off ⇒ 逐字节旧形态）
function stripV2(data: NodeStatusData): NodeStatusData {
  if (deliveryMetaEnabled()) return data;
  const { kind, mimeType, durationMs, posterUrl, version, roundKey, terminalState, summary, ...rest } = data;
  return rest;
}
// emitNodeStatus 出口统一过 stripV2；runTool 起手 emit 与 emitTerminalFromResult 都走它。
// emitTerminalFromResult 改造：
const emitTerminalFromResult = (tc, nodeId, data, toolName: string) => {
  const url = ...;
  if (url) {
    emitNodeStatus(tc, stripV2({
      nodeId, status: "done", url,
      ...(KIND_BY_TOOL[toolName] ? { kind: KIND_BY_TOOL[toolName] } : {}),
      ...(typeof data.mimeType === "string" ? { mimeType: data.mimeType } : {}),
      ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
      ...(typeof data.version === "number" ? { version: data.version } : {}),
      ...(typeof data.summary === "string" ? { summary: data.summary.slice(0, 80) } : {}),
    }));
    return;
  }
  const status = String(data.status ?? "");
  // v2：timeout / fallback_pending ⇒ running 的可见子态（D-2：status 保持 generating）
  if (status === "timeout" || status === "fallback_pending") {
    emitNodeStatus(tc, stripV2({ nodeId, status: "generating", terminalState: status as "timeout" | "fallback_pending" }));
    return;
  }
  // failed 分支同 done 补 kind；调用点（:198/:331）传 toolName。
};
```

- [ ] **Step 4: 跑测试确认通过** + generation 既有测试零回归
- [ ] **Step 5: Commit** `feat(pi-runtime): 工具域 v2 元数据 + timeout/fallback_pending 子态下发 + PI_RUNTIME_DELIVERY_META flag（E2 Task 3）`

---

### Task 4: Nest — pi-events node_status 白名单扩 v2（契约镜像 fixture）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/pi-events.ts:220-236`（node_status case）
- Test: `apps/server/src/agent/pi-runtime/pi-events.delivery-v2.test.ts`（新建）

**Interfaces:**
- Consumes: pi-runtime 侧 `node_status` 事件 data（Task 1-3 产出）。
- Produces: `mapPiEventToUiEvent` 的 node_status 分支透传 `kind/mimeType/durationMs/posterUrl/version/roundKey/terminalState/summary`；缺字段不报错（旧 runtime + 新 Nest 逐字节兼容）。

- [ ] **Step 1: 写失败测试**

```ts
// 契约镜像 fixture（与 Task 6 web 消费测试共用同形样例；两份字面量逐字段一致——
// 跨包导入不可行（P1 教训），漂移由两侧测试的 fixture 断言对称性约束）
export const NODE_STATUS_V2_FIXTURE = {
  nodeId: "n1", status: "done", url: "https://x/a.png",
  kind: "image", mimeType: "image/png", durationMs: 1234,
  posterUrl: "https://x/a.jpg", version: 3, roundKey: "run-1",
} as const;
// it("v2 字段全量透传") / it("缺 v2 字段（旧 runtime）⇒ 透传结果不含 undefined 键，旧行为逐字节不变") / it("terminalState+generating 透传")
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 最小实现**（case "node_status" 的 d 类型与 return ui() 各补八字段，形态照既有白名单——缺省键不写进返回对象）

```ts
const d = event.data as { nodeId?: string; status?: string; url?: string; error?: string;
  kind?: string; mimeType?: string; durationMs?: number; posterUrl?: string;
  version?: number; roundKey?: string; terminalState?: string; summary?: string };
return ui("node_status", {
  nodeId: d.nodeId, status: d.status, url: d.url, error: d.error,
  ...(d.kind ? { kind: d.kind } : {}), ...(d.mimeType ? { mimeType: d.mimeType } : {}),
  ...(typeof d.durationMs === "number" ? { durationMs: d.durationMs } : {}),
  ...(d.posterUrl ? { posterUrl: d.posterUrl } : {}),
  ...(typeof d.version === "number" ? { version: d.version } : {}),
  ...(d.roundKey ? { roundKey: d.roundKey } : {}),
  ...(d.terminalState ? { terminalState: d.terminalState } : {}),
  ...(d.summary ? { summary: d.summary } : {}),
});
```

- [ ] **Step 4: 跑测试确认通过** + `pi-events` 既有测试零回归 + `cd apps/server && npx tsc --noEmit`
- [ ] **Step 5: Commit** `feat(agent): pi-events node_status 白名单透传 v2 交付元数据（E2 Task 4）`

---

### Task 5: Nest — 交付卡埋点端点（小）

**Files:**
- Create: `apps/server/src/agent/delivery-metrics.controller.ts`
- Modify: `apps/server/src/agent/agent.module.ts`（注册 controller）
- Test: `apps/server/src/agent/delivery-metrics.controller.test.ts`

**Interfaces:**
- Produces: `POST /api/agent/metrics/delivery`（AuthGuard），body `{ events: Array<{ type: "impression"|"open"|"inline_play"|"retry"; nodeId?: string; kind?: string; ts?: number }> }`；进程内存计数（notify-metrics 同模式），经 `GET /api/health/notify-metrics` 追加 `deliveryCard:{...}` 面。

- [ ] **Step 1: 写失败测试**（Auth mock + events 空数组 400 / 正常批次 201 + 计数递增）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 最小实现**（controller 内 `Map<string, number>` 计数 + notify-metrics.health 快照对象合并；批量上限 50，超出 400）
- [ ] **Step 4: 跑测试确认通过** + `npx tsc --noEmit`
- [ ] **Step 5: Commit** `feat(agent): 交付卡埋点端点（E2 Task 5，notify-metrics 同模式内存计数）`

---

### Task 6: web — turnTimeline part 扩展 + mapNodeStatusV2 单调守卫

**Files:**
- Modify: `apps/web/src/components/agent/turnTimeline.ts:61-90`（artifact part 类型）、`:175`（node_status 事件类型）、`:545-590`（node_status 应用分支）
- Test: `apps/web/src/components/agent/turnTimeline.deliveryV2.test.ts`（新建）

**Interfaces:**
- Produces: artifact part 增可选 `kind?/durationMs?/posterUrl?/version?/roundKey?/terminalState?/summary?/lateNotify?`；`mapNodeStatusV2(timeline, evt)` 语义 = 单调守卫 + v2 upsert；timeline 事件 `node_status` data 增内部透传字段（wire 之外）`late?: boolean`（常驻订阅来源标记，Task 9 使用）。

- [ ] **Step 1: 写失败测试**

```ts
// 沿用既有 turnTimeline 测试构建 timeline 的方式（applyTimelineEvent 空 timeline 起步）
it("单调守卫：done 后晚到 generating ⇒ status 保持 done（净新增守卫，Review Focus 1）", () => {
  apply(tl, { type: 'node_status', data: { nodeId: 'n1', status: 'done', url: 'https://x/a.png' } })
  apply(tl, { type: 'node_status', data: { nodeId: 'n1', status: 'generating' } })
  const p = findArtifact(tl, 'n1')
  expect(p!.status).toBe('done')
})
it("failed↔done 同级不互翻：done 后晚到 failed 不回退（有正据优先）", () => {})
it("terminalState 子态：generating+terminalState='timeout' ⇒ part.status==='running' && part.terminalState==='timeout'")
it("子态晚到不回退 done：done 后到达 generating+terminalState ⇒ status 仍 done 且 terminalState 不落")
it("done 且有 url ⇒ kind/durationMs/posterUrl/version/summary upsert；缺省键不落 undefined")
it("v2 字段缺失（旧 runtime）⇒ 逐字节旧行为（status/url/errorText 路径不变）")
it("late:true（常驻订阅来源）⇒ part.lateNotify=true；live 路径不带 ⇒ 不置")
it("乱序补发不回退 progressElapsedMs（既有守卫回归）")
```

单调守卫实现判据（写入测试注释）：`RANK = { pending:0, running:1, done:2, failed:2 }`；新 status 仅当 `RANK[new] > RANK[prev]` 或（同级且新 status==='done' && prev!=='done'）才赋值——failed 与 done 同级但互不覆盖（先到先得，重试场景由用户动作发起新 generating 重新走 running）。**注意**：done 后 failed 不回退是否符合产品语义——是：done 有正据（url），failed 无正据推翻正据；重试成功会再来一个 done。

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 最小实现**（node_status 分支改为守卫式赋值；v2 字段逐个条件 upsert；`terminalState` 仅在落 running 时写入）

```ts
const RANK: Record<'pending'|'running'|'done'|'failed', number> = { pending: 0, running: 1, done: 2, failed: 2 }
// existing 分支：
const next = RANK[status]
if (RANK[existing.status] < next || (status === 'done' && existing.status !== 'done')) {
  existing.status = status
  if (mediaUrl) existing.url = mediaUrl
}
if (existing.status === 'running' && d.terminalState) existing.terminalState = d.terminalState
else if (existing.status !== 'running') existing.terminalState = undefined
// v2 upsert：kind/durationMs/posterUrl/version/summary 条件赋值（值有效才写）
// late 透传：if ((d as {late?: boolean}).late) existing.lateNotify = true
```

- [ ] **Step 4: 跑测试确认通过** + turnTimeline 既有测试全量回归（fixture 断言与 Task 4 对称）
- [ ] **Step 5: Commit** `feat(web): mapNodeStatusV2 单调守卫 + artifact part v2 扩展（E2 Task 6，守卫为净新增）`

---

### Task 7: web — groupDeliveryCards + deliveryActionsOf 纯函数

**Files:**
- Create: `apps/web/src/components/agent/deliveryCards.ts`（纯函数模块）
- Test: `apps/web/src/components/agent/deliveryCards.test.ts`（含变异：聚合键改动 ⇒ 组数变化被抓）

**Interfaces:**
- Consumes: Task 6 的 artifact part v2 字段。
- Produces:
  - `groupDeliveryCards(parts: TimelinePart[]): TimelinePart[]` —— 渲染期聚合：连续/相邻同 roundKey 的 done·artifact part 归并为 `kind:'delivery_group'` 虚拟 part（`items: ArtifactPart[]`，保序）；无 roundKey / 单成员不归组（独立卡原样）；纯函数（同输入两次调用同输出，不改 parts）。
  - `deliveryActionsOf(part: ArtifactPart): Array<'view'|'download'|'play'|'confirm_fallback'|'retry'>` —— 动作矩阵查表（规格 §6 表逐行）：done·image→[view,download]；done·video/audio→[play,view]；done·text→[view]；running→[]；running·fallback_pending→[confirm_fallback]；failed→[retry]。

- [ ] **Step 1: 写失败测试**（快照表逐行断言动作矩阵六状态；聚合四分支：roundKey 缺失独立卡 / 同 roundKey 归组保序 / 单成员不归组 / 重放一致性）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 最小实现**（两个纯函数，类型从 turnTimeline import）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(web): 交付卡聚合与动作矩阵纯函数（E2 Task 7，D-5 渲染期聚合不改 parts）`

---

### Task 8: web — AgentTurnTimeline.vue 交付卡渲染 + 埋点

**Files:**
- Modify: `apps/web/src/components/agent/AgentTurnTimeline.vue:307-380`（artifact 卡段）、template 组卡分支
- Create: `apps/web/src/components/agent/deliveryMetrics.ts`
- Modify: `apps/web/src/stores/agent.ts`（deliveryMetrics 接线）
- Test: `apps/web/src/components/agent/AgentTurnTimeline.deliveryCard.test.ts`（静态源码契约，沿用本仓 AgentSideRail 测试约定：readFileSync + stripComments + 正则）

**Interfaces:**
- Consumes: Task 6 part 字段、Task 7 两纯函数。
- Produces: `deliveryMetrics.ts` 导出 `observeDeliveryCard(type: 'impression'|'open'|'inline_play'|'retry', meta: { nodeId?: string; kind?: string })`——批量缓冲（50 条或 5s flush）POST `/api/agent/metrics/delivery`（fetch `cache:'no-store'` 不适用 POST；失败静默丢弃不重试，埋点零阻塞）。

- [ ] **Step 1: 写静态契约失败测试**

```ts
// 断言模板包含（stripComments 后正则）：
// - delivery_group 分支：v-for items、主交付大图（items[0]）、计数徽标（items.length）
// - 动作按钮全部经 deliveryActionsOf(part) 输出（模板内禁自造状态词/动作——D-1-2/4）
// - 版本徽标：v-if="part.version" 渲染 vN（D-3：缺失隐藏）
// - 内联起播：@click 用户手势触发，模板无 autoplay 属性（§11.3）
// - running·timeout 文案「仍在生成 · 已 N 分钟」（elapsedLabel 既有函数复用）
// - lateNotify 徽标「本回合交付」
// - 样式仅 --lnk-* 令牌（禁 --neo- 与新增 hex——design-token 守卫同款正则）
// - observeDeliveryCard 三类打点在 click 处理器中（impression 在 onMounted/visible 交集中）
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现渲染**（artifact 卡段增强 + delivery_group v-else-if 分支；组卡 = 主交付大图 + 余项小缩略行 + 计数徽标；动作按钮 `v-for="a in deliveryActionsOf(part)"` 查表渲染；view 动作 = 既有 focus_node 定位逻辑复用（`canvasNodeActions` composable），play = 音频 `<audio controls>` / 视频 `<video controls>`（controls 自带手势起播，无 autoplay），download = `<a download href=url>`，retry = emit 既有重试事件（AgentTurnTimeline 已有 failed 内联重试通路，D2 注释 :15），confirm_fallback = emit 既有 fallback 确认队列通路（composables/fallbackConfirmQueue.ts））；deliveryMetrics.ts 实现 + 三类打点接线（impression 用 IntersectionObserver 单例观察卡根元素，open/play/retry 在对应 click）。
- [ ] **Step 4: 跑测试确认通过** + `vue-tsc -b` 0 error + design-token 四测试零回归
- [ ] **Step 5: Commit** `feat(web): 交付卡渲染（动作矩阵/组卡/版本徽标/内联媒体）+ 埋点（E2 Task 8）`

---

### Task 9: web — AgentSideRail 常驻订阅（§5.5）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（常驻订阅生命周期；消费面白名单）
- Test: `apps/web/src/components/agent/AgentSideRail.residentStream.test.ts`（静态契约 + 逻辑单测）

**Interfaces:**
- Consumes: P1 权威通道 `GET /runs/events?...&lastEventId=N`（T8 canary 六锚实证形态：`id:` 帧 + `event:`/`data:` 行 + heartbeat）；既有 `consumeMainTurnStream`（deps.reader/onEvent/onCursor/signal——**不改它**，常驻订阅用独立轻量读取器）。
- Produces: `startResidentEventStream(threadId: string, lastEventId: number)` 单例（重复调用先行断言旧实例已关，双开即 throw——Review Focus 5）；`stopResidentEventStream()`；消费面白名单仅 `node_status`/`generation_progress`，且 node_status 注入 `late:true` 后走既有 `agent.trackNodeStatus`；其余事件**静默忽略**（E5 再统一）。触发点：会话面板 mounted / visibilitychange 回显 / 线程切换；断开点：unmount / visibilitychange 隐藏。

- [ ] **Step 1: 写失败测试**

```ts
// 静态契约（stripComments 正则）：
it("单例守卫：已存在活动订阅时 start 再次调用须先 stop 旧实例（双开即断言失败）")
it("消费面白名单：仅 node_status/generation_progress 进入 trackNodeStatus/trackGenerationProgress；其余 continue")
it("node_status 注入 late:true（补拍来源标记，Task 6 part.lateNotify 的驱动源）")
it("visibilitychange：document.hidden ⇒ stop；恢复可见 ⇒ start(lastEventId=游标)")
it("断线重连：reader 异常 ⇒ 记录游标（onCursor 的 seq）并延时重挂（≤2 次退避），带 lastEventId 续传")
it("unmount 钩子调用 stopResidentEventStream")
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 最小实现**（模块级 `let resident: { controller: AbortController; lastSeq: number } | null`；fetch SSE 读流循环用 `TextDecoder` 按 `\n\n` 分帧，解析 `id:`/`data:` 行——**不复用 consumeMainTurnStream**：它遇终局帧即 cancel，语义不同；heartbeat 帧（无 data）跳过；node_status 帧 `data.late = true` 后 `agent.trackNodeStatus(payload)`）
- [ ] **Step 4: 跑测试确认通过** + AgentSideRail 既有测试全量回归（P1 的 mainStreamChannel 静态契约必须仍绿）
- [ ] **Step 5: Commit** `feat(web): 会话面板常驻事件订阅（E2 Task 9，消费面白名单 node_status/generation_progress）`

---

### Task 10: DevTimelinePreview 样例 + 全量回归收口

**Files:**
- Modify: `apps/web/src/pages/DevTimelinePreviewPage.vue`（增补 §6 六场景样例事件流）
- Test: 目视核对 + 全量回归

- [ ] **Step 1: 增补样例**（六场景各一组事件序列注入预览页既有样例机制：单图 done、四格乱序 done（同 roundKey）、timeout 子态→补拍翻正、fallback_pending→确认→running、音频 done、文本 done+summary）
- [ ] **Step 2: 全量回归**

```bash
# pi-runtime（node24）
cd services/pi-runtime && ../../node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
# server
cd apps/server && npx tsc --noEmit && ./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
# web
cd apps/web && npx vue-tsc -b && ./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
```

Expected: 三端全绿 0 error。
- [ ] **Step 3: Commit** `test(dev-preview): E2 六场景样例事件流（E2 Task 10）`
- [ ] **Step 4: 推送 + PR**（worktree 内分支 `feat/e2-delivery-card`；git https 502 走 REST Git Data API，blob sha 逐项核对；PR body 引用规格 §10 验收判据 + 声明「合并后手动 dispatch runtime-deploy」）→ CI → squash merge → 部署 → 生产取证（flag off 缺省，行为不变）。

---

## Self-Review 记录

- 规格覆盖：§5.1-5.5（Task 1-4/9）、§6 动作矩阵（Task 7/8）、§7 数据变更（Task 1-6，GenerationTerminalNotice 零改动为裁决 1 修正后口径）、§8 三纯函数（Task 6/7）、§9 清单逐项映射、§10 契约镜像（Task 4/6 fixture 对称）+ 变异（Task 6 单调守卫/Task 7 聚合键/Task 9 双开）、验收④四指标（Task 5/8）。§6 场景 6 的「全屏阅读视图」明确不在 v1（规格自述）。
- 类型一致性：`NodeStatusData` 字段名（kind/mimeType/durationMs/posterUrl/version/roundKey/terminalState/summary）在 Task 1/3/4/6/7 五处一致；`lateNotify` 仅 web part 字段，wire 字段为内部 `late`（Task 6/9 对齐）；`deliveryActionsOf` 返回值字面量与 Task 8 模板动作键一致。
- Review Focus 五项全部有归属测试（Task 6/2/9）。
