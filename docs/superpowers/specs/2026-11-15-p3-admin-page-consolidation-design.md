# P3 运营后台页面收敛设计（分三阶段）

- 日期：2026-11-15
- 状态：**设计稿（方向已获用户批准，待评审）**
- 作者：产品 × 架构联合会审
- 关联立项：`docs/design/2026-11-15-pricing-subject-billing-takeover-design.md` §P3（第 112-121 行）
- 取证基线：master `d6c44f3b` 快照树；路由 `apps/web/src/router/index.ts:96-112`、菜单 `AdminLayoutPage.vue:53-69`、hub 页 `AdminPricingHubPage.vue`
- 依赖：阶段 C 硬依赖 P2 上线验证（见 `2026-11-15-p2-session-cost-cny-migration-design.md`）

---

## 0. 一句话结论

运营后台现有 12 个子页（渠道定价菜单下 4 项「定价中心/主体/成本/利润」+ 平台渠道定价 + 价目发布流 + 灰度 + 工具页）。收敛目标是菜单 6 项。但**删除动作有硬前置**：hub 页目前没有发布按钮、没有 diff 预览、没有回滚、没有公告开关，而这些能力都在「价目发布流页」上——先把它上收到 hub（阶段 A，纯增量零删除），才能安全删三张「原始数据·高级」页（阶段 B），最后在 P2 上线验证后才能删平台渠道定价页（阶段 C）。全程只删前端页面，保留后端 controller 与 `admin-api.ts` 接口作为逃生口，任何一步可靠「恢复路由+菜单」瞬时回滚。

---

## 1. 现状盘点（代码级事实）

### 1.1 路由与菜单

`router/index.ts:96-112` 12 个子页：models / routes / health / **pricing（AdminPricingPage 平台渠道定价）** / **pricing-hub（定价中心）** / **pricing-versions（价目发布流）** / **pricing-subjects（主体·高级）** / **pricing-cost（成本·高级）** / **pricing-margin（利润·高级）** / gray-release（灰度） / audit / guide。

`AdminLayoutPage.vue:53-69` 菜单：渠道定价子菜单含 hub + 三张高级页；顶层另有平台渠道定价、价目发布流、灰度发布。

### 1.2 各候选页的独占能力（删前必须迁移）

| 页面 | 独占能力 | hub 是否已覆盖 | 结论 |
|---|---|---|---|
| 主体页 `AdminPricingSubjectsPage.vue` | 物化按钮、就绪检查、**发布入口**（`:121-152`）、rebuild、主体表视图 | hub `refreshPricing`（`:165-201`）已含 rebuild→建draft→materialize→readiness；**无 publish** | 有缺口：发布入口未上收 |
| 成本页 `AdminCostRatesPage.vue` | 原始 CostRate CRUD（含 source/provisional/unitQuantity） | hub 卡片 `saveRecord`（`:130-163`）覆盖在售模型改数；高级逃生口未覆盖 | 日常可删，逃生口丢失 |
| 利润页 `AdminMarginPoliciesPage.vue` | 六档 scope 利润率 CRUD | hub 卡片仅 `scope=model` 利润率 | 日常可删，六档逃生口丢失 |
| 发布流页 `AdminPricingVersionsPage.vue` | **diff 预览、rollback（`:179-197`）、发布公告开关（notifyUsers）**、行内改价 | hub 全无（仅门禁检查 + 链接过去） | 有缺口：三项未上收 |
| 灰度页 `AdminGrayReleasePage.vue` | 白名单 preview/create/promote/rollback/report | 无；表空未启用 | 藏菜单保留文件 |
| 平台渠道定价 `AdminPricingPage.vue` | 渠道 `models[].pricing` 写入面 | 依赖 P2 切换后才有替代 | P2 前不可删 |

### 1.3 hub 页现状

`AdminPricingHubPage.vue` 已有：成本卡片墙、物化积分展示（P1.6）、`refreshPricing` 全链（rebuild→draft→materialize→readiness）、同步上游价目。**没有**：publish 按钮、diff 面板、rollback、公告开关、独立 rebuild/主体表。

---

## 2. 目标、成功判据与非目标

### 2.1 目标

| # | 目标 | 可验收形态 |
|---|---|---|
| G1 | 菜单 12→6 项 | 收敛后：模型目录·上游路由·健康探活·定价中心·审计日志·使用说明 |
| G2 | 发布闭环不丢能力 | diff/发布/回滚/公告四能力在 hub 可用，逐条对照发布流页 |
| G3 | 逃生口可回滚 | 后端 controller + admin-api 全保留，删页可瞬时恢复 |
| G4 | 零功能回归 | 各阶段上线后现有 hub/发布流测试全绿 + 生产走查 |

