# 平台模型体系加固 B1 批次 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** B1 闭环三件套——定时探活对账器（S1-1）、模型健康统计与告警（S1-2）、Dock 健康角标与灰显（S1-3），把「可选集 ⊆ 探活通过集」变成系统不变量。

**Architecture:** S1-1 落数据（prisma `UpstreamProbeRun` + `ProviderChannel.models` 条目级 `availability`）与探活服务；S1-2 从 `GenerationRecord` SQL 聚合健康并产出告警信号（纯函数+admin 端点）；S1-3 纯消费（用户鉴权投影端点 + 前端三组件灰显/角标）。探活器是唯一置 `unavailable` 的写入方。

**Tech Stack:** TypeScript · NestJS · Prisma/SQLite · Vitest · Vue 3

**Spec:** `docs/superpowers/specs/2026-10-09-mph-s11/s12/s13-*-design.md`（冲突以本计划裁定为准）

---

## Global Constraints

- **工作分支**：`feat/model-platform-hardening-b1`（worktree `pi-lnk-wt-b1`，勿向本地 master 提交）
- **Node runtime**：`/Users/4seven/.workbuddy/binaries/node/versions/22.22.2-6/bin/node`
- **依赖安装**：worktree 的 node_modules 已用 `cp -a` 从主工作区复制完成，**禁止跑 `pnpm install`**
- **测试命令**：`pnpm --filter @lnkpi/shared exec vitest run`、`pnpm --filter @lnkpi/server exec vitest run`（worktree 根）
- **Controller Ruling A（探活×健康交叉验证，源自 B0 探针实跑发现）**：`minimax-speech-2.8-hd` 在 MiniMax `/models` 未列出但生产成功 5 次 ⇒ **/models 清单 ≠ 全量可用**。置 `unavailable` 必须同时满足：①连续失败 ≥3 次 **且** ②该模型近 24h **零成功记录**（`recentSuccesses=0`，从 GenerationRecord SQL 计数）。任一不满足只记日志不灰显。总体规格 §3.1 不变量相应理解为「可选集 ⊆ 探活通过集 ∪ 健康背书集」（S1-1 规格修订已随本计划提交）。
- **Controller Ruling B（admin 鉴权）**：仓库无 admin 角色概念（`role` 字段属 AgentMessage）。运维端点鉴权 = 新建 `AdminTokenGuard`：`Authorization: Bearer ${LNKPI_ADMIN_TOKEN}`；env 未设置时恒 401（端点视为禁用）。不引入用户角色体系（S2 再议）。
- **Controller Ruling C（调度形态）**：沿用 reaper 的**手动 `setInterval` + env 派生毫秒**模式（`generation-reaper.service.ts:149-165`），不用 `@Interval` 装饰器（规格写的 @Interval 与仓库现实不符）。
- **env 覆盖类测试必须取低于默认值**（默认 360 分钟，测试设 1；interval=0 禁用）——防假绿铁律
- **探活只读**：只 GET `/v1/models`，任何情况下不发生成请求；密钥只进 Authorization header，不落盘不打印
- **探活器 try/catch 全包裹**，绝不抛错阻塞启动（reaper 同款纪律）；回滚 = env 置 0
- **availability 写入纪律**：`ensurePlatformChannel` 播种与 `model-catalog-sync` bootstrap 对齐写入时 availability 一律 `unknown`（或保留既有值），**探活器是唯一置 `unavailable`/恢复置回的写入方**
- **prisma 迁移**：新增 `UpstreamProbeRun` 走标准 prisma migrate（生产由容器 entrypoint 自动 `migrate deploy`）；测试用内存 SQLite 建真实表结构或按 server 既有测试基建
- **fixture 纪律**：SQL 坑写死进测试——SQLite `JSON_EXTRACT` 返回带双引号字符串（`REPLACE(col,'"','')`）；`createdAt` 毫秒时间戳比较用 cast，禁 `createdAt/1000` 与 `strftime` 混算
- **⛔ 不做**：推送渠道（邮件/IM）· 上架任何新模型 · 目录数据化/路由表（S2 范围）· `@Interval` 装饰器
- **生产 fixture 脱敏**：BYOK 行 userId 前缀用测试假 id，不拷真实用户 id

## Review Focus

1. **灰显误杀健康模型**：`minimax-speech-2.8-hd` 形态（/models 无但 24h 有成功）必须不灰显——Ruling A 的交叉验证是本批次最重要行为。→ Task 1/2
2. **availability 写入方竞态**：探活器与 bootstrap sync 并发写 `models` JSON 列，后写覆盖前写（丢 availability 或丢灰显）。→ Task 1/2（读-改-写必须重读最新值）
3. **SQL 双引号坑回归**：`JSON_EXTRACT` 聚合在真实形态数据上计数正确。→ Task 3
4. **用户数据越权**：health summary 按 userId 过滤，BYOK 行只回本人；admin 语义不泄露给普通用户端点。→ Task 4
5. **前端新模型零流量**：total=0 / successRate=null 不显示角标（避免新模型被标红）。→ Task 4

