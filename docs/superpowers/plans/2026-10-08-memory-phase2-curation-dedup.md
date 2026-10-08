---
规格  | docs/superpowers/specs/2026-10-08-pilnk-memory-product-adoption-scope.md
阶段  | Phase 2（B 策展蒸馏 + C 写入去重）
基线  | origin/master @ f0399337（已含 Phase 1：A 配额驱逐 + E 召回预算，PR #291）
分支  | feat/memory-phase2-curation-dedup（独立 worktree，未碰 master）
作者  | WorkBuddy
---

# Phase 2 实施计划：B 策展蒸馏 + C 写入去重

## 1 目标与范围（来自规格 §5/§6）
- **C 写入去重**（P1）：`save_memory` 遇同 `(userId, scope, sessionId)` 内**字面重复**内容时**更新**而非新增，消除"小熊 ×13"类重复行（验收 G3）。
- **B 策展蒸馏**（P0）：定期把同会话（canvas）的多条原始记忆合并为 ≤N 条 `source='curated'` 摘要；原始**保留不删**、可回溯；召回优先返回摘要、排除已被策展的原始行（验收 G2）。
- **非目标（本阶段）**：语义级去重、LLM 自动摘要、跨 scope 合并、TTL/删除 UI（属 Phase 3 F）。规则聚类，不用 LLM（规格 §5 B 非目标）。

## 2 设计决策
- **零 schema 迁移**：复用现有 `AgentMemory` 字段。策展摘要=独立行 `source='curated'`，其 `content` 末尾内嵌溯源标记 `--- 策展自 N 条原始记忆 (ids: …) ---`，原始行保留在库（可回溯）；召回时在 JS 侧解析标记、排除被策展的原始行，不靠新列。
- **C 去重键 = 归一化内容**（沿用 `normalizeMemoryContent`）：只做字面去重，不引入语义/关键词指纹——规格 §5 C 非目标明确"不做语义级去重"，且误并成本高于漏并（与 §13.3 一致）。 topic/语义去重列为后续可调优项。
- **B 聚类键 = `sessionId`（仅 canvas）**：最保守的"同主题"近似（一次画布会话=一个场景），避免跨项目误并（规格 §8 风险#2）。user scope 不策展（偏好类不应被合并）。
- **fail-soft 全链路**：去重查询异常→退化为新增（不丢记忆）；策展异常→返回 `{created:0}`（不阻断写入）；自动触发策展异常→吞掉。
- **自动触发**：`saveMemory` 在 canvas scope 且写入后该 scope 原始条数越过 `MEMORY_CONSOLIDATE_THRESHOLD(=50)` 时，自动跑一次 `consolidateMemory`（阈值穿越点触发，频率有界）；亦可由调度/手动调用。

## 3 改动文件
- `apps/server/src/agent/agent-memory.service.ts`
  - 新增常量 `MEMORY_CONSOLIDATE_THRESHOLD=50` / `MEMORY_CURATED_MAX=10` / 溯源标记正则与构造/解析 helper。
  - `saveMemory`：写前 `findDuplicate`（归一化内容查重）→ 命中则 `update` 而非 `create`；复用 count 做阈值触发。
  - 新增 `consolidateMemory({userId, scope})`：仅 canvas；按 sessionId 聚类原始（排除已被策展 id，幂等）；每组 ≥2 条生成 1 条 curated 摘要；封顶 `MEMORY_CURATED_MAX`。
  - `searchMemory`：召回时从 curated 行解析 `consolidatedFrom`，排除被策展的原始行（原始仍在库可回溯），并对返回内容的溯源标记做剥离（对模型透明）。
  - `evictIfOverQuota` 接收已算 count，避免重复查询。
- `apps/server/src/agent/agent-memory.service.test.ts`
  - 新增 `update` mock + 真实内存 store（create 落库、update 改内容、count 真统计），供 Phase 2 用例用。
  - C 用例：13 条同画布字面重复 → 落库 1 行（G3）；去重更新内容（不同原文同归一化→更新不新增）。
  - B 用例：30 条同会话原始 → 策展 1 条 curated、原始 30 仍在库；召回返回 1 条摘要且排除原始（G2）；策展幂等（二次调用不增生）。
- `services/pi-runtime/src/tools/memory.ts`：**不改动**（Phase 2 不改变 recall 返回结构，`truncated` 已透传）。

## 4 验收映射
- G3（C）：单测——连续 13 条同画布字面重复 → 落库 ≤2 行（实测 1 行）；验证 `findDuplicate` 走 update、不 create。
- G2（B）：单测——注入 30 条同会话原始 → `consolidateMemory` 产出 ≤`MEMORY_CURATED_MAX` 条 curated；原始 30 条仍在库（可回溯）；`searchMemory` 返回摘要且排除原始、`truncated` 仍为 false。
- 回归：现有 43 个 server 单测 + 25 个 pi-runtime 单测不退化。

## 5 风险与开放
- 字面去重会漏并"同主题异表述"（如"小熊"×13 但每句措辞不同）。规格 C 非目标已声明不做语义级；如需进一步收敛，下一步加"高 bigram Jaccard(≥0.8) 近似去重"，列为可调优项，不在本 PR。
- 策展摘要为规则拼接（取最新 3 条原文），非 LLM 摘要；语义压缩留 Phase B 备选（规格 §5 B 非目标）。
- 自动触发阈值 50 为经验起点；上线后按真实写入密度调参。
- 调度 hook（cron 周期性策展）不在本 PR，列为部署侧 follow-up。
