# C-2c acceptance：观测基线建档 + 阈值提案（立项规格）

> 日期：2026-11-14 · 状态：**待审阅（草稿）** · 依赖：A-2'（#863）、Skill SOP（#864）、C-2a（#866）、C-2b + isError 补正（#868，均已上线）
> SSOT：路标 §14.5（`2026-11-11-task-planning-engineering-roadmap-design.md:422`）、C-2a spec §5（`:99-107`）、C-2b spec（`2026-11-14-c2b-acceptance-canvas-state-design.md`）
> 按 v1.3 规格生命周期冻结（PR #860）：本刀细化**只进本文**，路标 §14 只回填状态行，正文不改。
> ⚠️ **本规格不产出任何阈值数字，不宣告 C-2c 闭环**：数据达标 gate（§5）未满足。

## 1. 背景与范围

C-2a（生成 oracle）与 C-2b（canvas_state + 多 kind 聚合 + isError 语义补正）已全部上线，生产 `b5088ed6`。路标 §14.5 定义的分期末段是「**C-2c 基线建档 + 阈值提案（人工拍板）**」，三指标为写入率 / fail-closed 拦截率 / fail-open 率。

本刀交付的是**观测契约与采集器**，不是基线本身：

- 定义三指标的精确分子/分母口径（§3 D1/D2）；
- 交付不侵入生产代码的周期采集器，解决进程内计数器重启清零问题（§3 D3、§4）；
- 定义阈值提案的**形状**与人工拍板流程，数字留白（§3 D4）；
- 明确数据达标 gate，未达 gate 只交付观测能力（§5）。

**不做**：改 acceptance DSL、扩 kind 枚举、改判据函数、加生产指标、自动 replan、自动设阈值、patch vendor、真模型 eval 进 PR 卡门。

> **优先级与价值澄清（PM/架构师审核 2026-11-14）**：本刀是「等 429 实名墙解封」的**候车室工作**——其四道 gate（§5）目前**全部未达**，采集器上线后中长期只会产出 `no_data`/探针期样本。真实解锁项是用户侧实名认证 / 换 key（§7）。故本刀只交付**最小可用**的观测契约 + 只读采集器，不追加任何超出 AC 的工程；剩余工程精力应压在「解墙」与「解封后回填 C-1a/C-1b 基线」上，而非提前拍阈值。

