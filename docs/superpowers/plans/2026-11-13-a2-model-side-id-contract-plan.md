# A-2' 实施计划 · todo_write 模型侧 id 契约

> 锚：spec `2026-11-13-a2-model-side-id-contract-design.md`（裁决形态/门禁证据/风险全在 spec，本 plan 只列步骤与验收）。
> 纪律：干净快照工作区（`gh api tarball/master` + 软链 node_modules）；vitest = nvm node24 + `--maxWorkers=1 --no-file-parallelism`；REST 推 PR（blob→tree→commit→ref→PR）；CI 绿停合并前。

## Step 0 · 工作区与预算核验

- [ ] `gh api tarball` 拉 master 快照（新 `/tmp/a2-work/`）+ 软链 node_modules（同 C-1a 流程）。
- [ ] 核验基线：`task-state.test.ts` 13 例 + `todo.test.ts` + `golden-cases.test.ts`（57 例）全绿基线先跑一遍留档。
- [ ] 确认 `task_tool.md` 零改动决策生效：`git diff --name-only` 不得含 prompt-registry/**（风险 1）。

## Step 1 · task-state.reduce（id 优先 + content 兜底）

- [ ] `reduce(prev, next)` 重构：prevById + prevByContent 双索引；item.id 分支优先，缺省走现行 content 兜底；usedIds 保留；structureChanged 判定含「带 id 重命名」；签名 `next: readonly TodoItemInput[]`（`TodoItemInput = TodoItem & {id?: string}`）。
- [ ] dropped-incomplete 告警修正（todo.ts）：按 id 或 content 双通道对账，重命名不误报。
- [ ] 新增测试 ①③④⑤（spec §7）先 RED 后 GREEN（TDD 纪律）；④ 含「带 id 项锁定后另一 content 项正常续用」细化；⑤ 含同调用重复 id 判新项。
- [ ] 回归锁：既有 13 例不动全绿。

## Step 2 · todo.ts schema + execute 硬拒绝

- [ ] todoSchema item 增 `id?`（spec §3.1 措辞）；工具 description 第 4 条改 id 语义；params 类型 `TodoItemInput[]`。
- [ ] execute 前置校验：幻觉/已删除 id ⇒ `AgentToolResult{isError:true}` + 合法 id 清单回执，零副作用（spec §3.3）；校验键 = `storeScopeKey ?? sessionId`（与 overwriteTodos 同键）。
- [ ] 新增测试 ②（硬拒绝）。
- [ ] **护栏**：schema 变更后确认 `details.todo.snapshot/diff` 输出形态不变（eval 资产与前端消费面零破坏）——已有契约镜像测试兜住。

## Step 3 · renderTodoBlock

- [ ] 行格式 `- [x] plan-N content`；新增测试 ⑥。

## Step 4 · 全量验证

- [ ] vitest 全量（pi-runtime 包）绿。
- [ ] 全量 eval L0：`golden-cases.test.ts` 57 例 + eval 集 121/121 绿。
- [ ] `pnpm -w` 构建面核验：只跑受影响包（vue-tsc 纪律：不加 --noEmit）。
- [ ] 变异自检（守卫纪律）：对「id 优先」分支做一次伪变异确认测试 RED（防判据自匹配恒绿）。

## Step 5 · REST 推 PR

- [ ] blob→tree（base_tree 只传改动路径）→commit→ref→PR；推前逐路径裸 blob sha 比对 master；正文回读长度。
- [ ] CI 盯盘；全绿后停合并前等用户授权。

## Step 6 · 合并 + 部署 + 复测（授权后）

- [ ] squash 合并；核验合并树==CI head 树 + compare DELTA=改动路径。
- [ ] **手工 dispatch `runtime-deploy.yml`**（deploy.yml 不含 services/pi-runtime），reviewer API 审批；核 pi-runtime pod 版本前移。
- [ ] 生产复测：真实多轮会话冒烟（重命名场景 id 存活取证）+ §4 两项观测（断裂率对比、硬拒绝自纠成功率）落 C-1c 基线档案。
- [ ] 观测数据落档前勿宣告 ALL_PASS。

## 改动路径清单（预期）

```
services/pi-runtime/src/tools/task-state.ts
services/pi-runtime/src/tools/todo.ts
services/pi-runtime/src/tools/task-state.test.ts
services/pi-runtime/src/tools/todo.test.ts
docs/superpowers/specs/2026-11-13-a2-model-side-id-contract-design.md
docs/superpowers/plans/2026-11-13-a2-model-side-id-contract-plan.md
```
