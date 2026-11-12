# spawn_subagent 触发策略 · 基线修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"主动委派"授权真正注入运行期，使模型在**非显式**话术下也会自发性调用 `spawn_subagent`。落地规格 `docs/superpowers/specs/2026-11-12-spawn-subagent-trigger-strategy.md` 的 §4.1 / §4.2 / §4.3 / §4.6 与 §5 验证——即**保持常驻 + 补 L2 点名 + 收敛 description + 补 fallback 文案 + 更正 tiering 注释**。本计划**不做** L3 技能 / persona / orchestrator（见规格 §7 路线图）。

**Architecture:** 四刀皆为**文案 / 规则**改动，无新增运行时链路、无新表、无新端点：
- §4.2 在 `prompt-registry/rules/` 新增恒注入（`core`）授权规则，并经 PROMPT_SPEC §6 的"6 处同步"进入 L6 静态拼装；该规则随 `basePrompt` **同时注入主会话与子代理**（§3.3）。
- §4.3 收敛 `spawn-subagent.ts` 的 `description` 为关键词信号（常驻 schema，不占 prompt-registry 预算）。
- §4.6 在 `spawn-subagent.ts` 的 `ok:false` 返回里补"自行完成"兜底文案（对齐 Codex "if unavailable, continue solo"）。
- §4.1 仅更正 `tiering.ts:159-167` 误导注释，不动 `ALWAYS_ON_TOOL_NAMES`。

**Tech Stack:** TypeScript、vitest；prompt-registry 静态预算机检（`pnpm prompt:lint`）；pi-runtime 经 `pi-prompt-assembler` 消费 prompt-registry。

**Spec:** `docs/superpowers/specs/2026-11-12-spawn-subagent-trigger-strategy.md`（执行前必读；本计划从该规格推导，二者同行）。配套调研：`docs/superpowers/research/2026-11-12-subagent-trigger-best-practices.md`。

## Global Constraints

- **代码基线 = 真 master（执行时以 `gh api repos/sev7n4/pi-lnk/branches/master` 核验的 commit 为准）**。本地主仓 `/Users/4seven/workspace/pi-lnk` 长期脏且 fetch 不可达、ref 陈旧，**禁止基于它读源码或改刀**。实施目录 = 干净快照 `/tmp/pi-lnk-master-<sha>`（`gh api .../tarball/<sha>` 解包）；所有代码路径相对该目录。
- **本机 ↔ GitHub 仅 `gh api` 可达**。快照无 `.git`，故每个任务末尾的 "Commit" = 把本任务改动路径登记进 Task 6 的 REST 单 commit 清单；Task 6 按 `blob → tree(base_tree 只传改动路径) → commit → ref → PR` 推送，推前逐路径裸 blob sha 比对 master，推后 `compare` 核验。
- **本刀会动 pi-runtime + prompt-registry ⇒ 触发 `runtime-deploy`**。按用户纪律：**CI 全绿后停在合并前，等单独授权再合并/部署**；生产实证（Task 5 第 3 步）属"部署后授权步骤"，未授权不执行。本轮交付 = 规格(已更新) + 本计划 + 代码 PR。
- **判据纪律**：按数据形态分支的修复，判据必须先贴真实生产记录求值 + 变异自检（#815 教训）；「0 命中」须排除假 0——BSD grep 不支持 BRE `\|`，一律 `grep -E` 或单模式。
- **预算纪律**：`prompt-registry` `STATIC_BUDGET_CHARS=3200`、当前实测 3085、**余量 115 字符**（硬事实，非估计）。新规则净增须 `pnpm prompt:lint` 实测不破硬线；若逼近预警线（2720），先压缩 §4.3 的 description 散文腾空间，**AI 不得自行删规则、不得自行抬预算**。
- **6 处同步铁律**（`PROMPT_SPEC.md §6`，🔴 漏改静默绿）：改 `rules/<id>.md` 必须同步 frontmatter · `MANIFEST.yaml`（version+contentHash）· `COMPOSED_IDS` · `FALLBACK_BY_ID` + `prompt-registry.fallback.ts` · 🔴 `renderStaticFallback()` 拼装顺序 · `pi-prompt-assembler.service.test.ts` 的 `EXPECTED`。漏改 `renderStaticFallback()` ⇒ 容器读不到 registry 走 fallback 时**该规则整段消失且无任何报错**。
- vitest 用 nvm node24：`$HOME/.nvm/versions/node/v24.13.0/bin` 加入 PATH，命令带 `--maxWorkers=1 --no-file-parallelism`；本机 pnpm 须 `env -u NODE_OPTIONS`；断言**禁用** `as never`。

