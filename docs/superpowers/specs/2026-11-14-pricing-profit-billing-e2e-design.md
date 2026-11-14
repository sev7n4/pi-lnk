# 定价主体 · 利润策略 · 计费账务端到端自动化设计（v1 总纲 + S1 详细规格）

- 日期：2026-11-14
- 修订：**v1.1（2026-11-14 评审补充）** —— 新增 §3.5「计量单位与币种口径（上游 → 平台侧）」及 D9/D10、U1–U5 缺口登记；成本统一人民币、去除币种 / 汇率列；公式、数据模型、门禁、验收、迁移、附录全链同步
- 修订：**v1.2（2026-11-14 基于 master 代码的自我审核）** —— 以 master `b5088ed6` 干净 tarball 快照逐条复核事实断言，修复 14 处偏差：复用现网 `CostRate.source` 列（原稿误新增 `costSource`）、`MarginPolicy.phase @unique` 冲突与两处 `findFirst` 读法、`loadActiveTable()` 单 `matchKey` 索引导致新键静默不生效、`prepareTextTokenQuote()` 漏改、`checkFloors` 传参按单单位成本会低估地板、反比率地板公式误用目标利润率、现网 `publish()` 已有地板硬拒、发布流建 draft 只复制 5 字段、手校 DTO 真实丢字段机理、`enumeratePricingSpace()` 不含 23 条反比率行、视频成本行 modelKey 漂移（U6）、计价调用点数、源码行号锚点、音频 chars 分期裁决；新增 §6.6.1 缓存双索引与 AC11–AC14 接线守卫
- 状态：**设计稿（v1.2 自审修订完成，转入实施计划）** —— 设计方向已获用户批准（方案 A / 总纲 + S1 详规），v1.1 两点评审意见已落实，v1.2 为基于最新代码的自我审核修订
- 作者：产品 × 架构联合会审
- 取证基线：2026-11-14 生产 DB 只读快照 + **master `b5088ed6f935bce758ddcc21d3194e0c2e4de7d3` 干净 tarball 快照**（`/tmp/pi-lnk-master-audit`，非陈旧工作树）；原始记录见 `.workbuddy/memory/2026-11-14.md`「定价 / 计费能力审计」
- 分期结构：S1 定价主体与利润引擎（本文详细规格）→ S2 上架联动与发布门禁 → S3 计费归因与 metering / 价格锁 → S4 账单与渠道对账

**关联文档（引用即契约）**

| 文档 | 关系 |
|---|---|
| `docs/superpowers/specs/2026-10-13-pricing-baseline-config-design.md` | **基线设计**。本文是其 §4 三层架构、§3 推论 2「价目挂 (渠道, 模型, 规格)」、§8.1 CostWatch、§8.2 渠道对账校准、§9 P2 排期的**续作**，不是替代；历史决策原文不改 |
| `docs/superpowers/plans/2026-10-13-p0-pricing-equivalent-migration.md` | P0 等价迁移（已上线），定义 `ruleVersion` 落账与 `matchKey` 规范化 |
| `docs/superpowers/plans/2026-10-14-p1a-pricing-publishing-gray-release.md` | P1-a 发布流 / 白名单灰度（已上线），本文复用其 diff→publish→rollback |
| `docs/superpowers/plans/2026-10-15-p2-token-precise-billing.md` | P2 token 精确计费（已上线，生产 flag `on`）；其 §Out of Scope 明确排除了「阶段切换 / CostWatch / 渠道对账校准」，本文承接 |
| `docs/ops/ops-console-guide.md`、`docs/ops/pricing-publishing-operations.md` | 运营操作面现状与 SOP-3「pull-models 抹定价」已知缺口 |
| `docs/superpowers/specs/2026-11-11-task-planning-engineering-roadmap-design.md` | 任务管理工程路标（v1.3 已冻结）。**本文不改该路标、不回填状态行**——两条主线互不隶属 |

---

## 0. 一句话结论

把 10-13 已设计但被分期排除的三层定价引擎「接完」：以 **上架模型 × 厂商 / 上游渠道 × 能力规格** 为定价主体，用 **人民币渠道成本 × 可配利润率 → 物化积分售价** 取代人工逐条填 `credits`，经既有发布流生效；中间以 §3.5 的单位链把上游「张 / 秒 / 字符 / 首 / token」归一为「元 / 一次计价单元」，再折成积分（1 credit = ¥0.01），最终按人民币出账；并把每笔报价的价格快照与成本 / 利润 / 单位上下文向下游开放，使计费归因（S3）与账单对账（S4）可自动化。**S1 只交付定价主体登记、成本层、利润层、单位归一、物化与解析链，不改在途请求链路、不改 `PointTransaction`、不建账单表。**

---

## 1. 背景与问题定义

### 1.1 能力审计结论（2026-11-14）

| 环节 | 状态 | 事实 |
|---|---|---|
| 模型上架 / 下架（后台） | ✅ | `admin/model-ops/onboard` + `ModelCatalogEntry`（DB 唯一真源、软删、审计、版本 bump） |
| 后台改价 | 🟡 | 价目发布流 + 灰度 + 成本地板已上线，但按**能力档位**不按模型 |
| 报价 → 计价 → 扣费 | ✅ | `PricingService.quote()` → **master 生产代码 15 处 `quote()` 调用点**（`studio.service.ts` 10 / `material.service.ts` 4 / `pricing.controller.ts` 1）+ **3 处 token 精确计费**（`agent.service.ts` 的 `prepareTextTokenQuote` 1 + `quoteTextTokens` 2）→ `PointsService` 事务化扣减 / 预扣结算 → `PointTransaction(ruleVersion)` |
| 展示价 == 实扣价 | ✅ | master `GET /api/pricing/quote` 复用同一个 `quote()`（本地工作树源码陈旧曾造成「端点缺失」误判，已按 master 复核纠正） |
| 订单 → 支付 → 入账 | ✅（仅支付宝） | `Order` / `Payment` / `Subscription` + 30 余个真实 SQLite 集成用例 |
| **发票 / 账单 / 账期 / 对账** | ❌ | 无 Invoice / Bill 实体、无月结、无日结对账任务 |
| **上架 ↔ 价目、成本 ↔ 售价联动** | ❌ | 本文要解的核心 |

### 1.2 生产基线事实（2026-11-14，`docker cp` 只读快照 + 远端 python3 查询）

| 指标 | 实测 | 对本文的约束 |
|---|---|---|
| active 价目版本 | `v2-launch`，341 条，其中 **211 条 `launch-reprice` 运营改价**；`v1-legacy-equivalent` 已 archived | 后台配价**真实生效**，迁移必须保这 341 行逐字不变 |
| `TEXT_TOKEN_BILLING`（容器 env） | `on` | token 精确计费在生产运行，解析链改动须保持其行为 |
| `CostRate` | 41 行，静态种子；agnes 三档标 `PROVISIONAL 暂定` | 成本层要可维护、可标注来源 |
| 在售 `ModelCatalogEntry` | 13 个 | 定价主体登记的输入规模 |
| `PointTransaction` | 10522 笔；`ruleVersion` 分布 NULL 8456 / `v2-launch` 1920 / `v1` 122 / **`constants-fallback` 24** | 24 笔静默兜底必须变可告警；8456 笔历史行标注「不可归因」而非「无规则」 |
| `PointTransaction.model` 非空 | 5104 / 10522（48.5%） | 归因缺口，S3 用 `UsageRecord` 解 |
| `Order` / `Payment` | 30 单（PAID 8 / PENDING 22）/ 8 笔支付记录 | 账单侧现状 |
| `PricingGrayRelease` | 空表 | 灰度能力已建但零使用，解析链须保留灰度优先级 |

### 1.3 与既有设计资产的关系：续作，不是新体系

10-13 基线 spec **已经**设计了本文的大部分愿景：§4「CostRate → MarginPolicy → PriceList」三层、§4.1 增量数据模型、§5.1 主公式 `ceil(成本 × 毛利系数 ÷ 0.01)`、§5.3 价格锁、§8.1 CostWatch 周更、§8.2 渠道对账校准、§3 战略推论 2「档位体系要从『时长 × 系数』改为『模型 × 规格』直查成本表，价目必须挂在 (渠道, 模型, 规格) 上」。

实现只走到 P0（等价迁移）+ P1-a（发布流 / 灰度）+ P2（token 精确计费）。P1-a plan 把 CostWatch 明确挪 P2，P2 plan 的 Out of Scope 又把「阶段切换 / CostWatch / 渠道对账校准」整体排除。因此**缺口不是「没设计」，而是「设计已拍板、实现被分期砍掉」**。本文的增量只有三块：① 定价主体维度化（模型 / 厂商 / 上游渠道）；② 利润率按 scope 可配且驱动物化；③ 把报价上下文打通到计费归因与账单。

⚠️ **设计稿与现网 schema 不一致（必须登记，禁止按设计稿重建）**：10-13 §4.1 写的是 `unitCostCents / currencySrc / effectiveFrom / sourceUrl / marginDefault / fxUsdCnyMilli / marginByCap`；现网落地的是 `CostRate(costYuan, unit, source, note)` 与 `MarginPolicy(phase, anchorCents, marginBp, capabilityOverrides)`。差异逐项登记见**附录 B**。本文一律以现网 schema 为基线做 additive 迁移。

---

## 2. 目标、成功判据与非目标

### 2.1 业务目标（可验收改写）

| # | 用户目标 | 可验收形态 |
|---|---|---|
| G1 | 上架产品后台配置报价 | 任一在售模型可在后台按 (模型, 上游渠道, 规格) 设定售价并发布生效 |
| G2 | 渠道成本配置 | 成本行可按上游渠道 / 厂商登记，**币种恒为人民币**，带计量单位、来源、有效期与凭据（§3.5） |
| G3 | 平台利润配置（按成本自定义 %X） | 可按 全局 / 模态 / 厂商 / 上游渠道 / 模型 / 模型+规格 六档 scope 设利润率，最具体者胜 |
| G4 | 按模型类型、厂商渠道自定义报价 | `PricingSubject` 以 `capability × modelKey × spec × provider × upstream` 为键 |
| G5 | 报价→计费→账单全流程自动化 | S1–S4 四期串成状态机：登记 → 成本 → 利润 → 物化 → 发布 → 计费 → metering → 日结 → 月账 → 差异告警 |

### 2.2 顶层成功判据

1. 上架一个新模型后，运营**不需要改代码 / 发版**即可完成「成本登记 → 利润率设定 → 价目生成 → 发布 → 按新价扣费」。
2. 任何一条已发布售价都能回答四问：成本多少、来自哪个渠道 / 凭据、按哪条利润率算出、属于哪个价目版本。
3. 缺成本或击穿地板的价目**无法发布**，且违规清单可定位到具体条目。
4. 改成本 / 改利润率**不自动改 active 价目**，只产出建议 diff，由运营经既有发布流决定。
5. 存量 341 条 legacy 档位行的价格逐字不变，既有等价金标准测试保持全绿。
6. 每笔扣费可归因到模型 / 渠道 / 成本 / 利润 / 规则版本（S3 落地，S1 提供契约）。
7. 任一在售模型可回答「上游按什么单位收钱、平台按什么单位卖钱、两者怎么换算、成本以什么币种入账」四问，且答案落在 §3.5 的字段与规则里，不依赖口头约定；单位缺失时系统拒绝猜价。

### 2.3 非目标与 No-Go

- 不引入独立定价微服务、规则引擎 DSL 或第二套价目表（重复造轮子，且与 `quote()` / 发布流 / 流水三处重复）。
- 不接真实税控发票、不扩展微信 / Stripe / 小程序虚拟支付渠道（另立项）。
- 不改 vendor（`pi-agent-core`）、不改 `apps/web` 设计令牌体系、不改任务管理工程路标（v1.3 冻结）。
- 不碰停在合并前等待授权的 C-2a PR #866。
- 不回填 / 改写历史 `PointTransaction`（账务不可变；8456 笔 `ruleVersion=NULL` 只做「不可归因」标注口径，不改行）。
- S1 不做：`onboard` 自动建价（S2）、`PointTransaction` 加列 / `UsageRecord`（S3）、`Bill` / 发票 / 渠道账单导入（S4）。

---

## 3. 口径裁决（全部拍板，本文无未决项）

