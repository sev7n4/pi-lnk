# docs 目录说明

整理于 2026-10-03，2026-10-04 补提示词审计报告登记，2026-10-07 更正 `superpowers/` 索引的维护方式（改为走生成器）。

## 根目录的两份提示词工程审计报告

| 文件 | 内容 | 性质 |
|---|---|---|
| `2026-10-02-prompt-engineering-audit.html` | **Round 1 · 现状审视**：16 条缺口（P0×4 / P1×6 / P2×6）+ 五窗口路线图。基线 `0593c3d` | 活资产 —— 缺口清单仍是唯一一份完整 P0/P1/P2 分级 |
| `2026-10-02-prompt-engineering-audit-round2.html` | **Round 2 · 重构路线**：Round 1 每条建议 × vendor 能力对照（现成/半/未用三档）+方案 A/B/C + W1–W8 路线图。基线 `d574b8b` | 活资产 —— 唯一一份「哪条能吃 vendor、哪条要自建」的取证 |

配套的**进展对账**见
[`superpowers/plans/2026-10-04-prompt-audit-gap-status.md`](./superpowers/plans/2026-10-04-prompt-audit-gap-status.md)
—— 16 条缺口逐条对到 `origin/master 006af0a` 的代码事实。

⚠️ **这两份 HTML 曾一度丢失**：它们原本是未跟踪文件，一次 `git stash -u` 把它打进
`d31f739`（stash commit）后该 stash 被 drop，文件从工作区与 master 双双消失，
只存在于悬空对象里，靠 `git fsck --lost-found` 才捞回。2026-10-04 已恢复为 tracked。
**教训：审计报告这类"结论资产"必须入库，不能只放工作区。**

## Agent 工程规范（2026-10-04 整改）

| 文件 | 内容 | 性质 |
|---|---|---|
| [`../AGENTS.md`](../AGENTS.md) | **agent 在本仓库工作的唯一权威规范** —— 新增系统地图、角色边界、变更影响面矩阵、完成定义（DoD）、PR 规范 5 节；纠正 CI 触发面描述错误；计数改为可实测获取 | 活资产 —— **每次改动需回代码核实** |
| [`superpowers/specs/2026-10-04-agents-md-hardening-design.md`](./superpowers/specs/2026-10-04-agents-md-hardening-design.md) | 本次整改的设计规格（含身份三层归属的决策依据） | 活资产 |
| [`superpowers/plans/2026-10-04-agents-md-hardening.md`](./superpowers/plans/2026-10-04-agents-md-hardening.md) | 实施计划 | 活资产 |
| [`link-audit-2026-10-04.html`](./link-audit-2026-10-04.html) | **Markdown 断链审计报告** —— 全仓 583 个 md，原始命中 604 条 ⇒ 真断链 14 条（已修 4 / 登记 19），含噪音收敛规则与门禁设计 | 活资产 —— 数字可用 `pnpm verify-links` 重跑核对 |
| [`agents-md-review-2026-10-04.html`](./agents-md-review-2026-10-04.html) | AGENTS.md 评审报告（7 维度评分 + P0/P1/P2 问题清单），基线 `352b44f` | 活资产 —— **结论资产，已入库** |

⚠️ **本节的存在理由**：同目录的两份提示词审计 HTML 曾一度丢失（未跟踪文件被 `git stash -u`
打进 stash 后该 stash 被 drop），只存在于悬空对象里，靠 `git fsck --lost-found` 捞回。
**审计/评审报告这类"结论资产"必须入库，不能只放工作区。** 本次评审报告从创建起即为tracked。

⚠️ **外部引用契约**：规范体系（`AGENTS.md` + `docs/agent/*.md`）里的以下章节名
被 ADR 与 charts README 按名引用，**改动时必须保持标题文本不变**
（注意部分标题含 emoji 与副标题，如 `## ⭐ 分支纪律（最高优先级）`）：

