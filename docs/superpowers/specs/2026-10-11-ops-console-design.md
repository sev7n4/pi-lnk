# 运营管理后台（Ops Console）V1 设计稿

- 日期：2026-10-11
- 状态：设计稿（待评审）
- 作者：运营痛点驱动（model-ops spec P7「无运营页面，全部裸 curl」的落地篇）
- 关联：`2026-10-10-model-ops-simplify-design.md`（V1-B 依赖其评审落地）、`2026-10-09-mph-s21-catalog-as-data-design.md`（目录数据化）、`2026-10-09-mph-s22-routing-table-design.md`（路由表配置化）、PR #350（P1 cost 费率接线，pricing 数据面）

---

## 0. 一句话结论

**在主站内嵌 `/admin` 懒加载路由，复用 `LNKPI_ADMIN_TOKEN` 鉴权与墨流设计体系，把既有 4 组裸 admin 端点（目录/路由/探活/健康）接上 UI，并新增 3 个最小服务端端点（审计日志只读 + 平台渠道定价读/写），消灭「运营动作全靠 curl + 手改 SQLite」的现状；model-ops 编排（上架/下架）作为 V1-B 解耦跟进。**

---

## 1. 背景与问题清单

| # | 痛点 | 现状证据 |
|---|------|---------|
| P1 | 目录/路由/探活/健康 4 组运营端点全部裸 curl + Bearer，每次操作翻 runbook | `apps/server/src/admin/` 4 个 controller 无任何 UI 消费方 |
| P2 | `AdminAuditLog` 只写不读——运营写操作落了审计，但没有任何界面能查 | 全仓无 `adminAuditLog.findMany` 生产代码（仅测试直查） |
| P3 | 平台模型 pricing（`inputPerM/outputPerM/cacheReadPerM/cacheWritePerM`）存在单行平台渠道（`id='platform'`）的 `models` JSON 里，无任何配置界面；pull-models 重建 `models[]` 会整块抹掉 pricing（PR #350 已知限制），补救靠手改 SQLite | `provider.service.ts` `PLATFORM_CHANNEL_ID = 'platform'`；PR #350 commit message「需手动编辑重填」 |
| P4 | 探活结果、模型健康只有 JSON 视图，判读成本高 | `model-health-summary.controller.ts`、`upstream-probe-admin.controller.ts` |

**不做的理由记录**：用户/积分/内容/大盘运营域明确不在 V1（用户已拍板聚焦模型平台运营）；数据模型（`User`/`PointTransaction`/`GenerationRecord`/`Work`）已就绪，后续扩域是加页面而非改架构。

---

## 2. 设计目标 / 非目标

### 目标

1. **V1-A 交付后，以下运营动作全部零 curl**：目录增删改查（含防呆 409 的替代品渲染）、路由行启停、探活触发与结果判读、模型健康总览、审计日志检索、平台渠道 pricing 配置。
2. **零新增部署面**：不新增构建流水线、不新增 nginx location、不新增进程——主站 deploy 即带上。
3. **服务端改动最小**：仅 3 个新端点（1 只读 + 2 平台渠道定价），全部沿用 `AdminTokenGuard` 与既有审计三件套模式。
4. **设计体系零欠账**：所有页面消费墨流 L2/L3 令牌，`design-token.test.ts` + `theme-usage.test.ts` 守卫全绿。
5. **admin 代码不进首屏 bundle**：路由级懒加载，验收可判读（chunk 枚举）。

### 非目标

- 不做 DB 账号体系/多角色/RBAC（单运营者，token 门够用；`AdminAuditLog.actor` 语义沿用现状）。
- 不做 BYOK 用户渠道的运营（用户自有渠道不可被运营台触碰，定价端点硬编码只允许 `id='platform'` 行）。
- 不做 pull-models 抹 pricing 的根修（merge/写回保护）——列为独立 hardening 小 PR，见 §10。
- 不做 model-ops 上架/下架编排 UI（依赖其 spec 评审，V1-B）。
- 不做实时推送（探活/健康均为手动刷新 + 轮询刷新按钮）。

---

## 3. 范围与分期

| 分期 | 内容 | 依赖 |
|------|------|------|
| **V1-A（本 spec）** | 运营台 UI × 5 页 + 3 个新服务端端点 | 无（全部骑在已上线能力上） |
| **V1-B（解耦跟进）** | 上架/下架编排表单（dryRun 预览 → 确认执行）、默认模型切换 UI | model-ops spec 评审落地其 P0/P1 端点 |
| **独立 hardening** | pull-models 写回保护（保留已有 pricing） | 本 spec 无阻塞，可并行 |

