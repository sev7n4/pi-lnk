# 内置技能可发现性 + 显式调用闭环：实施计划（对应 specs/2026-11-16-builtin-skills-discoverability-design.md）

> 状态：待用户审。审过后按 §0 授权闸门逐段实施。
> 基准：GitHub 真实 master `6e814d32`（本地隔离树 `.worktrees/fix-skills-a9`，从 tarball 重建 + `git init` 基线提交）。
> 分支纪律：新分支 `feat/builtin-skills-discoverability`，从真实 master 起；推 PR 前必核 `compare base...master` 触碰面零交集（A9 未合时须先定排期，见 §5）。

---

## 0. 授权闸门（分步，逐步停下等确认）

| 阶段 | 内容 | 触发部署 | 授权 |
|---|---|---|---|
| P-0 | 本规格 + 本计划入库（docs-only PR） | 否 | 审完文档后 |
| P-1 | A9 判定链修复合入（`cd86653`，server+web） | 是（deploy.yml） | 单独授权 |
| P-2 | 本刀代码实现 + 门禁全绿 + 推 PR | 是（deploy.yml） | 单独授权 |
| P-3 | 合并 + 生产部署 + 行为级冒烟 | 是 | 单独授权 |
| P-4 | G3 golden 重写（另一刀，runtime-deploy） | 是（runtime-deploy.yml） | 单独授权，不在本计划 |

**排期（用户 2026-11-16 23:24 已拍板：乙）**：
- **乙：A9 并入本刀** —— T0（A9 判定链，本地 `cd86653` 已全量验证）与 T1–T6 同一 PR 同刀推。一次部署；共享 `agent-skill-map.ts` / `agentSkillMap.ts` 修改面一并测。
- 甲方案（A9 先行独立 PR）作废，仅在乙 PR 因 compare 触碰面冲突被阻断时作为回退预案重提。

---

## 0.5 上游资产复用清单（硬约束，对应规格 §4.5）

第一原则：**每个任务先声明复用资产，禁止新造等价物。** PR 描述须逐条自证：

| 任务 | 复用资产（吃满上游/既有实现） | 禁止新造 |
|---|---|---|
| T0 A9 | 既有 `resolveInvocationMode` / `mergeAgentSkills` 内扩展，frontmatter 解析复用 `skills-parse` | 新裁决函数 |
| T1 runtime 端点 | `piRuntimeClient.listSkills()` 现成方法；controller 既有 `SkillEnvelope`/`AuthGuard` | 新查询协议、新守卫 |
| T2 pass-through | `resolveDockSkillTarget` 既有映射链上**增第三参**；`knownNames` 已含 `listSkills` 结果（`agent.service.ts:3591-3595` 已求值，零额外调用） | 独立白名单 |
| T3 web API | `unwrapSkillEnvelope` / `SkillApiError` 模式 | 第二套 unwrap |
| T4 合并纯函数 | `mergeAgentSkills` 既有去重/过滤；新函数只做运行时名映射+并入 | 第二套过滤 |
| T5 dockSkills | `loadDockSkills` 既有 fail-soft 结构上改数据源 | 新降级机制 |
| T6 `/` 候选 | `MentionInput` 既有 `@` 触发检测/候选列框/键盘导航，按触发字符分支 | 第二个列框组件 |
| 生效链路 | `resolveForceSkills → lane.skill()` 全链现成 | 改 lane.skill 语义 |

若某改动找不到可复用资产，须先在本 plan 补记「为何必须新造」，否则视为违规刀。

---

## 1. 目标与完成口径

达成规格 §10.1 的 B1–B7 全部通过 + §10.2 的 N1–N5 全部实测转红 + §10.3 门禁（server/web 全量、`vue-tsc -b`、设计令牌、变异）全绿。完成后**只**宣告"内置技能可发现 + 显式调用闭环"达标，不宣告 M1 全绿（P3/G3/G4–G6 未闭合）。

---

## 2. 任务拆分（按顺序，TDD）

### T0 · A9 判定链并入（本地 `cd86653`，已验证）
- 内容：`resolveInvocationMode` 消费 `userInvocable` + `routed` 意图、frontmatter `user-invocable` 识别、web 点选过滤、`invoke` intent 扩展。
- 状态：server 49/49 + web 24/24 + `tsc`/`vue-tsc` 过 + 变异 4/4 RED，随本 PR 一起推。

### T1 · Nest `GET /skills/runtime` 薄转发端点
- 文件：`skills.controller.ts`（+1 端点）、`skills.service.ts`（`listRuntimeSkills()` 转调 `piRuntimeClient.listSkills()`）。
- 判据：B1。返回 `{code:0,data:{skills:[...]}}`，11 项逐名对照 E1；runtime 失败 → `code!==0`。
- TDD：先写集成测试断言 11 项 + 失败分支，红→绿；变异 N1（返回空）转红。
- 守卫：`AuthGuard` 与 `mine` 一致；DTO 无入参（避免 ValidationPipe 剥字段问题）。
- 复用资产：`piRuntimeClient.listSkills()`、既有信封/守卫。

### T2 · server 运行时名 pass-through
- 文件：`agent-skill-map.ts` 的 `resolveDockSkillTarget` 增第 3 参 `runtimeNames?`（规格 §4.3）。
- 判据：B3；与 A9 的 `explicit/routed` 意图裁决不冲突。
- TDD：纯函数测试增"运行时名命中→pass-through"、"三处都不命中→undefined"，红→绿；变异 N3（去掉 pass-through）转红。
- `agent.service.ts` 调用点把 `known` 中运行时名传入（该值在既有代码 `3591-3595` 行已求值，零额外调用）。
- 复用资产：`resolveDockSkillTarget` 既有映射链、`withUserSkillNames` 既有并集。