| 章节名 | 所在文件 | 引用方 |
|---|---|---|
| `pi 内核版本` / `pi-runtime 开发纪律` / `端口约定` | `docs/agent/architecture.md` | `adr/0001`、`adr/0009`、`charts/pi-lnk-runtime/README.md` |
| `文档管理规范` | `docs/agent/docs.md` | `adr/0008`（2 处） |
| `分支纪律` / `仓库结构` / `必须先做的事` / `核心 skill 路由` / `本机环境` | `docs/agent/*.md` | `docs/adr/README.md` 等 |
| `系统地图` / `你的角色与边界` / `变更影响面矩阵` / `完成定义` / `PR 规范` | `AGENTS.md` | — |

`pnpm verify-claims` 的判据 2 校验这一点，**扫的是整个规范体系**（主文件 +
`docs/agent/*.md`），所以章节下沉后仍算在位 —— 这是拆分后刻意保持的护栏。

> 2026-10-04 拆分前，这些章节全部在 `AGENTS.md` 单文件里（526 行）。
> 拆分是为了让主文件只留「任何上下文都要看得见」的内容。

## 产品交互契约（2026-10-06 起）

产品级交互契约的权威来源。与 `docs/agent/*.md`（**工程**规范）分工不同：那里管"agent 在本仓库怎么干活"，这里管"**产品里的 agent 怎么跟用户交互**"。

| 文件 | 内容 | 性质 |
|---|---|---|
| [`superpowers/specs/2026-10-06-selection-as-default-reference-design.md`](./superpowers/specs/2026-10-06-selection-as-default-reference-design.md) | **画布选中 = Agent 默认指代**（代号 SEL-REF）—— 产品定义 + 落地规格。承接 M3 的 D-B，并显式划清「指代 ≠ 素材注入」「指代 ≠ 授权」 | 活资产 —— 产品级交互契约 |
| [`superpowers/plans/2026-10-06-selection-as-default-reference.md`](./superpowers/plans/2026-10-06-selection-as-default-reference.md) | **SEL-REF 实施计划** —— 6 个 task（纯函数 / kind 登记 / 契约 / Nest 拼装 / 前端回执 / 上线验收），逐 task 带 TDD 步骤、Review Focus 与回滚顺序 | 活资产 —— 实现依据 |
| [`superpowers/specs/2026-10-06-propose-confirm-deterministic-design.md`](./superpowers/specs/2026-10-06-propose-confirm-deterministic-design.md) | **propose 确认的确定性信号** —— 事故复核（点生成被判成取消）+ 确认/取消/超时/中止各自的权威信号表 + L1/L2 落点与回滚 | 活资产 —— 产品级交互契约 |
| [`superpowers/specs/2026-10-06-audio-node-unified-capability-design.md`](./superpowers/specs/2026-10-06-audio-node-unified-capability-design.md) | **音频节点统一创作能力**——顶层模态不变（图/文/音/视频），音频节点内部分 `voice / design / music` 三类；agent 按需求自主选分类、填参数、产出音频。含平台级 StepFun 通道（阶段 0）与 gen→music 优先顺序 | 活资产 —— 已复核，实施中 |
| [`superpowers/plans/2026-10-06-audio-node-unified-capability.md`](./superpowers/plans/2026-10-06-audio-node-unified-capability.md) | **音频节点统一创作能力实施计划** —— 11 个 task（平台 StepFun 通道 / AudioKind 元数据 / resolver 分流 / design 同步 / music 异步 / 工具扩展 / 前端三分类 / 治理同步 / 验收），逐 task 带 TDD 步骤、Review Focus 与回滚顺序 | 活资产 —— 实现依据 |

> 该规格**不新增 agent 工具**（走每轮动态上下文），因此不阻塞
> `agent/tool-framework-roadmap.html` §4 P1 的常驻集下沉。

## 保留的目录