---

## 4. 架构决策

### 4.1 载体：主站内嵌 `/admin` 路由

- 单运营者场景下独立 SPA 是过度设计：多一条构建/部署流水线（本项目部署纪律成本高）、一套登录壳、墨流体系无法复用。
- 路由懒加载保证 admin 代码独立 chunk；安全靠鉴权不靠隐藏——API 侧 `AdminTokenGuard`（Bearer `LNKPI_ADMIN_TOKEN`）不动，页面本身无 token 不出数据。
- 未来若需物理隔离：页面组件整体迁出即可，平滑降级。

### 4.2 鉴权：复用共享密钥 + sessionStorage

- 进入 `/admin` 任意子页 → 若 `sessionStorage` 无 token → 渲染 token 输入门；输入后前端发一次既有只读端点（如 `GET /api/admin/model-catalog`）验真，成功才落 `sessionStorage('lnkpi_admin_token')`。
- 任何请求返回 401/403 → 清 token、回输入门。关标签页即失效（sessionStorage 语义），符合单运营者风险模型。
- token 只在前端内存/sessionStorage，不落 localStorage、不进 URL、不打日志。

### 4.3 设计体系：墨流令牌消费

- 令牌 SSOT = `apps/web/src/styles/design-tokens.css`；页面/组件只消费 L2/L3，禁止新增 hex/rgba/text-white/bg-[#。
- 布局复用现有组件习惯（el-dialog 等既有组件库用法），不引入新 UI 依赖。

---

## 5. 服务端改动（3 个新端点）

### 5.1 `GET /api/admin/audit-logs`（审计只读）

```
GET /api/admin/audit-logs?action=&resource=&page=1&pageSize=20
→ 200 { rows: AdminAuditLog[], total: number, page, pageSize }
```

- `orderBy createdAt desc`；`pageSize` 上限 100、默认 20；`action`/`resource` 精确匹配过滤（可选）。
- 复用 `AdminAuditLog` 表与 `@@index([action, createdAt])`；`resource` 无索引——数据量 = 运营写操作频次（极低），不新增索引，注释说明。
- `before`/`after` 原样返回（本就是 JSON 字符串），前端格式化展示。
- 新 controller 落 `apps/server/src/admin/audit-logs.controller.ts`，注册进 `AdminModule`；sqlite integration test 照抄 `model-catalog.controller.sqlite.integration.test.ts` 模式。

### 5.2 平台渠道定价（读 + 写，2 个端点）

```
GET /api/admin/platform-channel
→ 200 { id, name, apiFormat, models: [{ name, displayName?, pricing?, ...原条目字段(不含敏感) }] }

PUT /api/admin/platform-channel/models/:name/pricing
body { pricing: { inputPerM, outputPerM, cacheReadPerM?, cacheWritePerM? } | null }
→ 200 { entry, previousPricing }
```

- **硬编码只操作 `PLATFORM_CHANNEL_ID`（'platform'）行**，不复现通用渠道 CRUD——BYOK 渠道结构性不可达。
- GET 返回的 `models` 为服务端解析后的列表；`models` JSON 畸形 → 返回 `models: []` + `parseError` 标记（fail-soft，与 PR #350 解析纪律同语义），绝不 500。
- PUT 语义：在 `models` JSON 数组中按条目名定位（**条目定位键以 `provider.service.ts` 消费 `models` 的现有 schema 为准，实现前先读该消费代码**），仅替换该条目的 `pricing` 键——set（对象）或 clear（null）——其余字段一律不动（防 pull-models 式整块覆盖重演）。
  - 定位失败 → 404；`models` JSON 畸形 → 409（拒绝盲写，提示先修复渠道行）。
  - DTO 校验：四字段非负数，`cacheReadPerM`/`cacheWritePerM` 可缺省（缺省补 0，与 `resolveChannelModelCost` 对齐）。
- 审计：复用 `adminAuditLog` 三件套，`action = 'platform-channel.pricing.set' | 'platform-channel.pricing.clear'`，`before`/`after` 存**条目级 diff**（该模型的旧/新 pricing 对象），不落整块 JSON。
- 无缓存失效面：渠道行由 `provider-resolver` 每次请求直读 DB（非 5s TTL 缓存的 `currentUpstreamRoutes()`），PUT 即时生效。
- 不 bump `catalogVersion`/`routesVersion`——渠道不在这两个版本化域内。

---

## 6. 前端结构（apps/web，墨流体系内）

```
src/router/index.ts          # + /admin 懒加载路由（与现有 () => import 模式一致）
src/pages/admin/
  AdminLayoutPage.vue        # token 门 + 侧栏壳（五页导航），子路由出口
  AdminModelsPage.vue        # 模型目录：列表/搜索/新增/编辑/软删；409 alternatives 一键渲染
  AdminRoutesPage.vue        # 路由表：列表/启停（PUT enabled）；版本号展示
  AdminHealthPage.vue        # 模型健康总览 + 探活触发与 run 结果
  AdminPricingPage.vue       # 平台渠道定价：模型行 + pricing 徽标（未配=醒目提示）+ 行内编辑弹窗
  AdminAuditPage.vue         # 审计日志：分页表格 + action/resource 过滤 + before/after 展开
src/services/admin-api.ts    # fetch 封装：统一 Bearer 注入、401 清门、错误归一
src/stores/admin.ts          # token 会话态 + 各页列表缓存（pinia，与现有 stores 同模式）
```

- **统一写操作交互**：所有 PUT/POST/DELETE 弹确认框（展示将变更的字段级 diff 摘要），执行后 toast 结果 + 刷新列表。
- **定价页徽标**：`未配定价` 用状态色令牌高亮——这就是 pull-models 抹除事故的运营可见信号（配了几个、缺几个，页头计数）。
- admin-api 单测覆盖：token 头注入、401 清理、fail-soft 解析。

---

## 7. 数据流与错误处理

| 场景 | 行为 |
|------|------|
| 无 token / token 错 | 页面不出数据；只读验真失败停留输入门 |
| 任意请求 401/403 | 清 sessionStorage → 回输入门（会话过期自愈） |
| 目录 DELETE 命中默认 → 409 | 渲染响应体 `alternatives` 为「切换到 X 再下架」操作引导（对齐 model-ops spec P5 语义） |
| 平台渠道 `models` JSON 畸形 | GET fail-soft 展示 `parseError`；PUT 409 拒写（不盲修） |
| 网络错误/超时 | 统一 toast，列表保留上次成功数据（不清空） |
| 探活触发 | 触发后轮询 run 状态至终态，展示耗时/结果 |

---

## 8. 测试策略

**Server（沿用既有模式，全部 sqlite integration test）**
- `audit-logs.controller.sqlite.integration.test.ts`：分页/过滤/空态/越界 pageSize 截断。
- `platform-channel-admin.controller.sqlite.integration.test.ts`：pricing set/clear 条目级 diff、畸形 JSON fail-soft（GET）/409（PUT）、定位 404、DTO 负例、审计行断言（action/before/after）、BYOK 渠道隔离断言（构造用户渠道行，确认端点不可达）。
- 既有 admin 测试零回归。

**Web**
- `admin-api.test.ts`：token 注入/401 清理/错误归一。
- 页面组件冒烟测试（渲染 + 关键交互）。
- `design-token.test.ts` + `theme-usage.test.ts` 全绿（守卫自动覆盖新增文件）。

---

## 9. 验收标准（可判读）

1. `/admin` 输 token 后五页可用；目录页完成「新增 → 编辑 → 软删 → 409 防呆触发」全流程零 curl。
2. 路由页启停一行 → 审计页立即可见该操作 before/after。
3. 健康页触发一次探活并读懂结果；无需打开 JSON。
4. 定价页为平台渠道某模型 set pricing → 新建生成会话的 llm override 含 `cost`（与 `resolveChannelModelCost` 测试样例对拍）；clear 后字段消失。
5. 审计页分页/过滤可检索本验收产生的全部写操作。
6. 构建产物枚举：admin 代码在独立懒加载 chunk，首屏入口 chunk 不含 admin 模块。
7. 守卫测试全绿；`pnpm` 全量测试零回归。

---

## 10. 风险与后续

| 项 | 说明 |
|----|------|
| pull-models 抹 pricing | 本 spec 只做「可见 + 可补配」，根修（重建时 merge 保留已有 pricing）列独立 hardening PR |
| token 明文 sessionStorage | 单运营者可接受；引入多人运营时再升级账号体系（届时 `actor` 字段已有落点） |
| `models` 条目定位键 | spec 未锁定字段名——实现第一步先读 `provider.service.ts` 的 `models` 消费代码，以真实 schema 为准（禁止凭猜） |
| V1-B 编排 UI | 依赖 model-ops spec 评审；其 P0（默认模型数据化）落地后，AdminModelsPage 增加「设为默认」操作位 |
| 扩域路径 | 用户/积分/内容/大盘 = 新增 pages + 只读端点，架构不变（§1 已记录） |