### T3 · web `skillApi.runtimeList()` + 类型
- 文件：`skill-api.ts` 增 `RuntimeSkill` 类型与 `runtimeList()`，走 `unwrapSkillEnvelope`。
- 判据：支撑 B1/B6。测试 mock 成功/失败信封。
- 复用资产：既有 unwrap/错误类型模式。

### T4 · web `mergeRuntimeSkills()` 纯函数
- 文件：`constants/agentSkillMap.ts` 增纯函数（规格 §8）：运行时名映射为 `AgentSkillDef`、`runtimeSkillId=name`，与 `mine` 合并去重、过滤 `userInvocable=false` / `disableModelInvocation=true` / `enabled=false`，内置兜底。
- 判据：B2/B5/B7。TDD 红→绿；变异 N5（去过滤）、N2（退回硬编码）转红。
- 复用资产：`mergeAgentSkills` 既有去重/过滤（A9 已含 userInvocable）；新函数仅做映射+并入。

### T5 · `AgentSideRail.vue` dockSkills 动态化
- 文件：`AgentSideRail.vue:949-962`，`loadDockSkills()` 改为 `runtimeList()` + `mine()` 并行拉、经 `mergeRuntimeSkills` 合并；失败回退 `AGENT_SKILLS`（B6）。
- 判据：B2/B6。组件测试：列表含 11 项 + 失败兜底。
- 复用资产：既有 `loadDockSkills` fail-soft 结构。

### T6 · composer `/` 触发器 + 候选列表
- 文件：`MentionInput.vue`——复用既有 `@` 的 `detectMention`/候选列框（`mention-candidate-listbox`）/键盘导航，按触发字符分支；新增可选 props（slash 候选）与 `slash-select` 事件。
- 判据：B4。候选源 = 同一 `dockSkills`；选中回写 `activeSkillId`（与 `+` 同一出口，不伪造文本命令）。
- TDD：组件测试 `/` 唤出、候选一致、选中出口、`@` 不受影响；变异 N4（独立硬编码列表）转红。
- 复用资产：`@` mention 全套既有机制；禁止第二个列框组件。

### T7 · 文档登记 + 全序列复测
- `docs/README.md` 登记新规格/计划（master 版 + 仅本方行重建，禁整文件推）。
- 复跑规格 §10 全部 B/N + v2 §10 M1-A1–A11 相关项回归。

---

## 3. 判据 → 任务 → 变异 映射

| 判据 | 任务 | 转红变异 |
|---|---|---|
| B1 `GET /skills/runtime` 11 项 | T1 | N1 |
| B2 `+` 含全部运行时技能 | T4/T5 | N2 |
| B3 点选 → forceSkills → lane.skill | T2 | N3 |
| B4 `/` 同源候选 + 同一出口 | T6 | N4 |
| B5 不可点选过滤 | T4（A9） | N5 |
| B6 fail-soft | T1/T5 | — （失败分支断言） |
| B7 动态性/无硬编码 | T4/T5 + 静态 ratchet | N2/N4 |

---

## 4. 验证命令（隔离树，逐条实跑并留存 stdout）

```bash
export PATH="/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH"
wt=/Users/4seven/workspace/pi-lnk/.worktrees/fix-skills-a9
# server 相关
cd "$wt/apps/server" && env -u NODE_OPTIONS ./node_modules/.bin/vitest run src/skills src/agent/pi-runtime --maxWorkers=1 --no-file-parallelism
env -u NODE_OPTIONS ./node_modules/.bin/tsc --noEmit -p tsconfig.json
# web 相关
cd "$wt/apps/web" && env -u NODE_OPTIONS ./node_modules/.bin/vitest run src/constants/agentSkillMap.test.ts src/services/skill-api.test.ts src/components/agent/AgentSideRail.dynamicSkills.test.ts --maxWorkers=1 --no-file-parallelism
env -u NODE_OPTIONS ./node_modules/.bin/vue-tsc -b
# 全量（合并前）
cd "$wt/apps/server" && env -u NODE_OPTIONS ./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
cd "$wt/apps/web" && env -u NODE_OPTIONS ./node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism
```

生产冒烟（P-3 后）：容器内 8100 `/skills` 11 项；`GET /api/skills/runtime` code:0；点选内置技能的轨迹含 `forceSkills` 与 `lane.skill` chunk。

---

## 5. git / PR 纪律（保命）

- 真实 HEAD 以 `gh api repos/sev7n4/pi-lnk/commits/master` 为准；本地 `origin/master` 常陈旧。
- 推 PR 前 `gh api repos/sev7n4/pi-lnk/compare/<base>...master` 核触碰面零交集；非己改动不覆盖。
- blob 上传必须 `gh api ... -F content=@file`（`-f` 会把路径当内容写坏，#917/#918 教训）。
- tree `base_tree` 只传改动路径；README 用 master 版 + 仅本方行重建（diff 自证 0 删 0 改）。
- PR 正文/回读长度核对；CI 全绿后才合。

---

## 6. 诚实结论（本计划不宣告的部分）

- 本刀达成 ≠ M1 全绿：P3 自定义导入 UI、G3 golden 重写、G4–G6（N 靶点/最近搜索+确认/userModified）仍独立。
- 内置技能的 `user-invocable` / `disable-model-invocation` 控制字段因运行时 `listSkills` 不返回、golden 未重写，本刀**不宣称**已遵守；B5 只覆盖已装技能。G3 是其必要下游，需单独授权。
- G7（同会话即时 → 下一轮新会话）为 v2 §7.2 允许的取舍，不按缺陷处理。
