# B2 批次实施计划 — 模型平台体系加固（S2-1 / S2-2 / S2-3）

> 上级规格：`docs/superpowers/specs/2026-10-09-model-platform-hardening-design.md`
> 分项规格：`-mph-s21-catalog-as-data-` / `-mph-s22-routing-table-` / `-mph-s23-failure-self-heal-`
> 执行方式：subagent-driven（SDD），5 任务串行；执行日 2026-10-10，BASE `f459d1f9`（含 #329）。
> B1 已上线：availability 语义、探活服务、AdminTokenGuard、健康统计、前端灰显/角标。

## 0. 控制器锚点核实结论（写计划前的实锚，dispatch 时随 brief 下发）

| 锚点 | 现实（f459d1f9 实测） | 对规格的影响 |
|---|---|---|
| `resolveModelKey` | `packages/shared/src/studioModelCatalog.ts:479`，签名 `(modality, key)`；被 server 4 文件 + web 3 文件 + packages/agent 1 文件 import（非测试） | 规格前提成立；**web 端直 import 的是 `apps/web/src/constants/studioModels.ts`**（归一层），web 切换落点在此 |
| 目录 sync 触发 | 无独立 bootstrap 定时器——`ensurePlatformChannel`（provider.service.ts:688）**惰性对齐**（:696 调 `planPlatformChannelSync`）；每次 provider 列表/pull 调用都会走 | 版本触发机制落点 = ensurePlatformChannel 内查 `catalogVersion`，变更即对齐；**不新增定时器**；spec A2 的「≤5s」实测语义=「保存后台下一次 provider 调用即生效」 |
| 路由判定 | `platformCredentials.ts` 的 resolver 返回 `{apiKey, baseUrl}` **真实值**（非 env 名）；`resolveApimartPlatformCredentials` 有 `apimartApiKey \|\| openaiApiKey` 回落 | RouteResult 按 spec 只回 `apiKeyEnvName`；apimart 的 openai 回落语义须在路由表阶段保留（翻译种子时逐条记录） |
| 重试通路 | **无服务端 retry 端点/DTO**——前端 `CanvasPage.vue:4215 retryNodeGeneration` = patch 后 `generateForNode(node)`；`CanvasNodeRetryFn = (nodeId) => void` | spec §3.3 的「服务端 DTO 可选参数」**前提失实**：换模型重试=前端用 `CANVAS_NODE_PATCH_KEY` 页面级 patch 模型字段 + 复用 generateForNode；服务端仅需在生成入口补 availability 校验（防绕过 UI 直发） |
| 诊断落库 | `formatDiagnosticCopy` 在 shared `generationDiagnostics.ts` + web `utils/generationDiagnostic.ts` 两层；退款三字段在 `GenerationRecord.metadata`（B0 已实证 charged/refunded） | spec 前提成立 |
| admin 模块 | `apps/server/src/admin/`（B1 建立）：`AdminTokenGuard`（fail-closed）+ admin.module.ts + 2 个 controller 先例 | 新 controller 挂同一 module，同款守卫 |
| 探活服务 | `upstream-probe.service.ts` onModuleInit 只注册 interval，**无启动首轮**（B1 生产复测确认表空） | 顺手项：注册后立即 `void this.probeOnce('startup')`（非阻塞） |

## 1. 全局约束（bind 所有任务）

1. **单写原则**：DB `ModelCatalogEntry` 是唯一真源；`STUDIO_MODEL_CATALOG` 代码常量降级为种子（只插不改），**本批次不删常量**（删除单独立 PR）。
2. **resolveModelKey 签名不变**；找不到时的确定性 fallback 行为与错误形态保持不变（S0-1 裁定延续：确定性、非静默）。
3. **A1 双实现对拍是 S2-2 的硬门禁**：28 条目录 × 5 上游逐条一致，对拍不绿不得合；`legacyResolveUpstream()` 对拍副本保留在本 PR 内。
4. **RouteResult 只回 `apiKeyEnvName`，绝不回密钥值**（序列化断言无 `sk-`）；密钥仍由 server 端 `readPlatformCredentialEnv` 取。
5. **禁止回落 OpenAI 链**：路由未命中且无 default 行 → 抛确定性错误（把注释级防护升级为类型级）。
6. 探活器是唯一置 `availability:'unavailable'` 的写入方（B1 裁定延续）；B2 所有新写入方不得碰该字段。
7. 新 admin 端点一律 `AdminTokenGuard` + 审计行（who/when/before/after）；写操作 bump 版本号（单调递增，last-write-win）。
8. 重试/换模型不得引入新计费语义（新失败=普通失败，零新逻辑）；退款三字段只透传不重算。
9. SQLite 时间戳一律整数毫秒（禁 strftime）；Prisma 聚合 bigint 经 toNum 归一。
10. ⛔ 不做总体规格 §6 之外的架构发挥；特性开关字段（catalog/routing 的 enabled 或 mode）命名与回滚语义在 T1/T3a 定型后不得漂移。