---

## File Structure

| 文件 | 责任 | Task |
|---|---|---|
| `apps/server/prisma/schema.prisma` + migration | `UpstreamProbeRun` 表 | 1 |
| `apps/server/src/provider/provider.service.ts` | 播种/写入时 availability=unknown 语义 | 1 |
| `apps/server/src/provider/model-catalog-sync.ts` | 对齐写入保留 availability 语义（逻辑不动，只传入保留） | 1 |
| `apps/server/src/provider/upstream-probe-logic.ts` | 纯函数：availability 写入计划 + 连败计数 + 交叉验证 | 1 |
| `apps/server/src/provider/upstream-probe.service.ts` | 定时探活 + 落库 + 结构化日志 | 2 |
| `apps/server/src/auth/admin-token.guard.ts` | AdminTokenGuard（Ruling B） | 2 |
| `apps/server/src/admin/upstream-probe.controller.ts` | `GET /api/admin/upstream-probe/latest` | 2 |
| `packages/shared/src/modelHealth.ts` | 聚合 SQL 构造 + 归一 + 告警纯函数 | 3 |
| `apps/server/src/admin/model-health.controller.ts` | `GET /api/admin/model-health` | 3 |
| `apps/server/src/canvas/model-health-summary.controller.ts`（或按现有模块归属） | 用户鉴权只读投影 `GET /api/model-health/summary` + 5min 缓存 | 4 |
| `apps/web/src/components/canvas/UniversalModelSelector.vue` + test | 灰显 + 健康角标 | 4 |
| `apps/web/src/components/**/ProviderConfigDialog.vue`、`AgentSideRail.vue` | 同规则 | 4 |

---

## Task 1: S1-1 数据模型 + 写入方语义 + 纯函数

- [ ] 1.1 prisma schema 新增 `UpstreamProbeRun {id String @id @default(cuid()), ranAt DateTime, upstream String, httpStatus Int?, modelCount Int?, ghosts String?（JSON 数组）, missing String?（JSON 数组）, error String?}`，生成迁移；确认迁移 SQL 干净（SQLite）
- [ ] 1.2 `provider.service.ts`（`ensurePlatformChannel` 播种）与 `model-catalog-sync.ts`（bootstrap 对齐）写入 models 时条目统一带 `availability: 'unknown'`；sync 的「保留既有条目」路径保留原 availability 值（不重置已灰显条目）；**不改 sync 的 diff 算法本体**
- [ ] 1.3 新建 `upstream-probe-logic.ts` 纯函数（零 IO）：
  - `planAvailabilityWrites(prevModels, diffByUpstream, {consecutiveFailures, recentSuccesses})` → 写入计划数组；置 unavailable 条件 = 失败≥3 **且** recentSuccesses=0（Ruling A）；恢复条件 = 探活通过且当前 unavailable → available；抖动（失败<3 或有健康背书）→ 不变+标记 `logged`
  - `bumpConsecutiveFailures(prev, ok)` → 连败计数器纯函数
- [ ] 1.4 单测：A1（三态转换矩阵）、A5 兼容（旧 `[{name,capability}]` 条目读为 unknown 并可升级写入）、Ruling A 两例（连败 3 + 有成功 → 不灰显；连败 3 + 零成功 → 灰显）、恢复路径 A4
- [ ] 1.5 shared+server 测试全绿；提交 `feat(b1-s11a): UpstreamProbeRun 表 + availability 写入语义 + 探活计划纯函数`

## Task 2: S1-1 探活服务 + admin 端点

