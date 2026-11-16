# 文本 token 物化→扣费链路接通（文本调价断裂修复）设计

- 日期：2026-11-15
- 状态：**已实施闭环（2026-11-16 回填）**——PR #898 squash `9ea291a34e` 合并上线；生产复测通过（改成本 0.05→0.06 物化发布后 ratios 端点 in 3636→151515，逐位==ratioOf 理论值；notifyUsers 默认 false 生产验证）。§4.3 核对点 4 已按对抗复审修正：三段行**不**要求新增快照强制，跟随门禁既有 token 行语义（豁免 unitSnapshot、地板判上限）。卡片「草案待发布」显示口径（锁①）仍未实施。
- 作者：产品 × 架构联合会审
- 关联立项：`docs/design/2026-11-15-pricing-subject-billing-takeover-design.md` §P1 第 39 行「文本：`quoteTextTokens` 已按模型反比率行结算，不动」——**本文修正该假设**：文本确实走反比率行，但该行不随物化刷新，形成断裂。
- 取证基线：master `d6c44f3b`（#895）快照树（`.workbuddy/eval/p0-args-clean/tree`），逐文件核对行号；生产 active 版本 `v-retest-895-212426`。
- 利益关系：本文与 P1.6 卡片口径（锁①）共用 cost-records 聚合端点，但两把锁**独立修复、可分刀合并**。

---

## 0. 一句话结论

|                                          |       |                                        |       |      |          |                                                                                                                                                                                                                                       |
| ---------------------------------------- | ----- | -------------------------------------- | ----- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文本 token 的扣费读的是三段反比率行 \`text:<model>:<in | cache | out>`，而 #890 物化器把更新后的反比率只写进六段主体行 `text | model | spec | provider | upstream`，两套键空间互不相通，导致定价中心改成本/利润→物化→发布后文本价格纹丝不动（agnes-2.5-flash 仍是旧 3636 → 275 分/百万，而新成本应约 6 分/百万）。修复方式：**物化器对 token 主体在现有六段主体行之外，额外 upsert 一条同值的三段 `text:\` 反比率行，并把它确立为文本扣费的唯一真相源\*\*——不动结算公式、不动公开端点契约、不动 SSE 预估逻辑，一跳接通「物化→发布→文本扣费」。 |

---

## 1. 问题定义（代码级事实，逐条锚定）

### 1.1 用户可观测症状

定价中心 hub 页改某文本模型的成本或利润率 → 保存 → 点「生成价目表」→ 去发布流页发布 → 实际对话扣费仍是旧价；卡片上文本的「物化后扣费积分」也不变。

### 1.2 双锁模型（两把独立的锁，症状叠加）

| 锁      | 层面 | 现象                                | 影响范围 | 归属                                         |
| ------ | -- | --------------------------------- | ---- | ------------------------------------------ |
| **锁①** | 显示 | 卡片读 active 版本，物化只写 draft，未发布前显示旧值 | 全模态  | 用户已拍板：保持 active 真源 + 加 draft 对比提示（另案，见 §7） |
| **锁②** | 结算 | 发布后文本扣费仍读旧三段行，物化产物（六段）无消费点        | 仅文本  | **本文修复**                                   |

### 1.3 锁②的证据链

**写入端（物化产物落错键空间）**

- `pricing-materializer.service.ts:102-105`：对 `billableUnit.startsWith('token_')` 的主体，`credits = ratioOf(unit.costYuanPerRequest, margin.profitBp)`（反比率）。
- `pricing-materializer.service.ts:22-23`：`ratioOf(cost, bp) = Math.floor(1e8 / (cost * (10000 + bp)))`。与 seed 的 `floor(1e6/(2.5×110))=3636` 在 `bp=1000` 时逐值等价。  
  |  |  |  |  |  |  
  | --- | --- | --- | --- | --- |
- `pricing-materializer.service.ts:133,149`：`matchKey = s.subjectKey`（六段），`buildEntryData` 写入 `subjectKey = s.subjectKey`。文本主体 spec 为 `in/cache/out`（`pricing-subject.service.ts:108-112`），故产物形如 `text|agnes-2.5-flash|in|agnes_hub|… = 181818`（约 5.5 分/百万）。

