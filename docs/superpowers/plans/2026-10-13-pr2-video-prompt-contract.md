# PR2 运动提示词质量（工具描述契约 + after_tool 纠偏）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 图生视频场景下，模型写节点 prompt 前 100% 在场拿到「只写运动」的契约（工具描述），prompt 落笔后、propose 前还有一次确定性纠偏机会（after_tool 工具结果提醒），根治「静帧外观复述」型低质提示词。

**Architecture:** pi-runtime 内两处加法。① `canvas-write.ts` 两个工具 description 各追加一句运动契约；② 新纯函数模块 `video-prompt-contract.ts` 产出纠偏文本，接入 `index.ts:90` 既有合并 after_tool listener（`upsert_media_node` 且 `args.type === 'video'` 时 patch 工具结果）。回归判据 = 纯函数单测 + 既有 golden/eval 不回归 + 遥测观测。

**Tech Stack:** TypeScript、node:test（pi-runtime 用 node 原生 test runner，见同目录 *.test.ts）

**Spec:** `docs/superpowers/specs/2026-10-13-generation-failure-recovery-and-motion-prompt-design.md` §5

## Global Constraints

- **零 prompt 预算消耗**：只动工具 description 与 hook，不碰 `prompt-registry/`（F9 预算锁死）。
- 纠偏文本 ≤300 字，内容 = 六段式索引 + 铁律，不重复 skill 全文（skill 全文走 forceSkills 通道，§5.3 可选后置，不在本计划）。
- 接入点必须是 `index.ts:90` 的**既有合并 listener 内部**，不得新注册第二个 after_tool listener（注册序纪律见 `result-signal-wiring.test.ts`）。
- 纠偏只做「提醒」，**不改写 args、不拦截工具**（vendor before_tool 支持改 args，但替写 prompt 是黑盒决策，明确拒绝）。
- 纯文生视频（无参考图）**不触发**纠偏（frame lock 段不适用）。
- **golden case 判据的显式偏离（spec §5.4 收敛决策）**：现有 `GoldenCase`  schema 只能断言助手文本（`expectTextIncludes`），**无法断言工具入参里的 prompt 内容**——「prompt 含运动词汇」这类判据需要扩展 runner（`expectToolArgsIncludes`），属 runner 增强且与「不自造 case」纪律相交，**本期不做**。回归判据收敛为：Task 1/3 纯函数与描述守卫单测 + `result-signal-golden` 不破坏 + 遥测（视频一次成功率）观测。runner 增强作为后续项记录在 spec §5.4，不在本计划范围。

## Review Focus

- `upsert_media_node` 更新一个**已存在**的 image 节点改 type 为 video 的边缘场景：args.type === 'video' 即触发，与「新建/更新」无关。
- 工具结果被 `capToolResult` 截断时，纠偏段必须在**截断后仍然可见**——实现上把纠偏文本拼在 patch content 的**末尾之前**先取合并，若合并 listener 先截断再返回，本任务的 patch 要在其后追加（同一 listener 内顺序拼装即可）。
- `isError` 为 true 的 upsert（如参数非法失败）不纠偏——没有节点落成，纠偏无对象。
- 纠偏文本不得诱导模型重写用户已确认的 prompt：措辞是「检查是否只描述运动」，不是「必须重写」。
- after_tool 事件形态守卫：args 是 `Record<string, JsonValue>`，读 `type` 必须走 `readStringField`（`hook-contract.ts`），不得 as 强转。

---

### Task 1: 纠偏纯函数 + 单测

**Files:**
- Create: `services/pi-runtime/src/tools/video-prompt-contract.ts`
- Test: `services/pi-runtime/src/tools/video-prompt-contract.test.ts`

**Interfaces:**
- Consumes: `hook-contract.ts` 的 `readStringField`
- Produces:
  - `VIDEO_MOTION_CONTRACT_REMINDER: string`（≤300 字的纠偏文本常量）
  - `videoContractReminder(args: Record<string, unknown>): string | null`（type=video 返回纠偏文本，否则 null）

