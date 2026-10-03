---
status: 事实对账（2026-10-04）
baseline: origin/master 006af0a（PR #138 合并后）
sources:
  - docs/2026-10-02-prompt-engineering-audit.html（Round 1，基线 0593c3d）
  - docs/2026-10-02-prompt-engineering-audit-round2.html（Round 2，基线 d574b8b）
---

# 提示词工程审计 · 缺口落地进展对账

> 本文回答一个问题：**Round 1 的 16 条缺口 + Round 2 的 W1–W8 路线图，现在到哪一步了。**
> 全部结论对着 `origin/master 006af0a` 逐条取证，不采信任何文档里的自述进度。
> 取证命令：`git grep / git show origin/master:<path>`，工作区不算数。

## 0. 结论先行

**已落地的是"资产化"这一条线（W1a），其余全部未动。**

| 判定 | 数量 | 条目 |
|---|---|---|
| ✅ 已完成 | 1 | P0-2 的一半（提示词资产化 + CI 门禁） |
| 🟡 部分完成 | 1 | P0-3（Registry 有 version/hash，但生产侧无 version 指标） |
| ⬜ 未开始 | 14 | 含**全部 P0-1（eval 体系）** |

**最要紧的一条**：Round 2 反复强调"规则重写必须压在有 eval 之后"，而 **eval 一行都没写**——
`createPiRuntimeHarness` 在 `origin/master` 上零命中，`vitest-evals` 只存在于 `vendor/`（vendored 只读树，没装 node_modules）。
所以 **W4–W5（规则原子化重写）当前不具备开工条件**，谁先动谁就是在无判据状态下改最高风险的资产。

**次要紧**：Round 2 判定"全场性价比最高"的两项 —— W2 的 `lane.compact({customInstructions})` 传保留段、
以及 P1-4 索引块补自然语言触发条件 —— 都是**改动极小、当前完全没动**的。

---

## 1. 两份报告在哪（重要）

Round 1 说 P0-1 的 eval「全仓 0」，这个结论仍然成立（见 §3），但**报告自身差点丢了**：

两份 HTML 报告曾以未跟踪文件存在于工作区，2026-10-03 的一次 `git stash -u` 把它们打进了
`d31f739`（stash commit），随后该 stash 被 drop。报告因此从工作区和 master 双双消失，
只存在于悬空对象里，靠 `git fsck --lost-found` 才能捞回。

已在本分支恢复为 tracked 文件（见 `docs/README.md` 登记）。

> 判据记录：`git cat-file -e origin/master:docs/2026-10-02-prompt-engineering-audit.html`
> 在恢复前返回 `does not exist in 'origin/master'`。

---

## 2. W1–W8 路线图逐条对账

### W1 地基（①②③④）— 🟡 完成 2/4

| 项 | 状态 | 证据 |
|---|---|---|
| ① `prompt-registry/` 骨架 + MANIFEST + schema | ✅ | 8 个 `.md` + `MANIFEST.yaml`；`apps/server/src/agent/pi-runtime/prompt-registry.loader.ts` |
| ② PROMPT_VERSION 落 metrics 与 session meta | ⬜ | `git grep PROMPT_VERSION origin/master -- services apps` → **零命中** |
| ③ `createPiRuntimeHarness` adapter + L0 CI | 🟡 | L0 有了（`scripts/prompt-lint.ts` + 独立 workflow），adapter 无 |
| ④ ≥30 条 golden case | ⬜ | `llm-judge` / `llmJudge` / `golden case` 全零命中 |

已超出 Round 2 预期的是 ①：Registry 不只存规则文本，还带了
`assertRegistryIntegrity`（L0–L9）+ 独立 `prompt-lint.yml` workflow +
`renderStaticFallback()` 内嵌兜底 + `GET /api/agent/prompt-registry` 免鉴诊断端点。
**"容器读不到 registry 时规则整段消失"这个静默失效已被三道护栏堵住**（lint / pnpm test / deploy 收尾 curl）。

W1a 自己的遗留登记（spec §12.1）：

- **L-1 镜像落地一致性 lint** — 决策为本轮不做（已有 deploy 收尾自检兜底）。
- **L-2 `pi_runtime_prompt_version_info` 指标** — 随 W3 做。**这条就是 ② 的正式落点。**

### W2 止血 + 观测 — ⬜ 0/3

| 项 | 状态 | 证据 |
|---|---|---|
| ① `lane.compact({customInstructions})` 传中文保留策略 | ⬜ | `session-manager.ts:1398` 仍是 `lane.compact(undefined, context)` —— **恒 undefined** |
| ② load_tools/load_skill 触发率 + 工具 schema token + 频次指标 | 🟡 | 触发率有（#102 `onSearch` hit/miss/empty 回调）；**schema token 与频次无** |
| ③ 索引块改写为"条目 + 触发条件" | ⬜ | `tiering.ts` 的 catalog 仍是 `- \${name}：\${toolSummary(t)}`，无一条自然语言触发条件 |

