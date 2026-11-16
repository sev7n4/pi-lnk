# P2 会话成本改读定价中心成本行 · 全链改标人民币（CNY）设计

- 日期：2026-11-15
- 状态：**设计稿（方向已获用户批准，待评审）**
- 作者：产品 × 架构联合会审
- 关联立项：`docs/design/2026-11-15-pricing-subject-billing-takeover-design.md` §P2（第 103-110 行）；三决策原始记录 `.workbuddy/memory/2026-11-15.md`
- 取证基线：master `d6c44f3b` 快照树 + eval 树（`p0-args-clean/tree`）；P1 cost 接线已上线（#890）
- 币种决策：**用户 2026-11-15 拍板「全链改标 CNY」**——本文按此，不采用「Nest 侧折回 USD」的小口径方案（该备选的代价对比见 §3）

---

## 0. 一句话结论

把 pi 会话成本（BYOK / 平台透传的 `override.cost` → `usage.cost`）的费率源从渠道 `models[].pricing`（第二手、USD、无来源分级）切换到定价中心 `CostRate`（单一权威、CNY、带 source/provisional/有效期），并把下游消费该值的三处——Prometheus 指标、degraded 兜底结算、SSE 流式预估——**从 USD 口径全链改标为 CNY**，消除「人民币成本被当美元再乘 7.15 汇率」的约 7 倍错价隐患。实施形态为**Nest 侧出口统一币种**（2026-11-15 对抗复审修正）：`override.cost` 恒为 CNY（CostRate 直出、渠道回落源 ×FX 折算），kill switch 只切来源不切币种，FX 收敛为出口单点。改完 `AdminPricingPage`（平台渠道定价页）退役前提成立（P3 阶段 C）。

---

## 1. 问题定义（代码级事实，逐条锚定）

### 1.1 现状链路（USD）

```
渠道 models[].pricing (USD/百万token, 四元组)
  → provider.controller.ts:26-63 ModelPricingDto (inputPerM/outputPerM/cacheReadPerM/cacheWritePerM)
  → ProviderChannel.models JSON 列
  → provider-resolver.service.ts:182,209 channelModelsJson
  → agent.service.ts:2821-2835 resolvePiSessionLlm → resolveChannelModelCost(...) → override.cost
  → pi-runtime model-assembly.ts:232 → Model.cost → vendor calculateCost → usage.cost
  → ① metrics.ts:407-431,708-711 pi_runtime_usage_cost_total (标注 USD)
     ② agent.service.ts:4343-4349 / pricing.service.ts:592-603 degraded 兜底 ×FX → 积分
     ③ 流式预估 estimateCreditsFromUsdCost ×FX
```

**解析器**：`apps/server/src/provider/model-cost.ts:20-78` `resolveChannelModelCost(modelsJson, modelName)`——按 `models[].name` 小写精确匹配，读 `inputPerM/outputPerM/cacheReadPerM/cacheWritePerM`，单键非法则整条未声明，fail-soft 返回 undefined。

### 1.2 权威源 CostRate（CNY）

- `prisma/schema.prisma:894-913`：`CostRate(channel, modelKey, spec, unit, costYuan, source, provisional, effectiveFrom/To, unitQuantity…)`；币种恒人民币（D9，禁 currency/fx 列）。
- 文本三档：`per_1m_tokens_in/out/cache`，`unit=per_1m_tokens`、`unitQuantity=1e6`、`costYuan`=元/百万 token（`cost-record.controller.ts:88-92,309-314`）。
- 现网值（`seed-pricing.ts:44-46,72-74`）：step-3.5-flash 0.7/2.1/0.14 元；agnes-2.5-flash 2.5/7.5/0.5 元（PROVISIONAL 暂定）。
- 读取纯函数：`pricing-unit-cost.ts:74-131 resolveUnitCost(subject, rates, at)`；文本按 `r.spec.endsWith(subject.spec)` 匹配（`pricing-unit-cost.ts:96`）。

### 1.3 两套链路语义差异（核心风险来源）

