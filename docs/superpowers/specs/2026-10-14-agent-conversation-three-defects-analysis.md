# Agent 对话链路三缺陷根因分析与治理方案

> 2026-10-14 · 生产实证（InkIt agent 侧栏）· 三个用户反馈：思考块收不起、阻塞期历史滑不动、思考无流式
>
> **本文是诊断 + 架构治理方案，不是实施记录。** 所有行号基于 `origin/master@7f460ea8`，
> 每条断言都经代码核实，未凭印象。

---

## 〇、一句话结论

三个反馈**不是三个独立 bug，而是同一条链路上的三类不同深度的缺陷**：

| # | 症状 | 真实层级 | 根因一句话 |
|---|---|---|---|
| 1 | 思考点开收不回 | **状态管理**（受控 vs 非受控混淆） | `<details :open>` 被当受控 prop 用，而 `part.id` 含 `Date.now()` ⇒ 每次 patch 都可能重建节点，折叠状态被丢弃 |
| 2 | 阻塞期历史滑不动 | **布局约束**（限高责任错配） | dock 限高由 `hasDockPresentation` 门控，而它**只认取消态、不认阻塞态** ⇒ 阻塞时 dock 无上限，`shrink-0` 撑爆 `flex-1` 滚动区 |
| 3 | 思考无流式 | **能力开关**（分层职责） | 全链路代码**已打通**，但 Web 默认 `planningThinking=false` ⇒ Nest 恒返回 `'off'` ⇒ 模型侧根本不产 reasoning |

**治理主张**：1、2 是**结构性缺陷**（会随迭代复发，必须改架构而非改症状）；3 是**配置与默认值决策**，代码已就位，缺的是产品决策与开关可见性。

---

## 一、问题 1：思考块「点开之后无法收拢」

### 1.1 现象与机理

`AgentTurnTimeline.vue:126-143` 的思考块：

```vue
<details
  v-if="part.kind === 'thinking'"
  :open="part.status === 'running'"   <!-- ← master 上是 :open="!dense" -->
>
  <summary class="flex cursor-pointer items-center gap-1.5">
    <span>🧠</span><span class="font-medium">{{ ... }}</span>
  </summary>
  <p ...>{{ collapseBlankRuns(part.text) }}</p>
</details>
```

关键事实（均已核实）：

1. **`<details>` 是原生组件，交互状态在 DOM 上。** 用户的点击直接改 DOM 的 `open` 属性，
   **不经过 Vue**。Vue 只有在下次 patch 时才会重新评估 `:open` 的绑定值。
2. **`:open` 是绑定值，不是「用户意图」。** 组件里**没有任何** `expandedCollapsed` 之类的
   用户意图 state（对比 `AgentExecutionTrace.vue:9-75` —— 它有 `expanded` ref + `update:collapsed` 事件，
   是**真正受控**的实现）。
3. **`part.id` 不稳定**：`turnTimeline.ts:154-158`

   ```ts
   let partCounter = 0
   function nextPartId(prefix: string): string {
     partCounter += 1
     return `${prefix}-${partCounter}-${Date.now()}`   // ← 时间戳进 key
   }
   ```

   `Date.now()` 让 `:key="part.id"`（`AgentTurnTimeline.vue:123`）在**重建 timeline 时必然变化**。

### 1.2 失效路径（为什么「收不回」）

| 路径 | 触发条件 | 结果 |
|---|---|---|
| **A. remount 丢状态** | `replayTimelineEvents` 重跑 / `liveTimeline` 重建 ⇒ `part.id` 变化 ⇒ `<details>` 卸载重挂 | 折叠状态重置为绑定值 ⇒ 用户「刚点开就被收起」或「收起后弹回」 |
| **B. re-patch 覆盖** | `part.status` 从 `running` 变 `done` ⇒ `:open` 从 `true` 翻 `false` ⇒ Vue 主动改写 DOM | 这条本身是**期望行为**（结束自动收起），但因无用户意图 state，**用户手动展开后一旦状态再变仍被强制覆盖** |
| **C. 双向都错** | 阻塞等待期（`showTaskCard` 为真 ⇒ `liveTimeline` 持续激活）+ thinking 段反复 running/done | A、B 交替 ⇒ 表现为「点开收不回、收起又弹回」 |

**根因定性**：把「**展示默认值**（running 展开 / done 收起）」误当成了「**受控状态**」。
原生 `<details>` 的正确用法是**只设初始值，之后完全交给用户**；
一旦用绑定属性持续接管，就会与用户的点击互相打架。

### 1.3 与历史修复的关系（重要）

`AgentExecutionTrace.vue` 曾在 **2026-10-07** 修过**同一个病**（注释明写：原先 reducer 每次写
`trace.collapsed` 经 watch 把展开态拉回 ⇒ 刚展开就被收起），做法是**改成真正受控**：
本地 `expanded` 乐观镜像 + `emit('update:collapsed')` + 父级 `traceCollapsed[id]` 持真相。

