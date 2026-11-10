# 历史失败分窗与「忽略/不再提示」实施计划（2026-11-10）

规格：`docs/superpowers/specs/2026-11-10-historical-failure-scope-design.md`
runbook：`docs/ops/2026-11-10-historical-failure-scope-prod-verify.md`
基线：真实 master `ea509049`（#816 之后）；先回滚 #815 得到干净基线再实现

> 顺序不可反：**回滚 → 干净基线 → 实现 → 端到端复测**。回滚与实现各走一次合并窗口（用户已按「按此建议执行」授权）。

---

## 0. 前置条件（每条都可命令核验）

| # | 条件 | 核验命令 |
| --- | --- | --- |
| P1 | 真实 master HEAD | `gh api repos/sev7n4/pi-lnk/git/ref/heads/master --jq '.object.sha'` |
| P2 | #815 仍在历史中 | `gh api repos/.../compare/1ccb1105...master --jq .status` ⇒ `ahead`/`behind_by=0` |
| P3 | 回滚文件隔离 | `gh api repos/.../compare/eda0308c...master --jq '.files[].filename'` ⇒ 期望 7 个（#815 的 4 + #816 的 3 docs） |
| P4 | worktree 内容 == 真实 master 树 | `git -C <WT> ls-files -s` 与 master tree 逐路径 blob sha 比对（`/tmp/sync_wt.py` 的 `to_write=0`） |
| P5 | 网络仅限 `gh api` | 本机 `git push` 502 / SSH publickey denied ⇒ 全程 REST 推分支 |

---

## 1. Task 0：回滚 PR #815（独立 PR，先合并）

**目标**：把 4 个文件恢复到 #815 父提交 `eda0308c` 的内容，master 回到干净的失败渲染语义。

**步骤**

1. 用 `gh api repos/.../git/trees/eda0308c?recursive=1` 取 4 个目标路径的 blob sha，逐路径 `git/blobs/<sha>` 拉内容。
2. 用 `git/trees` POST（`base_tree = 真实 master`）只传这 4 个路径，生成新 tree；`git/commits` POST parent = 真实 master；`git/refs/heads/revert/layer3-honest-render` PATCH（带 3 次 502 重试）。
3. **推前校验**：逐路径裸 blob sha（`sha1("blob %d\0"+data)`）比对 master，`DELTA` 恰为 4 个路径；`#816` 的 3 份 docs blob 与 master 全等（`MASTER_MOVED_SAFE`）。
4. 开 PR（body 用 `--body-file`，**回读 body 长度**防静默截断），列明：变更动机（前提被生产证伪）、影响面（纯 web + manifest）、验证证据、是否需手工 runtime 流水线（否）。
5. 盯 CI 三必需全绿 → squash 合并 → `Deploy to Tencent Cloud` success → 生产复测（容器镜像 / health / bundle hash 变更）。
6. 合并后**重新同步 worktree 到新 master**（`/tmp/sync_wt.py`，MASTER 换成回滚后的 sha）。

**Review Focus**：`CanvasPage.vue` 是否精确回到 6815 行、manifest `lines` 是否同步回 6815、`generationDiagnostic.ts` 是否彻底移除 `recordHasUsableOutput` / `getRecordResultUrls` / `collectResultUrls` / `HTTP_URL_RE`、8 个 Layer3 用例是否移除、`#816` 文档是否零改动。

**回滚顺序**：本 PR 自身就是回滚；若需再撤，用同一方法把 4 文件换回 `1ccb1105` 版本。

---

## 2. Task 1：`failureScope` 判据与静态文案（纯函数，先 TDD）

**改动**：`apps/web/src/utils/incompleteNode.ts`

五步（每个用例走一遍）：

1. **写失败测试**：`incompleteNode.test.ts` 增 T6/T7/T8 + `isFailureTerminalStatus` 的边界用例（`'failed'`/`'error'`/`'fallback_pending'` ⇒ true；`'generating'`/`'completed'`/`undefined` ⇒ false）。
2. **跑失败**：定向 vitest，确认 RED 且 exit≠0。
3. **最小实现**：导出 `isFailureTerminalStatus`；`nodePlaceholderText(status, generatingText, scope?)` 增失败终态分支（顺序：`incomplete` 优先，见模块头注释）。
4. **跑通过**：`incompleteNode.test.ts` 全绿，既有用例不回归。
5. **commit**（本地分支）。