① 是全表最便宜的改动：一个常量 + 一个参数，vendor 侧通道已验证端到端
（`compaction.ts:567` 会把它拼进摘要 prompt）。**未做。**

② 的触发率指标只覆盖 `tool_search`（`pi_runtime_tool_search_calls_total`），
**`load_skill` 没有对应指标** —— 而 P1-4 修的是 load_tools/P1-6 修的是 skill 路由，后者无判据。

### W3 工具侧 — ⬜ 0/3

| 项 | 状态 | 证据 |
|---|---|---|
| ① 工具元信息契约 lint | ⬜ | `git grep -c summary: origin/master -- services/pi-runtime/src/tools` 只命中 `web.ts`(2) + `types.test.ts`(2) |
| ② 常驻名单按频次裁剪 | ⬜ | 无频次指标，裁剪无依据 |
| ③ vision 子提示词迁 Registry | ⬜ | `sidebar-media-parse-prompt` 仍在 `apps/server/src/agent/`，未进 Registry |

①：`LnkpiTool.summary` 字段与 `toolSummary()` 回退逻辑都在（Round 1 §2.3 已指出），
但 19 个工具文件里只有 `web.ts` 真填了。**41/43 缺失这个结论至今成立。**

### W4–W5 规则重写 — ⬜ 未开始，且**当前不可开工**

现状证据（`prompt-registry/rules/*.md` 逐文件提编号）：

| 文件 | 编号 |
|---|---|
| `identity.opening.md` | 1, 2 |
| `no_gen_claim.{gen,nogen}.md` | 3 |
| `media_tool_policy.md` | **4, 5, 15, 16** |
| `sidebar_vision.tail.md` | 7, 14 |
| `gen_tool_policy.md` | 11, 12, 13 |
| `write_guard.md` | 10 |

- 注入顺序 `1,2,3,7,14,4,5,11,12,13` 的**跳跃问题原封不动**；
- 规则 4 单条仍 911 字符、9 个动作 + 3 反例 + 2 例外；
- 仍无 `<identity>/<style>/<tool_policy>/<negative_examples>/<examples>/<output_format>` 分区
  （Registry 的 `group: writeTools|genTools` 是**装配分组**，不是 Round 1 §07 提的 XML 语义分区）；
- 3 条 canonical trajectory 仍为 0。

**阻塞点**：Round 2 §08 明确"W4–W5 前置 = W1b 的 L1 判据可信"。L1 不存在 ⇒ 不开工。

### W6 结构化协议 — ⬜ 未开始

`git grep entryProjectors / appendCustomEntry origin/master -- services` → **零命中**。
`⟦plan⟧` 仍是 Nest 侧 `stripPlanMarkers` 剥文本的协议，压不掉、跨压缩必丢。

### W7 调度与守卫 — ⬜ 未开始

`before_request` / `after_response` 在 `services/` 下零注册（只在 `vendor/` 与 docs 里出现）。
四个 hook 对应的分流、输出守卫、`run_*` 参数护栏、Model 双分支全部未做。

### W8 常态化 — ⬜ 未开始

skill frontmatter 仍是 `name / version / description` 三字段
（`skills/drama-character-design/SKILL.md` 实测），无 `owner/changelog/eval_cases`。
无灰度（`PI_RUNTIME_SYSTEM_PROMPT` 仍是维护态兜底，非实验开关）。

---

## 3. 首轮 16 条缺口逐条判定

| # | 缺口 | 判定 | 关键证据 |
|---|---|---|---|
| P0-1 | 无 eval 体系 | ⬜ **仍为 0** | `createPiRuntimeHarness` 零命中；`packages/evals` 仅存在于 vendor 只读树 |
| P0-2 | 规则文本考古式移植 | 🟡 资产化✅ / 重写⬜ | Registry + lint + 三道护栏已落地；编号跳跃与 911 字单条未动 |
| P0-3 | 无版本号 | 🟡 部分 | Registry 有 `version`+`contentHash`，诊断端点可查；**pi-runtime 侧无 version 指标、session meta 无 promptVersion** |
| P0-4 | 工具 schema 无预算口径 | ⬜ | 无 schema token 度量、无分档降级 |
| P1-1 | 人格语气层缺失 | 🟡 部分 | `identity.opening` 已入 Registry，但仍是原来那一句"用简洁中文回答"，无 `<style>` 节奏约定 |
| P1-2 | 纯禁令体 | ⬜ | 无 `<negative_examples>` 配对 |
| P1-3 | 零 few-shot | ⬜ | 0 条 trajectory |
| P1-4 | load_tools 触发率 0 | ⬜ **根因未解** | 索引块无触发条件；触发率指标仅有 outcome 标签、无激活计数实证 |
| P1-5 | 工具无编写规范 | ⬜ | `summary` 仅 `web.ts` 填；无 lint |
| P1-6 | SKILL.md 无人管 | ⬜ | frontmatter 三字段；无触发 fixture；`load_skill` description 与索引块语言不一致 |
| P2-1 | 压缩摘要 100% 依赖 vendor | ⬜ **通道通但未填值** | `session-manager.ts:1398` 传 `undefined` |
| P2-2 | trust-boundary 硬截断 / 无修订语义 | ⬜ | 未动 |
| P2-3 | 无 per-task 推理预算 | ⬜ | `before_request` 未注册 |
| P2-4 | vision 子提示词孤岛 | ⬜ | 未入 Registry |
| P2-5 | 无 A/B 灰度 | ⬜ | 未做 |