**新组件 `AgentTurnTimeline` 没有继承这个修复**。这是典型的
「**修了一个组件，同类新组件重犯**」—— 缺少能跨组件复用的**折叠契约**，
导致每次新增可折叠渲染件都要重新踩坑。

### 1.4 方案

**根治：提取共享折叠契约，禁止裸 `<details :open>`。**

新增 `apps/web/src/components/agent/useDisclosure.ts`：

```ts
/**
 * 原生 <details> 的唯一正确封装：
 * - 语义分离：defaultOpen = 展示默认值（首帧生效）；manual = 用户显式意图（优先级最高）
 * - 任何时刻手动点击立即置 manual，不再被默认值改写
 * - part 重挂载时用「稳定 id」而非 Date.now() 兜底
 */
export function useDisclosure(getDefault: () => boolean) {
  const manual = ref<boolean | null>(null)      // null = 用户没表达过意图
  const isOpen = computed(() => manual.value ?? getDefault())
  function toggle() { manual.value = !isOpen.value }
  return { isOpen, toggle, reset: () => (manual.value = null) }
}
```

配套两条硬约束：

1. **`<details>` 不绑 `:open`**，改为 `:open="isOpen"` 仅在 `v-if` 首帧生效，
   或直接改用受控 `v-show` + 按钮（语义更清晰，也规避 `<summary>` 的键盘/AT 差异）。
2. **`nextPartId` 去掉 `Date.now()`**：改用 `${prefix}-${counter}` + 组件级 counter，
   或对 replay 路径改用 **由事件 `seq` 派生** 的确定性 id（`thinking:${seq}`）。
   —— 稳定 key 是折叠状态、动画、滚动锚点、增量 DOM patch 的**共同前提**，不该由时间戳决定。

**回归守卫**（本次缺失的正是这一层）：
- 组件级：`AgentTurnTimeline.disclosure.test.ts` —— mount → 展开 → 手动收起 →
  改 `status` → **断言仍保持收起**（当前必挂，能锁死 A/B 两条路径）。
- 布局级：见问题 2 的共享限高守卫。

---

## 二、问题 2：阻塞等待期历史对话无法上下滑动

### 2.1 这是**复发**，复发机制已找到

2026-10-09 修过一次（`AgentExecutionTrace.scrollLock.test.ts` 文件头注释记录了根因与修复）。
当时根因：钉底活体 trace 展开后，步骤 `<ul>` 无 `max-height` ⇒ 长 thinking detail 撑高
`shrink-0` 的 dock ⇒ `chat-wrap`（`flex-1 min-h-0`）被挤到 0 高。

**修复只打在 `AgentExecutionTrace(dense)` 一处**（`AgentExecutionTrace.vue:151-160`）：

```vue
:style="dense ? 'max-height: min(46vh, 420px); overflow-y: auto; overscroll-behavior: contain;' : undefined"
```

而 `AgentTurnTimeline(dense)`（**当前实际生效的活体路径**）根容器**无任何上限**
（`AgentTurnTimeline.vue:113-118`）：

```ts
const rootClass = computed(() =>
  props.dense
    ? 'agent-turn-timeline agent-turn-timeline--dense flex flex-col gap-0.5 text-[10px] leading-snug'  // ← 无上限
    : ...
)
```

### 2.2 真正的直接原因（比上条更致命）

限高**曾经存在过**，在 dock 容器上（`AgentSideRail.vue:3846-3849`）：

```css
.agent-input-area--scrollable {
  max-height: min(42vh, 400px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
```

但它的启用条件是（`AgentSideRail.vue:910-923`）：

```ts
const showCancelledCallout = computed(
  () => isRunCancelledState(threadRunState.value) || runCancelled.value,
)
/**
 * 底部 dock 含门控/定稿卡片时需限高以免挤占聊天滚动区。
 * 2026-10-06：门控/定稿卡片全部下线，只剩「已停止」提示仍钉在这里。   ← 注释暴露了退化过程
 */
const hasDockPresentation = computed(() => showCancelledCallout.value)
```

⛔ **注释就是病历**：2026-10-06 为了下线门控卡片，把限高条件从「dock 里有任何东西」
**收窄成「dock 里只有取消提示」**。于是阻塞态（`proposeWait` 等待确认、ask_user 卡片、
活跃 live timeline）**全部退回无上限** —— 限高在需求变化时被误当作死代码裁掉，
而不是被正确抽象成「dock 有内容就必须限高」。

于是链路变成：
`proposeWait / live timeline 变高` → `agent-input-area`（`shrink-0`，:3139）无上限
→ `chat-wrap`（`flex-1 min-h-0`，:2803-2808）被压到 0 高
→ **历史列表既看不见也滑不动**（`min-h-0` 保住的是 flex 容器，滚动区高度归零后无可滚内容）。