**读取端（扣费读三段旧行）**

- `pricing.service.ts:393`：`quoteTextTokens` 用 `buildTextTokenMatchKey(model, spec)` 拼 key。
- `pricing.core.ts:191-193`：`buildTextTokenMatchKey = text:${modelKey}:${spec}`（三段）。
- `pricing.service.ts:420-422`：从 `entries`（`loadActiveTable()` 的 `matchKey → credits` 单索引，`:664-668`）取 `rIn/rOut/rCache`，交给 `computeTextTokenCredits`（`:61-81`，`charge = ceil(tokens / r)`）。  
  |  |  |  
  | --- | --- |
- `pricing.service.ts:551`：`getActiveTextTokenRatios` 显式 `if (key.includes('|')) continue`——**六段文本行被公开端点主动排除**。
- `agent.service.ts:4343,4733`：冻结/结算都调 `quoteTextTokens`，与报价同源。
- `cost-record.controller.ts:139-143,245`：P1.6 卡片文本档也读三段 `text:` 行（同样是「真实结算口径」）。

**断裂确认**

- `pricing.core.ts:116-128`：`deriveSubjectSpec('text')` 恒 `undefined`，`quote()` 的主体分支（`pricing.service.ts:234/253/260`）对文本短路。
- 全仓 `subjectEntries` 读取点仅 `pricing.service.ts:234/253/260`，文本三条读取函数（quote/预估/公开端点）一次都不读。
- 结论：**六段文本主体行从生成起零消费点**，是历史设计误投射；三段旧行由 `seed-pricing-v2-draft.ts` 写死 3636，从未被物化刷新。

### `1.4 为什么不是「改读六段」而是「刷三段」`

`（承接用户批准的架构裁决，见 §3）`

---

## 2. 目标、成功判据与非目标

### 2.1 目标

| #  | 目标               | 可验收形态                                                                   |
| -- | ---------------- | ----------------------------------------------------------------------- |
| G1 | 文本价格随定价中心成本/利润变化 | 改成本→物化→发布后，`quoteTextTokens('agnes-2.5-flash',…)` 从 275 分/百万口径变为新成本派生口径 |
| G2 | 卡片与扣费同源          | P1.6 卡片文本档 `materializedCredits` 与 `quoteTextTokens` 读同一条三段行            |
| G3 | 全链路一致            | 报价、SSE 流式预估、公开反比率端点、冻结、结算六处读同一反比率                                       |
| G4 | 不破坏历史账单          | 已入账 `PointTransaction` 按 `ruleVersion` 固化，不受新行影响；切价前后分桶可对账              |

### 2.2 顶层成功判据

1. 端到端用例：建文本主体 → 改 `CostRate.per_1m_tokens_in` → `materialize` → 发布 active → `quoteTextTokens` 断言新积分，**变异（去掉三段 upsert）后 RED**。
2. 六处读取点一致性守卫：报价 / `prepareTextTokenQuote` / `getActiveTextTokenRatios` / freeze / settle / 卡片，全部命中同一三段 key，无遗漏。
3. 反比率公式等价锚：`ratioOf(2.5,1000) === 3636`，且 `ratioOf(0.05,1000) === 181818`（≈5.5 分/百万）。
4. 无回归：图/视频/音频/图编物化与扣费逐条金标准不变（六段主体行写入逻辑零改动）。
5. 历史兼容：切价前 `PointTransaction` 金额不变，新流水按新 `ruleVersion` 重算一致。

### 2.3 非目标与 No-Go

- **不**把文本扣费改读六段主体行（方案②）——见 §3 裁决。
- **不**动 `computeTextTokenCredits` / `estimateCreditsFromUsdCost` 公式与 FX 兜底。
- **不**动 studio 文本直生链路（`studio.service.ts:641,803` 的 `quote({capability:'text'})` 单行 5 分）——Out of Scope，两套键空间以 `text:` 前缀隔离。
- **不**删 legacy 三段行与其他模态 legacy 行（兜底与金标准基准）。
- **不**改 seed 阶段 `seed-pricing-v2-draft.test.ts:218` 的 3636 断言——它测的是 seed 逻辑（成本 2.5 → 3636），与物化刷新无关；改它等于篡改历史契约。
- **不**改 active 价目表首次 seed 的既有内容（增量 upsert，不动原行）。

