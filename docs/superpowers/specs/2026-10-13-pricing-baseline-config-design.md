# 基准定价与可配置价目体系设计（拉新期成本价 → 跟随上游调价 → 供应商议价）

- 日期：2026-10-13
- 状态：设计稿（待评审）
- 作者：产品 × 架构联合会审
- 上游数据截止：2026-10-13（全部来自官方定价页，见 §2 出处列）
- 关联：`docs/superpowers/specs/2026-10-13-billing-points-system-design.md`（商业化总设计，本文是其 §6「定价锚定方法」的展开）、PR #350（`ProviderChannel.models[].pricing` 成本数据面）、`docs/superpowers/specs/2026-10-11-ops-console-design.md`（运营台扩域）

---

## 0. 一句话结论

**产品未上线、无真实用量数据时，定价的唯一理性基准是「上游官方成本」：先用官方价目表算出三套价目（拉新期成本价 / 成长期 / 成熟期），把「成本 → 毛利系数 → 售价」做成可配置、版本化、运营后台可改的三层定价引擎；上线后用渠道对账数据校准成本，用 CostWatch 跟随上游调价，用户上量后用议价成本替换挂牌成本。** 现行硬编码积分价（图 10-20 / 视频 30-105 / 音频 5-15 / 文本 5）按官方成本折算**图片倒挂 3-4 倍、视频倒挂 8-10 倍**，只是被「未上线」掩盖着。

---

## 1. 为什么必须是「可配置基准价」而不是「改常量」

现状定价是代码常量（`imageCredits.ts` 的 `BASE_IMAGE_CREDITS=10`、`video-credits.ts` 的 30/50/70×系数、音频 5/15、文本 5），四个硬伤：

| # | 硬伤 | 后果 |
|---|---|---|
| 1 | **无成本锚** | 「10 分一张图」与上游收多少钱无关，毛利不可算、亏损不可见 |
| 2 | **改价 = 发版** | 上游调价（StepFun 已发过缓存价调整公告）无法快速跟随，只能硬扛或改代码 |
| 3 | **无版本** | 改价后历史流水不可追溯当时规则（B8），用户投诉「乱扣分」无法复现 |
| 4 | **档位与成本脱钩** | 新模型接入（如 gpt-image-2 4K 档成本 ¥2.93/张）没有定价入口，只能拍脑袋套旧档位 |

基准价体系要解决的不是「这次定多少钱」，而是**建立一个可以长期跟随成本呼吸的定价机器**。

---

## 2. 上游成本实证（2026-10-13 官方价目，全部有出处）

汇率按 **USD/CNY = 7.15**（配置项，可改）。

### 2.1 视频（本项目最高风险模态）

| 上游模型 | 计费单位 | 官方价格 | 折人民币 | 出处 |
|---|---|---|---|---|
| MiniMax-H3 768P | 每秒 | $0.08/s | ¥0.572/s | platform.minimax.io/docs/guides/pricing-paygo |
| MiniMax-H3 2K | 每秒 | $0.13/s | ¥0.930/s | 同上 |
| MiniMax-H3-Max 480P | 每秒 | $0.05/s | ¥0.358/s | 同上 |
| MiniMax-H3-Max 768P | 每秒 | $0.08/s | ¥0.572/s | 同上 |
| MiniMax-H3 输入图 | 张 | 前 5 张免费，超出 $0.04/张 | ¥0.286/张 | 同上 |
| MiniMax-H3 输入视频 | 秒 | 按输出分辨率：2K $0.13/s、768P $0.08/s | — | 同上 |
| H3 Regeneration 768P→2K | 每秒 | $0.05/s | ¥0.358/s | 同上 |
| Seedance 2.0 | 每秒 | $0.266–0.334/s | ¥1.90–2.39/s | openpaths.io 2026-08 价目卡 |
| Seedance 2.0 Fast 480P | 每秒 | from $0.054/s | ¥0.386/s | aiapi-pro.com 2026-09 |
| Wan 2.7 | 每秒 | $0.15/s | ¥1.073/s | openpaths.io |
| fal H3 Max 系列 | — | **待渠道实测**（fal 按端点计费，需拉账单） | — | — |

### 2.2 图片

| 上游模型 | 计费单位 | 官方价格 | 出处 |
|---|---|---|---|
| doubao-seedream-5-0-pro（≤261 万像素，约 1.5K 及以下） | 张 | **¥0.30**（输入图免费） | volcengine.cn 模型价格页 |
| doubao-seedream-5-0-pro（>261 万像素） | 张 | **¥0.60** | 同上 |
| doubao-seedream-5-0-flash | 张 | ¥0.12 | 同上 |
| doubao-seedream-5-0-lite | 张 | ¥0.22 | 同上 |
| gpt-image-2 low（1024×768） | 张 | $0.01 ≈ ¥0.072 | openai.com/api/pricing |
| gpt-image-2 medium（2K） | 张 | $0.08 ≈ ¥0.572 | 同上 |
| gpt-image-2 high（4K） | 张 | $0.41 ≈ ¥2.93 | 同上 |
| MiniMax image-01 | 张 | $0.0035 ≈ ¥0.025 | platform.minimax.io |
| Agnes Image / Navo / MJ 8.1 | — | **待渠道实测**（聚合渠道） | — |

### 2.3 音频