| ID | 歧义 | 裁决 | 理由 / 反例 |
|---|---|---|---|
| **D1** | 「按成本配 %X 利润」是成本加成率还是毛利率 | **成本加成率 markup**：`售价 = ceil(成本 × (1+X%) ÷ 0.01)`。X 以 `profitBp` 存储（10% = 1000bp） | 现网 `marginBp=11000`（1.10×）、地板 `costYuan×105`、种子 `computeCreditsFromCost(cost, 11000)` 全是加成口径。若改用毛利率 `成本/(1−X%)`，同样 10% 会得 1.111×，341 条 active 行口径漂移 |
| **D2** | 「打通账单」是否含开发票 | **不含**。账单 = 可归因 + 可对账 + 可出账的业务闭环（`Bill`/`BillLine`/渠道账单校准/利润看板）；税控发票、发票主体、税目、支付渠道扩展另立项 | 税务主体与资质信息本仓零建模，塞进本轮会把范围撑爆 |
| **D3** | 是否推倒重建价目体系 | **不推倒**。保留 `matchKey` 档位键为 fallback 行，**双轨**：新增 `subjectKey` 精确键，解析时精确键优先、legacy 键兜底 | 341 条存量行 + 等价金标准 4/4 是上线保护网；单轨切换需一次性全量回填，风险不可控 |
| **D4** | 「厂商渠道」到底指什么 | 用三个互不混用的字段：`provider` = 厂商品牌（由 `providerBinding` 映射）；`upstream` = 成本归属上游（`UpstreamRoute.upstream`：agnes_hub / apimart / stepfun / minimax / fal / zhipu）；`channelId` = 用户侧渠道（S1 恒为 `platform`） | 现网 `ProviderChannel.id='platform'` 是用户渠道，`UpstreamRoute.upstream` 是上游渠道，同名混用会直接算错成本。**BYOK 渠道结构性排除**（沿用 `platform-channel.controller.ts` 既有语义） |
| **D5** | 成本权威源 | 优先级 `channel_actual`（渠道账单校准）> `negotiated`（议价）> `official_list`（官方挂牌）> `provisional`（暂定种子）；同优先级取 `effectiveFrom` 最新且覆盖计价时刻的行 | 10-13 §2 口径说明：聚合渠道实际成本常为挂牌价 4–7 折，挂牌价只是上线基准与偏差上界 |
| **D6** | 利润率冲突 | scope 具体度优先：`model_spec > model > channel(upstream) > provider > modality > global`；同 scope 取 `effectiveFrom` 最新 | 与 D5 同源的「最具体者胜」，可解释、可回溯 |
| **D7** | 改价与在途请求 | **价格锁**：请求发起即锁 `ruleVersion + lockedCredits + costYuan + profitBp + subjectKey`；失败 / 取消按 `lockedCredits` 原额退 | 10-13 §5.3 已拍板；复用 `PointHold` / reaper exactly-once 范式，S3 落地落库，S1 只在报价返回结构里放出字段 |
| **D8** | 常量兜底是否继续静默 | **不再静默**：`constants-fallback` 每次计价打指标 + warn + 在返回结构里标 `degraded=true` | 生产实测已有 24 笔按兜底扣费且无任何提示 |
| **D9** | 成本用什么币种 | **单一人民币（CNY）**：`CostRate.costYuan` 恒为人民币元，是唯一成本权威源；不设币种列、不设汇率列、不做运行时换算。上游美元报价由运营按渠道结算单的人民币金额录入，`sourceRef` 指向凭据 | 平台售价（积分锚 ¥0.01）与账务全是人民币；10-13 §2 的美元挂牌价 × 7.15 汇率属于**录入侧**取证，不该进运行时。详见 §3.5.6 |
| **D10** | 上游计费单位与平台计价单位不同构，怎么换算 | **四层单位链、三次换算**：上游物理量（张/秒/字符/首/token）→ 人民币「元 / 一次计价单元」→ 积分 credits → 人民币账单。归一公式与每模态规则写死在 §3.5，物化与快照只消费归一后的 `costYuanPerRequest`（文本反比率行是唯一例外，见 §6.5）；单位缺失一律 `cost_missing`，禁止线性外推 | 视频上游按秒、平台按阶梯；音频上游按字符、平台按次；图片上游按张、平台把张数编进键。不定义换算规则就会出现「写了成本行但算错钱」 |
| **D11** | 音频 TTS「按字符精确计费」是否进 S1 | **不进**。S1 保留 `audio:voice` 档位一口价、成本行标 `provisional=true`；但 S1 就在 `PricingQuery` 补 `chars?: number` **可选类型占位**（旧调用零改动、S1 计价链不消费），运行时精确计费归 S3 | 现网 `PricingQuery`（`pricing.core.ts:23–33`）无 chars、15 处 `quote()` 调用点均不传，S1 做精确计费须改全部音频调用点并先落 `UsageRecord.chars`，属跨 S3 的范围扩张；补类型占位可避免 S3 再改 `quote()` 签名。v1.2 自拍板，取代 v1.1 遗留的「请你裁决」 |

### 术语表（避免同名歧义）

| 术语 | 定义 |
|---|---|
| 定价主体 `PricingSubject` | 一个可被独立定价的 (能力, 模型, 规格, 厂商, 上游渠道) 组合 |
| `subjectKey` | `capability|modelKey|spec|provider|upstream`，全部小写、`modelKey` 经 `modelOptionName` 归一、去渠道前缀 |
| `matchKey` | 现网档位键（`image:1K:1` / `video:minimax-h3:768p:5:...` / `text:<model>:in`），双轨中的 legacy 侧 |
| `unit` | 成本行的计价单位（现网实测四种）：`per_image` / `per_video` / `per_call` / `per_1m_tokens`；S1 新增 `per_second`（视频按秒登记）。`spec` 才区分具体档位（`1K` / `768p:5s` / `per_100_chars` / `per_song` / `per_1m_tokens_in`） |
| `unitQuantity` | 一条成本行的**一个计价单位**包含多少物理量：`per_image`=1 张、`per_video`=1 条、`per_second`=1 秒、`per_call`+`per_100_chars`=100 字符、`per_call`+`per_song`=1 首、`per_1m_tokens`=1e6 token |
| `billableUnit` / `unitsPerRequest` | 定价主体一次请求的物理量口径 / 消耗量。二者与 `unitQuantity` 共同决定 `costYuanPerRequest`（§3.5.4） |
| `计价单元` | 平台侧可被独立报价的「一次请求」：图片 = 一次出图请求（含张数）、视频 = 一条成片（含时长与参考素材）、音频 = 一次合成、文本 = 一组 token |
| `profitBp` | 成本加成利润率的基点，`profitBp=1000` ⇒ 倍率 1.10 |
| `priceFloorBp` | 最低允许加成，缺省 `500`（5%），与现网 `FLOOR_MULTIPLIER=105` 等价 |

---

## 3.5 计量单位与币种口径（上游 → 平台侧）

> 本节是**一等约束**（2026-11-14 评审补充）：定价主体、成本行、物化公式、报价快照、S3 metering、S4 账单全部按本节单位链取值。任何新增字段或端点若引入第二套单位、第二币种，视为违约。依据为现网代码实证，锚点见 §3.5.2 / §3.5.3。

### 3.5.1 单位链（四层节点 / 三次换算，唯一合法路径）

| 层 | 计量对象 | 单位 | 存储 / 常量 | 产生方 |
|---|---|---|---|---|
| L0 上游物理量 | 供应商实际计费量 | 张 / 秒 / 字符 / 首 / token | 渠道账单；请求参数 `count` / `duration` / `chars` / `tokens` | 上游渠道 |
| L1 成本（本文权威口径） | 一次平台计价单元的人民币成本 | **元 / 计价单元（CNY）** | `CostRate.costYuan` + `unit` + `unitQuantity` | 运营登记 / S4 账单校准 |
| L2 售价 | 平台对用户的一口价 | **积分 credits**（1 credit = ¥0.01，`MarginPolicy.anchorCents=1`） | `PriceListEntry.credits`；文本反比率行 `r` | `PricingMaterializer` |
| L3 账务 | 扣费与出账 | 积分（流水）/ 人民币元（账单） | `PointTransaction` / S4 `Bill` | `PointsService` / S4 |

**换算总式**（S1 物化的唯一入口，禁止在别处另写一份）：

```
costYuanPerRequest = costYuan × unitsPerRequest / unitQuantity
credits            = max(1, ceil( costYuanPerRequest × (10000 + profitBp) / 10000 / 0.01 ))
```

`costYuan` = 一条 `CostRate` 行的价格；`unitQuantity` = 该行一个计价单位包含的物理量；`unitsPerRequest` = 本次请求消耗的物理量。§6.5 的公式是本式在 `unitsPerRequest = unitQuantity = 1` 时的特例——**现网 341 条 active 行全部满足该特例**，故等价金标准 4/4 与逐字不变判据不动。

### 3.5.2 上游（成本侧）各模态计费单位

| 模态 | 上游计费单位 | 现网 `CostRate` 落法（`unit` / `spec` / `costYuan`） | 代码锚点 |
|---|---|---|---|
| 视频 | **上游挂牌按输出秒数**、分辨率分价；参考图按张（前 5 张免费，超出按张）、参考视频按秒；fal 按端点 / 次待实测 | 现网**按整条时长档**登记：`per_video` / `768p:5s` / 2.86（= ¥0.572/s × 5s 反推）；`2k:5s` / 4.65；`768p:10s` / 5.72；`768p:15s` / 8.58；4s 两行是「5s 锚点 × 4/5 线性推算」。⚠️ **41 行种子里零 `per_second` 行**，`per_second` 是 S1 新增枚举，不是现网已有数据 | `seed-pricing.ts:29–38` |
| 图片 | **按张**，分辨率 / 像素档不同价，输入图免费 | `per_image` / `1K` / 0.30（seedream-5.0-pro）；`2K` / 0.60；`gpt-image-2` 的 `1024` / `2K` / `4K` = 0.072 / 0.572 / 2.93 | `seed-pricing.ts:23–28` |
| 音频 TTS | **按字符数**（万字符 / M 字符） | `per_call` / `per_100_chars` / 0.009（step-tts-mini = ¥0.9/万字符 ÷ 100）；stepaudio-3-tts / 0.025；minimax-speech-2.8-hd / 0.0715 | `seed-pricing.ts:39–41` |
| 音频音乐 | **按首 / 次**（≤5 分钟一首） | `per_call` / `per_song` / 0（限免窗口，`watchWindow`） | `seed-pricing.ts:78` |
| 文本 | **按 1M tokens**，in / out / cache 分价 | `per_1m_tokens` / `per_1m_tokens_in` / 0.7、`_out` / 2.1、`_cache` / 0.14（step-3.5-flash） | `seed-pricing.ts:44–57` |

> 上游挂牌价出处见 `docs/superpowers/specs/2026-10-13-pricing-baseline-config-design.md` §2（含美元挂牌价与 7.15 汇率）。**该历史原文不改**；本文 D9 规定进入 `CostRate` 时一律人民币，折人民币这一步在录入侧完成。

### 3.5.3 平台侧（售价侧）计量单位 —— 与上游不同构

平台对用户**只按积分一口价**，键空间是「档位」而非物理量单价（`pricing.core.ts:87–107`）：

| 模态 | 平台计价键 | 一次请求如何计价 | 与上游单位的差异 |
|---|---|---|---|
| 图片 | `image:<1K/2K/4K>:<1..4>` | 分辨率档 × 出图张数，一档一条价（active `image:1K:1=33`、`image:1K:2=66`、`image:4K:1=323`） | 上游按张 + 像素档；平台把**张数编进键**，不是运行时 `单价 × count` |
| 视频 | `video:<family>:<480p/768p/2k>:<duration>:<mode>:ri<n>:rv<n>`（`mode` 为 `ref` 或 `-`） | 时长阶梯基础分 30 / 50 / 70（`video-credits.ts:8–12`）× 家族与分辨率系数 + 超额参考素材加分 | 上游**按秒线性**；平台是**时长阶梯 + 系数**，分辨率只认 3 档，参考素材仅 `minimax-h3 + reference_to_video` 生效 |
| 音频 | `audio:voice` / `audio:music` | 固定 5 / 15 分一次请求 | 上游按字符 / 按首；平台 `PricingQuery`（`pricing.core.ts:23–33`）**没有字符数参数** |
| 文本 | `text`（5 分/轮，studio 直生）；`text:<model>:in/cache/out` | 反比率行 `r` = 每 1 credit 可买 token 数，`charge = ceil(tokens/r)` | 唯一与上游同构（按 token）的模态 |
| 图片编辑 / 变体 | `image_edit:<model>` / `image_variant` | 一口价 | 上游按张 / 按次 |

