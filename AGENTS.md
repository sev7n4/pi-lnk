# PI-Lnk 项目 Agent 开发规范

> 本文件是 agent 在本仓库工作的**唯一权威规范**。
> 整理于 2026-10-03 —— 全文按当时仓库实况逐条核实过，删除了已失效的条文。
> 改动本文件时，**每条陈述都要回代码核实，不要凭印象写**（历史教训见末节）。

## 项目目标

**打造以 `pi-agent-core` 为内核的 canvas agent，驱动画布的超创平台 lnk π。**

- 内核：`@earendil-works/pi-agent-core`（版本见下节）
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
| 7 | **盯部署 + 上线生产验证** | 见 `prod-deploy-verify` skill（**四条流水线** + 生产取证全套，触发面见「系统地图」） |

**自检判据**（任何时候都应成立）：

```bash
git rev-list --count origin/master..master   # 必须 0
git rev-list --count master..origin/master   # 必须 0
```

**主仓（master 工作区）只做拉取/查看/开分支起点，不改代码不提交。**

三个高频踩坑（详见 `prod-deploy-verify` 与 `branch-first-dev-workflow` skill）：

- **判定分支是否已合并禁用 `git cherry` / `git rev-list --count`** —— squash 会重写 commit、patch-id 对不上，已合分支会被误报成「未合并」。权威判据：`gh pr list --head <b>` 拿 mergeCommit，再 `git merge-base --is-ancestor <sha> origin/master`。
- **查 check-run 数量用 `--jq '.total_count'`，不能用 `length`** —— 后者把 JSON 对象的 key 当数组元素数，`{"total_count":0,...}` 会返回 2，把「CI 从未触发」误判成「在跑」。
- ⚠️ **CI 触发面分两个事件，别混** —— `ci.yml` 的 `paths-ignore: ["**/*.md","docs/**"]` **只挂在 `push` 事件上**；`pull_request:` 分支**没有任何 paths 过滤**。所以：push 到 master 时纯文档改动零 workflow（正确行为）；但**开 PR 时一律触发三个 required check**，纯文档 PR 也不例外。`deploy.yml` 是独立的 paths 白名单（server / web / packages / deploy / prompt-registry 等）。

### 收尾清理（第7 步之后，别拖到下次）

合并完成后**当场清掉** worktree 与分支。累积起来会导致主仓状态混乱、`gh pr create` 在主仓执行报错、
worktree 抢占分支等问题（2026-10-03清理前累积到 26 个本地分支 / 21 个 worktree）。

**顺序：worktree → 本地分支 → 远程分支。**

```bash
# 0. 先体检：有未提交改动就别急着删
git -C .worktrees/<slug> status --porcelain
```

| 体检结果 | 判断与处置 |
|---|---|
| 有正在开发的改动 | **绝不删** —— 这是真活儿，保留 worktree |
| 有「PR 已合但文档没进 master」的未跟踪文件 | **备份后再删**（`cp` 到仓外目录），这是唯一副本 |
| 输出为空 | 可以删 |

```bash
# 1. 删 worktree（路径要用【绝对路径】，相对路径会报 not a working tree）
git worktree remove --force /abs/path/to/.worktrees/<slug>
git worktree prune

# 2. ⚠️ worktree 移除后磁盘目录仍在（每个 50M+，含 node_modules）
ls .worktrees/<slug> && rm -rf .worktrees/<slug>

# 3. 删本地 + 远程分支
git branch -D <slug>
git push origin --delete <slug>
```

**同步 master 后的两个必查项**（用 `git update-ref` 移动 HEAD 时尤其容易漏）：

```bash
git status --short              # 若出现 AD 状态（已add 删除但工作区又出现），说明 index 停在旧状态
git reset --mixed HEAD          # 修index（--mixed 不触发 unlink，比 --hard 安全）
rmdir docs/<已删目录>           # 清空后残留的空目录
```

> 合并后主仓的 index 不会自动跟随 `origin/master`，需显式 `git reset --mixed HEAD`。
> 若 `git reset --hard` 报 `unable to unlink old 'X': Operation not permitted`（本机对某些文件的
> unlink 有限制），改用逐文件 `git show origin/master:<path> > <path>` 覆写 +
> `git update-ref refs/heads/master <sha>`。

