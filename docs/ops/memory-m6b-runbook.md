# 记忆治理操作手册（M6a/M6b）：抑制止血 + 晋升候选 → PR

> spec: `docs/superpowers/specs/2026-10-06-memory-promotion-m6b-design.md`（判据继承 2026-10-04 spec §13.3）
> 面向对象：发现「模型被某条记忆反复带偏」或「某条记忆该升成全局规则」的人。

## 0. 两个通道，先分清

| 现象 | 该用的通道 | 见效速度 |
|---|---|---|
| 某条记忆**有害**（把模型带偏），想让它消失 | **抑制**（本手册 §2） | 下一轮注入即生效 |
| 某条记忆**反复出现且值得全局化**（行为纠正类） | **晋升**（本手册 §3） | 走 PR，合并部署后 |

多数污染记忆该「删（抑制）」而不是「升」——§13.3 依据三：让错误记忆继续注入 = 持续伤害。

## 1. 前置认知（避免误判读数）

- 抑制表是**进程内态**（Nest 与 pi-runtime 各一张，不落库）：**重启即失效**，需重新观察再决定。这是刻意设计（抑制是临时止血，判据会随提示词/模型升级变化）。
- 两侧表**不自动同步**：Nest 端点标记时会 fail-soft 转发 pi-runtime；转发失败只影响 `recall_memory` 通道，注入通道（主污染路径）不受影响。
- 指标 `pi_runtime_memory_suppressed_total`（`/metrics`，NodePort 30909）：**恒 0 = 标记链路未触发**，不是「没有污染」。

## 2. 抑制止血（人工确认后执行）

前提：拿到污染记忆的 `memoryId`（从 `recall_memory` 工具结果、或 DB `agent_memories` 表查）。

```bash
# 用该记忆所属用户的 JWT（端点做了归属校验：只能标自己的记忆）
curl -X POST https://<host>/api/agent/memory/suppressions \
  -H "Authorization: Bearer <JWT>" \
  -H "content-type: application/json" \
  -d '{"memoryId":"<memoryId>","reason":"反复把跨画布项目设定当当前画布观察"}'
# 期望：{"code":0,"message":"ok","data":{"forwarded":true}}
#   forwarded:false = pi-runtime 转发失败（Nest 注入通道仍已生效），可接受；重启后两侧都失效。
```

- 幂等：重复调用无副作用。
- `memoryId` 不存在或不属于当前账号 → 404（存在性与归属同态，不泄露区分信息）。
- 跨用户的抑制（用户没有 JWT / 需要代标）：直接查 DB 确认 id 后，用有归属的账号操作，或等待 M6b 后续的 ops 通道。**不要**绕过归属校验直接改库。

## 3. 晋升：从候选到 PR（人工流程，无一键）

### 3.1 看候选队列

```bash
curl "https://<host>/api/agent/memory/promotion-candidates?limit=20" \
  -H "Authorization: Bearer <JWT>"
```

响应是本人 scope='canvas' 记忆中，**同画布内归一化字面重复 ≥3 次**的条目（按 count 降序）。字段：`count / memoryIds / sampleContents / firstSeenAt / lastSeenAt / sessionId / truncated`。

⚠️ 队列只出事实、不做分级——§13.3 的三级判断必须人读内容：

| 内容类型 | 处置 |
|---|---|
| 用户偏好（"喜欢暖色调"） | **不晋升**（本就该按用户个性化） |
| 项目事实（"主角叫林晚"） | 人工确认后晋升 → 写进 `user` 档相关规则 |
| 行为纠正（"连线时未检查两端点"） | 人工确认后晋升 → 写进 `core` 组规则（LEARNINGS 真身） |

### 3.2 落地（改规则 = 同步 6 处 + 门禁）

1. 编辑 `prompt-registry/rules/<id>.md`（正文按分级落位）。
2. 同步 6 处（清单见 AGENTS.md「变更影响面矩阵」）：MANIFEST contentHash/version → loader `COMPOSED_IDS` → `FALLBACK_BY_ID` → `renderStaticFallback()` 拼装 → 测试 `EXPECTED`。
3. 🔴 **先看预算**：L6 硬线 3200，当前 3194 / **余量 6**。加字前必须等量删字或人工抬线（红线第 3 条）。
4. `pnpm prompt:lint` 必须绿（L0–L11）。
5. 开 PR（分支纪律：开发 → 提交 → PR → CI → squash → 部署 → 生产验证）。

### 3.3 晋升后的审计

晋升落库的新记忆行 `source='promoted'`（schema 已预留）；候选聚合**排除**该来源，晋升后的内容不会复活成新候选。写记忆时把 source 置为 `promoted` 属于后续工具支持，当前人工在 DB 侧留痕即可。

## 4. 排障速查

| 症状 | 先查 |
|---|---|
| POST suppressions 返回 200 但注入还带该记忆 | Nest 侧是否真的标记成功（同账号？）；**api 容器是否重启过**（表是进程内的） |
| `forwarded:false` | pi-runtime 是否可达/维护态（`PI_RUNTIME_MODE`）；不代表 Nest 侧失败 |
| 指标恒 0 | 标记链路从未触发（预期态，见 §1）；不是无污染 |
| 队列 `truncated:true` | canvas 行 ≥5000，扫描窗口截断——先抑制已确认的污染源再复核 |