**平台侧对外单位**：展示端点 `GET /api/pricing/quote` 与扣费一律返回 / 记 credits；`PointTransaction` 记积分；S4 `Bill` 按 `credits × ¥0.01` 折人民币出账。**用户不感知「元/秒」「元/千字符」**，单位换算完全发生在平台内部。

### 3.5.4 单位对齐契约（S1 新增，可机检）

1. `CostRate.unit` 收为受控枚举：现网四种 `per_image` / `per_video` / `per_call` / `per_1m_tokens` + S1 新增 `per_second`（视频按秒登记）。新增 `unitQuantity Float @default(1)`，取值见术语表。`spec` 保留现网字符串并加格式校验：视频 `<res>:<Ns>`、token `per_1m_tokens_<in/cache/out>`、音频 `per_100_chars` / `per_song`。
2. `PricingSubject` 新增 `billableUnit`（枚举 `image_count` / `video_call` / `video_second` / `chars_100` / `song` / `token_in` / `token_cache` / `token_out`）与 `unitsPerRequest Float?`。`resolveUnitCost(subject, at)` 返回 `{ costYuan, costRateId, costSource, unit, unitQuantity, unitsPerRequest, costYuanPerRequest, provisional }`；**价格行物化、地板校验与价格快照只消费 `costYuanPerRequest`**。唯一例外是文本 token 反比率行：它按「每 1M token 人民币成本」直接算 `r`，实际用量在结算 `charge=ceil(tokens/r)` 时体现，不得把 `costYuanPerRequest` 代进去（§6.5 警示）。
3. 按模态的归一规则（写死在代码，禁止运营自由填公式）：
   - **图片**：`unitsPerRequest = canonicalImageCount(count)` ⇒ `costYuanPerRequest = costYuan × count`（`unitQuantity=1`）。
   - **视频**：优先命中 `per_video` + `spec=<res>:<Ns>` 整条成本行（`unitsPerRequest=1`）；无整条行但有 `per_second` 行时 `unitsPerRequest = duration`；**两者都无 ⇒ `cost_missing`，禁止按 5s 锚点线性外推**（现网 4s 推算行迁移时标 `provisional=true`）。参考图 / 参考视频加项按张 / 秒单独登记成本行，随 `ri/rv` 累加。
   - **音频 TTS**：`unitsPerRequest = ceil(chars/100)`。现网 `PricingQuery`（`pricing.core.ts:23–33`）**没有 chars 字段**，`quote()` 的 15 处调用点也均不传 ⇒ 该主体 `unitsPerRequest=null`。**v1.2 裁决（D11）**：S1 保留档位一口价、成本行标 `provisional=true`、**不产出「按字符精确价」**；但 S1 就在 `PricingQuery` 上补 `chars?: number` 可选字段作为**类型契约占位**（旧调用零改动、S1 计价链不消费它），避免 S3 落 `UsageRecord.chars` 时再次改 `quote()` 签名；精确计费的运行时闭环归 S3。
   - **音乐**：`unitsPerRequest = 1`（按首）；限免窗口 `costYuan=0` 按「成本未确认」处理，不按 0 成本物化。
   - **文本**：`unitsPerRequest = tokens_<spec>`；反比率行公式见 §6.5，其 `r` 已隐含 `1e6` 换算。
4. **快照**：`PriceListEntry.costSnapshotYuan` 存 `costYuanPerRequest`，并新增 `unitSnapshot`（`billableUnit + unitQuantity + unitsPerRequest` 三元组）；S4 出账按快照，不按新成本回算（§8 账务不可变）。
5. **单位覆盖率指标**：`pricing_unit_mismatch_total{capability, reason}`，`reason ∈ missing_units / inferred_units / unit_enum_unknown`，与 `pricing_subject_total{cost_missing}` 一起进 §9 告警。

### 3.5.5 单位不对齐缺口登记（本文必须显式承接）

| # | 缺口 | 现状证据 | 归属 |
|---|---|---|---|
| U1 | 音频按字符收、平台按次卖，且计价入参无字符数 | `pricing.core.ts:23–33` 无 chars；`seed-pricing.ts:39–41` 是 `per_100_chars` | S1 标 `provisional` 不精确物化；S3 补 metering |
| U2 | 视频上游按秒线性、平台按阶梯；4s 两行注释自认「5s 锚点 × 4/5 线性推算」，10s / 15s 数值恰为 5s 锚点整数倍但未标来源 | `seed-pricing.ts:31–36` 注释自认「线性推算，待对账校准」 | S1 禁止外推 + 显式登记；S4 渠道账单校准 |
| U3 | 图片成本行只有分辨率、没有张数维度，`cost × count` 靠人工乘 | `seed-pricing.ts:23–28`；`image:1K:2=66` | S1 §3.5.4 归一规则 |
| U4 | 参考素材 `ri/rv` 进了售价键，成本侧无对应行 | `pricing.core.ts:99–105`；`seed-pricing.ts` 无 ri/rv 行 | S2 上架门禁列违规；S4 补成本行 |
| U5 | 上游单位取证来自美元挂牌价 × 汇率，而平台成本 / 售价 / 账务全是人民币，链条中断 | 10-13 spec §2 汇率 7.15；`pricing.core.ts:233–255` 的 USD 预估 | D9 + §6.3 |
| **U6** | **视频成本行与售价键的 modelKey 不同构**：成本行写 `seedance-2.0-fast`（`seed-pricing.ts:38`），售价枚举写 `seedance-2.0`（`pricing.space.ts:18`），而 `videoPriceFamily()` 把两者都归 `default` 家族；`h3-max` 只有一条 `480p:5s` 成本行，却要覆盖 `h3-max` / `h3-max-turbo` 两个售价家族与三档分辨率 | `seed-pricing.ts:29–38` vs `pricing.space.ts:18–22`、`pricing.core.ts:46–51` | S1 `resolveUnitCost` **按 `videoPriceFamily()` + (res, duration) 归一查成本行，禁止 modelKey 字符串直等**（§6.2/§6.3）；家族缺成本行一律 `cost_missing` 不外推；S4 渠道账单补齐 |

### 3.5.6 币种：单一人民币（D9 展开）

- `CostRate.costYuan` **恒为人民币元**，是唯一成本权威源。**不新增** `currencySrc` / `fxRate` / `fxUsdCny` 列，不做运行时汇率换算，不引入 `PRICING_FX_USD_CNY` 作为定价输入；写入侧不存币种字段。
- 上游以美元报价时（MiniMax-H3、gpt-image-2、渠道 `models[].pricing` 四元组、pi-runtime `AGNES_COST_*_PER_M`）：由运营在成本登记页按**渠道结算单 / 议价合同的人民币金额**录入，`sourceRef` 指向该凭据；美元金额只留在凭据里，不入库、不参与计算。这样汇率风险由「录入时点的结算凭据」承担并可审计，而不是散落在运行时公式里。
- 现网 `estimateCreditsFromUsdCost()` / `resolveFxUsdCny()` / `degradedTextTokenQuote()`（`pricing.core.ts:241–255`、`pricing.service.ts:463–475`；`pricing.service.ts:346–360` 是 `prepareTextTokenQuote`，不是兜底）与 `agent.service.ts:3765–3812` 的 SSE 展示预估，是**既有展示预估与兼容兜底**：S1 不删、不改其行为（不越界动已上线的 P2 路径），但**新解析链与物化链一律不消费它们**；该兜底命中时按 D8 打 `degraded=true` + 指标，S1 新模型精确人民币成本行到位后不再发生（AC7）。⚠️ **验收边界**：AC10「改 `PRICING_FX_USD_CNY` 零影响」只约束 `quote()` 与 `materialize()`；`quoteTextTokens` 的 degraded 兼容兜底属已上线行为，仍会读 FX，S1 不改它、只在命中时标 `degraded`，判据不得把它算进「零影响」面。
- S4 `ChannelStatement` 导入渠道账单时，美元账单同样在导入侧按结算单人民币金额折算后写修正建议；`Bill` / `BillLine` 金额字段一律人民币元，`ChannelStatement` 只保留原始报文与折算凭据，不落汇率列。

---

## 4. 总体架构

```
┌─ 运营面（ops-console，AdminTokenGuard + AdminAuditLog）────────────────────┐
│ 模型目录 / 渠道成本 / 利润策略 / 定价主体 / 价目发布流 / 灰度 / 审计        │
└───────────────────────────┬───────────────────────────────────────────────┘
                            │ 写：draft / cost / policy / subject
┌───────────────────────────▼───────────────────────────────────────────────┐
│ L1 成本层  CostRate（+ PricingSubject 登记）                                │
│   上游物理量（张/秒/字符/首/token）── 单位归一 §3.5 ──┐                   │
│   挂牌 / 议价 / 渠道账单校准（人民币元 / 计价单元）────┴→ costYuanPerRequest│
│   渠道 USD 费率只在录入侧折人民币，不进运行时（D9）                        │
├────────────────────────────────────────────────────────────────────────────┤
│ L2 策略层  MarginPolicy（多行 scope：global…model_spec）                    │
│   profitBp + priceFloorBp + anchorCents（¥0.01/credit，单一人民币口径）     │
├────────────────────────────────────────────────────────────────────────────┤
│ L3 物化层  PricingMaterializer（归一成本 × 利润 → credits，幂等 + diff）    │
│   → PriceListEntry(subjectKey, credits, basis, costSnapshot, unitSnapshot)   │
│   → 既有 PriceListVersion 发布流：draft → diff → publish → rollback          │
├────────────────────────────────────────────────────────────────────────────┤
│ L4 计价层  PricingService.quote() / quoteTextTokens()                       │
│   subjectKey 精确 → model 默认 → legacy matchKey → capability:* → 常量兜底   │
│   返回 PricingQuote（含价格锁 + 单位快照上下文）                            │
├────────────────────────────────────────────────────────────────────────────┤
│ L5 账务层（S3/S4）UsageRecord → PointTransaction → Bill/BillLine（人民币）  │
│   → ChannelStatement 导入 → 差异校准 → 回写 CostRate 建议                    │
└────────────────────────────────────────────────────────────────────────────┘
```

**端到端状态机（G5 的自动化链）**：上架 → 主体登记 → 成本登记 → 利润策略 → 物化建议价 → 发布（门禁）→ 计价（价格锁）→ metering → 日结 → 月账 → 渠道账单差异告警 → 成本校准建议 → 回到成本登记。每一步都有状态、幂等键与 `AdminAuditLog` / 指标；任一环失败即停在当前状态并告警，**不允许跳步自动改 active**。

---

## 5. 分期与接口契约

| 期 | 范围 | 明确不做 | 对外契约（后续期依赖） | 前置 |
|---|---|---|---|---|
| **S1（本文详规）** | `PricingSubject` 登记；`CostRate` / `MarginPolicy` 增维；**单位归一与单一人民币口径（§3.5）**；物化服务；`quote()` 增维解析；后台配置面；发布流 DTO 扩展 | 不接 `onboard`、不改 `PointTransaction`、不建 `UsageRecord` / `Bill`；不引入汇率 / 币种字段 | `PricingQuote` 返回 `subjectKey / costYuanPerRequest / billableUnit / unitSnapshot / profitBp / priceListVersionId / ruleVersion / costSource / degraded`；`PricingSubject` 状态机；发布门禁判定函数 `validatePublish(draftId)` | — |
| **S2** | `onboard` 事务内自动建主体 + 继承默认价；`offboard` 联动；发布门禁硬拒；成本变更 → 建议 diff；SOP-3 hardening（渠道定价独立列） | 不改计价内核 | 消费 S1 的 `validatePublish` 与 `PricingSubject` 状态；产出「缺成本 / 击穿地板」违规清单 | S1 |
| **S3** | `UsageRecord`（每请求一行）；`PointTransaction` 加列；价格锁落库；`quote()` 降级告警指标；多实例 revision 缓存失效 | 不建账单、不出发票 | 消费 S1 的 `PricingQuote` 上下文；产出按 (模型, 渠道, 期间) 的用量 / 成本 / 收入 / 毛利 | S1 |
| **S4** | `Bill` / `BillLine` 账期聚合；`ChannelStatement` 账单导入与差异校准；利润看板；日结 / 月结任务 | 不接税控发票 / 新支付渠道 | 消费 S3 的 `UsageRecord`；差异结果写回 `CostRate` 修正建议（人工确认后生效） | S2 + S3 |