| 上游模型 | 计费单位 | 官方价格 | 出处 |
|---|---|---|---|
| step-tts-mini | 万字符 | **¥0.9**（= ¥90/M 字符） | platform.stepfun.com 定价页 |
| stepaudio-3-tts | 万字符 | ¥2.5 | 同上 |
| stepaudio-2.5-tts | 万字符 | ¥5.8 | 同上 |
| minimax-speech-2.8-hd | M 字符 | $100 ≈ ¥715 | platform.minimax.io |
| minimax-speech-2.8-turbo | M 字符 | $60 ≈ ¥429 | 同上 |
| stepaudio-3-music / gen | 次 | **限时免费**（窗口期，需监控） | platform.stepfun.com |
| MiniMax Music-3.0 | 次 | $0.15/首（≤5 分钟） | platform.minimax.io |

### 2.4 文本（每 1M tokens）

| 上游模型 | 输入 | 输出 | 出处 |
|---|---|---|---|
| step-3.5-flash | ¥0.7（缓存命中 ¥0.14） | ¥2.1 | platform.stepfun.com |
| step-3.7-flash | ¥1.35（命中 ¥0.27） | ¥8.1 | 同上 |
| step-2-16k | ¥6 | ¥18 | apirank.vip 2026-08 实测页 |
| step-5-preview | ¥7（命中 ¥0.70） | ¥20 | platform.stepfun.com |
| MiniMax-M3（≤512K） | $0.60 ≈ ¥4.29（限时 5 折 → ¥2.15） | $2.40 ≈ ¥17.16 | platform.minimax.io |
| MiniMax-M2.7 | $0.3 ≈ ¥2.15 | $1.2 ≈ ¥8.58 | 同上 |
| agnes-2.0-flash / 2.5-flash | **待渠道实测**（聚合渠道默认路由） | — | — |

> **口径说明**：以上是上游**挂牌价**。平台实际走聚合渠道（Agnes hub / Apimart / fal）的成本通常为挂牌价的 4–7 折（如 NovAI 转售 Seedream $0.027–0.034 vs 官方 ¥0.30≈$0.042），**真实成本必须以渠道账单对账校准**（§8.2），挂牌价是上线前的唯一可用基准与对账偏差的上界。

---

## 3. 倒挂测算：现行积分价 vs 官方成本（积分锚 ¥0.01/分）

| 模态 | 现行价 | 折算人民币 | 官方成本（典型档） | 倒挂倍数 |
|---|---|---|---|---|
| 图片 1K（Seedream Pro） | 10 分 | ¥0.10 | ¥0.30 | **3.0× 亏** |
| 图片 2K（Seedream Pro） | 15 分 | ¥0.15 | ¥0.60 | **4.0× 亏** |
| 视频 5s 768P（MiniMax-H3） | 30×1.2=36 分 | ¥0.36 | ¥2.86 | **7.9× 亏** |
| 视频 5s 2K（MiniMax-H3） | 30×1.8=54 分 | ¥0.54 | ¥4.65 | **8.6× 亏** |
| 视频 10s 768P | 50×1.2=60 分 | ¥0.60 | ¥5.72 | **9.5× 亏** |
| 视频 15s 768P | 70×1.2=84 分 | ¥0.84 | ¥8.58 | **10.2× 亏** |
| 语音 TTS 100 字符（step-tts-mini） | 5 分 | ¥0.05 | ¥0.009 | 5.6× 赚 |
| 音乐（stepaudio-3-music） | 15 分 | ¥0.15 | ¥0（限免窗口） | 纯利润（窗口风险） |
| 文本/轮（step-3.5-flash，2K in+0.5K out） | 5 分 | ¥0.05 | ¥0.0025 | 20× 赚 |
| 文本/轮（step-2-16k，同量） | 5 分 | ¥0.05 | ¥0.021 | 2.4× 赚 |

**结论：文本/语音是利润池，图片/视频按官方成本是绞肉机。** 三个战略推论：

1. **视频不能按官方挂牌成本定价参与 C 端价格战**——MiniMax-H3 5s 成本 ¥2.86 已超即梦/可画 C 端会员有效单价（约 ¥0.2–0.3/s）的 2 倍。出路只有三条：聚合渠道折扣成本（默认路线）、议价、质量溢价的专业定位。
2. **档位体系要从「时长 × 系数」改为「模型 × 规格」直查成本表**——不同路线（minimax 官方 vs apimart vs fal）同一模型成本不同，价目必须挂在 (渠道, 模型, 规格) 上。
3. **文本按 token 精确计费（§3.4 已拍板）会把隐性补贴变显性**——现在 5 分/轮对便宜模型是 20× 毛利，这笔钱正在补贴视频亏损；P2 精确计费后补贴结构才会透明。

---

## 4. 三层定价架构（CostRate → MarginPolicy → PriceList）