---

## 3. 方案裁决（三候选的对抗性评估）

| 方案           | 做法                                                          | 改动面                          | 风险                                                                                                     | 裁决     |
| ------------ | ----------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| ①（采纳，细化见 §4） | 物化时额外刷三段 `text:` 反比率行，确立其为文本扣费真相源                           | materializer 1 主文件 + 发布门禁/测试 | 低：不动公式、不动读取端、不动公开端点；回滚=删新增 upsert                                                                      | **采纳** |
| ②            | 文本扣费六段化（quoteTextTokens / 预估 / 公开端点 / deriveSubjectSpec 全改） | 4+ 读取函数 + 选价规则               | 高：`quoteTextTokens(userId,model,usage)` 无 provider/upstream 六元组，须凭空发明选价规则；牵动 SSE 预估同源、灰度、degraded、前端徽标 | **否决** |
| ③            | 物化跳过文本，维持 legacy                                            | 2-4 文件                       | 伪修复：文本价格永不随定价中心变化，与 #890 目标冲突                                                                          | **否决** |

### 3.1 关键反对意见与回应

- **「双写会分叉」**：不改变真相源数量——文本的扣费真相本就是三段行（所有读取点都读它），物化只是补上「谁写三段行」这一缺位写者。六段文本行保留但明确降级为「物化副产物」，任何新消费点禁止读它（加接线守卫，见 §5.3）。真正的分叉是「两个独立权威写者」，而非「一个权威写者 + 一个无害副产物」。
- **「为何不彻底六段化」**：文本成本行全部 `channel=platform` 单一来源（`seed-pricing.ts` 与 `cost-record.controller.ts` 的 `mapTierToCostRow` 均为 platform），没有多渠道定价的业务基础。②是在解决不存在的问题，还引入真实歧义（同名模型多路由取哪条？）。
- **「为何保留六段行写入而不是纯替换」**：六段行的 `bySubjectKey` 索引承担 prev 命中、`ops-modified` 保护、`unchanged/changed` 统计；纯替换会破坏这套机制并引入重复 add。保留六段写入使改动局部化、可回滚，且为未来②留出数据基础。**但六段文本行自此标记 deprecated（2026-11-15 对抗复审补充）**：它是零消费点的死数据，本刀在物化器与其写入处加注释声明「文本扣费真相源=三段行，六段文本行仅副产物、禁止消费、计划未来版本停写」，退役时机与方案②评估一并纳入后续立项，防止死数据永久化。

---

## 4. 数据模型与代码流

### 4.1 写入侧（本刀唯一新增逻辑）

在 `pricing-materializer.service.ts` 的 `materialize()` 循环内，对 `isToken` 主体：

1. 现有流程照常：算 `credits = ratioOf(...)`、地板校验、写/更新六段主体行（**零改动**）。
2. **新增**：计算三段 key `text:${modelKey}:${spec}`（复用 `buildTextTokenMatchKey`，模型键归一化见 §4.3 核对点 1），在**同一 draft 版本**内 upsert 一条 `PriceListEntry`：
   - `matchKey = 三段 key`
   - `credits = 同一 ratioOf 值`
   - `subjectKey = null`（三段行不参与主体解析，与 seed 三段行一致）
   - `basis = 'auto-derived'`，`reason = null`
   - `costRateId` 必带（地板校验入口，见核对点 4）；**不**要求 unitSnapshot/成本快照——门禁对 token 三段行有原生豁免语义（核对点 4），物化行跟随既有语义而非新增强制
3. `ops-modified` 保护：若该三段 key 已存在且 `basis === 'ops-modified'`，跳过不覆盖（与六段行同纪律）。
4. 幂等：重复物化命中已有三段行且 credits 相同 → `unchanged`；不同 → `changed`；不存在 → `added`。计数并入 `MaterializeResult`。

### 4.2 读取侧（零改动，仅验证）

六处读取点均按既有逻辑读三段行，本刀不改其代码：

- `pricing.service.ts:393,420-422`（`quoteTextTokens`）
- `pricing.service.ts:473-534`（`prepareTextTokenQuote`）
- `pricing.service.ts:542-578`（`getActiveTextTokenRatios`）
- `agent.service.ts:4343`（settle）、`:4733`（freeze）
- `cost-record.controller.ts:139-143,245`（卡片）

