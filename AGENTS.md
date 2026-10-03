# PI-Lnk 项目 Agent 开发规范

> 本文件是 agent 在本仓库工作的**唯一权威规范**。
> 整理于 2026-10-03 —— 全文按当时仓库与生产实况逐条核实过，删除了已失效的条文。
> 改动本文件时，**每条陈述都要回代码/线上核实，不要凭印象写**（历史教训见末节）。

## 项目是什么

fork 自 lnkpi，目标是**把对话内核从自研 LangGraph Runtime 切到 [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi)**。

**当前状态（2026-10-03 核实）：已上线生产，功能迭代中。**
生产健康端点实测返回 `{"ok":true,"latencyMs":1}`；`deploy.yml` 与 `Runtime Deploy (pi-runtime)`
两条流水线均持续 success。**不要再按"Phase 0 基建阶段"理解本项目。**

架构与迁移决策详见：
- 讨论文档（第一资产）：`docs/discussion/2026-09-19-pi-lnk-migration-discussion.md`
- 实现 spec（Final v1.0）：`docs/superpowers/specs/2026-09-19-pi-lnk-fast-ramp-k3s-design.md`

## ⭐ 分支纪律（最高优先级）

**铁律：master 永远等于 origin/master，任何改动（含 `docs/`）不得直接提交到 master。**

**七步流程，一步都不能省：**

| # | 步骤 | 命令 / 判据 |
|---|---|---|
| 1 | **开分支**（发现要改的第一刻就开，别写完代码才开） | `git fetch origin && git worktree add .worktrees/<slug> -b <type>/<slug> origin/master` |
| 2 | 开发 | 在 worktree 里改；首次跑测试前 `pnpm install --frozen-lockfile` + `pnpm --filter @lnkpi/server exec prisma generate` |
| 3 | 提交 | 分支内 `git add` + `git commit`，message 用 `feat/fix/docs/ci(scope): 描述` |
| 4 | 推 + 开 PR | `git push -u origin <branch>` → `gh pr create --body-file <file>` |
| 5 | **盯 CI 到全绿** | `gh pr checks <n>` 全 pass；合并前先查有无在跑的 workflow（会互相挤掉） |
| 6 | **squash 合并** | `gh pr merge <n> --squash`（不加 `--delete-branch`，master 被主仓 worktree 占用会报错） |
| 7 | **盯部署 + 上线生产验证** | 见 `prod-deploy-verify` skill（两条流水线 + 生产取证全套） |

**自检判据**（任何时候都应成立）：

```bash
git rev-list --count origin/master..master   # 必须 0
git rev-list --count master..origin/master   # 必须 0
```

**主仓（master 工作区）只做拉取/查看/开分支起点，不改代码不提交。**

三个高频踩坑（详见 `prod-deploy-verify` 与 `branch-first-dev-workflow` skill）：

- **判定分支是否已合并禁用 `git cherry` / `git rev-list --count`** —— squash 会重写 commit、patch-id 对不上，已合分支会被误报成「未合并」。权威判据：`gh pr list --head <b>` 拿 mergeCommit，再 `git merge-base --is-ancestor <sha> origin/master`。
- **查 check-run 数量用 `--jq '.total_count'`，不能用 `length`** —— 后者把 JSON 对象的 key 当数组元素数，`{"total_count":0,...}` 会返回 2，把「CI 从未触发」误判成「在跑」。
- **push 到 master 没有新 run，先查 workflow 的 paths 过滤** —— `ci.yml` 有 `paths-ignore: ["**/*.md","docs/**"]`，`deploy.yml` 是 paths 白名单。**纯文档改动不触发 CI、不触发部署，零 workflow 是正确行为。**

## 本地测试纪律（2026-09-29 定）

背景：本机是 **4 核 Mac** 且多 agent 并存，曾实测多窗口并跑全量测试把 load 打到 **21+**（超载 5 倍）。