```
┌────────────────────────────────────────────────────────────┐
│ L1 成本层 CostRate（数据，运营可配）                          │
│   key = (channel, model, spec)                              │
│   unitCost { CNY | USD } · source: official_list /           │
│   channel_actual / negotiated · effectiveFrom/To · tier     │
│   写入面 = ProviderChannel.models[].pricing（已有，PR #350）  │
│   + 运营后台补录（议价结果、渠道账单校准值）                     │
├────────────────────────────────────────────────────────────┤
│ L2 策略层 MarginPolicy（配置，版本化）                        │
│   anchor: 0.01 元/分 · fx: USD=7.15                          │
│   phases: launch(1.10×) → growth(2.50×) → mature(3.50×)      │
│   capabilityOverrides: video { growth 2.0, mature 3.0 }      │
│   guardrails: priceFloor = cost × 1.05（永不吃亏卖）           │
├────────────────────────────────────────────────────────────┤
│ L3 售价层 PriceList（价目表版本，发布物）                       │
│   PriceRule{ match, formula, rounding, minCredits }          │
│   → 物化出每个 (capability, model, spec) 的积分价             │
│   PriceListVersion{ id, rules, effectiveFrom, status }        │
│   发布后：下单/生成请求锁定 version + 锁定价（§5.3）            │
└────────────────────────────────────────────────────────────┘
```

### 4.1 数据模型（增量，不推倒）

```prisma
model CostRate {              // L1：上游成本（含议价）
  id            String   @id @default(cuid())
  channel       String   // agnes_hub | apimart | stepfun | minimax | fal | official
  modelKey      String   // minimax-h3 | seedream-5.0-pro | step-3.5-flash …
  spec          String   // 归一化规格键：768p:5s / 1k / per-1k-tokens-in …
  unitCostCents Int      // 人民币分（存储一律换 CNY，汇率换算在写入时）
  currencySrc   String   // CNY | USD（审计换算依据）
  source        String   // official_list | channel_actual | negotiated
  sourceUrl     String?  // 官方价目页 URL（official_list 必填）
  volumeTier    String?  // negotiated 专用：monthly:<n> 阶梯档
  effectiveFrom DateTime
  effectiveTo   DateTime?
  createdAt     DateTime @default(now())
  @@unique([channel, modelKey, spec, effectiveFrom])
  @@index([modelKey, effectiveFrom])
}

model MarginPolicy {         // L2：策略（单行当前生效 + 历史留痕）
  id            String   @id @default(cuid())
  phase         String   // launch | growth | mature
  anchorCents   Int      @default(1)     // 1 积分 = 0.01 元
  fxUsdCnyMilli Int     @default(7150)  // 汇率 ×1000，配置项
  marginDefault Float    // 1.10 / 2.50 / 3.50
  marginByCap   Json?   // { video: { growth: 2.0, mature: 3.0 } }
  priceFloorMul Float    @default(1.05)  // 售价 ≥ 成本 × 1.05
  effectiveFrom DateTime
  createdAt     DateTime @default(now())
}

model PriceListVersion {     // L3：价目表版本（发布物）
  id            String   @id @default(cuid())  // 如 "v2026-10-20.1"
  status        String   // draft | active | archived
  phase         String   // 生成时的阶段
  rules         Json     // 物化后的全量档位价（对用户可见的最终值）
  diffSummary   Json?    // 相对上一版：哪些档位变了、变多少、毛利变化
  effectiveFrom DateTime
  publishedAt   DateTime?
  publishedBy   String?  // AdminAuditLog 已有审计链
  createdAt     DateTime @default(now())
}
```

`PointLedger`（即现有 `PointTransaction`）加 `ruleVersion String?` + `lockedCredits Int?` 两列——**B8 的解 + 价格锁**，与原设计一致。

> **P0 落地形状说明**：本节为设计稿数据模型。P0 等价迁移（2026-10-13）的实际落地形状——4 张表一次建齐（PriceListVersion / PriceListEntry / CostRate / MarginPolicy；P0 定价只消费前两张，CostRate / MarginPolicy 仅落溯源数据、P1 重定价启用）+ `PointTransaction.ruleVersion` 列 + `matchKey` 规范化细节——以 `docs/superpowers/plans/2026-10-13-p0-pricing-equivalent-migration.md` Task 1 为准。

### 4.2 与现有代码的接线（增量，零迁移风险）

| 现有资产 | 角色 | 改动 |
|---|---|---|
| `ProviderChannel.models[].pricing`（PR #350） | CostRate 的渠道写入面 | 无（已经是 JSON 列，零迁移） |
| `model-cost.ts` `resolveChannelModelCost` | 渠道费率解析器 | 无（复用） |
| `imageCredits.ts` / `video-credits.ts` / 音频文本常量 | **降级为 fallback 默认值** | 读取顺序：PriceList 服务 → 常量兜底（防价目服务故障时功能不可用） |
| `points.service.ts` `consume()` | 扣费执行 | 入参加 `ruleVersion` + `lockedCredits`，落流水 |
| `AdminTokenGuard` + `AdminAuditLog` | 运营写审计 | 无（价目发布走同一条审计链） |
| `AutomationJob` | 定时底座 | 无（CostWatch / 对账校准骑它） |
| `IdempotencyRecord` | 幂等模式 | 无（价目发布幂等） |

---

## 5. 定价公式与规则

### 5.1 主公式

```
基准价(积分) = ceil( 单位成本(元) × 毛利系数 ÷ 积分锚(0.01元/分) )
```

- 单位成本从 CostRate 取（按当前渠道实际路由的成本；无实测值时退官方挂牌价）；
- 毛利系数按阶段（launch/growth/mature）× 模态覆盖（video 可压低）；
- **价格地板**：`售价 ≥ 成本 × 1.05`——任何配置组合都不允许低于成本 + 5% 出售，上游涨价击穿现价时该档自动冻结促销并告警。

### 5.2 取整规则（观感层）

