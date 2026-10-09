# PI-Lnk 项目 Agent 开发规范

> **本文件是 agent 在本仓库工作的入口规范**，只放「任何时候都要看得见」的内容：
> 项目目标、角色边界、系统地图、变更影响面矩阵、完成定义。
> 改动本文件时，**每条陈述都要回代码核实，不要凭印象写**。

## 规范体系结构

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| **`AGENTS.md`（本文件）** | 项目目标 · 角色与边界 · 系统地图 · 变更影响面矩阵 · 完成定义 | **每次会话都读** |
| [`docs/agent/delivery.md`](./docs/agent/delivery.md) | 分支纪律 · 本地测试纪律 · 必须先做的事 · skill 路由 · PR 规范 | 要提交、开 PR、跑测试时 |
| [`docs/agent/architecture.md`](./docs/agent/architecture.md) | pi 内核版本 · pi-runtime 开发纪律 · 仓库结构 · 端口约定 | 动 vendor / pi-runtime / 部署配置时 |
| [`docs/agent/docs.md`](./docs/agent/docs.md) | 文档管理规范（去哪写、引用怎么处理、归档vs 删除） | 加删文档时 |
| [`docs/agent/environment.md`](./docs/agent/environment.md) | 本机环境（PATH、gh 位置、4 核限制） | 跑命令、排查环境问题时 |

⚠️ **引用契约**：`分支纪律` / `文档管理规范` / `pi 内核版本` / `端口约定` 这几个章节名
被 ADR-0001 / 0008 / 0009 与 `charts/pi-lnk-runtime/README.md` 按名引用。
**改这些章节名必须同步改引用方**，否则静默断链。`pnpm verify-claims` 会校验这一点
（判据 2 扫的是**整个规范体系**，不只是本文件 —— 所以下沉到 `docs/agent/` 也算在位）。

## 项目目标

**打造以 `pi-agent-core` 为内核的 canvas agent，驱动画布的超创平台 lnk π。**

- 内核：`@earendil-works/pi-agent-core`（版本见 [`docs/agent/architecture.md`](./docs/agent/architecture.md)）
- 载体：画布（canvas）—— agent 的产出物是可交互的图，而非纯文本流
- 方向：视觉内容的生产与迭代（分镜 / 电商素材 / 角色与场景等），skills 资产在 `skills/`
- **交互契约**：画布**选中 = agent 的默认指代** —— 用户说「这个 / 这几个」时默认指当前选中对象；**指代 ≠ 授权**（写操作仍走确认门），**指代 ≠ 素材注入**（不自动进芯片，M3 D-A 保持）。规格见 [`docs/superpowers/specs/2026-10-06-selection-as-default-reference-design.md`](./docs/superpowers/specs/2026-10-06-selection-as-default-reference-design.md)（已拍板，实现待排期）

## 变更影响面矩阵

**改什么会静默坏掉。** 下表是踩过的坑，每一行都在生产或 PR 里付出过代价。

### 改提示词规则 ⇒ 同步 6 处，漏一处就静默

| # | 位置 | 漏掉的后果 |
|---|---|---|
| 1 | `prompt-registry/rules/<id>.md` | 规则不存在 |
| 2 | `prompt-registry/MANIFEST.yaml`（`contentHash` = `sha256(body.trimEnd())` 前 12 位；`version` 两处一致） | 完整性校验失败 |
| 3 | `prompt-registry.loader.ts` 的 `COMPOSED_IDS` | 不参与组合 |
| 4 | `prompt-registry.loader.ts` 的 `FALLBACK_BY_ID` 映射（仅此一处定义） | 降级路径与实际规则不一致 |
| 5 | 🔴 `prompt-registry.fallback.ts` 的**内嵌规则常量**（`CORE_RULES_PREFIX` / `MEMORY_SCOPE_RULES` / `WRITE_TOOLS_RULES` / `GEN_TOOLS_RULES` / `CANVAS_VIEW_POLICY` / `CANVAS_DAILY_OPS` …） | registry 加载失败时走降级路径（`renderStaticFallback`），**提示词与磁盘规则不一致，且无任何报错** |
| 6 | 🟡 `pi-prompt-assembler.service.test.ts` 的 `EXPECTED` 硬编码串 | 测试假绿 |