### 2.3 方案

**根治：限高责任上移到「dock 容器」，不再由每个子组件各自为政。**

1. **判定反转** —— 限高条件从「内容枚举」改为「有内容即限高」：

   ```ts
   // 有任一 dock 展示态即限高：live timeline / propose 等待 / ask 卡 / 取消提示
   const hasDockPresentation = computed(
     () => showCancelledCallout.value || Boolean(liveTimeline.value)
        || Boolean(proposeWait.value) || Boolean(askCard.value),
   )
   ```
   —— 语义从「某几个已知卡片」变成**结构不变量**，未来新增任何 dock 内容自动受保护。

2. **组件级上限降级为二级防线** —— 给 `AgentTurnTimeline--dense` 根容器补上与
   `AgentExecutionTrace(dense)` 等价的 `max-height` + `overscroll-behavior: contain`，
   避免单组件内容多时先把 dock 撑到 42vh 才开始滚（滚动嵌套两层，体验仍差）。

3. **共享常量** —— `min(42vh,400px)` / `min(46vh,420px)` 两处魔数统一为
   `AGENT_DOCK_MAX_H`（放 design-tokens 或组件常量），消除「两条路径各自调参」。

4. **布局守卫（真正防复发的那一层）**：
   新增 `AgentSideRail.dockLayout.test.ts`，断言**结构不变量**而非具体数值：
   > 只要 `proposeWait` / `liveTimeline` 任一为真，
   > `agent-input-area` 必须带 `max-height` 且 `chat-wrap` 计算高度 > 0。

   这类「容器不得被内容撑破」的断言，比复制 N 个 max-height 修补更能防复发 ——
   上一轮的回归测试锁的是**单个组件的样式字符串**，所以新组件一诞生就绕过了它。

---

## 三、问题 3：思考过程没有流式展示

### 3.1 关键判断：**代码链路是通的，断在开关**

全链路逐层核实（含 vendor 上游）：

| 层 | 位置 | 状态 |
|---|---|---|
| 上游 vendor | `agent-loop.ts:327-340` + `ai/types.ts:551-553` | ✅ 原生 emit `thinking_start/delta/end`（`message_update` 载荷） |
| pi-runtime | `session-manager.ts:179-196` `EVENT_MAP` | ✅ 同名直传，**无剥离** |
| Nest 转换 | `pi-events.ts:513-571` `createThinkingAccumulator` | ✅ 400ms 节流下发累积快照（`transient:true`，只走 SSE 不落库），`end` 发全文 |
| 前端 store | `stores/agent.ts:407-412` → `executionTraceReducer` / `turnTimeline.ts:231-302` | ✅ running 段实时 append |
| 渲染 | `AgentTurnTimeline.vue:139-142` | ✅ `max-h-40 overflow-y-auto` + 脉冲光标 |

**真正断点（唯一）**：

```
Web   planningThinking = ref(false)                    // AgentSideRail.vue:1150 默认关
  ↓
Nest  mapThinkingLevel(thinking, effort)
      thinking !== true  ⇒  'off'                      // pi-runtime/thinking-level.ts:3-9
  ↓
pi-runtime  resolveThinkingLevel()：只对 undefined 回落 medium，
           收到具体值 'off' 就照传                        // session-manager.ts:747-750
  ↓
vendor  config.thinkingLevel === 'off' ⇒ 不传 reasoning 参数  // harness/execution/assistant.ts:80
  ↓
模型侧根本不请求 reasoning ⇒ 从源头不产生 thinking 事件
```

⛔ 单元测试甚至把这个行为**固化成了预期**：
`thinking-level.test.ts:6-7` 断言 `mapThinkingLevel(false,'high') === 'off'`、
`mapThinkingLevel(undefined,undefined) === 'off'`。
—— 这解释了为什么「链路通了但看不到效果」这么久没被自查发现：**测试锁的是映射函数，
没锁「用户能不能看到流式思考」这个端到端结果**。

### 3.2 两个叠加的次生问题

1. **新能力尚未合并**：`feat/thinking-live-stream`（`b3d594a5`, 19:11）**不在 `origin/master`**
   （`7f460ea8`, 18:58）。master 上 `:open="!dense"` ⇒ **dense（活体）时思考块默认收起**，
   也就是「流式内容其实在实时进，只是不给你看」—— 与用户「没看到效果」的描述高度吻合。

2. **开关不可见 / 无默认策略**：`supportsThinkingLevel` 决定开关可见性（`shared/src/modelCapability.ts`）。
   用户侧若看不到开关、默认又是关的，「新上线了思考流式但没效果」是必然的感知。

### 3.3 方案

**分两层，不要混为一谈：**