### 4.3 实施强制核对点（写错即错价）

1. **模型键归一化形态**：主体 `subjectKey` 用 `modelOptionName(modelKey).toLowerCase()`（`pricing-subject.service.ts:61`），三段 key 用 `quoteTextTokens` 传入的 `model`（`pricing.service.ts:393`）。必须确认二者对全部 `TEXT_TOKEN_MODELS`（`pricing.core.ts:177-188`，含 agnes-2.5-flash）逐值一致；若不一致，新增纯函数统一归一化并两端调用，禁止在物化器里另写一套。
2. **spec 集合**：三段 key 的 spec 用 `TEXT_TOKEN_SPECS = ['in','cache','out']`（`pricing.core.ts:161`），与主体 `billableUnit=token_<spec>` 同源；禁止硬编码字符串。
3. **地板校验口径**：三段行地板由 `checkFloors` 的 token 分支判上限（用 `rate.costYuan`，见核对点 4），物化时同值写入的六段行则照常走主体行分支（成本快照判下限）——两分支语义不同是既有设计（`pricing-publishing.service.ts:520-522` 注释），物化器不得混淆。
4. **发布门禁（2026-11-15 22:15 对抗复审修正）**：门禁已原生识别三段 token 行——`pricing-publishing.service.ts:492` 用 `isTextTokenMatchKey(e.matchKey)` 豁免 token 行的 unitSnapshot 校验，`:545-547` 对 token 行地板走「判**上限**、用 `rate.costYuan`（CostRate 渠道单价）」分支；seed 三段行正是以该语义过门禁。物化三段行必须**跟随**既有语义（带 `costRateId` 供地板校验即可），**禁止**为三段行新增强制快照/subjectKey 要求——与门禁既有豁免冲突会让三段行发布失败。核对点 3 的「同一 costSnapshotYuan」表述同步作废：三段行不依赖快照，地板由 `rate.costYuan` 判上限。

---

## 5. 测试与判据（行为级 + 变异自检）

### 5.1 新增端到端测试（核心判据）

文件：`pricing.s1-acceptance.test.ts`（扩展）或新建 `pricing-text-reprice-link.test.ts`。

```
建文本主体(text:agnes-2.5-flash:in) → 写 CostRate(per_1m_tokens_in, 0.05元)
→ materialize(draftId) → publish(draftId)
→ quoteTextTokens(userId,'agnes-2.5-flash',{inputTokens:1e6,outputTokens:0,cacheTokens:0})
→ 断言 credits ≈ 6（ratioOf(0.05,1000)=181818 → ceil(1e6/181818)=6）
→ 改 CostRate 为 0.10 → 再物化发布 → 断言 credits ≈ 3（价格跟随）
```

### 5.2 六处读取一致性守卫

静态 + 行为结合：断言 `materialize` 后 active 表中三段 key 存在且 credits == 六段文本主体行 credits；断言 `getActiveTextTokenRatios` 返回的 `agnes-2.5-flash.in` == 同值；SSE 预估（`prepareTextTokenQuote`）用 mock usage 断言与 `quoteTextTokens` 同式。

### 5.3 接线守卫（防未来误用六段）