| 目录 | 内容 | 性质 |
|---|---|---|
| `agent/` | **agent 规范专题文件**（2026-10-04 从 `AGENTS.md` 拆出）—— `delivery.md` 交付流程 / `architecture.md` 架构与内核 / `docs.md` 文档管理 / `environment.md` 本机环境。主文件 `../AGENTS.md` 保留「任何上下文都要看得见」的 5 节并给出导航。<br>另有**工具框架结论资产**：`tool-framework-audit.md`（诊断）/ `tool-framework-roadmap.html`（路线，§3 主线 A/B/C）/ `tool-capability-catalog.md`（**能力目录** = 主线 A 落地：47 工具 × 点名资产 × 归属 × 触发话术，含可重跑的扫描命令） | 活资产 —— 章节名受上方「外部引用契约」约束 |
| `adr/` | **架构决策记录**（0001-0009 + 模板）—— 回答"为什么这么定"。Accepted 后不删不改，被取代标Superseded。说明见 `adr/README.md` |
| `workflow/` | Agent 工作流交换契约（`README.md` + `examples/*.json`） | **活跃资产** —— 外部 Agent（WorkBuddy / Codex 等）靠它生成可导入画布的 JSON。校验函数是 `@lnkpi/shared` 的 `validateWorkflow`，代码里由 `useWorkflowExchange.ts`、`compositionLint.ts` 等消费。**不要删。** |
| `superpowers/` | 历史 spec 与 plan（**份数以实测为准**：`ls docs/superpowers/{specs,plans}/*.md \| wc -l`） | **从 [`superpowers/INDEX.md`](./superpowers/INDEX.md) 进** —— 按主题 + 状态（🟢living / 🔒frozen / ⛔superseded）分组。⚠️ 索引是**生成产物**，⛔ **禁止手改** —— 新增文档后跑 `python3 scripts/docs/gen_index.py > scripts/docs/index_data.json && python3 scripts/docs/gen_index_md.py`（见下节） |
| `discussion/` | 讨论文档（第一资产） | 项目方向与决策来源 |
| `ops/` | 部署 runbook | 生产运维 |

## 已删除的目录（2026-10-03）

以下目录**无代码引用**，且内容为已完成的阶段性产物，故删除：

| 已删目录 | 删除原因 |
|---|---|
| ~~`adr/`~~ | ❗**已恢复**（2026-10-03 同日）。原3 份是 LangGraph 时代的 ADR，但**ADR 这个目录形态本身是对的** —— 补录了 8 份已上线决策的 ADR（0001-0008），见 `adr/README.md`。 |
| `mockups/` | 3 份 UX 线框稿，对应实现均已在代码里：<br>· `agent-progress-ux-system.html` → `apps/web/src/components/agent/turnStatusBar.ts`、`activityLine.ts`<br>· `agent-background-tasks-card.html` → `AgentTaskProgressCard.vue`<br>· `agent-queued-message-card.html` → `queueDelivery.ts` |
| `diagnostics/` | `2026-09-30-agent-architecture-diagnosis.html` —— 一次性架构诊断报告（对照 Codex / Claude Code / WorkBuddy），无后续演进价值。 |
| `archive/` | `2026-09-20-branch-cleanup.md` —— 2026-09-20 的一次性分支清理留痕（99 → 18 个分支）。**同类信息现由 `AGENTS.md` 的「分支纪律」与 `branch-first-dev-workflow` skill 承载**，留旧文档反而会让人以为还有第二套规则。 |

**删除前已核实**：这 4 个目录在 `apps/` `packages/` `services/` `charts/` `deploy/` 里的引用数均为 **0**。

## 内核能力清单（不在 docs/ 下）

`@earendil-works/pi-*-` 各子包的使用情况与理由记录在
**[`services/pi-runtime/DEPENDENCIES.md`](../services/pi-runtime/DEPENDENCIES.md)** ——
让"是否吃满内核能力"变成可核对的事实，而不是靠印象。依据见
[ADR-0009](./adr/0009-vendor-capability-first.md)。

