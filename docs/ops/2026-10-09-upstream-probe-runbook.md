# 上游模型探活对账 Runbook（S0-3 冒烟探针）

- 日期：2026-10-09
- 背景：2026-10-09 幽灵模型事故（`deepseek-v4` 等目录模型在 agnes hub 无渠道，用户选中即 503）。取证用的手工 ssh 探针不可复跑，本 runbook 把它固化为一条命令（总体规格 `2026-10-09-model-platform-hardening-design.md` G3 的手工形式；定时化归 S1-1）。
- 脚本：`ops/probe-upstream-models.mjs`（Node ≥ 22.6，零三方依赖）

## ⚠️ 铁律

**探活只读 `GET /v1/models`，禁止发送任何真实生成请求。** 生成请求会计费、会污染用量统计，且无助于对账。

脚本只从 `process.env` 读密钥，不落盘、不打印密钥；报告不含密钥，可安全归档。

## 命令模板

### 形态一：本地直跑（仓库根目录）

```bash
cd <仓库根>
OPENAI_BASE_URL='https://apihub.agnes-ai.cn/v1' \
OPENAI_API_KEY='<agnes key>' \
APIMART_API_KEY='<apimart key>' \
APIMART_BASE_URL='https://api.apimart.ai/v1' \
HTTPS_PROXY='http://172.17.0.1:17891' \
node --experimental-strip-types ops/probe-upstream-models.mjs
```

说明：

- `--experimental-strip-types` **必带**：脚本动态 import `packages/shared/src/upstreamReconciliation.ts` 源码（Node ≥ 22.6）。
- 未配置的 env 对应上游记 `unavailable(未配置 …)`，不影响其他上游；想只探 agnes 就只给 `OPENAI_*`。
- apimart 跨境需 `HTTPS_PROXY`（本机/容器实测走 undici ProxyAgent；若 undici 不可加载，报告会标注「未走代理」）。
- `FAL_*` / `MINIMAX_*` / `STEPFUN_*` 同理按需追加（变量名见脚本内 `UPSTREAMS` 表；fal 的 key 变量是 `FAL_KEY`）。

### 形态二：ssh 到 CVM，脚本经 stdin 灌入容器（不落盘）

```bash
ssh <cvm> "docker exec -i lnkpi-api node --experimental-strip-types -" \
  < ops/probe-upstream-models.mjs
```

说明：

- 脚本文件**不进 api 镜像**（scripts/ 约束），经 stdin 灌入 `docker exec -i … node -`；密钥用容器自身的 env（`docker exec` 继承容器环境），**不要**把密钥放在 ssh 命令行里。
- 容器内 node 为 v22.23.3（≥22.6），`--experimental-strip-types` 同样必带。
- 容器内 `/app/packages/shared` 只有编译产物（`dist/`，镜像构建时 src 已清除），脚本会自动回退加载 `dist/upstreamReconciliation.js` —— **前提是镜像构建于本功能合入之后**；旧镜像会报「无法加载 shared 模块」，此时用形态一。
- apimart 需代理时加 `-e`：

```bash
ssh <cvm> "docker exec -i -e HTTPS_PROXY=http://172.17.0.1:17891 lnkpi-api node --experimental-strip-types -" \
  < ops/probe-upstream-models.mjs
```

## 报告解读

| 字段 | 含义 | 动作 |
|---|---|---|
| **ghost（幽灵）** | 目录有、按路由表归到该上游、而上游 `/v1/models` 无 → 用户可选必挂 | 立即按 S0-1 流程从目录下架（`STUDIO_MODEL_CATALOG` 删条目 + #306 sync 清镜像）；S1-1 落地后自动灰显+告警 |
| **missing（缺失）** | 上游有、目录无 → 上架机会 | 评估后按总体规格 §6 恢复/新增目录条目；**S1-1 未完成前禁止凭本报告直接上架**（B1-1 未完成前禁止把任何新模型上架目录） |
| **matched（匹配）** | 交集，正常 | 无 |
| **unavailable(reason)** | 上游不可达（未配置/超时/非 200） | **不是幽灵！** 绝不因不可达下架模型。`HTTP 402`=余额不足（充值）、`HTTP 403`=鉴权失败（换 key）、超时=查网络/代理 |
| **NO_MODELS_ENDPOINT** | 该上游无 `/models` 端点（fal/minimax 形态） | 正常跳过，不视为失败 |

