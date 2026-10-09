# S1-3 Dock 模型选择器健康角标与灰显 —— 分项规格

状态：待评审（2026-10-09）
上级规格：`2026-10-09-model-platform-hardening-design.md`（批次 B1，服务目标 G1/G4 的用户可见层）

## 1. 目标

Dock/设置页的模型条目呈现两类状态：**探活灰显**（上游无渠道，不可点）与**健康角标**（近 24h 成功率），让用户在下单之前就知道谁可用。

## 2. 现状摘录（真实锚点）

- 消费链：后端把 `ProviderChannel.models` / `UserAiPreferences.selectable*Models` 经现有 channels/preferences 接口下发；前端消费组件（grep 实锚）：`apps/web/src/components/canvas/UniversalModelSelector.vue`、`ProviderConfigDialog.vue`、`apps/web/src/components/agent/AgentSideRail.vue`。
- 现状条目无任何可用性/健康语义：镜像条目 `{name, capability}`（S1-1 后追加 `availability`），健康数据当前无端点（S1-2 交付）。
- 端点契约（依赖）：S1-1 `GET /api/admin/upstream-probe/latest`（运维面，不进前端）；**前端消费的是 channels/preferences 下发时顺带的条目级 `availability`** + S1-2 的健康端点（admin-only ⇒ 前端**不得**直连，需经现有用户鉴权的只读投影端点或在 channels 响应内嵌健康摘要）。

## 3. 改动设计

1. **数据下发（服务端，先于前端）**：channels/preferences 既有响应中，平台渠道条目加 `availability`（S1-1 已写入 DB，透传即可）；新增**用户鉴权**只读端点 `GET /api/model-health/summary?windowHours=24`（复用 S1-2 聚合，但按当前 userId 过滤 BYOK 行、只回平台行 + 该用户 BYOK 行，删除 admin 语义），响应缓存 5 分钟（服务端内存 Map 即可）。
2. **前端灰显（可用性）**：`UniversalModelSelector.vue` 条目 `availability==='unavailable'` → 置灰 + 「暂不可用」角标 + `disabled`（不可点）；`unknown` → 正常展示（缺省兼容）。
3. **前端角标（健康）**：successRate 非 null 时条目尾缀小圆点：`<0.5` 红、`<0.9` 黄、`≥0.9` 或 null 不显示（避免新模型零流量被标红）；hover title「近24h 成功率 x/x」。AgentSideRail 同规则。
4. **文案**：灰显角标文案「暂不可用」（与 S0-2 的报错文案族一致，都指向「平台暂未开通」语义）。
5. **ProviderConfigDialog**：平台渠道模型清单同规则灰显（只读清单里也标注，让用户在设置页就能看到断供）。

## 4. 验收判据（可断言）

| # | 判据 | 断言方式 |
|---|---|---|
| A1 | availability 透传：channels 响应平台条目含 availability 字段，旧数据缺省 unknown | 服务端集成测试 |
| A2 | health summary 端点：用户鉴权 401/200；BYOK 行只含本人；admin 语义不泄露 | 集成测试 |
| A3 | 灰显：`availability='unavailable'` 条目渲染 disabled+角标；`unknown`/缺失字段照常可选 | `UniversalModelSelector.test.ts` 追加 |
| A4 | 角标阈值：0.4→红、0.7→黄、0.95→无、null/total=0→无 | 单测（组件级） |
| A5 | 回归：幽灵模型（S0-1 已下架）不再出现在任何条目来源；若上游临时断供 agnes-2.0-flash（探活 3 连败），Dock 灰显 agnes-2.0-flash | 组件测试 + 端到端手工复测记录 |
| A6 | 性能：health summary 缓存生效——同一窗口二次请求不重算 SQL | 服务端单测（计数器） |

## 5. 测试要点

- 组件测试沿用 `UniversalModelSelector.test.ts` 既有 harness；fixture 条目覆盖三态 availability × 四档 successRate 的矩阵抽行。
- 端到端复测（runbook）：生产对某个测试条目人为置 unavailable（SQL），确认 Dock 灰显，随后恢复——**必须用测试渠道条目，禁止对生产真实模型做破坏性置灰**。

## 6. 涉及文件

- Modify: `apps/web/src/components/canvas/UniversalModelSelector.vue` + test、`ProviderConfigDialog.vue` + test、`AgentSideRail.vue`、channels/preferences 下发处（服务端）
- Create: `apps/server/src/admin/model-health-summary.controller.ts`（或并入 S1-2 admin controller 的用户版）+ 集成测试
- 依赖端点：S1-1（availability 落库）、S1-2（聚合函数复用）

## 7. 依赖与风险

- 依赖：S1-1、S1-2 先合（数据+聚合就绪），本分项纯消费。
- 风险=探活误判导致用户看到正常模型灰显（S1-1 已用 3 连败防抖）；二次缓解=灰显条目 hover 显示「最近探活时间」，运维可解释；回滚=前端开关一键回到无状态渲染（availability 透传字段保留，前端不渲染即可）。