## 2. 调研实证（干净快照 `b5088ed6`，逐条 `文件:行号`）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 路标 §14.5 三指标与分期；写入率趋零 ⇒ 止损（同 §13.5 SOP 激活率条款） | 路标 `:422` |
| 2 | C-2a spec §5 写入率定义 `declared / tool_calls_total{tool="todo_write"}`；明确「本刀只建可查、不设阈值」「**C-2c 才做基线建档与阈值提案（人工拍板）**」 | C-2a spec `:99-107` |
| 3 | C-2a spec 已登记「Q3 收尾断言入 C-2c」，理由是 C-1a/C-1b 基线被 429 墙挡住、跨时段 AB 不可控 ⇒ **这是本刀的已登记欠账，不是新发现缺口** | C-2a spec `:15` |
| 4 | ⚠️ C-2a spec 注记「`user_confirm` 留 C-2c」与 C-2b D2「只注册已校验枚举」、路标 §14.4「不可机检不许声明」冲突 ⇒ 本刀裁决砍除（§3 D5） | C-2a spec `:40`；C-2b spec §3 D2 |
| 5 | `declared` 在 `verifyAcceptance` 入口打，**调用级**：一次调用只 +1，即使多个 completed 项带 acceptance | `tools/todo.ts:165-167` |
| 6 | `onAcceptanceKind` 在结构校验循环内按 **item** 打，且先于任何 oracle 查询与 reject ⇒ 一次被硬拒的多 kind 调用，两个 kind 都会计数 | `tools/todo.ts:174-184` |
| 7 | `pass / fail_closed / fail_open` 均在调用级打；`checkedAny=false` ⇒ `skip`（不打 pass） | `tools/todo.ts:200-250` |
| 8 | 两族指标是**进程内 Map**，无持久化、无落盘；pod 重建即清零 | `metrics.ts:142-144`, `:482-489`, `:805-816` |
| 9 | `todo` 状态作用域键 `storeScopeKey = canvasSessionId ?? sessionId` ⇒ **清单按画布共享，非按会话隔离**；探针复用同一画布会跨会话累积清单 | `session-manager.ts:1347`, `tools/todo.ts:276` |
| 10 | events.jsonl 真实路径为**两级嵌套**（2026-11-14 生产取证实证，原稿 `/data/sessions/sessions/*` 误判会零命中）：顶层会话 `/data/sessions/<session-id>/events.jsonl` + 画布子会话 `/data/sessions/<session-id>/sessions/<canvas-session-id>/events.jsonl`（因 `storeScopeKey = canvasSessionId ?? sessionId` 按画布共享，画布会话为 session 内 `sessions` 子目录）。是 append-only 结构性事件 journal，含 `tool_execution_start/end` 完整事件：`start` 带工具参数（含 `todos[].status/acceptance`），`end` 带结果（含 `isError` 与 `details.todo.rejected` 补正标记）⇒ 可离线读取、精确分出分母/分子。**注意**：`/data/sessions` 是 pod PVC（§4 访问机制），CVM 不能直接读；采集器须递归 `find /data/sessions -name events.jsonl`（depth≤5）；事件 schema 由采集器单测钉死（§4 AC2–AC5）。 | `events-journal.ts:19-36,36,68-91`、`session-manager.ts:1347`、`session-retention.ts:71` |
| 11 | `pi_runtime_tool_calls_total{tool="todo_write"}` 由事件层渲染，**含 schema 校验失败调用**；C-2a 的写入率分母口径因此有偏（§3 D2） | `metrics.ts:164`, 生产 `/metrics` 实测 |
| 12 | 会话目录受 TTL 驱逐：**`sessionTtlMs=1_800_000`（30 min）**，sweep 每 `300_000`（5 min）跑一次；count 上限 200、bytes 上限 ~3.2 GB（`runtime-config.ts:148-149`、`values.yaml:63-66`）。⇒ 采集周期必须 **≤ TTL/4 = 7.5 min**（取保守默认 **≤7 min**），否则事件被 sweep 前未被采样 ⇒ 分母不可回溯。 | `runtime-config.ts:148-149,192-193`、`charts/pi-lnk-runtime/values.yaml:57,63-66` |

### 2.1 生产现状取证（2026-11-14 14:3x，`b5088ed6`，上线约 1 小时）

```
pi_runtime_acceptance_total{outcome="declared"}    4
pi_runtime_acceptance_total{outcome="pass"}        1
pi_runtime_acceptance_total{outcome="fail_closed"} 3
pi_runtime_acceptance_total{outcome="fail_open"}   0   （未渲染 = 0 样本）
pi_runtime_acceptance_kind_total{kind="canvas_state"} 5
pi_runtime_acceptance_kind_total{kind="generation"}  1
pi_runtime_tool_calls_total{tool="todo_write",result="ok"}                    4
pi_runtime_tool_calls_total{tool="todo_write",result="error",error_class="validation"} 3
pi_runtime_tool_calls_total{tool="todo_write",result="error",error_class="internal"}   5
```

- `fail_open` 零样本；`generation` 子域仅 1 次声明（跨 kind 探针贡献）；
- 样本**全部来自本轮与上一轮探针**，无真实用户流量；
- 429 实名墙监视 10 条记录全 `rate_limited`，`NOT_UNLOCKED` ⇒ C-1a/C-1b 全量跑批基线仍欠。

⇒ **按 `declared / 全部 todo_write 调用` 计算会得到 4/12 ≈ 33% 的虚假写入率**：分母含 3 次 schema 校验失败（不进 execute，`declared` 不可能触发），且 5 次 `internal` 是 isError 补正后硬拒被事件层归类（补正前记 `ok`）。这条口径不能直接用于基线。

### 2.2 C-2b 生产证据链本轮已补齐（供 §5 gate 引用）

| 路径 | 证据 | 结论 |
|---|---|---|
| 证据不足硬拒 | `min=999999`、oracle 读回 `节点数=4、image:2/text:1/video:1`、`isError=true/rejected=true/diff.updates=[]` | ✅ 上一轮 |
| **pass 边界（含等号）** | `min=4,max=4` 对真实 4 节点 ⇒ `isError=false`、`diff.list=[A/plan-3]` 写入真发生、指标 `pass=1` | ✅ 本轮 v2 `pass:2` |
| **同组 reject 优先** | 双 canvas 项 A(pass)+B(证据不足) ⇒ 整体硬拒、回执精确点名 B、`diff.updates=[]`；快照仍保留既有 `A/plan-3` ⇒ 非空初始态下零副作用 | ✅ 本轮 `dual:1` |
| **跨 kind 聚合** | 一次调用两个 item 各带 `generation`/`canvas_state` ⇒ generation 组先查、证据不足即硬拒，canvas 组未执行；`kind` 两族各 +1 | ✅ 本轮 `multi:3` |
| isError 精准性 | vendor schema 错误也 `isError=true` 但 `rejected=null` ⇒ 补正只打我们的硬拒 | ✅ 上一轮 |

