# 任务管理工程路标 · 文档落地实施计划（docs-only）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把规格 `docs/superpowers/specs/2026-11-11-task-planning-engineering-roadmap-design.md` 的取证结论回填进三份既有资产（交付清单 / 任务管理总纲 / plan-gate 规格状态行），消除 G4/G5 证据与漂移断层；本计划不含任何代码刀。

**Architecture:** 纯 docs-only 刀，分支 `docs/task-planning-roadmap`，单 PR。三类动作：①交付清单按「判定矩阵」逐项回填（只勾实证项）；②总纲状态列与 §5 用**行内追加注记 / 末尾追加条目**方式纠偏（旧行按序全保留）；③规格状态推进由用户拍板后手工完成（自动化产出不构成批准）。

**Tech Stack:** Markdown 文档 + `grep`/`git diff` 自检；CI 判据为 `verify-claims` / `verify-links`（干净 checkout 权威）与 docs-only 零发布确认。

**Spec:** `docs/superpowers/specs/2026-11-11-task-planning-engineering-roadmap-design.md`（本文档所有数字与判定均引自该规格 §2/§4/§8）

## Global Constraints

- 零 vendor patch、零新表、零新依赖；本分支只允许改 `.md` 文件（`git diff --name-only` 全部以 `.md` 结尾）。
- 全量快照 SSOT 红线与「B→A 反向不可行」红线照旧生效（总纲 §2.2/§5）——本计划不触碰任何代码，仅作背景。
- **纯追加判据（沿用 #825）**：对总纲与规格的纠偏必须「旧行按序全保留 + 0 行删除 + 新增内容带日期标注（2026-11-11）」；交付清单允许把 `- [ ]` 原位改为 `- [x]`（这是勾选不是改写历史口径），但禁止改写勾选项的原文。
- 生产数字必须带时点：一律标注「2026-11-10 快照 · 镜像 `141d5d97`（落后 master 17 提交）」。
- prompt 预算数字双口径（3175/余 25 为交付清单时点实测；3132/余 68 为 AGENTS.md 手工行）：引用时必须注明口径来源，权威以 `prompt-registry/PROMPT_SPEC.md` §5 为准；本计划不修改预算数字本身。
- 不虚勾：交付清单无实证项保持 `- [ ]` 并追加「证据待补（2026-11-11）」。
- docs-only 零发布为预期：`ci.yml` `push.paths-ignore` 含 `**/*.md`/`docs/**` ⇒ 合并后无 master CI run 不是失败；权威证据 = PR `pull_request` CI 全绿 + 合并树 == 已验证 PR head 树。
- 触发条件判定按总纲 §5 字面：注记只记证据，不得写「C1-B 可立项」。
- 合并与生产动作需用户单独授权；PR 正文必须回读长度（`@文件路径` 当正文会静默丢内容）。

## Review Focus

1. **无实证项虚勾**：交付清单某项被勾 `[x]` 但无数据来源 → 期望：每个 `[x]` 同行附「（证据：<数据摘要>）」；自检 = `grep -c "^- \[x\]"` 结果 == 有实证项数（见 Task 1 判定矩阵），并在 PR 描述列出逐项来源。
2. **历史口径被改写**：diff 出现 `-` 行（除清单勾选翻转外）→ 期望：`git diff` 中总纲/规格文件 0 删除行；自检 = Task 2/3 步骤中的 `git diff --numstat` 断言。
3. **数字口径混淆**：新增文本出现「3175」或「3132」但未标来源 → 期望：预算数字必须带「（PROMPT_SPEC 机器生成口径）/（2026-10-09 时点实测）」之一；自检 = grep 新增行中的数字上下文。
4. **触发条件被提前解锁**：总纲 §5 注记出现「C1-B 可立项 / 满足触发条件」→ 期望：注记只写「条件①证据仍为未满足（spawn_subagent 生产 0 调用 + 产物 0 命中，2026-11-10）」；自检 = Task 3 步骤中 grep 断言。
5. **Markdown 断链**：新增行引用不存在的文件路径 → 期望：新增行 0 Markdown 链接，或仅引用规格内已验证存在路径；自检 = 本地 `pnpm verify-links` 允许假红，CI 干净 checkout 为权威（在 PR 描述注明此判据）。

---