- [ ] **Step 1: 写失败测试**

```ts
// services/pi-runtime/src/tools/video-prompt-contract.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { videoContractReminder, VIDEO_MOTION_CONTRACT_REMINDER } from './video-prompt-contract.ts'

test('type=video → 返回纠偏文本', () => {
  const out = videoContractReminder({ type: 'video', prompt: '一只狼' })
  assert.ok(out && out.length > 0)
  assert.equal(out, VIDEO_MOTION_CONTRACT_REMINDER)
})

test('type=image → null（不误触发）', () => {
  assert.equal(videoContractReminder({ type: 'image' }), null)
})

test('type 缺失/非字符串 → null（形态不符不猜）', () => {
  assert.equal(videoContractReminder({}), null)
  assert.equal(videoContractReminder({ type: 42 }), null)
})

test('纠偏文本 ≤300 字且含六段式索引与铁律', () => {
  assert.ok(VIDEO_MOTION_CONTRACT_REMINDER.length <= 300)
  assert.match(VIDEO_MOTION_CONTRACT_REMINDER, /运镜/)
  assert.match(VIDEO_MOTION_CONTRACT_REMINDER, /只描述运动|只写运动/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd services/pi-runtime && node --test src/tools/video-prompt-contract.test.ts 2>&1 | tail -5`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写最小实现**

```ts
// services/pi-runtime/src/tools/video-prompt-contract.ts
import { readStringField } from '../../hook-contract.ts'

/**
 * 图生视频 prompt 契约纠偏（spec §5.2 主杠杆 B）。
 *
 * 铁律（skills/drama-motion-video）：「图管外观，prompt 管时间」——参考图已定义
 * 主体/构图/光线/风格，prompt 只写「什么在变」。重述静帧外观会诱导模型重新
 * 解释这一帧，是低质运动提示词的头号根因。
 */
export const VIDEO_MOTION_CONTRACT_REMINDER =
  '【图生视频 prompt 契约】该 video 节点挂有参考图：参考图已定义外观，prompt 必须只描述运动——' +
  '① 一个相机运动（带方向与速度）② 一个主体主导动作 ③ 仅必要的环境次运动（发丝/反光/烟尘）' +
  '④ 禁止项（变形/新增物体/崩坏）。检查当前 prompt 是否复述了静帧外观（如「毛发细节」「高精度渲染」），' +
  '若是请在 propose 前用 upsert_media_node 更新该节点改写为纯运动描述。'

/** upsert_media_node 落成 video 节点时返回纠偏文本；其余形态一律 null（不猜）。 */
export function videoContractReminder(args: Record<string, unknown>): string | null {
  const type = readStringField(args, 'type', 'after_tool.args')
  if (!type.ok || type.value !== 'video') return null
  return VIDEO_MOTION_CONTRACT_REMINDER
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd services/pi-runtime && node --test src/tools/video-prompt-contract.test.ts 2>&1 | tail -5`
Expected: PASS（4/4）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/tools/video-prompt-contract.ts services/pi-runtime/src/tools/video-prompt-contract.test.ts
git commit -m "feat(pi-runtime): 图生视频 prompt 契约纠偏纯函数（PR2 Task1）"
```

---

### Task 2: 接入既有合并 after_tool listener

**Files:**
- Modify: `services/pi-runtime/src/index.ts`（:90-117 既有合并 listener 内追加分支）
- Test: `services/pi-runtime/src/index.video-contract.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `videoContractReminder`
- Produces: 无新导出（行为接线）

- [ ] **Step 1: 写失败测试（接线断言）**