**同步判据**：`prompt-registry.loader.ts` 的 `renderStatic()`（读磁盘）== 内嵌 fallback 常量按 `FALLBACK_BY_ID` 组合的结果，**逐字符相等**。
**已机检**：由 `pnpm prompt-lint` 执行（独立流水线 `prompt-lint.yml`）——
`prompt-registry.loader.ts` 的 **L7** 校验逐条比对「磁盘 body == 内嵌常量」，不一致即 exit 1。
变异实测：把 `prompt-registry.fallback.ts` 里一个字改掉（`focus_nodes`→`focus_node`）⇒ 报
「canvas_daily_ops.md 的 body 与常量不一致」+ 退出码 1。**所以第 5 处不是"靠自觉"，别再当它没人管。**

⚠️ **降级路径的函数与常量是两回事，别只改一半**：
`renderStaticFallback()` **定义在 `prompt-registry.loader.ts:255`**（不是 assembler），
它**组合的是 `prompt-registry.fallback.ts` 里的内嵌常量**；
`pi-prompt-assembler.service.ts:136` 在 `snapshot.degraded` 时才调它（`agent.controller.ts:267` 同）。
⇒ 改规则正文要同时改**磁盘 .md** 和**内嵌常量**；只改一边 ⇒ 降级路径与正常路径给出不同提示词。

🔴 **本节曾被一个错误的"符号已不存在"结论带偏过一次（2026-10-06 当天修正）**：
当时的取证写法是 `git show $R:apps/…/loader.ts | grep -c <符号>`，返回 0，于是把第 5 处判成"失效指针"并写进了本文件。

**真因不是 grep，是 zsh 的参数修饰符**（已复现 33/33 次，可稳定重现）：

```zsh
R=c69d3fa4
echo $R:apps     # → /Users/…/c69d3fa4pps   ← `:a` 被当成「绝对路径」修饰符，apps 的 a 被吃掉
echo ${R}:apps   # → c69d3fa4:apps        ✅ 正确
```

⇒ git 收到的是一个不存在的路径 → `fatal: ambiguous argument …` → **stderr 被 `2>/dev/null` 吞掉** →
stdout 为空 → `grep -c` 输出 0 ⇒ 看起来"符号不存在"，实际是**命令拼错了**。
**正确写法：`git show ${REV}:<path>`（变量必须加花括号）。**

⇒ 该符号（`renderStaticFallback`）从 #114 起**从未消失**，用 pickaxe 可验：
`git log -S "renderStaticFallback" -- …/prompt-registry.loader.ts` 只有一条（引入）记录。

**留给自己的三条判据**：
1. 判「不存在」时，**先看命令有没有报 fatal**（别用 `2>/dev/null` 吞掉），再落盘复核一次；
2. **凡写进规范的工具故障断言，必须同处给出可复现命令**（由 `verify-claims` 判据 6 守）；
3. zsh 里**变量紧跟冒号**一律加花括号（`${R}:…`）—— 这是本仓最容易复发的静默失败形态。
⚠️ `FALLBACK_BY_ID` 只在 loader 定义（`:112`），`prompt-registry.fallback.ts` 里没有同名符号 ——
它靠**内容逐字相等**被约束，不是靠常量名对齐。
⚠️ 搜索时**别让命令错误伪装成"查不到"**：`2>/dev/null` 会把 `fatal:` 一起吞掉，
于是一个拼错的路径和一个真实缺失长得一模一样。历史教训见上面第 5 处的红框。
大范围扫描（如全仓 python 遍历）会超时（exit 137），此时缩小范围或用 `git grep -n -- <符号> -- <目录>`。

改完跑 `pnpm prompt:lint`（独立成 `prompt-lint.yml` 流水线，`ci.yml` 不覆盖它）。

⚠️ **L6 预算上限 3200 字符**：最紧组合 `core+writeTools+genTools+todoTools` 实测 **3197** ⇒ **余量 3 字符**
（权威值见 `prompt-registry/PROMPT_SPEC.md` §5 budget-table，由 `scripts/gen-prompt-spec-map.ts` 机器生成、`--check` CI 守卫；本行手工同步，以 PROMPT_SPEC.md 为准，别按本行数字排期）。
`pnpm prompt:lint` 会打印实测值并对超预警线（2720 = 85%）给 warning。加规则前先跑它看余量，别按旧数字排期。

### 改工具分层 ⇒ 必答「哪个资产点名了它」

**新增工具默认进延迟集前，必须回答：`prompt-registry` 规则或 `skills/*.md` 里，哪个资产按名字点名了它？**
答不上来按「未点名」处理 ⇒ 必须常驻。

机理：`drive/tools.ts:686` 只把 `activeToolNames` 传给 `prepareToolCall`，
未激活的工具吃 vendor 硬编码的 `Tool X is unavailable`，**没有恢复路径**。

