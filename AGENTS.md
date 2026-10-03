# PI-Lnk 项目 Agent 开发规范

本项目 fork 自 [lnkpi](https://github.com/your-org/lnkpi)，
目标是**把内核从自研 LangGraph Runtime + 自研 `@lnkpi/agent` 切换到 [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) v0.85.1**。

## 当前阶段：Phase 0'' 基建子阶段（进行中）

讨论与规格阶段已完成：

- **第一资产（讨论文档 v1.3）**：[`docs/discussion/2026-09-19-pi-lnk-migration-discussion.md`](./docs/discussion/2026-09-19-pi-lnk-migration-discussion.md)
  （§1–§11 主文 + 附录 A：A.4 业界先例 / A.5 目标架构借鉴蓝图 / A.6 落地方案草图）
- **实现侧 spec（Final v1.0）**：[`docs/superpowers/specs/2026-09-19-pi-lnk-fast-ramp-k3s-design.md`](./docs/superpowers/specs/2026-09-19-pi-lnk-fast-ramp-k3s-design.md)
  （16 章，Fast-Ramp Atomic-First + K3s Day-1 Minimal，P0+P1 硬截止 30 天）

已完成：N2 PoC spike（5/5 live PASS，`packages/pi-poc`，含实测 API 模式）；B1 vendor pi v0.85.1；B2 `services/pi-runtime` 骨架（端点冒烟通过）。

进行中 / 待做（spec §6.2.0）：B3 Zod↔TypeBox 桥接、B4 Nest L6 入口接入、B5 Helm chart、B6 K3s 单节点 + Prometheus/Grafana、B7 镜像构建 + registry、B8 Nest↔pi-runtime RPC 客户端 + AgentEvent SSE 实流。B3/B8 完成后进 P0 shadow 验证（chat 流 ≥7 天 + 7 项 KPI，见 spec §4.4/§6.2.2）。

**所有开发工作按本文件 + spec 执行**；改动落盘后必须逐项 Grep 复核（历史上有 Edit 报成功但未落盘的案例）。

## 仓库归属红线（2026-09-28 拍板：pi-lnk 唯一仓库）

**pi-lnk = 唯一仓库 + 唯一发布门**：前后端 / runtime / CICD / agent 开发**全部**在 pi-lnk 做。
lnkpi 仓库（`/Users/4seven/workspace/lnkpi`）降级为**只读历史归档**，不再用于开发。

### 治理转向（覆盖 2026-09-27 旧的"双仓库并行"红线）

- 以前"日常功能开发在 lnkpi、发布以 pi-lnk 为准"作废；以后不维护 lnkpi↔pi-lnk 同步手册
- **lnkpi 仓库 deploy.yml**：push 触发的 deploy-web job 已禁用（`if: false`），避免把 lnkpi 自己的 dist 推上去覆盖 pi-lnk 推的
- **pi-lnk deploy.yml**：deploy-web job 已改为 push 触发 master（当 changes 检测到 web 改动）时自动跑，Upload step 加 `rm -rf dist/assets` 清旧 chunk 再解压，不再"emergency only"

### 保留红线

1. **agent 链路独立演进** —— 涉及 `apps/server/src/agent/**`、`services/pi-runtime/**`、`charts/**`、`vendor/**` 的改动只在 pi-lnk 做（lnkpi 不再开发，"永不从 lnkpi 同步"自动达成）
2. **老 runtime（LangGraph）已删永不回退** —— `services/agent-runtime` / `Dockerfile.agent-runtime` / `deploy-agent-runtime.yml` 已退役删除，`PI_RUNTIME_MODE=off` 是维护态关停不是切链路
3. **lnkpi 仓库保留 `services/agent-runtime` 是其刚需**（它无 pi-runtime）—— 不要去删它、也不要"同步后再删"

老同步手册 `docs/ops/RUNBOOK-lnkpi-to-pi-lnk-sync.md` §10 仅留历史参考。

## 核心规则（继承自 lnkpi）

- 任何创造性工作前 → `brainstorming` skill
- 任何 bug / 异常 → `systematic-debugging` skill
- 提交前 → `verification-before-completion` skill
- 写实现计划 → `writing-plans` skill
- 分支管理 → `using-git-worktrees` skill

## 本地测试纪律（2026-09-29 定）

背景：本机是 **4 核 Mac** 且多 agent 并存，曾实测多窗口并跑全量测试把 load 打到 **21+**（超载 5 倍，所有测试互相拖慢）。

1. **默认跑变更相关测试，不跑全量**：
   - server：`pnpm test:server:changed`（相对 origin/master 的变更用例）或 `pnpm test:server`（整个 server 套件）；改动聚焦时直接跑单文件——`pnpm --filter @lnkpi/server exec vitest run src/agent/<file>.test.ts`
   - pi-runtime：`pnpm test:runtime`；单文件 `node --import tsx --test src/<file>.test.ts`（在 `services/pi-runtime/` 下）
2. **全量 `pnpm test` 是 CI 的活**。位置：`ci.yml` 的 **`Build monorepo`** job → step `Unit and integration tests`（`ci.yml:74` 的 `pnpm test`）——**不是**独立 test job。`gh pr checks` 只列 3 个 job（Verify spec figures / Build monorepo / Build API Docker image），看不到测试但它确实跑在里面，核实要下钻 step：
   ```
   gh run view <id> --json jobs --jq '.jobs[] | .name as $n | .steps[] | "\($n) :: \(.name) :: \(.conclusion)"'
   gh run view <id> --log | grep -E 'Test Files.*passed|# (tests|pass|fail) '
   ```
   规模（2026-10-03 实测）：`services/pi-runtime` 555 用例 + `apps/server` 96 / `apps/web` 176 / `packages/shared` 43 / `packages/agent` 25 个测试文件，约 3 分钟。本地确需全量时：
   - 先 `uptime`——**load > 8 禁止起跑**（有并行会话在跑时几乎必然超）
   - 同一时刻**全仓只允许一个全量**；server 全量必须带 `--hookTimeout=120000`（已知 flake）
3. **不要本机同时跑 server 与 pi-runtime 两套全量**——资源竞争会 SIGKILL(137)，出现假失败
4. vitest 本地已限 **2 fork**（`apps/server/vitest.config.ts`，CI 环境不限速）——这是给多 agent 并存留余量，不要调回去
5. worktree 首次跑测试前：`pnpm install --frozen-lockfile` + `pnpm --filter @lnkpi/server exec prisma generate`（否则 vitest 报 `.prisma/client` 缺失）

## 已拍板决策（以 spec v1.0 为准）

详细版见 spec 第 3 章决策表；与讨论文档 §10 的差异：**D-α' 替换 D-α（K3s Day-1 Minimal）、D-β' 替换 D-β（Fast-Ramp Atomic-First，8 周 → 5-6 周，marketing 移出 v1.0）**。

| ID | 决策 |
|---|---|
| D-α' | pi-runtime 部署形态：**K3s Day-1 Minimal**（替换原 D-α 独立 Node 服务） |
| D-β' | 迁移策略：**Fast-Ramp Atomic-First**（先攻最难的 atomic，P0 shadow ≥7 天 + 7 项 KPI；marketing 移至 v1.1） |
| D-γ' | pi 版本控制：**vendor 到 monorepo**（`vendor/earendil-works/pi/`，pin v0.85.1 + patch 流程） |
| D-δ' | OAuth 接入：**v1.0 默认关闭**（v1.1 解锁条件见 spec） |
| D-ε | 项目命名：**PI-Lnk**（包名 `@pi-lnk/*`） |
| D-ζ' | 老 LangGraph Runtime：**保留 30 天回退开关**（4 级回退 + 归档） |
| D-η' | 自研 `@lnkpi/agent`：**部分保留**（纯函数工具保留，12 个 prompt-mode 全删 → slash command + skill） |

## 仓库结构（monorepo 已有代码）

```
pi-lnk/
├── apps/
│   ├── server/          # @lnkpi/server —— NestJS 服务端（pi-runtime 的宿主入口，F7 ProviderContext 所在）
│   └── web/             # Vue 3 前端
├── packages/
│   ├── agent/           # @lnkpi/agent —— 自研 agent（D-η'：纯函数工具保留，prompt-modes 删除）
│   ├── pi-poc/          # N2 PoC spike（5/5 PASS，实测 API 模式的参考实现）
│   └── shared/          # 共享包
├── services/
│   └── pi-runtime/      # 新 agent 运行时（fastify，承载 vendored pi，K3s 部署）
├── vendor/
│   └── earendil-works/pi/  # pi v0.85.1 只读镜像（纪律见其 VENDORED.md，禁止业务 patch）
├── deploy/              # 部署脚本与配置
├── docs/
│   ├── discussion/      # 讨论文档（第一资产，v1.3）
│   └── superpowers/specs/  # 实现 spec（Final v1.0）
└── scripts/
```

## 端口约定（本地开发 + 部署）

| 服务 | 端口 | 说明 |
|---|---|---|
| Web（Vite dev） | 5173 | 本地 dev 走 Vite proxy `/api`；生产 Vercel `/api` rewrite |
| Nest API（apps/server） | 3001（`PORT` 可覆盖） | 生产 CVM 直连 `:5100`，公网统一走 nginx `:8888` |
| pi-runtime | **8100**（`PORT` 可覆盖） | 新 agent 运行时；Nest 经 `PI_RUNTIME_URL` 调用 |

> 端口分配原则：新服务避开本机已占用端口（8080 被占）；pi-runtime 在 K3s 内走 ClusterIP，**不直接暴露公网**——访问链路：浏览器 → nginx `:8888` → Nest → (集群内) pi-runtime。
>
> ⚠️ 老 LangGraph agent-runtime（Python, :8000）已于 **2026-09-27 退役删除**（`services/agent-runtime/`、`Dockerfile.agent-runtime`、`deploy-agent-runtime.yml` 一并移除）。pi-runtime 是**唯一**对话链路：`PI_RUNTIME_MODE=off` 现在是**维护态关停**（chat 与心跳都报不可用），不再代表「切回另一条链路」。

> 讨论文档 A.6 重要校准：**pi v0.85.1 无 subagent 支持（全仓 0 命中）**，subagent 需 L2 自建（嵌套 Agent 实例或复用 Lane），HITL 挂点用 `before_tool` hook，上下文注入用 `transform_context`。