```ts
// services/pi-runtime/src/index.video-contract.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VIDEO_MOTION_CONTRACT_REMINDER } from './tools/video-prompt-contract.ts'

// 以纯函数方式复刻 index.ts 合并 listener 的拼装逻辑（抽成可测的小步），
// 断言：video 成功 → content 末尾附纠偏段；video 失败(isError) → 不附；
// image → 不附；纠偏段拼在 capToolResult 截断结果之后（不被吞）。
test('接线拼装：video + !isError → 纠偏段在 content 末尾', () => {
  const content = [{ type: 'text' as const, text: '{"ok":true}' }]
  const patched = appendVideoContract(content, { toolName: 'upsert_media_node', isError: false, args: { type: 'video' } })
  assert.match(patched[patched.length - 1].text, /图生视频 prompt 契约/)
})

test('接线拼装：isError → 不附', () => {
  const content = [{ type: 'text' as const, text: '{"ok":false}' }]
  const patched = appendVideoContract(content, { toolName: 'upsert_media_node', isError: true, args: { type: 'video' } })
  assert.ok(!patched.some((p) => p.text.includes('图生视频 prompt 契约')))
})

test('接线拼装：image → 不附', () => {
  const content = [{ type: 'text' as const, text: '{"ok":true}' }]
  const patched = appendVideoContract(content, { toolName: 'upsert_media_node', isError: false, args: { type: 'image' } })
  assert.ok(!patched.some((p) => p.text.includes('图生视频 prompt 契约')))
})
```

> `appendVideoContract` 是本任务从 index.ts 合并 listener 中抽出的纯拼装函数（下一步实现），测试它 = 测接线而不必起 harness。

- [ ] **Step 2: 运行确认失败**

Run: `cd services/pi-runtime && node --test src/index.video-contract.test.ts 2>&1 | tail -5`
Expected: FAIL（`appendVideoContract` 不存在）

- [ ] **Step 3: 实现拼装函数 + 接入 listener**

在 `index.ts` 顶部 import 区加：

```ts
import { videoContractReminder } from './tools/video-prompt-contract.ts'
```

在合并 listener（:90 `harness.hooks.on("after_tool", async (event) => {`）**内部**，`capToolResult` 分支之后、listener 返回之前，加：

```ts
// 图生视频 prompt 契约纠偏（spec §5.2）：video 节点落成即在工具结果末尾附提醒，
// 给模型「propose 前改写 prompt」的确定性修正窗口。只加文本，不改写/不拦截。
if (event.toolName === 'upsert_media_node' && !event.isError) {
  const reminder = videoContractReminder(event.args as Record<string, unknown>)
  if (reminder) {
    const patched = capped.trimmed ? capped.content : event.content
    return { content: [...patched, { type: 'text', text: reminder }] }
  }
}
```

> ⚠️ 位置纪律：必须放在 `if (!capped.trimmed) return undefined` 之后——即先让既有截断逻辑生效，纠偏段拼在**截断后的 content** 末尾，保证不被吞。`event.args` 经 `videoContractReminder` 内的 `readStringField` 守卫，此处 as 仅为过 TS 类型（形态判读在纯函数内）。

同时把拼装逻辑抽为可测函数（放在 `index.ts` export 区或同文件顶部）：

```ts
export function appendVideoContract(
  content: readonly { type: string; text: string }[],
  event: { toolName: string; isError: boolean; args: Record<string, unknown> },
): { type: string; text: string }[] {
  if (event.toolName !== 'upsert_media_node' || event.isError) return [...content]
  const reminder = videoContractReminder(event.args)
  if (!reminder) return [...content]
  return [...content, { type: 'text', text: reminder }]
}
```

listener 内改为调用 `appendVideoContract(capped.trimmed ? capped.content : event.content, event)` 并据此 return（保持同一 listener 单返回点风格，与既有 `return { content: capped.content }` 分支等价合并）。

- [ ] **Step 4: 运行确认通过**

