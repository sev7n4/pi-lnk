# Ops Console 运营后台操作手册（V1）

> 适用版本：PR #362（master `1548abe1`，2026-10-11 上线）  
> 入口：`http://119.29.173.89:8888/admin` · 认证：`LNKPI_ADMIN_TOKEN`（sessionStorage，关标签即失效）  
> 本文所有交互描述均与线上代码逐一核对（apps/web/src/pages/admin/*.vue）。

---

## 0. 登录

1. 打开 `/admin`，输入 Token（生产容器 env `LNKPI_ADMIN_TOKEN`），进入侧栏壳。
2. Token 只存 `sessionStorage`：**关标签页即失效**，重新进入需再输一次。401/403 会自动清 Token 回登录门。
3. Token 轮换：CVM 上改 api 容器 `.env` 的 `LNKPI_ADMIN_TOKEN` → `docker compose up -d` 重建。

---

## 1. 模型目录（AdminModelsPage）— 上架/下架/改配置

页面顶部显示 `catalogVersion`；支持按 `modelKey`/名称实时搜索。

每行带两列链路信息（2026-10-12 增强）：

- **上游端点**：该模型按路由表解析出的请求端点（baseUrl）+ 归属上游（如 `agnes_hub`）；未命中路由行显示「未路由」。
- **链路状态**：`🔴 不可用`（探活判定：连续 3 轮 ghost 且近 24h 零真实成功 → 建议下架）/ `🟡 欠费`（近 24h 有 402 余额不足记录 → 给上游账户充值）/ `🟢 正常`（探活 available 或近 24h 有真实成功流量）/ `⚪ 未知`（探活尚未判定：新上架/冷模型）。悬停看判定依据；数据与探活自动同步，无需手工维护。

### 新增条目（上架新模型）

点「新增条目」，字段含义：

| 字段              | 说明                                                                                      |
| --------------- | --------------------------------------------------------------------------------------- |
| modelKey        | **稳定标识，创建后不可改**（编辑态不显示此字段）。软删后同 modelKey 重新 POST 视为恢复上架                                 |
| displayName     | 展示名                                                                                     |
| gatewayModelId  | 上游网关侧的真实模型 ID                                                                           |
| modality        | `text` / `image` / `video` / `audio`                                                    |
| providerBinding | `gateway-openai-compat` / `fal-http` / `minimax-http` / `zhipu-http`                    |
| params (JSON)   | 透传给上游的额外参数，**必须是合法 JSON**（如 `{"model":"native"}`）；非法 JSON 提交会被前端拦截并提示「params 不是合法 JSON」 |

### 编辑

行内「编辑」：可改 displayName / gatewayModelId / modality / providerBinding / params（modelKey 不可改）。

### 下架（软删）

行内「下架」→ 二次确认弹窗。注意：

- 是**软删**（`deletedAt` 置位），列表状态列变「已下架」；
- 已下架的行「下架」按钮禁用（防重复删）；
- 恢复方式：用**相同 modelKey 重新新增**即视为恢复上架；
- 若该模型是某处默认模型，服务端会返回 **409**，错误原文透出到页面顶部红条——需先改掉默认模型再下架。

---

## 2. 上游路由表（AdminRoutesPage）— 查看与启停

只读展示 + 行级「启用」开关。列含义：

| 列            | 含义                                |
| ------------ | --------------------------------- |
| 优先级          | 数字越小越先匹配                          |
| 匹配 / pattern | matchType + 匹配模式（如按模型 key 前缀）     |
| 能力           | 该路由承载的 capability（text/image/...） |
| 上游           | 命中后转发到的上游渠道                       |
| fallbackKey  | 该上游的 API Key 所在 env 变量名           |

### 启停语义（重要）

- 拨动开关 = `PATCH enabled`，**本进程即时生效**，跨实例有 5s TTL 兜底——切换后最多 5 秒全网生效。
- 失败时页面自动 reload，让开关状态与服务端对齐（不会出现 UI 显示已开、实际没开的漂移）。
- V1 不支持在页面新增/编辑路由行（改 pattern/优先级仍走 API/DB）。

---

## 3. 健康探活（AdminHealthPage）— 只读监控

### 真实流量健康（上半区）

- 窗口选择：`1h / 6h / 24h / 168h`（默认 24h），切换即重查。
- 顶部黄条 = 告警区（规则触发才出现），格式：`[规则] 模型 — 成功率 xx%（窗口 xh，共 N 次）`。
- 表格逐列：总次数 / 完成 / 失败 / 成功率 / **errorCode 分布**（如 `TIMEOUT×3`）/ **402 次数**（余额不足，见下方排障节）。

### 探活结果（下半区）

- 展示**每个上游最近一次**探活：HTTP 状态、拉到的模型数、**对账结果**：
  - `ghost N` = 目录里有、上游 `/models` 清单没报的模型（候选下架）；
  - `missing N` = 上游有、目录里没有的模型（候选上架）。
- ⚠️ **上游 `/models` 清单 ≠ 实际可用**：部分上游（如 agnes hub）`/v1/models` 只报自家少量模型，实际承接的第三方模型不上清单——这类模型 ghost 数偏高属预期，判活以**真实流量健康（上半区）**为准；灰显有双条件防线（连续 3 轮 ghost 且近 24h 零真实成功才灰显），不会因清单缺失误伤。
- 探活**定时自动跑（默认 6h 间隔），没有手动触发按钮**——这是 by design（V1 无触发端点）。部署初态「暂无数据」属正常。

---

## 4. 平台渠道定价（AdminPricingPage）— 配置计费

针对**平台渠道**（`id='platform'` 单行渠道；BYOK 用户渠道结构性不可达）。

### 界面

- 顶部：渠道名 + `N/M 已配定价` 计数；「未配定价」黄徽标 = 该模型没有 pricing（**pull-models 重建模型列表会把 pricing 整块抹掉**——看到一片黄徽标基本就是刚跑过 pull-models，需重新补配）。
- 定价单位：**USD / 百万 token**。

### *设置*/修改定价

