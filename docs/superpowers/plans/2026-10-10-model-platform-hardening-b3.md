# B3 批次实施计划 — 模型平台体系加固遗留清理（8 项）

> 上级规格：`docs/superpowers/specs/2026-10-09-model-platform-hardening-design.md`
> 前置：B2（PR #340）+ 热修 #343（startup 探活等待路由 bootstrap 落定）均已上线。
> 本批次是 B2 最终全分支评审登记的**非阻塞遗留清单**的集中清理，无新特性。
> 执行方式：SDD 两实现任务串行 + 文档项控制器自做；执行日 2026-10-10，BASE `d9d758e2`。

## 0. 锚点核实（写计划前实锚，dispatch 随 brief 下发）

| 项 | 现实（d9d758e2 实测） |
|---|---|
| 探活分组目录 | `upstream-probe.service.ts:291` `STUDIO_MODEL_CATALOG.map(...)` → admin DB 新增模型不进探活分组与对账 |
| UpstreamProbeRun | schema.prisma:280 `{id,ranAt,upstream,httpStatus,modelCount,ghosts,missing,error}`——**无 reason 列**；writeRunRecord 在 probe.service:348/:419 两调用点 |
| admin latest 响应 | `upstream-probe` admin controller GET latest 透出 runs 数组（B2 生产实测字段：id/ranAt/upstream/httpStatus/modelCount/ghosts/missing） |
| dockAudio 固化 | `apps/web/src/constants/dockAudio.ts:25` `AUDIO_VOICE_OPTIONS=listModels('audio')`、:53 `DEFAULT_AUDIO_VOICE` 模块加载时求值（bootstrap 注入前=常量目录）；`:90/:105` 已是函数（不固化）；消费方 `useNodeGeneration.ts:1013` 等读两个 const |
| audio 回退路径 | `audio-kind.ts` `resolvePlatformAudioFallback(modelName, env)`（T2.6 已切 DB 目录做 kind 匹配的同一文件）+ `studio.service.ts` audio 回退分支 `platformGatewayModelId('audio', meta)`；confirm 门控；模型形状=gatewayModelId，镜像 name=modelKey 约定下校验恒过 |
| admin controller | `model-catalog.controller.ts` 四端点方法级 `@UseGuards(AdminTokenGuard)`；测试直接实例化 controller（绕过 guard），401 断言缺失（upstream-routes.controller 已有先例：guard 元数据 + env 未设 fail-closed throw） |
| POST 并发 | create 的查重（409）在事务外 check-then-act；并发同 key create → Prisma P2002 → 500 |
| 路由缓存保护 | `upstream-route-store.ts` `refreshUpstreamRouteCache` 直接 `cachedRows = rows`——无 catalog store 同款 `rows.length > 0` 保护 |

## 1. 全局约束（bind 两任务）

1. 探活器是唯一置 `availability:'unavailable'` 的写入方；本批次零新写入方。
2. SQLite 时间戳整数毫秒；迁移纯 DDL 加列（`reason String?` 可空，旧行为 NULL）。
3. 行为兼容：探活分组切 DB 目录后，**存量 25 条（=种子常量）分组结果逐条不变**（缓存初值=种子常量的同源性保证）——对拍测试锁住。
4. web 改动遵守设计体系（不新增 hex/rgba；本批次预期零样式改动）。
5. ⛔ 禁 `git add -A`；测试命令同 B2（server `--hookTimeout=120000`；已知慢机 flaky 复跑一次再判）。

## 2. 任务分解（2 实现任务串行 + 文档项）

### Task 1 — 探活/路由 store 域（model: default）