### Task 1: 回填交付清单 14 项生产取证

**Files:**
- Modify: `docs/ops/2026-10-09-task-tool-delivery-checklist.md`

**Interfaces:**
- Consumes: 规格 §2.3 生产取证数据（2026-11-10 快照）。
- Produces: 清单中每个 `- [x]` 项带同行证据；未实测项带「证据待补（2026-11-11）」标注。后续 Task 2/3 引用本任务产出的取证块。

- [ ] **Step 1: 读清单原文，建立项号映射**

读 `docs/ops/2026-10-09-task-tool-delivery-checklist.md` 全文，列出 `:7-24` 的 14 个 `- [ ]` 项原文，按主题归入判定矩阵四类（A 部署前核对 / B 生产取证 / C 行为断言 / D 指标建档）。禁止凭记忆改写项文本。

- [ ] **Step 2: 按判定矩阵逐项回填**

判定矩阵（有实证 → `- [x]` + 同行证据；无实证 → 保持 `- [ ]` + 追加「证据待补（2026-11-11）」）：

| 类 | 判据 | 回填动作 |
|---|---|---|
| B-生产取证 | `[legacy-plan-marker]` | `- [x]` + 「（证据：近 7 天容器日志 grep 计数 0，2026-11-10 快照）」 |
| B-生产取证 | `[todo_write] dropped-incomplete` 基线 | `- [x]` + 「（证据：全量 282 次调用 / 10 月 89 / 11 月 193，DB 只读副本 executionEvents 展开，2026-10 快照）」 |
| B-生产取证 | compaction 存活 | 有「跨压缩注入」生产样本则勾并附证据；无逐例证据则「证据待补」 |
| B-生产取证 | fork 正确 | 同上：无逐例证据则「证据待补」 |
| C-行为断言 | 14/14 断言重放 | 本计划**不重放**，保持 `- [ ]` + 「证据待补（需按原断言重放，见 spec `2026-10-09-task-tool-design.md` §4）」 |
| D-指标建档 | 四项指标基线 | 保持 `- [ ]` + 「证据待补（Nest `/metrics` 无 pi_runtime_plan_* 暴露，见规格 §4 G4）」 |
| A-部署前核对 | 逐项核对历史 | 保持原样不动（历史时点项，不回填） |

在清单末尾追加一个「2026-11-11 取证块」小节，原文粘贴规格 §2.3 的生产数据表与 task_list 载荷样例（含时点标注），作为所有勾选项的统一证据来源。

- [ ] **Step 3: 自检勾选数与证据完备性**

Run: `grep -c "^- \[x\]" docs/ops/2026-10-09-task-tool-delivery-checklist.md`
Expected: 计数 == Step 2 矩阵中实际打勾项数（预计 ≤ 6，以实际矩阵为准）；每个 `[x]` 同行含「（证据：」字样：
Run: `grep -n "^- \[x\]" docs/ops/2026-10-09-task-tool-delivery-checklist.md | grep -cv "证据："`
Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add docs/ops/2026-10-09-task-tool-delivery-checklist.md
git commit -m "docs(ops): 回填 task-tool 交付清单生产取证（2026-11-10 快照，实证项勾选 + 其余标注证据待补）"
```

### Task 2: 总纲 §3 状态列纠偏（C4 行内追加注记）

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-task-management-module-design.md`

**Interfaces:**
- Consumes: 规格 §2.3 C4 产物断层取证；Task 1 的取证块（引用关系，无代码依赖）。
- Produces: 总纲 §3 C4 行尾的 2026-11-11 注记；Task 3 依赖该行注入后的行号。

- [ ] **Step 1: 定位 C4 状态行原文**

Run: `grep -n "2026-10-10-c4-subagent-design.md" docs/superpowers/specs/2026-10-09-task-management-module-design.md`
Expected: 命中 §3 表格 C4 行（状态列为「**已立项（2026-10-10）**：spawn_subagent 工具化自主派发 + …」）与 §7 资产地图两处；只改 §3 状态行。

- [ ] **Step 2: 行内追加注记（不改写原文）**

在 C4 行状态列末尾（`；一期不依赖 C1-B（只读语义下依赖环消解，见该 spec §4-5）`之后）原位追加：