| 基准价区间 | 取整 |
|---|---|
| < 50 分 | 取 5 的倍数 |
| 50–500 分 | 取 10 的倍数 |
| > 500 分 | 取 50 的倍数 |

拉新期成本价**不取整**（1 分精度，诚实反映成本）；成长期/成熟期价目表才启用取整 ladder。文本/对话类有 `minCredits: 1`（单次调用最少 1 分）。

### 5.3 价格锁（公平性硬规则）

- **生成请求发起时锁定**：`ruleVersion + lockedCredits` 随请求落库，生成中途调价不影响进行中的请求；
- 失败/取消/卡死退款按 `lockedCredits` 原额退（reaper exactly-once 范式已有，不变）；
- 充值购买的积分是「钱 → 分」的转换，不受调价影响；调价改变的是「1 分能兑换的服务量」——协议中保留调价权 + **提前 7 天公告**（见 §10）。

---

## 6. 初始价目表（拍板稿，基于 §2 官方成本）

三阶段并行算出，供直接选用。**「拉新期」列即用户拍板的「按成本价走」**（1.10× = 覆盖支付宝手续费 ~0.6% + 服务器带宽 + 缓冲）。

### 6.1 图片（元/张 → 分/张）

| 档位 | 成本 | 拉新期 1.10× | 成长期 2.50× | 成熟期 3.50× |
|---|---|---|---|---|
| Seedream 5.0 Pro 1K | ¥0.30 | 33 | 75 | 105 |
| Seedream 5.0 Pro 2K | ¥0.60 | 66 | 150 | 210 |
| Seedream 5.0 Flash 1K | ¥0.12 | 13 | 30 | 42 |
| gpt-image-2 low（1024） | ¥0.072 | 8 | 18 | 25 |
| gpt-image-2 2K | ¥0.572 | 63 | 143 | 200 |
| gpt-image-2 4K | ¥2.93 | 323 | 733 | 1026 |

> ⚠️ **2026-10-15 修正（P1-a T7 落地实测）**：4K 拉新期原写 322，系手算舍入错——按项目口径
> `ceil(成本 × 110)` 精确算是 `ceil(2.93 × 110) = ceil(322.3) = 323`。P1-a 的 v2 草案种子用
> `computeCreditsFromCost()` 现算（不硬编码），实得**323**；本表已对齐实现。方向保守（多收 1 分/张），
> 价格地板（成本 × 1.05 = 308）不受影响。后续任何"表里写一个数、代码里算另一个数"的位置都以此为准。

取整后（成长期）：30 / 150 / 30 / 20 / 140 / 750。

### 6.2 视频（元/条 → 分/条；视频毛利系数单独压低：growth 2.0× / mature 3.0×）

| 档位 | 成本 | 拉新期 1.10× | 成长期 2.0× | 成熟期 3.0× |
|---|---|---|---|---|
| MiniMax-H3 5s 768P | ¥2.86 | 315 | 572 | 858 |
| MiniMax-H3 5s 2K | ¥4.65 | 512 | 930 | 1395 |
| MiniMax-H3 10s 768P | ¥5.72 | 629 | 1144 | 1716 |
| MiniMax-H3 15s 768P | ¥8.58 | 944 | 1716 | 2574 |
| MiniMax-H3-Max 5s 480P | ¥1.79 | 197 | 358 | 537 |
| Seedance 2.0 Fast 5s 480P | ¥1.93 | 212 | 386 | 579 |

> **产品决策点（2026-10-13 已拍板采纳三轨体系）**：视频必须做**三轨档位体系**——Premium（H3 2K，质量溢价，对标专业创作者）/ Standard（H3 768P）/ Economy（H3-Max 480P、Seedance Fast，价格竞争力走量）。单轨 H3 全线定价在 C 端没有价格竞争力（§3 推论 1）。fal 路线（h3-max / h3-max-turbo）成本待渠道账单实测后补录。

> **4 秒档的成本覆盖口径（2026-10-15 已收口）**：本表按 5s/10s/15s 给成本锚点，但枚举空间里
> 还存在 **4s 档**（legacy 常量遗留，共 30 条：H3 768p/2k 的 4s × 基础+参考）。vendor 无 4s SKU，
> P1-a T7 曾裁定 4s 档暂不挂 `costRateId`、走 `noCostCoverage` 标注进审批流。
> **2026-10-15 已按 5s 锚点×4/5 线性推算补录**（768p ¥2.288 / 2k ¥3.72），4s 档挂推算行、
> 地板校验恢复（768p 4s 售价 252 ≥ ceil(2.288×105)=241、2k 4s 售价 410 ≥ ceil(3.72×105)=391）；
> **推算口径待 P2 渠道对账用真实账单校准**。

### 6.3 音频

**TTS：维持 5 积分一口价**（2026-10-13 用户拍板：用户体验优先、与全站「按次扣分」心智保持一致，不做按字符计价）。成本照登 CostRate 用于毛利核算，价格地板规则自动拦截亏损模型——若某 TTS 模型每 100 字符成本 > ¥0.045（5 分 × 1.05 地板 ÷ 100），该模型自动标红不上平台路线（如 minimax-speech-2.8-hd 成本 ¥0.0715/百字符，命中此规则，仅保留 BYOK）；cheap 路线（step-tts-mini ¥0.009、stepaudio-3-tts ¥0.025）健康，5 分隐含 2-5.6× 毛利。