⚠️ 仍缺：**fail-open 生产实证**（需人为制造 oracle 查询故障，不擅自改生产配置）、**跨 kind 双方都 pass**（需会话内真实生成记录）。二者只有单测覆盖。

## 3. 五项裁决

### D1 · 口径统一：写入率按「项」，拦截率/健康度按「调用」

`declared` 是调用级（事实 5），一次调用可有多个 completed 项；`acceptance_kind_total` 是项级（事实 6）。混用会失真。裁决：

| 指标 | 分子 | 分母 | 单位 | 说明 |
|---|---|---|---|---|
| 写入率 | 带 `acceptance` 的 completed **项**数 | 所有 completed **项**数 | 项 | 与 SOP 教学「收尾写声明」语义对齐 |
| fail-closed 拦截率 | `fail_closed` | `declared` | 调用 | 沿用 C-2a spec §5，不改口径 |
| fail-open 率 | `fail_open` | `declared` | 调用 | 同上 |

⚠️ 三者单位不同，采样输出必须逐行标注 `unit=item|call`，禁止拼进同一比率表而不声明。**旁路对照**：同时输出 `declared / 合法 todo_write 调用数`（调用级写入率）作为交叉校验，但不作为主指标。

### D2 · 分母不新增生产指标，走 `events.jsonl` 离线统计

理由（§2.1 + 事实 11）：`tool_calls_total` 含 schema 校验失败调用，会系统性低估写入率；isError 补正又把硬拒归为 `internal error`，用 `result="ok"` 做分母会把硬拒排除，仍有偏。而 `events.jsonl` 是 append-only 且含完整工具参数（事实 10），可精确分出：

- `todo_write` 调用数（按 `tool_execution_start`）；
- 参数中 `status="completed"` 的项数（分母）；
- 其中带 `acceptance.kind` 的项数（分子）；
- 硬拒数（`tool_execution_end.details.todo.rejected=true`）；
- validation 失败（只有 start、无合法 end 或 schema 报错）。

⇒ **零生产代码改动**（极简哲学，路标 §19.1）；采集器只读 `/data/sessions`。

⚠️ **口径子集关系（防双重计数）**：events 派生的 `hard_rejects`（`tool_execution_end.details.todo.rejected=true`）**只是** metrics `fail_closed` 的**子集**。`fail_closed` 还含「结构非法 / schema 不符」类硬拒——这类在框架层 `execute` 前即被拒，**不会**产生 `rejected=true` 的结束事件。采集器输出必须分两列：`hard_rejects`（events 派生，仅证据不足类）与 `fail_closed`（metrics 原值，含全部硬拒），禁止把 `hard_rejects` 当 `fail_closed` 用、也禁止二者相加。旁路对照：`tool_calls_total{result="error",error_class="validation"}` 即结构/schema 拒的近似计数。

🔴 **已知生产缺陷（独立小刀，不在本 PR 范围）**：`pi_runtime_acceptance_total` 已上线且**任何看板读者都会用 `tool_calls_total` 当天然分母**，而该分母含 3 次 validation + 5 次 internal（§2.1），系统性失真（§2.1 的 33% 假象即源于此）。本刀只把口径搬去离线计算，**未修复活指标本身**。建议作为独立刀（守本刀 No-Go「不新增生产指标」，需单独授权）：① 在 `metrics.ts` 新增 `pi_runtime_todo_write_executed_total`（仅 `execute` 进入后计数）作为自洽分母；或② 在 `pi_runtime_acceptance_total` 的 HELP 行显式写明「分母非 `tool_calls_total`，见 C-2c D2」。本刀不擅自改生产指标。

### D3 · 重启清零：外部周期采样 + 版本段，不做负增量

`/metrics` 是进程内 Map（事实 8），K3s 部署会重建 pod。裁决：

