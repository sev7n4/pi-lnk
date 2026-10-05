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
