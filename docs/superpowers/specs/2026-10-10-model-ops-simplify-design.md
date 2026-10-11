# 平台侧模型上架/下架极简方案（Model Ops Simplification）

- 日期：2026-10-10
- 状态：设计稿（待评审）
- 作者：模型平台运维事故复盘驱动（2026-10-10 视频/文本双默认切换 + 智谱接入全程实录）
- 关联：`2026-10-09-mph-s21-catalog-as-data-design.md`（B2 目录数据化）、`2026-10-09-mph-s22-upstream-routes.md`（路由表配置化）

---

## 0. 一句话结论

**把「默认模型、上游白名单、探活覆盖」三处最后的硬编码收进数据层，再用一个原子编排端点把「目录+路由+探活+凭据校验」串成单次调用——上架 ≤1 次调用，下架 ≤1 次调用且自带替代建议与流量摘要。**

---

## 1. 问题清单（全部来自 2026-10-10 实战，非假设）

| # | 痛点 | 当日代价 |
|---|------|---------|
| P1 | 默认模型是 shared 硬编码常量（`DEFAULT_MODEL_KEYS`），目录 DELETE 防呆拿它判定 → **切默认必须发版** | video v2.0、text agnes-2.0-flash 两次下架各触发一个完整 PR→CI→部署循环（#345 + 本次 PR） |
| P2 | 新上游的 `VALID_*` 白名单与穷举 switch 分散 **8 处**（route-store / resolver 两个 switch / probe registry+映射 / admin routes / catalog binding / legacy 对拍副本） | 接智谱改 8 文件 + 12 处测试锁，是整个 PR 的体积大头 |
| P3 | 上架一个模型 = env 注入 + 重建容器 + 路由种子存在 + admin POST 目录，**四步无一致性校验**，靠人肉 checklist | 智谱接入的运营动作分散在 PR 描述里 |
| P4 | 探活条目源是种子常量 `STUDIO_MODEL_CATALOG`，**admin 动态上架的条目不在探活范围**（盲区：cogvideox-flash 永远不被探活） | 动态上架的模型坏了只能靠用户报障发现 |
| P5 | 防呆闸只拦「删默认」，**不验证替代品是否存在且健康**，也不给替代建议 | agnes-2.0-flash 若在无接位模型时被误删，文本解析 fallback 悬空 |
| P6 | 路由/目录分属两个 admin 端点，**default 行禁用这类高危操作无二次确认** | 本次实战中 default→agnes_hub 兜底行险些被批量禁用（已即时恢复，无损） |
| P7 | 无运营页面，全部裸 curl + Bearer token | 每次操作都要翻 runbook |

---

## 2. 设计目标

1. **上架一个模型 ≤ 1 次 API 调用**（含凭据校验、路由检查、探活冒烟、目录写入、版本热更）。
2. **下架 ≤ 1 次调用**，且响应里自带：默认防呆判定 + 同模态健康替代品列表 + 近 24h 流量摘要；支持 `dryRun`。
3. **切默认不再发版**：数据驱动 + 原子切换 + 自动审计。
4. 探活覆盖 **所有**在架条目（数据源 = DB 而非种子）。
5. 所有写操作复用既有三件套：`adminAuditLog` + `catalogVersion/routesVersion` 原子 bump + 进程内缓存显式刷新。
6. **不做自动下架**（上游抖动误杀风险；健康驱动只到「建议」为止）。

---

## 3. 方案分层（P0→P3，可独立交付）

### P0 默认模型数据化（收益最大、体量最小，先做）

**现状**：`DEFAULT_MODEL_KEYS: Record<StudioModality, string>`（shared 常量）→ `isDefaultModelKey` / `defaultModelKey` / `resolveModelKeyFromRows` fallback 三处消费。

**改动**：
1. `ModelCatalogEntry` 加 `isDefault boolean` 列 + 部分唯一索引 `(modality) WHERE isDefault AND deletedAt IS NULL`（每模态至多一个活默认，DB 级保证）。
2. shared `defaultModelKey(modality)` 改为运行时读目录缓存（TTL 同 catalog；DB 空表时回落种子常量——种子降级为 bootstrap fallback，不再是真源）。
3. admin API：`PUT /api/admin/model-defaults` `{modality, modelKey}`：
   - 校验：目标条目在架（deletedAt null）、探活 available（探活数据可查时）；
   - 事务内：旧默认 `isDefault=false` → 新默认 `isDefault=true` → bump 版本 → 审计；
   - **切换即解除旧默认的下架障碍**——DELETE 防呆改为查 DB `isDefault`，无需先发版。
4. DELETE 防呆升级（解决 P5）：命中默认 → 409，响应体附 `alternatives`：同模态在架 + 探活 available 的条目列表（前端直接渲染成「切换到 X 再下架」的一键操作）。

**验收**：切换默认 = 1 次 PUT；下架旧默认 = 切换后 1 次 DELETE；全程零代码改动。以 agnes-2.0-flash（本次已用代码方式切完）为回归样例。

