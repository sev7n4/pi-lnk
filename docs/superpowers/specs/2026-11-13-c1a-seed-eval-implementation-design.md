# C-1a · canvas 拆解质量种子集——实施规格（spec）

> 日期：2026-11-13 · 状态：**已立项推进**（用户授权「开始推进下一刀 = C-1a 种子集立项」；合并仍须单独授权——代码刀纪律）
> 上位锚：C-1 立项 spec `2026-11-12-c1-canvas-decomposition-eval-design.md` §6 C-1a 行 + §8 判据细化；路标规格 v1.3（`e957d6d8`）§9.4/§9.6。
> 本刀性质：**eval 资产刀**（`services/pi-runtime/src/eval/**` 测试侧 + docs），不触生产路径；`deploy.yml` paths 不含 services/pi-runtime ⇒ 合并不触发生产部署（eval 是否进 dist 见 §7 影响面核对）。

## 1. C-1a 交付定义（对应 C-1 立项 spec §6 首行）

1. **种子场景集**：Q1（拆解时机）+ Q2（清单结构）判据就位的 case 条目，**生产反查来源为主**（本 spec §3 逐条给出生产出处）；
2. **runner 判据扩展**：`GoldenCase` 增 `expectTodoSnapshot` 声明式判据字段 + `evaluateCase` 快照判定逻辑（纯函数，零生产代码）；
3. **L0 契约测试**：种子集自身合法性 + `evaluateCase` 判定语义单测（伪造 transcript，零 token，PR 必跑）；
4. **验收**：L0 全绿（无 token）；种子集人工跑一轮产出完整报告（失败归因三分类：模型行为/判据过强/环境）——人工跑批为 C-1a 收尾动作，不在本 PR 内。

## 2. 生产反查取证（2026-11-13，deploy-cvm 只读副本）

方法：`docker cp` 只读副本 → `sqlite3 "file:...?mode=ro"` → `AgentMessage.metadata.executionEvents` 反查。

**① 真实清单规模（Q2 阈值接地，防拍脑袋）**——4 条代表性多步任务的 todo/propose 快照实测：

| 生产出处（createdAt / thread 场景） | 工具 | items 实测 | 话术摘要 |
|---|---|---|---|
| 1794386994351（时政热点分析） | propose_plan → todo_write ×3 | **3** | 热点检索 → Top10 数据 → 综合报告 |
| 1794157769794（短剧分析+创作） | todo_write ×3 | **2** | 分析爆款逻辑 → 创作剧本 |
| 1794373817416（教学视频 tts 方案） | propose_plan → todo_write ×3 | **3** | 写脚本 → TTS 配音 → 音频驱动视频 |
| 1794373650015（先出方案） | propose_plan | **4** | 脚本节点 → 静帧图 → 动效视频 → 预览确认 |

⇒ **生产真实清单规模 = 2–4 项**（非想象中的 8–10）。种子集 `minItems` 一律 ≥2、`maxItems` ≤6（留校准余量），首阈值数字有生产锚。

**② 真实「该 propose 没 propose」失败实例（Q1 正例的直接证据）**：`1794390082165`「我需要做一个关于如何使用 codex 制作知识视频的方案，请你帮我设计方案」——显式方案请求，该 assistant 回合**零拆解工具**（无 todo_write/propose_plan，直接动了生成类工具）。种子集 c1a-decomp-02 复现此场景。

**③ 单步负例生产实例**：`1794037033829`「再帮我生成一条牧羊犬」（仅生成类工具，未拆解——正确行为）、`1794072144236`「这些节点没有重叠的吧」（纯提问）、`1794319138173`「所有的节点没法在一个视角内看到」（布局单原子操作）。

**④ 事件结构锚**（判据实现依据）：`tool_call` 事件 `data.args`——`todo_write` 为 `todos:[{content,activeForm?,status}]`；`propose_plan` 为 `{summary, steps[], explanation?}`（与 master `propose-plan.ts` schema 一致）；SSE 侧 `transcript.toolCalls[].input` 同构（`transcript.ts:144`）。

## 3. 种子场景集细目（9 条条目，Q1/Q2 判据双覆盖）

**计数口径（对 §6「各 5–7 条」的细化裁决）**：复合判据 case（召回 + 结构断言并存）按判据归属双计象限——Q1 判据出现在 8 条（5 复合召回 + 3 负例），Q2 判据出现在 6 条（5 复合结构 + 1 纯结构），两象限均落在 5–7 区间；条目总数 9 条（一次运行同时产出两象限数据，省 token）。

### 3.1 复合判据条目（Q1 召回 + Q2 结构，5 条，全部 origin:"production"）

