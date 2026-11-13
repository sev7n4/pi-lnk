# C-1b · 全量集（Q3 多轮 + Q4 观测 + 画布终态 oracle）——实施规格

> 日期：2026-11-13 · 状态：**spec/plan 已落档，实施待单独授权**（代码刀纪律）
> 上位锚：C-1 立项 spec `2026-11-12-c1-canvas-decomposition-eval-design.md` §6 分期（C-1b 行）+ §8 判据细化（8.3/8.4/8.6/8.7 全部在本期生效）。
> 前置：C-1a 种子集已合并（PR #861，`ce5562f1`）——`expectTodoSnapshot`/`pickLatestSnapshot`/origin=production 纪律/L0 校验全部复用。
> 真模型跑批环境约束：agnes 平台 rpm 429 实名墙（`docs/ops/EVAL-c1a-seed-run-2026-11-13.md`）——C-1b 实施与判据开发不依赖跑批（L0 无 token）；跑批解锁后按本 spec 验收执行。

## 1. C-1b 交付定义（对齐 C-1 spec §6）

| 项 | 内容 |
|---|---|
| Q3 多轮 case | 8–12 条：步骤 1 拆解 → 步骤 2 执行中途 → 步骤 3 收尾，判 updates 增量序列 + 终态 status 分布 |
| Q4 派发观测 | 4–6 条（L0 only，观测期不设强门禁） |
| Q1/Q2 补量 | 各至 10–14 条（C-1a 现状 Q1=8 / Q2=6 双计口径） |
| 画布终态 oracle | `expectCanvasState` 判据字段落地（L3 节点数/类型计数 + L5 提交级） |
| identity 断裂观测 | §8.6 前置观测判据随 Q3 生效（只观测不计分） |
| model id 记录 | §8.7：runner 报告固定展示每 case 实际 model id |
| L0 契约测试 | 扩展覆盖全部新字段与 steps 结构 |

全集规模目标：**≥30 条**（C-1a 9 条 + 本期新增 ≥21 条），上限 50。

## 2. 生产取证（2026-11-13 只读副本，反查接地）

### 2.1 todo item 数据面（Q3 判据的地基）

生产 `todo_write` args（`AgentMessage.metadata.executionEvents[].data.args`）：

```json
{"todos": [{"activeForm": "生成v2定妆照", "content": "重新生成6张统一国漫厚涂风格的定妆照", "status": "in_progress"}, ...]}
```

- item = `{activeForm, content, status}`，**status 枚举 = pending / in_progress / completed**（生产实证三种全出现）；
- **无 id 字段**（模型侧 schema 无 id——A-2' 前提再次确认）；系统侧 id 由 task-state `reduce()` 按 content 匹配生成 ⇒ **content 跨快照逐字稳定 = identity 存活**（§8.6 观测的数据面成立）；
- 同一会话跨轮 status 演进实证：`pending×3 + in_progress×1` → 后续快照 `completed×2 + in_progress×2`（ts 1794123781173 → 1794125486999）⇒ **updates 增量序列判据可行**。

### 2.2 Q4 场景素材（生产反查命中，全部 production）

| 出处 ts | 话术 | 形态 |
|---|---|---|
| `1794386792852` | 时政+科技热点+流量逻辑+top10 短视频大调研 | **主动派发正例**（thinking 明示「我先派个子代理去收集」）——与 C-1a decomp-03 话术同任务更强版本 |
| `1794388824637` | 「以上调研分析为什么没有调用子 agent？」 | **真金用户纠偏反馈**：该派没派在生产被用户点名 ⇒ 正例话术的失败面实证 |
| `1794389008908` | 「用子代理重新跑一遍分析流程」 | 显式指令正例 |

克制负例：小查询/单点提问（复用 C-1a n2 话术形态）→ `forbidTools: ["spawn_subagent"]`。

### 2.3 画布 node 形态（L3 nodeTypeCounts 数据面）

`get-canvas-summary` 返回 node = `{id, status, title, type}`，**type 枚举 = image / text / video**（layout-smoke 画布实证）⇒ 类型计数判据零新增探针（summary 已返回 type，只需 runner 解析）。

## 3. 判据字段设计（对齐 §8.3，纯声明式）

### 3.1 多轮 steps[]（GoldenCase 扩展）

```ts
interface GoldenStep {
  text: string;                                   // 本轮用户话术
  expectTodoSnapshot?: SnapshotExpect;            // 复用 C-1a 字段（每步独立成立）
  expectTodoStatus?: {                            // 新增：快照 status 分布断言
    allOf?: Array<"pending" | "in_progress" | "completed">;  // 允许出现的枚举白名单
    requireProgress?: boolean;                    // 相对上一步：至少一条 item status 前进（pending→in_progress→completed 有序）
  };
  expectIdentitySurvival?: { itemIndex: number }; // §8.6 观测：编写期标注「本 item 将被编辑/重发」
  expectCanvasState?: CanvasStateExpect;          // §8.3 字段（收尾步用）
  expectTools?: string[];                         // 复用
  forbidTools?: string[];                         // 复用
}
```