### 2.2 非目标与 No-Go

- **不**动后端 controller（`pricing-cost/margin/subject/publishing/gray`）——只删前端页面。
- **不**删 `admin-api.ts` 的 `pricingS1.*` / `pricingVersions.*` / `pricingGray.*` 接口方法。
- **不**动灰度发布设施（表空未启用，No-Go 继承立项设计）。
- **不**在 P2 上线验证前删 `AdminPricingPage`（硬依赖）。
- **不**删 doc 历史资产（仅同步页面清单描述，非运行依赖）。

---

## 3. 三阶段设计

### 阶段 A — hub 上收发布闭环（本轮可实施范围，纯增量零删除）

**改动**：在 `AdminPricingHubPage.vue` 新增发布面板，从发布流页迁入四项能力：
1. **publish 按钮**：二次确认 + 门禁判定（复用 `getReadiness`）+ 调 `pricingVersions.publish(draftId, notifyUsers)`，带公告开关。
2. **diff 预览面板**：迁入发布流页 `loadDiff`（`:115-126`）的涨跌档数、maxIncrease/maxDecrease、地板违规/缺成本/无覆盖标红。
3. **rollback 按钮**：迁入 `rollback()`（`:179-197`）。
4. **公告开关**：`notifyUsers` 胶囊，沿用 #895 发布弹窗语义。

**测试迁移**：`AdminPricingVersionsPage.test.ts:188/227/249`（diff/发布/回滚三用例）迁入 `AdminPricingHubPage.test.ts`。

**验收**：hub 上完成一次「改数→生成价目表→看 diff→发布（带公告）→回滚」全流程；现有测试全绿；**零删除**，可瞬时回滚（撤销本 PR）。

### 阶段 B — 删三张高级页 + 藏发布流/灰度菜单（依赖 A 稳定）

**前置**：阶段 A 上线并生产走查稳定。

**改动**：
- 删 `AdminCostRatesPage.vue`、`AdminMarginPoliciesPage.vue`、`AdminPricingSubjectsPage.vue`（三张均无测试覆盖，日常操作已被 hub 覆盖）。
- 发布流页、灰度页**先藏菜单保留文件**（回滚工具 + 表空设施）；`router` 与 `AdminLayoutPage.vue` 对应行删除/注释。
- 改 hub `:243` 链接与 `:387` 文案（不再指向待删的发布流页）、`AdminGrayReleasePage.vue:235` 引导文案。
- 逃生口确认：后端 controller 保留，必要时可临时恢复路由。

**验收**：菜单收敛；三张页删除后 hub 全流程不回归；保留页文件可恢复。

### 阶段 C — 删平台渠道定价页（依赖 P2 上线验证）

**前置**：P2 上线并生产验证无会话再依赖渠道 `models[].pricing`（见 P2 spec G5）。

**改动**：删 `AdminPricingPage.vue` + `AdminPricingPage.test.ts`；清 `router` / 菜单引用；后端 `ModelPricingDto.pricing` 与 `resolveChannelModelCost` 作为过渡回落保留（P2 spec 明确不删）。

**验收**：会话成本来源取证全部为 CostRate；删页后会话成本不回归。

---

## 4. 测试与判据

### 4.1 行为级

- 阶段 A：`AdminPricingHubPage.test.ts` 新增/迁入 publish+diff+rollback+公告 4 类用例；`vue-tsc -b` 0；前端单测全绿。
- 阶段 B/C：路由/菜单快照测试（断言菜单项数）；被删页无残留引用（grep 守卫）。

### 4.2 接线守卫（防逃生口误删）

新增静态测试：断言 `admin-api.ts` 的 `pricingS1/pricingVersions/pricingGray` 方法全在、后端 controller 文件全在——删页不删接口，违者 RED。

### 4.3 变异自检

| 变异 | 预期判据 |
|---|---|
| 阶段 A 漏迁 publish 按钮 | hub 发布流程用例 RED |
| 阶段 B 误删后端 controller | §4.2 守卫 RED |
| 阶段 C 在 P2 未验证时删 AdminPricingPage | 评审门禁（人工）+ 会话成本来源取证 FAIL（非自动化） |

---

## 5. 改动文件清单（按阶段）

| 阶段 | 文件 | 动作 |
|---|---|---|
| A | `apps/web/src/pages/admin/AdminPricingHubPage.vue` | 新增发布面板（publish/diff/rollback/公告） |
| A | `apps/web/src/pages/admin/AdminPricingHubPage.test.ts` | 迁入 3+ 用例 |
| B | `AdminCostRatesPage.vue` / `AdminMarginPoliciesPage.vue` / `AdminPricingSubjectsPage.vue` | 删 |
| B | `router/index.ts` / `AdminLayoutPage.vue` | 改（删路由/菜单行） |
| B | `AdminPricingHubPage.vue` / `AdminGrayReleasePage.vue` | 改链接/文案 |
| C | `AdminPricingPage.vue` / `AdminPricingPage.test.ts` | 删（P2 后） |
| 全局 | `admin-api.ts`、后端 controller | **不改**（逃生口） |

