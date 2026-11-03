# E1：生成终态写点直通（terminal write tap）设计规格

状态：待评审（brainstorming 产出，2026-11-03，方案 A 拍板见 §4）
前置：
- `2026-11-03-e-series-conversation-driven-canvas-evolution-design.md`（总纲，G-1~G-5 判据全期有效）
- PR #684 `5583168a`（订阅先于触发：`onBeforeNotify`/arm 机制）
- PR #685 `9e66ef84`（`notifyTerminalsOnce` 抽取 + `notifyInFlight` 单飞 + job-generation-notify 1min tick）
分支约定：feature 分支 + PR + squash merge；feature flag `LNKPI_TERMINAL_WRITE_TAP`（缺省开）。

## 0. 配图索引

| 编号 | 形式 | 内容 | 位置 | 用途 |
|---|---|---|---|---|
| 图 1 | 内嵌 Mermaid（时序） | 拦截→直发→简报轮全链路时序 | §5 | 验收：触发点与守卫的相对位置 |
| 图 2 | 内嵌 Mermaid（判据树） | 终态迁移判定（拦截 vs 放行） | §5.2 | 验收：判据穷举、metadata 更新不误触 |

## 1. 背景与取证

**背景**（详见总纲 §1-§2）：天鹅→蓝老虎→黄小龙虾事故链修复后简报链路已通，但
WorkBuddy 对标结论表明差距在「完成事件的送达路径」——它是进程级事件点对点注入，我们是
「写库→1min tick 全表扫描」广播模型。E1 把送达路径升级为「终态迁移即触发」，tick 降级纯兜底。

**延迟构成**（2026-11-03 生产取证，蓝/红精灵会话）：

| 产物类型 | 直发路径 | 延迟 |
|---|---|---|
| text 及 agent-canvas-tools 结算的生成 | `notifyTerminalNow` 10 个调用点（全部在 agent-canvas-tools.service.ts） | 秒级（终态写入同毫秒触发） |
| **studio 管线直写的终态**（image/video/audio 的 probe/merge/provider 回调/超时分支） | **零直发**，只靠 1min tick 扫描 | 0~60s 随机（黄小龙虾旧版 5.5min 即此根因） |

**写点分布**（`git grep` 取证）：`generationRecord.update/updateMany` 生产代码共 29 处
—— studio.service.ts 27 处（completeImage/Video/Music 的成功、失败、超时、fallback 各
分支，无公共 helper）+ generation-reaper.service.ts 1 处（回收）+ late-generation-notify
1 处（`agentTurnNotified` metadata 标记，**非终态迁移，不应触发**）。

## 2. 目标

1. 终态落库 → 直发触发延迟 **P95 ≤ 5s**（当前 tick 路径 0~60s）。
2. studio 写点 **零改动**（B2 当年放弃逐点挂钩的教训：漏改 = 静默丢简报）。
3. tick 降级为纯兜底（总纲 G-1：上线一周后 tick 命中占比 <10%）。
4. 新增生成类型/新写点**自动被覆盖**（写咽喉性质，与 reaper 读咽喉同构）。

## 3. 范围（含明确不做）

**做**：
- 新模块 `apps/server/src/studio/terminal-write-tap.ts`：Prisma `$extends` 拦截 +
  终态迁移判据 + 触发 `notifyTerminalsOnce('terminal-write')`。
- feature flag `LNKPI_TERMINAL_WRITE_TAP`（env，缺省开；关 = 行为与今天逐字节一致）。
- reason 观测打点：notify 扫描日志按 reason 分布（`terminal-write` / `notify-tick` /
  `periodic` / `startup` / `manual`），供 G-1 度量。

**不做**：
- 不改 studio.service.ts 任何一处 update 调用（零写点改动是本规格的存在理由）。
- 不改 `notifyTerminalsOnce` 内部（直发、去重、单飞守卫、arm/onDelivered 钩子全部原样复用）。
- 不引入 outbox 表 / 新 worker / 新定时器。
- 不做同会话聚合（E3）、不做失败文案（E4）——本包只保证「触发」。
- 不拦截 reaper 对 canvasData/Session 的写（只挂 GenerationRecord 模型）。

## 4. 方案裁决（A / B / C 对比，拍板 A）

| 方案 | 改造面 | 风险 | 裁决 |
|---|---|---|---|
| **A. Prisma `$extends` 终态迁移拦截** | 1 个新模块，零写点改动 | 判据需精确（§5.2 给出类型级判据） | **拍板** |
| B. 收拢 27 处为 settle helper 再挂钩 | 27 处 × 各分支测试 | 漏改 = 静默丢简报（B2 已证明逐点路线维护性差） | 否决 |
| C. tick 提频 30s | 极小 | 不治本，扫描频率换延迟 | 否决 |

**拍板 A 的五条理由**：① 改造面即交付风险（1 vs 27）；② 「读咽喉→写咽喉」哲学同构，
新写点自动覆盖是已验证性质；③ 净新增面最小（直发/去重/单飞/钩子全复用 #684/#685）；
④ 判据是 Prisma 类型级的，零语义猜测；⑤ 纯增量 + flag 可回滚（总纲 G-3）。

## 5. 详细设计

### 5.1 全链路时序

（见 图 1）

```mermaid
sequenceDiagram
    participant S as studio.service
    participant P as 拦截层 write-tap
    participant N as GenerationReaperService
    participant R as pi-runtime
    S->>P: generationRecord.update（status 终态）
    P->>P: 判据判定（图 2）通过
    P->>N: void notifyTerminalsOnce（"terminal-write"）——fire-and-forget
    Note over N: 单飞守卫：在飞则跳过；durable 去重：已通报则不重发
    N->>R: notify-generation（arm 先于 notify，#684）
    R->>R: 简报轮（agent_start）
    N->>N: onDelivered 钩子 → 投影落库（AgentMessage）
```