## 断链现状与处置（2026-10-04 审计）

**机器校验**：`pnpm verify-links`（已接进 `ci.yml` 的 `Verify spec figures` step）。
只校验**活跃资产**的 markdown 相对链接 —— 断链会让 PR 直接红。

### 已修（4 条）

| 文件 | 原引用 | 修正为 |
|---|---|---|
| `discussion/2026-10-04-vendor-ext-review-registertool-pion.md` | `./0009-…md` `./0006-…md` `./0005-…md` | `../adr/…` |
| `../services/pi-runtime/DEPENDENCIES.md` | `./0009-…md` | `../../docs/adr/…` |

ADR 统一在 `docs/adr/`，但引用方分布在 `docs/discussion/` 与 `services/pi-runtime/`，
少了目录前缀就点不开。

### 已登记不改（21 条「路径引用」）

**按 ADR-0008「篡改历史记录比留死链更糟」，以下刻意保留，只登记。**

| 文件 | 条数 | 性质 |
|---|---|---|
| `discussion/2026-09-19-pi-lnk-migration-discussion.md` | 12 | 迁移期的目标文件（`packages/agent/src/*` 等），讨论纪要里的**当时计划** |
| `README.md`（本文件） | 4 | 下表登记的历史断链 |
| `discussion/2026-10-04-work-task-guidance.md` | 2 | 引用已删的 spec |
| `AGENTS.md` | 1 | `docs/extensions.md` 实际在 `vendor/` 下（裸文件名省略路径，上下文合法） |
| `ops/RUNBOOK-old-runtime-retirement.md` | 1 | 老 runtime 退役runbook，引用已删的 `deploy/AGENT_RUNTIME_PRODUCTION.md` |
| `../services/pi-runtime/DEPENDENCIES.md` | 1 | 同上，`docs/extensions.md` 在 vendor 下 |

**另有 5 条指向 `deploy-agent-runtime.yml`**（`adr/0001` + `ops/` 下 3 份 runbook/postmortem）：
该 workflow 随 LangGraph 链路删除而消失，是**历史事实**，不修。

### 审计范围与噪音控制

全仓 583 个 md，原始命中 **604 条** ⇒ 真断链 14 条。收敛靠四条排除规则：

| 排除项 | 条数 | 理由 |
|---|---|---|
| `vendor/` | ~500 | 第三方只读镜像，文档写的是他们自己的仓库结构。**禁止业务 patch**，改了无法与上游合并 |
| `docs/superpowers/` | ~260 | 历史 plan/spec 的「要创建 XXX 文件」是**当初的任务描述**，文件不在了正常 |
| 裸文件名引用 | 大量 | 如 `prompt-registry.loader.ts` 省略子目录，文件真实存在，上下文合法 |
| `.workbuddy/` `.superpowers/` | — | 私有记忆与临时产物，非仓库资产 |

⇒ 门禁实际只扫**活跃资产 md**（当前 76 个，**以 `pnpm verify-links` 的实测输出为准**）；噪音从 604 降到 21（这两个数是 2026-10-04 审计快照，非实时值）。

> **为什么人工审计不可持续**：这次手工扫 583 个 md **两次都超时**。
> 所以要做的是机器化门禁，而不是一次性大扫除。

## `superpowers/` 索引（2026-10-03 已补）

历史 spec 与 plan 的**正文未改动**，新增 [`superpowers/INDEX.md`](./superpowers/INDEX.md) 做导航：
按主题分组，每份标 living / frozen / superseded，判定规则写在索引文末。

- **份数不要写死在文档里**：specs 与 plans 的真实份数以
  `ls docs/superpowers/specs/*.md | wc -l` / `ls docs/superpowers/plans/*.md | wc -l` 实测为准。
  ⚠️ 本文与 INDEX 曾长期写着过时的硬编码份数（283 / 286）。**根因是索引被手改过** ——
  没有对应文件的手写内容会在下一次重跑生成脚本时被抹掉。**根治办法是不手改、走生成器**（见下）。