| 维度 | 渠道 pricing | CostRate | 切换影响 |
|---|---|---|---|
| 币种 | USD | CNY | **本文要消解的错配**：现状 degraded ×FX 把 usage.cost 当 USD |
| 缓存维度 | cacheRead + cacheWrite 两键 | 仅 cache（无 cacheWrite） | 需裁决 cacheWrite：建议 0（CostRate 无此维度） |
| 粒度 | 渠道内 models[].name | (channel,modelKey,spec) 三档 | 需按三档聚合四元组 |
| 可信度 | 无分级 | source 五级 + provisional + 有效期 | CostRate 可标注暂定价，更严格 |
| 命名 | models[].name | modelKey（小写连字符） | 需归一（modelOptionName） |

### 1.4 决定性证据：下游把 usage.cost 当 USD 再乘汇率

- `pricing.service.ts:592-603` `degradedTextTokenQuote`：`usage.costUsd × FX × marginBp`。
- `agent.service.ts:3812-3814` `estimateCreditsFromUsdCost(totals.cost, marginBp, fxUsdCny)`。
- `agent.service.ts:4348`：`...(usage.cost !== undefined ? { costUsd: usage.cost } : {})`——把 vendor `usage.cost` 直接当 USD 传下去。
- `metrics.ts:708-711`：指标 HELP 明写 "LLM usage cost (USD)"。

**结论**：若把 CNY 的 CostRate 值填进 `override.cost` 而不改下游，degraded 兜底与 SSE 预估会把它当 USD 再 ×7.15 → 约 7 倍错价，指标 USD 口径被污染。用户拍板「全链改标 CNY」即为此。

---

## 2. 目标、成功判据与非目标

### 2.1 目标

| # | 目标 | 可验收形态 |
|---|---|---|
| G1 | 会话成本费率源单一权威 | 文本模型 `override.cost` 来自 CostRate，非渠道 pricing |
| G2 | 币种口径统一为 CNY | 指标 HELP/标签、degraded 结算、SSE 预估全部 CNY，无残留 FX 乘数（针对 usage.cost） |
| G3 | fail-soft 不阻断会话 | 无 CostRate / 畸形 → 回落渠道 pricing → 都没有 → 无 cost 字段，会话照建 |
| G4 | 可灰度可回滚 | 新增专用 kill switch，默认回落渠道，灰度期观察指标无异常跳变 |
| G5 | AdminPricingPage 可退役 | 生产验证无会话再依赖渠道 pricing 后，P3 阶段 C 删除该页 |

### 2.2 顶层成功判据

1. 单测：配 CostRate 三档 → `override.cost = {input:0.7, output:2.1, cacheRead:0.14, cacheWrite:0}`（CNY 值，无 FX）；无 CostRate → 回落渠道 pricing 的 USD 值（过渡期）→ 都没有 → undefined。
2. 指标断言：`pi_runtime_usage_cost_total` HELP 标 CNY，数值 == CNY 成本累计，不得再乘 FX。
3. degraded 结算：mock usage.costUsd（现字段名应改为 costCny）→ 积分计算不再乘 FX，断言新口径值。
4. 全量 server 绿、`vue-tsc -b` 0、pi-runtime `node --import tsx --test` 全绿。
5. 生产取证：新会话 llm.cost 来自 CostRate；指标口径切换时点可标注；无约 7 倍跳变。
6. kill switch：设为 off 时行为完全回到渠道 pricing（过渡期），设为 on 才读 CostRate。

### 2.3 非目标与 No-Go

- **不**改对客定价/扣费（`quoteTextTokens` 反比率、主体价）——本刀只动「会话成本（usage.cost）」这条内部成本核算链，与用户积分扣除无关。
- **不**动 `AdminPricingPage` 页面本身（P3 阶段 C 的事）。
- **不**删 `resolveChannelModelCost`（过渡期回落 + 回滚路径保留）。
- **不**处理 BYOK 用户自带 Key 的成本归因（BYOK 成本不进平台 CostRate，设计 6.2）；`resolveCostRateModelCost` 需限定平台渠道命中。
- **不**改 vendor `Model.cost` 四元组契约与 `calculateCost` 行为（pi-runtime 零改动）。
- **不**改 `PointTransaction` 账务。

---

## 3. 方案裁决：全链改标 CNY（用户拍板）vs Nest 侧折回 USD

