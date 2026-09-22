# @pi-lnk/pi-runtime

PI-Lnk 独立 agent 运行时（spec §6.2.0 **B2**），部署形态 D-α' K3s Day-1。

## 当前状态（P0'' 骨架）

| 端点 | 状态 | 说明 |
|---|---|---|
| `GET /healthz` | ✅ | 服务/版本/会话数 |
| `POST /sessions` | ✅ 骨架 | 模型装配（PoC 验证过的最小依赖面），B8 换完整 AgentHarness 会话 |
| `GET /sessions/:id/events` | ✅ 骨架 | SSE 通道已开，B8 接 AgentEvent 11 种事件流 |
| `DELETE /sessions/:id` | ✅ | 会话清理 |

**模型装配**（`src/model-assembly.ts`，来自 PoC 5/5 PASS 的实测模式）：
- 只依赖 `pi-agent-core` + `pi-ai`（不引 pi-coding-agent）
- 凭据走环境变量：`AGNES_API_KEY`（lnkpi 生产中转）→ `OPENAI_API_KEY`（官方）
- 内核源码 vendor 在 `vendor/earendil-works/pi/`（只读镜像，纪律见 VENDORED.md）

## 运行

```bash
pnpm install --filter @pi-lnk/pi-runtime
pnpm --filter @pi-lnk/pi-runtime dev          # 本地开发（默认 :8100，PORT 可覆盖）
AGNES_API_KEY=sk-... pnpm --filter @pi-lnk/pi-runtime start
curl --noproxy '*' localhost:8100/healthz
curl --noproxy '*' -X POST localhost:8100/sessions -H 'content-type: application/json' -d '{}'
```

> 端口约定见根目录 AGENTS.md：pi-runtime 默认 **8100**（避开本机 8080 占用与老 runtime 8000）；K3s 内走 ClusterIP，不直接暴露公网——上线后访问链路不变：浏览器 → Vercel/nginx `:8888` → Nest → (集群内) pi-runtime。

## 后续任务（spec §6.2.0）

- B3 Zod↔TypeBox 桥接（~50 行）
- B4 Nest L6 入口接入（apps/server）
- B5 Helm chart（fork bitnami/common）
- B6 K3s 单节点 dev + Prometheus/Grafana
- B7 容器化（Dockerfile 已预留）+ registry
- B8 Nest ↔ pi-runtime RPC 客户端 + AgentEvent SSE 实流
