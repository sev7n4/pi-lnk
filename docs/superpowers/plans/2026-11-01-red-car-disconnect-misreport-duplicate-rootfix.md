# 「生成红色小汽车」断线误报 + 双图 根治 实施计划

状态：待评审（2026-11-01）
规格：`docs/superpowers/specs/2026-11-01-red-car-disconnect-misreport-duplicate-rootfix-design.md`（§9 文件级清单 = 本计划唯一输入；§4 三条不变量 = 实施判据）
分支：`feat/red-car-disconnect-misreport-dupgen-rootfix`，**基于最新 origin/master**（先 `git -c http.proxy= -c https.proxy= fetch origin` 或 REST 对齐；本地 master 可能落后生产若干 PR）。
部署：
- P0/P4 首落包 = web(Nest 意图去重属 Nest 层) + Nest 两层全量 —— 不碰 pi-runtime，不触发 `runtime-deploy`。
- P1/P3/P2 跨层包 = API 镜像 + `runtime-deploy`（手工 dispatch tag）+ web 三条流水线。

---

## 批次 T0：旁观流稳定性前置（P0 的地基，必须先做）

> 依据规格 §11 风险 1：P0 依赖旁观流回填尾包，但 `/runs/events` 实测 47ms 断流、15s 心跳未发、`hasKey` 假时返 404（诊断 §3-D3）。不先修，P0 的 `lastEventId` 回填会踩同一坑。

1. `apps/web/src/components/agent/follow-up-tail.ts`：修复 `GET /api/agent/runs/events` 首连断流（实测 47ms），确保常驻订阅存活 + 15s 心跳真实发出；记录 `lastEventId` 游标。
2. `services/pi-runtime/src`：`GET /sessions/:key/events` 在 `manager.hasKey` 为假时返回 404 的语义确认 —— 客户端 `retryOnMissing`（404→退避重试）已接线，需验证退避能覆盖「session 刚建未就绪」窗口；必要时改 `hasKey` 为假时返回 200 空流 + 快照而非 404。
3. 测试：`follow-up-tail` 订阅存活用例（模拟 60s 常驻、断言无早断）、`pi-runtime.client` `retryOnMissing` 退避用例。

验收：旁观流常驻 ≥60s 不丢、心跳可见；`lastEventId` 游标在主流断后能正确续拉。

---

## 批次 T1：P0 web 端 verify-before-fail + 旁观流回填 + UX 翻转

1. `AgentSideRail.vue` `streamConversation` 主流 reader：额外解析 `id:` 帧（当前只解析 `data:`），把最后 seq 存入 `lastMainSeq`（§9 文件清单）。
2. catch@2705 改造：非 Abort 时**不**直接 `markTurnError` + 失败卡，改置「对账中」暂态 → 调 `reconcileLatestAssistant()` + `thread-state`/节点状态查真（§8 `shouldVerifyBeforeFail`）→ 仅当服务端确认无活跃且无已完成才标失败。
3. `streamRecovery.ts`：新增 `deriveObserverFromSeq(lastMainSeq)` 纯函数（有 seq→`lastEventId`，无→`from=now`）。
4. `follow-up-tail.ts`：主流产失后旁观流首连参数由写死 `from=now` 改为 `deriveObserverFromSeq` 结果。
5. `networkFault.ts`：`classifyRequestError` 增加「对账中」中性态（不归网络失败）。
6. UX 翻转：断流后主推「恢复/继续」（reconcile，不重生成），「重试」(re-prompt) 降级为服务端确认真失败后才出现的次选。
7. 测试：`AgentSideRail` 流断对账行为用例（与 `historyFetchNoStore.test.ts` 同规格钉死：主流断 + 服务端 settled → 不弹失败卡、旁观流补 done）、`streamRecovery` 纯函数单测。

验收：`vue-tsc -b` 全绿；S1 主场景（§6.1）复现：断流不误报、3s 内借旁观流节点完成。

---

## 批次 T2：P4 Nest 意图级幂等（双图硬兜底）

> 依据规格 §4.3 / §7 / §9-P4。复用已建 `IdempotencyRecord` 表与唯一索引，只改键维度 + 增加意图去重入口。涉及 schema 变更 → 走 Prisma migrate deploy，**禁用 auto-merge**。

