---
status: 事实对账（2026-10-04）
baseline: origin/master 10e1e82c（PR #149 合并后）
sources:
  - docs/2026-10-02-prompt-engineering-audit.html（Round 1，基线 0593c3d）
  - docs/2026-10-02-prompt-engineering-audit-round2.html（Round 2，基线 d574b8b）
---

# 提示词工程审计 · 缺口落地进展对账

> ⚠️ **时效声明（2026-10-06 追加）**：本文正文是 **2026-10-04 的快照**（基线 `10e1e82c`），
> 其中**多处判定已被后续 PR 翻转**（最典型：下文写「W1b L1 runner ⬜ 未做」，而它已交付并已真跑）。
> **读本文正文前请先读文末「附录 A · 2026-10-06 复核对账」**——那里是对当前 `master` 的逐条重取证，
> 以及两条**改变 W4–W5 开工条件**的新事实。正文保留原样，作为「当时判断」的历史记录。

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
~~`createPiRuntimeHarness` 在 `origin/master` 上零命中~~ **已由 PR #149 交付**（形态为 `eval/driver.ts` + `eval/transcript.ts`，不走 coding-agent）。
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
| ③ `createPiRuntimeHarness` adapter + L0 CI | 🟡 | **adapter 已有**（PR #149 的 `eval/driver.ts` 走 pi-runtime HTTP）；L1 runner（接 vitest-evals + evalHarnessTable）未做 |
| ④ golden case | 🟡 **12 条（全部真实失败来源）** | PR #149。刻意少于建议的 30 条 —— 本仓纪律是**不自造**；后续每次线上事故增量补一条 |

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
| ① `lane.compact({customInstructions})` 传中文保留策略 | ✅ | **PR #141（静态清单）+ PR #142（动态状态 + hook 路径）已上线**，生产 `image.tag=69a9f35ad` |
| ② load_tools/load_skill 触发率 + 工具 schema token + 频次指标 | 🟡 | 触发率有（#102 `onSearch`）；**load_skill 路由指标已由 PR #141 补上**；schema token 与工具频次仍无 |
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

**阻塞点（2026-10-04 更新）**：Round 2 §08 明确「W4–W5 前置 = W1b 的 L1 判据可信」。
PR #149 已建判据层（L0 + 12 条 case + driver），**L1 行为回归仍未跑** ⇒ W4–W5 继续挂起。

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
| P0-1 | 无 eval 体系 | 🟡 **判据层已建** | PR #149 交付 L0 契约层（16 条）+ 12 条真实失败 case + HTTP driver。**L1 行为回归（真跑模型）仍未做** |
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

**① W1b：eval harness（唯一硬阻塞）—— ✅ 依赖阻塞已排除（2026-10-04 取证修正）**

Round 2 已把成本降到"写一层 adapter"：vendor `packages/evals` 有 `vitest-evals` +
`evalHarnessTable`（pass-rate lift + token/延迟/成本配对差值），
只缺 `createPiRuntimeHarness`——参照 `packages/evals/src/pi-harness.ts:246` 的形态，
但走 pi-runtime 的 `/sessions` + `/prompt` HTTP，而非 coding-agent 的临时工程目录。

> **✅ 原「私有依赖」判断是错的，本节已修正**（2026-10-04 取证）：
> `@earendil-works/pi-evals` 自身是 `private: true`，那是 **vendor 树内自研框架**，不是 npm 包。
> `vitest-evals@0.15.0` 是 **npm 公开包**（Apache-2.0），vendor 的 lock 里已锁它及其
> `@vitest-evals/core` / `@vitest-evals/report-ui` 依赖。
> 真实摩擦点是 peerDeps 形态：`vitest-evals` 要 `ai`（Vercel AI SDK）而项目用
> `@earendil-works/pi-ai`；但要用的 `harness-table.ts` 只 import `vitest-evals/harness`，
> **不碰 `ai` peer** ⇒ 影响面很小。
>
> **结论：W1b 无依赖阻塞，可直接开写 adapter，无需退化为自建 L1 套件。**

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