---

## 6. 分刀、顺序与回滚

1. **刀 P3-A（本文本范围）**：hub 发布闭环 → 授权合并 → 生产走查 → 稳定观察。
2. **刀 P3-B**：A 稳定后删三页 + 藏菜单。
3. **刀 P3-C**：P2 验证后删渠道定价页。

**回滚**：全程只删前端页面 + 改路由/菜单，后端与 API 层不动——任何阶段可靠恢复文件 + 路由行瞬时回滚，无数据迁移、无后端变更。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| A 未稳就删页 → 发布能力断档 | 三阶段强顺序，B 前置=A 生产走查稳定 |
| 逃生口丢失 | 后端 controller + admin-api 全保留 + §4.2 守卫 |
| 灰度页文案指向已删发布流页 | B 阶段同步改文案 |
| P2 未上线误删渠道页 → 会话成本无源 | C 硬依赖 P2 验证，人工门禁 |

---

## 8. 已确认决策与待办

1. ~~阶段 A 是否与文本断裂刀（T1）/P2（P2a）同批立项~~ → **已拍板（2026-11-15 22:15 对抗复审）**：P3-A 独立成刀，纯前端与后端定价刀不混批，风险面隔离。
2. ~~阶段 B 三张高级页的「逃生口」是否接受丢失~~ → **已拍板（2026-11-16）**：运营答复「没用过。后续运营直接用新的页面（定价中心）即可。原来的下线。」⇒ 阶段 B 前置全绿并已实施（见 §9）。
3. 收敛后菜单 6 项的文案定稿。

---

## 9. 状态回填（只追加，2026-11-16）

**阶段 A 已上线并走查稳定**：P3-A 合入 `c86b1dbe`（PR #904），生产浏览器级走查 11/11 PASS（token 门 → 定价中心 → 草案 → diff 预览 → 发布弹窗含公告开关默认关 → 回滚弹窗），API 级 diff/发布/回滚全链复测通过。

**阶段 B 已实施并上线**（PR #928，squash `9fa03b5`）：

- **改动**：删 `AdminPricingSubjectsPage.vue` / `AdminCostRatesPage.vue` / `AdminMarginPoliciesPage.vue` 三页 + 三条路由；`AdminLayoutPage.vue` 删三菜单项、发布流/灰度菜单**注释保留**（隐藏但留源码，取消注释即恢复）；hub 改两处文案（发布入口指向已上收至本页的发布面板）、灰度页改一处引导文案（指向「定价中心」生成草案）。
- **菜单 12→7**：模型目录·上游路由·健康探活·定价中心·平台渠道定价·审计日志·使用说明。⚠️ §2.1 G1 的「6 项」是 A+B+C **全链终态**（「平台渠道定价」属阶段 C 删除范围）——阶段 B 单独达成 7 项，C 完成后达 6 项。
- **接线守卫（§4.2 落地）**：新增 `apps/web/src/pages/admin/admin-pricing-pages.guard.test.ts`——8 个后端定价 controller + `admin-api.ts` 三能力组 23 个关键方法全在 + 三页已删 + 三路由已删 + 发布流/灰度仍在。**变异自检 2/2 RED**（改 `pricingGray.promote` → 方法组 RED；移走 `pricing-margin.controller.ts` → controller RED）。
- **验证**：CI 全量 **web 4321 / server 2990 / shared 697 / agent 385 = 8393 用例 0 失败**（web 512 文件全绿）；`vue-tsc -b` 0 错；残留引用扫描前端零残留。生产走查 **12/12 PASS**（侧栏 7 项、三页 URL 不可达、发布流页 URL 仍直达、hub 发布面板四能力在位）。产物判据：`AdminLayoutPage-*.js` 含 7 项菜单文案、零「原始数据：主体/成本/利润」与「价目发布流/灰度发布」。
- **实施计划**：`docs/superpowers/plans/2026-11-16-p3b-admin-page-convergence.md`。

**阶段 C 未启动**：硬前置「会话成本来源取证全部为 CostRate」尚未成立——`PI_SESSION_COST_SOURCE=cost_rate` 已于 2026-11-16 13:15 切换，但切换后 7h 内生产无真实 pi 会话 usage 累计（`pi_runtime_usage_cost_total` 无序列行），取证待真实流量产生后另行进行。