**变异**：M5（删 historical 分支 ⇒ T6 RED）、M6（失败分支前移到 incomplete 之前 ⇒ T8 RED）、M8（伪变异仍绿）。

---

## 3. Task 2：toast 转移判据（止血，先 TDD）

**改动**：`apps/web/src/composables/useGenerationFailureToast.ts`

1. **写失败测试**：`useGenerationFailureToast.test.ts` 增 T1（`failed→error` ⇒ false）、T2（`generating→error` ⇒ true）、T4（`historical` ⇒ false）、T5（`dismissed` ⇒ false）。
2. **跑失败** ⇒ RED。
3. **最小实现**：`NodeErrorLike` 增 `failureScope?: unknown`；`shouldToastForFailure` 增两条抑制（前序失败终态 / next 非 active scope）。
4. **跑通过** + 既有用例（取消语义、completed→error、快照相等）全绿。
5. **commit**。

**变异**：M1（删前序抑制 ⇒ T1 RED）、M2（删 scope 抑制 ⇒ T4/T5 RED）、M8。

⚠️ 不改动 `onNodeError` 的文案 `${title} 生成失败：${msg}`——本次只治理"何时弹"，不改"弹什么"。

---

## 4. Task 3：加载期对账尊重历史失败（核心，先 TDD）

**改动**：`apps/web/src/pages/CanvasPage.vue`

1. **先复核**：`os.walk` 扫全仓确认 `buildStudioRecordPatch` 只在 `reconcileMissingGenerationRecords` 内被调用（规格 R-1），并把定义处/调用处分开列。
2. **写失败测试**：新增行为级用例 T9（历史失败终态 ⇒ patch 不含 `status:'error'`、不含 `errorMessage`、含 `failureScope:'historical'`）、T10（`dismissed` 不被覆盖）、T11（`completed` 回填不变）。若 `buildStudioRecordPatch` 不便直接测，按 `delivery.md` §判据 1 **从真实源文件抽取片段执行**，禁止复刻逻辑的假绿脚本。
3. **跑失败** ⇒ RED。
4. **最小实现**：在 `buildStudioRecordPatch` 开头加失败终态分支；watch 快照透传 `failureScope`；新增 `dismissNodeFailure(nodeId)`（`patchNodeData` + `saveCanvas`）。
5. **跑通过** + `vue-tsc -b` + 定向回归。

**变异**：M3（仍映射 error ⇒ T9 RED）、M4（覆盖 dismissed ⇒ T10 RED）、M8。

---

## 5. Task 4：UI 忽略按钮与四处透传

**改动**：`NodeTaskCornerActions.vue` + 4 个节点组件 + `NodeRenderer.vue` + CanvasPage 事件接线

1. **写失败测试**：T12（忽略按钮 emit 正确 nodeId / `dismissNodeFailure` 写 `dismissed` 且触发 `saveCanvas`）；`NodeTaskCornerActions` 在 `historical` 时按钮可见、`dismissed`/缺省时不可见。
2. **跑失败** ⇒ RED。
3. **最小实现**：`failureScope` prop + `dismiss` emit；5 个使用方透传；CanvasPage 通过既有节点事件/inject 通道接入（不新造全局总线）。
4. **跑通过** + `design-token.test.ts`（只消费 L2/L3 令牌，禁新增 hex/`rgba(`/`bg-[#`）。
5. **commit**。

**变异**：M7（不 emit / 错 nodeId ⇒ T12 RED）、M8。

**`os.walk` 复核**（`delivery.md` §判据 5）：列出 `failureScope` 的定义处与全部生产调用处，确认 5 个使用方一个不漏；测试文件里的调用不计入。

---

## 6. Task 5：门禁与推 PR

