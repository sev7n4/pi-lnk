# 定价扣费接管（主体价）与控制台收敛 — 立项设计

> 2026-11-15 · 状态：待评审
> 背景：v-final2-123837 已发布 active（450 条目，109 主体价就绪）。生产取证发现：
> 实际扣费（studio）与前端展示报价均不传 subjectKey，引擎落 **legacy matchKey 行（旧价）**——
> 视频全家族售价低于成本 6~11 倍；cogvideox-flash（官方免费）仍扣 30 积分；
> audio:design 无 legacy 行 → gen-preview 报价 degraded、扣费被归并为 voice。

## 0. 决策：A 扣费走主体价（已拍板）

**B（重刷 legacy 行）在数据模型上不可行**：legacy 视频行的键维度是
`video:<family>:<res>:<dur>` —— agnes-video-2.5-flash 与 cogvideox-flash 同属
family `default`，物理上共用一行。同一行无法同时表达「agnes-video 每秒 0.572 元成本」
和「cogvideox 免费」，更无法承载「每模型自持利润」（定价中心的核心需求）。
**A 是唯一能承载按模型成本+按模型利润的形态**，且基础设施已全部在位：

| 已就绪设施 | 位置 |
|---|---|
| 六级解析（灰度→主体→模型默认→legacy） | `pricing.service.ts quote()` |
| 主体价行（109 条，成本×利润快照） | active 表 `subjectEntries` |
| 杀开关（跳过主体级，进程级回滚） | `PRICING_SUBJECT_KEYS=off`（quote 内逐次读 env） |
| 命中率观测 | `pricing_resolution_total{level=global_subject|exact|fallback}` |

## P1 — 扣费走主体价（引擎单点收口）

**核心改动：把「主体解析」收进 `pricing.quote` 内部，调用方零改动。**

现状 `resolveSubjectKey(q)` 要求调用方传 `spec/provider/upstream`（缺任一返回
undefined → 跳过主体级）。改为：未传时服务端自解析——

1. 按 capability 推导 spec（复用既有规范化函数，零映射漂移）：
   - video：`canonicalVideoResolution(resolution)` + duration → `"<res>:<dur>s"`
   - audio：`audioKind`（voice / design / music）
   - image：`canonicalImageResolution(resolution)`
   - image_edit / image_variant：现无逐模型主体（spec="*"）→ 维持 legacy 行
2. 以 `channel=platform + modelKey + spec` 查 PricingSubject（唯一命中）取
   provider/upstream → 拼 subjectKey → 查 active 表 `subjectEntries`。
3. 无主体 / 命中失败 → **回落 legacy 行（现状行为不变）**，绝不猜价。
4. 文本：`quoteTextTokens` 已按模型反比率行结算，不动。

**连带修复（studio audio 分支）**：现状把 design 归并为 voice 再报价
（"与 legacy 计价分支逐字同果"）——接管后 design 有自己的主体行，该归并
必须解除，改为传真实 audioKind。

**验收**：
- 全模态对照金标准：subject-first 价 vs legacy 价逐条 diff 清单进 PR 描述；
- 单测：agnes-video 768p:10s → 630 分、cogvideox-flash → 0 分、
  gen-preview design → 0.95 分/百字符口径、无主体模型回落 legacy 不变；
- 变异自检：拆掉 subject 自解析分支 → 对照测试 RED；
- 生产复测：quote 探针 6 模态 + 一笔真实生成扣分对账。

**⚠️ 商业确认项（合并前需拍板）**：接管即调价——视频涨 6~11 倍、cogvideox
转免费。涨价是否需要站内公告/存量用户沟通，由业务决定。

## P1.5 — 展示==扣费参数对齐不变式（#674 防线，P1 验收项）

> 2026-11-15 影响面审计结论：P1 后「扣费走主体价」而展示若缺参数会继续落 legacy 行
> ⇒ 展示≠扣费，**重演 #674 事故形态**（提议卡显示 10 / 实扣 33）。故参数对齐是 P1 的
> 验收项，不是可选项。不变式：**展示 query 参数必须 ⊇ 计费 query 参数**（同模态同模型同规格）。

后端扣费点补齐（补传 modelKey 等以命中主体行）：

| 调用点 | 现状参数 | P1 补齐 |
|---|---|---|
| studio video:2159 | model+res+dur+mode+ri/rv（已齐） | 不动，自动命中 |
| studio audio:2362 | audioKind（design→voice 归并） | 解除归并 + 传真实 modelKey |
| studio image:1093 | count+resolution，**无 modelKey** | 补 modelKey（resolver 已知模型） |
| studio image_edit:1509 / variant:1326 | modelKey / 无 | 不动（主体 spec="*" 可解析） |
| material.service video:533 | duration+modelKey，**无 resolution** | 补 resolution |
| material.service image:352/417 | count，无 modelKey | 补 modelKey |
| 文本（studio:641/803、agent quoteTextTokens） | per-model token 反比率行 | **不动**（已按模型计价） |