1. **默认跑变更相关测试，不跑全量**：
   - server：`pnpm test:server:changed`（相对 origin/master 的变更用例）；聚焦时单文件 —— `pnpm --filter @lnkpi/server exec vitest run src/agent/<file>.test.ts`
   - pi-runtime：`pnpm test:runtime`；单文件 `node --import tsx --test src/<file>.test.ts`（在 `services/pi-runtime/` 下）
2. **全量 `pnpm test` 是 CI 的活**。位置：`ci.yml` 的 **`Build monorepo`** job → step `Unit and integration tests`（`ci.yml:74` 的 `pnpm test`）—— **不是**独立 test job。`gh pr checks` 只列 3 个 job（Verify spec figures / Build monorepo / Build API Docker image），看不到测试但它确实跑在里面，核实要下钻 step：
   ```
   gh run view <id> --json jobs --jq '.jobs[] | .name as $n | .steps[] | "\($n) :: \(.name) :: \(.conclusion)"'
   gh run view <id> --log | grep -E 'Test Files.*passed|# (tests|pass|fail) '
   ```
   本地确需全量时：
   - 先 `uptime` —— **load > 8 禁止起跑**
   - 同一时刻**全仓只允许一个全量**；server 全量必须带 `--hookTimeout=120000`（已知 flake）
3. **不要本机同时跑 server 与 pi-runtime 两套全量** —— 资源竞争会 SIGKILL(137)，出现假失败
4. vitest 本地已限 **2 fork**（`apps/server/vitest.config.ts`，CI 不限速）—— 给多 agent 并存留余量，不要调回去
5. worktree 首次跑测试前：`pnpm install --frozen-lockfile` + `pnpm --filter @lnkpi/server exec prisma generate`（否则 vitest 报 `.prisma/client` 缺失）

> 测试文件规模会变，**要数字时实测 `find <dir> -name '*.test.ts' | wc -l`，别抄本文档的旧数字**。
> 2026-10-03 实测：server 97 / web 176 / pi-runtime 顶层 26 个测试文件。

## 架构决策（已拍板，勿反复）

| ID | 决策 |
|---|---|
| D-α' | pi-runtime 部署形态：**K3s Day-1 Minimal** |
| D-β' | 迁移策略：**Fast-Ramp Atomic-First**；marketing 移出 v1.0 |
| D-γ' | pi 版本控制：**vendor 到 monorepo**（`vendor/earendil-works/pi/`，pin 上游 tag + patch 流程） |
| D-δ' | OAuth 接入：**v1.0 默认关闭** |
| D-ζ' | 老 LangGraph Runtime：**已彻底退役删除**（`services/agent-runtime`、`Dockerfile.agent-runtime`、`deploy-agent-runtime.yml` 均已移除） |
| D-η' | 自研 `@lnkpi/agent`：**部分保留**（纯函数工具保留，prompt-mode 全删 → slash command + skill） |

> ⚠️ **pi 版本号有两套，别混**：
> - **上游 tag `v0.85.1`** = 我们 pin 的 `pi-agent-core` 版本，见 `vendor/earendil-works/pi/VENDORED.md`
> - `vendor/earendil-works/pi/package.json` 里的 `"version": "0.0.3"` = vendor 镜像自己的内部版本号
> - 运行时还有 `0.0.29`/`0.0.30`/`0.0.31` 等历史 tag 出现在 registry 与 commit message 里
>
> 判断"我们用的是哪个上游版本"→ 查 `VENDORED.md`；查"镜像构建产物版本"→ 查部署 tag。混用会得出错误结论。

> ⚠️ **pi v0.85.1 无 subagent 支持**（全仓 0 命中）。subagent 需 L2 自建（嵌套 Agent 实例或复用 Lane）；
> HITL 挂点用 `before_tool` hook，上下文注入用 `transform_context`。

## 仓库结构