## Review Focus

以下最可能咬人，各自已在所属任务的测试中钉住：

1. **6 处同步漏改 ⇒ fallback 静默丢规则**（PROMPT_SPEC §6 红色警告）。合理期望：新规则在 `renderStaticFallback()` 拼装顺序与 `FALLBACK_BY_ID` 中齐备；用 `pnpm prompt:lint` + 一个断言"组合静态 prompt 含授权串"锁死。→ Task 1。
2. **prompt:lint 余量破线**。合理期望：规则净增 ≤115 字符且实测不破硬线；若破线必须压缩 description 或人工拍板抬预算，不得 AI 自抬。→ Task 1 闸门。
3. **description 收敛误伤"禁用"条件**。合理期望：收敛后 description **仍含**"改画布/生成内容别派"的勿用条件，否则写场景会误派。→ Task 2 断言同时校验 when/why + 禁用。
4. **子代理继承新规则但不递归**。合理期望：新规则进 `basePrompt` ⇒ 子代理也看到；但白名单排除 `spawn_subagent` ⇒ 子代理不可再派生（不变量，加一条回归断言"子代理工具集不含 spawn_subagent"）。→ Task 2/5。
5. **tiering 注释更正不动常驻集**。合理期望：`spawn_subagent` 仍在 `ALWAYS_ON_TOOL_NAMES`；只改 `:159-167` 注释文本，不得触碰数组元素。→ Task 4（纯注释 + review 复核）。

---

## File Structure

| 文件 | 职责 | 任务 |
|---|---|---|
| `prompt-registry/rules/subagent-delegation.md` **（新建）** | §4.2 L2 恒注入授权规则（`core`，~80–120 字符） | T1 |
| `prompt-registry/MANIFEST.yaml` | 加 entry（id/version/order/contentHash） | T1 |
| `services/pi-runtime/src/.../prompt-registry.fallback.ts` | `FALLBACK_BY_ID` 加新规则 + `renderStaticFallback()` 拼装顺序 | T1 |
| `services/pi-runtime/src/.../pi-prompt-assembler.service.ts` | `COMPOSED_IDS` 加新 id | T1 |
| `scripts/gen-prompt-spec-map.ts` | 重生成规则地图（`--write`） | T1 |
| `services/pi-runtime/src/.../pi-prompt-assembler.service.test.ts` | `EXPECTED` 更新 + 新增 spawn 授权断言 + 变异自检 | T1 |
| `services/pi-runtime/src/tools/spawn-subagent.ts` | §4.3 description 收敛 + §4.6 fallback 文案 | T2/T3 |
| `services/pi-runtime/src/tools/spawn-subagent.test.ts` | description 信号断言 + fallback 文案断言 + 子代理白名单断言 | T2/T3/T5 |
| `services/pi-runtime/src/tools/tiering.ts` | §4.1 注释更正（不动 `ALWAYS_ON_TOOL_NAMES`） | T4 |
| `docs/superpowers/{specs,plans}/2026-11-12-spawn-*.md` | 规格(已更新)与计划随 PR 同行 | T6 |

> 注：`prompt-registry.fallback.ts` / `pi-prompt-assembler.service.ts` / `COMPOSED_IDS` / `FALLBACK_BY_ID` / `renderStaticFallback()` 的**精确路径以 `grep -E 'FALLBACK_BY_ID|renderStaticFallback|COMPOSED_IDS'` 在 `services/pi-runtime/src` 定位为准**（PROMPT_SPEC §6 已命名，路径随重构可能偏移）。

