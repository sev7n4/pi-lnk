# S2-1 模型目录数据化（运营后台热更）—— 分项规格

状态：待评审（2026-10-09）
上级规格：`2026-10-09-model-platform-hardening-design.md`（批次 B2，服务目标 G5；S2-2 的数据层前置）

## 1. 目标

`STUDIO_MODEL_CATALOG` 从代码常量迁为 DB 单一真源：新增/下架/改文案在运营后台操作，≤5 分钟生效（含镜像与用户可选列表对齐），全程无 deploy。

## 2. 现状摘录（真实锚点）

- 目录：`packages/shared/src/studioModelCatalog.ts` 28 条（字段 `modelKey/displayName/gatewayModelId/modality/providerBinding/params`），被 **shared/web/server 三端 import**（`resolveModelKey`、UI 归一、capability 判定、`platformCredentials.ts` 均依赖）。
- 写入链：`ensurePlatformChannel`（播种）→ `model-catalog-sync.ts`（#306，bootstrap 对齐镜像+用户可选+disabledModels diff）。
- 运维界面现状：无 admin 后台；admin 鉴权先例见 S1-1/S1-2 端点。
- 已知衍生依赖：`studioModelCatalog.test.ts`/`ghost.test.ts` 锁 28 条清单、`modelCapability.test.ts` 锁 capability 规则。

## 3. 改动设计

1. **新表 `ModelCatalogEntry`**（字段与现类型逐字同构 + `id/createdAt/updatedAt/deletedAt`）；`STUDIO_MODEL_CATALOG` 代码常量降级为**播种种子**：bootstrap 时 upsert 进表（幂等，单写原则——**DB 是唯一真源**，总体规格 §6）。
2. **`resolveModelKey` 改造**：签名不变（`resolveModelKey(modality, key)`），实现改读 DB（进程内缓存 + 5s TTL 或版本号失效）；**找不到时的抛错行为与错误类型保持不变**（S0-1 A4 的契约延续）。
   - ⚠️ shared 包（纯函数、无 DB）与 server 端（有 prisma）的分层：`resolveModelKey` 保留纯函数形态，新增 `resolveModelKeyFromRows(rows)` 供注入；server 端包装器查 DB 后调它，web 端**改为消费服务端下发的目录**（channels/preferences 响应已含条目，不新增通道）。
3. **运营端点**（admin 鉴权）：`GET/POST/PUT/DELETE /api/admin/model-catalog`；DELETE=软删（同 S0-1 下架语义：sync 清镜像与可选、停用记录清理）；写操作全部写审计日志（who/when/before/after）。
4. **生效机制**：写操作 bump `catalogVersion`；`model-catalog-sync` 的 bootstrap 对齐逻辑改为「版本变化即对齐」（当前只在启动跑一次）——5 分钟生效判据由「后台保存 → sync 立即触发」实现，不依赖重启。
5. **兼容窗口**：种子播种后，代码常量保留一个发布周期（仅作 seed），删除常量的 PR 单独走（避免一 PR 改三层）。

## 4. 验收判据（可断言）

| # | 判据 | 断言方式 |
|---|---|---|
| A1 | 播种幂等：连续两次 bootstrap，表行数不变、无重复 modelKey | 集成测试 |
| A2 | 热更生效：POST 新条目 → sync 触发 → 镜像与 selectableTextModels 含新条目（≤5s）；DELETE → 同步清理（复用 S0-1 A2/A3 判据于动态路径） | 集成测试 |
| A3 | `resolveModelKeyFromRows` 纯函数行为与旧实现逐 case 一致（28 条 fixture 全量回归） | shared 单测（迁移既有 test 断言到 rows 注入形态） |
| A4 | web 端目录来源切换后，Dock/设置页渲染与改造前逐条一致（快照对比） | `UniversalModelSelector.test.ts` 快照 |
| A5 | 审计：每次写操作产生含 before/after 的审计行 | 集成测试 |
| A6 | 生产复测：后台新增一条测试模型（如 `agnes-2.5-flash`，网关真实存在）→ 无发版 ≤5 分钟 Dock 可见 → 删除 → 消失 | runbook 手工复测记录归档 ops/ |

## 5. 测试要点

- 既有 28 条目录断言（`studioModelCatalog.test.ts`）改为「种子常量」断言 + 「DB 路径」断言两层，防止直接删测试造成覆盖倒退。
- 版本失效并发：两个写操作竞态 → last-write-win + 版本单调递增（单测）。

## 6. 涉及文件

- Create: prisma `ModelCatalogEntry` + 迁移、`apps/server/src/admin/model-catalog.controller.ts` + 集成测试、`resolveModelKeyFromRows`（shared）
- Modify: `studioModelCatalog.ts`（降级为种子）、`model-catalog-sync.ts`（版本触发）、server 侧 resolve 包装器、web 目录来源
- 风险文件：`platformCredentials.ts`/`modelCapability.ts` 的 import 链逐个核对（TS6133/project references 教训：本地 tsc 过 ≠ CI 过）

## 7. 依赖与风险

- 前置：S0-1/S1-1 已上线（下架语义与探活闭环先行，数据化才安全）。
- 风险=目录双源漂移：单写原则 + 种子只插不改（人工改 DB 绕过后台 = 审计外操作，runbook 禁止）；回滚=特性开关回代码常量模式（总体规格 §6）。
