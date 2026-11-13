# C-1a 实施计划（plan）

> 上位 spec：`2026-11-13-c1a-seed-eval-implementation-design.md` · 日期 2026-11-13 · 改动全部落在 `services/pi-runtime/src/eval/`

## Step 1 · 建 C-1a 专用工作区（干净 master 快照）

1. `gh api repos/sev7n4/pi-lnk/tarball/e957d6d8` 解包到 `/tmp/c1a-work/`（真 master 源码，纪律：不信本地陈旧分支）；
2. 软链主仓 `node_modules`（pnpm 结构需按 `node_modules/.pnpm` 相对性验证，失效则 `env -u NODE_OPTIONS pnpm install --offline` 于快照内）；
3. 确认 `node --version` 走 nvm v24。

## Step 2 · golden-cases.ts 接口与判定扩展

1. `origin` 联合类型增 `"production"`（注释注明 about 必含 13 位时间戳出处）；
2. `GoldenCase` 增可选 `expectTodoSnapshot?: { minItems?; maxItems?; requireDistinctContent?; firstStepPredicate?: "collect"|"clarify"|"any" }`（与 C-1 spec §8.3 字段名逐字一致）；
3. 新增纯函数 `pickLatestPlanSnapshot(toolCalls)`：最后一条 `todo_write`/`propose_plan` 的 input，`items = todos ?? steps`，`content = content ?? summary`；
4. `evaluateCase` 增快照判定块（spec §4 判定序，失败信息报「期望 vs 实际」）；
5. `GOLDEN_CASES` 改为 `[...既有基线, ...CANVAS_DECOMPOSITION_CASES]`（import 自新文件）。

## Step 3 · canvas-decomposition-cases.ts（新文件）

9 条种子按 spec §3 逐字落（id/origin/about 含出处/expectTools/forbidTools/expectTodoSnapshot/requiresCanvasNodes）；文件头注释写明：来源纪律、双计口径、负例三豁免规避。

## Step 4 · golden-cases.test.ts L0 扩展

1. 修订「origin 不得为 synthetic」⇒「synthetic 必须在 about 带理由 + production 必须带 13 位出处」；
2. 新增 expectTodoSnapshot 资产合法性（min≤max/枚举/不悬空/负例必含双禁）；
3. 「可判定判据」检查补 `expectTodoSnapshot` 计入；
4. evaluateCase 快照判定语义单测 7 例（spec §5.4 清单）。

## Step 5 · 本机验证

1. `npx tsx --test` 或仓库既有 node:test 跑法跑 `golden-cases.test.ts`（确认仓库 test script；node24）；
2. 全量 eval 目录测试绿；`vue-tsc`/tsc 不涉及（未触前端）；确认 dist 构建输入不含 eval（读 `services/pi-runtime/package.json` build 脚本 + tsconfig include）——闭环 C-1 §6 遗留核对项，结论写进 PR 描述。

## Step 6 · REST 推 PR（停合并前）

blob（逐路径 sha 比对 master）→ tree（base_tree 只传改动路径）→ commit（parent=e957d6d8）→ 分支 `eval/c1a-seed-decomposition` → PR（正文回读长度）→ compare 核验 DELTA → 盯 CI → **全绿后停，等合并授权**。

## Step 7 · C-1a 收尾（PR 外，人工跑批）

部署形态 pi-runtime 上跑种子集一轮（C-1 spec §5.3 环境纪律：真实 userId/canvasSessionId、先订阅就绪、requiresCanvasNodes 预检）→ 报告落 `docs/ops/`（失败归因三分类）→ 阈值校准结论回填本 spec §3 表。
