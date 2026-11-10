# PR5 移动端 isMobileLayout 收敛审计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地路线③棘轮收口裁决的文档性动作——修正错误前提的 spike 文档、更新记忆索引、明确棘轮停在 11，全程零代码、零发布。

**Architecture:** 纯文档裁决，不触碰任何产品代码；spike 文档头部标注 superseded（链接本规格），MEMORY.md 索引更正为"路线③收口于 11 / PR5 壳层已落地无待办"；spike 修正经 docs-only PR 推入 master（零发布风险）。

**Tech Stack:** Markdown 文档；REST Git Data API（`gh api`）推送 docs 改动；`scripts/verify-is-mobile-layout-scope.py` 验证 guardrail。

**Spec:** `docs/superpowers/specs/2026-11-10-pr5-mobile-isMobile-layout-convergence-design.md`

## Global Constraints

- `MAX_ALLOWED=11` 长期保留为 guardrail，不降低（spec §2 / §7）。
- 壳层边界不变：`MobileCanvasShell` 不接收 `isMobileLayout` 判断（spec §7）。
- `AgentSideRail` 保持移动端 hidden 挂载 + 部分可见（spec §7）。
- 所有 docs 改动经 PR 推入 master；`deploy.yml` 的 `push.paths` 不含 `docs/`，零生产发布（spec §3）。
- 审计基准 true master `8915f5a5`（spec header）。
- `.workbuddy/memory/` 为 gitignored 本地记忆，不进仓库 PR（spec §3 注释）。

## Review Focus

1. spike 文档未标注 superseded ⇒ 未来会话误以为"PR5 待搬 8 点"继续磨（spec R2）。
2. MEMORY.md 仍写"地板 3 / 待 PR5 收口" ⇒ 误导后续会话（spec R3）。
3. `MAX_ALLOWED` 被误降 ⇒ 破坏"停在 11"裁决（spec §7）。
4. L1272 被误删为"死代码" ⇒ 破坏桌面焦点守卫（spec §5.1）。
5. 误将分支强搬进壳层 ⇒ 破坏已钉死的壳层边界（spec §5.3）。

（每条的 pin 见对应 Task 步骤。）

---

### Task 1: 修正 spike 文档标注 superseded（G3）

**Files:**

- Modify: `docs/agent/pr5-mobile-shell-scope-spike.md`（标题下方插入警示块）

**Interfaces:**

- 无（独立文档编辑，不依赖其他 Task）

- [ ] **Step 1: 在 spike 文档标题正下方插入 superseded 警示块**

```markdown
> ⚠️ **本 spike 已被 supersede**：`docs/superpowers/specs/2026-11-10-pr5-mobile-isMobile-layout-convergence-design.md`
> 重核 true master 后推翻本文件的「从零建壳 / 搬 AgentSideRail 8 处归零到地板 3」假设——
> 壳层已落地（2026-10-20 PR5 / D-9，MobileCanvasShell.vue 573 行）、AgentSideRail 移动端仍 hidden 挂载、
> 全仓 0 处可搬壳层 / 0 处死代码。路线③棘轮**正式停在 11**（MAX_ALLOWED=11 长期保留为 guardrail）。
> **请勿再据此「继续磨 8 点」。**
```

- [ ] **Step 2: 在 spike 正文首段补注**

在 spike 现有首段后追加一句：`（⚠️ 本 spike 的「从零建壳」「搬 8 点归零到地板 3」假设已被上述收敛审计规格证伪，以下探查结论仅供历史参考，不构成待办。）`

- [ ] **Step 3: 本地保存改动，等待 Task 3 经 docs-only PR 推送**

---

### Task 2: 更新 MEMORY.md 索引（G4，本地 gitignored）

**Files:**

- Modify: `.workbuddy/memory/MEMORY.md`（路线③索引行）

**Interfaces:**

- 无

- [ ] **Step 1: 改写路线③索引行**

将现有包含"棘轮 / 移交 PR5 / 地板 3 / 待 PR5 收口"的索引行替换为：

```markdown
- ✅ **路线③ isMobileLayout 棘轮已收口于 11**（MAX_ALLOWED=11 长期保留为 guardrail，是完成态非未达标；PR #799/#801/#806/#808 合入）。**PR5 移动壳层已落地**（MobileCanvasShell.vue 573 行，2026-10-20 PR5/D-9），移动逻辑无需再迁，spike 已 superseded（见 2026-11-10 收敛审计规格）。AgentSideRail 移动端仍 hidden 挂载（onMounted 加载历史），L1272 为桌面守卫非死代码。全仓 isMobileLayout 读取 39 处（AgentSideRail 11 + CanvasPage 28），0 处可搬壳层 / 0 处死代码。
```

- [ ] **Step 2: 删除/更正任何残留的「地板 3」「待 PR5 收口」「迁移 8 点」「D 类 8 处」表述**

- [ ] **Step 3: 本地保存（`.workbuddy/memory/` 为 gitignored，不进仓库 PR）**

---

### Task 3: 推 docs-only PR（落地 Task 1 的 spike 修正）

**Files:**

- Push: `docs/agent/pr5-mobile-shell-scope-spike.md`（仅此 1 文件）

**Interfaces:**

- 无

- [ ] **Step 1: 用 REST Git Data API 推送 spike 修正**

```bash
# base = master（动态获取）；裸 blob sha 核对（sha1("blob %d\0"+data)）
# tree 仅含 docs/agent/pr5-mobile-shell-scope-spike.md 改动路径，base_tree 继承 master
# 创建 blob → tree → commit → ref 分支 → PR
```

- [ ] **Step 2: 开 PR**

标题：`docs(agent): 标注 PR5 spike 已被收敛审计规格 supersede`
正文：说明本 PR 仅修正 `docs/agent/pr5-mobile-shell-scope-spike.md` 头部（标注 superseded），零产品代码、零发布风险；关联规格 `2026-11-10-pr5-mobile-isMobile-layout-convergence-design.md`。

- [ ] **Step 3: 轮询 CI 三必需**

`Verify spec figures` / `Build monorepo` / `Build API Docker image` 全 success。

- [ ] **Step 4: squash 合并并核验**

```bash
gh pr merge <PR#> --squash --delete-branch
# 核验：合并树仅 1 路径（spike 文档 +N/-M）；最新 deploy run 仍为当前 master（docs 不触发发布）
```

---

### Task 4: 验收验证（AC1–AC4）

**Files:**

- 无（纯验证）

**Interfaces:**

- 无

- [ ] **Step 1: 跑 guardrail 验证脚本**

```bash
python3 scripts/verify-is-mobile-layout-scope.py --json
```

预期：`VERDICT ALL_PASS`；`MAX_ALLOWED = 11`；`Shell 读取点 ≤ 11`。

- [ ] **Step 2: grep 全仓读取点，确认无新增**

```bash
git grep -n "isMobileLayout" 8915f5a5 -- 'apps/web/src/**' | wc -l   # 预期仍为既有计数
```

确认 AgentSideRail 11 + CanvasPage 28，无第三文件、无新增直读。

- [ ] **Step 3: 确认文档裁决落地**

确认 spike 文档头部 superseded 块就位（Task 1）；MEMORY.md 索引更正（Task 2）；规格 `2026-11-10-...-convergence-design.md` 已落盘。