1. ~~**`vitest-evals` 依赖是否可解？**~~ ✅ **已取证：可解，npm 公开包。**
   详见 §4 第一梯队 ① 的修正说明。W1b 可直接开工，无需退化为自建 L1 套件。

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

---

## 5. 执行记录（2026-10-04）

| 项 | 状态 | 交付 |
|---|---|---|
| `vitest-evals` 依赖取证 | ✅ 完成 | npm 公开包，原判断有误；W1b 无阻塞 |
| **W2① 压缩保留段** | ✅ **已上线生产** | PR #141（静态清单）+ PR #142（动态状态 + hook 路径），`image.tag=69a9f35ad` |
| W2② `load_skill` 触发率 | ✅ 已完成 | PR #141「按技能名路由指标」 |

### W2① 最终形态：两层保留段

```
customInstructions = COMPACTION_RETENTION_INSTRUCTIONS   ← #141：通用四类清单（说"要保留哪几类"）
                  + "\n\n"
                  + buildRetentionInstructions(state)     ← #142：真实状态（说"是哪个节点"）
```

少任何一层都不完整：静态清单说不出具体节点 id，动态状态说不出还应保留哪几类。

**#142 补的、#141 缺的三块**：

1. ⭐ `before_compaction` hook 路径完全没接 —— 那是**有图会话**走的那条
   （`annotateImagesForSummary` 命中才自产摘要），原本透传恒 `undefined` 的
   `event.customInstructions` ⇒ 这类会话拿不到任何保留段
2. ⭐ 没有真实状态 —— 新增 `TurnContext.retention`，Nest 从 `Session.canvasData` 读
   `status === 'pending_confirm'` 的节点（该字段是 SSOT：`proposeGeneration` persist 后才
   返回卡片，且 pi-runtime 的 generation-gate 跨轮重建后仍回查它）
3. kill switch 没覆盖 hook 路径

### 顺带修掉的真实缺陷

`isTurnContextEqual()` 漏比较新增的 `retention` ⇒ `setTurnContext` 判定"没变"而整轮跳过，
保留段永远是上一轮的值。因为 retention 不进 system prompt，
**系统提示词不抖动、指标全绿，看不出任何异常**。
由 wiring 层断言抓出（纯函数测试 100% 通过照样漏）。

### 生产取证

`helm image.tag = 69a9f35ad`；容器内 import **真实 dist 产物**（非重实现）跑 6 项断言全 true
（版本标记 / 节点 id 透传 / 恒非空 / 注入阻断 / 截断 / 两层合并）；
api 容器 `grep -c collectRetentionState` = 3。

### W2① 之后的剩余缺口

- **W2③** 索引块补自然语言触发条件（Round 2 判断 3）—— 建议先用 `tool_search_activated_total`
  观测一个周期再决定是否继续押注渐进披露
- **P0-3 收尾（L-2）** pi-runtime 侧 `pi_runtime_prompt_version_info` + session meta 落 `promptVersion`
- **W1b / W3 / W4–W8** 见 §4 第三梯队

---

## 6. 执行记录（第二轮，2026-10-04 上午）

| 项 | 状态 | 交付 |
|---|---|---|
| **撤回**「W2③ 先观测再动手」 | 🔴 **建议作废** | 实测生产**零流量**（见下），观测类建议在有流量前全部失效 |
| **W1b eval harness** | 🟡 判据层已建 | PR #149：`eval/{transcript,driver,golden-cases}.ts` + L0 契约层 16 条 + 12 条真实失败 case |

### 🔴 为什么撤回上一轮的建议

我上轮建议「W2③ 先观测 `tool_search_activated_total` 一个周期再决定」。实测：

| 指标 | 值 |
|---|---|
| `pi_runtime_sessions_active` | **0** |
| `pi_runtime_sessions_live` | **0** |
| `pi_runtime_tool_search_activated_total` | **0** |
| `pi_runtime_uptime_seconds` | 1648 |
| 有数据行的 counter 指标 | **0 个**（全部 Map 为空） |
| `readyz` HTTP 请求 | 331次（健康检查） |
| `sessions/:id/events` HTTP 请求 | **恰好 1 次** |
| Nest 侧 pi-runtime 相关日志 | **0 条** |

