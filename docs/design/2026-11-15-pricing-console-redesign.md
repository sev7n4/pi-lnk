# 定价中心重构设计：上架即定价 · 单屏卡片墙 · 利润自持

- 日期：2026-11-15
- 状态：设计定稿（用户逐轮拍板），转入实现
- 前置：`docs/superpowers/specs/2026-11-14-pricing-profit-billing-e2e-design.md`（S1 总纲，本设计**只重构运营面，不动计价内核公式**）
- 代码事实基线：master `efcfe756`（PR #874 合并后）干净树逐文件核对

## 0. 一句话

**上架即填数（定价卡片内嵌上架向导），定价中心只是上架模型的「改数墙」（卡片数量恒等于上架模型数），利润率每条记录自持，价目表只读供对账，增删随上下架自动发生。**

## 1. 五条硬规则（用户拍板，逐条对应实现）

| # | 规则 | 实现落点 |
|---|---|---|
| R1 | 一个 渠道×模型 = **一条成本记录**；多规格是记录内的**档位卡片**，点选配置 | 后端聚合端点 GET /admin/pricing/cost-records（每在售模型一条）；前端卡片组件 |
| R2 | 成本记录的**增删只发生在模型上下架**（上架自动建空记录、下架归档留底）；定价中心**无增删入口** | 卡片列表数据源 = 在售目录条目（`ModelCatalogEntry.deletedAt==null`）；定价中心只有改数 |
| R3 | 定价中心只做**改数值**（成本档位数 + 利润率） | PUT /admin/pricing/cost-records/:modelKey |
| R4 | 利润只有一个 X% 数值，**记录自持，无全局继承**；全局仅作上架时预填值，之后互不影响 | 每模型一条 `MarginPolicy(scope='model', scopeKey=modelKey)`；引擎 `resolveMargin` **不改**（model 档优先于 global 是既有行为）；UI 不暴露 global 输入 |
| R5 | 价目表是**只读产物**：生成后用于计费转 credit + 对账 | 物化/发布流不动；价目表入口只链到 versions 页（只读查看） |

## 2. 卡片组件规格（唯一的核心交互组件）

同一张卡片组件，**两个挂载点**：
- **上架向导**（`AdminModelsPage` 新增弹窗内嵌，初始填写模式）：目录表单提交成功后，按模态展示档位输入（预填利润率 10%），可整体跳过（跳过 → 模型在定价中心显示「待填」）。
- **定价中心**（`AdminPricingHubPage`，修改模式）：改成本数 / 改利润率。

卡片骨架（四模态同构）：
```
┌ 卡头：模型名 · 渠道(providerBinding)徽标 · 模态 · 状态徽标(已就绪/待填) ┐
│ 档位 chips（点选 → 编辑该档）：
│   图像   1K / 2K / 4K                    每档 = 元/张
│   视频   480p / 768p / 2k               每档 = 元/秒（时长自动展开）
│   音频   语音(元/百字符) / 音乐(元/首)    按 audioKind 出现哪些显示哪些
│   文本   输入 / 输出 / 缓存              元/百万token 三字段
│ 利润率行：[ 10 ] %（自持数值，直接改）
│ 只读出价预览：成本 × (1+利润率) → credit（抽自物化公式口径）
│ 就绪提示：N 条规格缺成本 → 填完哪些档位即全部出价
└────────────────────────────────────────────┘
```

档位来源 = **主体枚举同一常量源**（`pricing.core.ts` 的 `ENUMERATED_IMAGE_RESOLUTIONS` / `ENUMERATED_VIDEO_RESOLUTIONS_CANONICAL` / audioKind），上架时主体尚未 rebuild 也能列出同一档位——零映射问题。

## 3. 对 S1 已批准设计的三处修订（变更记录）

| # | 修订 | 理由 | 引擎影响 |
|---|---|---|---|
| D-1 | **利润运营面收敛为 model scope 单点**：不再暴露 global/六档继承 UI；每个在售模型恒有一条 `scope='model'` active 策略行 | 全局继承 = 隐式批量变价 + 对账需追溯；记录自持对账零追溯 | `resolveMargin` 零改动（model 档本就优先于 global）；global 行保留为未覆盖模型的兜底，UI 不可见 |
| D-2 | **视频成本粗化为 per_second（每分辨率）**：卡片填「元/秒」，时长档由 `resolveUnitCost` 既有 per_second 路径展开 | 当前种子本就线性（10s=2×5s、4s=5s×4/5），粗化无损；维护面 36+ 行 per_video → 每模型 3 行 | ⚠️ `resolveUnitCost` 视频分支收紧：per_second 行从「仅按 family 匹配」改为「`modelKey === subject.modelKey && spec === res` 精确匹配」（原实现不看分辨率，2k 会误用 480p 每秒成本）；legacy per_video 行的 family 匹配语义保持不变 |
| D-3 | **一键导入成本概念移除**：`POST /cost-rates/import` UI 入口下线；`inferCostUnit`（按主体推断计量单位）逻辑迁移复用到卡片保存路径 | 上架卡片填数天然绑定模型，不存在映射问题 | 端点暂保留（内部/迁移期复用），不新增 UI 入口 |

## 4. API 契约（新增 `admin/pricing-cost-record.controller.ts`）

