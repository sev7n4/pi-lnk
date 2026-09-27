# 两产品线边界测绘（2026-09-28）

- **状态**：测绘完成，待用户裁决拆仓路径
- **范围**：只测绘、**不拆仓、不改代码**
- **来源**：`packages/*/package.json` 依赖边 + 目录规模 + 跨模块 import 实测 grep
- **关系**：给「画布产品线 vs agent 产品线拆分」提供决策依据；不含实现

## 0. 配图索引

本文档不含图（依赖方向与归属用表格表达，无状态机/拓扑需要图示）。

## 1. 结论摘要

| 结论 | 说明 |
|---|---|
| ✅ `services/pi-runtime` **已经是独立产品线的种子** | 208K，**零 workspace 依赖**，独立服务、独立部署。拆它成本最低 |
| ✅ server 侧依赖方向**单向且健康** | `agent` → `canvas`/`studio`，反向零依赖 |
| ⚠️ `packages/agent` **名不副实，混了画布领域逻辑** | `applyCanvasActions(CanvasData, ...)`、`prompt-modes/`(176K)、`studio/`(76K) 都不是 agent loop |
| 🔴 web 侧 agent UI **焊死在画布 dock 上** | `components/agent` 反向依赖 6+ 个 canvas dock 组件（单向、且是**错误方向**） |
| 🔴 `packages/shared` 是**混合大包** | `canvas/`(252K) 与 agent 契约混在一个 barrel，拆哪边都要先劈开它 |

**一句话**：拆仓的难点不在 pi-runtime（已独立），而在 **`packages/agent` 的职责错位** 与 **web 侧 agent UI 对 canvas dock 的反向依赖**。

## 2. 包级依赖边（实测）

| 包 | 规模 | 依赖的内部包 | 归属判定 |
|---|---|---|---|
| `@lnkpi/shared` | 660K | 无（叶子） | **需劈开**：`canvas/`(252K) 归画布，agent 契约/refs 归 agent |
| `@lnkpi/agent` | 480K | → shared | **需劈开**：executor/prompt-modes/studio 归画布，refs/类型归 agent |
| `@pi-lnk/pi-runtime` | 208K | **无** | ✅ **agent 产品线**（已独立） |
| `@lnkpi/web` | 3.2M | → agent, shared | **需劈开** |
| `@lnkpi/server` | 1.7M | → agent, shared | **需劈开** |

## 3. 目录级归属划分

### 3.1 apps/server/src

| 目录 | 规模 | 归属 | 备注 |
|---|---|---|---|
| `agent/` | 608K | **agent** | 但内部深度依赖 canvas/studio（见 §4.2） |
| `studio/` | 332K | 画布 | 生成能力（图/视频/切片） |
| `provider/` | 136K | 共享 | 上游渠道 |
| `canvas/` | 136K | 画布 | 实体服务（material/shot） |
| `points/`、`media/`、`auth/`、`assets/`、`storage/`、`membership/`、`upload/` | ~340K | 平台/共享 | 账号、积分、存储等通用能力 |

### 3.2 apps/web/src/components

| 目录 | 规模 | 归属 | 备注 |
|---|---|---|---|
| `canvas/` | 1.3M | **画布** | 含 `dock-studio/shared/`（agent UI 复用的控件来源） |
| `agent/` | 516K | **agent** | 反向依赖 canvas dock 控件（见 §4.1） |
| `usage/`、`auth/`、`media/`、`workflow/`、`account/`、`works/`、`membership/` | ~192K | 平台/共享 | |

### 3.3 packages/agent/src（⚠️ 职责错位最集中处）

| 目录 | 规模 | 实际归属 | 说明 |
|---|---|---|---|
| `tools/executor.ts` | — | **画布** | `applyCanvasActions(data: CanvasData, actions: CanvasAction[]): CanvasData` —— 纯画布领域逻辑，却放在 agent 包 |
| `prompt-modes/` | 176K | **画布/生成** | 生图提示词模式，与 agent loop 无关 |
| `studio/` | 76K | 画布 | |
| `refs/` | 60K | agent | 引用解析，可归 agent |
| `types.ts` | 4K | 混合 | 同时 import `CanvasAction`/`CanvasData`/`Shot` |

## 4. 跨边界依赖清单（实测 grep）

### 4.1 web：agent → canvas（🔴 6+ 条，错误方向）

`apps/web/src/components/agent/` 直接 import canvas dock 控件：

| 文件 | 依赖的 canvas 组件 |
|---|---|
| `AgentSideRail.vue` | `DockGenerateButton`、`DockMicButton`、`MentionInput`、`UniversalModelSelector` |
| `AgentSidebarRefChip.vue` | `DockTypeIcon`、`dockIcons`（类型） |
| `AgentCanvasOutputs.vue` | `DockTypeIcon` |

反向（`canvas/` → `agent/`）仅 **1 条**：`dock-studio/shared/DockRefChip.vue` → `AgentRefHoverPreview.vue`。

**结论**：agent 面板是被**嵌入画布 dock** 渲染的，并复用 dock 的按钮/图标/输入控件。
这是拆仓的最大结构障碍——要么把这些控件下沉为共享 UI 包，要么 agent 产品线自己重新实现一套。