## 文档管理规范

### 去哪写

| 文档类型 | 位置 | 命名 |
|---|---|---|
| 实现 spec（设计方案） | `docs/superpowers/specs/` | `YYYY-MM-DD-<主题>-design.md` |
| 实施计划 | `docs/superpowers/plans/` | `YYYY-MM-DD-<主题>.md` |
| 方向 / 决策来源 | `docs/discussion/` | `YYYY-MM-DD-<主题>-discussion.md` |
| 部署运维 | `docs/ops/` | — |
| 对外契约 | `docs/workflow/` | ⚠️ 活跃资产，改动前先确认是否影响外部 Agent |
| 提示词规则 | `prompt-registry/rules/` | `<主题>.md` / `<主题>.tail.md`，改完要更新 `MANIFEST.yaml` |

各目录性质与删除判据见 `docs/README.md`。

### 硬约束

- **spec 放 `superpowers/specs/`，plan 放 `superpowers/plans/`** —— 别混。spec 是"设计为什么"，
  plan是"怎么做"，两者生命周期不同。
- **新增文档必须在 `docs/README.md` 登记**（哪个目录、是什么、为什么放这里），
  否则半年后没人知道它是死是活。
- **删除文档前必查引用**，且区分引用性质：

```bash
git grep -l "<文件名或路径>" -- '*.md'      # ⚠️ 用 git grep，别用 grep -r（会超时 SIGTERM）
git grep -l "<路径>" -- apps packages services charts deploy   # 顺带确认代码没引用
```

| 引用性质 | 处置 |
|---|---|
| 代码 import / 对外契约 | **绝对不能删** |
| 活跃文档里的链接 | 删目标，同时把链接改成指向新位置或标注"已移除" |
| 历史 plan/spec 里的"创建/修改某文件"任务描述、模板参考 | **刻意不改** —— 篡改历史记录比留死链更糟。在 `docs/README.md` 记断链清单 + 给出取回方法（`git show <commit>:<path>`） |

### 归档 vs 删除

- **已完成的文档不删，移不改** —— 历史决策有追溯价值（"当初为什么这么定"）。
  真要清理，优先**归档**（挪进 `docs/adr/` 下的 ADR 快照，或集中到 `docs/superpowers/INDEX.md` 标注 frozen）而非删除。
- **删除的判据是"内容已完成使命且无追溯价值"**，典型三类：① 对应功能已实现的设计稿
  （先核实实现确实在代码里）；② 一次性报告/诊断；③ 已被后续决策取代且被明确标注 superseded。
- **有 active 依赖的一律不删**：代码引用、对外接口、被现存文档当spec 依赖的。

### 提交前自查

- [ ] 新增/删除的文档在 `docs/README.md` 登记了
- [ ] 删掉的文档查过引用，且性质判断过了
- [ ] 纯文档 PR 确认了 CI/部署是否真的需要触发（看 workflow 的 paths 过滤，别被"零 workflow"吓到）
- [ ] 分支/worktree 已按上面的顺序清理干净


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
> 本文档正文不写会漂移的计数（测试文件数、文档份数、清单长度）——需要规模感时给获取命令。
> 这条规则由 `pnpm verify-claims` 机器校验（接在 `ci.yml` 的 `Verify spec figures` step）。
> ⚠️ 判据卡的是**类别**而非具体值 —— 早先的判据只检查几个已知旧值，
> 于是同一批任务里新写的 DoD 又引入了新的测试规模数字，判据照样通过。

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

## ⭐ pi-runtime 开发纪律（吃满内核能力）

**核心原则：动手前先查 vendor 能力面；vendor 有的，必须用 vendor 的，不许自研等价物。**

依据：[ADR-0009](./docs/adr/0009-vendor-capability-first.md)。
现状清单：[`services/pi-runtime/DEPENDENCIES.md`](./services/pi-runtime/DEPENDENCIES.md)。

### 为什么这条是硬纪律