```
pi-lnk/
├── apps/
│   ├── server/          # @lnkpi/server —— NestJS，pi-runtime 的宿主入口，ProviderContext 所在
│   └── web/             # @lnkpi/web —— Vue 3 前端
├── packages/
│   ├── agent/           # @lnkpi/agent —— 自研 agent（D-η'）
│   ├── shared/          # @lnkpi/shared —— 共享包（含 imagePromptingGuide 等）
│   └── pi-poc/          # @pi-lnk/pi-poc —— N2 PoC spike（5/5 PASS）
├── services/
│   └── pi-runtime/      # @pi-lnk/pi-runtime —— agent 运行时（fastify，承载 vendored pi）
├── charts/pi-lnk-runtime/   # Helm chart（K3s 部署）
├── vendor/earendil-works/pi/ # pi 只读镜像（纪律见其 VENDORED.md，禁止业务 patch）
├── deploy/              # 部署脚本与 Dockerfiles
├── docs/                # discussion（第一资产）/ superpowers（spec 与 plan）/ ops（runbook）
├── prompt-registry/     # 提示词规则资产（.md）+ MANIFEST.yaml，进 api 镜像
├── skills/              # skill 资产
└── scripts/             # ⚠️ 不进 api 镜像（Dockerfile 只 COPY apps/packages/prompt-registry）
```

> ⚠️ **包名目前不统一**：多数是 `@lnkpi/*`，但 `pi-runtime` 与 `pi-poc` 是 `@pi-lnk/*`。
> D-ε 决策要求统一为 `@pi-lnk/*`，但迁移未完成。**写代码前先看目标目录的 `package.json` 实际 name**，
> 不要按决策表推断。改造未完成前不要"顺手统一"，会炸其他包的引用。

## 端口约定

| 服务 | 端口 | 说明 |
|---|---|---|
| Web（Vite dev） | 5173 | 本地 dev 走 Vite proxy `/api` |
| Nest API（apps/server） | 3001（`PORT` 可覆盖） | 生产 CVM 直连 `:5100`，公网统一走 nginx `:8888` |
| pi-runtime | **8100**（`PORT` 可覆盖） | K3s 内走 ClusterIP，**不直接暴露公网** |

访问链路：浏览器 → nginx `:8888` → Nest（`:5100`）→ (集群内) pi-runtime。

> `PI_RUNTIME_MODE=off` 是**维护态关停**（chat 与心跳都报不可用），
> 不再代表「切回另一条链路」—— 老 LangGraph 链路已删除，没有第二条可切。

## 必须先做的事

- **动手前先读相关代码，不凭印象改。** 本仓库历史上多次因"凭印象画/写"被退回：
  漏画已存在的按钮、删掉代码里的默认态、线框与真实 chrome 不符。
- **改动落盘后必须逐项复核。** 可靠判据只有 `git status` 显示 ` M`/`??`；
  Edit/Write 报"成功"**不等于**落盘，Grep 命中可能是缓存假象。
- **分支上开发。** 见上方分支纪律。

## 核心 skill 路由

| 场景 | skill |
|---|---|
| 创造性工作前 | `brainstorming` |
| bug / 异常 | `systematic-debugging` |
| 提交前 | `verification-before-completion` |
| 写实现计划 | `writing-plans` |
| 分支管理 | `using-git-worktrees` |
| **开发流程（七步）** | `branch-first-dev-workflow` |
| **合并后：盯 CI / 盯部署 / 生产取证** | `prod-deploy-verify` |

## 本机环境

```bash
export PATH="/usr/local/bin:$PATH"   # gh 在 /usr/local/bin，不在默认 PATH
```

- **本机是 4 核 Mac，多 agent 并存** —— 跑全量测试前先看 `uptime`，别互相拖慢
- `ps` 在沙箱环境 `operation not permitted`，查进程用 `lsof`
- 主仓`/Users/4seven/workspace/pi-lnk`；worktree 在 `.worktrees/<slug>/`