**S1 实施计划范围声明**：一份实施计划只覆盖 S1（含总纲中定义但由 S1 提供的契约桩与迁移）；S2–S4 各自独立 spec → plan → 实现周期，不在本轮计划内。

---

## 6. S1 详细规格：定价主体与利润引擎

### 6.1 数据模型（全部 additive，禁止推倒重建）

| 表 | 动作 | 新增 / 变更字段 | 约束 |
|---|---|---|---|
| `PricingSubject` | **新增** | `id`, `subjectKey @unique`, `capability`, `modelKey`, `spec`, `provider`, `upstream`, `channelId @default('platform')`, `status`, `billableUnit`, `unitsPerRequest Float?`, `defaultSubjectKey?`, `source`(`auto`/`manual`), `createdAt`, `updatedAt` | `status ∈ draft / cost_missing / priced / published / offboarded`；`billableUnit ∈ image_count / video_call / video_second / chars_100 / song / token_in / token_cache / token_out`；`@@index([modelKey, capability])`、`@@index([upstream, status])` |
| `CostRate` | 加列（**复用 `source`**） | `provider?`, `upstream?`, `unitQuantity Float @default(1)`, `effectiveFrom?`, `effectiveTo?`, `sourceRef?`, `provisional Boolean @default(false)`；`unit`（已有）收为受控枚举 + 新增 `per_second`；**`source`（已有列，`@default("official_list")`）扩为 D5 四级枚举，不新增 `costSource` 列** | **不新增 `currencySrc` / `fxRate` / `fxUsdCny`（D9）**；`costYuan` 恒为人民币元；保留既有 `@@unique([channel, modelKey, spec])`；新增行用 `@@unique([channel, modelKey, spec, effectiveFrom])` 前先做回填（见 6.9）。⭐ 逻辑层字段名 `costSource`（`resolveUnitCost` 返回值、`PricingQuote`、`pricing_cost_source_total{source}`）= `CostRate.source` 的值，**不新建同名列** |
| `MarginPolicy` | 语义重构（保留列） | `scope`, `scopeKey?`, `profitBp`, `priceFloorBp @default(500)`, `effectiveFrom`, `effectiveTo?`, `status` | 现网单行 `marginBp=11000` 迁移为 `scope='global', profitBp=1000`（1.10×）；`marginBp` 列保留只读兼容，不再作为写入口；`anchorCents=1` 即 1 credit = ¥0.01（人民币）。⭐ **`phase String @unique` 冲突**：现网仅一行 `phase='launch'`（`seed-pricing.ts:132–136`），新增多行必须给每行确定性唯一 `phase`（global 行沿用 `'launch'`，其余取 `'scope:<scope>:<scopeKey>'`），否则 `create` 撞唯一约束。⭐ 两处 `findFirst({ orderBy: { createdAt: 'desc' } })` 必须改按 `scope='global'` 精确查询（§6.6.1） |
| `PriceListEntry` | 加列 | `subjectKey?`, `costSnapshotYuan?`（存 `costYuanPerRequest`）, `unitSnapshot?`, `profitBpSnapshot?`, `costRateId`（已有）, `marginPolicyId?`; `versionId` 沿用已有列 | ⭐ 现网 `matchKey String` **非空**且 `@@unique([versionId, matchKey])`。S1 的 subjectKey 行**必须把 `subjectKey` 字符串本身写入 `matchKey`**（两列同值），`subjectKey` 列同时置同值用于区分类型；用 `|` 分隔的 subjectKey 与 `:` 分隔的 legacy 键天然不撞键。禁止填占位值 / 空串，禁止让 legacy 键与 subjectKey 行共用同一 `matchKey`（会撞唯一约束）。`@@unique([versionId, matchKey])` 不变；新增 `@@unique([versionId, subjectKey])`（可空列，SQLite 允许多个 NULL） |
| `PriceListVersion` | 加列 | `revision Int @default(0)` | 每次 publish / rollback `+1`；**S1 只改这两处做递增，不引入发布门禁（S2）**；S3 用它做多实例缓存失效 |
| `PricingQuote`（内存类型，非表） | 扩字段 | `subjectKey?`, `costYuanPerRequest?`, `billableUnit?`, `unitSnapshot?`, `profitBp?`, `priceListVersionId?`, `costSource?`, `degraded?: true` | **全部条件写入**（键不出现纪律：`...(x ? {k:v} : {})`，禁止 `?? null`）。⭐ `degraded` 只在 `constants-fallback` 路径出现且恒为 `true`，非兜底路径不出现该键 ⇒ `pricing.service.test.ts` 里几十处 `toEqual({credits, ruleVersion})` 等价锚零改动（v1.2 实施计划自审补） |

**不新增**：`PointTransaction` 任何列、`UsageRecord`、`Bill` / `BillLine`、`ChannelStatement`、`Invoice*`（分别属 S3 / S4 / D2）；**以及任何币种 / 汇率列**（`currencySrc` / `fxRate` / `fxUsdCny`）——成本与售价统一人民币（D9）。

#### 6.1.1 现网必须同步改造的函数（v1.2 自审核对表，写实施计划时逐项落任务）

> 只加表、加端点而漏改这些函数，会精确重演上一轮缺口 #2「后台写了价、计价侧永远构造不出这个键 ⇒ 静默不生效」。以下位置均取自 master `b5088ed6`。

| # | 现网函数 / 位置 | 不改的后果 | S1 必须做的改造 |
|---|---|---|---|
| 1 | `loadActiveTable()` — `pricing.service.ts:504–527`，`entries.set(e.matchKey, e.credits)` | **单 Map 只按 `matchKey` 建索引**，subjectKey 行即使入库也进不了表快照 ⇒ 六级解析前三级恒 miss | 加 `subjectEntries` 第二 Map（`e.subjectKey` 非空时按它建索引），`quote()` 先查它；缓存失效仍走 `invalidate()`（§6.6.1） |
| 2 | `loadGrayTable()` — `pricing.service.ts:533–562` | 同上，灰度 subjectKey 行失效 | 同建双 Map，灰度 / global 两套快照对称 |
| 3 | `quoteTextTokens():259` **与** `prepareTextTokenQuote():362` 两处 `TEXT_TOKEN_MODELS.includes(model)` | 只改前者 ⇒ SSE 流式预估仍走 USD 兜底，破坏 2026-11-03「预估与结算同源同式」 | **两处同时**替换为「该模型存在 in/out 反比率主体行」判据；`pricing.service.test.ts:610` 的 `plan.compute === quoteTextTokens` 契约须继续绿 |
| 4 | `readCurrentMarginBp()` — `pricing.service.ts:478–485`；`readMarginBp()` — `agent.service.ts:3765–3775` | 两处 `findFirst({ orderBy: { createdAt: 'desc' } })`，多行 scope 后会取到「最新创建」的某模型 30% 利润行，污染 USD 兜底毛利 | 改为 `findFirst({ where: { scope: 'global', status: 'active' } })`，缺省仍 11000bp；两处同步改，AC12 机检 |
| 5 | `checkFloors()` — `pricing-publishing.service.ts:409–435`（传参 432 `rate.costYuan`） | 传的是**单单位成本**：图片 3 张（0.30 元/张）地板只按 `ceil(0.3×105)=32` 算，实际应为 `ceil(0.9×105)=95` ⇒ 严重低估下限 | 改传 **`costYuanPerRequest`**（由 `unitSnapshot` 或 `resolveUnitCost` 复算），`checkCostFloor` 的 `FLOOR_MULTIPLIER=105` 改由 `priceFloorBp` 派生且数值等价（§6.4） |
| 6 | `createDraftFromActive()` — `pricing-publishing.service.ts:87–180`（复制点 113 / 173） | 只复制 `matchKey / capability / credits / basis / costRateId` 5 字段 ⇒ 从 active 建 draft 时所有新列全丢 | 复制清单扩展至 `subjectKey / costSnapshotYuan / unitSnapshot / profitBpSnapshot / marginPolicyId / reason`；AC13 断言 |
| 7 | `parseEntriesBody()` — `pricing-publishing.controller.ts:39–68`；`PublishEntryInput` — service:66；`upsertEntries()` — service:180–215 | **手写白名单**只透传 5 字段，其余静默丢弃（与 `ValidationPipe` 无关：`@Body() Record<string, unknown>` 不受 whitelist 影响） | 三处同步扩字段并写透传回归；`versionId_matchKey` upsert 键保持不变（subjectKey 行的 `matchKey` 就是 subjectKey 本身） |
| 8 | `getActiveTextTokenRatios()` — `pricing.service.ts:416–449` | 按 `key.startsWith('text:')` 组装；subjectKey 用 `|` 分隔不会误入，但需判据守住 | 无需改逻辑，AC11 加「subjectKey 不污染 token 比率 map」断言 |
| 9 | `checkCostFloor()` — `pricing.core.ts:184–196` | 反比率上限 `floor(1e6/(costYuan×105))` 是**地板**口径；误换成目标利润率会误拒 | 改为 `floor(1e8/(costYuan×(10000+priceFloorBp)))`，`priceFloorBp=500` 时逐值等价（§6.8） |

### 6.2 定价主体 `PricingSubject`

- **生成规则（两路枚举，缺一不可）**：`ModelCatalogEntry`（`deletedAt IS NULL`）× 能力档位 × `UpstreamRoute` 命中的 `upstream` → 笛卡尔积去重。
  1. **档位行**：`enumeratePricingSpace()`（`pricing.space.ts:24–61`）产出图片 `1K:1`…`4K:4`、视频 `<res>:<duration>:<mode>:ri:rv`、`image_variant` / `image_edit:<model>`、`audio:voice|music`、`text` 单行。
  2. ⭐ **文本 token 反比率行不在 `enumeratePricingSpace()` 里**：由 `enumerateTextTokenRows()`（`pricing.space.ts:93–103`）单独产出 **8 模型 × in/out + 7 条 cache = 23 行**（与附录 A 生产 23 条 `text:<model>:*` 逐数吻合）；该函数的注释仍写「5 模型 × 14 行」，是陈旧注释，**以 `TEXT_TOKEN_MODELS` 数组实际 8 个为准**。`rebuild` 必须同时消费两个枚举，否则 23 条精确计费主体全漏。
  3. `spec` = **平台档位规格**，沿用 `pricing.core.ts:87–107` 的规范化口径；文本 token 规格为 `in|cache|out`。
