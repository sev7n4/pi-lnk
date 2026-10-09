# S1-2 模型健康统计与告警 —— 分项规格

状态：待评审（2026-10-09）
上级规格：`2026-10-09-model-platform-hardening-design.md`（批次 B1，服务目标 G4）

## 1. 目标

任何人 1 分钟内回答「哪个模型最近稳/不稳」：提供按 model×channel 聚合的成功率端点，并对失败率突增产生运维可见信号。**不引入 metrics 设施**（apps/server 无 Metrics/Logger 体系的现状维持），全部从 `GenerationRecord` SQL 聚合。

## 2. 现状摘录（真实锚点）

- 表结构（生产实测）：`GenerationRecord(id, userId, type, prompt, model, url, status, metadata JSON, createdAt, nodeId, sessionId)`；status ∈ completed/failed/fallback_pending；model 形态两族——平台裸名（`agnes-2.0-flash`）与 BYOK 前缀（`<userId>::<modelKey>`，JSON 列 `metadata` 里 `originalModel` 同样带前缀）。
- 已知 SQL 坑（MEMORY 备忘，写死进测试）：SQLite `JSON_EXTRACT` 返回**带双引号**字符串⇒`LIKE 'val%'` 恒不匹配，必须 `REPLACE(col,'"','')`；`createdAt` 是毫秒时间戳整数，比较用 `createdAt/1000` 与 `strftime` 混算恒假（用 cast）。
- 退款语义：`metadata.refundedPoints`/`refundReason='platform_failed'`。
- admin 鉴权先例：S1-1 的 `/api/admin/upstream-probe/latest`（AuthGuard admin）。

## 3. 改动设计

1. **聚合纯函数** `packages/shared/src/modelHealth.ts`：
   ```ts
   type ModelHealthRow = { model: string; channelId: string; windowHours: 24;
     total: number; completed: number; failed: number; fallbackPending: number;
     refunded: number; successRate: number | null /* total=0 时 null */ }
   buildHealthSql(windowHours: number): { sql: string }   // 拼参由调用方绑定，防注入
   rowsToHealth(rawRows): ModelHealthRow[]               // 归一 BYOK 前缀：剥离 `userId::` 再分组
   ```
   - BYOK 与平台分开统计：`channelId` 取「`model` 含 `::` → 前缀段（用户渠道）；否则 `platform`」。
2. **端点** `GET /api/admin/model-health?windowHours=24`（AuthGuard admin）：返回 `ModelHealthRow[]` + `generatedAt`；windowHours ∈ {1,6,24,168}，越界 400。
3. **告警规则（纯函数）** `flagHealthAnomalies(rows): Alert[]`：
   - 规则 R1：window 内 total ≥ 5 且 successRate < 0.5 → `degraded`（gemini-3.1-flash 失败6/成0 即命中）；
   - 规则 R2：`total ≥ 5 且 failed 全部 errorCode∈{model_unavailable}` → `ghost_suspect`；
   - 规则 R3：任一上游 402 文案出现 ≥ 1 次 → `upstream_balance`（从 metadata.userMessage 匹配，复用 S0-2 的字面量族）；
   - 告警首版落点：随端点返回 + 结构化日志 `[MPH][health]`（与 S1-1 同口径，推送渠道另立分项）。
4. **调度**：不做定时——复用 S1-1 探活器的周期尾巴顺带算一次（同一个 `@Interval` 服务内两个方法），避免第二个定时器；或由运维 curl 端点（runbook 记录）。

## 4. 验收判据（可断言）

| # | 判据 | 断言方式 |
|---|---|---|
| A1 | SQL 对生产形态 fixture 正确聚合：含 BYOK 前缀行、含 `metadata` JSON 引号形态的 errorCode | 集成测试（内存 SQLite，建真实表结构） |
| A2 | BYOK 剥前缀：`cmrrxageh::deepseek-v4-pro` 与平台 `deepseek-v4` **不合并**（channelId 不同即分行） | 单测 |
| A3 | `gemini-3.1-flash` 失败6/成0（总体规格 §2.4 数据）→ R1 命中 `degraded`；`deepseek-v4` 503 原文记录 → R2 命中 | 单测 |
| A4 | JSON 双引号坑回归：`JSON_EXTRACT(metadata,'$.errorCode')` 形态数据在聚合中正确计数（用 REPLACE 写法的 SQL 断言） | 集成测试 |
| A5 | 端点：无鉴权 401；windowHours=999 → 400；admin → 200 | 集成测试 |
| A6 | 生产复测：curl 端点，输出含今日事故两笔（deepseek-v4 platform 行），30 秒内完成 | curl 记录归档 ops/ |

## 5. 测试要点

- SQL 注入防线：windowHours 只允许白名单值（A5 已锁）；其余无自由拼接。
- fixture 用生产真实行拷贝（脱敏 userId）：含成功/失败/退款三种 metadata 形态。

## 6. 涉及文件

- Create: `packages/shared/src/modelHealth.ts` + test、`apps/server/src/admin/model-health.controller.ts`（或并入 S1-1 的 admin controller）+ 集成测试
- Modify: S1-1 的探活服务（尾巴调用，若采纳 §3.4）
- 只读：`GenerationRecord`（零迁移）

## 7. 依赖与风险

- 依赖 S0-2（errorCode 语义齐了 R2 才有意义）；与 S1-1 无强依赖（可并行，端点独立）。
- 风险=SQL 全表扫描慢：`createdAt` 上已有索引性（时间过滤先行）；窗口白名单限制聚合粒度；数据量再涨时才考虑预聚合表（YAGNI，暂不做）。
