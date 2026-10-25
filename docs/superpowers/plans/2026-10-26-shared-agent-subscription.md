# 会话级订阅跨标签页共享 · 实施计划

> 规格：`docs/superpowers/specs/2026-10-26-shared-agent-subscription-design.md`（本计划的一切判据以该规格为准）
> 止血（已上线，PR #594）：`useEnterCreation` 在 list 失败时用「记忆的项目」兜底 —— **本计划不重复止血，也不改进入创作语义**。

---

## Goal

把「每标签页一条常驻 SSE」改成「**同会话全局一条**」，根治 Chrome 同源 HTTP/1.1 **6 连接上限**被订阅占满导致的普通请求排队饿死（2026-10-26 生产事故：品牌页点锚卡 15s、「项目加载失败」、重试无效）。

## Architecture

- 新模块 `apps/web/src/components/agent/shared-subscription.ts`：**同源同会话**用 `BroadcastChannel` 选举 leader，只有 leader 真正 `fetch` 订阅 URL，其余标签页经频道收帧。
- `follow-up-tail.ts`：**只把「开连接」抽成可注入 transport**，游标/退避/idle/clean-end 重连/404 终态等判定**一行不改**。
- `AgentSideRail.vue`：装配改经 `shared-subscription`；`#587` 的「后台即释放」由 leader 统一执行。

## Tech Stack

Vue 3 + TypeScript（`apps/web`）、vitest、Pinia、浏览器原生 `BroadcastChannel`（**零新依赖**）。

## Spec

`docs/superpowers/specs/2026-10-26-shared-agent-subscription-design.md`

---

## Global Constraints

- **G-1 零新依赖**：只用浏览器原生 `BroadcastChannel`；不得引入 polyfill 库或状态库（规格 §14 A）。
- **G-2 判定逻辑零改动**：`follow-up-tail.ts` 现有的游标、退避预算、idle 闸门、clean-end 重连、404/401/403 终态判定**只允许搬家，不允许改语义**（规格 §3）。
- **G-3 降级优先于失败**：任何异常 ⇒ 退到「各自订阅」（= 改动前行为），不得抛错、不得静默失联（规格 R-D）。
- **G-4 游标只增不减**：任何路径都不得让 `seq` 回退（回退 ⇒ 服务端全量重放）（规格 R-C）。
- **G-5 follower 不得自建连接**：follower 路径**禁止**出现订阅 URL 的 `fetch`（守卫测试锁定，规格 §10）。
- **G-6 依赖注入以便单测**：时钟、频道工厂一律注入，禁止在模块内直接取 `Date.now()` / `new BroadcastChannel()`（沿用 `follow-up-tail.ts` 抽出工厂的既有教训）。
- **G-7 既有契约不动**：`AgentSideRail.observerWiring.test.ts` 的 6 条断言必须**原样通过**（#574 的语义不得回退）。
- **G-8 分支与 PR**：按 `docs/agent/delivery.md`；worktree 内开发、squash 合并；**不碰另一窗口的文件**（如 `2026-10-25-enter-creation-unified-design.md` 当前有 2 个配图错误，属他人改动）。
- **G-9 上线后必须复测**：两个标签页打开同一会话 ⇒ Chrome Network 面板 `runs/events` **只有 1 条**；另一端跑一轮 ⇒ 两个标签页都出文本。

## Review Focus（最可能咬到真实用户的 5 条，每条标归属任务）

1. **leader 被杀后用户是否失联**（Task 4）：3s 无 pong ⇒ 接管并带游标重连；期间**不得静默**。
2. **后台标签页释放语义是否仍成立**（Task 5）：`#587` 的「隐藏即释放」在共享后由 leader 统一执行，follower 不各自持有 ⇒ 行为不得回退。
3. **帧丢失能否自愈**（Task 3）：BC 非可靠 ⇒ 帧带单调 seq，缺口须请求重放，不得静默漏帧。
4. **老客户端不炸**（Task 4）：无 `BroadcastChannel` ⇒ 各自订阅，**不报错、不卡**。
5. **单标签页是否变慢**（Task 6）：共享引入的握手不得让单标签页的订阅连接数 > 1。

---

## 文件结构映射

| 文件 | 动作 | Task |
|---|---|---|
| `apps/web/src/components/agent/shared-subscription.ts` | 新增 | T1–T4 |
| `apps/web/src/components/agent/shared-subscription.test.ts` | 新增 | T1–T4 |
| `apps/web/src/components/agent/follow-up-tail.ts` | 抽 transport | T5 |
| `apps/web/src/components/agent/follow-up-tail.test.ts` | 适配 | T5 |
| `apps/web/src/components/agent/AgentSideRail.vue` | 装配 | T6 |
| `apps/web/src/components/agent/AgentSideRail.observerWiring.test.ts` | 补守卫 | T6 |
| `apps/web/src/composables/useAgentSubscriptionMetrics.ts` | 新增（可观测） | T6 |
| `docs/superpowers/specs/2026-10-26-shared-agent-subscription-design.md` | 已写（本分支） | — |

---

## Task 1 · 四个纯函数 + 单测

**目标**：把选举与游标判定做成可单测的纯函数（规格 §8）。