`PI_RUNTIME_MODE=active` + `PI_RUNTIME_URL` 配置正确 ⇒ **不是接线问题，是纯零流量**。

⇒ **「先观测」这个动作本身也要先查流量**，否则给的是一个永远等不到的判据。
⭐ 这条已写进长期记忆：**任何「靠观测决定要不要做」的建议，都要先确认有流量。**

### W1b 交付内容（PR #149，mergeCommit `10e1e82c`）

```
services/pi-runtime/src/eval/
├── transcript.ts       流式事件 → 归一化 transcript 的折叠（纯函数）
├── transcript.test.ts  14 条
├── driver.ts           走 pi-runtime HTTP 驱动一轮
├── driver.test.ts       5 条
├── golden-cases.ts    12 条 case + evaluateCase()
└── golden-cases.test.ts 16 条（L0 契约层）
```

### ⭐ 一处架构判断要修正 Round 2

Round 2 说「照 `packages/evals/src/pi-harness.ts:246` 的形态写 adapter」——
**vendor 那个 harness 的 `run` 深度依赖 `@earendil-works/pi-coding-agent`**
（`createAgentSessionFromServices` / coding-agent 的 `SessionManager` / `SettingsManager`），
而本项目**刻意不依赖那个包**（ADR-0001/0009）⇒ 直接抄会把整个 CLI 宿主拉进依赖面。

**但不需要重写框架**：`createHarness` / `evalHarnessTable` / judge 全部来自
`vitest-evals/harness`（npm 公开包，与 coding-agent 无关）。
⇒ **只需实现 `run` 回调**，框架不动。这不违反 ADR-0009「vendor 有的必须用」——
`createHarness` 就是 vendor 提供的、我们已用的部分。

### 三个关键设计决策

1. **eval 走 HTTP 而非进程内调 `SessionManager`** —— 后者绕过 HTTP 契约 / SSE 归一 /
   `from=now` 订阅裁决，而那三处恰是真实链路出问题的地方。
   **eval 要测「上线后那个」，不是「源码里那个」。**
2. **首批 12 条而非 30 条** —— 30 条的前提是「能自造 case」，本仓纪律是**不自造**。
   宁可 12 条真实的。后续每次线上事故增量补一条。
3. **L0 契约层（零 token）先于 L1** —— L0 抓「评测集自己的错」，能在无凭据环境先挡掉。

### L0 契约层当场抓到两个真实问题

1. ⭐ **`expectTools: []` 语义缺口**：原实现按「必须包含全部期望工具」解，
   空数组**恒通过** ⇒ 闲聊/致谢 case 变成永远绿的僵尸判据。
   已补：`[]` = **不得调任何工具**。⚠️ 判据存在性检查要用
   `c.expectTools ?? undefined === undefined`，**不能用 `!c.expectTools`**。
2. **`write-guard-003` 零判据**（我留注释说「首批不做 judge」）⇒ 被 L0 抓出。

### transcript 折叠：最易错处会让评测基线假绿

`message_end` 常带**全量文本**（非增量），无条件 append ⇒ 同一段话出现两遍
⇒ 基于文本的断言永远失败。`mergeText` 规则：新文本**以旧文本为前缀 ⇒ 替换**。
⇒ **一个「看起来在跑、实际判据全错」的评测基线，比没有 eval 更危险。**

### 剩余缺口

| 项 | 状态 | 说明 |
|---|---|---|
| **W1b L1 runner** | ⬜ 未做 | 接 `vitest-evals` + `evalHarnessTable` 做 baseline vs candidate 对比。**需 LLM 凭据** |
| **W2③ 索引块触发条件** | ⏸ **挂起** | 原计划「先观测」已作废（零流量）。Round 2 判断 3 的假设**至今未被任何数据验证** |
| **P0-3 收尾（L-2）** | ⬜ 未做 | `pi_runtime_prompt_version_info` + session meta 落 `promptVersion` |
| **W4–W5 规则重写** | ⏸挂起 | 前置是 L1 判据可信，L1 未跑 ⇒ 继续不开工 |