退出码：

| 码 | 含义 |
|---|---|
| 0 | 无 ghost 且无上游 402/403（unavailable/跳过不判败） |
| 1 | 有 ghost，或任一上游 402/403（欠费/鉴权失败）—— CI/巡检据此判败 |

## 归档约定

每次运行的报告（stdout 全文）按日期存 `docs/ops/probe-<date>.md`（如 `docs/ops/probe-2026-10-09.md`），作为当次探活快照存档（总体规格 §4 第 4 条：上游探活快照按日期归档）。总体规格 §2.4 是第一份（2026-10-09 事故取证）。

```bash
node --experimental-strip-types ops/probe-upstream-models.mjs | tee docs/ops/probe-$(date +%F).md
```

## 排错

| 症状 | 处置 |
|---|---|
| `无法加载 shared 模块 …` | 本地：确认在仓库根目录、命令带 `--experimental-strip-types`；容器：镜像早于本功能合入，改用形态一 |
| `ExperimentalWarning: Type stripping …`（stderr） | Node 实验特性告警，无害，忽略 |
| agnes 报 `未配置 OPENAI_BASE_URL` | 本地形态需显式给 base url（agnes hub 无默认值） |
| apimart 一直超时 | 检查 `HTTPS_PROXY`（跨境必须走代理）与 undici 可用性（报告会标注「未走代理」） |

## B2/B3 批次增补（2026-10-10）

### startup 首轮语义（#343 热修）

- 启动日志序列：`启动首轮探活待路由表就绪后触发（来源=startup）` → 路由表播种/装载落定 → `触发启动首轮探活（来源=startup）`。
- 等待上限 15s（`STARTUP_PROBE_ROUTES_READY_TIMEOUT_MS`）；超时照常执行并 WARN「等待路由表就绪超时」——按当前缓存路由执行（可能空表 → 组内跳过），**绝不静默丢失首轮**。
- 判「竞态未修」的症状：启动后立刻出现「N 个目录条目未命中任何路由行且无可用 default 行」WARN（N≈目录条目数）。出现即说明启动序列异常，排查 SeedService/DB。

### reason 列（B3）

- `UpstreamProbeRun.reason`：`startup` / `periodic` / `manual`，可空（B3 前旧行为 NULL）。
- `GET /api/admin/upstream-probe/latest` 响应透出 reason 字段；事后排查「这轮是谁触发的」以 run.reason 为准（此前只能靠日志回溯）。

### 探活分组目录来源（B3）

- 分组与对账读 **DB 目录**（`currentCatalogEntries()`，5s TTL 缓存）而非代码常量：**admin 新增/下架模型自动进对账**，无需发版。
- 新增模型无匹配路由行时由 default 行（→ agnes_hub）接住；若 default 行被停用则该条目进 unroutable WARN 跳过（不算 ghost）。

### 路由表维护操作项

- **二跳边界**：admin 新增「modelKey 无路由特征、但 gatewayModelId 命中 apimart backed 名单」的条目时，**必须同步加路由行**（PUT /api/admin/upstream-routes 或种子），否则探活/生成路由会把该模型归 agnes_hub 而真实流量走 apimart（路由纯函数无法表达 gatewayModelId 二跳，见 s22 规格）。
- 多 default 行按装载序取第一行兜底（priority desc → id asc）；运营端点 PUT 已校验「至多一条 default」。

### 回退路径 availability 校验（B3 + B4 登记）

- **audio** 回退（confirm 门控重放）已接 `assertPlatformModelAvailable`（按 modelKey 查镜像——注意 audio 的 gatewayModelId 与 modelKey 不同名，如 minimax-speech-2.8-hd ≠ speech-2.8-hd，按 gatewayModelId 查会恒 miss）。
- **image/text/video 回退分支未接**（B4 登记项）：灰显模型回退的代价=一轮注定失败的上游调用后进统一漏斗（退款+failed），无资损。补齐时**必须按 modelKey 查镜像**（video/image 多条目 modelKey≠gatewayModelId：seedance-2.0→doubao-seedance-2.0、image2 等），按 gatewayModelId 查会造出「静默恒过」的假校验。
