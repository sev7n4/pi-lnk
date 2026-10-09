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