- 采集器部署在 CVM（cron 或低频常驻），**不进 pi-runtime 代码、不写生产 DB**；
- 每条采样记录带 `ts`、`PI_RUNTIME_VERSION`、`pod_name`、`window_key`；
- 计数器下降 ⇒ 标记 `reset=true` 并开新版本段，**不做负增量、不跨段直接累加**；
- 采样周期必须短于会话目录 TTL 驱逐窗口（事实 12：TTL=30 min，sweep=5 min），否则 `events.jsonl` 分母不可回溯。
- **采样频率 concrete**：默认 **≤7 min**（≤ `TTL/4`=7.5 min，取保守整数），避免「重启 + TTL 双驱逐」的**组合失效**（pod 重建清空 `/metrics` 且事件被 sweep ⇒ 该窗口分母与计数同时丢失）；若生产调大 `PI_RUNTIME_SESSION_TTL_MS`，同步放宽采样周期但必须满足 `周期 ≤ TTL/4`。
- **上次样本落 CVM 本地盘**（`acceptance-samples.jsonl` 即其自身）：采集器启动即读末行作为 `prev`，跨采集器自身重启也能检测 pod 重启段，不用依赖进程内记忆；
- **组合失效处置**：若某窗口既 `reset=true` 又无对应 `events.jsonl`（已被 sweep），该窗口标 `no_data`，不估算补齐（§7）。

### D4 · 阈值提案只定形状，数字与拍板归人工

采集器只产出**分位数建议表**（格式留白，本刀不填数），三类阈值语义固定：

| 阈值 | 语义 | 超线动作 |
|---|---|---|
| 写入率下限 | 模型不写 ⇒ 机制空转 | 止损：`PI_RUNTIME_ACCEPTANCE=off`（kill switch 一行，不删 schema） |
| fail-closed 上限 | 模型普遍虚报完成 | 回灌 Skill SOP / C-1 eval 新 case（路标 §18.2 事故→eval 回灌） |
| fail-open 上限 | 机制健康度 / Nest oracle 抖动 | 告警，查 oracle 依赖，不改判据 |

⛔ 脚本**不得**自动设阈值、不得自动触发止损；阈值数字与是否启用由人工拍板（路标 §14.5「人工拍板」原文）。

### D5 · 两处历史注记的处置

1. `user_confirm` **不做**（砍除 C-2a spec `:40` 的「留 C-2c」注记）：① 不可机检，违反路标 §14.4「不可机检的验收不许声明」；② 已有 `ask_user` 一等事件与终态卡（#846/#848）作为用户确认的结构化载体；③ 违背 C-2b D2「只注册已实现校验的枚举」。C-2c 明确不扩 DSL。
2. Q3 收尾断言（C-2a spec `:15` 登记的欠账）：**本刀只登记依赖，不实现**。它依赖 C-1a/C-1b 跑批解锁（gate G1），且 C-1 spec Q3 现有判据只有 `updates` 序列与终态 status 分布（C-1 spec `:40`），补断言需另立 eval 刀。本刀在 §5 把它列为 gate 依赖项，不假装已有。

## 4. 采集器规格

**输入（全只读）与访问机制**：

| 源 | 真实位置 | CVM 如何取 | 只读性 |
|---|---|---|---|
| 计数器 | `:30100/metrics`（NodePort，宿主可达） | `curl --noproxy '*' localhost:30100/metrics` | ✅ GET |
| 事件 journal | `/data/sessions/<sid>/events.jsonl` + `/data/sessions/<sid>/sessions/<csid>/events.jsonl`（**两级嵌套，pod PVC，非 CVM 文件系统**；采集器递归 `find /data/sessions -name events.jsonl`） | `kubectl exec deploy/pi-lnk-runtime -n pi-lnk-runtime -- sh -c 'find /data/sessions -name events.jsonl -exec cat {} +'`（`KUBECONFIG=/etc/rancher/k3s/k3s.yaml`，与 RUNBOOK 取证同手法） | ✅ 仅 `cat`，不写 |
| pod / 版本 | 部署元数据 | `kubectl get deploy -n pi-lnk-runtime` + `/metrics` 的 `build_info` 标签（版本须等于镜像 tag，RUNBOOK:55） | ✅ GET |