⚠️ **W4–W5 的前置条件目前只完成了一半**：判据（case + `evaluateCase`）有了，
但**从未真正跑过模型**。在没有一次真实 L1 跑之前，「回归集」只是纸面。

---

## 附录 A · 2026-10-06 复核对账（R1 窗口追加）

> **取证基线**：`origin/master` = `ddbe5660`（SEL-REF #236 合并后）。正文快照基线为 `10e1e82c`。
> **取证方式**：`git grep -n <pat> -- <path>` 只认 tracked 文件；合并判定用
> `gh pr view <n> --json mergeCommit.oid` 与 master HEAD 比对（**禁用 `git cherry` / `--is-ancestor`**，squash 会重写提交 ⇒ 必然误判）。
> ⚠️ 本节只覆盖两类内容：**正文判定已翻转** 与 **新增事实**。未提及的条目不代表已变，只是本轮未逐条重证。

### A.1 判定翻转：正文写「未做」⇒ 实际已落地

| 项 | 正文（10-04） | 现状（10-06 取证） | 证据 |
|---|---|---|---|
| **W1b L1 runner** | ⬜ 未做 | ✅ **已交付，且已真跑过模型** | `services/pi-runtime/src/eval/{cli,runner,driver,transcript,golden-cases}.ts`；跑法与坑见 `docs/EVAL_HARNESS_RUNBOOK.md` |
| **P0-1 eval 体系** | ⬜ 未开始 | ✅ 双层判据均已在（L0 契约层零 token + L1 行为层真跑模型） | L0 = `evaluateCase`（12 条 case）；L1 = `runL1` + `cli.js` |
| **P0-3 收尾（L-2）** | 🟡 部分（无 version 指标） | ✅ 已落地 | `apps/server/src/agent/agent.service.ts:926` 派生 `promptVersion = ${registryVersion}@${registryHash}`；指标 `pi_runtime_prompt_info`（`services/pi-runtime/src/metrics.prompt-info.test.ts`） |
| **P2-1 压缩摘要全依赖 vendor** | ⬜ 通道通但未填值 | ✅ 已填值 | `services/pi-runtime/src/session-manager.ts:1811` 传 `customInstructions = COMPACTION_RETENTION_INSTRUCTIONS + buildRetentionInstructions(...)`；另有 `compaction-summary.ts` 的 `missingSummarySections` 审计（`:1166` fail-soft 告警） |
| **W2③ 索引块触发条件** | ⏸ 挂起（原计划「先观测」作废） | 🟡 **以另一形态落地** | `prompt-registry/rules/canvas_daily_ops.md:12` 规则 20 写下自然语言触发词（「画布有什么/多少节点」「有哪些任务/生成到哪了/出错没」…）⇒ 索引块改为**按需 tool_search** 而非常驻名单 |

### A.2 里程碑盘点（spec §12）

`M1` PROMPT_SPEC + 规则地图生成器 / `M2` 语义 id + L10 门禁 / `M3` 组装契约 6 case /
`M4` 地图改生成产出 + CI 校验 / `M5` 真模型 A/B 场景集 / `M6a` 记忆反哺剔除 / `M6b` 晋升候选队列
—— **七项均已交付**。
M5 场景集在 `services/pi-runtime/src/evals/prompt-ab-scenarios.ts`（首跑归档见 `docs/ops/prompt-ab-runbook.md`）；M6b 由 PR #210 交付。

### A.3 三条改变 W4–W5 开工条件的新事实

**① 阻塞点解除，但带着两个前提。**
正文「阻塞点」写「PR #149 已建判据层，**L1 行为回归仍未跑** ⇒ W4–W5 继续挂起」。
2026-10-06 已真跑（`docs/EVAL_HARNESS_RUNBOOK.md` §7 与 10-06 baseline）⇒ 由「不可开工」变为「**可开工，待排期**」。动手前必须知道：

