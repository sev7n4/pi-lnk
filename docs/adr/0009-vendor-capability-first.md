# ADR-0009: pi-runtime 开发必须先查 vendor 能力面，禁止自研等价物

| 字段 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-10-03 |
| 决策者 | 项目发起人 |

## 背景

项目目标（见 `AGENTS.md`）是**以pi-agent-core 为内核驱动画布**。
选了 vendor + pin 的路线（ADR-0001），但"选了vendor"不等于"用上了vendor"。

2026-10-03 实测：`vendor/earendil-works/pi/packages/` 下有 **11 个子包**，
而 `services/pi-runtime` 只import 了 **2 个**：

| 已用 | `pi-agent-core`（14 处）、`pi-ai`（2 处） |
|---|---|
| **未用** | `pi-client`、`pi-chord`、`pi-coding-agent`、`pi-protocol`、`pi-server`、`pi-session-backends`、`pi-telemetry`、`pi-tui`、`pi-evals`、`chord` |

而 vendor 明确提供了扩展面文档
（`vendor/earendil-works/pi/packages/coding-agent/docs/extensions.md`），
覆盖 Events（Lifecycle/Resource/Session/Agent/Model/Tool/Input）、
ExtensionContext（`compact`/`fork`/`getSystemPrompt`/`getContextUsage`/`isIdle` 等）、
ExtensionAPI（`registerTool`/`sendMessage`/`appendEntry` 等）。

**"没吃满"已经有真实代价**（三个已合并 PR 的标题就是证据）：

| PR | 教训 |
|---|---|
| #100 | 自研"索引块 + load_tools"方案**在生产失败**（0.0.29/0.0.30 E2E：弱模型无视引导直调延迟工具，吃vendor 硬编码的 `Tool X is unavailable` 且无恢复路径）⇒ 改为对齐官方 Dynamic Tool Loading |
| #104 | steering 与 followUp 两种队列模式**没接**，是"吃满 pi-agent"的一部分 |
| #29 | dock 技能与 pi-runtime **真实安装列表不对齐** —— 技能资产与内核能力脱节 |

还有一个隐性代价：**自研等价物会制造 upmerge 负担**。vendor 目录禁止业务 patch（ADR-0001），
但 host 侧自研的绕行逻辑（如自己造索引块）会在 vendor 升级时变成技术债——
要么继续维护，要么推倒重来，而 vendor 官方能力可能已经解决了。

## 考虑过的方案

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| 想到什么做什么（现状） | 灵活 | 重复造轮子、漏洞百出、upmerge 负债 | ❌ |
| **强制先查 vendor 能力面再动手**（选中） | 复用官方能力、upmerge 成本低 | 需要每次多查一步 | ✅ |
| 全部自研，不 vendor | 完全可控 | 放弃pi 生态的全部演进红利 | ❌ |

## 决定

1. **动手前必须先查 vendor 能力面**，优先级：
   - `vendor/earendil-works/pi/packages/coding-agent/docs/extensions.md`（扩展面全景，含 Events / Context / API）
   - `vendor/earendil-works/pi/VENDORED.md`（版本与 pin 纪律）
   - **代码搜索**：`git grep -n "<能力关键词>" -- vendor/earendil-works/pi/packages/`
2. **发现"我们要的能力 vendor 已有"→ 必须用 vendor 的，不许自研等价物。**
   自研前必须在 PR 里说明：**vendor 有什么 / 为什么不能用**。
3. **vendor 没有 → 才自研**，且要：
   - 隔离在 host 侧（不 patch vendor，见 ADR-0001）
   - 记录为技术债，注明"若vendor 后续提供则应替换"
4. **吃满的判定标准是可测的**：`vendor` 里 11 个子包，逐个确认"用不上"或"用得上且已用"，
   说不清的就是欠账，写进 PR 描述。
5. **升级 vendor 时**（`VENDORED.md` 记录理由 + 走七步流程）：
   **重点回归"我们自研的绕行逻辑"** —— 那些是升级时最可能被官方能力取代的地方。
6. **能力清单要进索引**：新增"用了什么/没用什么"的记录，避免半年后自己也说不清。

## 后果

**正面**
- 避免重复造轮子（#100 的教训直接省下一次返工）
- upmerge 时自研绕行逻辑更少、负债更可控
- 能力清单化，"吃满"从口号变成可核对的清单
- 升级 vendor 时有明确的回归重点

**负面 / 代价** ❗
- **每次开发多查一步**，前期会变慢
- `extensions.md` 是 coding-agent 的文档，而我们跑在自定义 host 上——
  **不能假设文档里的每样东西在 host 里都能直接用**，要验证
- 目前 9 个子包没用上，其中 `pi-tui`/`pi-client` 可能是**我们场景不需要**（非吃不满），
  也可能是真欠账 —— 需要逐个确认，这是待办

**将来要注意**
- 若某个未用子包确认不需要用，把理由写进 `pi-runtime/DEPENDENCIES.md`，**别让"未用"变成想不起来为什么**
- 出现"host绕行 vendor 缺陷"时，先确认是 vendor 真缺能力，还是**我们没正确用它**

## 关联

- [ADR-0001](./0001-vendor-pi-as-kernel.md) —— vendor + pin + 禁业务 patch 的路线选择
- [ADR-0005](./0005-tool-tiering-official-dynamic-loading.md) —— 本决策的**第一个实证案例**
- 规范落地：`AGENTS.md`「pi 内核开发纪律」节
- 扩展面全景：`vendor/earendil-works/pi/packages/coding-agent/docs/extensions.md`
- 吃满设计：`docs/superpowers/specs/2026-10-02-pi-runtime-capability-fullfillment-design.md`（T1-T4）