**音乐**：stepaudio-3-music 限免窗口期内成本 ¥0 → 维持现价 15 分/首作为促活道具，但 CostRate 标记 `source: official_list, watchWindow: true`，**窗口关闭或开始收费时自动告警并重定价**（这是当前 15 分音乐唯一的利润风险）。

### 6.4 文本（按次估算口径：2K in + 0.5K out；P2 起按 token 精确计费）

| 模型 | 单次成本 | 拉新期 | 成长期 2.5× | 成熟期 3.5× |
|---|---|---|---|---|
| step-3.5-flash | ¥0.0025 | 1 | 1 | 1 |
| step-3.7-flash | ¥0.0061 | 1 | 2 | 3 |
| step-2-16k | ¥0.021 | 3 | 6 | 8 |
| step-5-preview | ¥0.0245 | 3 | 7 | 9 |
| MiniMax-M2.7 | ¥0.0086 | 1 | 3 | 4 |

> 现行「5 分/轮」对 flash 类是 20× 毛利、对 step-2 是 2.4×——**文本是当前唯一健康的利润池，也在隐性补贴视频**。上表口径是 2K in + 0.5K out 的短对话（studio 直生/单轮）；**agent 回合上下文会累积，典型按 8K in + 0.5K out 估算**，换算与用户呈现定稿见 §6.5。若拉新期直接上 token 精确价：便宜模型回合费从 5 分降到 1-2 分（拉新利好），贵模型涨到 6-7 分（模型选择自然分流，保护毛利）。

### 6.5 token 计费的积分换算与用户呈现（Q4 定稿，2026-10-13）

**先回答「最后长什么样」：是的，全部换算成积分扣——token 只是计量中间态，账本仍然只有积分一个单位**（与 §2「积分是唯一内部计价单位」一致，人民币不进钱包）。但「1 积分 = X tokens」的**单一比率不精确**：同一模型输入/输出成本差 3-5 倍（step-3.5-flash 输入 ¥0.7 vs 输出 ¥2.1 每 M），一个比率必然误导一端。定稿方案 = **双比率展示 + 预扣结算 + 回合明细**三层：

**① 价目表：每模型一行，用「反比率」（1 积分 ≈ 多少 tokens），不用「X 积分/千 tokens」**——后者全是小数点（0.175 分/K tokens），前者是整数心智。缓存命中单列（agent 重复上下文的真实成本远低于名义值，值得让用户看见）：

| 模型 | 1 积分 ≈ 输入 | 1 积分 ≈ 缓存命中 | 1 积分 ≈ 输出 | 典型 agent 回合* |
|---|---|---|---|---|
| step-3.5-flash | 5.7K | 28.6K | 1.9K | **2 分** |
| step-3.7-flash | 3.0K | 14.8K | 0.49K | **4 分** |
| step-2-16k | 0.67K | —（上游未公布） | 0.22K | **15 分** |
| step-5-preview | 0.57K | 5.7K | 0.20K | **17 分** |
| MiniMax-M2.7 | 1.9K | 9.3K | 0.47K | **6 分** |

（*成长期 2.5× 毛利，典型 agent 回合 = 8K 输入 + 0.5K 输出；拉新期 1.1× 下同口径为 1-7 分，模型越贵差得越开。）

**② 对话内回合明细**：每回合结束在回复下方显示「-2 积分（输入 8.2K · 输出 0.4K）」，展开可见缓存命中数、单价版本（ruleVersion）、预估 vs 实际差额——与现有积分明细页（`usage/*` 组件）同源，不新造展示体系。

**③ 预扣 + 结算（防「跑完没钱」）**：

- 回合发起时按 worst-case 预估**预扣**（预估 × 1.2），预扣不通过 → 拒绝发起并提示充值（与 studio「先扣后退」哲学一致，绝不先服务后收钱）；
- 回合结束按 usage 实际 token **结算**，差额解冻返还；
- 单回合不足 1 分按 1 分收（`minCredits: 1`，账本不碎片化，「每回合至少 1 分」心智简单）；
- 一次用户交互（含内部多轮工具调用）= **一个结算单**，不逐工具扣；
- 循环执行确认时暂停不计费（对齐 WorkBuddy）；选择终止时已产生未出答案的部分进入退费评估（reaper exactly-once 退款范式复用）。

> **2026-10-15 实施拍板（P2 启动，计划 `docs/superpowers/plans/2026-10-15-p2-token-precise-billing.md`）**：
> ① **反比率按当前生效阶段现算**（上线时为拉新期 1.1×）——毛利烘在比率里，价目表保持定价唯一真相源；阶段切换时经发布流重发布新比率。本节上表数字为**成长期 2.5× 参照口径**，非上线值。
> ② 「一次用户交互一个结算单」工程化为「**一个 run 一个结算单**」：steer 插话并入当前 run（天然满足同交互语义）；drain / followUp / automation 派生的 run **各自预扣结算**（可审计、无跨 run 归属判定）。预扣额 = 典型回合（8K in + 0.5K out）× 1.2；**automation run 预扣失败降级为不预扣照常执行 + warn**（不阻塞自动化）。
> ③ 反比率行形态：价目表行 `matchKey = text:<modelKey>:in | :cache | :out`，`credits` 存「tokens / 积分」整数（行方案零迁移；毛利随阶段经发布流重算）。`text` 单行**保留**——studio 文本直生/提示词模式继续按次计费，其 token 口径迁移为后续独立计划。
> ④ 上线形态：`TEXT_TOKEN_BILLING` flag **默认 off**（合并部署后零行为变化，Q2 展示预估维持现状）→ 生产回归 → 灰度开启 → 观察四指标（预扣失败率 / hold 泄漏 / 结算延迟 / 预估偏差）一周后固化 on。
> ⑤ 计费公式：`credits = ceil(inputTokens/rIn) + ceil(cacheReadTokens/rCache) + ceil(outputTokens/rOut)`（cacheWrite 由上游折入 input 口径；模型无 cache 行则 cache tokens 并入 in 项）；任何缺失走 USD 成本兜底，**quote 永不 throw**。

