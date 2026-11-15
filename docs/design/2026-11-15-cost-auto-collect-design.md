# 成本数据自动采集方案（Cost Auto-Collect Design）

> 日期：2026-11-15 · 状态：**设计稿待评审**（未实现）
> 前置：定价中心已上线（PR #875 合 `c64e4b6f`），缺口 = 视频 48 档 + 音频 4 档。
> 本方案目标：**这 52 档的真实上游成本数字不靠人供，从渠道侧自动获取并写入成本目录**。
> 发布（生成正式价目表）在采集完成、人工复核之后单独授权执行。

## 0. 已核证事实（2026-11-15 生产探针 + 官方文档，非推测）

| 上游 | 承载模型（生产路由） | 数据通道 | 核证结果 |
|---|---|---|---|
| **fal** | h3-max、h3-max-turbo | **L1 价格 API（已探针成功）** | `GET https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai/minimax/h3-max`，Authorization: Key FAL_KEY → `{"unit_price":0.00017,"unit":"compute seconds","currency":"USD"}`。两模型同价。⚠️ 计费单位是 **GPU 计算秒**，非视频秒 ⇒ 需按档换算（见 §3.1） |
| **zhipu** | cogvideox-flash | **L2 官方价目（已核证）** | docs.bigmodel.cn/pricing 明确：**CogVideoX-Flash 视频生成 多分辨率 免费**（0 元/次）；CogVideoX-2=0.5 元/次、CogVideoX-3=1 元/次 |
| **stepfun** | step-tts-mini、stepaudio-3-tts、stepaudio-3-gen-preview、stepaudio-3-music-preview | L2 官方价目 | platform.stepfun.com 公开 stepaudio/step-tts 价目（元/百字符、元/首） |
| **minimax** | minimax-h3 | L2 官方价目（L1 账单 API 待核证） | platform.minimaxi.com 公开 H3 视频档位价目；控制台有账单记录，是否有对账 API 未验证 |
| **agnes_hub** | agnes-video-2.5-flash | **无 API（已探证）** | apihub.agnes-ai.cn 为 OpenAI 兼容网关：`/v1/models/pricing` 返回 200 是假阳性（把 "pricing" 当 model id → `model_not_found`）；`/v1/usage`、`/v1/billing/*` 均 404。官网 agnes-ai.cn 是否公布价目待核 |

结论：**52 档里约 40 档有可自动化来源**（fal 24 + zhipu 12 + step 4，minimax 8 待核证账单 API）；仅 agnes-video 的 12 档（或其中在售档）没有程序化通道，需官网抓取或向 agnes 运营一次性索取。

## 1. 设计原则（沿用定价中心五规则，不新增概念）

1. **不猜数**：抓不到的档位保持缺，绝不填占位数。自动写入的每一行都带 `source` 与原始凭证（响应原文/URL/抓取时间）。
2. **来源优先级（引擎既有语义，不新增）**：`manual（人工改过）> channel_actual（渠道实测）> official_list（官方价目）> provisional`。自动采集只写 `official_list` / `channel_actual`，**永不覆盖 manual 行**。
3. **落库走既有通道**：采集器只调现有 `PUT /admin/pricing/cost-records`（定价中心已带视频 legacy 行退役语义），不另开写路径。
4. **免费 ≠ 缺数据（新决策，需拍板，见 §4-D1）**：CogVideoX-Flash 免费，但现行引擎把 `costYuan<=0` 一律当"缺"⇒ 必须引入"显式 0 价"语义，否则 12 档采到了也出不了价。
5. **fail-soft 纪律**（探活器同款）：任一 adapter 失败只记审计日志与该 adapter 的失败计数，绝不阻塞其它上游、绝不抛出阻断调度。

## 2. 架构：一个采集服务 + 每上游一个适配器