### 4.2 server：agent → canvas/studio（✅ 单向，方向正确）

`apps/server/src/agent/` 依赖：

- `../canvas/material.service`、`../canvas/shot.service`、`../canvas/canvas.module`
- `../studio/studio.service`、`../studio/image-slice.service`、`../studio/video-generation.orchestrator`

反向（`src/canvas/` → `src/agent/`）**零命中**。

**结论**：server 侧方向干净——agent 是画布领域之上的编排层。拆的时候 agent 侧需要**通过接口/客户端**调用画布能力，
不能像现在这样直接 import。

## 5. 三条拆仓路径

| 路径 | 做法 | 成本 | 风险 | 建议 |
|---|---|---|---|---|
| **A. 先劈 shared/agent，再谈拆仓** | 把 `shared` 劈成 `shared-core`/`shared-canvas`；把 `packages/agent` 的 executor/prompt-modes/studio 移出到画布侧 | 中（1–2 天） | 低——纯搬运 + 改 import，可逐个 PR 验证 | ⭐ **建议默认** |
| **B. 直接物理拆成两个仓库** | `git filter-repo` 拆目录 + 各自建仓 | 高（数天） | **高**——web 侧 6+ 反向依赖要先解；不可逆 | 不建议现在做 |
| **C. 只把 pi-runtime 独立出去** | `services/pi-runtime` 单独成仓（它本来就零 workspace 依赖） | **低（数小时）** | **极低** | ⭐ 可**立刻**做，与 A 并行 |

**推荐组合**：**C 立刻做（几乎零风险）+ A 作为主线推进**，等 A 完成后 B 自然水到渠成。

### 5.1 C 的第一步：独立边界守卫（2026-09-28 已落地）

`services/pi-runtime/src/independence.test.ts`——两条 CI 守卫：

1. 源码不得 import 任何外部 workspace 包（`@lnkpi/{agent,shared,server,web}`、`@pi-lnk/pi-poc`）
2. `package.json` 不得声明外部 workspace 依赖

理由：**「现在独立」不等于「将来独立」**。物理拆仓前的等待期里，只要有人在 pi-runtime 里 import 一次
`@lnkpi/shared`，这颗种子就被焊死在 monorepo 上，将来又要重新劈一遍。守卫把已有的独立性固化成
可执行约束，成本≈0，且完全可逆（删文件即可）。

已做负向验证：临时注入 `import type { Foo } from "@lnkpi/shared"` 后测试 fail 1，确认守卫不是摆设。

⚠️ **守卫不是拆仓本身**。`services/pi-runtime` 仍在 monorepo 内、仍由本仓库 CI 构建、helm chart 仍在本仓库。
真正独立成仓（含独立 CI / 发布流）尚未开始，需先裁决 §6 的三个开放问题。

## 6. 开放问题（需你裁决）

1. **`packages/agent` 里的 `applyCanvasActions` 到底算谁的？** 它是画布领域逻辑，但被 `agent.service.ts` 用来落地动作。
   若 agent 产品线不需要画布，这块应搬到画布侧；若未来 agent 产品线也有自己的"执行结果落地"，则应抽象成接口。
2. **web 侧 dock 控件是否下沉为共享 UI 包？** `DockTypeIcon`/`DockGenerateButton`/`MentionInput`/`UniversalModelSelector`
   被 agent 复用。下沉 = 多一个共享包；不沉 = agent 产品线自己重写 UI。
3. ~~**`shared` 劈开后 agent 产品线是否还需要 `NodeType`？**~~ → **已裁决并订正（2026-09-28）**：`NodeType` 补入 `audio`，
   与 `NODE_TYPES` 重新对齐；剩余 3 类有意不支持（见 §7）。归属问题随 path A 推进时再定。

## 7. 附注：测绘中发现的既有缺口（与拆仓独立）

`extractCanvasActions` 的 `NODE_TYPES` 白名单照抄 `NodeType`（7 个：prompt/image/video/text/group/shot/sceneComposer），
而画布实际可创建的节点类型有 11 个（`DockNodeType` 另含 `audio` / `mediaInput` / `videoComposition` / `worldModel`）
→ 这 4 类画布动作会被**静默丢弃**。

**2026-09-28 已裁决**（用户定夺）：

- ✅ **补入 `audio`** —— 画布确实可创建音频节点，且 shared 侧多处已按 audio 处理
  （`selectionBatchGenerate` 的 `SUPPORTED_TYPES`、`nodeRefs` 的 `RefMediaType`、`studioModelCatalog` 音频模型），
  之前只是白名单漏了。同步改了两处 SSOT：`agentContract.ts` 的 `NODE_TYPES` 与 `index.ts` 的 `NodeType`。
- ⏸ **`mediaInput` / `videoComposition` / `worldModel` 有意不支持** —— 当前无实际需求（项目未商业化、无对应流量），
  等出现实际需求时再补。已加回归测试锁定「这三类仍被丢弃」，防止将来被误放宽。
- ❌ 不做丢弃计数观测 —— 原提议「先加计数跑一周看数据」在无商业流量的前提下没有意义，已取消。