**两个 0 分维度（评测 / 版本化可观测）仍是 0。**

---

## 4. 接下来怎么做

排序原则：**先补判据，再动文案；先做便宜的止血，再做高风险的改造。**

### 第一梯队（阻塞项，建议立刻做）

**① W1b：eval harness（唯一硬阻塞）**

Round 2 已把成本降到"写一层 adapter"：vendor `packages/evals` 有 `vitest-evals` +
`evalHarnessTable`（pass-rate lift + token/延迟/成本配对差值），
只缺 `createPiRuntimeHarness`——参照 `packages/evals/src/pi-harness.ts:246` 的形态，
但走 pi-runtime 的 `/sessions` + `/prompt` HTTP，而非 coding-agent 的临时工程目录。

⚠️ **前置阻塞**：报告已指出 `vitest-evals@0.15.0` 是私有包 `@earendil-works/pi-evals` 的
devDependency，vendored 树里没装 node_modules。**这个依赖不通，adapter 写了也跑不起来。
第一步应先验证依赖能否安装**，而不是直接写 adapter。

首批 case 按报告要求取**线上真实失败样本**（"只看到文件名" / "假称已出图" / 模糊工具名），
不自造。这三类在 `docs/` 的历史记录里都有痕迹，可直接提取。

**② W2①：压缩保留段（一行止血）**

`session-manager.ts:1398` 改传中文保留策略。这是全表性价比最高的一项：
vendor 通道已验证端到端、风险极低、回滚等于传回 `undefined`。
当前"压缩后待确认节点 id 丢失"是**每天都在发生的存量问题**。

**③ W2② 的缺口：补 `load_skill` 触发率指标**

现在只有 `tool_search` 的触发率。P1-6（skill 路由准确率）没有判据就无法开工。
**这条要在动 skill 之前上线。**

### 第二梯队（判据就位后）

- **W2③** 索引块补自然语言触发条件（Round 2 判断 3：门槛设计问题，不是提示词强度问题）
- **W3①** 工具元信息契约 lint（`summary` 必填 / ≤2 句 / 单一语言）
- **P0-3 收尾（L-2）** pi-runtime 侧 `pi_runtime_prompt_version_info` gauge + session meta 落 `promptVersion`

### 第三梯队（依赖 L1 判据，不得提前）

- **W4–W5** 规则原子化重写 —— 报告原话：「在判据可信之前做最大规模的文案重写，
  和首轮担心的风险是一样的，只是风险敞口从 W1–W2 缩小到 W4」
- **W6** `⟦plan⟧` → custom entry
- **W7** 调度守卫 / Model 双分支

---

## 5. 三个需要拍板的点

1. **`vitest-evals` 依赖是否可解？**
   私有包 + vendor 只读树是硬约束。若不通，eval 需退化为自建 L1 套件
   （硬断言 + 人工抽样），工作量从"2 人日"回到"1–2 周"，W4 的排期要整体后移。
   **建议在 W1b 开工前先花半天验证这条。**

2. **W4–W5 是否接受继续挂起？**
   规则文本的编号跳跃与 911 字单条是真实缺陷，但按报告自己的排序，
   在 eval 缺位时改它是"无法回滚、无法归因的冒险"。本文建议维持挂起，
   若业务压力要求先改，**至少先只做"编号连续化"这一项**（纯机械、可字节对账），
   不碰规则正文。

3. **P1-4 是否换修法？**
   2026-10-03 生产取证已确认 `tool_search` 触发率**仍为 0**（40 次工具调用全落常驻集，
   `tool_search_activated_total` 为 0）。Round 2 判断 3 押注"索引块补触发条件"，
   但**这个假设本身尚未被任何数据验证过**——延迟集当前有工具被生产实证为"延迟即不可达"
   （`arrange_nodes` / `save_memory` / `focus_node` 等已因此回归常驻）。
   建议：先按 W2③ 改索引块，然后**用 `tool_search_activated_total` 观测一个周期**，
   拿数据决定是否继续押注渐进披露，而不是直接做。