- **`UpstreamRoute` 命中算法**：现网不是 (modelKey, capability) 精确表，而是 `UPSTREAM_ROUTE_SEEDS`（`packages/shared/src/upstreamRouting.ts:319–338`）的 `matchType ∈ prefix|exact|regex|default` + `priority` 降序 + `capability` 过滤（`*` 通配）+ `enabled=true` 的**第一条命中行**；链尾 `default → agnes_hub` 保证每个模型都解析到 upstream。取值 `agnes_hub / apimart / stepfun / minimax / fal / zhipu`（schema.prisma:685 注释只列 5 个，`zhipu` 见 seeds:335，是注释陈旧）。`providerBinding` 类型仅 4 值（`studioModelCatalog.ts:34`），`zhipu-http` 为类型声明但当前目录播种无此行 —— D4 映射表按类型声明保留，覆写由运营完成。
- ⚠️ **两个 `spec` 不是同一个东西**：`PricingSubject.spec` 是平台档位规格（含张数 / 时长 / 参考素材），`CostRate.spec` 是上游成本行规格（`1K` / `768p:5s` / `per_100_chars` / `per_song` / `per_1m_tokens_in`）。二者**不要求字符串相等**，由 §3.5.4 的 `billableUnit + unitQuantity + unitsPerRequest` 归一规则建立映射；`resolveUnitCost` 不得用 `subjectKey` 直接去 `CostRate` 做字符串匹配。
- ⭐ **U6 视频归一（防止「有成本行却查不到」）**：成本行的 `modelKey` 与售价键不同构（`seedance-2.0-fast` vs `seedance-2.0`，`h3-max` 单行覆盖两个售价家族）。`resolveUnitCost` 对视频必须先经 `videoPriceFamily()`（`pricing.core.ts:46–51`）把 `modelKey` 归到 `default | minimax-h3 | h3-max | h3-max-turbo`，再按 `(family, canonicalVideoResolution, duration)` 查成本行；家族内多行按 D5 优先级取最可信者，**禁止 `modelKey` 字符串直等**。未覆盖的 (家族, 分辨率, 时长) 组合一律 `cost_missing`，不得拿 `h3-max` 的 `480p:5s` 行给 `h3-max-turbo / 2k` 用。
- **`billableUnit` / `unitsPerRequest` 生成**：按模态写死（图片 `image_count` + `count`；视频 `video_call` + 1 或 `video_second` + `duration`；音频 TTS `chars_100` + `null`；音乐 `song` + 1；文本 `token_<spec>` + 实际 token 数）。`unitsPerRequest=null` 表示运行时计量缺失（U1），主体标 `provisional` 且只保留档位价。
- **`subjectKey` 语法**：`capability|modelKey|spec|provider|upstream`；`modelKey` 先经 `modelOptionName()` 剥 `platform::` / `ch_xxx::` 前缀并小写（现网 `quoteTextTokens` 已因此踩过「prefixed key → constants-fallback」）。
- **`provider` 映射**：`providerBinding` → `gateway-openai-compat ⇒ agnes_hub 默认`、`fal-http ⇒ fal`、`minimax-http ⇒ minimax`、`zhipu-http ⇒ zhipu`；可由运营在主体登记页覆写（例：同为 `gateway-openai-compat` 但走 apimart 的 seedream 归 `volcengine`）。映射表落代码常量 + 后台可覆写，二类来源都写审计。
- **状态机**：`draft`（主体已登记）→ `cost_missing`（无有效成本行）→ `priced`（已物化出建议价）→ `published`（所在版本成为 active）；`offboarded` 由 S2 的下架联动置位。状态只能单向前进，`published → priced` 需经新版本发布。
- **S1 入口**：`POST /api/admin/pricing/subjects/rebuild`（幂等全量重建）+ 后台「定价主体」页逐条编辑。`rebuild` **只新增缺失主体，绝不修改既有行**（含 `status` 与人工覆写的 `provider` / `defaultSubjectKey`），并列出「目录有、主体无」差异供运营确认。S1 **不接** `onboard`（S2）。
- **BYOK 排除**：只登记 `channelId='platform'` 的主体；BYOK 用户自带 Key 的成本不进平台价目（沿用 `platform-channel.controller.ts` 硬编码 `id='platform'` 的既有语义）。

### 6.3 成本层 `CostRate`（单一人民币 + 单位归一）

**成本权威源只有一张表**：`CostRate`（现网 41 行静态种子，`costYuan` = 人民币元 / 计价单元）。下列两处 USD 数据面**不是成本权威源**：

1. `ProviderChannel.models[].pricing` 四元组（`inputPerM / outputPerM / cacheReadPerM / cacheWritePerM`）——由 `model-cost.ts resolveChannelModelCost` 解析，供 vendor `usage.cost`（USD）与展示预估使用；
2. pi-runtime `AGNES_COST_*_PER_M` 环境变量——同上。

按 D9，二者**一律不进 `resolveUnitCost`、不参与物化、不落 `costYuan`**。运营若要以其为依据，须按渠道结算单的人民币金额在成本登记页录入并填 `sourceRef`；系统不读汇率、不做运行时折算（§3.5.6）。

S1 提供唯一入口 `resolveUnitCost(subject, at)`：

- 查 `CostRate`：`costSource` 读**现网已有的 `CostRate.source` 列**（`@default("official_list")`，`schema.prisma:894`），按 D5 优先级 `channel_actual > negotiated > official_list > provisional`、`effectiveFrom ≤ at < effectiveTo` 取最新行，且 `unit` / `spec` 与主体的 `billableUnit` 按 §3.5.4 归一规则匹配（**不是字符串直等**，见 §6.2 的双 `spec` / U6 警示）；命中即取 `costYuan`。v1.1 曾写「新增 `costSource` 列」，v1.2 更正为复用 `source`，避免同义字段分叉。
- 归一化：`costYuanPerRequest = costYuan × unitsPerRequest / unitQuantity`；返回 `{ costYuan, costRateId, costSource, unit, unitQuantity, unitsPerRequest, costYuanPerRequest, provisional }`。
- **未命中 / `unitsPerRequest=null` / 只有 `per_second` 却缺时长 ⇒ 返回 `null`**，主体置 `cost_missing` 并计 `pricing_unit_mismatch_total`：**不猜价、不按 0 成本定价、不按 5s 锚点线性外推**（U2）。
- `sourceRef` 记录官方价目页 URL / 渠道结算单文件 id / 议价合同标识；`provisional=true` 的行（现网 agnes 三档、视频 4s 推算行、音频字符行）在发布门禁按「成本未确认」处理（S2 契约）。
- 写入侧**不存币种 / 汇率**；`AdminAuditLog` 记成本改动 before/after（含 `unit` 与 `unitQuantity`）；改成本只生成建议 diff，不改 active（§2.2）。

**SOP-3 hardening 归 S2**：把渠道 `pricing` 从 `models` JSON 列挪到独立列 / 独立表，使 `pull-models` 不再抹掉定价；S1 只保证 `resolveUnitCost` 从统一入口读，S2 换存储时该接口不变。

### 6.4 利润层 `MarginPolicy`

- `scope` 六档 + `scopeKey`：`global`（`*`）/ `modality`（`image`）/ `provider`（`volcengine`）/ `upstream`（`apimart`）/ `model`（`seedream-5.0-pro`）/ `model_spec`（`seedream-5.0-pro|4K:1`）。
- 解析算法（D6）：对给定主体按具体度从高到低逐档查 `status='active'` 且有效期覆盖的行，**首个命中即返回**，附带命中的 `marginPolicyId` 供物化快照；全未命中回 `global` 缺省行（`profitBp=1000`）。
- `priceFloorBp` 与 `profitBp` 分离：地板是「绝不低于」的硬线（缺省 5%），利润率是目标值；`checkCostFloor` 由硬编码 `FLOOR_MULTIPLIER=105` 改为读策略行的 `priceFloorBp`，等价关系 `ceil(costYuanPerRequest × (10000+priceFloorBp)/10000 ÷ 0.01) == ceil(costYuanPerRequest × (100 + priceFloorBp/100))`，`priceFloorBp=500` 时即现网 `ceil(costYuan × 105)`（现网 341 行是 `costYuanPerRequest = costYuan` 的 1:1 特例）。反比率行仍按每 1M token 成本口径校验（§6.5 警示），不混用两种成本。
- ⭐ **地板校验的输入必须跟着归一**（v1.2 补）：现网 `checkFloors()` 在 `pricing-publishing.service.ts:432` 传的是 `rate.costYuan`（**单单位成本**）。若只把乘数换成 `priceFloorBp` 而不改传参，图片 `count=3`／0.30 元每张时地板会按 `ceil(0.3×105)=32` 判，而真实一次请求成本是 `0.9` 元 ⇒ 应判 `ceil(0.9×105)=95`，**下限被严重低估**。S1 必须改为传 `costYuanPerRequest`（从 `unitSnapshot` 或 `resolveUnitCost` 复算），并把「图片 count=3」列为 AC9 定向用例。
- ⭐ **反比率上限是地板口径，不是目标利润率口径**（v1.2 修正 v1.1 §6.8 条件③ 的公式错）：现网 `checkCostFloor()` 对 `text:<model>:<spec>` 行的上限是 `floor(1e6/(costYuan×105))`（`pricing.core.ts:178/191`），对应 `priceFloorBp=500`；而物化用的 `r = floor(1e8/(costYuan×11000))` 对应目标 `profitBp=1000`。两者差约 4.8%，**不得混用**。改为策略派生后：`limit = floor(1e8/(costYuanPer1MToken × (10000+priceFloorBp)))`，`priceFloorBp=500` ⇒ `floor(1e6/(costYuan×105))`，与现网逐值相等。
- 后台按 scope 增删改，**每次写落 `AdminAuditLog` before/after**；同 scope 同时只允许一条 active（部分唯一索引或应用层 CAS，沿用发布流单 active 范式）。

### 6.5 物化与报价计算

**价格行（非 token）**：输入是 §3.5.4 归一后的**一次计价单元人民币成本**，不是裸 `CostRate.costYuan`：

```
costYuanPerRequest = costYuan × unitsPerRequest / unitQuantity     （§3.5.1）
credits            = max(1, ceil( costYuanPerRequest × (10000 + profitBp) / 10000 / anchorYuan ))
anchorYuan         = anchorCents / 100 = 0.01                       （人民币，1 credit）
```

与现网 `computeCreditsFromCost(costYuan, marginBp)` 的关系：`marginBp = 10000 + profitBp`，`marginBp=11000 ⇔ profitBp=1000`，两者数值逐字相等，故既有金标准测试无需改期望值。现网 341 条 active 行都是 `unitsPerRequest = unitQuantity = 1` 的特例（整条视频 / 单张图 / 单次音频 / 单轮文本），归一后数值不变——**这是「存量逐字不变」成立的前提，实施时必须有断言守住**。

**文本 token 反比率行**（`text:<model>:in|cache|out`，credits 存的是「每 1 积分可买多少 token」）：

```
r = floor( 1e4 / ( costYuan × (10000 + profitBp) / 10000 ) )
  = floor( 1e8 / ( costYuan × (10000 + profitBp) ) )
```

推导：每 credit 成本 = `r × costYuan / 1e6` 元，收入 `0.01` 元，要求 `0.01 ≥ r × costYuan/1e6 × (1+profit)` ⇒ `r ≤ 1e4/(costYuan × (1+profit))`。代入 `profitBp=1000` 得 `floor(9090.9…/costYuan)`，与现网 `floor(1e6/(costYuan × marginBp/100))` 在 `marginBp=11000` 时逐字相等。

⚠️ **此处的 `costYuan` 是 `per_1m_tokens` 行的「每 100 万 token 人民币成本」，不是 `costYuanPerRequest`**。文本是唯一按物理量计价的模态：公式里的 `1e6` 已等价于 §3.5 的 `unitQuantity=1e6` 归一，实际用量 `unitsPerRequest=tokens` 在结算时经 `charge=ceil(tokens/r)` 体现。**禁止把 `costYuanPerRequest` 代入本式**，否则会产生 1e6 倍错价；该约束由 AC9 的定向用例守住。

**取整 ladder**（10-13 §5.2）作为**可选开关** `roundingLadder: off|on`，S1 默认 `off`（1 分精度，诚实反映成本）；开启时才按 <50/50–500/>500 三段取整。避免默认开启破坏存量等价。

**`basis` 语义扩展**：`legacy-equivalent`（存量）/ `launch-reprice`（存量 v2 种子）/ `auto-derived`（物化生成）/ `ops-modified`（人工覆写）。`ops-modified` 必须带 `reason`，否则写路径 400；覆写值不参与后续自动重算，除非运营显式解除覆写。

**`PricingMaterializer`**：输入 draft 版本 id + 主体集合 → 逐主体 `resolveUnitCost` + `resolveMargin` + 公式 → 与现有条目 diff → 只 upsert `basis != 'ops-modified'` 的条目；写入时同步落 `costSnapshotYuan = costYuanPerRequest` 与 `unitSnapshot = { billableUnit, unitQuantity, unitsPerRequest }`。幂等（同输入二次运行 diff 为空）；产出 `{ added, changed, unchanged, missingCost[], unitMismatch[], floorViolations[], noCostCoverage[] }`。**成本 / 策略变更绝不自动写 active**：只生成「建议价目 diff」，运营确认后写进 draft，走既有 `diff → publish → rollback`。

### 6.6 解析链 `PricingService.quote()`

新增维度解析，顺序固定（保留灰度语义，D3 双轨）：

1. 灰度表 `subjectKey` 精确行（名单命中时）
2. global `subjectKey` 精确行
3. model 默认行 `capability|modelKey|*|*|*`
4. legacy `matchKey` 档位行（现网全部 341 行走这里）
5. `capability:*` 默认行
6. `legacyPriceOf` 常量兜底 + `degraded=true` + 指标 + warn（D8）