"选了 vendor"不等于"用上了 vendor"。2026-10-03 实测：vendor 有 **11 个子包**，
pi-runtime 只import 了 **2 个**。而"没吃满"已经付出过真实代价：

| PR | 教训 |
|---|---|
| #100 | 自研"索引块 + load_tools"**在生产失败**（0.0.29/0.0.30 E2E：弱模型无视引导直调延迟工具，吃vendor 硬编码的 `Tool X is unavailable` 且无恢复路径）⇒ 改为对齐官方 Dynamic Tool Loading |
| #104 | steering / followUp 两种队列模式没接，是"吃满"的一部分 |
| #29 | dock 技能与 pi-runtime **真实安装列表不对齐** —— 技能资产与内核能力脱节 |

还有隐性代价：host侧自研的绕行逻辑会在 vendor 升级时变成技术债
（要么继续维护，要么推倒重来，而官方可能已解决）。

### 动手前的三步检查（不可省）

```bash
# 1. 查扩展面全景（Events / ExtensionContext / ExtensionAPI）
#    vendor/earendil-works/pi/packages/coding-agent/docs/extensions.md

# 2. 查你要的能力在 vendor 里有没有（别凭包名猜）
git grep -n "<能力关键词>" -- vendor/earendil-works/pi/packages/

# 3. 查 pi-runtime 是否已经在用
git grep -n "<能力关键词>" -- services/pi-runtime/src/
```

### 决策规则

| 情况 | 处置 |
|---|---|
| vendor **有**这个能力 | **必须用 vendor 的**。自研前在 PR 里说明「vendor 有什么 / 为什么不能用」 |
| vendor **没有** | 才自研，且要① 隔离在 host 侧（**不patch vendor**，见 ADR-0001）② 记为技术债，注明"若 vendor 后续提供则应替换" |
| 用到了 `pi.on` / `registerTool` 等扩展机制 | 优先切到 vendor 机制，别维护平行实现 |

> ⚠️ `extensions.md` 是 **coding-agent** 的文档，我们跑在自定义 host 上——
> **不能假设文档里每样东西在 host 里都能直接用**，要验证后再用。

### 吃满的判定标准（可核对，不是口号）

`vendor/earendil-works/pi/packages/` 下逐个子包确认"用得上且已用"或"用不上且写了理由"。
**说不清的就是欠账**，写进 PR 描述或 `DEPENDENCIES.md`。

当前待确认的子包（见 `DEPENDENCIES.md` 第四节）：`telemetry`、`evals`、
`session-backends` —— 这三个是**疑似欠账**（我们自建了 metrics / 有 pi-poc 但没接 eval）。
而 `tui`（终端UI）**大概率不需要**（我们是 Web 画布）—— **待确认 ≠ 吃不满**。

### 升级 vendor 时的回归重点

升级流程见「pi 内核版本」节。回归按此顺序：

1. **`DEPENDENCIES.md` 第三节的"自研物"** —— 最可能被官方能力取代的地方
2. **工具分层**（ADR-0005）—— 已知易碎，0.0.29/0.0.30 就是在这崩的
3. **事件流 / SSE**（ADR-0006）—— `lastEventId` 与 `from=now` 不能叠加
4. **hook 顺序** —— `before_tool` 在 `prepareToolCall` **之后**，别指望它拦"调了不该调的工具"
5. **视觉能力三态**（ADR-0004）—— 端到端验证，别只改一端

### 已知的最大缺口

**pi 0.85.1 无 subagent 支持**（全仓 0 命中）。需要 subagent 时只能 L2 自建：
嵌套 Agent 实例，或复用现有 Lane。HITL 挂点用 `before_tool` hook，
上下文注入用 `transform_context`。

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

**`docs/` 子目录**（说明见 `docs/README.md`）：

| 目录 | 性质 |
|---|---|
| `workflow/` | ⚠️ **活跃对外契约，别删** —— 外部 Agent（WorkBuddy/Codex）靠它生成可导入画布的 JSON；校验函数 `validateWorkflow` 由 `useWorkflowExchange.ts`、`compositionLint.ts` 消费 |
| `adr/` | **架构决策记录**（0001 起，最新编号见 `docs/adr/`）—— 回答"为什么这么定"，Accepted 后不删不改，被取代则标 Superseded |
| `superpowers/` | 历史 spec 与 plan（数量以 `INDEX.md` 为准）。**从 `INDEX.md` 进**（按主题 + living/frozen/superseded 分类），不要直接翻目录 |
| `discussion/` | 讨论文档（第一资产） |
| `ops/` | 部署 runbook |

