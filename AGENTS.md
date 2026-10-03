# PI-Lnk 项目 Agent 开发规范

> 本文件是 agent 在本仓库工作的**唯一权威规范**。
> 整理于 2026-10-03 —— 全文按当时仓库实况逐条核实过，删除了已失效的条文。
> 改动本文件时，**每条陈述都要回代码核实，不要凭印象写**（历史教训见末节）。

## 项目目标

**打造以 `pi-agent-core` 为内核的 canvas agent，驱动画布的超创平台 lnk π。**

-内核：`@earendil-works/pi-agent-core`（版本见下节）
- 载体：画布（canvas）—— agent 的产出物是可交互的图，而非纯文本流
- 方向：视觉内容的生产与迭代（分镜 / 电商素材 / 角色与场景等），skills 资产在 `skills/`

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

## pi 内核版本

**当前唯一版本：`0.85.1`**（2026-10-03 核实，三处一致）

| 位置 | 值 | 含义 |
|---|---|---|
| `vendor/earendil-works/pi/VENDORED.md` | `v0.85.1`（tag 对应 commit `d981de1`） | pin 的上游版本，**权威来源** |
| `services/pi-runtime/package.json` | `"@earendil-works/pi-agent-core": "0.85.1"` | 运行时 npm 依赖，**实际生效的版本** |
| `vendor/earendil-works/pi/package.json` | `"version": "0.0.3"` | ⚠️ vendor 镜像的**内部版本号，与上游无关** |

### 三个版本号别混

- **`0.85.1`** = pi 内核版本（npm 包名无 `v` 前缀；VENDORED.md 写作 `v0.85.1`）
- **`0.0.3`** = vendor 镜像目录自己的 `package.json` 版本号，**不是 pi 版本**
- **`0.0.1`~ `0.0.41`** = **pi-runtime 镜像的部署 tag**（历史遗留的数字版号，2026-10-03 起已停用）

### 查询规范

| 想查什么 | 去哪查 | 不要去哪 |
|---|---|---|
| pi 内核用的是哪个版本 | `services/pi-runtime/package.json` 的 dependencies | vendor 的 `package.json`（是镜像内部号） |
| pin 的上游 tag / patch 纪律 | `vendor/earendil-works/pi/VENDORED.md` | — |
| 当前部署的是哪个镜像 | 部署 tag = **master 的 commit 短 sha**（`git rev-parse origin/master \| cut -c1-9`） | registry 里的 `0.0.x` 数字 tag（已停用） |
| 上游有没有新版本 | 上游 repo 的 release/tag | 本地任何文件 |

**升级 pi 的流程**：改 `services/pi-runtime/package.json` 版本 → 同步更新 vendor 目录与 `VENDORED.md` 的版本/commit 行
→ 在 `VENDORED.md` 记录升级理由 → 走分支七步流程。
⚠️ vendor 目录**禁止业务 patch**（只允许记录版本与来源），否则 upmerge 时无法与上游对齐。

> pi v0.85.1 **无 subagent 支持**（全仓 0 命中）。subagent 需 L2 自建（嵌套 Agent 实例或复用 Lane）；
> HITL 挂点用 `before_tool` hook，上下文注入用 `transform_context`。

## 仓库结构（2026-10-03 核实）

```
pi-lnk/
├── apps/
│   ├── server/          # @lnkpi/server —— NestJS，pi-runtime 的宿主入口，ProviderContext 所在
│   └── web/             # @lnkpi/web —— Vue 3 前端（画布 UI 在此）
├── packages/
│   ├── agent/           # @lnkpi/agent —— 自研 agent，纯函数工具为主
│   ├── shared/          # @lnkpi/shared —— 共享包（含 imagePromptingGuide 引导场景目录）
│   └── pi-poc/          # @pi-lnk/pi-poc —— N2 PoC spike（5/5 PASS）
├── services/
│   └── pi-runtime/      # @pi-lnk/pi-runtime —— agent 运行时（fastify，承载 vendored pi）
├── charts/pi-lnk-runtime/   # Helm chart（K3s 部署：deployment/service/ingress/hpa/netpol/pvc）
├── vendor/earendil-works/pi/ # pi 只读镜像（纪律见其 VENDORED.md，禁止业务 patch）
├── skills/              # 业务 skill 资产（drama-* 7 个 + ecommerce-product-photo）
├── prompt-registry/     # 提示词规则资产（rules/*.md + MANIFEST.yaml），进 api 镜像
├── deploy/              # 部署脚本（cvm-recover.sh / deploy-remote-build.sh 等）
├── docs/                # 见下方 docs 子目录
├── scripts/             # ⚠️ 不进 api 镜像（Dockerfile 只 COPY apps/packages/prompt-registry）
├── assets/              # 静态资源
└── uploads/             # 上传产物（本地，一般不入库）
```