- **方案 A 盲区**：L1 直调 `loadRegistry + renderStatic`，**绕过 Nest 装配层**（动态段拼装 / `STATIC_BUDGET_CHARS` 截断 / 静态-动态分工）。
  它只回答「**规则文本**改了行为变不变」，**不回答**「装配层有没有问题」——别拿「L1 跑通了」论证后者。
- **429 是主要噪声源**：pi-runtime pod 内 `AGNES_API_KEY` 是**平台免费额度**，2026-10-06 实测 11 条里 **3 条撞 429**
  （表现为 `agent_end failed/assistant_error`，会混进 fail/error）。⇒ 改动前必须先把 baseline 跑干净
  （撞到的用 `--only <case>` + 更大 `--interval` 补跑），否则「限流」会被读成「行为退化」，把人引向改本来正确的提示词。

**② P1-4 的根因被实测改写**（Round 2 判断 3 的假设被推翻）。
Round 2 假设「模型不会主动搜工具」。2026-10-06 分级下发实验（PR #222 → #223，真实 agnes 模型、容器内解密 BYOK）给出反证：

- 无「常驻替代品」的探针 ⇒ **4/4 主动 `tool_search` 且命中**；
- 全量下沉后复测 10 轮 ⇒ 8/10 触发搜索、`hit=9/miss=1`、**0 幻觉**；
- 历史「`tool_search` 恒 0」的真因是**没有动机**（能力全常驻，模型不需要搜），不是能力缺失。

⇒ P1-4 的命题从「教会模型搜索」变成「**不要让某个常驻工具能给延迟领域凑出半个答案**」——
实测有替代品时出现过「素材库 18 张图答成『没有任何节点』」的**静默答错**。新铁律：**核心读能力必须整套同进退**。

**③ 「注入顺序跳跃」的改动成本远高于原估。**
正文把注入顺序 `1,2,3,7,14,4,5,11,12,13` 的跳跃列为机械项。实测：规则编号被全仓 **227 处**「规则 N」引用
（`prompt-ab-scenarios.ts`、`golden-cases.ts`、`pi-prompt-assembler.service.test.ts`、`tool-capability-catalog.md`、`PROMPT_SPEC §3` 表格；
且「同步 6 处」这一表述还牵到归 R6 的 `AGENTS.md`）。
⇒ 若做编号连续化，**必须同批改全部引用点**，不能「先改编号、回头再补」。

⭐ 同时澄清一个曾经担心的点：**L10 门禁只管 anchor 引用**（`prompt-registry.loader.test.ts` 的引用正则
「只认 反引号 + 小写字母数字连字符 + ≥4 字符」，故「见规则 14」**不会**被当成引用）
⇒ 重排编号**不会**静默断运行链路，只会让注释/文档里的编号失准。**风险等级下降，但改动面仍广。**

### A.4 仍未做（截至 10-06，对 master 零命中 / 未改动取证）

W4–W5（规则原子化：编号仍跳 6/8/9、规则 4 仍 **934 字符**、无 XML 语义分区、0 条 canonical trajectory）、
W6（`entryProjectors` 零命中）、W7（`before_request`/`after_response` 在 `services/` 零注册）、
W8（skill frontmatter 仍 `name/version/description` 三字段、无灰度）、W3① 工具元信息 lint、
W3③ vision 提示词孤岛（仍在 `apps/server/src/agent/sidebar-media-parse-prompt.ts`）、
P0-4 schema token 口径、P1-1（人格层仍禁令体）/P1-2/P1-3、P2-2/P2-3/P2-5。

> ⚠️ 与正文一致的一条判断仍然成立：**W4–W5 仍是本线风险最高的资产**，
> 新增的 L1 判据只让「有判据可依」成立，**不等于收益已被证明**。
> 真要动手，顺序建议：先把 baseline 跑干净 ⇒ 单条规则改动 ⇒ 立刻重跑 L1 对比 ⇒ 有增益才继续下一条。