> 2026-10-03 清理：删除 `mockups/`、`diagnostics/`、`archive/`（代码引用均为 0，内容为
> 已完成的阶段性产物）；**`adr/` 当天删除、同日恢复**并补录 8 份 ADR —— 详见 `docs/README.md`。

**`skills/` 现有清单**：`drama-audio-design`、`drama-character-design`、`drama-motion-video`、`drama-qc-review`、`drama-scene-worldview`、`drama-script-writing`、`drama-storyboard`、`ecommerce-product-photo`
—— 新增 skill 时同步更新此清单，并注意 `prompt-lint.ts` 会对 skill 做格式门禁。

> ⚠️ **包名不统一，但影响面很小**：多数是 `@lnkpi/*`，而 `services/pi-runtime` 与 `packages/pi-poc` 是 `@pi-lnk/*`。
> 实测这两个包名**只出现在各自的 `package.json` 里，无其他文件 import**（Nest 侧走 HTTP + `PI_RUNTIME_URL`
> 通信，不作为 npm 依赖引入），因此不构成障碍。
> **写代码前先看目标目录的 `package.json` 实际 name**，不要按目录名或历史推断。

## 变更影响面矩阵

**改什么会静默坏掉。** 下表是踩过的坑，每一行都在生产或 PR 里付出过代价。

### 改提示词规则 ⇒ 同步 6 处，漏一处就静默

| # | 位置 | 漏掉的后果 |
|---|---|---|
| 1 | `prompt-registry/rules/<id>.md` | 规则不存在 |
| 2 | `prompt-registry/MANIFEST.yaml`（`contentHash` = `sha256(body.trimEnd())` 前 12 位；`version` 两处一致） | 完整性校验失败 |
| 3 | `prompt-registry.loader.ts` 的 `COMPOSED_IDS` | 不参与组合 |
| 4 | `prompt-registry.loader.ts` 的 `FALLBACK_BY_ID` 映射（仅此一处定义） | 降级路径与实际规则不一致 |
| 5 | 🔴 `pi-prompt-assembler.service.ts` 的 `renderStaticFallback()` **拼装顺序** | **整段提示词静默消失，且无任何报错** |
| 6 | 🟡 `pi-prompt-assembler.service.test.ts` 的 `EXPECTED` 硬编码串 | 测试假绿 |

**同步判据**：「磁盘 renderStatic == 内嵌 renderStaticFallback」四组合**逐字符相等**。

⚠️ `renderStaticFallback` 在 3 个源文件 + 2 个测试文件出现（共 5 处），
第 5 处指的是**内嵌 fallback 的那一处**；「四组合逐字符相等」判据的实现在
`prompt-registry.loader.test.ts`。
⚠️ `FALLBACK_BY_ID` 只在 loader 定义，`prompt-registry.fallback.ts` 里没有同名符号 ——
它靠**内容逐字相等**被约束，不是靠常量名对齐。
⚠️ 本仓 `grep` / `git grep` 可正常使用；大范围扫描（如全仓 python 遍历）会超时
（exit 137），此时缩小到具体目录或改用 `git grep -n -- <符号> -- <目录>`。

改完跑 `pnpm prompt:lint`（独立成 `prompt-lint.yml` 流水线，`ci.yml` 不覆盖它）。

⚠️ **L6 预算上限 3200 字符**，当前余量约 320 ≈ 还能加 4 条中等规则。加规则前先想清楚值不值。

### 改工具分层 ⇒ 必答「哪个资产点名了它」

**新增工具默认进延迟集前，必须回答：`prompt-registry` 规则或 `skills/*.md` 里，哪个资产按名字点名了它？**
答不上来按「未点名」处理 ⇒ 必须常驻。

