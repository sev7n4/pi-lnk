# D-1 创作资产契约 · 复审定稿全量实施计划

- **状态**：待用户审阅（先审产物内容；合并 / 部署 / 生产复测按既有总授权推进）
- **状态（2026-11-17 收尾回填，只追加）**：R0/R1/R2 三刀全闭环——R0 #921 入库、R1 经核对已在 #900/#901 实现（撤销新刀）、R2 #923 合入上线 + 部署 + 生产探针全绿；第一原则已入 AGENTS.md（#926）。详见文末「实施记录回填」。
- **SSOT**：`docs/superpowers/specs/2026-11-15-creative-domain-harness-quality-gates-design.md` 附录 D（第一原则 + 收敛裁决）+ `docs/superpowers/specs/2026-11-15-d1-creative-asset-contract-design.md` 附录 D.1–D.7
- **触发**：#916 入库的三份规格被 #919「恢复 master 到 #915 代码树」回退（当前 master `bcbe771b` 三份 404）；用户 2026-11-16 拍板「先复审定稿 + 排全量计划 + 一次性实施」，并把「吃满上游、不重复造轮子」定为第一原则。
- **取证基准**：master `bcbe771b`（#919 后），#900/#901 D-1 代码刀已合入；生产 K3s `d5c262cd` / Nest 代码树随 #919 恢复。
- **实施形态**：R0 docs-only；R1/R2 走 SDD（每任务 fresh implementer + reviewer + 变异自检）或 native 逐任务，二者共用本计划的 Task 分解与 Review Focus。

---

## Global Constraints（每条任务隐含遵守）

1. **第一原则（最高优先级）**：任何判据 / 工具 / 字段，先做等价物检索（`grep -E` + 已知词反向对照，禁 BRE `\|`），能接线就不新建；禁造无人写入的字段、禁把 `prompt` / 模型自报数字当判据证据。
2. **零新增**：不新增 Prisma model / 列 / migration、不新增 LLM 工具、不新增事件类型、不 patch vendor。R1 只改判定器入参装配与纯函数内部；R2 只复用既有传播引擎。
3. **单一真相源**：三条 oracle 纯函数（`judgeIdClosure` / `judgeAuthorityRef` / `judgeDurationBudget`）与 C-1 eval golden cases 共用同一实现，不在 eval / 生产各写一份。
4. **零副作用硬拒链**：不满足走 `rejectionResult()` → `after_tool` patch `isError:true`，不抛错、不改 vendor（复审规格 §5.3）。
5. **kill switch + 指标随判据自带**：`PI_RUNTIME_ACCEPTANCE` 开关 + `pi_runtime_acceptance_*` 计数；生产 acceptance 零声明（C.8 #4）⇒ R1 前先有 D-0 声明率观测（归 C-2c，只读，不阻塞 R1 实施）。
6. **判据先贴真实记录求值**：按数据形态分支的判定，先在真实生产记录上求值 + 变异自检（#815 / 复审规格 §8.2-6）；判 RED 用完整 stdout 标记，禁 `| tail` 吃退出码。
7. **只追加纪律**：三份规格正文 / 附录 A–C 历史快照不改，本轮追加内容均在附录 D；入库 PR 不改历史时点数字。
8. **合并树核验**：REST 推 PR 前逐路径比对 master blob；合并后逐路径 KEPT + parent 核验（#912/#916/#919 教训）。

---

## Review Focus（spec 暗示但最易咬人的失败模式）