## 2. 任务分解（5 任务串行）

### Task 1 — S2-1a：目录数据层 + 纯函数（model: default）

- Prisma `ModelCatalogEntry`（字段与现类型逐字同构 + `id/createdAt/updatedAt/deletedAt`）+ 迁移（纯 DDL）。
- shared `resolveModelKeyFromRows(rows, modality, key)` 纯函数：行为与现 `resolveModelKey` 逐 case 一致（把现实现改为薄壳调它）；**A3 = 既有 28 条 fixture 全量回归迁移到 rows 注入形态**。
- server 端包装器：DB 查询（含软删过滤）+ 进程内缓存（5s TTL 或版本号失效，二选一并写明）→ 调纯函数；studio/material/agent 等调用点零改动。
- 种子播种：bootstrap（ensurePlatformChannel 同款惰性时机或模块 init）upsert `STUDIO_MODEL_CATALOG` → 表，幂等（A1）；**种子只插不改**（已有人工/后台改动不被覆盖——按 modelKey 存在即跳过）。
- 验收：A1 播种幂等（两次 bootstrap 行数不变）；A3 纯函数全量回归；既有 `studioModelCatalog.test.ts` 改两层断言（种子常量层 + rows 注入层），**禁删测试**。
- Commit: `feat(b2-s21a): ModelCatalogEntry 表 + resolveModelKeyFromRows 纯函数 + 种子播种`

### Task 2 — S2-1b：运营端点 + 版本触发 + web 来源切换（model: default）

- `apps/server/src/admin/model-catalog.controller.ts`：GET/POST/PUT/DELETE（软删）/api/admin/model-catalog，AdminTokenGuard，写操作写审计 + bump `catalogVersion`（存储于新表或 meta 表，T1 若未建则本任务建）。
- 版本触发：`ensurePlatformChannel` 对齐前查版本，变更即跑 `planPlatformChannelSync` 对齐（含 selectableTextModels/disabledModels 用户快照清理，复用 #306 语义）；A2 集成测试：POST → 下一次 provider 调用镜像含新条目；DELETE → 清理。
- web 目录来源：`apps/web/src/constants/studioModels.ts` 从直 import 常量改为消费服务端下发条目（**优先扩既有 channels/preferences 响应**，不得新增独立轮询通道；下发 payload 含 displayName/modality/params 等渲染所需全字段——镜像条目形状需扩展时走 sync 写入侧）；`resolveModelKey` web 调用点改读下发数据；A4 = UniversalModelSelector 渲染快照逐条一致。
- 竞态：两写并发 → last-write-win + 版本单调递增（单测）。
- 验收：A2/A4/A5（审计含 before/after）+ 竞态单测。
- Commit: `feat(b2-s21b): 目录运营端点 + 版本触发对齐 + web 目录来源切换`

### Task 3 — S2-2a：路由表数据层 + 纯函数 + 对拍（model: default）

- Prisma `UpstreamRoute`（`{id, matchType:'prefix'|'exact'|'regex', pattern, capability, upstream:'agnes_hub'|'apimart'|'stepfun'|'minimax'|'fal', priority, enabled}` + default 行支持）+ 迁移；种子 = 从现 resolver 链逐条翻译（step-*→stepfun；minimax-h3→minimax；h3-max→fal；apimart backed 名单→apimart；兜底 default→agnes_hub），**apimart 的 openai key 回落语义以注释/字段记录**。
- shared `upstreamRouting.ts`：`resolveUpstreamRoute(rows, modelKey, capability): RouteResult | null`；RouteResult=`{upstream, baseUrl?, apiKeyEnvName}`；命中=priority 降序、同级 exact>prefix>regex；未命中→default 行；无 default→**确定性抛错**（A3）；regex 行 ReDoS 防线（pattern 长度上限 + 禁嵌套量词 lint 断言）。
- **A1 对拍**：`legacyResolveUpstream()`（现 resolver 链原样保留）× 新表，28 条目录 × 5 上游 fixture 全量对比，逐条一致。
- 验收：A1/A2/A3/A4（redact 断言无 sk-）。
- Commit: `feat(b2-s22a): UpstreamRoute 表 + 路由解析纯函数 + legacy 对拍`

### Task 4 — S2-2b：resolver 查表化 + 探活接线 + 启动首轮（model: default）