**`docs/` 子目录**：`adr/`（决策记录）、`archive/`、`diagnostics/`、`discussion/`、`mockups/`、`ops/`（runbook）、`superpowers/`（spec 与 plan）、`workflow/`

**`skills/` 现有清单**：`drama-audio-design`、`drama-character-design`、`drama-motion-video`、`drama-qc-review`、`drama-scene-worldview`、`drama-script-writing`、`drama-storyboard`、`ecommerce-product-photo`
—— 新增 skill 时同步更新此清单，并注意 `prompt-lint.ts` 会对 skill 做格式门禁。

> ⚠️ **包名不统一，但影响面很小**：多数是 `@lnkpi/*`，而 `services/pi-runtime` 与 `packages/pi-poc` 是 `@pi-lnk/*`。
> 实测这两个包名**只出现在各自的 `package.json` 里，无其他文件 import**（Nest 侧走 HTTP + `PI_RUNTIME_URL`
> 通信，不作为 npm 依赖引入），因此不构成障碍。
> **写代码前先看目标目录的 `package.json` 实际 name**，不要按目录名或历史推断。

## 端口约定

| 服务 | 端口 | 来源 | 说明 |
|---|---|---|---|
| Web（Vite dev） | 5173 | `apps/web/vite.config.ts` | 本地 dev 走 Vite proxy `/api` |
| Nest API（apps/server） | **5100** | 生产 CVM 实测监听 | 容器内 `PORT` 可覆盖 |
| pi-runtime | **8100** | `charts/pi-lnk-runtime/values.yaml:15`、`services/pi-runtime/.env.example:10` | 避开 CVM已占用的 8080 / 8000 |

生产访问链路：浏览器 → nginx → Nest（`:5100`）→ (K3s 集群内) pi-runtime（`:8100`，ClusterIP不暴露公网）。

> `values.yaml` 里 `NEST_BASE_URL` **必须带 `/api` 全局前缀**（如 `http://<NodeIP>:5100/api`），
> 否则 P1 工具转发会 404。
>
> pi-runtime 访问宿主 Nest 端口时，K3s 会把 pod 发往宿主已发布端口的流量 DNAT，
> NetworkPolicy 放行规则实测会失效（见 `values.yaml:43-52` 的注释），改 NetworkPolicy 前先读那段。

> `PI_RUNTIME_MODE=off` 是**维护态关停**（chat 与心跳都报不可用），不是「切回另一条链路」——
> 老 LangGraph 链路（`services/agent-runtime`）已彻底删除，没有第二条可切。

## 必须先做的事

- **动手前先读相关代码，不凭印象改。** 本仓库历史上多次因"凭印象画/写"被退回：
  漏画已存在的按钮、删掉代码里的默认态、线框与真实 chrome 不符。
- **改动落盘后必须逐项复核。** 可靠判据只有 `git status` 显示 ` M`/`??`；
  Edit/Write 报"成功"**不等于**落盘，Grep 命中可能是缓存假象。
- **分支上开发。** 见上方分支纪律。

## 核心 skill 路由

**第一层：`using-superpowers`（总入口，每个会话开始就该调用）**
它规定"有任何 skill 可能适用就必须先调用"、并给出优先级（process skill 先于 implementation skill）。
下面这些是它路由到的具体 skill：

| 场景 | skill |
|---|---|
| 创造性工作前 | `brainstorming` |
| bug / 异常 | `systematic-debugging` |
| 提交前 | `verification-before-completion` |
| 写实现计划 | `writing-plans` |
| 分支管理 | `using-git-worktrees` |
| **开发流程（七步）** | `branch-first-dev-workflow` |
| **合并后：盯 CI / 盯部署 / 生产取证** | `prod-deploy-verify` |

> `using-superpowers` 管**"该不该用 skill、按什么顺序用"**；
> `branch-first-dev-workflow` 管**"git 操作怎么走"**。两者不冲突，是不同维度。

## 本机环境

```bash
export PATH="/usr/local/bin:$PATH"   # gh 在 /usr/local/bin，不在默认 PATH
```

- **本机是 4 核 Mac，多 agent 并存** —— 跑全量测试前先看 `uptime`，别互相拖慢
- `ps` 在沙箱环境 `operation not permitted`，查进程用 `lsof`
- 主仓`/Users/4seven/workspace/pi-lnk`；worktree 在 `.worktrees/<slug>/`