**图 1 · 拦截层只做触发器——并发治理全部在既有 notifyTerminalsOnce 一侧**

图 1 说明了什么：拦截层只是「触发器」，通报的全部并发治理（单飞、去重、订阅先于触发、
投影落库）都在既有 `notifyTerminalsOnce` 一侧——拦截层自身无状态、无锁、无重试，
fire-and-forget 保证写路径零阻塞（判据 D-2）。

### 5.2 终态迁移判据（图 2）

（见 图 2）

```mermaid
flowchart TD
    A["update / updateMany 调用"] --> B{"model == generationRecord？"}
    B -->|否| X["放行不拦"]
    B -->|是| C{"data.status 存在？"}
    C -->|否| X2["放行：metadata 标记等非状态写"]
    C -->|是| D{"data.status ∈ completed / failed？"}
    D -->|否| X3["放行：generating 占位等中间态"]
    D -->|是| E{"flag LNKPI_TERMINAL_WRITE_TAP 开？"}
    E -->|否| X4["放行：flag 关闭"]
    E -->|是| F["触发 notifyTerminalsOnce（terminal-write）"]
```

**图 2 · 终态迁移判据四层判定——全部类型级/配置级，无语义猜测**

图 2 说明了什么：判据四层全部是**类型级/配置级**断言，无业务语义猜测——
`data.status` 字段存在性天然区分「终态迁移」与「`agentTurnNotified` 标记更新」（后者
只写 metadata，不含 status，即 §1 取证中 late-generation-notify 的那 1 处不误触）；
状态枚举由 Prisma `GenerationRecordWhereInput` 类型约束。

**边界语义**：
- reaper 回收（generating→completed/failed）**同样触发**——回收是超时终态，正为 E4
  「失败主动叙事」供事件；本包不改文案，简报内容与今天一致。
- 同一 update 内 `metadata` 与 `status` 同时写：含 status 即触发，metadata 部分照常写入（拦截是旁路观察者，不改写调用参数）。
- `$extends` 挂载点：`PrismaService` 初始化处按 flag 条件 `$extends`（flag 关 = 不挂载，
  client 保持 base 类型），与其他 `$extends`（如存在）叠加顺序无关（拦截只读参数不修改）。
  ⚠️ 实现注意：`$extends` 返回 extended client，其类型与 base 不同——挂载必须在
  `PrismaService` 内部完成（不外泄类型变化），并跑一遍 server 全量 tsc 确认消费者类型兼容。

### 5.3 观测

- 复用既有日志：`[terminal-write] 回合外生成终态通报已处理 N 条`（notifyTerminalsOnce 原样）。
- G-1 度量：打点 `generation_notify_trigger_total{reason}`（terminal-write / notify-tick /
  periodic / startup / manual / orphan-reap 预留），上线一周后出 tick 占比基线。

## 6. 判据（D-系列）

- **D-1 零写点改动判据**：PR diff 中 `studio.service.ts`、`generation-reaper.service.ts`、
  `late-generation-notify.ts` 的 update 调用零行变更（review 硬检查）。
- **D-2 零阻塞判据**：拦截层对 update 的返回值透传原样（不改参数/不改返回），触发走
  `void … catch(warn)`，写路径不 await 通报（变异：把 void 改 await ⇒ 写路径延迟测试必须红）。
- **D-3 判据穷举判据**：图 2 的每个「放行」分支各有至少一个测试用例（含
  `agentTurnNotified` metadata 更新不触发的反例——即 §1 的第 29 处写点）。
- **D-4 守卫复用判据**（总纲 G-2）：并发两条终态 update ⇒ `notifyInFlight` 使第二次
  触发跳过；已通报记录 ⇒ durable 去重跳过。测试复用 #685 既有单飞/去重用例形态。
- **D-5 flag 语义判据**：flag 关闭时 `$extends` 不挂载（非空转判断），行为与今天逐字节一致。

## 7. 测试策略

1. **单元**：判据树全分支（图 2 六路）+ flag 开关 + 返回值透传。
2. **变异测试**（守卫必须行为级）：① 判据去掉 `status ∈` 检查 ⇒ D-3 用例必须红；
   ② 触发改 await ⇒ D-2 用例必须红；③ flag 判断取反 ⇒ 开关用例必须红。
3. **集成**：completeImage 成功 / 失败 / 超时三分支各触发一次（断言 notify mock 收到
   `terminal-write`）；reaper 回收路径触发一次（E4 铺垫）。
4. **回归**：generation-reaper.service.test.ts 全量 31 用例不动；notify-tick 用例语义不变。

## 8. 回滚

- `LNKPI_TERMINAL_WRITE_TAP=false` → `$extends` 不挂载，等同回滚。
- 模块独立文件（terminal-write-tap.ts），回滚 = 删文件 + 删挂载行，无遗留。

## 9. 验收（生产）

| 项 | 判据 |
|---|---|
| 直发延迟 | 蓝精灵式复测：图片 probed 完成 → 简报触发 ≤ 5s（取 3 次样本） |
| tick 占比 | 上线一周 `generation_notify_trigger_total` 中 tick 占比 <10%（G-1） |
| 零回归 | 一周内无重复简报（durable 去重无击穿）、无通报风暴（单飞守卫日志零跳过异常） |
| 写路径 | studio 生成接口 P99 延迟环比无劣化（D-2 生产面） |
