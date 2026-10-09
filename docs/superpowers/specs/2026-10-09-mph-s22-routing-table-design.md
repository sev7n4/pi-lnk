# S2-2 上游路由表配置化 —— 分项规格

状态：待评审（2026-10-09）
上级规格：`2026-10-09-model-platform-hardening-design.md`（批次 B2，消除问题 P-6；依赖 S2-1 数据层）

## 1. 目标

「哪个模型走哪个上游」从 resolver if/else 链迁为数据驱动路由表；新增供应商/调整路由不改代码；探活对账器（S1-1）改读路由表，消除其脚本内硬编码映射。

## 2. 现状摘录（真实锚点）

- 路由判定散在两处：
  - `packages/shared/src/platformCredentials.ts`：`isStepFunPlatformModel`（`/^step/i`）、`isMiniMaxH3PlatformModel`（`/^minimax-h3$/i`）、`isFalH3MaxPlatformModel`（`/h3-max/i`）、`usesApimartImageGateway`（→`imageModelProfiles.ts` 的 backed-image 名单）、其余默认落 `OPENAI_BASE_URL`（agnes hub）；
  - `apps/server/src/provider/provider-resolver.service.ts` L70-73：按上述函数依次 if/else 选 baseUrl/apiKey，**缺 key 回落 OPENAI 链的静默错路由风险已有注释防护（StepFun 那条「绝不因缺 key 返回 null」）**。
- 已有事故教训（写入 platformCredentials 注释）：缺 key 回落 OpenAI = 阶跃模型名发到 OpenAI 的静默错路由。
- 消费方：`provider-resolver.service.ts`、`studio.service.ts`/`material.service.ts` 的 resolve 调用点、S0-3/S1-1 的探活路由映射（硬编码副本）。

## 3. 改动设计

1. **路由表结构**（DB 表 `UpstreamRoute`，S2-1 数据层同款模式）：
   ```
   { id, matchType: 'prefix'|'exact'|'regex', pattern, capability,
     upstream: 'agnes_hub'|'apimart'|'stepfun'|'minimax'|'fal',
     priority, enabled }
   ```
   首版种子 = 从现有 resolver 家族规则逐条翻译（step-* → stepfun；minimax-h3 → minimax；h3-max → fal；agnes-image-* backed 名单 → apimart/agnes hub 按现值；**兜底 = agnes hub**）。
2. **解析纯函数** `resolveUpstreamRoute(rows, modelKey, capability): RouteResult | null`（shared，注入 rows；null=未命中兜底前的显式状态）：
   - **`RouteResult` 必含 `{upstream, baseUrl, apiKeyEnvName}`——只回 env 名，不回密钥值**（密钥仍由 server 端 `readPlatformCredentialEnv` 取）；
   - 命中优先级 = priority 降序，同优先级 exact > prefix > regex；
   - **兜底行为显式化**：未命中任何行 → 走 `default` 行；无 default 行 → 抛确定性错误，**禁止回落 OpenAI 链**（把既有注释级的防护升级为类型级）。
3. **provider-resolver 改造**：if/else 链替换为查表；每个 `resolve*PlatformCredentials` 函数保留为薄包装（签名不变，调用点零改动）。
4. **探活器接线**：S1-1 的 `upstream-probe.service` 删除硬编码映射，改 `resolveUpstreamRoute` 按 enabled 路由分组探活（总体规格 Review Focus 第 5 行：**同名模型只探路由指向的那一家**）。
5. **运营端点**：`GET/PUT /api/admin/upstream-routes`（admin，写审计，同 S2-1 模式）；改路由 → `routesVersion` bump → 探活器下周期生效（不热重启）。

## 4. 验收判据（可断言）

| # | 判据 | 断言方式 |
|---|---|---|
| A1 | 等价回归：现有 28 条目录 × 5 上游的路由判定，新表结果与旧 resolver 链**逐条一致**（翻译完整性） | shared 单测：28 条 fixture 全量对比双实现 |
| A2 | 优先级与匹配类型：exact 胜 prefix、priority 高者胜、正则仅最后兜底 | 单测 |
| A3 | 无 default 行 + 未命中 → 抛错不回落（防静默错路由回归） | 单测 |
| A4 | `RouteResult` 不含密钥值：序列化断言无 `sk-` 前缀值 | 单测（redact 断言） |
| A5 | 探活接线：同名模型（agnes-image-2.0-flash 若双上游都配）只探路由行指向的那一家 | 单测（双行 fixture） |
| A6 | 缺 key 行为：路由命中但 env 缺 key → 显式错误（StepFun 既有语义），文案含「未配置」 | 单测（回归既有注释承诺） |
| A7 | 生产复测：改一条路由（测试模型）→ 下个探活周期按新路由对账 | runbook 归档 |

## 5. 测试要点

- 双实现对拍（A1）是本分项的核心安全网：旧 resolver 链在迁移 PR 内保留为 `legacyResolveUpstream()` 供对拍测试，合入后第二个 PR 删除。
- regex 行的 ReDoS 防线：pattern 长度上限 + 禁止嵌套量词（简单 lint 断言）。

## 6. 涉及文件

- Create: prisma `UpstreamRoute` + 迁移、`packages/shared/src/upstreamRouting.ts` + test、admin controller + 集成测试
- Modify: `platformCredentials.ts`（薄包装化）、`provider-resolver.service.ts`（查表化）、S1-1 探活服务接线
- 删除（第二 PR）：legacy 对拍副本

## 7. 依赖与风险

- 前置：S2-1（数据层与后台模式）；探活接线依赖 S1-1。
- 风险=翻译遗漏造成错路由（比幽灵模型更隐蔽）：A1 全量对拍是硬门禁，**对拍不绿不得合**；回滚=路由表开关回 legacy 链（特性开关，总体规格 §6）。