### P1 上架/下架原子编排（model-ops）

新增 `apps/server/src/admin/model-ops.controller.ts`，编排既有能力而非新增存储：

```
POST /api/admin/model-ops/onboard
{ modelKey, gatewayModelId, modality, upstream, displayName?, params?, defaults?, smokeTest? }
→ 步骤（任一失败即中止，返回已完成/未完成步骤清单）：
  1. 凭据存在性：UPSTREAM_REGISTRY[upstream].apiKeyEnvName 在进程 env 已配置（缺 → 422，附 env 名）
  2. 路由可达：resolveUpstreamRoute(路由行, modelKey, modality).upstream === upstream
     （未命中 → 409，提示需加路由行——路由行仍由种子/PUT 管理，不让编排端点隐式创建路由）
  3. smokeTest=true 时按 modality 发一次最小真实请求（t2v 5s / 512px 图 / 短 tts），成功才继续；
     付费模型默认 smokeTest=false（避免成本）
  4. 事务：目录 POST（复用既有 create 语义，含软删复活）+ 审计 + bump
→ 200 { entry, version, steps: {...} }

POST /api/admin/model-ops/offboard
{ modelKey, reason?, dryRun? }
→ dryRun=true（默认）返回：默认判定、alternatives、近24h 流量摘要（model-health 投影数据）、
   路由影响面（哪些路由行指向该模型的上游/同 pattern 波及条目）
→ dryRun=false 执行：软删 + 审计 + bump；若 modelKey 同时被路由行精确匹配且无其他条目复用，
   响应提示「路由行仍在，建议 PUT enabled=false」（路由与目录解耦，不自动改路由）
```

**高危操作二次确认（解决 P6）**：upstream-routes PUT / model-defaults PUT / offboard 执行态全部要求请求头 `X-Confirm: <modelKey|routeId>`（值必须与目标一致），防呆值不匹配 → 428。批量脚本场景保留 `dryRun` 先行。

### P2 探活覆盖动态条目

- `probeOnce` 的 `catalogEntries` 数据源：`STUDIO_MODEL_CATALOG` 种子 → **DB `ModelCatalogEntry`（deletedAt null）**。种子回归唯一职责：播种。
- `UPSTREAM_REGISTRY` 加 `probeMode: 'models' | 'none'`（默认 models）：`none` 的上游（如 zhipu 视频不在 /models 列表）整组跳过 diff、只落 run 帧，**不算 ghost 也不算 unavailable**——显式声明探活盲区，而非静默误判。
- ghost 灰显逻辑不变（A3 连败 3 次且零成功 → unavailable）。

### P3 运营页面（web admin，最后做）

单页 `/admin/models`（受 LNKPI_ADMIN_TOKEN 会话保护，或短期用 env token 一次性粘贴）：
- 目录列表：modality 分组、在架/下架/探活 availability/近24h 成功率 列
- 上架表单（onboard 端点 + 步骤结果渲染）
- 下架按钮（先 dryRun 卡片：替代建议 + 流量摘要 + Confirm 输入框）
- 默认模型切换器（per modality，只列 available 条目）

---

## 4. 数据与兼容

| 项 | 决策 |
|---|---|
| 种子常量的地位 | 播种 + bootstrap fallback（DB 空表/首次启动）；`STUDIO_MODEL_CATALOG` 不再被探活/解析直接消费 |
| `defaultModelKey` 签名 | 保持同步签名（内部读缓存），调用面零改动；缓存 miss 时回落种子常量 |
| legacy 对拍副本（A1） | 路由对拍逻辑不动；默认值切换不涉路由，对拍范围不受影响 |
| BYOK 链 | 完全不受影响（BYOK 不走目录/默认） |
| 计费/退款 | 不涉及（fail 退款路径与默认值解耦，本次事故已实证 refundedPoints 正常） |

## 5. 分期与工作量

| 期 | 内容 | 量级 | 风险 |
|---|------|------|------|
| P0 | 默认数据化 + alternatives 防呆 | 1 个 migration + shared/server 各一文件 + 测试 | 低（fallback 链有种子兜底） |
| P1 | model-ops 编排 + X-Confirm | 1 个新 controller + 既有端点加头 | 低（纯编排，无新存储） |
| P2 | 探活数据源切 DB + probeMode | probe service 一处 + registry 字段 | 中（ghost 判定回归要跑全） |
| P3 | web 运营页 | 前端单页 | 低（纯消费 admin API） |

**验收基线（用今天的实战回放）**：
- 智谱接入：env 注入 + 1 次 onboard 调用（smokeTest 内置）——而不是 8 文件 PR；
- agnes-video-v2.0 / agnes-2.0-flash 下架：各 1 次 offboard（dryRun 看到 2.5-flash 替代建议后确认）——而不是两个 PR 两个部署窗口；
- default 行禁用类误操作：X-Confirm 缺失直接 428。