1. `apps/server/src/agent/agent.service.ts`：新增 `normalizeIntent(prompt)`（去空白/转小写/截断 128）+ `pickDedupRecord(threadId, intent, windowMs)`（查同 thread + 同意图 + 近窗 in-progress/completed）。
2. `agent.controller.ts` `streamConversation` 入口：归一化意图后调 `pickDedupRecord`；命中 → 复用既有 `GenerationRecord`/节点（返回既有节点而非新开 operation）；未命中 → 正常建 operation。
3. `IdempotencyRecord` 键构成：从 `ik_{threadId}_{Date.now()}_{随机4位}` 改为 `ik_{threadId}_{intentHash}_{近窗标记}`，唯一索引改为复合（`threadId`+`intentHash`+`windowKey`）。
4. 单测：`normalizeIntent` 同义变体指纹一致、`pickDedupRecord` 命中/未命中/近窗外放行；`streamConversation` 入口去重契约用例（同句 5 连发 → 仅 1 条 completed）。
5. 迁移：`prisma migrate`（加可空 `upstreamTaskId` 列 + 复合唯一索引），`migrate deploy` 禁用 auto-merge。

验收：S2 主场景（§6.2）复现：重发同句 5 次 → `GenerationRecord` 仅 1 条、节点仅 1 个；用户真要「再画一辆」（含「再/第二/另一个」语义）放行。

---

## 批次 T3：P1 收发解耦 + 权威通道（架构期，跨层）

1. `agent.controller.ts`/`agent.service.ts`：`POST /conversation` 语义改为落 user+turnId 即返回，回合事件源切到旁观流 `/runs/events`（带 `lastEventId` + 快照兜底）；主 POST 流降级「首投加速」。
2. `AgentSideRail.vue`：本端回合事件源从「读 POST 响应体」切到旁观流订阅；`turnId` 贯穿发送与订阅（规格 §5.3）。
3. 测试：拔掉主 POST 流仅靠旁观流，回合完整呈现且无重复文本（解决 D1/D3）。

验收：主流缺失下回合不丢、不重复。

---

## 批次 T4：P3 resume 替代 re-prompt（架构期，跨层）

1. `services/pi-runtime/src`：新增 `resume(sessionKey)`（内部 `lane.resume(ctx)`），仅当存在活跃 operation 时重驱动同一 operationId。
2. `agent.controller.ts`：新增 `POST /agent/internal/resume-session` 内部端点透传。
3. `AgentSideRail.vue`：恢复路径 `resume` 优先，仅 `NothingToResume` 才 `prompt`；resume 路径同时回填节点终态（规格 §11 风险 5）。
4. 测试：进行中回合断线恢复 → 不产生新 operationId、不重跑已完成图像生成。

验收：S3 主场景（§6.3）复现。

---

## 批次 T5：P2 durable 会话后端（加固期，runtime）

1. `session-manager.ts`：`sessions: Map` + `sessionTtlMs` → durable 后端（sqlite-node 或轻量 SQLite 持久化 operation 元数据 + transcript tail + 已建节点）；`sessionResumes` 维度扩展 `disk|rebuilt`。
2. 测试：pi-runtime 重启后，进行中/刚完成回合仍可 `resume` 并被客户端对账成功。

验收：重启/TTL 后 P0 对账不失效。

---

## 批次 T6：可观测性补齐 + 验证、合并、部署、生产取证

1. `GenProgress` 补写（该类会话当前为空）；`GenerationRecord.upstreamTaskId` 落库便于 30s 定位。
2. 全量回归分批（≤12 文件/批，`--maxWorkers=1 --no-file-parallelism`）：server/runtime/web 三层 + `vue-tsc -b` + `pnpm prompt:lint`（未改提示词，跑一遍确认 0 漂移）。
3. PR（squash）；CI 绿后合并（改 schema 的 PR 禁 auto-merge）；`runtime-deploy` 仅 P1/P3/P2 包触发。
4. 生产取证（T0+T1+T2 首落包）：
   - API/Nest：`/api/health` + dist 内 `normalizeIntent`/`pickDedupRecord` 字面量命中；
   - web chunk 新字面量（对账暂态/`deriveObserverFromSeq`/`lastEventId`）命中；
   - **真机复测 S1–S3**（用户执行，清单入 PR 描述）；
   - 用会话 `cmvwkh89b00lgp801xu2fjbrr` 同款复现：① 断流不误报 ② 重发同句至多 1 图。
5. 合并后收尾：删分支/worktree；规格状态改「已上线」；`python3 scripts/docs/gen_index.py > scripts/docs/index_data.json && python3 scripts/docs/gen_index_md.py` 再生 INDEX。

## 回滚

- P0（web）：revert 前端 commits（回到旧「断流即失败」行为，功能可用性不劣于现状）；`deriveObserverFromSeq` 纯函数随 revert 移除。
- P4（Nest）：意图去重入口 revert + 唯一索引迁移 revert（`migrate deploy` 回退）；注意索引回退需手工 `prisma migrate` 或 `ALTER`。
- P1/P3/P2（跨层）：runtime 回滚 = 旧内存 session + 无 resume 端点；Nest/web revert 对应 commits。
- 共用开关：P0 对账暂态若引入新回归，加 `VITE_DISABLE_VERIFY_BEFORE_FAIL` 特性开关瞬时回退到旧判错路径。