- **F-1 把"重锚"做成"造字段"**：R1 最易退化为新加 `assetId` / `authority` / `duration` 列 —— 一旦出现 migration 即违反第一原则，reviewer 直接打回。
- **F-2 快照端点与 oracle 双写真相**：`getAssetContractSnapshot` 已在组装 `registeredIds` / `authority` / `durationRows`（`:3440` 区块），oracle 必须消费**同一批**数据，不得在 `todo.ts` 里另起一套解析。
- **F-3 duration 入参 vs 模型自报**：`durationBudget` 只能取 `studio.generateVideo` 的 `duration` 入参 / `pricing.quote` 时点（`:653/:2179/:3019`）；任何从画布文本 `render-canvas-view.ts` 自报数字取值即违反 #815。
- **F-4 客户端 PATCH 绕过 ratchet**：R2 的 web `patchNodeData` 若只改前端 state 不触发 server `applyStalePropagation`，人工编辑闭环不成立；须走 `CANVAS_NODE_PATCH_KEY` 同一落库通路。
- **F-5 空证据 vacuous pass**：D.6 已裁决根因是数据面非语义 —— R1 不得再改空证据 pass 语义，保持现状，待真实数据出现后按 #815 校准。

---

## R0 · 三份规格定稿重新入库（docs-only，先做）

### Task R0-1：定稿内容落库
- 在干净 master `bcbe771b` 树上放三份定稿文档：
  - 复审规格 + 附录 D（第一原则 D.1 / 入库状态 D.2 / 收敛裁决 D.3 / 诚实边界 D.4）
  - D-1 spec + 附录 D.7（等价物检索表 / 三刀范围 / 作废方案清单）
  - D-1 plan（原 7 任务计划，正文不动）
- `docs/README.md` 三行登记（基于当前 master 版，只插入不改行）
- 从仓库根重跑 `python3 scripts/docs/gen_index.py > scripts/docs/index_data.json && python3 scripts/docs/gen_index_md.py`（禁手改 INDEX.md）

**门禁**：`verify-spec-figures` ×2（已绿）+ `verify-claims` 7/7（已绿）+ `verify-links` + CI 三 check。

**Review Focus**：#917/#918 blob 事故（`-f content=@file` 不展开 @）——blob 上传一律 base64 JSON + `--input`；推前逐路径比对 master blob；合并树核验。

**交付**：docs PR（squash）→ 合并树 == CI head 树 → 三份文档 master 200。

---

## R1 · 三条 oracle 重锚到既有锚点（SDD/native 代码刀）

### Task R1-1：`judgeIdClosure` 入参重锚
- **落点**：`services/pi-runtime/src/tools/todo.ts:268-276` + `services/pi-runtime/src/tools/acceptance.ts` 的 `AssetContractPredicates`
- **改法**：判定器入参从"新 assetId 列"改为消费快照端点的 `registeredIds`（`agent-canvas-tools.service.ts:23/:38` 已从节点 `data.assetId` / 显式登记聚合），复用 `rejectUnknownIds()`（`todo.ts:111`）的孤儿引用 / 一名多实体硬拒形态
- **判据**：负例 fixture = 孤儿引用 + 一名多实体各 1 条；正例 = 已登记 ID 引用；变异自检（条件恒 falsy）判 RED
- **等价物锚点**：节点 id 生成 `:84-88`、`refOrder`/`localRefs`（`canvas-write.ts`/`session-manager.ts`）

### Task R1-2：`judgeAuthorityRef` 入参重锚
- **落点**：`todo.ts:277-279`
- **改法**：消费快照端点 `authorities`（`:55-56` 从 Material.metadata.authority 按维度聚合），判定"每维度恰一权威 + 已验收 + 版本钉住"，复用 `SidebarAttachment.role` / `parentVersionId` 既有链
- **判据**：负例 = 同维度多重权威 / 未验收母版；正例 = 单权威钉版；变异自检 RED

### Task R1-3：`judgeDurationBudget` 入参重锚
- **落点**：`todo.ts:280-282` + 快照端点 `durationRows` 组装（`:66-77`）
- **改法**：`durationRows` 改由 `studio.generateVideo` 真实入参 `duration`（`studio.service.ts:653/:3019`）与 `pricing.quote` 同拍（`:2179`）派生；台词字数只从显式结构化字段取，**禁从 prompt 派生**（D.5 裁决）
- **判据**：负例 = 字数 > 时长×4.5；正例 = 预算内；模型自报数字 fixture 必须被拒；变异自检 RED
- **诚实边界**：存量会话（无 duration 入参留痕）仍 fail-closed 诚实拒绝，不造数补齐