行内「编辑」→ 弹窗四个字段，**留空 = 不计费该维度**：

| 字段             | 含义  |
| -------------- | --- |
| inputPerM      | 输入  |
| outputPerM     | 输出  |
| cacheReadPerM  | 缓存读 |
| cacheWritePerM | 缓存写 |

规则：非负有限数；**至少填一个字段**（全部留空想清零请用「清除」按钮）。保存后**下一生成会话即生效**。

### 清除定价

行内「清除」→ 二次确认（提示：清除后该模型**不计费**）。即 `pricing=null`。

### 安全语义（防线，运营不必操作但需知道）

- PUT 是**条目级**替换：只动你编辑的那个模型的 pricing，其他模型/其他字段逐字节不动（防 pull-models 式整块覆盖重演）。
- 每次保存/清除都写审计日志（含旧/新定价 diff），actor 恒为 `admin`。
- 若渠道 models JSON 畸形：页面顶部出现黄条「平台渠道 models JSON 畸形（服务端拒绝写入）」，**编辑/清除按钮全部禁用**（拒盲写）——此时需先修 DB 渠道行再操作。

---

## 5. 审计日志（AdminAuditPage）— 追责与回溯

- 过滤：`action` / `resource` **精确匹配**（回车或点「查询」），actor 恒为 `admin`。
- 分页：20 / 50 / 100 每页，页码越界由服务端钳制。
- 行首 `>` 展开 **before / after** JSON 快照（定价变更可看到改前的完整 pricing 对象）。

常用 action 取值（精确匹配时直接复制）：  
`platform-channel.pricing.set` · `platform-channel.pricing.clear` · 以及目录/路由各写操作的对应 action。

---

## 6. 常用 SOP

### SOP-1：上架一个新模型（端到端）

1. **目录页**：新增条目（填 modelKey/gatewayModelId/modality/binding）。
2. **路由页**：确认有启用的路由能匹配到该模型对应能力与上游（没有则走 API/DB 加路由）。
3. **定价页**：给该模型配 pricing（四字段至少一项）。
4. **健康页**：观察 1h/24h 窗口成功率与错误码，确认真实流量正常。

### SOP-2：模型突然大量失败

1. 健康页看 errorCode 分布：`402` 计数高 = 上游余额不足，去对应上游充值（fallbackKey 列可定位是哪个 env/渠道）；
2. `TIMEOUT/5xx` 密集 = 上游故障，可在路由页临时**关停该路由**让流量走其他路由；
3. 恢复后再把开关打开，全程操作都会留审计记录。

### SOP-3：pull-models 跑完之后（防计费裸奔）

1. 定价页看「已配定价」计数是否骤降、出现成片「未配定价」黄徽标；
2. 对着审计页 `platform-channel.pricing.clear`/`set` 的 before 快照（或上次配置记录）逐个补回 pricing；
3. 健康页下半区对账 ghost/missing，决定是否顺带上/下架。
4. 根治手段（定价存独立列，不再被抹）已立项 hardening PR，落地前靠本 SOP 兜底。

### SOP-4：查「谁在什么时候改了什么」

审计页按 resource 精确匹配（如模型 modelKey 或渠道 id）→ 展开行看 before/after diff。

---

## 7. 概念澄清（FAQ）

