# 实施计划：决策面收归对话页

> 规格：[2026-11-22-conversation-only-decision-surface-design.md](../specs/2026-11-22-conversation-only-decision-surface-design.md)
> 分支：`feat/remove-canvas-propose-actions-20261122`（worktree，基于 origin/master 004ffa2d）
> 第一原则：见规格 §1（零新增判据/字段/通道；唯一新增是 `go-chat` emit 的接线）

---

## 刀次

### 刀 0：规格（本刀）
- [x] 规格落盘，含第一原则等价物检索表 + 自动闸门规格交叉条款
- [ ] 历史规格状态回填（放到最后一刀，避免中途污染主线文档）

### 刀 1：PC overlay 退场（TDD，先红后绿）
1. **先写红**：在 `ProposeConfirmOverlay.test.ts` 加「三动作按钮不应存在」断言 → 跑单文件确认 RED。
2. 删 `CanvasPage.vue` 的 overlay import + template 块；删 `handleProposeConfirmEdit` / `handleProposeConfirmCancel`。
3. 删 `ProposeConfirmOverlay.vue` / `ProposeConfirmOverlay.test.ts`。
4. 改 `NodePendingPrompt.vue:11` 注释、`stores/agent.ts:787`、`executionTraceReducer.ts:21`、`AgentSideRail.vue:783,4008` 注释。
5. 跑 `CanvasPage` 相关测试 + `vue-tsc -b` 确认无悬空引用 → GREEN。
6. 单刀提交：`fix(web): 移除画布节点确认胶囊，决策收归对话时间线（PC）`

### 刀 2：移动状态带改造（TDD，先红后绿）
1. **先写红**：`MobileNodeStatusBar.test.ts` 加「拒绝/确认不存在 + 去对话处理 emit go-chat」断言；`MobileCanvasShell.nodeActions.test.ts` 改窗态断言 → RED。
2. `MobileNodeStatusBar.vue`：删两钮 + 两 emit；加 `go-chat` emit + 按钮（复用状态带样式，44px 触控，L2/L3 令牌）。
3. `MobileCanvasShell.vue`：改接线、删两 prop、改注释。
4. `CanvasPage.vue`：删两行 `:on-node-pending-*` 接线（保留 `handleAgentGenerateNode`）。
5. 跑状态带/壳层测试 + `design-token.test.ts` → GREEN。
6. 单刀提交：`fix(mobile): 状态带移除确认/拒绝，改为去对话处理跳转`

### 刀 3：历史规格状态回填（docs）
- `docs/adr/0011-propose-confirm-single-surface.md`、`2026-10-19-propose-confirm-single-surface-design.md`、`2026-10-30-propose-confirm-execution-unity-design.md`、`2026-11-02-propose-card-ux-optimization-design.md` 各追加一条状态注（不删原文、不改章节名）。
- 未跟踪的 `2026-11-22-generation-auto-approve-gate-design.md`：按规格 §3.3 回写 §4.2 / §5 触点（注意该文件是别的窗口的未跟踪文件——**从 origin/master 取，不碰主仓工作区副本**；若 master 无此文件则本刀不动它，只在 PR 正文标注冲突留给其作者）。
- 提交：`docs(specs): 决策面收归对话页——四份历史规格状态回填`

### 刀 4：验证 + PR + 合并 + 部署复测
- 全量相关 vitest（nvm node24 + `--maxWorkers=1 --no-file-parallelism`）、`vue-tsc -b`、`pnpm verify-claims`（若改了规范章节名）。
- push → PR → CI 全绿 → squash 合并（不加 `--delete-branch`）。
- 部署：只改 `apps/web` ⇒ push 自动分流 web-only；**若手工 dispatch 必带 `deploy_web_only=true`**。判据=产物 chunk 含新标记。
- 生产 CDP：PC 先点 `.agent-fab` 展开；移动单会话 `setDeviceMetricsOverride`+reload 触摸仿真。走查状态带跳转与对话卡三动作。

---

## 测试纪律（本机）
- `pnpm --filter @lnkpi/web exec vitest run <file> --maxWorkers=1 --no-file-parallelism`（nvm node24；`env -u NODE_OPTIONS`）。
- 变异不 RED 先疑伪变异；判 RED 用完整 stdout（不要 `| tail` 吃退出码）。
- 静态守卫禁止在注释里写受看守 token 字面量（CI 棘轮按裸计数匹配整文件）。
- worktree 依赖借用：`apps/web/node_modules/@lnkpi/{shared,agent}` 必须指向**本 worktree** 的 packages（相对软链），否则测到主仓旧代码。