**纪律**：`quote()` 永不 throw（既有生命线）；每一级回落都记 `pricing_resolution_total{level, subjectKey?}`；灰度缺行沿用现网「视数据事故落 global」语义；`PRICING_SOURCE=constants` 旁路（现网 `pricing.service.ts:191–193` 直接返回 `RULE_VERSION_CONSTANTS_FALLBACK`）**返回值逐字不变**，仅新增一次 `constants_fallback` 计数与 `degraded=true` 标记，不改旁路行为。

**`TEXT_TOKEN_MODELS` 数据化（两处必须同步）**：现网 `TEXT_TOKEN_MODELS` 是 8 个硬编码白名单（数组实际 8 个，代码注释自称「5 个」已陈旧），导致新上架模型直接落 USD 兼容兜底。S1 改为「`PricingSubject` 中存在该模型 `in/out` 反比率行即视为已知」，`TEXT_TOKEN_MODELS` 保留为启动自检常量（不删、不再作为运行时判据）。⭐ **`includes` 判断在 `quoteTextTokens()`（`pricing.service.ts:259`）和 `prepareTextTokenQuote()`（`:362`）各有一份**，必须同时替换：只改前者会让 SSE 流式预估继续走 USD 兜底，与结算分叉，直接破坏 `pricing.service.test.ts:610` 的 `plan.compute(usage) === quoteTextTokens(usage).credits` 同源契约。两条路径的其余行为（cache 缺行并入 in、`modelOptionName` 剥前缀、既有 USD 兜底）逐字不变；按 §3.5.6，该 USD 路径**不是权威成本源**，命中时按 D8 计 `degraded=true` + 指标。

**`MarginPolicy` 两处消费点同步**：`readCurrentMarginBp()`（`pricing.service.ts:478–485`）与 `readMarginBp()`（`agent.service.ts:3765–3775`）现均为 `findFirst({ orderBy: { createdAt: 'desc' } })`。S1 引入多行 scope 后，这会取到「最后创建」的任意一行（可能是某模型的 30% 利润），污染 USD 兼容兜底与 Q2 展示预估 ⇒ 两处统一改为 `findFirst({ where: { scope: 'global', status: 'active' } })`，读失败仍缺省 11000bp；AC12 用「新增一条非 global 策略行后两处仍返回 11000」机检守住。

**展示端点**：master `GET /api/pricing/quote`（`pricing.controller.ts:31–54`）已接受 `modelKey / resolution / duration / ...` 并复用 `quote()`（展示值 == 实扣值），`degraded` 现由 `ruleVersion === 'constants-fallback'` 推导；同期还有 `GET /api/pricing/active`（`:17–21`，返回 `textTokenRatios`，前端徽标用）。S1 给 quote 端点扩 `provider / upstream / spec` 三个可选参数（缺省与计费调用保持一致），并把 `PricingQuote.degraded` 直接透出（不再靠 ruleVersion 反推）；**灰度折扣不预显**（现网设计取舍，保留）。`active` 端点须断言 subjectKey 行（`|` 分隔）不会误入 `text:` 前缀组装（AC11）。

**开关**：`PRICING_SUBJECT_KEYS`（`on|off`，缺省 `on`）。`on` 时按上述六级解析；`off` 时**只保留最后三级**（legacy `matchKey` → `capability:*` → 常量兜底），行为与 S1 之前逐字一致，作为发布回滚开关。开关只影响解析路径，不改表结构与已发布价目。

#### 6.6.1 缓存层双索引（解析链生效前提，v1.2 新增）

> ⭐ 这是本轮自审最重要的补漏：现网 `loadActiveTable()`（`pricing.service.ts:504–527`）只做 `entries.set(e.matchKey, e.credits)` **单 Map**，`loadGrayTable()`（`:533–562`）同理。若只按 §6.1 加 `subjectKey` 列、按 §6.6 改 `quote()` 解析顺序，而不改这两个加载器，新键行虽然入库却永远进不了表快照 ⇒ 六级解析的前三级恒 miss ⇒ **精确重演上一轮缺口 #2「后台写了价，计价侧永远构造不出这个键」**。

改造契约：

1. `PriceTable` / `GrayTable` 各增 `subjectEntries: Map<string, number>`；加载时对每个 entry：`entries.set(e.matchKey, e.credits)` 保持不变（legacy 语义零改）；`if (e.subjectKey) subjectEntries.set(e.subjectKey, e.credits)`。
2. `quote()` 第 1–3 级查 `subjectEntries`，第 4–5 级仍查 `entries`；灰度表双 Map 对称处理，缺行沿用「视数据事故落 global」语义。
3. `PRICING_SUBJECT_KEYS=off` 时**跳过 `subjectEntries` 的读取**（不是跳过加载），保证回滚后行为逐字一致。
4. `invalidate()`（`:123–129`）必须同时清 `cache` 与 `grayCache` 两个对象（现网已是整体置 null，双 Map 随对象一起失效）；`PriceListVersion.revision` 的 S3 轮询只负责多实例广播，不替代本处索引。
5. 判据：把一条 subjectKey 行的 `subjectKey` 列删掉（只留 `matchKey` 同值）⇒ 该主体必须回落到 legacy 价（AC11 变异）；把 `matchKey` 填成占位值 ⇒ 违反 §6.1 唯一约束，迁移守卫必须 RED。

**向后兼容**：master 生产代码共 **15 处 `pricing.quote()` 调用点**（`studio.service.ts` 10 处：641/644/647/650/803/1093/1326/1509/2159/2362；`material.service.ts` 4 处：352/354/417/533；`pricing.controller.ts` 1 处：44）+ **3 处 token 精确计费**（`agent.service.ts:3786` 的 `prepareTextTokenQuote`、`:4342` 与 `:4732` 的 `quoteTextTokens`）。`PricingQuery` 增 `provider? / upstream? / spec? / subjectKey? / chars?` 等**可选字段**，旧调用零改动；`chars?` 按 D11 只作类型契约占位、S1 计价链不消费。`v1` 等价金标准 4/4 与「全网等价自检」逻辑只作用于纯 `legacy-equivalent` 版本，新版本混入 `auto-derived` 时继续跳过自检（现网 `onModuleInit:145–175` 已按 `legacyRows === totalRows` 条件化，无需改造，但 AC5 要断言）。

### 6.7 后台配置面（最小集）

| 端点 | 用途 | 写审计 |
|---|---|---|
| `GET/POST /api/admin/pricing/subjects` · `POST /subjects/rebuild` | 主体列表 / 人工登记 / 幂等重建 | `pricing-subject.*` |
| `GET/PUT /api/admin/pricing/cost-rates` | 成本行按 (upstream, provider, model, spec) 登记 **人民币金额**、`unit` / `unitQuantity`、有效期、来源凭据；页面不提供币种 / 汇率字段（D9），美元报价由运营按结算单折算后录入 | `pricing-cost.*` |
| `GET/PUT /api/admin/pricing/margin-policies` | 六档 scope 利润率与地板 | `pricing-margin.*` |
| `POST /api/admin/pricing/versions/:id/materialize` | 物化建议价写进 draft（幂等） | `pricing-version.materialize` |
| `GET /api/admin/pricing/versions/:id/readiness` | S2 门禁数据源（S1 先提供只读判定函数） | — |

页面：`AdminPricingSubjectsPage.vue`、`AdminCostRatesPage.vue`、`AdminMarginPoliciesPage.vue`，在 `AdminLayoutPage` 菜单「渠道定价」组内追加；路由与 `admin-api.ts` 同步登记。

**既有端点扩展（三处同步，缺一处字段就静默丢）**：`PUT /api/admin/pricing/versions/:id/entries` 现网只透传 `matchKey / capability / credits / basis / costRateId` 5 字段 —— ① controller 的 `parseEntriesBody()`（`pricing-publishing.controller.ts:39–68`）、② service 的 `PublishEntryInput` 接口（`:66`）、③ `upsertEntries()` 的 create/update 两处（`:195–215`）必须**同时**扩到 `subjectKey / costSnapshotYuan / unitSnapshot / profitBpSnapshot / costRateId / marginPolicyId / reason`，使运营覆写（`basis='ops-modified'`）能带理由与单位快照落库；`diffSummary` 增 `missingSubject` / `marginSnapshot` / `unitMismatch` 三个只读字段。物化服务直接写 `PriceListEntry`，不经该端点，两条写路径共用同一套字段校验。另 `createDraftFromActive()`（`:87–180`，复制点 113 / 173）只复制 5 字段，从 active 建 draft 时新列会全丢 ⇒ 复制清单同步扩展（AC13）。

⚠️ **真实丢字段机理（v1.2 纠偏）**：全局 `ValidationPipe(transform, whitelist)` 确实会剥掉无装饰 DTO 属性，但 `pricing-publishing.controller.ts` 用的是 `@Body() body: Record<string, unknown>` + **手写 `parseEntriesBody()` 白名单**，`whitelist` 对它不生效 —— 字段是**被手写解析器丢掉的**，不是被 ValidationPipe 吞的。两条纪律都要守：新增 controller 一律沿用 `Record<string, unknown>` 手校模式并显式透传每个新字段；若确需 DTO class，必须逐字段加装饰器并写透传回归测试。判据用「提交带 `subjectKey` / `profitBpSnapshot` 的 entries，读回两字段必须非空」。

### 6.8 发布门禁契约（S2 实现，S1 定函数）

`validatePublish(draftId)` 返回 `{ ok, violations[] }`，硬拒条件：① 任一 `published` 主体缺有效成本行（含 `provisional=true`）；② 任一价格行 `credits < ceil(costYuanPerRequest × (10000+priceFloorBp)/10000 ÷ 0.01)`（`priceFloorBp` 取该条目物化时命中的 `MarginPolicy` 行，即 `marginPolicyId` 所指行；缺失则回 `global` 缺省 500）；③ **任一反比率行 `r > floor(1e8/(costYuanPer1MToken × (10000+priceFloorBp)))`**（= 现网 `floor(1e6/(costYuan×105))`，`priceFloorBp=500` 时逐值等价；⚠️ v1.1 误写成 `floor(1e4/(costYuan×(1+profit)))`，那是**目标利润率下的物化值**而非地板上限，混用会误拒/误放）；④ `ops-modified` 条目缺 `reason`；⑤ 同一 `subjectKey` 在 draft 内重复；⑥ **单位不对齐**：`unitMismatch[]` 非空（`unit` 不在受控枚举 / `unitQuantity ≤ 0` / `unitsPerRequest` 缺失却标了精确价 / 视频档位靠锚点外推）；⑦ **币种违约**：出现 `currencySrc` / `fxRate` / `fxUsdCny` 等非人民币字段。

⭐ **与现网门禁的关系（v1.2 纠偏）**：`publish()`（`pricing-publishing.service.ts:288–368`）**已经有**地板硬拒 —— `:306` 调 `checkFloors()`、`:323–330` 在 `floorViolations.length > 0` 时抛 `BadRequestException`，且 `:310–312` 对 `missingCost` 只告警不硬拒。所以 S1 不是「等 S2 才把门禁接进 publish」，而是：**S1 直接扩展既有 `checkFloors()` 的判据集合**（补 `provisional` / `unitMismatch` / `subjectKey` 重复 / `ops-modified` 缺 reason，并把传参从单单位成本改为 `costYuanPerRequest`），`validatePublish()` 复用同一判定函数；**S2 只补主体级门禁**（主体状态机联动、违规清单结构化 400 返回、上架时 `provisional` 阻断）。既有 `diffSummary` 的字段扩展（`missingCost` / `noCostCoverage` 已有，补 `missingSubject` / `marginSnapshot` / `unitMismatch`）同属 S1。

### 6.9 迁移与兼容（生命线）