|                                    |                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 新增测试：遍历 active 表所有 `matchKey` 含 \` | `且 capability=text 的条目，断言其`subjectKey\` 对应的三段 key 存在且 credits 相等（保证副产物与真相源不漂移）。注释声明「六段文本行禁止作为扣费读取源」。 |

### 5.4 变异自检（每个 MUST RED）

| 变异                                                      | 预期判据                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 删掉新增三段 upsert                                           | §5.1 端到端测试 RED（发布后仍读旧 3636）                                                                                                      |
| 三段 credits 写成六段值以外的常数                                   | §5.2 一致性守卫 RED                                                                                                                   |
| 模型键归一化不统一（物化用原名、扣费用小写）                                  | §4.3 核对点测试 RED（key 不匹配）                                                                                                          |
| 三段 upsert 的 credits 不取 `ratioOf` 结果、改取六段正价口径（creditsOf） | §5.1 端到端 RED（积分数量级从「分/百万」错成「每请求分」）；现有 `pricing-materializer.service.test.ts` 的 ratioOf 公式锚仍绿，故必须靠本刀端到端判据捕获——这是「整文件绿≠判据 RED」的重点防区 |

### 5.5 回归

- 全量 server suite 绿（基线 2872+）。
- 图/视频/音频/图编物化金标准逐条不变（六段写入逻辑未动）。
- `vue-tsc -b` 0（本刀纯后端，无前端类型变化）。

---

## 6. 改动文件清单（预估）

| 文件                                                              | 改动                             |
| --------------------------------------------------------------- | ------------------------------ |
| `apps/server/src/pricing/pricing-materializer.service.ts`       | 新增三段 text 行 upsert（§4.1）       |
| `apps/server/src/pricing/pricing.s1-acceptance.test.ts`（或新测试文件） | 端到端判据 + 一致性守卫                  |
| `apps/server/src/pricing/pricing-subject.service.ts`（条件）        | 若 §4.3 核对点 1 不通过，抽出统一模型键归一化函数  |
| `apps/server/src/pricing/pricing.core.ts`（条件）                   | 同上，复用 `buildTextTokenMatchKey` |

不改：`pricing.service.ts` 读取逻辑、`agent.service.ts`、`studio.service.ts`、`cost-record.controller.ts`（消费端零改动）。

---

## 7. 与锁①的协同（用户已拍板，另案实施）

用户决策：**卡片保持 active 真源，加 draft 对比提示**。实现要点（不属本刀，但需共存）：

- `cost-records` 聚合在 active 版本外，额外查最新 draft 版本的同名条目，若 credits 不同则在新字段（如 `draftMaterializedCredits`）返回草案值。
- hub 卡片显示「草案 vX 待发布：X 分」，active 值仍是主显示，避免误导；**草案值必须标注版本名**——draft 复用机制（`AdminPricingHubPage.vue:172-175`）导致「改数→保存→未物化」窗口内 draft 是陈旧的，不带版本名的对比值会二次制造「我改了怎么还不变」。
- **`saveRecord` 成功 toast 补引导文案「预览后请点生成价目表出价」**（2026-11-15 对抗复审补充；`syncApply:222` 已有此文案，`saveRecord:156` 缺失）——没有这句，运营保存后看到的草案对比值不反映刚改的数。
- 本刀修复后，draft 对比值才会正确反映文本调价；两刀合并前，draft 对比对文本无意义（因物化产物本就没进扣费链）——故**建议本刀先合，锁①后合**，或同批但判据分开。

---

## 8. 分刀与顺序

1. **刀 T1（本文）**：文本物化→扣费接通 + 判据 + 变异 → 授权合并部署 → 生产复测（改一次文本成本，物化发布，验对话扣分与卡片）。
2. **刀 T2（锁①，另案）**：卡片 draft 对比提示（纯展示，前端 + cost-records 聚合）。
3. 与 P2/P3 无硬依赖，可并行立项；合并时按 master 前移纪律逐路径核验。

---

## 9. 风险与回滚

| 风险                                   | 缓解                                                              |
| ------------------------------------ | --------------------------------------------------------------- |
| 三段行 upsert 污染 seed 段（seed 也写三段 3636） | 物化只操作 draft 版本；seed 段在版本创建时一次性写入，物化 upsert 的是同版本同 key，幂等覆盖；不跨版本 |
| 双写不一致（六段改、三段没改）                      | §5.3 接线守卫断言同值；`ops-modified` 两边同纪律                              |
| 归一化漂移导致 key 不匹配                      | §4.3 核对点 1 强制对拍                                                 |
| 发布后历史账单被误认为变价                        | `ruleVersion` 分桶对账，切价前流水不参与新价断言                                 |

**回滚**：删除 `materialize` 中新增的三段 upsert 即可（六段写入零改动），active 表切回上一版本即恢复旧价；无需数据迁移。

---

## 10. 待评审确认

- §4.3 核对点 1 的实际结果（模型键是否同形）——实施第一步先跑对拍脚本，若发现不一致需在本 spec 补记为 D1 决策。
- 是否将 T2（锁①）纳入同批合并——建议分刀，待确认。