1. **写失败测试**：`shared-subscription.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { electLeader, shouldTakeOver, mergeCursor, planFrames } from './shared-subscription'

describe('shared-subscription 纯函数', () => {
  it('electLeader：字典序最小者当选；空数组返回 null', () => {
    expect(electLeader(['b', 'a', 'c'])).toBe('a')
    expect(electLeader([])).toBe(null)
  })
  it('shouldTakeOver：超过阈值才接管；恰好等于阈值不接管', () => {
    expect(shouldTakeOver({ lastPongAt: 1000, now: 4000, timeoutMs: 3000 })).toBe(false)
    expect(shouldTakeOver({ lastPongAt: 1000, now: 4001, timeoutMs: 3000 })).toBe(true)
  })
  it('mergeCursor：取大；null 视为未知', () => {
    expect(mergeCursor(5, 9)).toBe(9)
    expect(mergeCursor(null, 3)).toBe(3)
    expect(mergeCursor(7, null)).toBe(7)
    expect(mergeCursor(null, null)).toBe(null)
  })
  it('planFrames：丢弃已消费帧，保持单调', () => {
    const frames = [{ seq: 1 }, { seq: 2 }, { seq: 3 }]
    expect(planFrames(frames, 2)).toEqual([{ seq: 3 }])
  })
})
```

2. **跑失败**：`cd apps/web && ./node_modules/.bin/vitest run src/components/agent/shared-subscription.test.ts` ⇒ 模块不存在（红）。
3. **最小实现**：导出上述四个纯函数（`now`/`timeoutMs` 由调用方传入）。
4. **跑通过**：同上 ⇒ 绿。
5. **commit**：`feat(agent): 订阅共享的四个纯函数（选举/接管判定/游标合并/帧过滤）`。

## Task 2 · 选举与握手

**目标**：follower 能加入频道、知道自己不是 leader（规格 §5.2）。

1. 写失败测试：用**注入的 fake channel**（`createChannel` 依赖）模拟两个标签页；断言「同会话两页只有一页自认 leader」。
2. 跑失败。
3. 最小实现：`createSharedSubscription({ channelName, createChannel, now, ... })`；消息 `hello/ping/pong/bye`；选举按 `electLeader`。
4. 跑通过。
5. commit。

## Task 3 · 帧转发与游标单调

**目标**：leader 收到的帧被转发给 follower，seq 不回退（规格 R-C、§5.2）。

1. 写失败测试：fake channel 投递 `frames`；断言 follower 收到同序帧；断言 `seq` 回退的帧被 `planFrames` 丢弃。
2. 跑失败。
3. 最小实现：leader 转发 `{frames, seq}`；follower 走 `planFrames` 后进 `onFrame`。
4. 跑通过。
5. commit。

## Task 4 · leader 死亡接管 + 降级

**目标**：R-F 与 R-D 落地。

1. 写失败测试：① leader 停止 `pong` ⇒ 超过阈值后 follower 接管并**调用** `openStream`；② `createChannel` 返回 `null`（老客户端）⇒ **不调用** `openStream` 之外的任何东西、走各自订阅路径且不抛错；③ 选举期间抛错 ⇒ 降级且不抛到调用方。
2. 跑失败。
3. 最小实现：`ping/pong` 周期探测 + `shouldTakeOver` + `openStream` 接管（带游标）；降级分支直接调用注入的 `openStream`（各自订阅）。
4. 跑通过。
5. commit。

## Task 5 · `follow-up-tail.ts` 抽 transport（判定零改动）

**目标**：G-2。

1. 写失败测试：**不新增用例**，先跑 `follow-up-tail.test.ts` 现状（绿）作为基线；再补一条「transport 由外部注入时，帧仍按原契约回调」。
2. 跑失败（新用例红）。
3. 最小实现：把 `deps.fetchImpl` 收敛为 `deps.openStream(onFrame, onClose)`；**游标/退避/idle/终态判定一行不动**；头注释追加「连接归属已移交 `shared-subscription`」的修订说明（规格 §3 要求显式修订）。
4. 跑通过：`follow-up-tail.test.ts` **既有断言原样通过**（G-7）。
5. commit。

## Task 6 · `AgentSideRail` 装配 + 守卫 + 可观测

**目标**：G-5、R-E。

1. 写失败测试：`AgentSideRail.observerWiring.test.ts` 补一条静态守卫 —— **follower 路径不得出现订阅 URL 的直连 `fetch`**（与 G-5 同形：先写会红的守卫）。
2. 跑失败。
3. 最小实现：装配改经 `shared-subscription`；新增 `useAgentSubscriptionMetrics.ts`（连接数/leader 切换次数）。
4. 跑通过：`observerWiring.test.ts` 6 条原样绿 + 新守卫绿。
5. commit。

## Task 7 · e2e 验收 + PR

1. 人工 + 脚本验收（规格 §10）：
   - 两个标签页打开同一会话 ⇒ Chrome Network 面板 `runs/events` **只有 1 条**；
   - 另一端跑一轮 ⇒ 两个标签页都出文本；
   - 关闭 leader ⇒ follower ≤3s 接管。
2. 跑失败/通过：以「Panel 截图 + 断言脚本」为准。
3. 无代码改动（仅验收记录写进规格 §13）。
4. 开 PR（base=master，body 贴规格与验收证据）。
5. commit（验收记录追加到规格文件）。

---

## 验收标准（Definition of Done）

- [ ] `shared-subscription.test.ts` 全绿；四个纯函数分支覆盖
- [ ] `follow-up-tail.test.ts` **既有断言原样通过**（无一条被改写）
- [ ] `AgentSideRail.observerWiring.test.ts` 6 条原样通过 + 新守卫通过
- [ ] `vue-tsc -b` 零新增错误
- [ ] 两标签页场景：Network 面板 `runs/events` 仅 1 条
- [ ] leader 关闭：follower ≤3s 接管且不静默
- [ ] 无 BroadcastChannel 客户端：行为等同改动前
- [ ] 规格 §13 回填 `pnpm verify-spec-figures` 结果（0 错 0 警）
