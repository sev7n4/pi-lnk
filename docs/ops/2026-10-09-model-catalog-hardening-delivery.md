# 模型多类型配置加固 · P0/P1 交付与生产取证报告

> 完成时间：2026-10-09 ｜ 状态：**已全部合并上线 + 生产取证完成**
> 性质：一次性交付收尾报告（归档，无 active 依赖）
> 覆盖范围：模型选择与配置链路的 P0（正确性）与 P1（运维成本根治）；P2（能力元数据收编）与 P3（YAML 化/网关）经调研**明确不做**

## 一、背景与决策依据

初始诉求是「多链路模型多选的极简配置与运维」，经两轮深挖修正诊断：

- 复杂度不在 `.env`，在于模型清单曾有 **6 份真相**（真 SSOT = `packages/shared/src/studioModelCatalog.ts`，另有 `index.ts` 幽灵清单、`imageEditProfiles` 白名单、`ProviderConfigDialog` 音色硬编码、DB 冻结快照、MiniMax 渠道硬注入）。
- **自动发现只能补「存在性」**：`/v1/models` 全行业只返回 `{id,object,created,owned_by}`，能力面（参数处置/音色/分辨率档位）必须人工策展。正确形态是 sync + curate 双层，不是全自动。
- **不引网关**（上游已是聚合网关 + 直连，再套一层是负资产）；**不做 YAML 化**（pi-runtime 有 CI 守卫禁止 import 外部包、镜像只含 dist，agent 侧与 catalog 隔着 HTTP+DB 两跳，YAML 收益为负）。

## 二、交付结果

| 优先级 | PR | 合并 commit | 内容 |
|---|---|---|---|
| P0-1 | #294 | `72b7d8f3` | 删 `packages/shared/src/index.ts` 幽灵清单（gpt-4o/dall-e-3/sora 等，与 catalog 零重叠但主导航可达）；`getCapabilities()` 改 `listModels(modality)` 派生（补 audio 维度）；`ModelSelector.vue` 降薄适配层走 bootstrap；`useCapabilities` 兜底统一 catalog 派生 |
| P0-2 | #299 | `5a7286be` | 降级信号：`platformGatewayModelId` 返回结构体 `{gatewayModelId, modelKey, modelFallback?, originalModel?}`，四链路经 `platformMetaPatch` **只在真降级时**并入 metadata；前端 `describeModelFallback` 接进 `getRecordFailureMessage`，真降级提示「所选模型「X」当前不可用，已用「Y」生成（按原计划扣费）」 |
| P1 | #306 | `d39c19db` | DB 冻结快照根治：`UserAiPreferences.disabledModels` 新列 + 迁移；`model-catalog-sync.ts` 纯逻辑（`planUserSelectableSyncRow` / `planDisabledModelsOnPreferencesUpdate`）；`ensurePlatformChannel` 复用 `planPlatformChannelSync` 对齐平台渠道；停用记录由 `PUT /provider/preferences` 后端 prev/next diff 推导，**前端零改动**；`syncAdded` 从停用 diff 的 prev 侧排除（防跨部署误停） |

**P1 根因**（master 代码证实）：`ensurePlatformChannel` 对已存在渠道只更新 `baseUrl` 永不动 `models`（provider.service.ts:650-657）；`ensurePreferences` 对已存在用户直接 `return`（:678）；且「用户主动停用」与「模型新上架」在快照里同形（`audio-model-backfill.ts` 头注释已识别）。**StepFun 42 用户人工回填即其后果，#306 后上新模型只改 catalog 即全员生效。**

## 三、生产取证（只读生产库 + 真实 dist 探针）

### P0-2 终审（Node 实跑真 `describeModelFallback`，3332 笔含 originalModel 的 completed 记录）

| 指标 | 数量 |
|---|---|
| 会真的弹出「已换模型」提示 | **54（全部 video，全部真降级）** |
| ├ BYOK 回落（`agnes-video-v2.0` 不可用 → 实投 `seedance-2.0-min`） | 44 |
| └ platform（请求 `seedance-2.0-mini` → 实投 `agnes-video-v2.0`） | 10 |
| 被打标但被 name 闸压制 | 1152（BYOK 假阳性，正确不提示） |
| 「同名不同 id 形态」误报 | **0** |

⇒ **零误报、零漏报**。10 笔 platform 降级根因 = catalog `seedance-2.0-min` vs 历史请求 `seedance-2.0-mini` 拼写不一致（全仓不带 `doubao-` 前缀的 `seedance-2.0-mini` 仅在测试文件，来源为历史数据/agent 传参）。调查过程中「44 笔 BYOK 真降级漏报」的早期判断被真代码实跑**证伪**并取消相应任务。

### P1 上线验证

- server 探针（容器内 import 真实 dist）：**8/8 ALL_PASS**
- 生产库：`disabledModels` 列存在；`_prisma_migrations` applied=1；存量行零 null；容器 healthy
- 部署：CI 3/3（Build API Docker image / Build monorepo / Verify spec figures）；迁移由容器 entrypoint 自动 `prisma migrate deploy`（deploy.yml 无迁移步骤）

## 四、测试与变异验证

| 层 | 结果 |
|---|---|
| #294 | shared 46 文件/391 绿 + capabilities 7 + web 10；变异 3 条全抓红（塞回 gpt-4o / modelKey 重复 / 恢复手写清单）；补 3 条同源断言（原 capabilities 测试对模型清单零断言，改实现时曾假绿） |
| #299 | server 探针 7/7（含 `doubao-seedance-2.0-mini` gateway id 空间命中不误报的硬正例）；master HEAD 全量测试 success |
| #306 | 纯逻辑 12 用例 + provider.service 5 条 P1 用例；provider 全目录 + agent-canvas-tools 210/210 绿；变异 3 条全抓红（去停用判据 / 去 excludeFromPrev / 去平台渠道对齐），还原后 31/31 绿 |

## 五、清理动作

| 项 | 处理 |
|---|---|
| worktree `model-catalog-sync` / `p0-fallback-signal` | 已删除 |
| 本地分支 `fix/model-fallback-signal` / `feat/model-catalog-sync` | 已删除（删除前经特征标识对账确认内容已全进 master） |
| 远程分支 `feat/model-catalog-sync` / `fix/model-fallback-signal` | 已删除（服务器 API 权威核对零残留） |
| 事故：`git add -A` 在主仓 detached HEAD 造出含 71 个垃圾文件的坏提交 `e988499d` | 已核实该提交零源码后 `git reset 8c40ece1` 完全还原；纪律固化：每条命令绝对路径 / `git -C`、禁 `git add -A` |

## 六、遗留与观察项

1. **`seedance-2.0-mini` 拼错 id 的产生源头未消**（历史数据或 agent 侧传参）——#299 后此类请求会「被看见」（正确标记+提示），但源头仍在；待下次命中时从记录反查来源。
2. **`disabledModels` 未暴露到 API**：当前无前端消费需求，不排期。
3. **P1 效果的天然验证点**：下一次向 `STUDIO_MODEL_CATALOG` 加新模型时，观察存量用户 bootstrap 后菜单是否自动出现（无需回填脚本）。
4. P2（能力元数据 7 处散落收编为按 `providerBinding` 查表）为可维护性优化，待有加模型需求时顺路做。