1. `scripts/fixtures/pc-canvas-legacy-manifest.json` 只改 `CanvasPage.vue.lines`（回滚后 6815 → 实现后实测值），**不动** `append_only_prefix_bytes`/`sha256`（V5 只追加契约）。
2. `scripts/verify-pc-canvas-legacy-scope.py` 三条棘轮 ALL_PASS；`pnpm verify-spec-figures`（新文档无图）；`pnpm verify-claims`。
3. 定向 vitest 全绿 + `vue-tsc -b` + `npx tsc --noEmit`（禁 `as never`）+ `pnpm -r build`。
4. `git status --short` 为空（CI 读提交内容，工作区不能脏）。
5. 推前逐路径裸 blob sha 比对真实 master、`MASTER_MOVED_SAFE`；`git/trees` POST 用 `base_tree` 只传改动路径；推后全树核对 `DELTA=改动路径` + parent 正确 + `ALL_PARALLEL_KEPT`。
6. 开 PR（含规格/计划/runbook + `docs/README.md` 登记），回读 body 长度。

---

## 7. Task 6：合并 → 部署 → 端到端生产复测（闭环前置）

1. CI 三必需全绿（下钻 `Build monorepo` 内 `pnpm test` step 的 `Errors` 与 `Exit status`）。
2. squash 合并 → `Deploy to Tencent Cloud` success。
3. **只读生产取证**：容器 health、web dist mtime / 新 chunk hash、`index.html` 引用的 chunk 与实际产物一致。
4. **浏览器带鉴权端到端**（runbook）：复用 `scripts/prod-cdp-smoke.mjs` 的 `mintJwt`（SSH 读容器 `JWT_SECRET` 自签）+ `localStorage.token` 注入 + PC 视口 PREFLIGHT；`LNKPI_SMOKE_WRITE=0` 默认只读。
   - S1 黄条数 = 0；S2 诊断抽屉可见「上游超时，请稍后重试」与退费；S5/S6 点忽略后刷新不复发；S7 成功/生成中节点无回归。
5. **禁止**以「bundle 含代码 + 推断数据」代替渲染取证（上一轮教训）。若 CDP 通道不可用，如实标注未验证项，不宣告闭环。
6. 清理 worktree / 本地分支 / 远程分支；工作日志只追加回填。

---

## 8. Review Focus（评审时逐条问）

1. `buildStudioRecordPatch` 是否真的只在加载期调用？有没有别的写者会绕过降级？
2. `shouldToastForFailure` 两道抑制是否都经变异证明能 RED？是否存在"去掉一道另一道兜住"的恒绿？
3. 5 个 `NodeTaskCornerActions` 使用方是否全部透传 `failure-scope` / `@dismiss`？
4. `dismissed` 是否只改一个字段、不删节点/记录、不改退费？
5. 新增 UI 是否只消费 L2/L3 令牌？`design-token.test.ts` 是否跑过？
6. manifest 是否只改 `lines`？mother spec 的 `append_only_prefix_bytes`/`sha256` 是否零变化？
7. 端到端复测是否**真的**用浏览器打开了目标会话？黄条计数是否为 0？

---

## 9. 回滚顺序（若本刀出问题）

1. 前端行为异常 ⇒ 优先回滚 Task 3/4（节点 data 与 UI），Task 1/2 纯函数可保留（判据更保守，无副作用）。
2. 整刀回滚 ⇒ 用 REST 把本 PR 全部改动路径恢复成回滚后 master（`Task 0` 合并 sha）的 blob，方法同 Task 0；注意 manifest `lines` 一并回退。
3. `failureScope: 'dismissed'` 已写入用户画布是**持久副作用**：回滚前端只会让它不再被消费（显示为缺省 active），不会自动清除；如需清理属生产写，须单独授权 + 备份。

---

## 10. 验收清单（合并前逐项打勾）

- [ ] Task 0 回滚 PR 已合并 + 部署 + 复测，master 干净基线确认
- [ ] T1–T12 全绿，M1–M7 逐条 RED、M8 伪变异仍绿（记录 exit code）
- [ ] `os.walk` 复核 `failureScope` 5 个生产调用方 + `buildStudioRecordPatch` 单一调用方
- [ ] `vue-tsc -b` / `npx tsc --noEmit` / `pnpm -r build` 通过
- [ ] 三条棘轮 ALL_PASS、`design-token.test.ts` 通过、`verify-spec-figures` / `verify-claims` 通过
- [ ] CI 三必需全绿，`Build monorepo` 内测试 step `Errors=0`
- [ ] 生产端到端：黄条 0、静态标记 4、诊断可查、忽略刷新不复发
- [ ] worktree / 分支清理、工作日志只追加回填