1. 全部新增列 **nullable / 带缺省**，一次 additive migration；不删列、不改类型、不重建表。
2. `PricingSubject` 首次 `rebuild` 从现网 13 个在售模型 + **`enumeratePricingSpace()` 档位行** + **`enumerateTextTokenRows()` 的 23 条反比率行**（§6.2）三路生成，人工覆写存活（insert-if-absent）。漏第二路会让 23 条精确计费主体全部缺失。
3. `MarginPolicy` 现网单行迁移为 `scope='global', profitBp=1000, priceFloorBp=500, phase='launch'`（**沿用已有 `phase`，避开 `@unique` 冲突**）；`marginBp=11000` 保留只读，写路径不再消费。后续新增行按 `'scope:<scope>:<scopeKey>'` 生成唯一 `phase`。同步把两处 `findFirst(orderBy createdAt desc)` 改按 `scope='global'` 精确查询（§6.6）。
4. `CostRate` 41 行：**`source` 列缺省已是 `official_list`，无需回填**（v1.1 误写「回填 `costSource`」）；只回填 `unitQuantity`（`per_image` / `per_video` / `per_call`+`per_song` 一律 1；`per_call`+`per_100_chars`=100；`per_1m_tokens`=1e6）；**不回填任何币种 / 汇率列**（D9）。agnes 三档、视频 4s 两条推算行、音频字符行、音乐限免行标 `provisional=true`。视频成本行的 modelKey 漂移（U6）不改写历史行，由 `resolveUnitCost` 的 family 归一吸收。
5. **active `v2-launch` 的 341 条行一条不改**：S1 只在新建 draft 时物化 `subjectKey` 行；旧 `matchKey` 行原样复制（**并同步扩展 `createDraftFromActive()` 的复制清单**，见 §6.1.1 #6）。新增行的 `matchKey = subjectKey`（§6.1），两列同值。迁移必须断言这 341 条满足 `unitsPerRequest = unitQuantity = 1` 的特例（§6.5），否则「逐字不变」不成立；同时断言新行 `matchKey` 非空且不与任何 legacy 键撞唯一约束。
6. 历史 `PointTransaction` 一行不改；8456 笔 `ruleVersion=NULL` 在 S3 报表里标「不可归因（历史）」。
7. 回滚判据：关闭新解析链（feature flag `PRICING_SUBJECT_KEYS=off`）后，行为与 S1 之前逐字一致，等价金标准 4/4 全绿。

---

## 7. S2–S4 接口契约（只定边界，不展开设计）

| 契约 | 生产方 | 消费方 | 不变式 |
|---|---|---|---|
| `PricingSubject` 状态机 + `rebuild` | S1 | S2（onboard / offboard 事务） | 上架必产生主体，下架必置 `offboarded`，同一 `modelKey` 不重复 |
| `validatePublish(draftId)` | S1 | S2（publish 事务） | 违规清单非空 ⇒ publish 400，版本状态零变化。⚠️ 现网 `publish()` 已有地板硬拒（`pricing-publishing.service.ts:323–330`），S1 扩的是同一 `checkFloors()` 判据集合，S2 补的是主体级门禁与结构化 400，不是从零接线 |
| `PricingQuote` 价格锁上下文 | S1 | S3（UsageRecord / PointTransaction） | 每笔扣费可回溯 `ruleVersion + costYuanPerRequest + profitBp + subjectKey + unitSnapshot` |
| 单位归一契约（§3.5） | S1 | S3（`UsageRecord` 物理量）/ S4（账单聚合） | 上游物理量 → 人民币元/计价单元 → credits → 人民币账单，四层单位不得跳层；S3 落实际用量后按同一 `billableUnit` 复核，不重算历史 |
| `PriceListVersion.revision` | S1 | S3（多实例缓存失效） | publish / rollback 必 `+1` |
| `resolveUnitCost(subject, at)` | S1 | S4（渠道账单差异校准） | 返回人民币 `costYuanPerRequest` 与单位三元组；校准结果只产出修正建议，人工确认后才写 `CostRate`，不写汇率 |
| `UsageRecord`（S3 产） | S3 | S4（Bill / 日结 / 看板） | 每请求 / 每回合恰好一行，与 `PointTransaction` 1:1 |

---

## 8. 一致性与错误处理

| 场景 | 处置 |
|---|---|
| 价目表缺行 / DB 异常 / 无 active / 启动自检失配 | 沿用现网四条兜底路径，`quote()` 永不 throw；按 D8 计指标 + warn + `degraded=true` |
| 成本行缺失或 `provisional` | `resolveUnitCost` 返回 `null` ⇒ 主体保持 `cost_missing`，**不猜价、不按 0 成本定价**；发布门禁硬拒 |
| 单位不对齐（`unit` 未知 / `unitQuantity≤0` / 缺 `unitsPerRequest` / 按秒却无时长） | 计 `pricing_unit_mismatch_total`，该主体不物化精确价，保留档位一口价并标 `provisional`；**禁止把上游物理量直接当积分乘**；发布门禁条件 ⑥ 硬拒 |
| 上游只给美元报价 | 不做运行时折算；成本登记页要求填人民币金额 + `sourceRef`（结算单），缺失则视为成本未确认 |
| 利润率策略零命中 | 回 `global` 缺省行（迁移保证必存在）；若连 global 都缺失则视为数据事故，走常量兜底 + 告警 |
| 多实例 30s 计价缓存 | `PriceListVersion.revision` 由 S3 做轻量轮询失效；S1 不引入消息中间件（YAGNI） |
| 并发写成本 / 策略 | 沿用 `platform-channel.controller.ts` 的 `updateMany({ where: { ...原文 } })` 乐观锁范式，冲突 409 不覆盖 |
| 发布并发 | 沿用单 `$transaction`：旧 active → archived、draft → active、写审计、清缓存，任意时刻至多一个 active |
| 改价与在途请求 | D7 价格锁；生成中途调价不影响进行中的请求，失败退款按 `lockedCredits` 原额 |
| 历史账单 | 按落账时的快照重算，永不按新价回算（账务不可变） |

---

## 9. 可观测性

| 指标 / 日志 | 含义 | 告警 |
|---|---|---|
| `pricing_resolution_total{level}` | 解析链每级命中数 | `level=constants_fallback` 非零即告警（治生产 24 笔静默兜底） |
| `pricing_subject_total{status}` | 主体状态分布 | `cost_missing` 持续增长告警 |
| `pricing_materialize_total{outcome}` | 物化成功 / 缺成本 / 地板违规 | 地板违规非零告警 |
| `pricing_cost_source_total{source}` | 成本来源分布 | `provisional` 占比 > 20% 告警 |
| `pricing_unit_mismatch_total{capability, reason}` | 单位归一失败（U1–U4 的可观测面） | 非零即告警；`reason=inferred_units` 出现即视为数据事故（禁止外推） |
| `AdminAuditLog` `pricing-margin.*` / `pricing-cost.*` | 利润率 / 成本改动 before-after（含 `unit` / `unitQuantity`，金额一律人民币） | 变更即留痕，无需额外告警 |

---

## 10. 验收判据（S1，逐条可机检）

| ID | 判据 |
|---|---|
| **AC1** | 新建一个在售文本模型并登记主体 → 后台为该 (模型, upstream) 设人民币成本行、设 `profitBp=1500` → `materialize` 生成 draft 行 → publish → 该模型调用按新价扣费，且 `PricingQuote` 返回 `subjectKey / costYuanPerRequest=… / billableUnit / unitSnapshot / profitBp=1500 / ruleVersion / priceListVersionId` |
| **AC2** | 同一模型换 `upstream` 设不同成本 ⇒ 两条 `subjectKey` 各自独立计价，互不影响；BYOK `channelId` 不产生主体 |
| **AC3** | 缺成本主体 `status=cost_missing`，`materialize` 报告 `missingCost[]` 且不写价目行；`validatePublish` 返回违规清单 |
| **AC4** | `ops-modified` 条目在二次 `materialize` 时价格不变；缺 `reason` 的覆写写路径 400 |
| **AC5** | 存量 341 条 `v2-launch` 行价格逐字不变；等价金标准 4/4 全绿；`PRICING_SUBJECT_KEYS=off` 时全链行为与上线前一致 |
| **AC6** | `profitBp=1000` 时价格行公式与现网 `computeCreditsFromCost(cost, 11000)` 逐值相等；反比率公式与现网 `floor(1e6/(cost×110))` 逐值相等 |
| **AC7** | 新登记模型（不在旧 `TEXT_TOKEN_MODELS` 8 个白名单内）走 `quoteTextTokens` 精确反比率，不再落 USD / 常量兼容兜底 |
| **AC8** | 每次 `constants-fallback` 计数 +1 且返回 `degraded=true`；`GET /api/pricing/quote` 与计费 `quote()` 对同一参数返回同值 |
| **AC9**（单位链） | 逐模态断言 §3.5.4 归一：图片 `count=3` ⇒ `costYuanPerRequest=3×单价`；视频有 `per_second` 行且 `duration=10` ⇒ `10×秒价`，若同时删掉 `per_second` 行与 `768p:10s` 整条行、只留 5s 锚点 ⇒ 报 `unitMismatch` 并置 `cost_missing`，**绝不 5s×2 外推**；音频 TTS 缺 chars ⇒ 主体 `provisional` 且只保留档位价；音乐限免 `costYuan=0` ⇒ 不物化；文本按 token 反比率与现网逐值相等，且把 `costYuanPerRequest` 误代入反比率公式的负例必须 RED。全部 341 条 legacy 行满足 `unitsPerRequest=unitQuantity=1` 特例断言 |
| **AC10**（币种） | `CostRate` / `PriceListEntry` / `PricingQuote` / 后台写入 DTO 中**不存在** `currencySrc` / `fxRate` / `fxUsdCny` / `usdPerM` 字段；改 `PRICING_FX_USD_CNY` 环境变量对任一 `materialize` 与 `quote()` 结果零影响；成本页提交带币种字段返回 400；`Bill` 金额单位为人民币元 |
| **AC11**（接线守卫） | ① 新建一条 `subjectKey` 价目行后，`loadActiveTable()` 的 `subjectEntries` 必须含该键、`quote()` 必须命中它（而非回落 legacy 价）；删掉该行 `subjectKey` 列 ⇒ 必须回落 legacy 价，测试 RED；② `PRICING_SUBJECT_KEYS=off` 时该行不生效；③ subjectKey 行不污染 `GET /api/pricing/active` 的 `textTokenRatios`；④ 新登记模型同时让 `quoteTextTokens` 与 `prepareTextTokenQuote` 走精确路径，`plan.compute(usage) === quoteTextTokens(usage).credits` 继续绿 |
| **AC12**（策略多头读） | `MarginPolicy` 新增一条 `scope='model', profitBp=3000` 行后，`readCurrentMarginBp()` 与 `readMarginBp()` 仍返回 11000bp；新增行的 `phase` 唯一且不撞 `launch`；`phase` 重复的 create 必须报错而非静默覆盖 |
| **AC13**（发布流字段透传） | 经 `PUT /:id/entries` 提交带 `subjectKey / costSnapshotYuan / unitSnapshot / profitBpSnapshot / marginPolicyId / reason` 的条目，读回逐字段非空；从 active 建新 draft 后这些列全部保留；`ops-modified` 缺 `reason` 返回 400 |
| **AC14**（地板与 U6 归一） | 图片 `count=3`、0.30 元/张 ⇒ 地板下限按 `ceil(0.9×105)=95` 判定，**不是** `ceil(0.3×105)=32`；反比率行上限按 `priceFloorBp`（改 `profitBp` 不影响上限）；把 `seedance-2.0-fast` 成本行误按字符串直等查 `seedance-2.0` 主体 ⇒ 必须报 `cost_missing` 而不是拿别的家族行凑数；`h3-max-turbo/2k` 缺成本行 ⇒ 不外推 `h3-max/480p:5s` |

**变异自检（必须 RED）**：① `profitBp` ±1 bp；② 删除一条 `CostRate` 行；③ 解析链把 `subjectKey` 与 `matchKey` 优先级对调；④ 去掉 `modelOptionName` 前缀归一；⑤ 让 `ops-modified` 参与自动重算；⑥ **把 `unitQuantity` 从 1e6 改成 1（或让 `unitsPerRequest` 恒等于 1）**；⑦ **删掉 `loadActiveTable()` 的 `subjectEntries` 索引（或把 `prepareTextTokenQuote` 的 `includes` 判断改回白名单）**。七处各跑定向测试，任一恒绿即判据失效，须先修判据再继续（项目保命纪律：变异不 RED 先疑伪变异与判据自匹配恒绿；⭐ 判 RED 必须用完整 stdout 的 `AssertionError` / `failing tests` 标记，不可用 `| tail` 吃退出码）。

