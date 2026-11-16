# P3-B 实施计划：运营后台页面收敛（删三张高级页 + 藏发布流/灰度菜单）

> 规格：`docs/superpowers/specs/2026-11-15-p3-admin-page-consolidation-design.md` §3 阶段 B
> 依赖：P3-A 已合入并上线（#904 `c86b1dbe`），生产浏览器走查 11/11 PASS（2026-11-16 20:00）
> 本计划只覆盖**阶段 B**；阶段 C（删平台渠道定价页）另立计划。

## 0. 一句话结论

删掉三张运营从没打开过的「原始数据·高级」页，把「价目发布流」「灰度发布」从菜单里藏起来（文件与路由保留作逃生口），并补一条静态守卫钉死「删页不删接口」。全程只动前端，零后端改动。

## 1. 前置条件核对

| 前置 | 来源 | 状态 |
|---|---|---|
| 阶段 A 上线 | P3 spec §3 | ✅ #904 `c86b1dbe` 已上线，前端产物含 `publishFromHub`/`rollbackFromHub`/`loadDiff`/公告开关 |
| 阶段 A 生产走查稳定 | P3 spec §3 | ✅ 浏览器级 11/11 PASS（2026-11-16 20:00，截图 `.workbuddy/tmp/p3a-shots/`）+ API 级全链复测（diff/发布/回滚） |
| 运营确认逃生口可丢失 | P3 spec §8.2 | ✅ 2026-11-16 用户答复：「没用过。后续运营直接用新的页面（定价中心）即可。原来的下线。」 |

## 2. 改动清单

### 2.1 删除文件（3）

| 文件 | 独占能力 | 处置 |
|---|---|---|
| `apps/web/src/pages/admin/AdminPricingSubjectsPage.vue` | 主体表视图 / rebuild / 独立 publish | **删**。物化+发布已在 hub（`refreshPricing` 含 rebuild→draft→materialize→readiness；publish 见 P3-A 发布面板） |
| `apps/web/src/pages/admin/AdminCostRatesPage.vue` | 原始 CostRate CRUD（source/provisional/unitQuantity） | **删**。日常改数走 hub 卡片 `saveRecord`；逃生口 = 后端 controller 保留（守卫钉死） |
| `apps/web/src/pages/admin/AdminMarginPoliciesPage.vue` | 六档 scope 利润率 CRUD | **删**。日常改 `scope=model` 走 hub；六档为冷门，运营确认从未使用 |

### 2.2 改路由（`apps/web/src/router/index.ts`）

删 3 行：`pricing-subjects` / `pricing-cost` / `pricing-margin`。
**保留** `pricing-versions` / `gray-release` 路由行——藏菜单不藏路由，URL 仍可直达（回滚工具 + 表空设施）。

### 2.3 改菜单（`apps/web/src/pages/admin/AdminLayoutPage.vue`）

- 删 3 行菜单项：原始数据·主体 / 成本 / 利润
- 藏 2 行菜单项：价目发布流 / 灰度发布（用 `v-if="false"` 保留 DOM 结构与索引，便于瞬时恢复；路由保留）

> 收敛后菜单 6 项：模型目录 · 上游路由 · 健康探活 · 定价中心 · 平台渠道定价 · 审计日志 · 使用说明
> （平台渠道定价属阶段 C 删除范围，本刀保留。）

### 2.4 改文案（2 文件）

| 文件 | 位置 | 现状 → 目标 |
|---|---|---|
| `AdminPricingHubPage.vue` | `:354` | `<router-link to="/admin/pricing-versions">价目表（只读）→</router-link>` → 指向已隐藏页，需改指 hub 自身发布面板或改为纯文案引导 |
| `AdminPricingHubPage.vue` | `:525` | `发布门禁：通过，可到「价目表（只读）」页发布` → 文案已错（发布能力在 hub 面板），改为 `发布门禁：通过，可在本页「发布」面板发布` |
| `AdminGrayReleasePage.vue` | `:235` | 「请先在「价目发布流」页复制 active 建草案」→ 发布流页已藏菜单，文案改为「请先在「定价中心」页点「生成价目表」出草案」 |