**分解依据**：T1 是规则 + 6 同步（最大、最易漏），独立成任务便于 reviewer 以"是否零破坏"拒绝；T2/T3 改同一文件 `spawn-subagent.ts` 的两段（description / fallback），可同文件但分断言；T4 纯注释零风险；T5 是集成测试 + 生产实证闸门；T6 汇总推 PR。每个任务自带测试周期，可单独被拒。

---

### Task 1: §4.2 L2 规则 + 6 处同步 + prompt:lint 闸门

**Files:**
- Create: `prompt-registry/rules/subagent-delegation.md`
- Edit: `prompt-registry/MANIFEST.yaml`、`services/pi-runtime/src/.../prompt-registry.fallback.ts`、`pi-prompt-assembler.service.ts`、`scripts/gen-prompt-spec-map.ts`、`pi-prompt-assembler.service.test.ts`

**Rule body（候选，净增须 ≤115 字符，落地以 `pnpm prompt:lint` 实测为准）:**
```markdown
---
id: subagent-delegation
version: 1.0.0
title: 研究类任务优先委派子代理
order: 47
owner: agent-platform
updated: 2026-11-12
group: core
anchor: subagent-delegation
---
研究/探索/多源核对/联网查资料类任务（尤其会塞满主窗口的探索过程）→ 优先 spawn_subagent 派只读子代理独立做完，你只汇总要点。
```

**Interfaces / 6 同步清单（逐项打勾）:**
- `rules/subagent-delegation.md` frontmatter 含 `id`/`anchor`（anchor 字符集须过 L11）。
- `MANIFEST.yaml` 加 entry（`order` 选未占用值，如 47；`contentHash` 取文件哈希前 12 位）。
- `COMPOSED_IDS` 含 `subagent-delegation`。
- `FALLBACK_BY_ID` 含 `subagent-delegation`（fallback 文案与规则正文一致）。
- 🔴 `renderStaticFallback()` 拼装顺序含 `subagent-delegation`（**漏改 = 静默丢规则**）。
- `pi-prompt-assembler.service.test.ts` 的 `EXPECTED` 同步。
- `npx tsx scripts/gen-prompt-spec-map.ts --write` 重生成规则地图（PROMPT_SPEC §3 表格）并提交。

**Tests (RED→GREEN):**
- `it('★ 组合静态 prompt 含委派授权串')`：断言 `renderStatic(['core','writeTools','genTools'])` 输出包含 `spawn_subagent` 与 `优先` 关键词（证明规则进了 L6）。
- `it('★ 变异自检：移除该规则 → 授权串消失')`：用 fixture/registry override 临时把 `COMPOSED_IDS` 剔除 `subagent-delegation` → 断言同一渲染函数输出**不含**授权串。证明授权文本源自规则而非 spawn description 或硬编码 fallback（判据真实依赖规则，非恒真）。
- `pnpm prompt:lint` 必须 ok（余量 ≥0 且非虚假通过）；若破硬线，回 Task 2 先压 description 再回本任务。

---

### Task 2: §4.3 description 收敛（关键词信号化，保留禁用条件）

**Files:**
- Edit: `services/pi-runtime/src/tools/spawn-subagent.ts`（`description` 字段，:32-36）
- Edit: `services/pi-runtime/src/tools/spawn-subagent.test.ts`

**New description（候选）:**
```
把一项只读调研派给子代理：它带完整上下文独立工作（查画布/读文档/联网），返回报告后阻塞本回合。
优先用：任务含"调研/研究/探索/多源核对/联网查资料"，且探索过程不值得占主窗口。
禁用：要改画布/生成内容时别派，自己做。
```

**Tests:**
- `it('★ description 含触发关键词信号')`：断言 `description` 含 `调研`/`研究`/`探索`/`多源核对`/`联网查资料`。
- `it('★ description 保留禁用条件')`：断言含 `改画布`/`生成内容`/`别派`/`自己做`（防止收敛误伤勿用条件）。
- `it('★ 子代理白名单不含 spawn_subagent')`：从 `SUBAGENT_TOOL_WHITELIST` 断言无 `spawn_subagent`（递归封死不变量，呼应 §3.3）。

---

### Task 3: §4.6 fallback 文案（对齐 "if unavailable, continue solo"）

