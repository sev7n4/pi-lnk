# S0-3 部署后冒烟探针（对账报告手工版）—— 分项规格

状态：待评审（2026-10-09）
上级规格：`2026-10-09-model-platform-hardening-design.md`（批次 B0，服务目标 G3 的手工形式；S1-1 的前身）

## 1. 目标

提供一条命令即可产出「目录 28 ↔ 各上游真实清单」的对账报告，让运维在部署后/巡检时 5 分钟内发现幽灵模型与欠费上游；**不建长期设施**（定时化、告警、灰显回流归 S1-1）。

## 2. 现状摘录（真实锚点）

- 2026-10-09 事故取证用的是一次性 ssh + `docker exec node` 手工探针（ssh→`apihub.agnes-ai.cn/v1/models` 用 `OPENAI_API_KEY`、apimart 用 `APIMART_API_KEY`），结论可靠但**不可复跑、diff 靠人眼**。
- 容器环境：`lnkpi-api` 内 node v22.23.3、无 curl；`agnes-ai.cn` 国内直连可达（无需代理），apimart 需走 `HTTPS_PROXY=172.17.0.1:17891`（undici ProxyAgent 实测可用）。
- 上游路由的「谁服务谁」判定源：`packages/shared/src/platformCredentials.ts` 的 resolver 族 + `STUDIO_MODEL_CATALOG[].providerBinding`。
- 镜像读取：DB `ProviderChannel('platform').models`（`docker cp` + 宿主 sqlite3，SQL 用单引号）。

## 3. 改动设计

1. **新增脚本** `ops/probe-upstream-models.mjs`（仓库 ops/ 目录，Node ≥ 22，零三方依赖除 undici——undici 随 node 内置）：
   - 输入：5 个上游的 BaseURL/Key 一律从 `process.env` 读（`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`APIMART_*`/`FAL_*`/`MINIMAX_*`/`STEPFUN_*`），**脚本绝不落盘任何密钥**；
   - 对每个上游 `GET /v1/models`（fal/minimax 若无 /models 端点则记录 `NO_MODELS_ENDPOINT` 跳过，不视为失败）；
   - **核心 diff 写成可复用纯函数并导出**：`diffCatalogAgainstUpstream(catalogEntries, upstreamModelIds, routingMap)` → `{ghosts, missing, matched}`（幽灵=目录有上游无；缺失=上游有目录无；matched=交集）。此函数放 `ops/` 还是 shared 包？——放 `packages/shared/src/upstreamReconciliation.ts`（纯逻辑+单测），B1-1 定时器直接 import，**禁止重写第二套**（总体规格 §3.3 门禁）；
   - 输出：stdout Markdown 报告（每上游一节 + ghost/missing 汇总），退出码：有 ghost 或上游 402/403 时 `exit 1`（供 CI/巡检判成败）。
2. **运行手册** `docs/ops/2026-10-09-upstream-probe-runbook.md`：一条命令模板（本地直跑 / ssh 到 CVM `docker exec -i lnkpi-api node -` 两种形态）、报告解读表（与 superpowers 探针脚本的「输出解读」同风格）、归档约定（每次运行报告存 `docs/ops/probe-<date>.md`）。
3. routingMap 首版**硬编码在脚本内**（与 platformCredentials resolver 家族规则同表），并加注释「与 platformCredentials.ts 保持一致，S2-2 路由表落地后改为 import」。

## 4. 验收判据（可断言）

| # | 判据 | 断言方式 |
|---|---|---|
| A1 | `diffCatalogAgainstUpstream(今日真实目录, agnes hub 真实12个, 路由表)` 的 `ghosts` 恰为 `['gemini-3.1-flash','deepseek-v4','gpt-5.5']`（假设 S0-1 未合；S0-1 合入后为 `[]`——用例两态都写，按目录 fixture 参数化） | shared 单测，fixture = §2.4 探针清单逐字 |
| A2 | diff 按集合比较不依赖顺序：打乱 upstreamModelIds 顺序 + 增删无关字段，结果不变 | 单测 |
| A3 | 上游 402/403/超时 → 该上游记为 `unavailable(reason)`，**不产生 ghost 误报**（上游不可达 ≠ 模型幽灵） | 单测：mock 402 响应 |
| A4 | 脚本对 5 上游实跑：agnes hub 报 12、apimart 报 402、StepFun/MiniMax/fal 按 NO_MODELS_ENDPOINT 或清单输出；exit code 符合 §3.1 | 手工实跑 + runbook 记录归档 `docs/ops/probe-2026-10-XX.md` |
| A5 | 脚本与 shared 纯函数不 import 任何 node_modules 之外的依赖、不写文件、不打印密钥（grep `sk-` 断言） | 代码审查 + CI grep |

## 5. 测试要点

- `packages/shared/src/upstreamReconciliation.test.ts`：A1/A2/A3 全覆盖；fixture 从本规格 §2/总体规格 §2.4 抄真实清单。
- 脚本本体（`ops/probe-upstream-models.mjs`）不做单测（IO 壳），逻辑全部下沉 shared 纯函数——与「scripts/ 永远不在 api 镜像里」的既有约束一致，脚本只在本机/CVM 容器外跑。

## 6. 涉及文件

- Create: `packages/shared/src/upstreamReconciliation.ts`、`packages/shared/src/upstreamReconciliation.test.ts`、`ops/probe-upstream-models.mjs`、`docs/ops/2026-10-09-upstream-probe-runbook.md`
- Modify: 无既有文件（S0-1 若同批发车，本脚本读的目录自动是删减后的）

## 7. 依赖与风险

- 与 S0-1/S0-2 无代码冲突；S1-1 直接复用 `upstreamReconciliation.ts`。
- 风险：apimart/StepFun 的 `/models` 行为与 agnes hub 不同（分页/鉴权差异）——脚本对非 200 一律 `unavailable(reason)` 保守处理，不猜结构；runbook 明示「探活只读 /models，禁止发真实生成请求」（总体规格 §4 第 2 条）。