### Task R1-4：接线收口 + 全量门禁
- `verifyAcceptance()`（`todo.ts:164`）挂载三条重锚后的 oracle，保持 `reject > fail_open > pass` 聚合（复审规格 §8.2-2）
- golden cases（`eval/golden-cases.ts:98-102`）同步更新谓词语义，eval 与生产共用同一真相源
- 门禁：`pnpm -r build` → `pnpm test:runtime`（当前基线 2058 + R1 新增）→ `verify-tool-tiering` / `verify-tool-contract` / `verify-claims` → 变异自检 RED → 合并树核验

---

## R2 · 客户端 PATCH stale 传播（F2，SDD/native 代码刀）

### Task R2-1：web PATCH 触发服务端 ratchet
- **落点**：`apps/web/src/composables/useSelectedNodeEditor.ts:58` `patchNodeData` + `apps/web/src/composables/canvasNodeActions.ts:13` `CANVAS_NODE_PATCH_KEY` 唯一合法写通路
- **改法**：人工编辑（PATCH）落库后走既有 `applyStalePropagation`（`agent-canvas-tools.service.ts`），与 agent 写路径同一 ratchet；不新建传播引擎（D.7 裁决）
- **判据**：负例 = 改上游节点后下游未标 stale；正例 = 下游正确 stale；前端 state 与 server 快照一致
- **门禁**：web 单测 → server 集成测试 → build → 合并树核验

---

## 执行顺序与阶段门

| 阶段 | 任务 | 门 | 授权 |
|---|---|---|---|
| ① R0 入库 | R0-1 | 本地 4 门禁 + CI 三 check + 合并树核验 | docs-only 总授权 |
| ② R1 oracle | R1-1 → R1-2 → R1-3 → R1-4 | 全量门禁 + 变异 RED | 合并-部署-生产复测总授权 |
| ③ R2 stale | R2-1 | web/server 门禁 + 变证 | 同上 |
| ④ 生产复测 | 三 oracle 真实记录求值 + acceptance 声明率 + stale 传播 | 行为级实证（核 build_info 双部署单元） | 同上 |

**不启动**（前置未达 / 属其他线）：D-0 观测基线（归 C-2c，四 gate 未达不拍阈值）、D-2 感知监控（human gold set + 429 解封）、F3 空证据语义改写（根因は数据面）、429 墙（用户侧实名）、A-6 真机走查（本环境不可代跑）。

---

## 诚实边界

- 三 oracle 在 R1 重锚 + 生产复测前不宣告生效；存量 fail-closed 保持。
- 生产 `acceptance` 零声明（C.8 #4）⇒ 即使 R1 完成，声明率未起前门仍零触发；不因此虚报闭环。
- 429 墙 / A-6 / 交付清单证据 / spawned 复核等既有欠账不受本计划影响，不宣告 ALL_PASS。

---

## 实施记录回填（2026-11-16 19:5x，只追加）

> 按「判据先贴真实记录求值」，R1 在实施前逐文件核对 master `ce5cd887` 代码，发现**R1 已在 #900/#901 完成**，无需新刀；R2 缺口真实存在并已实施。

### R0 · 完成
- 基于新基底 `bcbe771b` 重建四份定稿文档（复审规格附录 D / D-1 spec 附录 D.7 / D-1 plan / 本计划），README 插入 4 行登记、索引重跑 565 份。
- 四门禁绿（spec-figures ×2 / claims 7/7 / links 0）→ PR **#921** CI 三绿 → squash 合并 `ce5cd887` → 合并树 == CI head 树 `e2419a16`、7/7 blob KEPT、parent=`bcbe771b`。