```markdown
**；2026-11-11 生产取证注记：spawn_subagent 源码在 master 与生产镜像对应树中均在且已注册装配（config.ts/index.ts），但生产运行镜像全量搜索 0 命中、executionEvents 零调用（2026-11-10 快照 · 镜像 141d5d97，落后 master 17 提交）⇒ 未进入生产运行时，根因（构建输入 vs 部署链路）未定位，详见规格 docs/superpowers/specs/2026-11-11-task-planning-engineering-roadmap-design.md §4 G4**
```

- [ ] **Step 3: 自检纯追加**

Run: `git diff --numstat docs/superpowers/specs/2026-10-09-task-management-module-design.md`
Expected: 删除行数 0（`0<TAB>1<TAB>` 形态；行内追加不改行数）；`git diff` 中该行旧文本按序完整保留。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-09-task-management-module-design.md
git commit -m "docs(agent): 总纲 §3 C4 状态追加生产取证注记（源码在、运行时缺失，根因未定位）"
```

### Task 3: 总纲 §5 追加触发条件取证注记

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-task-management-module-design.md`

**Interfaces:**
- Consumes: 规格 §4 G4 的触发条件判定（条件①证据仍为未满足）。
- Produces: 总纲 §5 末尾新条目「2026-11-11 取证注记」；为后续 C1-B 立项评审提供时点证据锚。

- [ ] **Step 1: 定位 §5 末尾**

Run: `grep -n "红线：B→A 反向不可行" docs/superpowers/specs/2026-10-09-task-management-module-design.md`
Expected: 命中 §5 红线行；注记追加在该行之后的文件内（保持 §5 节内）。

- [ ] **Step 2: 追加带日期条目**

在 §5 末尾（红线行之后）追加：

```markdown
- **2026-11-11 取证注记（时点快照 · 镜像 141d5d97）**：触发条件①证据仍为**未满足**——spawn_subagent 生产 executionEvents 零调用（全量 0 次）且生产运行镜像全量搜索 0 命中（源码在 master，运行时缺失，根因未定位）；触发条件②未见产品侧立项要求。C1-B 立项判定仍按本节字面执行，本注记只记证据不改判定。数据来源与边界见 docs/superpowers/specs/2026-11-11-task-planning-engineering-roadmap-design.md §2.3/§4。
```

- [ ] **Step 3: 自检「不提前解锁」**

Run: `grep -n "C1-B" docs/superpowers/specs/2026-10-09-task-management-module-design.md | tail -5`
Expected: 新注记行不含「可立项 / 满足触发条件 / 解锁」字样，且明确写「仍按本节字面执行」。
Run: `git diff --numstat docs/superpowers/specs/2026-10-09-task-management-module-design.md`
Expected: 累计删除行数仍为 0。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-09-task-management-module-design.md
git commit -m "docs(agent): 总纲 §5 追加 2026-11-11 触发条件取证注记（条件①②均未满足，只记证据）"
```

### Task 4: plan-gate 规格状态行纠偏

**Files:**
- Modify: `docs/superpowers/specs/2026-10-10-plan-gate-design.md`

**Interfaces:**
- Consumes: 规格 §4 G5（`draft-review` 与 PR #329 已合事实不一致）。
- Produces: 状态行注记；消除「规格 draft、代码已合」漂移。

- [ ] **Step 1: 定位状态行原文**

Run: `grep -n "status: draft-review\|状态" docs/superpowers/specs/2026-10-10-plan-gate-design.md | head -5`
Expected: 头部状态行（取证报告记录为 `:6`，`status: draft-review`）。

- [ ] **Step 2: 行内追加事实注记（保留原状态字段不删除）**

在状态行后追加一行（不改原行）：

```markdown
> 2026-11-11 状态纠偏注记：本文状态字段 `draft-review` 为历史时点残留；实现事实为**已实现（2026-10-10，PR #329 squash=`f459d1f9`，合入 master 历史）**，模块全景（`2026-10-09-task-management-module-design.md` §3 C3）已记「已实现」。原状态字段保留不改写，以本注记为准。
```

- [ ] **Step 3: 自检**

Run: `git diff docs/superpowers/specs/2026-10-10-plan-gate-design.md | grep "^-" | grep -v "^---"`
Expected: 无删除行（`---` 为 diff 头，排除后应为空）。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-10-plan-gate-design.md
git commit -m "docs(agent): plan-gate 规格状态行追加纠偏注记（draft-review 为历史残留，实现已合 #329）"
```