**回归红线**：`pricing.equivalence.integration.test.ts` 4/4、`pricing.service.test.ts`、`pricing-publishing.service.test.ts`、`payment.integration.test.ts` 全绿；`vue-tsc` 零新增错误；仅改后端 + ops-console 页面时 `design-token.test.ts` 仍需跑。

---

## 11. 风险与权衡

| 风险 | 缓解 |
|---|---|
| 双轨键过渡期两套解析并存，运营困惑 | 后台明确展示「精确键 / 档位键」两栏与命中来源；`level` 指标可查；S4 完成后再评估是否单轨化（不在本轮） |
| 成本来源不准（聚合渠道实际价与挂牌价差 4–7 折） | D5 优先级 + `sourceRef` 凭据 + `provisional` 标记；S4 渠道账单校准闭环 |
| 利润率被误配成负值 / 击穿地板 | 写路径校验 `profitBp ≥ priceFloorBp`；`validatePublish` 二次硬拒；审计留痕 |
| 新字段被静默丢弃 | **真实机理**：`parseEntriesBody()` 手写白名单 + `PublishEntryInput` + `upsertEntries()` 三处只透传 5 字段（不是 ValidationPipe 对 `Record<string, unknown>` 生效）。三处同步扩字段 + 透传回归；若另用 DTO class 才需要防 `ValidationPipe(whitelist)` |
| ⭐ **新增 subjectKey 行因缓存只按 `matchKey` 建索引而静默不生效**（重演上一轮缺口 #2 形态） | `loadActiveTable()` / `loadGrayTable()` 双 Map（§6.6.1）+ AC11 变异守卫；这是本轮自审识别出的最高风险项 |
| ⭐ **`MarginPolicy` 多行 scope 撞 `phase @unique` / 污染两处 `findFirst`** | 确定性 `phase` 生成 + 两处改按 `scope='global'` 精确查询（§6.1 / §6.6）+ AC12 |
| ⭐ **地板校验仍按单单位成本 ⇒ 多单位请求下限被低估** | `checkFloors` 改传 `costYuanPerRequest`（§6.1.1 #5 / §6.4）+ AC14 |
| **上游单位与平台档位不同构（U1–U6）**：视频秒 vs 阶梯、音频字符 vs 按次、图片张数编进键、参考素材无成本行、美元口径断裂、视频 modelKey 漂移 | §3.5.4 归一规则写死 + `unitQuantity/unitsPerRequest` 显式建模 + U6 按 `videoPriceFamily()` 归一；缺失一律 `cost_missing` / `provisional`，禁止外推；S3 补 metering、S4 补渠道账单校准 |
| 美元报价渠道的汇率风险 | D9 把折算移到录入侧并绑 `sourceRef` 结算凭据；运行时零汇率字段，`AC10` 用环境变量变异守住「改汇率不影响计价」 |
| additive 迁移在 SQLite 上加唯一索引 | 先回填再建索引；`subjectKey` 可空列多 NULL 在 SQLite 合法；迁移脚本自带幂等重跑 |
| 范围蔓延到账单 / 发票 | §2.3 No-Go + §5 分期表；S1 验收判据不含任何账单表 |

---

## 12. 决策记录

| # | 决策 | 来源 |
|---|---|---|
| 1 | 采用方案 A（扩展现网三层并物化），明确否决 B（独立规则引擎）与 C（只补表单） | 2026-11-14 设计评审，用户批准 |
| 2 | 规格边界 = 总纲 + S1 详规，S2–S4 只定接口契约 | 2026-11-14 用户选择 |
| 3 | 利润率按成本加成率 markup（D1）、账单不含税控发票（D2）、不推倒现有体系（D3） | 2026-11-14 设计评审「理解回写」三条假设，用户确认未纠正 |
| 4 | 定价主体维度含 `provider` 与 `upstream` 两个不同字段，BYOK 排除 | D4 |
| 5 | 常量兜底升级为可告警 | D8 |
| 6 | 本文不改任务管理工程路标（v1.3 冻结）、不碰 C-2a PR #866 | 项目主线纪律 |
| 7 | 补齐「上游计费单位 → 平台计价单位」四层单位链（三次换算）与归一契约（§3.5），显式登记 U1–U6 错配缺口 | 2026-11-14 用户评审意见 ①；原规格未体现。U6（视频 modelKey 漂移）由 v1.2 自审补入 |
| 8 | 成本单一人民币口径（D9）：不设币种 / 汇率列、不做运行时折算；美元报价在录入侧按结算单折人民币 | 2026-11-14 用户评审意见 ② |
| 9 | **v1.2 以 master `b5088ed6` 干净快照逐条复核事实断言**，修复 14 处偏差并新增 §6.1.1 现网改造清单、§6.6.1 缓存双索引、AC11–AC14 | 2026-11-14 用户指令「基于最新代码实现，自我审核修改补充完善后继续推进」；判接线一律以 master 为准，不信陈旧工作树 |
| 10 | 音频 TTS 精确计费不进 S1，仅补 `PricingQuery.chars?` 类型占位（D11） | v1.2 自拍板，收口 v1.1 遗留的待裁决项，避免范围扩张又不锁死 S3 契约 |

---

## 附录 A：生产基线数据（2026-11-14 只读取证）

```
PriceListVersion : v2-launch(active, 341 条 / 211 条 launch-reprice) ; v1-legacy-equivalent(archived, 318 条)
TEXT_TOKEN_BILLING: on（lnkpi-api 容器 env）
PointTransaction : 10522 笔 ; ruleVersion NULL 8456 / v2-launch 1920 / v1 122 / constants-fallback 24
                  model 非空 5104 ; kind consume 8271 / refund 1020 / freeze 1018 / release 171 / grant 42
CostRate         : 41 行 ; ModelCatalogEntry 在售 13 ; PricingGrayRelease 空
Order            : 30 (PAID 8 / PENDING 22) ; Payment 8
active 价目键样例: image:1K:1=33, image:1K:2=66, image:4K:1=323, audio:voice=5, audio:music=15
text:<model>:* 反比率行: 23 条
```

## 附录 B：10-13 设计稿 vs 现网 schema 差异登记

| 设计稿（§4.1） | 现网落地 | 本文处置 |
|---|---|---|
| `CostRate.unitCostCents Int`（人民币分） | `costYuan Float`（元） | 沿用 `costYuan`，不换算单位；**不新增 `currencySrc/fxRate`**（D9 单一人民币）；改为新增 `unitQuantity` 承接计量单位归一（§3.5.4） |
| `CostRate.effectiveFrom/To`、`sourceUrl`、`volumeTier` | 无 | `effectiveFrom/To` 补列；`sourceUrl` 折进 `sourceRef`；`volumeTier` 不做（无议价阶梯需求，YAGNI） |
| `MarginPolicy.marginDefault Float 1.10/2.50/3.50` | `marginBp Int 11000` | 以 `profitBp`（加成部分）为写入口；`marginBp` 保留只读兼容；`phase` 保留作审计标签 |
| `MarginPolicy.marginByCap Json` | `capabilityOverrides String?`（注释「P1 重定价消费」，实际未消费） | 由六档 scope 多行取代；`capabilityOverrides` 不再作为写入口 |
| `MarginPolicy.fxUsdCnyMilli`、`priceFloorMul` | 无（`resolveFxUsdCny` 走 env；`FLOOR_MULTIPLIER=105` 硬编码） | **`fxUsdCny` 不进定价链路**（D9；既有 env 只服务展示预估与兼容兜底，S1 不动）；地板改 `priceFloorBp` |
| `PriceListVersion.rules Json` 物化全量档 | `PriceListEntry` 关系表 + `matchKey` | 沿用关系表，新增 `subjectKey` 列，不回退到 JSON |
| `PointLedger.lockedCredits` | 无 | 由 S3 价格锁落地，S1 只在 `PricingQuote` 放上下文 |
| 10-13 §4.1 `CostRate.sourceUrl` / 来源分级 | **现网 `source String @default("official_list")` 列已存在**（`schema.prisma:894`） | **复用** `source` 扩为 D5 四级枚举 + 新增 `sourceRef`；v1.1 误写「新增 `costSource` 列」，v1.2 更正，避免同义字段分叉 |
| 10-13 §4.1 单行阶段策略表 | **现网 `MarginPolicy.phase String @unique`，仅 `phase='launch'` 一行**（`seed-pricing.ts:132–136`） | 多行 scope 必须给每行确定性唯一 `phase`（§6.1）；两处 `findFirst({ orderBy: { createdAt: 'desc' } })` 改按 `scope='global'` 精确查询（§6.6） |

## 附录 C：关键源码锚点（写实施计划时按 master 复核，勿信陈旧工作树）

| 主题 | 路径 |
|---|---|
| 计价入口 / 兜底 / 缓存 | `apps/server/src/pricing/pricing.service.ts`（`quote():189–231`、`onModuleInit():131–180`） |
| ⭐ **缓存单 Map（S1 必须改双索引）** | `apps/server/src/pricing/pricing.service.ts:504–527`（`loadActiveTable`）、`:533–562`（`loadGrayTable`）、`:123–129`（`invalidate`） |
| ⭐ **`TEXT_TOKEN_MODELS` 两处 includes 判据** | `apps/server/src/pricing/pricing.service.ts:259`（`quoteTextTokens`）、`:362`（`prepareTextTokenQuote`） |
| ⭐ **两处 `MarginPolicy` 防御读** | `apps/server/src/pricing/pricing.service.ts:478–485`、`apps/server/src/agent/agent.service.ts:3765–3775` |
| matchKey / 地板 / 公式 / `TEXT_TOKEN_MODELS` | `apps/server/src/pricing/pricing.core.ts`（`buildMatchKey():87–107`、`checkCostFloor():184–196`、`TEXT_TOKEN_MODELS:125–137`、`computeCreditsFromCost():227–229`） |
| 档位枚举（种子与金标准同源） | `apps/server/src/pricing/pricing.space.ts:24–61`；**文本 token 反比率行在 `:93–103` 单独枚举（23 行）** |
| 发布流 / diff / publish / rollback | `apps/server/src/pricing/pricing-publishing.service.ts`（`createDraftFromActive():87–180`、`upsertEntries():180–215`、`checkFloors():409–435`、**`publish():288–368` 已有地板硬拒 `:323–330`**） |
| 发布流 admin 端点（手校 DTO 范式） | `apps/server/src/admin/pricing-publishing.controller.ts`（`parseEntriesBody():39–68`） |
| 渠道成本四元组（含乐观锁） | `apps/server/src/admin/platform-channel.controller.ts` |
| 上架编排（纯编排无新存储） | `apps/server/src/admin/model-ops.controller.ts` |
| 展示报价端点（master 已存在） | `apps/server/src/pricing/pricing.controller.ts`（`GET quote:31–54`、`GET active:17–21`） |
| 扣费 / 预扣结算 / reaper | `apps/server/src/points/points.service.ts` |
| 数据模型 | `apps/server/prisma/schema.prisma`（`ModelCatalogEntry:648`、`UpstreamRoute:689`、`PriceListVersion:862`、`PriceListEntry:873`、`CostRate:887`、`MarginPolicy:901`、`PointHold:940`） |
| ⭐ **上游路由种子 / providerBinding 类型** | `packages/shared/src/upstreamRouting.ts:319–338`（含 `zhipu` 行 `:335`）、`packages/shared/src/studioModelCatalog.ts:34` |
| 运营 SOP（含 SOP-3 已知缺口） | `docs/ops/ops-console-guide.md` |
| **成本行的单位 / 规格 / 人民币金额（§3.5.2 实证）** | `apps/server/src/pricing/seed-pricing.ts:21–79`（41 行，零 `per_second`） |
| **平台侧视频时长阶梯与系数（§3.5.3）** | `apps/server/src/points/video-credits.ts:8–48` |
| 渠道 USD 费率解析（非成本权威源） | `apps/server/src/provider/model-cost.ts`、`apps/server/src/pricing/pricing.core.ts:241–255` |
| 文本 USD 兼容兜底（D8 标记，S1 不改行为） | **`apps/server/src/pricing/pricing.service.ts:463–475`**（`degradedTextTokenQuote`；`:346–360` 是 `prepareTextTokenQuote`，v1.1 行号写错）、`apps/server/src/agent/agent.service.ts:3765–3812` |
| 上游各模态挂牌单位与出处（历史原文不改） | `docs/superpowers/specs/2026-10-13-pricing-baseline-config-design.md` §2 |