| 方案 | 做法 | 改动面 | 代价 | 裁决 |
|---|---|---|---|---|
| 全链 CNY（采纳，实施形态=出口统一币种） | Nest 出口把 `override.cost` 恒装 CNY（CostRate 直出、渠道源 ×FX 折算）；下游三处消费去 FX、改标 CNY | Nest + pi-runtime 指标/兜底/预估 | 指标口径断点；触达已上线结算链；回归面广 | **用户拍板采纳** |
| Nest 折回 USD（备选） | 组装 override.cost 前把 CNY ÷ FX 折回 USD，下游零改动 | model-cost.ts + agent.service.ts | 指标仍 USD（语义略绕），但改动最小、不碰结算链 | 未采纳，留档 |

### 3.1 采纳方案的已知代价（必须如实记账）

1. **指标断点**：`pi_runtime_usage_cost_total` 从 USD 改 CNY，历史曲线与切换后不可直接比；需在运行手册与 Grafana 面板标注切换时点（预计 2026-11-2x，合并日）。
2. **字段名连锁**：`usage.costUsd`、`estimateCreditsFromUsdCost`、degraded 注释里的 "USD" 需系统性改名/改注（如 `costCny`、`estimateCreditsFromCnyCost`），避免留下误导。这是本刀最容易漏的「口径残留」。
3. **回归面**：degraded 兜底是生产已上线路径，改 FX 后必须用 mock 精算断言，防止误伤正常对话（正常 token 模型走反比率行，不消费 usage.cost；仅非 token / 价目 degraded 时消费）。
4. **历史数据**：存量会话已装配旧 USD cost，生命周期结束前不受影响（无中途换费率撕裂）；历史指标数据保留 USD 口径，不回灌。

---

## 4. 数据模型与代码流

### 4.1 新增解析器（Nest 侧）

在 `apps/server/src/provider/model-cost.ts` 新增 `resolveCostRateModelCost(rates, modelKey, at)`：

```
输入：CostRate 行数组（按 modelKey 预筛）、modelKey、at
处理：找 per_1m_tokens_in/out/cache 三档（provisional=true 或过期则视为缺）
输出：{ input, output, cacheRead, cacheWrite: 0 } | undefined
纪律：任一必需档缺失 → undefined（宁可少算不错算）；单档畸形 → undefined；fail-soft
```

复用 `resolveUnitCost`（`pricing-unit-cost.ts:74`）做单位归一，或直接用 `costYuan`（文本行 `costYuanPerRequest === costYuan`，见 `pricing-unit-cost.ts:96`）。**注意 seed agnes 的 note 写 PROVISIONAL 但 `provisional` 列为 false**（`seed-pricing.ts:72-74`）——物化链会读它们；P2 若按 provisional 过滤需先决定是修 seed 标志位还是容忍。

### 4.2 组装点改造（Nest 侧）——出口统一币种（2026-11-15 22:15 对抗复审修正，硬伤修复）

**原稿缺陷**：若下游各处直接去 FX，灰度期 kill switch 切换时同一字段 `usage.cost` 会混两种币种（`cost_rate` 源给 CNY、`channel` 回落源是 USD），下游无法区分，degraded 结算与指标在灰度期是错的。

**修正后形态**：**Nest 侧出口统一币种**——无论哪个来源，`override.cost` 恒为 CNY，kill switch 只切来源、不切币种：

`agent.service.ts:2821-2835 resolvePiSessionLlm`：

```
costCny = resolveCostRateModelCost(costRates, ctx.model, now)          // CostRate 直出 CNY
       ?? withFxToCny(resolveChannelModelCost(ctx.channelModelsJson, ctx.model))  // 渠道 USD 源 ×FX 折 CNY
// kill switch: PI_SESSION_COST_SOURCE=cost_rate|channel（默认 channel，灰度期）
// withFxToCny：渠道源（USD/百万）× resolveFxUsdCny → CNY/百万；FX 取数复用既有 resolveFxUsdCny
// 都没有 → undefined（字段不出现）
```

技术可行性：vendor `calculateCost` 只是乘法不关心币种——四元组装 CNY 值，`usage.cost` 出来即 CNY 数值，下游零分支。FX 自此**单点化**：只在本出口折算一处，下游三处消费（指标/degraded/预估）全部去 FX、标注 CNY。灰度期两来源的 `usage.cost` 均为 CNY，切换无币种跳变（数值可能因来源单价不同而变，属预期）。

### 4.3 下游改标 CNY（Nest + pi-runtime）