### 6.6 档位映射（对现有常量的替换关系）

- 图片：`BASE_IMAGE_CREDITS=10 × FACTORS` → 直接查 (model, resolution) 成本表；
- 视频：`videoCredits(duration) × modelFactor` → 直接查 (model, resolution, duration) 成本表，参考图/视频加价项保留（上游同样收费：H3 输入图前 5 张免费、$0.04/超出张）；
- 音频：voice 5 / music 15 **一口价不变**（Q3 拍板，一致性优先）；音乐盯限免窗口；
- 文本：5 分/轮 → token 折算（P2，呈现定稿见 §6.7）。

### 6.7 前端展示定稿：Dock 徽标与 agent 实时积分（Q：文本节点与 agent 窗口怎么显示）

> 全部锚点经代码核对（2026-10-13）：`DockCreditBadge.vue` / `PromptDockPanel.vue:262` / `AgentSideRail.vue:3073`（turn-status-line）/ `turnStatusBar.ts` / `executionTraceReducer.ts`（`applyTurnUsage` + `formatTokens`）/ `stores/agent.ts`（`trackTurnUsage`）/ `pi-events.ts:568`（`createUsageAccumulator`）。

**A. 文本节点（Dock 内，生成前）**

现状：`<DockCreditBadge :credits="estimateTextCredits()" />` 恒显示「⚡5积分」。

改后：**「⚡1积分起」**（hover 明细「按 token 计费 · 单次至少 1 积分 · 典型 1–2」）。理由：token 价在生成前无法精确（输出长度未知），徽标的职责是回答「要不要钱 + 大概多少」——下限 + 典型区间是诚实且不误导的表达；图片/视频/音频徽标不变（仍是确定价）。`estimateTextCredits()` 语义从「固定 5」改为「floor 1」。

生成落成后：文本节点（检查器/节点底部，与图片/视频节点实际扣分同 pattern）显示**「本次 -N 积分（输入 X · 输出 Y）」**。

**B. agent 窗口四层显示（由粗到细）**

```
┌─ 回合状态行（turn-status-line，已有组件）──────────────────┐
│ running:  生成回复中 · 12s · 预估 -2积分                    │
│ waiting:  等待你确认 · 还剩 2 分钟（暂停不计费）              │
│ settled:  -2 积分（输入 8.2K · 输出 0.4K）▾                 │
└──────────────────────────────────────────────────────────┘
   回复下方常驻行 = settled 值 sticky，展开看 cacheRead/ruleVersion/预估vs实际
   顶栏余额 pill（AccountPointsPill.vue）= settle 后递减 + 高亮闪一下
   侧栏头部 = 本会话累计 -N 积分
```

数据链路（服务端权威、客户端实时预估）：

1. **实时预估源**：`pi-events.ts` 的 `createUsageAccumulator` 已在每条 `message_end` 算出 delta——改 `feed()` 让 delta **即时 emit** 一个 `usage_delta` 事件（现在只累积不外发）；前端按缓存价目表（`GET /api/pricing/active`，P0 顺带输出）折算成「预估 -N」；
2. **结算权威值**：`turn_usage`（已有，agent_end 前折叠）之后新增 `turn_settled{ credits, ruleVersion, inputTokens, outputTokens }`——consume 落账后才发，客户端以此覆盖预估值并驱动 pill 递减；
3. **前端落点**：`stores/agent.ts` 的 `trackTurnUsage` 旁加 live 累计 + settled 两个态；`turnStatusBar.ts` 的 `TurnStatusLineInput` 增加 usage 段（`running` 拼「· 预估 -N」，新增 `settled` 态拼「-N 积分（…）」）；`executionTraceReducer.ts` 的 `formatTokens`（X.Xk）直接复用；
4. **预扣表达**：发起时预扣 ×1.2 冻结——发送按钮在预扣不通过时禁用并提示「余额不足」（pill 点击已有充值入口）；预估与实际差 >20% 时明细行标注，防「预估 -5 实际 -2」的困惑。

**C. 两种计费入口的区分（都在同一账本）**

agent 内的生成工具（`propose_generation` 确认 → studio 扣费）在**画布节点**上显示（现有 DockCreditBadge + 生成记录链路）；对话 token 计费在**聊天侧**显示。积分明细页按 category 分列（text / image / video / audio），用户可分视角对账。

---

## 7. 拉新期成本价机制（Phase 配置）

