# 老 LangGraph agent-runtime 退役（2026-09-27 完成）

## 结论

`services/agent-runtime`（Python / LangGraph，容器 `lnkpi-agent-runtime` :8000）**已彻底退役并删除代码**。
pi-runtime（K3s，NodePort 30100）是**唯一**对话链路。

## 为什么可以跳过 shadow 7 天 / K4 diff / top-20 使用率这三条判据

原退役判据（K4 diff=0 + 使用率覆盖 + shadow 7 天无差异）是「生产有真实流量」前提下的保守设计。
本项目当时**未正式上线、仅作者本人单测**，三条判据全部是 **vacuous（空真）**——不是"达标"，是"无样本"：

| 判据 | 实测（2026-09-27 17:36） | 判定 |
|---|---|---|
| 老 runtime 近 6h 非 health 请求 | **0** | 无流量可比对 |
| 24h `/v1/threads/*/state` | 47 条，全部发生在 PR #34（active 短路）上线**之前**，最后一条 11:03 CST | 短路已生效，之后归零 |
| 24h 容器总请求 | 2923 条，其中 **2876 条是 Docker 自身 HEALTHCHECK** | 无业务流量 |
| 生产 env | `PI_RUNTIME_MODE=active`、`PI_RUNTIME_URL=http://172.20.0.1:30100` | 已全量在 pi |
| 网络可达性 | nginx 只代理 `/api` → Nest；老 runtime 无端口映射 | 外部无从触达 |

## 执行顺序（可回溯）

### 第 1 步：停服务（零代码、秒级可回滚）— 2026-09-27 17:42

```bash
ssh deploy-cvm
cd /opt/lnkpi
cp .env .env.bak-before-retire-20260927-1742
# 注释掉 AGENT_RUNTIME_URL（⚠️ 见下方"踩坑"：SERVICE_TOKEN 不能注释）
docker compose -f /opt/lnkpi/deploy/docker-compose.prod.yml stop agent-runtime   # Exited(137)
```

停服后跑 `retire-verify.py` 全绿，确认无任何回归。

> **⚠️ 踩坑（真实发生）**：`AGENT_RUNTIME_SERVICE_TOKEN` **不是**老 runtime 专属。
> 它是 `/agent/internal/*` 的服务间鉴权，**pi-runtime 的 `tools/nest-client.ts` 仍在使用**。
> 第 1 步误把它一起注释掉了——因为运行中的容器已加载该变量所以当时没炸，
> 但**任何一次 `lnkpi-api` 重启都会让 pi 的全部画布读写工具 401**。
> 已于同日 17:5x 恢复（备份 `.env.bak-before-token-restore-*`）。
> 代码侧已加中性名 `LNKPI_INTERNAL_SERVICE_TOKEN`（新名优先、旧名兜底），见 `agent-internal.guard.ts`。

### 第 2 步：删代码（PR #38）

Nest 侧（`apps/server`）：
- 删 `agent-runtime.client.ts`（`AgentRuntimeClient`）+ 其测试
- 删 `streamFromRuntime` / `mirrorToPiRuntime` / `createRuntimeClient`
- `streamConversation` 只有 pi 分支；healthz 失败 → 直接 `runtime_unavailable`，**无任何回落**
- `checkRuntimeHealth` 只探 pi
- `getThreadState` / `getThreadTimeline` 恒 `null`（**端点保留**：前端 `AgentSideRail.vue` 重连时仍调）
- `PI_RUNTIME_MODE` 三态 → **二态**：`active`（默认）/ `off`（维护态关停）

部署与工程资产：
- `services/agent-runtime/`（整个 Python 服务）
- `deploy/docker/Dockerfile.agent-runtime`、`deploy/systemd/lnkpi-agent-runtime.service`
- `.github/workflows/deploy-agent-runtime.yml`
- `deploy/AGENT_RUNTIME_PRODUCTION.md`、`deploy/enable-agent-runtime.sh`、`deploy/enable-observability-cvm.sh`
- `deploy/observability/{prometheus/agent-runtime-*.yml,grafana/dashboards/agent-runtime-dashboard.json}`
- `deploy/runtime-compare.py`、`deploy/shadow-kpi-report.py`（shadow 通道已不存在）
- compose `agent-runtime` 服务 + `lnkpi-checkpoints` 卷
- CI 的 `verify-contract` 作业（Zod↔Pydantic 校验）+ `scripts/verify-contract.ts` + npm script

### 顺带修掉的一处行为差异

`streamFromPiRuntime` 的 `finalizeTurn` 此前**漏传 `linkedOutputs`**（老 LangGraph 路径传了 `deriveLinkedOutputs(canvasActions)`）。
老路径删除后若不补，助手消息的「产出」挂件会永久为空——已在退役 PR 里补回对等语义。

## 退役后仍然活着的东西（别再误删）

| 项 | 为什么还在 |
|---|---|
| `GET /api/agent/thread-state`、`thread-timeline` 端点 | 前端 `AgentSideRail.vue:1330,1789` 重连时调用；实现恒 null，删端点 → 404 |
| `/agent/internal/*` + `x-lnkpi-service-token` | pi-runtime 画布工具调 Nest 的唯一通道 |
| `AGENT_RUNTIME_SERVICE_TOKEN` 这个变量名 | 历史命名，线上 .env 在用；已加中性名 `LNKPI_INTERNAL_SERVICE_TOKEN` 逐步迁移 |
| `buildTurnMetadata` 对 `journeyTrace` 的支持 | 纯函数保留；pi 不发 `journey_update`，故运行时不产出（前端步骤条处于休眠态） |

## 回滚

- **秒级止血（维护态）**：`/opt/lnkpi/.env` 设 `PI_RUNTIME_MODE=off` → chat 与心跳都报不可用。
  注意：这**不等于**切回老 runtime——那条链路已删；`off` 现在的语义是「关停」。
- **版本回退**：`LNKPI_API_IMAGE=lnkpi-api:<旧 sha>` 重新部署（脚本保留当前 + latest + 1 个历史）。

## ⚠️ 给后续同步的提醒

`/opt/lnkpi` 是从 **lnkpi** 仓库同步出来的派生运行树。pi-lnk 单方面删除 `services/agent-runtime`
**不会**自动同步到 lnkpi；下次从 upstream merge 时，若 lnkpi 侧仍保留该目录，它会被带回来。
要么在 lnkpi 侧做同款删除，要么 merge 后重新删一次并记一笔。