| 位置 | 改动 |
|---|---|
| `metrics.ts:708-711` | HELP "USD" → "CNY"；指标名可保留 `usage_cost_total`（避免断序列）或新增 `usage_cost_cny_total`（需面板迁移，待评审） |
| `pricing.service.ts:592-603` `degradedTextTokenQuote` | 去掉对 usage.cost 的 FX 乘数（FX 已在 Nest 出口单点折算，§4.2）；参数名 `costUsd` → `costCny` |
| `agent.service.ts:3812-3814` | 同上，`estimateCreditsFromUsdCost` → `estimateCreditsFromCnyCost`（去 FX） |
| `agent.service.ts:4348` | `costUsd` → `costCny` 字段名 |
| `model-assembly.ts:112-126,232` | 注释 USD → CNY（代码透传不变） |
| `llm-override.ts:37-60` | 注释 USD → CNY（校验逻辑不变） |

### 4.4 实施强制核对点

1. **cacheWrite=0 裁决**：CostRate 无 cacheWrite 维度，四元组补 0；若某渠道模型确有 cacheWrite 计费，需登记为已知缺口（不猜）。
2. **provisional 过滤**：先决定 seed agnes note/provisional 不一致的处理（§4.1）。
3. **kill switch 默认值**：默认 `channel`（回落），灰度期手动切 `cost_rate`；与 `PI_LLM_PASSTHROUGH` 交互（后者 off 会连带杀 override，本开关需在 override 下发前提下才有意义）。
4. **命名归一**：`resolveCostRateModelCost` 的 modelKey 与 `ctx.model` 同形核对（复用 `modelOptionName`）。
5. **出口币种一致性（对抗复审新增）**：`override.cost` 必须恒为 CNY——无论 kill switch 处于 `cost_rate` 还是 `channel`。`withFxToCny` 的 FX 取数复用既有 `resolveFxUsdCny`（含缓存/降级行为），禁止第二处 FX 常量。灰度期两来源切换时下游零感知币种差异。
6. **degraded 变异的判据自匹配防区**：现有 `degradedTextTokenQuote` 测试若直接 mock FX 常数，「去 FX」变异可能因 mock 同值而恒绿（伪变异）——判据必须用**非 1 的真实 FX 值**（如 7.15）断言精确积分值，FX 改变 ⇒ 断言值改变，才能证明 FX 真被移除。

---

## 5. 测试与判据（行为级 + 变异自检）

### 5.1 新增单测

- `model-cost.test.ts:11-49` 扩展：CostRate 三档命中→四元组（CNY 值）、缺档→undefined、provisional→undefined、回落渠道（**渠道源值 ×FX 折 CNY 后的精确值断言**，用非 1 的真实 FX）、两源皆无→undefined。
- `agent.service.pi-runtime.test.ts:240-264` 更新：CostRate 命中时 `llm.cost` 来自成本行（CNY）；kill switch 两种取值下 `llm.cost` 均为 CNY 数值（出口币种一致性，核对点 5）；无两源才不带 cost。

### 5.2 pi-runtime 测试

- `metrics.test.ts:115-146`：HELP 标 CNY，数值 == CNY 累计。
- `llm-override.test.ts` / `model-assembly.test.ts`：注释改名不影响断言，但需确认四元组透传仍正确。

### 5.3 变异自检（每个 MUST RED）

| 变异 | 预期判据 |
|---|---|
| `resolveCostRateModelCost` 缺档时返回部分四元组（而非 undefined） | §5.1 缺档判据 RED |
| degraded 去掉 FX 的代码被还原（重新乘 FX） | §5.2/§5.1 degraded 精算断言 RED |
| kill switch off 时仍读 CostRate | §5.1 回落判据 RED |
| cacheWrite 从 0 改为读 cache（错配） | §5.1 四元组断言 RED |
| `withFxToCny` 被删（渠道回落源不折 CNY，直接装 USD 值） | §5.1 kill switch 两取值的币种一致性断言 RED（channel 取值下数值≠CNY 折算值） |

### 5.4 回归

- server 全量绿（基线 2872+）、`vue-tsc -b` 0、pi-runtime `node --import tsx --test` 全绿。
- 正常 token 模型对话不受影响（不消费 usage.cost）。

---

## 6. 改动文件清单（预估）