| id | 生产出处 | 话术（自包含化） | expectTools | expectTodoSnapshot | about 要点 |
|---|---|---|---|---|---|
| `c1a-decomp-01` | 1794157769794 | 「帮我分析最近一周最火的 10 部短剧，拆解流量背后的底层逻辑，然后帮我选一个类似题材创作一部短剧」 | `["todo_write"]` | `{minItems:2, maxItems:4, requireDistinctContent:true}` | 生产实际 2 项（分析/创作）；≥2 可分辨子目标 |
| `c1a-decomp-02` | 1794390082165 | 「我需要做一个关于如何使用 codex 制作知识视频的方案，请你帮我设计方案」 | `["propose_plan"]` | `{minItems:2, maxItems:6, requireDistinctContent:true}` | **真实生产失败复现**：该回合零拆解工具 |
| `c1a-decomp-03` | 1794386994351 | 「基于最近一周的时政热点和科技热点，分析各平台流量逻辑，并给出接下来的题材选型建议」 | `["todo_write","propose_plan"]` | `{minItems:2, maxItems:5, firstStepPredicate:"collect"}` | 生产两工具都调（方案→清单管道）；首步=检索类（生产实测首步为搜索） |
| `c1a-decomp-04` | 1794373817416 | 「我要做一个教学视频：先出教学内容大纲，再根据大纲用 TTS 生成配音，最后用配音驱动画面视频生成。请先给我完整方案」 | `["propose_plan"]` | `{minItems:2, maxItems:5, requireDistinctContent:true}` | 生产 3 步方案；话术自带顺序约束（管线依赖），判清单互斥 |
| `c1a-decomp-05` | 1794373650015 | 「请你先把制作这个教学视频的完整方案给出来，我确认后再开始实施」 | `["propose_plan"]` | `{minItems:2, maxItems:6}` | 显式「先方案后实施」——最强 propose 信号；生产 4 步 |

### 3.2 纯 Q2 结构条目（1 条，origin:"synthetic" + 理由标注）

| id | 话术 | expectTools | expectTodoSnapshot | synthetic 理由（进 about） |
|---|---|---|---|---|
| `c1a-decomp-06` | 「帮我依次完成三件事：① 把画布上所有文本节点文案改成红色主题措辞 ② 为这个主题生成一张封面图 ③ 完成后把新旧节点排成一行」 | `["todo_write"]` | `{minItems:3, maxItems:6, requireDistinctContent:true}` | 显式枚举多指令形态在生产反查中均为续接上下文的残段，无法自包含复现；此形态是「items 数下限」判据的最干净载体。`requiresCanvasNodes:3`（需要真实文本节点） |

### 3.3 Q1 负例条目（3 条，origin:"production"，§8.2 原子性前置标注）

| id | 生产出处 | 话术 | forbidTools | 原子性标注（about 内） | 备注 |
|---|---|---|---|---|---|
| `c1a-decomp-n1` | 1794037033829 | 「再帮我生成一条牧羊犬的图片」 | `["todo_write","propose_plan"]` | ≤1 个原子调用（run_image_generation 提交）；生产实证未拆解 | 不 expectTools（生成有确认流，防 flaky）；三条豁免边界规避（无歧义参数、非澄清、非 1 项+说明） |
| `c1a-decomp-n2` | 1794072144236 | 「画布上这些节点有相互重叠的吗？」 | `["todo_write","propose_plan","create_nodes_batch","upsert_media_node","set_node_text","arrange_nodes"]` | 0 原子调用（纯提问，读探针合法） | 只禁写与拆解，不禁读（get_canvas_layout 合法） |
| `c1a-decomp-n3` | 1794319138173 | 「画布上的节点没法在一个视角内看到，帮我把它们整理到一屏内」 | `["todo_write","propose_plan"]` | ≤1 原子调用（arrange_nodes 一次） | `requiresCanvasNodes:3`；先查再确认不算（豁免①），判据只禁拆解不禁 arrange |

**负例共遵守**：§8.2 三豁免边界全部前置规避（话术自带无歧义参数 / 非澄清请求 / 非「1 项+方案说明」形态）；ask_user 澄清不算拆解（判据不含 ask_user）。

## 4. 判据扩展设计（对 C-1 spec §8.3 的实施态）

```ts
// golden-cases.ts 增量（additive，不改既有字段语义）
origin: "audit" | "synthetic" | "production";  // 扩枚举：production = 生产反查（about 必含出处）
expectTodoSnapshot?: {
  minItems?: number; maxItems?: number;
  requireDistinctContent?: boolean;        // 精确串重复判重；语义重叠不做（§8.3 不变）
  firstStepPredicate?: "collect" | "clarify" | "any";  // collect=搜索/检索/收集/调研类开头
};
```