- 状态分布（living / frozen / superseded 分解）由生成器从 `scripts/docs/index_data.json` 读出，
  **不要手工维护**，也不要拿旧快照当判据。
- 判定优先读文档开头的 `状态：` 字段，其次按月份 + 主题推断。
- **判定错了的修法**：改文档开头的状态字段，然后**重跑生成脚本**，不要手改 INDEX。

### 重新生成索引（⛔ 不要手改 INDEX.md）

`INDEX.md` 是 `scripts/docs/` 下两个脚本的产物（`gen_index.py` 扫盘判定状态 →
`index_data.json` → `gen_index_md.py` 渲染 md）。**手改会让索引与数据源脱节**：其中没有对应文件的手写内容会在重跑时被静默抹掉，而文件仍在盘上的条目会被扫盘重新收回（只改归类与小节标题计数）。

实测状态（`c5f722b4` 重跑前）：`index_data.json` 的 `total` 停在 283，而 `INDEX.md` 有 290 条条目 —— 两个数来自不同的东西。差集实测：`index_data − INDEX = 0`、`INDEX − index_data = 7`，即那 7 条只存在于 `INDEX.md`、不在数据源里；其中 3 条落在「Agent 交互与可见性」小节，该小节标题写 27、实际 29。真正的缺口是 11 份（6 份 plan + 5 份 spec）。注意 `302 − 283 = 19` 是拿陈旧 `total` 比今天的总数，不能当作缺口。这 7 个文件在盘上都存在，所以按上面两条命令完整重跑时它们会被扫盘重新收回，变的是主题归类与小节标题计数；只有单跑 `gen_index_md.py`（配陈旧 `index_data.json`）才会把它们抹掉。真正会被重跑抹掉的是没有对应文件的手写内容。

```bash
python3 scripts/docs/gen_index.py > scripts/docs/index_data.json   # 重新判定
python3 scripts/docs/gen_index_md.py                               # 重新生成 INDEX.md
```

⚠️ 脚本自身按 `__file__` 回溯定位仓库根；但 `>` 重定向是**相对路径**，仍须从**仓库根**跑。

**怎么读重跑后的 diff**（`gen_index_md.py` 按份数 `-len(...)` 排序主题分组）：

主题分组是**按份数排序**的，所以某主题份数一变，**整个小节连同其下整块条目会移位**，
diff 因此可能很大而**实际一份文档都没丢** —— 实测给 `other` 主题加 1 份文档：
diff 67 行，其中 18 行文档条目出现在 `-` 侧，但它们**全部**同时出现在 `+` 侧（移位）。

✅ **唯一判据：有没有「净丢失」**。跑这一条即可（基线用改动前的 `INDEX.md`；
下面直接取 `HEAD` 版，已有改动未提交时换成改前副本）：

```bash
diff <(git show HEAD:docs/superpowers/INDEX.md) docs/superpowers/INDEX.md \
  | grep -oE '^[<>].*docs/superpowers/[^`]+' | sort -u > /tmp/idx-changed.txt
comm -23 <(grep '^<' /tmp/idx-changed.txt | grep -oE 'docs/superpowers/[^`]+') \
         <(grep '^>' /tmp/idx-changed.txt | grep -oE 'docs/superpowers/[^`]+')
```

输出为空 ⇒ 没有文档丢失（重排属正常）。输出非空 ⇒ 那几份文档真的不在索引里了，查文件是否被删。

⛔ **不要因为「看到几十行 `-`」就去手改 INDEX.md 找补** —— 那是分组重排，不是漂移。
要补条目，改/加文档后**重跑生成器**即可。

> 决策依据见 [ADR-0008](./adr/0008-docs-index-over-doc-edits.md)——
> 为什么不批量改正文（文件量级 diff 失控），以及为什么不用"按月份删/归档"（丢决策追溯价值）。