机理：`drive/tools.ts:686` 只把 `activeToolNames` 传给 `prepareToolCall`，
未激活的工具吃 vendor 硬编码的 `Tool X is unavailable`，**没有恢复路径**。

生产证据（PR #100）：40 次工具调用全落常驻集，`tool_search_activated_total` 为 0
⇒ 官方 Dynamic Tool Loading 触发率至今为 0。

⚠️ 已因此回归常驻：`arrange_nodes` / `set_node_generation_params` / `save_memory` / `focus_node` / `remove_edges`。
**`focus_node`（单数，常驻）≠ `focus_nodes`（复数，延迟）** —— 只差一个字母，极易踩错。

新增或变更工具须在 `services/pi-runtime/src/tools/tiering.test.ts` 显式声明归属。

### 改 vendor 消费 ⇒ 认清层次边界

`pi.on` / `pi.registerTool` / `registerCommand` / `ui.*` **全属 `pi-coding-agent`**
（交互式终端宿主，本项目**未依赖**）。`interface ExtensionAPI` 唯一实现在
`coding-agent/src/core/extensions/types.ts`。

⇒ `docs/extensions.md` 是扩展面**全景**，**不是 agent-core 能力清单**。
我们的事件源本来就是 vendor 的 `harness.events.on`（`session-manager.ts` 的 `attachEvents`）。

`vendor/` 目录**禁止业务 patch**（只允许记录版本与来源），否则 upmerge 时无法与上游对齐。

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

## 系统地图

改之前先知道东西在哪、改哪层会走哪条流水线。**这一节的所有事实都经实测核实，改动时先复核。**

### 请求链路

```
浏览器 → nginx(:8888) → Nest apps/server(:5100) → pi-runtime(K3s NodePort 30100，外网不可达)
        → vendor pi(services/pi-runtime) → 上游模型
```

- `AGNES_MODEL_ID` 线上是**空串**（`??` 不兜底）⇒ LLM 实际靠 BYOK 注入
- 生产库是 **SQLite**；`/opt/lnkpi/.env` 是维护态止血开关（改 `PI_RUNTIME_MODE` + `compose up -d --force-recreate api`）
- **画布 SSOT 在前端**（`saveCanvas` 整份覆盖）；`add_node` 有**两份 applier 必须同步**
- 前端**无 CSP**（`nginx.conf` 无该头）⇒ iframe sandbox 配错没有第二道防线

### 四条流水线的触发面（改哪层走哪条）

| workflow | 触发条件 | 覆盖 |
|---|---|---|
| `ci.yml` | `push`(master) 走 paths-ignore；**`pull_request` 无任何 paths 过滤** | 全仓构建 + 测试 |
| `deploy.yml` | `push`(master) + paths 白名单：server / web / packages / deploy / prompt-registry / package.json / pnpm-lock / pnpm-workspace / .dockerignore / 自身 | api + web |
| `runtime-deploy.yml` | **纯 `workflow_dispatch`，无 push 触发** | pi-runtime |
| `prompt-lint.yml` | paths 触发：`prompt-registry/**`、`prompt-registry.*`、`prompt-lint.ts` | 提示词门禁 |

⚠️ **最容易踩的静默失败**：改 `services/pi-runtime/**`、`skills/**`、`vendor/**` 后 push 到 master，
`runtime-deploy.yml` **不会自动跑** —— CI 全绿但线上没有任何变化。
这三类改动合并后必须手工发一次，且 **tag = master 的 commit 短 SHA**（非语义版号）。

## 你的角色与边界

**关于「身份」的一句说明**：本文件不定义人格（沟通语气、主动性偏好）——那属于宿主层配置，
换模型/换宿主即失效且无法验证。这里只定义**你能做什么、什么必须先问人**，因为这部分与仓库强绑定。

### 必须先问人的红线

以下操作**一律先向人确认**，不要自行执行：

1. 动 `apps/server/prisma/schema.prisma` 或任何数据迁移
2. 动积分 / 扣分 / 退款逻辑
3. 改 `prompt-registry` 预算（L6 上限与当前余量见「变更影响面矩阵」）
4. 任何生产止血操作：改 `PI_RUNTIME_MODE`、改 helm values、重发镜像 tag
5. 向 master 直接提交

