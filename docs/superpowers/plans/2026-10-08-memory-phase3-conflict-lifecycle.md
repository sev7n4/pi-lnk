---
规格  | docs/superpowers/specs/2026-10-08-pilnk-memory-product-adoption-scope.md
阶段  | Phase 3（D 召回冲突消解 + F 生命周期/删除/TTL）
基线  | origin/master @ 1cb74ef7（已含 Phase 1 #291 + Phase 2 #293）
分支  | feat/memory-phase3-conflict-lifecycle（独立 worktree，未碰 master）
作者  | WorkBuddy
---

# Phase 3 实施计划：D 召回冲突消解 + F 生命周期/删除/TTL

## 1 目标与范围（spec §5 D/F）
- **D 冲突消解**（P1，验收 G4）：召回结果里同主题多版本时，标出「现行版本」与其余 `superseded:true` 的旧版本——**数据级自曝**（沿用 crossCanvas 传统），不静默丢弃。
- **F 生命周期**（P2，验收 G6）：`delete_memory`（Nest 内部端点 + pi-runtime 工具，归属校验 404 同态）+ 可选 TTL 过期清扫（env `MEMORY_TTL_DAYS`，默认 0=关闭）。
- **非目标**：管理 UI 面板（列 follow-up）；逐行 `expiresAt` 列（需 schema 迁移，见 §2 偏差）；LLM 语义判同主题。

## 2 设计决策与规格偏差（记录在案）
- **主题判据 = `normalizeMemoryContent` 相等**：与 C 写入去重同一字面口径（宁漏勿错，M6b §13.3 拒绝关键词判据同理）。语义级"同主题"不在本阶段。
- **"最新"判据 = `createdAt`**：⚠️ 规格写 `updatedAt`，但 `AgentMemory` 无该列（零 schema 迁移是 Phase 1/2 已锁前提）。已知近似：C 去重的 update 会改 content 但 createdAt 不动，被更新行的"新"体现不出来。补列属 schema 迁移，列 follow-up。
- **权威序（仅 createdAt 平手时）**：`user_explicit > promoted > curated > agent_auto`。spec §8 风险 #4 的结论落实为：**新近性压权威**（旧 user 记忆 vs 新 canvas 记忆 → canvas 新版胜），权威序只做同刻 tiebreak。
- **superseded 行仍返回**（带标记），与 crossCanvas 同哲学：数据自曝、调用方取舍；不静默丢。
- **TTL 零 schema 取舍**：按 createdAt 年龄整批清扫（`MEMORY_TTL_DAYS` env 运行时读），而非逐行 `expiresAt`。`source='promoted'` 豁免（人工确认晋升的全局规则不随 TTL 消失）。curated 摘要若原始被清扫，召回的溯源排除集自然失配（幂等无害）。
- **TTL 触发时机**：`saveMemory` 写入点顺带（fail-soft，与 B 策展自动触发同模式）；cron 周期清扫列 follow-up。TTL=0 时纯 env 读取即返回，零开销。
- **delete 归属校验 = 404 同态**（与 suppressMemory 一致）：不存在与不属于同态，防"存在但不属于你"信息泄露。
- **delete_memory 工具 tier=`destructive`**：M6a 曾刻意不做模型侧删除（memory.ts 头注）；本阶段按 spec F 解禁，用 destructive 档挂 before_tool 审批（B-3）补回"用户确认语义"，并把工具描述限定为「用户明确要求忘记某事实时才用；事实只是变了 → 优先 save_memory 改写」。

## 3 改动文件
- `apps/server/src/agent/agent-memory.service.ts`
  - `AgentMemoryItem` 增 `superseded: boolean`；
  - `searchMemory`：对 matched 全集做同主题聚类（Map<归一化键, 最优行>），返回项按簇标 superseded；
  - 新增 `readMemoryTtlDays()` / `deleteMemory()` / `sweepExpiredMemories(now?)`；
  - `saveMemory` 写入点顺带 TTL 清扫（fail-soft）。
- `apps/server/src/agent/agent-canvas-tools.controller.ts`：`POST agent/internal/memory-delete` + `DeleteMemoryDto`。
- `services/pi-runtime/src/tools/memory.ts`：
  - `MemoryItem` 增 `superseded?`；recall payload 增 `supersededCount` + `supersededNotice`（与 crossCanvas 的 notice 分键，不互斥覆盖）；
  - 新增 `delete_memory` 工具（destructive）；更新 M6a「刻意不做删除」头注为 Phase 3 决策。
- 测试：server（真实内存 store + 忠实 delete/deleteMany，D×3 + F×6）；pi-runtime（delete_memory×4 + superseded 透传×2）。

## 4 验收映射
- **G4（D）**：旧 user 记忆 + 新 canvas 记忆同主题 → 两者都返回，新版 `superseded:false`、旧版 `superseded:true`；无冲突全 false；createdAt 平手按权威序。
- **G6（F）**：删自己 scope 成功（行消失）；跨用户/不存在 → 404；空白 id → 400；TTL 默认关不删行；TTL=7 清扫过期行且 promoted 豁免；saveMemory 触发清扫。
- 回归：既有 server 50 测 + pi-runtime 25 测不退化；tsc --noEmit 0 错。

## 5 风险与开放
- 归一化内容相等作为主题判据会**漏判**近义改写的冲突（如旧「品牌是蓝」vs 新「主色调改为蓝」不互标）——与 C 同款保守取舍，规格 §8 风险 #3 已声明。
- C 去重 update 不刷 createdAt ⇒「被更新的记忆」在 D 眼里不新。影响小（同 scope+session 内 C 已消解重复；跨 scope 冲突多为新增行），补 updatedAt 列时一并解。
- TTL 清扫只在写入点触发：长期无写入的账号过期行暂留（仍可能被召回）。cron 接入与 B 策展调度 hook 同批 follow-up。
- 管理面板 UI（列出/删除/提升）未做，spec §5 F 第三要点列 follow-up。