生产证据（PR #100）：40 次工具调用全落常驻集，`tool_search_activated_total` 为 0
⇒ 官方 Dynamic Tool Loading 触发率至今为 0。

⚠️ 已因此回归常驻：`arrange_nodes` / `set_node_generation_params` / `save_memory` / `focus_node` / `remove_edges`。
**`focus_node`（单数）≠ `focus_nodes`（复数）** —— 只差一个字母，极易踩错；
⚠️ **2026-10-06 起两者都常驻**（#216）：`canvas_daily_ops` 第 19 条点名的是**复数版**，
此前按「未被 skill 点名」把它留在延迟集 —— **判据漏了 prompt 规则这一侧**。

新增或变更工具须在 `services/pi-runtime/src/tools/tiering.test.ts` 显式声明归属。
完整四列登记（47 工具 × 点名资产 × 归属 × 触发话术）与可重跑扫描命令见
[`docs/agent/tool-capability-catalog.md`](./docs/agent/tool-capability-catalog.md)。

#### ⛔ 下沉常驻集的前置条件（2026-10-06 拍板）

`tool_search` 触发率至今为 0 ⇒ **现在下沉任何工具 = 功能直接不可达**
（尤其 `run_*`：用户点了确认却出不了图，是严重回归）。**顺序不能反**：

1. 在 skill 里补「工具不在你的列表里 ⇒ 先 `tool_search` 关键词」的线索；
2. 生产验证 `pi_runtime_tool_search_calls_total{outcome="hit"}` **首条出现**；
3. 才批量下沉（常驻 36→≤28 的目标记在 `tool-framework-roadmap.html` §4 P1）。

⚠️ 数据现状：常驻集里**零下发点名的只有 2 个**（`run_text_generation` / `run_prompt_generation`，
属 `tiering.ts` 的有意豁免）⇒ **只靠下沉到不了 28**，必须先减点名或把 skill 点名降级为中风险。

#### `skills/*.md` 的归属：段落级（2026-10-06 拍板）

| 层 | 归谁 | 约束 |
|---|---|---|
| 正文（垂类流程 / 步骤 / 话术） | **R1**（提示词工程线） | — |
| 尾部固定小节 `## 工具可用性`（「工具不在列表里先 `tool_search`」线索） | **R5**（工具框架线） | R1 改正文时**保留该小节**；R5 只追加/更新该小节 |

同文件不同段落 ⇒ git 冲突面小。⚠️ 改 `skills/**` 同样要手工 dispatch `runtime-deploy`（tag = master 短 SHA）。

### 改 vendor 消费 ⇒ 认清层次边界

`pi.on` / `pi.registerTool` / `registerCommand` / `ui.*` **全属 `pi-coding-agent`**
（交互式终端宿主，本项目**未依赖**）。`interface ExtensionAPI` 唯一实现在
`vendor/earendil-works/pi/packages/coding-agent/src/core/extensions/types.ts`
（原先此处只写了包内简路径「coding-agent / src / core / extensions / types.ts」—— 那种写法在仓库根定位不到，
2026-10-06 由新增的判据 7 抓出并改为上面的完整路径）。

⇒ `docs/extensions.md` 是扩展面**全景**，**不是 agent-core 能力清单**。
我们的事件源本来就是 vendor 的 `harness.events.on`（`session-manager.ts` 的 `attachEvents`）。

`vendor/` 目录**禁止业务 patch**（只允许记录版本与来源），否则 upmerge 时无法与上游对齐。

**升版前必跑 `pnpm verify-tool-contract`**（已接进 `ci.yml` 的 `Verify spec figures`）。
上游是 0.x、**没有 semver 兜底**，而 4 个 hook（`before_tool` / `after_tool` /
`transform_context` / `before_payload`）是靠**运行时读字段**消费的：上游把
`event.toolName` 之类的字段改名或删掉，消费方不会报错，只会静默 fail-soft
（功能悄悄没了，指标也看不出来）。该脚本比对 vendored HookMap 与我们实际依赖的
字段集合，漂移即 exit 1。自由形态字段（`details` / `args` / `payload`）的形态守卫
在 `services/pi-runtime/src/hook-contract.ts`——**不要用 `as` 强转后直接取属性**，
`{ ...payload }` 在 payload 为 null / 字符串时会静默产出残缺对象。

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
| `observability-watchdog.yml` | **`schedule`（每 30 分钟）+ `workflow_dispatch`，无 push 触发** | 观测巡检断言（须 SSH 进 CVM 跑，Prometheus 只在 NodePort 内网可达） |

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