```
apps/server/src/pricing/cost-collect/
  cost-collect.service.ts        # 调度入口 + 汇总 + 写库（走 cost-records PUT 内部服务调用）
  cost-collect.controller.ts     # POST /admin/pricing/cost-collect/run {upstreams?: string[], dryRun?: boolean}
  adapters/
    fal.adapter.ts               # L1：价格 API + 用量回读（§3.1）
    zhipu.adapter.ts             # L2：官方价目表（CogVideoX-Flash 免费，结构化常量表 + 文档 URL 凭证）
    stepfun.adapter.ts           # L2：官方价目（核证页面后决定：API 抓取 or 结构化常量表 + URL）
    minimax.adapter.ts           # L2（L1 待核证）
    agnes.adapter.ts             # L2 官网抓取（可能退化为人工一次性录入，见 §4-D3）
  cost-collect.audit.ts          # 每次运行的整帧审计落盘（AttemptLog 同款）
```

- **调度**：手动按钮（定价中心每模型卡「同步上游价目」+ 全局「一键同步」）为主；每日定时为可选（env 开关，默认关，复用 automation-scheduler）。
- **dryRun 模式**：只产出"将写入的行 + 来源 + 凭证"，人工在卡片上预览确认后才真正落库——首版强制 dryRun→确认 两段式，防止错误价目直接进入出价链。

## 3. 各上游适配规格

### 3.1 fal（h3-max、h3-max-turbo，24 档）——唯一 L1 通道，两步走

- **第一步（零成本）**：价格 API 拿单价。已实测：`$0.00017 / compute seconds`。
- **第二步（换算 per-video 档位）**：fal 计费 = 计算秒 × 单价。两条换算路径，按优先级：
  - **a) 用量回读（channel_actual，最优）**：fal Platform API 支持按请求回读计费明细（usage line items）。对每个缺档 (model, res:duration) 发 **1 次真实探针生成**，从用量 API 回读该请求实际扣费 ⇒ 直接得到该档真实成本，写 `channel_actual`。探针成本估算：$0.00017/GPU 秒 × 每次几十秒 ≈ **每档几分钱美元，24 档总预算 < $5**。探针开关默认关，需授权开启（§4-D2）。
  - **b) 模型页 per-video 价（official_list，零成本兜底）**：fal 模型页若公布 minimax/h3 的 per-video 价格表，直接抓取（无则跳过，不猜）。
- 计算秒计价的隐含风险：同档位计算秒数会随负载波动 ⇒ channel_actual 值标注采样次数与时间，后续真实流量持续回读自动修正。

### 3.2 zhipu（cogvideox-flash，12 档）——零成本，立即全解

- 官方价目：**免费（0 元/次，全分辨率）**。adapter 为结构化常量表 + docs.bigmodel.cn/pricing URL 凭证。
- 依赖 §4-D1 的显式 0 价语义，否则物化仍报缺。

### 3.3 stepfun（4 个音频档）——L2

- 官方价目页核证后：若价目结构稳定（元/百字符、元/首），做**结构化常量表 + URL 凭证**（价目变更靠人工复核触发重核，不跑脆弱的页面爬虫）；若平台有公开价目 API 则优先 API。

### 3.4 minimax（minimax-h3，8 档）——L2 优先，L1 待核证

- 先核证 platform.minimaxi.com 是否有对账/余额 API（Coding Plan 的 `/v1/token_plan/remains` 是百分比配额，**不是**按量计费账单，不能用于成本采集）。有 → L1；无 → L2 常量表。

### 3.5 agnes_hub（agnes-video-2.5-flash，12 档）——唯一无程序化通道

- apihub 无 pricing/usage API（已探证）。选项：
  - L2：agnes-ai.cn 官网价目页抓取（存在且稳定则做）；
  - **人工一次性**：向 agnes 运营索取价目表，录入时走卡片（manual 行，天然最高优先级，一次性的、合法的"人供数"，但只此 12 档）。

## 4. 需拍板的决策（D1–D3）

| # | 决策 | 建议 |
|---|---|---|
| **D1** | **显式 0 价语义**：引擎 `resolveUnitCost` 现把 `costYuan<=0` 恒当缺。建议改为：`source IN (official_list, channel_actual, manual)` 且 `costYuan=0` 视为**合法的免费价**（provisional 行仍排除）；成本目录 UI 显示「免费」。 | 采纳（否则 cogvideox 12 档采到也白采） |
| **D2** | **fal 探针实测开关**：对 24 个档位各发 1 次真实生成（总预算 < $5）换 channel_actual 精确成本；不开则只有 $0.00017/GPU秒 单价无法换算成档位价。 | 首轮开启（预算可控），后续关闭只靠真实流量回读修正 |
| **D3** | **agnes-video 12 档**：官网抓取 or 运营一次性提供？ | 先核证官网；无则运营一次性提供（唯一保留人工的档位） |