1. **探活分组切 DB 目录**：`upstream-probe.service.ts:291` 改 `currentCatalogEntries()`（import 自 model-catalog-store）。效果：admin 新增/下架模型进探活分组与对账（新增模型无路由行命中 → default 行接住归 agnes_hub；若后台已删 default → unroutable warn，与现语义一致）。测试：既有套件应零改动通过（缓存初值=种子常量同源）；新增 1 用例——mock `currentCatalogEntries` 返回含 DB-only 条目 → 分组/对账包含之（复用 T2.5 接线测试形态，防「锁透传没锁效果」）。
2. **路由缓存空表保护**：`refreshUpstreamRouteCache` 加 `if (rows.length > 0)`（同 model-catalog-store 不对称补齐）；测试锁「load 异常/空结果保旧值」。注意与「确定性空表抛错」语义的关系：保护只作用于 refresh 写缓存时刻，`currentUpstreamRoutes()` 冷启动初值仍为 `[]`（消费方空表语义不变）。
3. **writeRunRecord 落 reason 列**：schema `UpstreamProbeRun` 加 `reason String?`（`'startup'|'periodic'|'manual'`）+ 迁移（纯 DDL）；两调用点传入 reason；admin latest 响应透出 reason 字段（类型+测试）。B2 评审遗留 ①。

### Task 2 — admin/web 域（model: default）

1. **model-catalog controller 补 401 断言**（复用 upstream-routes 先例形态：路由级 guard 元数据 + 无 env 时带任意 Bearer 仍 401）。B2 评审遗留 ②。
2. **POST 并发兜底**：create 事务内 create 捕获 P2002 → 409 Conflict（错误体与既有查重 409 同形）；测试：mock create 抛 P2002 → 409。check-then-act 查重保留（常规路径仍 409 快路径）。B2 评审遗留 ③。
3. **audio 回退路径 availability 裁定**：读 `studio.service.ts` audio 回退分支 + `resolvePlatformAudioFallback`，两案选一并报告：A=回退前接 `assertPlatformModelAvailable`（镜像查不到=gatewayModelId 形状，需实测是否要 name 双查；若镜像只回 modelKey 行则校验恒过、加了即防御纵深）；B=代码注释 + runbook 注明豁免理由（confirm 门控 + 形状恒过）。实现者实测后选，报告记录依据。B2 评审遗留 ⑤。
4. **dockAudio 惰性求值**：`AUDIO_VOICE_OPTIONS`/`DEFAULT_AUDIO_VOICE` 两 const 改惰性（实现者按消费方形态选：函数化改造调用点 / 模块内 memo getter 导出 const 只读代理——**禁止破坏既有 import 形状**导致 4+ 消费点大改；选改动面最小方案并记录）。效果：bootstrap 注入后新值可见（仍非响应式——热更需刷新页面的既有语义不变，此处只修「模块加载时序」）。测试：注入归一层后取值变化断言。B2 评审遗留 ⑥。

### 文档项（控制器收尾自做）

5. **runbook 增补**：`docs/ops/2026-10-09-upstream-probe-runbook.md` 追加：①路由二跳边界操作项（admin 新增「modelKey 无特征、gatewayModelId 命中 backed」条目须同步加路由行）②reason 列说明与 startup 等待语义（#343）③探活分组切 DB 目录后「新增模型自动进对账」的运维语义。B2 评审遗留 ⑧。

## 3. Review Focus（最终评审必查）

1. 分组切 DB 后存量行为零漂移（对拍断言）+ DB-only 条目真进对账（效果断言非泛断言）。
2. reason 列迁移纯 DDL；admin latest 新字段有测试；旧行 reason=null 不破坏既有消费。
3. 401 断言形态与 upstream-routes 先例同构；P2002→409 错误体同形。
4. dockAudio 改造后 web 全套 + vue-tsc 绿；无循环依赖引入（dockAudio ↔ studioModels）。
5. 探活唯一写方裁定不破（Grep unavailable 写入）。

## 4. 执行约定

- 顺序 T1 → T2 → 文档项 → 最终评审 → push/PR/CI/合并/部署/生产复测。
- 测试：`pnpm --filter @lnkpi/server exec vitest run --hookTimeout=120000` / `pnpm --filter @lnkpi/web exec vitest run` + web `vue-tsc -b`；shared 不动则不跑全量（T1/T2 均不碰 shared 包——**探活分组读的是 server store，无 shared 改动**）。
