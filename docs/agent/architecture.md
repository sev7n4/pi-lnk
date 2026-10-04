# 架构与内核规范

pi 内核版本 · pi-runtime 开发纪律 · 仓库结构 · 端口约定。

> 属于 [`AGENTS.md`](../../AGENTS.md) 规范体系的一部分。主文件见「系统地图」与「变更影响面矩阵」。

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

依据：[ADR-0009](../../docs/adr/0009-vendor-capability-first.md)。
现状清单：[`services/pi-runtime/DEPENDENCIES.md`](../../services/pi-runtime/DEPENDENCIES.md)。

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

升级流程见本文件「pi 内核版本」节。回归按此顺序：

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