## 5. 交付与验收

1. **采集完成判据**：`GET /admin/pricing/cost-records` 中 52 个缺档全部有值且带来源徽标（免费 12、fal 24、step 4、minimax 8、agnes 12——agnes 视 D3）；每行可追溯凭证（URL/响应摘要/探针请求 id）。
2. **物化判据**：新 draft materialize → missingCost=0，109 主体全部出价。
3. **人工复核门**：卡片墙逐卡展示「来源 + 金额 + 同步时间」，运营确认无异常价（如单价倒挂、免提档误标）后，才进入发布流程。
4. **发布**：单独授权执行（不并入本方案的实施 PR）。

## 6. 实施顺序（获批后）

1. D1 引擎显式 0 价一刀 + 回归（变异自检）；
2. 采集服务骨架 + fal/zhipu adapter（dryRun）→ 生产取证：cogvideox 12 档 + fal 单价落 dryRun 报告；
3. stepfun/minimax adapter（核证后定 L1/L2）；
4. D2 授权后开 fal 探针实测 → channel_actual 回填；
5. agnes-video 按 D3 收尾；
6. 全量复核 → 等你授权发布。

## 7. 增量（2026-11-15 用户追加需求）：新模型上架时的"自动获取成本"

> 问题：后续平台目录上架新模型（新增渠道或在现有渠道上新增），能否自动一键获取成本 + 点复核确认？

**答案：能，架构天然支持——因为采集器按渠道（upstream）注册适配器，不按模型。** 关键事实：fal 价格 API 不支持全量列表（已探针：无 endpoint_id 时返回空），必须逐模型查询；但查询参数可从模型目录的 `gatewayModelId` 自动构造（fal 规则 `fal-ai/{gatewayModelId}`），所以"新模型"不需要任何新代码——上架动作本身就把查询输入带齐了。

### 7.1 三类场景的覆盖面（诚实分级）

| 场景 | 覆盖 | 交互形态 |
|---|---|---|
| 现有 **L1 渠道**（fal）+ 新模型 | **全自动** | 上架卡片内「自动获取成本」→ dryRun 预览 → 点确认落库 |
| 现有 **L2 渠道**（zhipu/stepfun/minimax）+ 新模型 | **半自动** | 常量表无此模型 → 卡片提示"该渠道暂无此模型自动价目"，人工填一次；后续可升级 L2 为页面解析器提升到全自动 |
| 现有 **无通道渠道**（agnes_hub）+ 新模型 | 人工 | 卡片人工填数（现状，非死路） |
| **新渠道** + 新模型 | 一次性开发 | 适配器是渠道的注册成本：探明该渠道有无 pricing API / 价目页形态，写一个 adapter 后该渠道所有后续新模型都走同一通道；未写适配器前默认人工填数 |

### 7.2 规格增量

- **D4 适配器接口按渠道签名**：`collect(upstream, modelRef[])`，`modelRef` 从目录（gatewayModelId/providerBinding/modality/spec 枚举）自动带出。上架向导内嵌定价卡新增「自动获取成本」按钮：调 dryRun → 卡片内预览（来源+金额+凭证）→ 点确认才落库（复用 §2 两段式）。
- **D5 通道覆盖面自检**：定价中心每张卡显示该渠道自动通道状态（L1 可用 / L2 有表 / 无通道）；上架向导完成（或跳过定价）后，后台自动对该模型跑一次 dryRun，有结果就塞进卡片预览——**新模型上架完成的瞬间，能自动拿到的成本已经在预览里等确认**。
- **D6 fal 类计算秒计价换算**：新模型若计费单位是 compute seconds（非固定 per-video 价），沿用 §3.1 探针实测换算（受 D2 类授权开关约束），探针预算按模型数预审。

### 7.3 不变的边界

- L2 渠道新模型仍需人工一次（或未来升级解析器）；agnes 类无 API 渠道恒人工；发布门禁与人工复核两段式不因自动化而跳过。