- GoldenCase 增可选 `steps?: GoldenStep[]`——**有 steps 时顶层 text/expect* 不得共存**（L0 校验，防两套判据打架）；
- runner：有 steps 的 case 循环调用 `runEvalCase`（**同一 sessionId** 复用追加语义，systemPrompt 首次生效——driver 现状，已在代码注释实证），每步独立 transcript + 判据，**任一步 fail 即 case fail**（failures 带 `step[N]` 前缀定位）；
- **repeat 裁决**：Q3 多轮 case `repeat=1`（3 步 × 2–4 次 LLM 调用/步，repeat 3 成本不可接受）；抖动兜底改由「全集跑通 ≥2 轮跨 run 对比」承担（C-1 spec §6 C-1b 验收原文）。单轮 case（Q1/Q2/Q4 新增条目）沿用 repeat:3 多数表决。**这是对 §4 随机性处置的显式例外，登记于此。**

### 3.2 expectCanvasState（§8.3 形态落地）

```ts
expectCanvasState?: {
  nodeCount?: { min?: number; max?: number };
  nodeTypeCounts?: Record<"image" | "text" | "video", { min?: number; max?: number }>;
  generationSubmitted?: boolean;   // L5 提交级（判模型）；成功级 requiresGenerationWait 本期不实施
};
```

- 探针实现：复用 `fetchCanvasNodeCount` 的 HTTP 通道与信封解析（`x-lnkpi-service-token` / `{sessionId}` / `{code,message,data:{nodes}}`），扩展解析 node.type 计数——**零新增端点**；
- 判据消费统一经「画布终态读回函数」（eval 测试侧），C-2 生产校验未来共享同一函数（§8.3 一套 DSL 两消费方立场不变，本期只建 eval 侧）。

### 3.3 identity 断裂观测（§8.6 落地，只观测不计分）

- 数据面：同一 case 内跨步收集各步 `pickLatestSnapshot` 的 items；
- 机械判据：标注 item（`expectIdentitySurvival.itemIndex`）的 `content` 在**后续任一含 todo_write/propose_plan 的步**快照中逐字存活 ⇒ 存活；措辞变/消失 ⇒ 断裂一次；
- 产出：`identityBroken / identityObserved` 计数进报告固定区块 + C-1c 基线档案；**不影响 pass/fail**；
- 诚实边界：content 一字不差存活 ≠ 语义等价（模型可能措辞变但意图同）——**断裂观测按最保守口径计**（措辞变即计断裂），宁可高估不低估（观测目的是为 A-2' 立项提供价值证明，高估方向安全）。

### 3.4 model id 记录（§8.7）

`runEvalCase` 已从 `/sessions` 响应拿到 provider/model（`session created` 响应字段，C-1a 跑批实证）——driver 透传到 RuntimeRunResult，runner 报告 per-case 展示 `model` 列。跨 run 基线对比前先核 model id 一致。

## 4. Q3 场景集设计（8–12 条，编写期标注纪律同 C-1a）

每条三步结构（步骤 1 拆解 / 步骤 2 中途 / 步骤 3 收尾），全部 `origin:"production"`（话术取自生产反查）或显式 synthetic 带理由。种子候选（实施时按生产反查逐条定稿）：

| # | 形态 | 步骤 1 | 步骤 2（中途） | 步骤 3（收尾） | 出处 |
|---|---|---|---|---|---|
| q3-01 | 全周期跟踪 | 多步任务话术 → expectTodoSnapshot(min≥2) | 「继续/开始第一步」→ requireProgress | 「完成剩下的」→ expectTodoStatus(completed 存在)+终态 | C-1a decomp-01 同任务全周期化 |
| q3-02 | 中途追加项 | 拆解 → 快照基线 | 「另外把 X 也加进去」→ 新快照 items 增量 | 收尾 | 生产多轮追加形态反查 |
| q3-03 | 中途措辞重发 | 拆解 → 快照基线 | 改写式追问（诱导重发清单）→ **expectIdentitySurvival 标注** | 收尾 | §8.6 观测主场景 |
| q3-04 | 中途插入澄清 | 拆解（含未定参数） | ask_user 澄清 → 回答 | 收尾 | 豁免②场景：澄清不算拆解也不算断裂 |
| q3-05 | 显式方案→todo 迁移 | propose_plan → steps 快照 | 「开始执行」→ todo_write 接管 | 收尾 | plan/todo 双工具协同形态 |
| q3-06~08 | 按生产反查补齐 | — | — | — | C-1 spec §7.3 阈值纪律 |