⚠️ **致命误设（两类，2026-11-14 生产取证补全）**：(a) 把 events 当成「CVM 本地盘路径」直接 `fs.readdir` ⇒ 必然 `ENOENT`——`/data/sessions` 经 PVC 挂进 pod，CVM 侧无此挂载；必须 `kubectl exec`（或改为 in-cluster CronJob 挂同 PVC）。(b) 写成单层 glob `/data/sessions/sessions/*/events.jsonl` ⇒ 生产**零命中**（真实没有顶层 `sessions/` 目录，`sessions` 是 session 内的画布子会话目录）；必须用两级递归 `find /data/sessions -name events.jsonl`，覆盖 `<sid>/events.jsonl` 与 `<sid>/sessions/<csid>/events.jsonl`。本刀采 CVM `kubectl exec` 路线，复用既有取证范式、零新部署单元。

**输出**：append-only `acceptance-samples.jsonl`，每行一个窗口：

```
ts, window_key, version, pod, reset,
declared, pass, fail_closed, fail_open,          # 来自 /metrics，counter 原值
kind_generation, kind_canvas_state,
todo_calls, completed_items, acceptance_items,  # 来自 events.jsonl，窗口增量
hard_rejects, validation_errors,
unit_written_rate=item, unit_verdict_rate=call,
written_rate, fail_closed_rate, fail_open_rate, # 分母为 0 ⇒ null + no_data
traffic_tag=probe|real|mixed
```

**流量分级（G4 使能）**：采集器无法从事件本身判断「探针 vs 真实用户」。机制：采集器读 env `PROBE_SESSION_PATTERN`（默认空 ⇒ **保守把所有流量标 `probe`**），对命中的会话整窗标 `traffic_tag=probe`，未命中标 `real`，混合即 `mixed`。探针脚本须用约定前缀（如 `c2b-probe-*`）命名画布/会话，使模式可匹配。**默认全 `probe` 是刻意保守**：在真实流量占主导前，绝不把样本当基线（§7）。

**守卫（每条都要有变异自检，且必须 RED）**：

| # | 守卫 | 失效后果 |
|---|---|---|
| 1 | 分母为 0 ⇒ `no_data`，**不得**输出 `0%`/`100%` | 假基线 |
| 2 | 计数器下降 ⇒ `reset=true` 开新段，禁止负增量 | 重启被读成写入率崩塌 |
| 3 | `window_key` 幂等去重 | 重复采样抬高样本量 |
| 4 | `events.jsonl` 损坏行 fail-soft 跳过并计数 | 半行写入污染分母 |
| 5 | 只读：不写生产 DB、不改 pod env、不调 kill switch | 越权 |
| 6 | `traffic_tag` 必须标注；全探针流量 ⇒ 报告显式写「不代表生产分布」 | 把探针期当基线 |

⚠️ 判据纪律：变异 RED 判定用完整 stdout 的 `AssertionError`/`failing tests` 标记，**排除模块加载失败造成的伪 RED**（本轮 PR #868 踩过 `Cannot find package 'typebox'` 导致 13 项变异恒红）；变异脚本须先跑基线预检，全绿才放行。

## 5. 数据达标 gate（人工拍板前置，本刀不锁数）

| Gate | 条件 | 当前 |
|---|---|---|
| G1 | C-1a/C-1b 全量跑批解锁并完成基线（用户侧实名认证 / 换 key） | ❌ 10 条监视全 `rate_limited` |
| G2 | 生产采样窗口 ≥ N 天且 `declared` ≥ M（N/M **人工拍板**，本规格不填数） | ❌ 4 次声明、上线 ~1h |
| G3 | 采样期内无 kill switch 切换、无未标记的重启跨段 | ⏳ 采集器尚未部署 |
| G4 | 真实用户流量样本占主导；否则必须标注「探针期」 | ❌ 当前 100% 探针 |

**任一未达 ⇒ 只交付观测契约与采集器，不产出阈值数字、不宣告 C-2c 闭环、不回填路标状态行为「已完成」。**

## 6. 验收标准（AC）

1. 规格落档并通过 `verify-spec-figures`（0 错）；路标正文零改动。
2. 采集器实现 + 单测：AC1 正常窗口产出三指标；AC2 分母 0 ⇒ `no_data`；AC3 counter 回退 ⇒ `reset` 段；AC4 重复窗口幂等；AC5 损坏行 fail-soft；AC6 `traffic_tag` 标注；AC7 只读（无写操作调用）。
3. 6 项变异自检全部 RED + 基线预检全绿 + 所有变异文件恢复。
4. 在 CVM 采集器跑满一个采样窗口，产出 `acceptance-samples.jsonl` 首行并与 `/metrics` 人工对账一致。
5. 报告 `docs/ops/` 落一份「观测契约 + 当前样本现状 + gate 未达说明」，**明确写着阈值待人工拍板**。
6. 路标 §14 只追加一行状态回填（v1.3 冻结），措辞为「观测契约已建，基线/阈值待 gate」，不得写成「C-2c 完成」。