**快照提取与判定语义**（`evaluateCase` 内纯函数，零新遥测）：

1. `pickLatestPlanSnapshot(toolCalls)`：取 transcript 中**最后一次** `todo_write` 或 `propose_plan` 调用的 input，`items = input.todos ?? input.steps ?? []`，每项 `content = item.content ?? item.summary ?? ""`——「终态语义」与 `pickLatestSnapshot` 播种精神一致；
2. 判定序：无任何拆解调用 ⇒ fail「未触发拆解工具」（expectTodoSnapshot 存在即要求触发，与 expectTools 独立再判一次）；items 数出 [min,max] ⇒ fail（报实际 items 数与内容）；`requireDistinctContent` 精确重复 ⇒ fail（报重复串）；`firstStepPredicate:"collect"` 首项 content 不匹配 `/(搜索|检索|收集|调研|查[一找看]|gather|search)/i` ⇒ fail（报首项原文）；
3. **"clarify" 枚举保留但种子集不使用**——首步澄清在生产形态为 ask_user 或方案 assumptions，硬断言形态未定（C-1b 与 firstStep clarify 判据共同定，§8.5 校准纪律）；
4. 失败信息必须同时报「期望 vs 实际」（与既有 failures 风格一致，`gc.test.ts` 既有断言风格）。

## 5. L0 契约测试扩展（`golden-cases.test.ts` 增量）

1. **资产合法性**：`expectTodoSnapshot` min≤max（错序=写错）、`firstStepPredicate` 枚举合法、`origin:"production"` 的 about 必含生产出处标记（`/\d{13}/` 时间戳）、`origin:"synthetic"` 的 about 必含「synthetic」理由段（修订既有「origin 不得为 synthetic」测试为「synthetic 必须带理由」，production/audit 不受限）；
2. **象限判据完备**：带 expectTodoSnapshot 的 case 必须同时有 expectTools 或 forbidTools（快照判据不悬空）；负例 case 的 forbidTools 必含 `todo_write` 与 `propose_plan` 二者；
3. **既有 L0 自检兼容**：about 工具名一致性测试自动覆盖新字段（工具名正则不变）；「至少一个可判定判据」检查需把 `expectTodoSnapshot ?? undefined` 计入有效判据（否则纯快照判据 case 会误报）；
4. **evaluateCase 判定语义单测**（伪造 transcript，零 token）：无快照 fail / minItems 违例报实际值 / distinct 重复报重复串 / firstStep 不匹配报首项原文 / 合规快照 pass / 多次 todo_write 取最后一次 / todos 与 steps 双 schema 解析。

## 6. 实现载体与环境（关键工程约束）

- **全新 master 快照工作区**：本地工作树在陈旧分支 `5926ac72` 且大范围脏（纪律：并发 worktree 不互踩）⇒ 以 `gh api tarball/e957d6d8` 建 C-1a 专用工作区 + 软链 node_modules，改动只落在 `src/eval/` 两文件 + 一新文件；
- 改动面（全量）：`eval/golden-cases.ts`（接口 + evaluateCase + GOLDEN_CASES 并入种子集）、`eval/canvas-decomposition-cases.ts`（新文件，9 条种子）、`eval/golden-cases.test.ts`（L0 扩展）；
- 测试跑法：nvm node24 + `--maxWorkers=1 --no-file-parallelism`（既有纪律）；
- L1 真模型人工跑批**不在本 PR**：C-1a 收尾动作，按 C-1 spec §5.3 环境约束在部署形态 pi-runtime 上执行并出报告（失败归因三分类）。

## 7. 影响面与门禁

- **生产影响面 = 零**：`src/eval/**` 不进生产代码路径；立项评审遗留问题「dist 是否含 eval 文件」本刀核验（tsc 构建输入不含 eval 目录即闭环，若含则补部署影响面评估注记）；`deploy.yml` paths 不含 services/pi-runtime ⇒ 合并不触生产部署；
- **门禁**：L0 全绿 + Build monorepo + Verify spec figures 全绿；CI 绿后停在合并前等单独授权（代码刀纪律）；
- **风险登记**：① 复合判据双计口径是 §6 读取的细化（登记于此，评审点）；② `firstStepPredicate:"collect"` 正则是初版判据，人工跑批期按失败归因校准；③ 生产出处话术均做了自包含化改写（原文是续接上下文的残段），about 必须保留出处时间戳供溯源。