- [ ] 2.1 新建 `AdminTokenGuard`（Ruling B：Bearer LNKPI_ADMIN_TOKEN，env 缺省恒 401）+ 单测
- [ ] 2.2 新建 `upstream-probe.service.ts`：手动 `setInterval`（Ruling C）读 `LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES`（默认 360，0=禁用不注册 timer）；单次 `probeOnce()` = 对 5 上游 GET /v1/models（fetch 注入式替身；apimart 走容器 HTTPS_PROXY 的行为沿用 S0-3 脚本结论）→ `diffCatalogAgainstUpstream()`（复用 shared，禁第二套）→ 交叉验证查 GenerationRecord 近 24h 成功计数 → `planAvailabilityWrites` → 读-改-写镜像（先重读最新 models 再写入，防竞态）→ `UpstreamProbeRun` 落库 → 变化时 `console.log('[MPH][probe] ...')` 结构化日志；全程 try/catch
- [ ] 2.3 集成测试：A2（env=0 不注册 timer；env=1 分钟生效，fake timers）、A3（连败 2 不变 / 第 3 次且零成功 → unavailable + run 落库）、A4 恢复、上游 402 → unavailable(reason) 不产生 ghost
- [ ] 2.4 新建 `upstream-probe.controller.ts`：`GET /api/admin/upstream-probe/latest`（AdminTokenGuard）返回最近 run + `ranAt`；无 run 时 200 + `{runs: []}` 语义（或 404，二选一并写进 openapi 注释）；A6 集成测试（无 token 401、对 token 200）
- [ ] 2.5 server 测试全绿；提交 `feat(b1-s11b): 定时探活对账服务 + admin 端点`

## Task 3: S1-2 健康统计 + 告警

- [ ] 3.1 新建 `packages/shared/src/modelHealth.ts`：`buildHealthSql(windowHours)`（时间过滤先行、errorCode 用 REPLACE 写法）、`rowsToHealth()`（BYOK `<userId>::<model>` 剥前缀、channelId=前缀段；平台行 channelId='platform'）、`flagHealthAnomalies()`（R1 total≥5 且成功率<0.5→degraded；R2 全部失败 errorCode∈model_unavailable→ghost_suspect；R3 402 文案≥1→upstream_balance，复用 S0-2 字面量族）
- [ ] 3.2 shared 单测：A2（BYOK 与平台同名模型不合并）、A3（gemini-3.1-flash 失败6/成0 → degraded；deepseek-v4 503 原文记录 → ghost_suspect）、successRate=null（total=0）
- [ ] 3.3 新建 `model-health.controller.ts`：`GET /api/admin/model-health?windowHours=24`（AdminTokenGuard；windowHours ∈ {1,6,24,168} 白名单，越界 400）；响应 `{generatedAt, rows, alerts}`；A5 集成测试
- [ ] 3.4 集成测试（内存 SQLite 真实表结构）：A1/A4（JSON 双引号坑 + BYOK 前缀 + 退款计数，fixture 三种 metadata 形态，脱敏）
- [ ] 3.5 测试全绿；提交 `feat(b1-s12): 模型健康统计聚合 + 告警规则 + admin 端点`

## Task 4: S1-3 用户投影端点 + 前端灰显/角标

- [ ] 4.1 服务端：新建用户鉴权只读端点 `GET /api/model-health/summary?windowHours=24`（普通 AuthGuard，非 admin）：复用 S1-2 聚合，返回平台全部行 + 当前用户 BYOK 行（按 userId 过滤，绝不回他人 BYOK 行）；服务端内存 Map 缓存 5 分钟（A6：二次请求不重算 SQL，计数器断言）；channels 下发处平台条目透传 `availability`（A1 集成测试：旧数据缺省 unknown）
- [ ] 4.2 前端灰显：`UniversalModelSelector.vue` 条目 `availability==='unavailable'` → disabled + 「暂不可用」角标 + hover「最近探活时间」（若响应携带）；`unknown`/缺失照常可选；`ProviderConfigDialog.vue`、`AgentSideRail.vue` 同规则
- [ ] 4.3 前端角标：successRate 非 null 尾缀圆点 `<0.5` 红 / `<0.9` 黄 / `≥0.9` 或 null 或 total=0 无；hover「近24h 成功率 x/x」；阈值判定抽纯函数（组件内或 shared）便于 A4 单测（0.4→红、0.7→黄、0.95→无、null→无）
- [ ] 4.4 组件测试（沿用 `UniversalModelSelector.test.ts` harness）：A3 三态 × A4 阈值矩阵抽行；A2 集成测试（401/200、BYOK 只含本人、admin 语义不泄露）
- [ ] 4.5 测试全绿（shared+server+web）；提交 `feat(b1-s13): 用户健康投影端点 + Dock 灰显与健康角标`

---

## 验收（批次出口）

| # | 判据 |
|---|---|
| V1 | shared + server + web 测试全绿 |
| V2 | 合并部署后：等首个探活周期或手动触发，`UpstreamProbeRun` 有记录；`curl /api/admin/upstream-probe/latest`（带 LNKPI_ADMIN_TOKEN）返回最近 run；`curl /api/admin/model-health` 输出含事故两笔；Dock 对 unavailable 条目灰显（A7/A6/A6 复测，controller 负责） |
| V3 | runbook 增补：探活端点与健康端点的巡检命令（并入既有 upstream-probe runbook） |