- `provider-resolver.service.ts` if/else 链替换为查表（经 server 侧路由读取器，带进程内缓存 + `routesVersion` 失效）；`resolve*PlatformCredentials` 薄包装签名不变、调用点零改动；缺 key 行为保持 StepFun 既有语义（显式错误含「未配置」，绝不静默回落）——A6 回归断言。
- 探活接线：`upstream-probe.service` 删硬编码映射，改 `resolveUpstreamRoute` 按 enabled 路由分组探活（同名模型只探路由指向那一家——A5 双行 fixture）。
- **顺手项（B1 登记）**：探活 onModuleInit 注册后立即 `void this.probeOnce('startup')`（非阻塞；日志标注 startup 来源）。
- 运营端点：GET/PUT /api/admin/upstream-routes（admin+审计+bump routesVersion；改路由下个探活周期生效，不热重启）。
- 验收：A5/A6 + admin 端点测试（复用 B1 guard 测试形态）；A1 对拍保持绿。
- Commit: `feat(b2-s22b): provider-resolver 查表化 + 探活路由接线 + 启动首轮探活`

### Task 5 — S2-3：退款透明化 + 换模型重试（model: default）

- 退款透明化：`GenerationDiagnostic` 增可选 `chargedPoints?/refundedPoints?/refundReason?`；文本/图片两条落库路径透传 metadata 三字段；抽屉诊断 tab 渲染「已自动退还 N 积分」（refundedPoints>0 时）+ `formatDiagnosticCopy()` 追加 refund 行；缺字段不渲染（A1 组件测试，复用 MediaInspectorDrawer 既有 harness）。
- shared `retryRecommendation.ts`：`recommendRetryModel(...)` 纯函数（排除失败模型自身与 unavailable；successRate 降序、null 排可用组末位；**只推荐同渠道**；无候选→null）——A2 矩阵含「全候选 successRate=null 冷启动」形态；A4=候选排除探活 unavailable。
- 一键换模型重试（**按控制器裁定修正的实现路径**）：前端诊断抽屉失败态渲染「换 {displayName} 重试」按钮（recommendation 非 null；errorCode ∈ {cancelled, invalid_input, upload_required} 不渲染）；点击 = `CANVAS_NODE_PATCH_KEY` 页面级 patch 节点 modelKey（**禁 updateNodeData 直写内部 store**）→ 复用 retryNodeGeneration 通路；`CanvasNodeRetryFn` 扩展可选 overrides 参数（向后兼容）。服务端在生成入口补模型 availability 校验（unavailable → 既有错误语义 + 新 errorCode 映射复用 S0-2）。A3 集成测试改为「生成入口 availability 拒绝 + 合法模型正常出记录」；A5 二次失败独立计费退款。
- 验收：A1/A2/A4/A5（A3/A6 按修正路径执行）。
- Commit: `feat(b2-s23): 退款透明化 + 换模型重试（推荐纯函数 + 前端按钮 + 生成入口校验）`

## 3. Review Focus（最终全分支评审必查）

1. 目录双源漂移：种子只插不改是否成立？后台改 + 种子 upsert 竞态？
2. 路由翻译完整性：A1 对拍 fixture 是否真覆盖 28 条 × 5 上游（含 capability 维度）？apimart openai 回落语义去哪了？
3. web 快照 A4：`resolveModelKey` 异步化后调用点是否有 await 漏改（TS 会抓，但 any 逃逸要查）？
4. 探活启动首轮：非阻塞是否真不阻塞 bootstrap（probeOnce 吞异常）？startup/periodic 来源区分？
5. 换模型重试：patch 键用对没（CANVAS_NODE_PATCH_KEY）？availability 校验绕过面（agent 直调路径）？
6. 审计行：三处 admin 写端点（catalog/route）是否都有 before/after？越权（非 admin token）全 401？

## 4. 执行约定

- 任务顺序 T1→T2→T3a→T3b→T5（T3b 依赖 T3a；T5 与 T3 无文件冲突但保持串行降低 shared 包并发写）。
- 每任务：task-brief 派发 → 实现者报告 → review-package → 独立评审 → （需修复时 resume 修复 + re-review）→ ledger 记录 → 下一任务。
- 测试命令：`pnpm --filter @lnkpi/shared exec vitest run` / `pnpm --filter @lnkpi/server exec vitest run --hookTimeout=120000` / web 侧 `pnpm --filter @lnkpi/web exec vitest run`；已知慢机 flaky（membership.usage.sqlite、selection-binding）超时形态可复跑。
- shared 新增子路径导出须同步三件套（package.json exports + typesVersions + scripts/patch-workspace-packages.cjs）；发版后核 Docker dist（B1 验证项延续）。