Run: `cd services/pi-runtime && node --test src/index.video-contract.test.ts src/tools/video-prompt-contract.test.ts 2>&1 | tail -5`
Expected: PASS（7/7）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/index.ts services/pi-runtime/src/index.video-contract.test.ts
git commit -m "feat(pi-runtime): after_tool 接入图生视频 prompt 契约纠偏（PR2 Task2）"
```

---

### Task 3: 工具描述契约（upsert_media_node + set_node_generation_params）

**Files:**
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`（:98 upsert_media_node description、:229 set_node_generation_params description）

**Interfaces:**
- Consumes: 无
- Produces: 无（description 文本变更）

- [ ] **Step 1: 写描述守卫测试（防回归被改掉）**

```ts
// services/pi-runtime/src/tools/canvas-write.video-contract-desc.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./canvas-write.ts', import.meta.url), 'utf8')

test('upsert_media_node description 含图生视频运动契约', () => {
  assert.match(src, /reference image\(s\)[\s\S]*?ONLY motion/)
})

test('set_node_generation_params description 含图生视频运动契约', () => {
  const paramsBlock = src.slice(src.indexOf('name: "set_node_generation_params"'))
  assert.match(paramsBlock.slice(0, 2000), /ONLY motion|只描述运动/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd services/pi-runtime && node --test src/tools/canvas-write.video-contract-desc.test.ts 2>&1 | tail -5`
Expected: FAIL

- [ ] **Step 3: 改两处 description**

`upsert_media_node` description（:98）末尾追加：

```
For video nodes with reference image(s), the prompt must describe ONLY motion (one camera move + one subject action + ambient secondary motion + prohibitions). Do NOT restate the frame's static appearance — the reference image already defines it.
```

`set_node_generation_params` description（:229）末尾追加同一句（参数预填是 propose 前最后一次工具接触，双点提醒）。

- [ ] **Step 4: 运行确认通过 + 归属回归**

Run:
```bash
cd services/pi-runtime && node --test src/tools/canvas-write.video-contract-desc.test.ts 2>&1 | tail -3
node --test src/tools/tiering.test.ts 2>&1 | tail -3
```
Expected: 双 PASS（tiering 回归证明仅描述变更、归属未动）

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/tools/canvas-write.ts services/pi-runtime/src/tools/canvas-write.video-contract-desc.test.ts
git commit -m "feat(pi-runtime): upsert/set_params 工具描述补图生视频运动契约（PR2 Task3）"
```

---

### Task 4: PR 前回归（pi-runtime 全量）

**Files:**
- Modify: 无

- [ ] **Step 1: 单文件全跑**

Run: `cd services/pi-runtime && node --test src/tools/video-prompt-contract.test.ts src/index.video-contract.test.ts src/tools/canvas-write.video-contract-desc.test.ts src/tools/tiering.test.ts src/result-signal-golden.test.ts 2>&1 | tail -8`
Expected: 全 PASS（`result-signal-golden` 防接线破坏信号行）

- [ ] **Step 2: 类型检查**

Run: `cd services/pi-runtime && ../../node_modules/.bin/tsc --noEmit 2>&1 | head`
Expected: 无新增错误

- [ ] **Step 3: prompt 预算未动验证**

Run: `cd /Users/4seven/workspace/pi-lnk && pnpm prompt:lint 2>&1 | tail -5`
Expected: 预算值不变（3197/3200，warning 不变）——本计划零 registry 改动

- [ ] **Step 4: 推送 + 开 PR**

```bash
git push -u origin <branch>
gh pr create --base master --title "feat(pi-runtime): 图生视频运动提示词契约（工具描述 + after_tool 纠偏）（PR2/③）" --body "实现 spec §5.1/§5.2。零 prompt 预算消耗。回归：tiering 归属不变 + result-signal-golden 不破坏。"
```

- [ ] **Step 5: 盯 CI 全绿后 squash 合并**

```bash
gh pr checks <n>
gh pr merge <n> --squash
```