1. **能力层（代码已通）** —— 把「开关可见性」升级为显式产品决策：
   - 支持 reasoning 的模型：**默认开启**（`planningThinking` 初值按模型能力推导，而非硬编码 `false`）；
   - 开关必须**始终可见**（不支持的模型置灰 + tooltip「该模型不支持深度思考」，
     而不是整个入口消失 —— 入口消失 = 用户无法判断「是我的模型不支持，还是产品没做」）；
   - **默认值决策需与定价联动**：开思考 = 更多 token / 积分。要么默认开并在 UI 明示消耗，
     要么默认关但首轮给一次「开启深度思考」引导。**当前是「默认关 + 无提示 + 无可见入口」，
     等于功能不存在**，是最差的一种状态。

2. **合并层（流程缺陷）** —— `b3d594a5` 必须走 merge → 生产复测。
   合并后验证点（端到端，不能只看函数）：
   - 开启思考 → 模型是否真返回 `thinking_delta`（看 `pi-runtime` SSE 原始帧）；
   - 前端 running 块是否**逐段增长**（不是一次性出现）；
   - dense 与 history 两种形态的默认值是否符合预期。

3. **端到端守卫（补测试盲区）**：
   新增一条**跨层契约测试**（不 mock 掉 `mapThinkingLevel`）：

   ```
   场景：模型声明 supportsThinkingLevel=true，用户未显式设置
   断言：下发给 pi-runtime 的 thinkingLevel !== 'off'
        且 上游 assistant.ts 的 reasoning 参数被传入
   ```

   这条测试直接锁「用户默认能不能看到思考」，而不是锁映射函数的字面输出。

---

## 四、优先级与落地顺序

| 优先级 | 事项 | 理由 |
|---|---|---|
| **P0** | 问题 2 判定反转 + 布局守卫 | 阻塞期**完全无法回看历史**，是功能性阻断；且已复发过一次 |
| **P0** | 问题 1 折叠契约抽取 + 稳定 part id | 交互基本失效；且**同类修复已在另一组件做过一次**，再不抽象必然第三次复发 |
| **P1** | 问题 3 合并 `b3d594a5` + 端到端守卫 | 能力已通，缺合并 + 默认策略决策；不急但要让「已上线」名副其实 |
| **P1** | `nextPartId` 去 `Date.now()` | 影响折叠/动画/滚动锚点/增量 patch，是问题 1 的**共同前提**，与 P0 同批做更省事 |

**建议合并为一个 PR 的理由**：三个问题分属三个组件，但**共享两个根因** ——
①「展示默认值 vs 受控状态」混淆；②「容器约束责任错配」。
同批治理可一次建立两条共享机制（`useDisclosure` + dock 限高不变量），
并用两条布局/交互守卫钉住。若拆三个 PR，会重演「修一条路径、另一条继续漏」的老问题。

---

## 五、给 Agent 工程的三条通用结论

1. **原生交互元素（`<details>`/`<input>`/`<dialog>`）的「默认值」与「受控值」必须分离。**
   前者只在首帧生效，后者必须成对维护 state + 事件，否则用户操作会被下一次 patch 静默覆盖。
   平台侧应把裸 `<details :open>` 列为**评审红线**，而非等用户反馈。

2. **布局约束的归属要跟着「容器角色」走，不能跟着「已知内容」走。**
   `hasDockPresentation` 从「内容枚举」退化到「只有取消提示」时，
   所有未知的新内容自动失去保护 —— 这是**用实现枚举代替结构不变量**的典型代价，
   且注释里那句「门控/定稿卡片全部下线」正是决策当时就存在的信号，但没人把它翻译成
   「限高条件需要重新抽象」。

3. **测试要锁「用户可感知的结果」，不是「中间函数的输出」。**
   `mapThinkingLevel` 单测全绿而用户看不到思考；`scrollLock.test.ts` 锁住单个组件样式
   而新组件绕过它。两处都指向同一个盲区：**断言离用户远了一层，中间任何一次重构都会让它失效而不报警**。

---

## 附：本文关键断言的取证命令

```bash
# 问题 1：master 上的绑定值 + 不稳定 key
git show origin/master:apps/web/src/components/agent/AgentTurnTimeline.vue | sed -n '118,140p'
grep -n "nextPartId" -A5 apps/web/src/components/agent/turnTimeline.ts

# 问题 2：限高门控（注意 :910-923 的注释）
grep -n "hasDockPresentation" apps/web/src/components/agent/AgentSideRail.vue
sed -n '3846,3849p' apps/web/src/components/agent/AgentSideRail.vue

# 问题 3：开关默认值 + 映射固化
grep -rn "planningThinking = ref" apps/web/src/components/agent/AgentSideRail.vue
cat apps/server/src/agent/pi-runtime/thinking-level.ts

# 新能力未合并
git branch --contains b3d594a5 -a
```