### R1 · 已在 #900/#901 实现（撤销本计划的 R1 实施任务）
代码实证（master `ce5cd887`）：
- `services/pi-runtime/src/tools/todo.ts:254-282`：`assetOracle.inspect()` 已挂载，三判定器 `judgeIdClosure`/`judgeAuthorityRef`/`judgeDurationBudget` 全部接线。
- `services/pi-runtime/src/tools/asset-oracle.ts`：三纯函数定义完整（单一真相源，golden cases 共用）。
- `apps/server/src/agent/agent-canvas-tools.service.ts:3440-3523` 快照端点已把 `registeredIds`（节点 `data.assetId`）/ `referencedIds`（`pinnedAssetId`+`derivedFrom`）/ `authorities`（Material.metadata.authority+status+pinnedVersion）/ `durationRows`（`Shot.durationMs`）全部装配到**既有锚点**——与 D.7 收敛裁决逐字一致。
- `dialogueChars` 无结构化源：快照端点注释 `:3435-3436` 明确「不造数」，`judgeDurationBudget` 对缺 dialogueChars 走 `missing` ⇒ 诚实 fail-closed（符合第一原则）。
⇒ **R1 无新增代码刀**。本计划 R1-1～R1-4 任务作废，改列为「已实现」核对结论。

### R2 · 已实施（本轮唯一代码刀）
- 缺口实证：`apps/server/src/sessions/sessions.service.ts:patchCanvas`（人工编辑侧车 PATCH）`$transaction` 内 `applyCanvasActions` → 写回，**未调用 `applyStalePropagation`**；而 agent 写路径 persist/commitStage 有。`CLIENT_FORBIDDEN_NODE_DATA_KEYS`（`sessions-canvas-patch.ts:26-27`）只禁客户端回灌 stale 字段，不等于服务端会计算——二者不矛盾（计算 ≠ 回灌）。
- 实现（吃满上游、单一真相源）：把 `computeNodeContentHash` / `changedNodeIdsFromOps` / `propagateStale` 提取到 `packages/shared/src/canvas/lineage.server.ts`（复用既有 `computeContentHash` / `downstreamClosure` / `shouldPropagate`）；agent-canvas 私有 `applyStalePropagation` 与 sessions.service.patchCanvas 共用同一纯函数，零重复实现、零字段/migration。
- 测试：shared lineage 单测 11/11（新增 propagateStale 3 例）+ server patch 集成 14/14（新增 R2 2 例）+ agent lineage 回归 6/6；变异 2/2 RED（下游 `stale:true→false` / patchCanvas 接线切除）。

### 部署与生产复测 · 完成（2026-11-16 深夜，只追加）
- PR **#923** squash 合并 `de30e8f8`（合并树 `d2e35aca` == CI head 树、6/6 blob KEPT、parent 核验过）；Deploy run 43865523998 success。
- 生产行为级探针（canary JWT + 既有用户，只读取证 + 探针节点清理）：canary 会话画布 A→B→C 链 PATCH 改 A 后 BFS 传递闭包 B/C `stale=true`、A `contentHash` 变更且 `version=2`（add_node 建档 v1 + update v2，与 agent 写路径同口径）、重复 PATCH 幂等（contentHash 不再变化）、探针节点已清理。
- 结论：客户端 PATCH 写路径与 agent 写路径共用同一 ratchet（R2 判据全过），人工编辑 stale 闭环在生产成立。

### 收尾结论（2026-11-17，只追加）
- 三刀全闭环：R0 完成（#921）；R1 经逐文件核对已在 #900/#901 实现（本计划 R1-1～R1-4 撤销，改判「已实现」）；R2 完成（#923 + 部署 + 生产探针全绿）。
- 第一原则「吃满上游、不重复造轮子」已入 `AGENTS.md`（#926 合 `9cc0e1c5`），此后规格与实施计划强制携带该原则与等价物检索结论。
- 诚实边界维持：三 oracle 生产声明率仍为零（fail-closed 属诚实拒绝，非缺陷）；D-0 声明率观测归 C-2c，真实声明数据出现前不宣告 oracle 生效；本计划不宣告 ALL_PASS。