### 可自主决定的范围

以下可以自己决定，不必打断人：单文件改动、加测试、写文档、跑只读命令、
修 typo、改注释与格式化。前提是改动不触及上面的红线，且落在 DoD 的自检范围内。

### 越界信号

**「我不确定这条规则是否适用」⇒ 停下问，不要猜。**

这一条是本节最重要的。以下情形都适用它：
- 引用文档里的事实性数字前**先实测**（本文档不写会漂移的计数）
- 改动跨越了本文档没覆盖的层
- 需要绕过某条规则才能往下做

猜错的代价远高于问一句的代价。核实成本也就一条命令。

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

## 完成定义（提交前自检）

**全部是可执行命令，不是原则性表述。**

### 提交前必跑

| # | 命令 | 为什么 |
|---|---|---|
| 1 | `pnpm -r build` | **vitest 绿 ≠ tsc 绿**（esbuild 只转译）；web 走 `vue-tsc -b` |
| 2 | `pnpm test:server:changed` / `pnpm test:runtime` | 默认只跑变更相关；全量是 CI 的活 |
| 3 | 引用了文档里的事实性数字 ⇒ **先实测再写** | 见「越界信号」 |
| 4 | 改 `prompt-registry/**` ⇒ `pnpm prompt:lint` | 门禁独立于 `ci.yml` |
| 5 | 改 `AGENTS.md` ⇒ `pnpm verify-claims` | 机器校验本文档的事实性断言（计数 / 章节名 / workflow 名 / pin 版本），已接进 `ci.yml` 的 `Verify spec figures` step |
| 6 | 改 `vendor/` ⇒ 确认**零业务 patch** | 否则 upmerge 无法与上游对齐 |

### 合并前必看

- `gh pr view <n> --json mergeStateStatus` —— `BLOCKED` = required check 未过，**GitHub 不允许绕过**
- required checks = `["Verify spec figures", "Build monorepo", "Build API Docker image"]`
- ⚠️ **`Test Files N passed` ≠ CI 会绿**：必须同看 `Errors N errors` 与末尾 `Exit status`。
  实测出现过全量测试「文件数/用例数全 passed」但 `Errors` 非零、最终 exit 1 的情况
  （未处理 rejection 会被 vitest 单独计入 `Errors`）
- ⚠️ **CI 全量测试不在独立 job**：`pnpm test` 是 `Build monorepo` 内的一个 step，
  `gh pr checks` 看不到它，须下钻：
  `gh run view <id> --json jobs --jq '.jobs[].steps[]|"\(.name) :: \(.conclusion)"'`

### 合并后（上线验证）

- 改 pi-runtime / skills / vendor ⇒ **必须手工发 `runtime-deploy.yml`**（见「系统地图」）
- pi-runtime tag = master 的 commit 短 SHA
- 生产取证：curl 免鉴端点比数量/字符数，或容器内 `require(dist/...)` 读真值
- ⚠️ **别只看 workflow 绿了就assume 已上线**

## PR 规范

四个**必填项**，缺任一项评审人有权打回。模板见 `.github/pull_request_template.md`。

| 项 | 要求 | 拦的是什么 |
|---|---|---|
| **变更动机** | 解决什么问题，一两句 | 防止「顺手改」混入 |
| **影响面** | 哪几层 / 哪几个端点 / 是否改提示词或工具分层 | 评审人不知道该看哪 |
| **验证证据** | 跑了什么命令、看到什么输出 | 防止「跑过了」当证据 |
| **是否需手工发 runtime 流水线** | 是 / 否 + tag | 防止「CI 绿了但没上线」的静默失败 |

## 本机环境

```bash
export PATH="/usr/local/bin:$PATH"   # gh 在 /usr/local/bin，不在默认 PATH
```

- **本机是 4 核 Mac，多 agent 并存** —— 跑全量测试前先看 `uptime`，别互相拖慢
- `ps` 在沙箱环境 `operation not permitted`，查进程用 `lsof`
- 主仓 `/Users/4seven/workspace/pi-lnk`；worktree 在 `.worktrees/<slug>/`