```yaml
phases:
  - name: launch
    margin: 1.10                 # 成本价 + 10% 覆盖支付手续费与基础设施
    startsAt: "上线日"
    endsAt: "2027-01-31"         # 或由退出条件触发自动切 growth
    subsidyBudgetCents: 3000000  # 拉新补贴总额上限 ¥30,000（毛利缺口累计）
    exitConditions:              # 任一满足即提议切阶段（人工确认后发布）
      - subsidyUsedRatio >= 0.8
      - mau >= 5000
      - date >= endsAt
  - name: growth
    margin: 2.50
    capabilityOverrides: { video: 2.0 }   # 视频竞争激烈压低系数
  - name: mature
    margin: 3.50
    capabilityOverrides: { video: 3.0 }
```

规则：

1. **补贴预算熔断**：毛利缺口（成本 − 售价折算）累计超过预算 80% 时告警，100% 时该模态自动回到 `priceFloor`（成本 × 1.05）并通知运营——「拉新期按成本价走」不等于无限期亏；
2. **切换是发布行为**：阶段切换 = 发布新 PriceListVersion（走 §8.4 审批流），不是定时器黑移；
3. **已锁价不受影响**：切换前已发起生成/已购积分包按价格锁与积分锚规则处理（§5.3）；
4. **退出条件可视化**：运营后台看板展示补贴消耗曲线 + 退出条件达成度，辅助拍板。

---

## 8. 调价工作流（跟随上游成本 → 议价）

### 8.1 CostWatch（周更，骑 AutomationJob）

- 每周拉取 §2 各上游官方定价页（MiniMax / StepFun / 火山方舟 / OpenAI 公开价目），解析 → 与 CostRate 现行值 diff；
- 变动 > 5% → 告警（IM/邮件）+ 自动生成 **vNext 价目草案**（含 §4.1 的 `diffSummary`：哪些档位变了、变多少、毛利变化）；
- 已知会变的价格源重点盯：StepFun 缓存命中价（2026-10-14 刚调过）、MiniMax 限时 5 折、stepaudio-3-music 限免窗口。

### 8.2 渠道对账校准（月更）

- 每月渠道账单（ Agnes/Apimart/fal/MiniMax/StepFun 实际扣费）vs `usage.cost` 流水（PR #350 数据面已有）比对；
- 偏差 > 10% 的 (channel, model) → 生成 `channel_actual` CostRate 修正草案；
- **议价结果录入 = `negotiated` 来源 CostRate**，支持 `volumeTier` 阶梯（月用量 <10 万 / 10-100 万 / >100 万 分档单价），用户上量后议价落地即替换挂牌成本，同一售价下毛利自动变厚——不需要改价目表。

### 8.3 新模型接入

- catalog 新增模型（`studioModelCatalog.ts`）→ 必须在 CostRate 登记成本才能上架（无成本 = 价目表服务返回 fallback 常量 + 告警，不允许「无成本裸奔」）；
- 建议接入流程加一道 checklist：成本登记 → 档位草案 → 发布。

### 8.4 发布与回滚（运营后台，ops-console 扩域「定价域」）

```
草案(draft) → 影响面预览 → 审批(AdminAuditLog) → 发布(active) 
   → 历史版本 archived（流水可复现）
   异常 → 一键回滚到上一 active 版本（新版本同样留痕）
```

- 发布必须带 `diffSummary`：变化的档位数、最大涨幅、毛利影响、影响的在途请求数；
- 回滚不改历史流水（ruleVersion 指向旧版本仍然可查）；
- 发布前 7 天公告义务由运营手动确认（合规 checklist 挂钩）。

### 8.5 白名单灰度发布（2026-10-13 拍板，初始价目表走此路径）

**现状核对（代码实证）**：项目当前**没有任何按用户维度的灰度能力**——全部 feature flag 都是 env 全局开关（`SEL_REF_ENABLED`、`PI_RUNTIME_*` 家族、`ASK_USER_BLOCKING`，见 `agent.service.ts:701` / `runtime-config.ts`），翻转需重建容器。所以灰度不是「开个开关」，是随 P1 运营后台新建的一层薄机制，骑在 P0 的价目表服务上。

**数据模型**（P0 三表之外新增两张小表，SQLite 无迁移风险）：

```
PricingGrayRelease      // 一次灰度活动
  id / versionId        // 指向被灰度的 PriceListVersion
  status                // active | promoted | rolled_back | expired
  startsAt / endsAt     // 灰度窗口（默认 7 天；到期自动 expired 回老价目）
  createdBy / note
PricingGrayWhitelist    // 灰度名单（releaseId + userId 唯一）
  id / releaseId / userId / phone(录入快照) / note
```

**价目解析顺序**（价目表服务内，一次查询）：

```
① active 灰度窗口（now ∈ [startsAt, endsAt]）且 whitelist 命中当前 userId
   → 返回该 release 的 versionId 价目
② 否则 → 当前 active 的 global PriceListVersion
③ 价目服务故障 → fallback 现有常量（§4 已有规则，保功能 + 告警）
```

**录入校验（防「白给了」）**：运营粘贴名单（手机号，换行/逗号分隔）→ 服务端按 `User.phone` 解析 userId：
- 解析不到的号码**显式列出报错**，不静默跳过；
- 解析成功后展示预览「命中 N 人 / 未命中 M 个号码」再确认生效——**空集假绿防线：灰度生效判据必须断言 whitelist 非空且命中数 > 0**，否则「灰度发布了但没人走新价」与「灰度生效了」在旧逻辑下长得一样。

