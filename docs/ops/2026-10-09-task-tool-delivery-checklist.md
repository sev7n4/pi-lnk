# C1 任务清单工具化 上线验收清单

> spec：`docs/superpowers/specs/2026-10-09-task-tool-design.md`（v1.1）· 实现计划：`docs/superpowers/plans/2026-10-09-task-tool-todo-write.md`
> 分支：`spec/todo-task-tool`（Task 0-5 六个实现 commits，TDD 全绿：pi-runtime 1203/1203 · Nest 1317/1317 · prompt:lint ok）

## 部署前
- [ ] 双侧 env 核对：Nest（lnkpi-api 容器）与 pi-runtime（k3s）`PI_RUNTIME_TODO_TOOL` 同值（部署纪律：平台 env 不落 DB）
- [ ] `pnpm test:server && pnpm --filter @pi-lnk/pi-runtime test` 全绿（本分支已验证；合并后以 CI 为准）
- [ ] prompt 预算实测：`pnpm prompt:lint`——全组合（含 todoTools）3175/3200，**余量仅 25**（⚠️ 贴线；是否抬 STATIC_BUDGET_CHARS 属 AGENTS.md 红线第 3 条，须人工拍板）
- [ ] 上游风险确认：vendored pi-agent-core 0.85.1 为 harness 完整形态最后版本；upmerge（≥3 minor）时本模块全部落点须重映射（总体设计 §1 坑位 4）

## 部署后（生产取证）
- [x] 真实多步出图任务一次：任务卡片出现、状态随执行推进、完成后清空
  - 证据待补（2026-11-11）：task_list 111 / task_update 656 事件证明卡片出现与状态推进，但「完成后清空」未逐例取证（生产 DB executionEvents 展开，2026-11-10 快照）
  - ✅ 已取证（2026-11-16 第二次快照）：卡片出现与状态推进维持 11-10 证据；「完成后清空」补齐逐例——40 个 ≥2 次提交的 thread 中 6 个以空清单收尾（正例 thread 例：`cmvgffanf…` / `cmvj042s2…` / `cmvopvd0h…` / `cmvqrq0ia…` / `cmvxx5hq8…`）；判读：规范收尾率 15%，多数 thread 因会话终止未走「全部完成→提交空数组」约定，属真实行为信号（候选归因：工具引导/SOP 强化收尾约定），见文末 11-16 取证块
- [ ] 老会话 resume：旧 ⟦plan⟧ 卡片仍渲染；续聊触发 todo_write 后单卡替换不双卡
  - 证据待补（2026-11-11）：未做 resume 专项取证
  - 仍欠（2026-11-16 复查）：全库唯一含 ⟦plan⟧ 的 thread（`cmurf6mvp…`，2 条消息）无后续 todo_write——服务端无逐例样本；该项本质是前端渲染行为，归 A-6 真机走查
- [x] `[legacy-plan-marker]` 日志 = 0（对照窗口：部署时间戳之后的日志，agent.service.ts 派生点）（证据：近 7 天容器日志 grep 计数 0，2026-11-10 快照）
- [x] `[todo_write] dropped-incomplete` 出现率记录为漏发率基线（spec §6.1）（证据：todo_write 调用量基线已录——全量 282 次 / 10 月 89 / 11 月 193，DB 只读副本 executionEvents 展开，2026-11-10 快照；dropped-incomplete 专项日志率未单独统计，见文末取证块）
- [x] 触发一次长会话 compaction：压缩后任务清单块仍在 system prompt（k3s 侧 debug 日志或临时探针）
  - 证据待补（2026-11-11）：无跨压缩逐例生产样本
  - ✅ 已取证（2026-11-16）：pi-runtime 生产会话 `cmwiwqqq500abo3017u4kebh7`（PVC `/data/sessions`，events.jsonl 1622 行）当日发生 **10 次 threshold 触发的 compaction（全部 completed）**；压缩结束后仍有任务活动的 3 次压缩，模型均继续发出形态正确的全量快照（如 07:22:46Z compaction_end 后 07:25:31Z 快照 n=3 / in_progress=1）——清单注入跨压缩存活，逐例成立。样本量 1 会话，存活率统计口径见指标建档
- [ ] fork 一个有清单的会话：新分支的任务清单状态正确（details 快照随 toolResult 分支拷贝）
  - 证据待补（2026-11-11）：无 fork 逐例生产样本
  - 仍欠（2026-11-16 复查）：pi-runtime 全部 session 文件（events.jsonl + meta.json，200 目录）`fork`/`branch`/`branched` **零命中**——生产无 fork 用例，非取证缺口而是用量缺口；等真实用例或 eval 场景覆盖（requiresConfirm/fork 类归 A-6）

## 指标建档（spec §6.1）
- [x] 采用率（多步任务中 todo_write 调用占比）基线落本文件追记
  - 证据待补（2026-11-11）：Nest `/metrics` 无 `pi_runtime_plan_*` 系指标暴露（2026-11-10 快照）；调用量原始数据见文末取证块
  - ✅ 已建档（2026-11-16）：**19.2%**（33 个有 todo_write 的多步生成 thread / 172 个多步生成 thread）。口径：多步生成 thread = ≥2 次 `add_node` 画布操作或 ≥2 次 `run_atomic_gen` 阶段事件的 thread；操作化口径非规格原文口径，后续应固化为指标采集后复核
- [x] 跨压缩存活率（压缩后清单块仍在的会话占比）
  - 证据待补（2026-11-11）：同上，指标未暴露
  - ✅ 已建档（2026-11-16）：**3/3 = 100%**（compaction_end 后仍有任务活动的压缩事件，模型均继续产出正确全量快照）。判读：方向达标（规格目标 100%），但样本 = 单生产会话单日，需随 compaction 用量累积复核（与 B-2 `pi_runtime_task_entry_*` 观察面联动）