**画布污染裁决**（Q3 特有设计问题）：多轮 case 共享 layout-smoke 画布 ⇒ 收尾步生成/建节点会跨 case 累积。处置：① Q3 收尾步判据**以 status 分布为主**，`expectCanvasState.nodeCount` 只允许写**上界**（防污染爆量）不写下界（写下界即环境 flaky）；② 需要「精确初始态」的 case 显式标 `requiresCleanCanvas:true`，runner 预检发现画布超限即抛「环境问题」（同 fetchCanvasNodeCount 纪律：绝不静默跑脏画布）；③ 本期不实现画布重置/清理（生产写操作，越权）——诚实登记为环境约束。

## 5. Q4 场景集设计（4–6 条，L0 only 观测期）

| # | 形态 | 判据 | 出处 |
|---|---|---|---|
| q4-01 | 大范围多源调研话术 | `expectTools` 含 `spawn_subagent` 或其前置读工具族（宽松：二选一即过——**观测期不设强门禁**） | `1794386792852` |
| q4-02 | 显式「用子代理」指令 | `expectTools` 含 `spawn_subagent`（用户显式指令=最强信号） | `1794389008908` |
| q4-03 | 用户纠偏后重做 | step1 常规拆解 + step2「为什么没调子agent」→ 观测模型是否改用 spawn_subagent（**只观测**，两分支都记录） | `1794388824637` |
| q4-04/05 | 小查询克制负例 | `forbidTools: ["spawn_subagent"]` | n2 形态扩展 |

q4-03 的价值：它是「三层点名模型」P3（系统提示点名）生效与否的行为观测面——若点名上线后模型在该场景自发改用 spawn_subagent，即为点名有效的直接证据。

## 6. Q1/Q2 补量（至各 10–14）

- Q1：补 2–6 条（生产反查多步话术优先；负例豁免三边界沿用 §8.2）；
- Q2：补 4–8 条（快照结构，阈值沿用 C-1a 生产锚 minItems≥2/maxItems≤6）；
- 来源纪律不变：production 必含 13 位出处；synthetic 必须带反查不到的理由。

## 7. L0 契约测试扩展（无 token）

1. steps 结构合法性：steps 与顶层判据互斥、每步至少一个判据、step.text 非空；
2. expectTodoStatus 枚举白名单校验；requireProgress 不得出现在 step[0]（无上一步可比）；
3. expectIdentitySurvival.itemIndex 越界 = 非法（须 < step 内快照 items 数的编写期上界）；
4. expectCanvasState：min≤max、type 枚举封死、generationSucceeded 出现即 L0 红（本期未实施成功级）；
5. Q3 case 必须 `repeat:1`（结构锁定，防止误配 3× 成本爆炸）；
6. requiresCleanCanvas 声明必须配 expectCanvasState（否则声明无意义）；
7. 快照判定语义单测扩充：status 演进（requireProgress 通过/失败两态）、identity 存活/断裂两态、伪造 transcript 零 token。

## 8. 验收标准

1. **L0 全绿**（无 token，进 CI smoke 档）；
2. 全量 eval 目录测试绿（既有 91 例 + 新增，无回归）；
3. 真模型跑批（环境解锁后）：全集跑通 ≥2 轮；抖动率 <20%（repeat 表决后仍翻脸 case 占比）；报告含 model id 列、identity 断裂计数区块、失败归因三分类；
4. 阈值/区间数字全部有生产锚或显式 synthetic 理由（C-1 §7.3 纪律）；
5. 纯 eval 资产刀：零生产代码路径（dist 影响面核对沿用 C-1a 结论：生产入口零 ./eval 引用）。

## 9. 诚实边界

1. Q3 多轮 case 的 token 成本显著高于单轮（3 步 × 2–4 调用/步）——磨限流环境下 12 条 Q3 全跑一轮 ≈ 150+ 次 LLM 调用，跑批必须 batch 化 + 低频；若环境持续阻断，Q3 行为验收推迟但 L0 与判据实现照常交付；
2. identity 观测的 content 逐字对比口径保守（§3.3），断裂率数字的含义必须在报告里写明口径；
3. 画布无重置能力 ⇒ Q3 对画布终态的断言力弱于理想（上界 only）——若未来 C-2 需要精确初始态，画布快照/恢复是独立立项；
4. Q4 观测期判据宽松（二选一即过）——扩强门禁等 spawned 持续性数据（#858 后 7 天复核纪律）。