### 2.5 新增静态守卫（`apps/web/src/pages/admin/AdminPricingHubPage.test.ts` 或独立测试文件）

P3 spec §4.2 要求：**删页不删接口**。新增测试断言：

1. `apps/web/src/services/admin-api.ts` 中 `pricingS1` / `pricingVersions` / `pricingGray` 方法全在（方法名逐一断言）
2. 后端 controller 文件全在：
   - `apps/server/src/admin/pricing-cost.controller.ts`
   - `apps/server/src/admin/pricing-margin.controller.ts`
   - `apps/server/src/admin/pricing-cost-record.controller.ts`
   - `apps/server/src/admin/pricing-cost-collect.controller.ts`
   - `apps/server/src/admin/pricing-subject.controller.ts`（若存在，以 master 实际为准）
   - `apps/server/src/admin/pricing-gray-release.controller.ts`（若存在）
   - `apps/server/src/admin/pricing-publishing.controller.ts`（若存在）
3. 三个被删页面文件已不存在 + 路由中无残留引用

> 守卫用「读文件存在性 + 读 admin-api.ts 文本」实现，不 import 后端（前端测试不引后端模块）。

## 3. 测试与判据

| 判据 | 命令 | 期望 |
|---|---|---|
| 前端单测全绿 | `pnpm --filter @lnkpi/web test`（或 web 包内 vitest） | 0 失败 |
| 类型门禁 | `vue-tsc -b`（**勿加 `--noEmit`**，composite TS6310） | 0 错 |
| 守卫变异自检 | 把 `admin-api.ts` 的 `pricingGray` 方法名改掉 → 守卫 RED；恢复 → 绿 | RED 可证伪 |
| 删除页无残留引用 | `grep -rn "AdminCostRatesPage\|AdminMarginPoliciesPage\|AdminPricingSubjectsPage\|pricing-subjects\|pricing-cost\b\|pricing-margin" apps/web/src` | 仅剩守卫测试自身的断言字符串 |
| 生产走查 | 浏览器登录 admin → 侧栏 6 项、三张高级页菜单消失、发布流/灰度不可见（URL 直达仍 200）、hub 发布面板四能力在位 | 全过 |

## 4. 分刀与回滚

**单刀提交**（前端纯删改，无后端、无配置）：

1. 本地改动 → 本地测试 → 推分支 → PR → CI 绿 → squash 合并 → **手工 dispatch `deploy.yml` 带 `deploy_web_only=true`** → 生产走查。

**回滚**：本刀为纯前端删除，revert 该 commit 即可瞬时恢复（无数据迁移、无后端变更）。
`pricing-versions` / `gray-release` 的路由与文件**始终保留**，任何阶段都不需要恢复它们。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| 删页后运营找不到改数入口 | hub 卡片已覆盖日常改数；已确认运营只用定价中心 |
| 藏菜单后灰度/发布流页成孤儿页 | 路由保留，URL 直达可用；文案已同步指向新入口 |
| 误删后端接口导致逃生口失效 | §4.2 静态守卫（变异自检可证伪） |
| 菜单文案与实际不符 | 走查截图核对侧栏 6 项 |

## 6. 阶段 C 前置提醒（不在本刀范围）

删 `AdminPricingPage.vue` 的硬前置 = 「会话成本来源取证全部为 CostRate」。`PI_SESSION_COST_SOURCE=cost_rate` 已于 2026-11-16 13:15 切换，但**截至切换后 7h 生产无真实 pi 会话 usage 累计**（`pi_runtime_usage_cost_total` 无序列行）⇒ 取证尚未成立，阶段 C 保持不动，待有真实流量后另行取证。