- [x] 卡片抖动率（同 content 重复触发 task_list 的频次）
  - 证据待补（2026-11-11）：同上，指标未暴露
  - ✅ 已建档（2026-11-16）：193 个相邻快照 diff 对中——疑似重排撕裂对（新增与删除同现）40 对（**20.7%**）、正常增删 48 对（24.9%）、纯状态翻转 105 对（54.4%）。判读：**未达规格 ≈0 目标**；撕裂对含「模型改写任务文案」与「真重排」两种成因，本口径无法区分，先登记为观测信号，case 级归因后再定收紧手段（不急动匹配键）
- [x] 多 in_progress 率（单次提交 >1 个 in_progress 的占比；>10% 则升服务端硬校验——Codex 是服务端强校验，我们先软后硬，用数据决定）
  - 证据待补（2026-11-11）：同上，指标未暴露
  - ✅ 已建档（2026-11-16）：**4.85%**（13/268 份非空快照）< 10% 阈值——**维持软校验，不升硬校验**（数据驱动决定，符合 spec §5 预设）

## 2026-11-11 生产取证块（统一证据来源）

> 时点快照：2026-11-10 · 生产镜像 `141d5d97`（落后 master 17 提交）。来源：只读 DB 副本，展开 `AgentMessage.metadata.executionEvents`（12,229 条消息 / 1,054 条带事件，覆盖 2026-07-16 → 2026-11-10）。数据与分析全文见规格 `docs/superpowers/specs/2026-11-11-task-planning-engineering-roadmap-design.md` §2.3。

| 信号 | 全量 | 2026-10 | 2026-11 | 判读 |
|---|---|---|---|---|
| `todo_write` 调用 | 282 | 89 | 193 | C1 上线后放量，活跃链路 |
| `ask_user` 调用 | 271 | 108 | 163 | 高活 |
| `propose_plan` 调用 | 42 | 12 | 30 | ≈ todo_write 的 15%，「先方案确认」非主流路径 |
| `spawn_subagent` | **0** | 0 | 0 | 未进入生产运行时（源码在、运行时不在，根因未定位） |
| `task_list` / `task_update` 事件 | 111 / 656 | — | — | task_list 首现 2026-10-09 10:49（与 C1 上线日吻合） |

- 最近一条生产 `task_list` 载荷（原文）：`{"items":[{"id":"plan-4","title":"创建教学脚本大纲节点","status":"done","activeForm":"编写脚本"},{"id":"plan-7",...},{"id":"plan-9",...}]}` —— id 为位置序且跳号，字段全集仅 `content / activeForm / status`。
- 2026-11-11 复核纠偏：上表 spawn_subagent 行判读「未进入生产运行时」有误——取证范围漏了 pi-runtime K3s 独立部署单元；复核生产 pi-runtime（镜像 d9085d33）dist 内 6 文件命中 + `pi_runtime_subagent_*` 三系列 metrics 暴露 ⇒ **已注册进生产运行时**，零调用为用量缺口（prompt-registry/skills 零点名，与 tool_search 激活率 0 同构）。详见路标规格 §2.3 复核纠偏条。
- 可观测性：Nest `/metrics` 返回 200 但无 `pi_runtime_plan_*` / `subagent_*` / `turn_budget_*` 命名指标暴露；`[legacy-plan-marker]` 近 7 天日志 0 次。

## 2026-11-16 生产取证块（第二次快照，交付清单 8 项证据回填）

> 时点快照：2026-11-16 18:08。来源：① Nest DB 只读副本（`docker cp` → sqlite3 mode=ro，13,388 条 AgentMessage / 1,208 条带 executionEvents，覆盖 2026-07-16 → 2026-11-16）；② pi-runtime 生产 pod（`pi-lnk-runtime-5d7b47fc49-bhx6s` @ `55c8ff9f`）PVC `/data/sessions` 200 个 session 目录（events.jsonl + meta.json，只读 grep/node 脚本）。方法与判读全文见本文件上方各条目注记。

| 信号 | 全量 | 2026-10 | 2026-11 | 判读 |
|---|---|---|---|---|
| `todo_write` 快照 | 294 | 89 | 205 | 持续放量；其中非空快照 268 份 |
| 多 in_progress 提交 | 13 | — | — | **4.85% < 10%**，维持软校验 |
| 撕裂对 / 正常增删 / 纯状态翻转 | 40 / 48 / 105（共 193 对） | — | — | 抖动率 20.7%，未达 ≈0，登记观测信号 |
| 采用率（多步生成 thread） | 33/172 = **19.2%** | — | — | 操作化口径，待指标固化后复核 |
| 完成后清空正例 | 6 / 40 thread | — | — | 规范收尾率 15%，行为信号登记 |
| compaction（生产，threshold 触发） | 10 次 completed（单会话单日） | — | — | 压缩后有活动 3 次全部存活（3/3=100%，样本小） |
| fork（生产） | **0** | — | — | 零用例，非取证缺口 |

- 仍欠（如实）：resume 逐例（归 A-6 真机走查）、fork 用例（等真实用量或 eval 覆盖）、抖动率 case 级归因、跨压缩存活率随用量累积复核。
- 数据面备注：Nest DB 的 metadata「compact」/「fork」字样均为自然语言内容（画图素材/新闻文本），非执行事件——跨压缩与 fork 取证必须走 pi-runtime PVC session 文件，与 C-2c spec 记录的数据面结论一致。