### 4.1 `GET /api/admin/pricing/cost-records`
聚合每个在售目录条目为一条记录：
```jsonc
{
  "code": 0,
  "data": [
    {
      "modelKey": "agnes-video-2.5-flash",
      "displayName": "…",
      "modality": "video",
      "audioKind": null,
      "channel": "gateway-openai-compat",      // providerBinding
      "profitPct": 10,                          // model-scope MarginPolicy；无行 → null（卡片按预填 10 展示，保存落库）
      "tiers": [                                // 按 modality 由枚举常量展开
        { "spec": "480p", "label": "480p", "unit": "per_second", "unitQuantity": 1,
          "costYuan": null, "perVideoDerived": null },   // perVideoDerived：legacy per_video 行折算的每秒参考值（展示用，非存储）
        …
      ],
      "subjectsTotal": 12,
      "missingSpecs": ["480p:4s", …],           // 复用 resolveUnitCost 逐主体判定
      "status": "missing"                        // ready | partial | missing
    }
  ]
}
```
- 数据源：在售 `ModelCatalogEntry`（deletedAt==null）× 对应 `PricingSubject` × `CostRate` × model-scope `MarginPolicy`。
- 视频档位取值：per_second 行（modelKey 精确 + spec=res，effective）优先；无则从该 res 的 legacy per_video 行折算 `costYuan/dur` 显示为参考值（不落存储）。

### 4.2 `PUT /api/admin/pricing/cost-records/:modelKey`
```jsonc
{ "tiers": [{ "spec": "480p", "costYuan": 0.57 }, …], "profitPct": 10 }
```
- 校验：modelKey 必须是**在售**目录条目（下架模型 404 —— R2：定价中心无增删，只改在售）。
- costYuan>0：upsert `CostRate(channel='platform', modelKey, spec, unit, unitQuantity)`（unit 推断复用 `inferCostUnit` 口径：视频 → per_second/spec=res；图像 → per_image/res；音频 → per_call/per_100_chars|per_song；文本 → per_1m_tokens_in|out|cache）。
- 视频档位保存时**顺带退役**同模型同 family 同 res 的 legacy per_video 行（`effectiveTo=now`，留底不删）——卡片逐次编辑即自迁移。
- profitPct：upsert `MarginPolicy(scope='model', scopeKey=modelKey, profitBp=profitPct*100, priceFloorBp=500, status='active')`（地板校验沿用 margin 控制器规则）。
- FORBIDDEN_COST_FIELDS 守卫照旧（AC10 单一人民币）。

### 4.3 `POST /api/admin/pricing/cost-records/migrate-video-per-second`
一次性迁移端点（幂等）：把在售视频模型的全部生效 per_video 行折算为 per_second 行（`per_second = costYuan / 秒数`，spec=res），并将原 per_video 行 `effectiveTo=now` 退役。返回 `{converted, retired}`。生产执行前按纪律 DB 备份。

## 5. UI 结构（页面 / 路由 / 菜单）

| 变更 | 内容 |
|---|---|
| 新增 | `AdminPricingHubPage.vue`（定价中心）：顶栏（生成价目表 / 价目表只读入口 / 发布）；左栏在售模型按模态分组 + 状态点；主区选中模型卡片（修改模式） |
| 替换 | `AdminPricingSimplePage.vue` 删除（路由/菜单/文件），由定价中心替代 |
| 保留 | 三张高级表页（subjects/cost-rates/margin-policies）**路由保留、菜单移入「高级（原始数据）」子分组**——逃生口，日常不进 |
| 修改 | `AdminModelsPage` 新增弹窗内嵌定价卡片（初始填写模式，可跳过）；提交链：POST catalog → PUT cost-records |
| 不动 | 物化 / 发布 / 门禁 / versions 页（价目表只读查看） |

## 6. 存量迁移（生产）

1. DB 备份（双端 sha + 只读快照纪律）。
2. 调 `POST /migrate-video-per-second`（幂等，返回 converted/retired 计数）。
3. 为全部在售模型补 `scope='model'` MarginPolicy 行（profitBp=1000，即现 global 值物化）——由迁移端点同事务完成或脚本执行；global 'launch' 行保留兜底不删。
4. 视频/音频缺的真实成本数字：仍需用户供数（agnes-video-2.5-flash / cogvideox-flash / h3-max-turbo 全 12 档、h3-max/minimax-h3 缺档、音频 4 条）——定价中心卡片即为填数入口，**不能编造**。

## 7. 验收标准

- **等价金标准**：迁移 + 粗化后，任一视频主体 materialize 的 `costYuanPerRequest` 与迁移前 per_video 口径**逐条相等**（per_second × dur == per_video 行值）。
- 引擎测试：per_second 行 `(modelKey, spec=res)` 精确匹配；跨模型 per_second 不再命中（变异自检 RED）。
- 聚合端点：在售模型数 = 卡片数；下架模型不出现在 GET；PUT 对下架模型 404（R2 变异自检）。
- 利润自持：PUT profitPct → model-scope 行落库 → materialize 生效值 == 该值；无行时回退 global 兜底（1000）。
- 前端：定价中心无新增/删除记录入口；上架弹窗可跳过定价卡（跳过后 hub 状态=待填）。
- 门禁：`vue-tsc -b`、vitest 全量、既有 S1 验收测试全绿。

## 8. 明确不做（本期）

- 不动 `creditsOf` / 反比率 / 发布门禁 / 计费链。
- 不做多渠道（一模型多 providerBinding）拆卡——当前目录一对一，出现再拆。
- 不做批量填数工具（全线调价场景出现再加）。
- 不删 legacy per_video 历史行（对账留底，仅 effectiveTo 退役）。
