# propose 确认执行权归一（P0 止血包）实施计划

状态：待评审（2026-10-30）
规格：`docs/superpowers/specs/2026-10-30-propose-confirm-execution-unity-design.md`（§9 文件级清单 = 本计划唯一输入）
分支：`feat/propose-confirm-execution-unity`，**基于最新 origin/master**（先 `git -c http.proxy= -c https.proxy= fetch origin` 或 REST 对齐，本地 master=3f8181d2 落后生产 #635–#638）。
部署：Nest+runtime+web 三层全量——API 镜像流水线 + `runtime-deploy` 手工 dispatch（tag=master 短 SHA）+ web deploy。

## 批次 T0：Nest 执行权（P0-1 / P0-4）

1. （v1.1 裁决：不新增端点）`agent-canvas-tools.service.ts`：
   - `startImageGeneration`/`startVideoGeneration` 入口幂等守卫：`status===generating && generationRecordId` → 直返现有 record（`deduped:true`），不创建第二个 record；
   - `proposeGeneration` summary 追加 `audioKind`（runtime 派发 run-audio 免二次 get-node）；
   - start 系既有参数装配/SSOT 写入（generating+recordId）/studio 分发原样复用。
3. `sessions.service.ts`：`PENDING_CONFIRM_CLIENT_EXITS` → `{pending_confirm, generating}`；注释写明取消走 decline 内部通道。
4. 测试：`sessions.service.test.ts`（draft 覆盖被回写 / pending_confirm、generating 放行）、`agent-canvas-tools.service.test.ts`（首次启动 / 幂等直返 / prompt 缺失 fail-closed）。

验收：Nest 测试全绿；幂等守卫单测 2 例 + 守卫收紧用例全绿。

## 批次 T1：runtime 确认即启动（P0-1，复用既有端点）

1. `canvas-write.ts` propose 分支 `outcome.confirmed` 后、`waitForGenerationTerminal` 前：
   - `client.post("/agent/internal/start-node-generation", {sessionId, userId, nodeId})`；
   - 成功 → 记录返回 recordId，继续既有终态等待（进度 ticker 不动）；
   - 失败 → 返回 fail 信号（`_signal:{status:"failed", retryable:true}`）+ 明说「生成未启动」文案，禁止「生成仍在进行」话术。
2. 轮询臂（SSOT 启发式）保留为画布手动生成兜底，注释标注「P1-2 job 化后删除」。
3. 测试：`canvas-write.test.ts`（answered→start 调用断言 / start 500→fail 文案 / start 幂等直返→照常等终态）。

验收：runtime 测试全绿；golden cases 无回归（`eval/`）。

## 批次 T2：web 锚点换源 + 单执行者收敛（P0-2 / P0-3）

1. `useCanvasActions.ts`：新增 `deriveProposeConfirmAnchor(waitingPart, nodeStatus)` 与 `shouldStartPolling(nodeData, activeRecordId)` 纯函数 + 单测。
2. `stores/agent.ts`：从 timeline part 派生活跃 propose 等待（只读 computed，禁新白名单 ref）。
3. `CanvasPage.vue`：
   - overlay 锚点接 `deriveProposeConfirmAnchor`；
   - `handleAgentGenerateNode`/`handleNodeGenerate`（propose 态）删 `generateForNode` 自起与 patch draft；
   - 生成轮询 watcher（`shouldStartPolling` 门控 → `useGenerationPolling`）。
4. `ProposeConfirmOverlay.vue`：锚点 prop 化；`!isMobileLayout` 门控从组件剥离（移动端入口归磁贴确认条，遵循 MobileSheet 唯一基座纪律）。
5. 移动端磁贴 pending 决策栏：接 `confirmProposeWait` / `cancelProposeForNode` emit 链（实施前回读 mobile-node-lifecycle SSOT §9 项位，规格 §11 风险 4）。
6. `NodePendingPrompt.vue`：门控接 anchor（part ∥ status）。

验收：`vue-tsc -b` 全绿；CanvasPage 确认接线契约测试更新；design-token 四测试（若碰样式）。

## 批次 T3：web 流断归因收口（P0-5）

1. `AgentSideRail.vue` 主流 catch：活跃等待 part（propose/question）存在 → 不 append「生成失败」；置中性「连接已断开，等待状态保持」并依赖 lastEventId 回放。
2. `/answers` 回执处理：`deduped`/404 → 对应 part 翻 confirmed 终态 + 状态对账（不再静默/报错）。
3. 测试：新增 `AgentSideRail` 流断门控行为用例（与 historyFetchNoStore 同规格钉死）+ `agent.pendingQuestion` 回归。

## 批次 T4：验证、合并、部署、生产取证

1. 全量回归分批（≤12 文件/批，`--maxWorkers=1 --no-file-parallelism`）：server / runtime / web 三层 + `vue-tsc -b` + `pnpm prompt:lint`（未改提示词，跑一遍确认 0 漂移）。
2. PR（squash）；CI 三流水线绿后合并；`runtime-deploy` 手工 dispatch（tag=master 短 SHA，feature_grep 断言新端点字面量）。
3. 生产取证：
   - API 镜像 tag 对账 + `/api/health`；
   - runtime healthz version + dist 内 `start-node-generation` 字面量；
   - web chunk 新字面量（anchor/watcher）命中；
   - **真机复测主场景 S1–S7**（用户执行，清单入 PR 描述）；
   - GenerationRecord 30s 判据在生产走查中核对。
4. 合并后收尾：删除分支/worktree；规格状态改「已上线」；`python3 scripts/docs/gen_index.py > scripts/docs/index_data.json && python3 scripts/docs/gen_index_md.py` 再生 INDEX。

## 回滚

- runtime：`PI_RUNTIME_GEN_TERMINAL_WAIT_MS` 极小值 ≈ 恢复旧行为（规格 §5.3 既有开关）。
- Nest：幂等守卫/summary 追加均为加法回滚 = revert 该 commit；守卫收紧回滚 = 恢复白名单含 `draft`。
- web：revert 前端 commits（确认路径回到旧双执行者，功能可用性不劣于现状）。