**Files:**
- Edit: `services/pi-runtime/src/tools/spawn-subagent.ts`（`execute` 两处 `ok:false` 返回）
- Edit: `services/pi-runtime/src/tools/spawn-subagent.test.ts`

**Change:** 在 `subagent_concurrency_full` / `subagent_not_available` 的 `textResult` 里追加一句引导："子代理暂不可用，请自行联网/读文档完成调研，不要卡死或静默放弃。"

**Tests:**
- `it('★ fallback 含自行完成引导')`：mock `coordinator.tryRun` 返回 `{ok:false,reason:'concurrency_full'}` 与 `'not_attached'` → 断言返回 `details` 文本含"自行联网/读文档完成调研"。

---

### Task 4: §4.1 tiering.ts 注释更正（纯注释，不动常驻集）

**Files:**
- Edit: `services/pi-runtime/src/tools/tiering.ts`（:159-167 注释）

**Change:** 把"该通道无动机时触发率 0 ⇒ 不可达"归因改为正确立论——"延迟集时 spawned 恒 0 的真根因是点名缺失（L2/L3），且 web_search/web_fetch 常驻可凑答其领域（铁律）→ 故提回常驻。" 移除"tool_search 不可用"的错误暗示（详见规格 §6）。

**Guard:**
- 不动 `ALWAYS_ON_TOOL_NAMES` 数组；review 复核 `spawn_subagent` 仍在其中。
- 可选：在 `tiering.test.ts` 加一条断言 `ALWAYS_ON_TOOL_NAMES.includes('spawn_subagent')`（若已有则复用）。

---

### Task 5: §5 集成验证（含生产实证闸门）

**Files:**
- Edit: `services/pi-runtime/src/tools/spawn-subagent.test.ts`（集成用例）

**Local tests:**
- `it('★ 非显式话术下 description+L2 双保险可被识别')`：构造含"帮我调研 XX"的会话上下文（用真实生产夹具的最小子集），断言组装后的静态 prompt 含授权串且工具 schema 含收敛后 description（联合判据）。
- `it('★ 子代理继承 basePrompt 含新规则')`：构造 subagent build 上下文，断言其 `systemPrompt` 含 `subagent-delegation` anchor 文本（验证 §3.3 注入路径）。

**生产实证（部署后授权步骤，未授权不执行）：**
- 用测试号 + **非显式**话术（只说"帮我调研 XX 行业竞品"）驱动一轮，回查 `SubagentTask` 表是否落行、`/api/agent/threads/:id/state` 是否含 `subagentTasks` ——验证 L2 点名后自发性委派生效（对比 D2 实证"仅显式写 spawn 才调用"的基线）。
- 比对 D2 已验证的 spawn 管线（`spawn_subagent` → `SubagentTask` → `/state`），确认本次只增"触发率"、不改管线。

---

### Task 6: 汇总推 PR（停合并前等授权）

**Files:**
- Edit: `docs/superpowers/{specs,plans}/2026-11-12-spawn-*.md`（随 PR 同行；规格已在本次前置更新）

**Steps:**
- 汇总 T1–T5 全部改动路径，按 `blob → tree(base_tree 只传改动路径) → commit → ref → PR` 经 `gh api` 推送（推前逐路径裸 blob sha 比对真 master）。
- `gh api .../actions` 等 CI 全绿（含 `prompt:lint`、`vue-tsc -b`、vitest）。
- **停在合并前**：通知用户"代码刀 CI 全绿、待授权合并/部署（runtime-deploy 闸门）"。生产实证（Task 5 第 3 步）在授权合并部署后另行执行。

## No-Go

- 不改 `ALWAYS_ON_TOOL_NAMES`（§4.1 只改注释）。
- 不立 L3 `research-delegate` 技能 / 软硬 persona / orchestrator（规格 §7 路线图，本次不做）。
- 不把 spawn 改回延迟集（已证不利）。
- 不新增表 / 端点 / 运行时链路；不改 `SubagentCoordinator` / 白名单 / plan-gate。
- 不自行删规则或抬 `STATIC_BUDGET_CHARS`。
- 不在未授权时合并或部署（runtime-deploy 闸门）。