| 文件 | 改动 |
|---|---|
| `apps/server/src/provider/model-cost.ts` | 新增 `resolveCostRateModelCost` + 回落组合 |
| `apps/server/src/provider/model-cost.test.ts` | 新增 CostRate 源单测 |
| `apps/server/src/agent/agent.service.ts`（`resolvePiSessionLlm` + 3 处 degraded/预估） | 组装切换 + CNY 改标 |
| `apps/server/src/agent/agent.service.pi-runtime.test.ts` | 更新 cost 来源断言 |
| `apps/server/src/pricing/pricing.service.ts`（`degradedTextTokenQuote`） | 去 FX + 改名 |
| `services/pi-runtime/src/metrics.ts` | HELP/口径 CNY |
| `services/pi-runtime/src/metrics.test.ts` | 口径断言 |
| `services/pi-runtime/src/model-assembly.ts` / `llm-override.ts` | 注释 CNY（逻辑不变） |
| 配置/文档 | 新增 `PI_SESSION_COST_SOURCE` 环境变量说明、运行手册指标口径切换时点 |

不改：`prisma/schema.prisma`（复用 CostRate）、`PointTransaction`、对客定价/扣费链。

---

## 7. 分刀与顺序

1. **刀 P2a（本文）**：解析器 + 组装切换 + 全链 CNY 改标 + kill switch + 判据 → 授权合并部署 → 生产取证（新会话 cost 来源、指标口径、无 7 倍跳变）。
2. **刀 P3-C（依赖本刀）**：生产验证无会话依赖渠道 pricing 后，删 `AdminPricingPage`（见 P3 spec 阶段 C）。
3. 与文本断裂刀（T1）无硬依赖，可并行；合并时按 master 前移纪律逐路径核验。

---

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 指标口径断点 | 切换时点标注；面板/告警阈值复核 |
| 字段名残留 USD | §4.3 全表改名 + grep 守卫断言无残留 |
| degraded 回归误伤 | mock 精算断言 + 全量绿 |
| agnes 暂定价被当权威 | provisional 裁决（§4.4）+ 运营知会 |
| 会话成本跳变引发告警 | kill switch 默认 channel，灰度切换 |

**回滚**：`PI_SESSION_COST_SOURCE=channel` 瞬时切回渠道 pricing（成本来源），但指标 CNY 改标需代码回滚或接受双口径并存——这是「全链 CNY」方案相对「Nest 折 USD」的主要回滚成本，已在 §3.1 记账。

---

## 9. 待评审确认

1. 指标名：`usage_cost_total` 保留名改口径，还是新增 `usage_cost_cny_total`（涉及面板迁移）。建议保留名改口径，减少破坏。
2. `provisional` 不一致处理（§4.4 核对点 2）。
3. kill switch 默认值与灰度节奏。

---

## 10. 状态回填（只追加，2026-11-16）

**§9.3 已拍板并执行（2026-11-16 13:15 用户确认）**：生产 `PI_SESSION_COST_SOURCE=cost_rate` 已切换生效。

生产取证（镜像 sha 未变 `1d2cefa15bcd`，零代码变更，容器 recreate 应用 env）：

- 容器内 `printenv PI_SESSION_COST_SOURCE` = `cost_rate`；`PRICING_FX_USD_CNY` 未设（默认 7.2）。
- 生产 DB + 生产 dist 求值：`agnes-2.5-flash` cost_rate 分支 → `{input:0.06, output:0.15, cacheRead:0.005}` CNY（切换前渠道口径 0.36/1.08/0.036，≈7.2x 虚高由此修除）；`agnes-2.0-flash` 三档 provisional=1 → cost_rate 分支 undefined（严格过滤生效，运行时自动回落渠道源）。
- `pi_runtime_usage_cost_total` 切换后基线全 0；真实流量单价验证（≈0.06 元/MTok 形态）并入 P3-A 浏览器走查会话顺带核。
- 回滚：`/opt/lnkpi/.env` 删 `PI_SESSION_COST_SOURCE`（或改回 `channel`）+ `docker compose -f docker-compose.prod.yml up -d --no-build api`，瞬时生效。
- 备份：DB `/root/lnkpi-db-backups/lnkpi.db.before-cost-rate-switch-20261116-1252.db`；env `/opt/lnkpi/.env.before-cost-rate-switch-20261116`。

数值口径说明（预期跳变，非故障）：切换后 Nest 会话成本预估从渠道口径（in ≈4 分/百万）变为 CostRate 口径（in ≈1 分/百万）；权威结算走反比率行仍为 ≈7 分/百万——两条公式固有差异，非本刀引入。