### Task 5: 分支核对、开 PR、docs-only 判据验证

**Files:**
- Create: 无（PR 描述）；分支 `docs/task-planning-roadmap`

**Interfaces:**
- Consumes: Task 1–4 的四个 commit。
- Produces: 待合并 PR；合并后的 docs-only 零发布证据链。

- [ ] **Step 1: 全分支自检**

Run: `git diff master --name-only`
Expected: 全部为 `.md` 文件，恰为 3 个文件（交付清单 / 总纲 / plan-gate 规格）+ 本计划与规格 2 个新文件 = 5 个 `.md`。
Run: `git diff master --numstat | awk '$2!=0{print}'`
Expected: 除交付清单勾选翻转外无删除行；若出现删除行，回到对应 Task 检查。

- [ ] **Step 2: 推分支并开 PR（正文回读长度）**

```bash
git push -u origin docs/task-planning-roadmap
```

PR 正文直接内联（不用 `@文件路径` 引用），要点：规格 + 计划链接、三个回填动作摘要、Review Focus 五条的自检结果、时点标注（2026-11-10 快照 · 镜像 141d5d97 落后 17 提交）。创建后回读 body：

```bash
gh pr view --json body --jq '.body | length'
```
Expected: 长度 > 0 且与撰写内容一致（防静默丢内容）。

- [ ] **Step 3: 等 PR CI 全绿**

Run: `gh pr checks --watch`
Expected: `pull_request` 流水线全绿（verify-claims / verify-links 以干净 checkout 为权威；本地脏工作树假红不作为证据）。

- [ ] **Step 4: 合并（需用户单独授权）与零发布确认**

用户授权后 squash 合并。合并后确认 docs-only 零发布：

Run: `gh api repos/sev7n4/pi-lnk/actions/runs?event=push&per_page=3 --jq '.workflow_runs[] | .head_sha[0:8]+" | "+.name+" | "+.status'`
Expected: 该 master 合并提交**无 deploy run / 无 ci run**（paths-ignore `**/*.md` 生效为预期）；权威证据 = PR CI 全绿 + 合并 tree == 已验证 PR head tree（`gh api repos/sev7n4/pi-lnk/compare/<pr-head>...master --jq '.ahead_by'`，预期 `0` 或仅含后续 docs 提交）。

- [ ] **Step 5: 规格状态推进（人工步骤）**

用户评审拍板后，把规格 `2026-11-11-task-planning-engineering-roadmap-design.md` 头部状态由「待评审」手工改为「已拍板（<日期>）」，并在总纲 §7 资产地图按其维护规则追加本文索引行。此步骤不由 agent 自动执行。

---

## 后续立项队列（不在本计划内，各自独立 spec → plan → implementation）

1. 阶段 A-2「任务快照稳定 id + `applyIncremental` fold」（先按总纲 §5 字面判定 C1-B，再独立成文）；
2. 阶段 A-3「`propose_plan` 摘要 `assumptions[]` 字段」；
3. 阶段 B-1/B-2/B-3「`setActiveTools` 只读切换 / `EntryProjector` 注入 / `promptGuidelines` 下沉」三刀；
4. 阶段 B-4「C4 产物断层根因定位 + 上线决策门」；
5. 阶段 C「canvas 拆解 eval 集 / `acceptance`·`dependsOn` / upmerge 映射表」。

## Self-Review 记录

- 规格覆盖：§8 验收 1–4 项逐条映射到 Task 1（验收 1）、Task 2/3/4（验收 2）、Task 5 Step 3（验收 3）、Task 5 Step 4（验收 4）；§7 状态推进映射 Task 5 Step 5。无缺口。
- 占位符扫描：判定矩阵中「有生产样本则勾并附证据；无则证据待补」为**有判据的条件分支**，非 TBD；代码步骤无占位。
- 类型一致性：不适用（docs-only），文件路径均已用 grep 步骤先行定位。
- Review Focus：五条均落 Task 1–5 的自检步骤（虚勾计数 / 删除行断言 / 数字口径 grep / 解锁字样 grep / verify-links 权威口径）。