## 7. 风险与回滚

- **采集器本身是新增运维面**：只读、低频、失败只告警不阻断；停 cron 即回滚，无生产状态残留。
- **TTL 驱逐导致分母丢失**：采集周期短于窗口；若已丢失，该窗口标 `no_data`，不估算补齐。
- **429 墙期污染**：模型输出残缺 ⇒ `validation` 错误抬高、写入率被压低。墙期样本单列 `traffic_tag=probe/429`，不进拍板基线。
- **canvas 共享清单**（事实 9）：`events.jsonl` 按会话统计 completed 项时，同一画布的跨会话清单会在快照里重复出现 ⇒ 只统计**工具调用参数**里的项，不用快照去重，避免漏算。

## 8. No-Go（与路标 §5.3 一致）

不改 acceptance DSL / 不加 kind（含 `user_confirm`）；不新增生产指标；不做自动 replan、自动阈值、自动止损；不 patch vendor；不在 PR 卡真模型 eval；不动路标 v1.3 冻结正文；不写生产 DB。

## 9. 与路标 v1.3 冻结的关系

本规格是**独立立项 spec**，与 C-2a/C-2b 同构：细化只进本文，路标 §14 仅在实施后追加一行状态回填。§16.3/§16.9/§18.2 的重审触发条款不因本规格改变。

## 10. 人工拍板 playbook（决策手册）

本刀不自动拍板（D4）。以下是在 §5 四 gate 满足后，人工把「观测数据」转成「阈值与闭环结论」的可执行手册。

### 10.1 触发条件
- §5 G1–G4 **全部**绿（任一未达 ⇒ 停，只维护采集器，不拍板）。

### 10.2 输入
- `acceptance-samples.jsonl`（采集器产出，窗口聚合后）；
- 采集器生成的**分位数建议表**（离线口径 D2，非 `/metrics` 分母）；
- 生产 `/metrics` 原值（仅交叉校验，不作基线分母——§2.1 的 33% 陷阱）。

### 10.3 步骤
1. **核验流量纯度**：确认 `traffic_tag=real` 窗口占主导；若仍 `probe` 主导 ⇒ 回到 G4，不拍板。
2. **离线重算三率**：用 D2 口径（events 派生分母）算 写入率(item) / fail-closed 率 / fail-open 率，逐项对照分位数建议表。
3. **套 D4 语义定数**：
   - 写入率下限：模型不写 ⇒ 止损 `PI_RUNTIME_ACCEPTANCE=off`（kill switch 一行，不删 schema）；
   - fail-closed 上限：普遍虚报 ⇒ 回灌 Skill SOP / C-1 eval 新 case（§18.2）；
   - fail-open 上限：机制健康度 / oracle 抖动 ⇒ 告警查 oracle 依赖，不改判据。
4. **落锁**：阈值数字写入 `docs/ops/acceptance-baseline.md`（锁定版），记录采样区间、N/M、拍板人、日期与理由；采集器可选读该文件做软告警（仍不自动止损）。
5. **闭环**：路标 §14 状态行由「观测契约已建，基线/阈值待 gate」改为「C-2c 闭环：基线已建档、阈值已拍板（见 acceptance-baseline.md）」。

### 10.4 反模式（拍板前自查）
- ❌ 用 `/metrics` 的 `tool_calls_total` 当分母（33% 假象，§2.1）；
- ❌ 在 `probe` 主导期拍板（G4 未达）；
- ❌ 自动设阈值 / 自动止损（D4 ⛔）；
- ❌ 把 `hard_rejects`（events 子集）当 `fail_closed`（D2 ⚠️）；
- ❌ 跨 `reset` 段直接累加（D3 ⛔）。

### 10.5 重新打开
- 任一 gate 回归（G1 墙复封 / G3 出现未标记重启段 / G4 流量纯度跌破）⇒ 自动回到「只观测」；
- 锁后数据漂移超出带宽（如 fail-open 率连续 N 窗超线）⇒ 按 §18.2 事故→eval 回灌 重新评审阈值。