**可观测（零新增埋点）**：consume 落流水时 `ruleVersion + grayReleaseId` 随账本落库（P0 已在流水加 ruleVersion，灰度只多一个字段）→ 灰度报告 = 按 grayReleaseId 聚合流水：命中人数、各档位扣费分布、退款率、毛利缺口。

**出口判据（灰度一周，全部满足才 promote）**：

1. 白名单命中率 100%（N 人全部走新价目；附有效性断言：whitelist 非空 + 命中 > 0）；
2. ruleVersion 落账正常，无 pricing 解析错误 / fallback 告警；
3. 预扣-结算链路无异常退款（对比灰度前退款率基线）；
4. 毛利缺口消耗符合 §7 补贴预算预期曲线；
5. 白名单用户无「余额不足」误判（预扣 ×1.2 逻辑正确性）。

**出口动作**：

- `promote`：该版本转 global active、原 active 归档（走 §8.4 审批链，`AdminAuditLog` 留痕）；
- `rollback`：release 置 rolled_back，白名单用户回老价目；在途请求按价格锁（§5.3）不受影响；
- 窗口到期未处置 → 自动 expired（保守默认：不自动 promote）。

**为什么不做百分比灰度**：当前用户量为零/极小，白名单是充分且可解释的粒度；百分比分桶（稳定哈希）等有真实流量后再讲，不过度设计。此机制同时为将来订阅制、多池的灰度复用（同一张 release 表换 versionId 即可）。

---

## 9. 实施排期（嵌入总路线图）

| 阶段 | 内容 | 出口判据 |
|---|---|---|
| P0（与商业化 P0 并行） | CostRate/MarginPolicy/PriceListVersion 三表 + 价目表服务（fallback=现有常量）+ consume 带 ruleVersion/lockedCredits | 现有全部档位从常量迁到价目表服务，行为不变（等价迁移）（✅ 2026-10-13 完成：金标准全网等价 + ruleVersion 落账 + boot 自播种） |
| P1 | 运营后台定价域（草案/预览/审批/发布/回滚 + **§8.5 白名单灰度**）+ §6 初始价目表按拉新期灰度发布 + CostWatch 周更 | 改价不发版；上游调价一周内可跟随；初始价目表白名单灰度一周达标后 promote（✅ 2026-10-15 完成 P1-a：发布流 draft/diff/publish/rollback + 地板校验 + 白名单灰度两表/解析/报告/promote + v2 拉新期草案种子 + ops-console 两页。**CostWatch 周更按 spec §8.1 挪 P2**（依赖渠道对账数据面与外部定价页抓取稳定性）；「上游调价一周内可跟随」由「改价不发版」机制本身满足） |
| P2 | token 精确计费（§3.4）+ 渠道对账校准 + 阶段切换（launch→growth） | 毛利看板可算；拉新补贴曲线可见 |
| P3 | 议价阶梯 CostRate + 三方对账 job 产出毛利报表 | 议价结果即配即生效 |

> P0 的「等价迁移」是地基：先把定价从代码常量搬进可配置体系且行为零变化，再谈改价——避免「迁移动价」两个风险叠加。

---

## 10. 风险与合规

| 风险 | 规则 |
|---|---|
| 调价权争议 | 充值协议明示「平台保留积分价目调整权利，调整提前 7 天公告」；已锁定请求与已购积分不受影响（§5.3） |
| 无限亏损 | priceFloor = 成本 × 1.05 硬闸 + 补贴预算熔断（§7） |
| 免费窗口陷阱 | 限免/限时折扣上游（stepaudio-3-music、MiniMax-M3 五折）在 CostRate 标记 watchWindow，到期自动重定价 |
| 汇率波动 | USD 成本随 fx 配置换算；汇率波动 > 3% 触发价目复核提醒 |
| 坏数据 | 价目服务故障 → fallback 现有常量（保功能），同时告警——与 `model-cost.ts` 「宁可少算不错算」同纪律 |
| 聚合渠道黑箱 | 挂牌价只作基准与上界，真实成本以月对账校准；未校准渠道的档位标「成本待实测」不对外承诺毛利 |

---

## 11. 已拍板决策（2026-10-13，用户逐条确认）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 拉新周期与补贴预算 | ✅ **同意默认值**：至 2027-01-31 / 补贴预算 ¥30,000（80% 告警、100% 熔断回价格地板） |
| 2 | 视频三轨档位 | ✅ **采纳**：Premium（H3 2K 质量溢价）/ Standard（H3 768P）/ Economy（H3-Max 480P + Seedance Fast 走量），Dock 模型选择器按三轨组织 |
| 3 | TTS 计价 | ✅ **维持 5 积分一口价**（用户体验优先、全站按次扣分心智一致，不做按字符）；成本照登 CostRate，价格地板自动拦截亏损模型（>¥0.045/百字符不上平台路线） |
| 4 | token 精确价呈现 | ✅ **定稿 §6.5**：全部换算积分扣（token 仅计量中间态）；双比率展示「1 积分 ≈ X 输入 / Y 输出 tokens」+ 缓存命中单列；预扣×1.2 + 实际结算；单回合 min 1 分；一次交互一个结算单 |
| 5 | 初始价目表发布方式 | ✅ **采纳白名单灰度一周**（用户 2026-10-13 拍板）：不等直发——项目当前无按用户维度的灰度能力（全项目 flag 均为 env 全局开关，见 §8.5 现状核对），随 P1 运营后台一并建设；机制定稿见 **§8.5** |