前端展示点补齐（参数来源已核实存在，纯前端小改）：

| 展示面 | 现状参数 | 补齐 |
|---|---|---|
| 提议生成卡/artifact 卡（useProposalNodeData.quoteQueryOf） | video 只传 duration；audio 只传 audioKind；image 传 count+res | `ProposalNodeData.modelId` 已存在（imageModel/videoModel/audioModel 归一），quoteQueryOf 全模态补 modelId + video 补 videoResolution |
| ImageDockPanel | image count+res | 补 modelKey（dock 所选模型） |
| RefineSidePanel | image_edit+modelKey | 已对齐 |
| AgentTurnTimeline | quote→实耗对账位（§14.5-C credit_tx 翻转）已有 | 不动，作为对账观测面 |

**防线**：新增静态契约测试——枚举前端 quoteQuery 构造 == 对应 studio 计费 query 逐字段
相等（断言写死参数清单，漏传即 RED）。

## P1.6 — 定价中心卡片显示「物化后扣费积分」（用户 11-15 新增需求）

- `GET /admin/pricing/cost-records` 每档位新增 `materializedCredits`：从 **active 价目表**
  （无则最新 draft）subject 行按 `capability|modelKey` 前缀匹配取 credits；无则 null（前端显示「—」）。
- 展示口径与扣费口径一致：video 显示「X 分/秒（4s≈… 5s≈… 10s≈… 15s≈…）」按时长枚举；
  audio voice/design 显示「N 分/百字符」、music「N 分/首」；image「N 分/张」；文本「反比率」。
- 不在服务端重算公式，只读取物化条目（单一真相源：物化了什么就显示什么）。

## P1.7 — 账单明细对账（P1 验收项）

- 权威账面 = `PointTransaction`（meta 存 category/model/generationId/ruleVersion；
  「我的积分」页 + 会话流水端点 + SSE credit_tx 三面同源）。
- **对账脚本**（只读生产快照）：取近期 consume 流水 → join GenerationRecord 补
  resolution/duration/audioKind → 按 meta.ruleVersion 分桶 → 用当前 active 表重算 quote
  → 断言 == 流水金额（ruleVersion 不同的切价前流水不参与断言，只统计）。
- **上线冒烟**：真实生成 image/video/audio 各一笔 → 对账脚本验新流水全对 +
  AgentTurnTimeline 实耗翻转正常。

## P2 — 会话成本改读定价中心成本行

- 现状：`model-cost.ts` 读渠道 `models[].pricing`（inputPerM/outputPerM）→
  pi 会话 `override.cost`（会话成本核算，与对客定价无关）。
- 改为：文本模型会话成本解析**优先读 CostRate**（platform 渠道
  `per_1m_tokens_in/out/cache`），无成本行回落渠道配置（宁可少算不错算）。
- 收益：`AdminPricingPage`（平台渠道定价页）的退役前提成立——成本配置
  单源到定价中心。

## P3 — 页面收敛（菜单 10 项 → 6 项）

| 动作 | 页面 | 前置 |
|---|---|---|
| 删 | 主体/成本/利润三个「原始数据·高级」页 | hub 上收发布流 |
| 并 | 价目发布流页 → hub（补 diff 预览+发布+回滚；hub 已有门禁检查） | — |
| 改名/降级 | 平台渠道定价 → 待 P2 上线验证后删除，菜单先收进子菜单 | P2 |
| 藏菜单 | 灰度发布（页面保留，表空未启用） | — |

收敛后菜单：模型目录 · 上游路由 · 健康探活 · 定价中心 · 审计日志 · 使用说明。

## 分刀与顺序

1. **刀1（P1）**：quote 主体自解析 + studio design 解放 + 金标准/变异 →
   授权合并部署 → 生产探针（本刀含调价，合并前单独确认涨价口径）。
2. **刀2（P2）**：会话成本改读 CostRate。
3. **刀3（P3）**：页面收敛（纯前端）。

## No-Go

- 不动 `legacyPriceOf` 常量兜底（quote 永不 throw 的最后一道防线）；
- 不删 legacy 行（兜底与金标准基准）；
- 不动灰度发布设施（表空未启用，保持现状）；
- 不在 quote 内加缓存外 DB 高频查询（主体解析结果随 active 表快照同生命周期缓存）。