### 下架为什么只有软删，没有硬删？
刻意设计。原因：① GenerationRecord/审计/审计 before 快照都按 modelKey 引用历史，硬删会断历史；② 软删可恢复——同 modelKey 重新新增即恢复上架，误操作零成本回滚；③ 默认模型有 409 防呆联动。**软删 = `deletedAt` 置位、运行时不再路由该模型；硬删 = 行消失、不可恢复**。V1 无硬删入口，也不需要。

### params (JSON) 怎么填？
它不是「传给上游的请求参数」，而是**参数处置声明**：声明该模型支持哪些生成参数、以及每个参数如何处理。值为「字段名 → 处置」的对象，处置只有四个取值：
- `native`：参数原生透传给上游（如 `speed: "native"` = 速度参数上游真支持）；
- `promptPrefix`：参数值拼进提示词前缀（文生图/视频常用）；
- `instruction`：参数作为指令注入（音频情感等）；
- `metadataOnly`：只存元数据，不影响生成（未列出的参数默认此值）。

示例（文本模型）：`{"temperature":"native","top_p":"native"}`；示例（视频模型）：`{"duration":"promptPrefix","aspect_ratio":"promptPrefix"}`。**不知道怎么填就保持 `{}`**（所有参数仅记元数据，不影响功能），不要填非 JSON 文本。

### providerBinding 与接口协议的关系？
binding 是**服务端装载/适配器白名单**，不是 HTTP 协议族声明。当前四个值：`gateway-openai-compat`（OpenAI 兼容网关）、`fal-http`、`minimax-http`、`zhipu-http`（厂商专用 HTTP 适配）。没有 anthropic 绑定——文本对话类模型一律走 `gateway-openai-compat`。运行时分发实际按模型名/路由决定，binding 只影响目录装载校验与能力清单投影。

### modality 是输入能力还是输出能力？
**输出（生成）能力**，且单选。`image` = 生成图片的模型，`video` = 生成视频，`audio` = 语音合成/音乐生成（配合 audioKind 区分），`text` = 文本生成。「识图/识视频」这类**输入**多模态能力不在本字段建模。

### 上游路由的启停影响范围？
路由按 **pattern 逐条匹配**，禁用某条 = 该 pattern 的流量不再命中此路由，**落到下一优先级路由，最终兜底到 default 行（agnes_hub）**——不是「整个上游网关的模型全不可用」。例如禁用 6 条 apimart 的 image 路由后，`seedream-5.0-pro` 等图片请求会兜底到 agnes_hub（能否生成取决于 agnes_hub 是否支持该模型）。要让某上游整体下线，禁用它名下的全部路由即可。路由行由种子播种，页面只能启停，不能增删改 pattern。

### 健康页的「渠道」列为什么有 platform 之外的 ID？
上半区健康统计聚合的是**全部真实生成流量**（GenerationRecord），按 (模型, 渠道) 分组：`platform` = 平台计费渠道；`cmuuoi2mv...` 这类 = 各用户的 **BYOK 自带 Key 渠道**。所以健康统计天然包含 BYOK 流量（只读统计，不涉及配置）。下半区**探活**只探平台路由表里的上游（agnes/apimart/fal/minimax/stepfun/zhipu），**不探 BYOK**。

### 「最近一次探活」为什么有的行 HTTP/模型数是空的？
那是一次**失败的探活**——看同行「错误」列（如 `超时 (>15000ms)`）。探活超时 = 该次没有拿到 HTTP 状态和模型清单，字段留空是正常表现，不是数据丢失。持续超时说明该上游出口不通或过慢。

### ghost / missing 怎么用？
`ghost 10` = 上游有、目录没有的模型数（候选上架）；`missing 6` = 目录有、上游已没有的模型数（候选下架）。**V1 只显示计数，清单在 API 响应里（`GET /api/admin/upstream-probe/latest` 的 `ghosts[]`/`missing[]`）**，可 curl 查看；页面展示清单已列入增强计划。

### 定价四元组是什么标准？支持倍率吗？
`inputPerM / outputPerM / cacheReadPerM / cacheWritePerM` = **每百万 token 的绝对美元单价**（OpenAI/Anthropic 官方价目同构，cache 两项对应缓存读写计费）。**不支持倍率模式**——要按官方价 ×1.1 加价，请直接算出绝对值填入。

## 8. 边界与已知限制（V1）

- 探活无手动触发（定时 6h）；路由行不能增/改（只能启停）；无账号体系/多角色。
- 定价页对 `pricing: null` 与「未配置」当前展示一致（终审标星的盲区，hardening PR 一并修）。
- 审计 before/after 展开是原始 JSON 文本，无高亮。
- 所有错误以页面顶部红/黄条透出服务端原文——**不会静默吞错**，看到红条先读内容再行动。
