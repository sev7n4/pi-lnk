# Phase 2 口径澄清 · 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把母规格 §6.2「SFC 零网络调用」与 §2「不动 L0 拉流」的冲突，只追加地收敛为「L1 指令零内联调用」，零行为变更。

**Architecture:** master 源码取证 → 母规格只追加 §15.7 → `Issue #755` 同步 → 本地门禁 → `gh api` 推 PR / CI / squash / 合并树核对。

**True master:** 写作时 `aa4aa528`（PR #791 合并前）。**必须等 #791 合并后**再取新 master 作基线；两刀都改母规格，抢同一路径会丢 §15.6。本机 git 与工作树不可信，推前一律 `gh api` 全树逐路径比对裸 blob sha。

**Spec:** `docs/superpowers/specs/2026-11-09-phase2-l1-command-scope-clarification-design.md`
**Tech Stack:** Python 3 标准库（只追加校验 / blob sha）、`gh api` Git Data API、既有 docs 门禁。

---

### Task 1: 代码取证与只追加登记

**Files:**
- 只追加 `docs/superpowers/specs/2026-11-05-sse-conversation-view-unification-design.md` §15.7
- 新增 `docs/ops/2026-11-09-phase2-scope-clarification-evidence.md`

- [ ] **Step 1: 取 master 源码** — `gh api` 拉 `AgentSideRail.vue` 与 `agentCommandClient.ts`，逐条列出 5 处 `fetch`（797 通用封装 / 950 threads / 1087、1170、2060 user/messages），确认 `agentCommandClient` import 存在、`cache:'no-store'` 依赖不可回退。
- [ ] **Step 2: 只追加 §15.7** — 在 §15.6 之后追加；`SequenceMatcher` 证明 `delete_or_replace=0`，旧 blob sha 与新 master 一致。
- [ ] **Step 3: 写证据** — 登记端点表、只追加字符数、门禁结果与「口径澄清 ≠ 已上收」边界。

---

### Task 2: Issue 同步与本地门禁

**Files:**
- GitHub `Issue #755`（正文 + 评论，无仓库文件）

- [ ] **Step 1: 门禁** — `verify-spec-figures --file <本规格>` 0 error / 0 warning；全量 `verify-spec-figures` 0 error；`verify-links` exit 0；`verify-claims` 7/7；占位符零命中；`verify-pc-visual-regression.py` ALL_PASS。
- [ ] **Step 2: issue** — Phase 2 条目打勾，追加说明评论，明写 5 处 `fetch` 仍保留、未新增 CI 守卫。

---

### Task 3: 推 PR、CI 与状态回填

**Files:**
- 提交清单：规格、计划、证据（3 新增）+ 母规格（1 只追加）

- [ ] **Step 1: 推前核对** — 逐路径裸 blob sha：3 新路径在 master `ABSENT`；母规格 master blob 等于 #791 合并后的 §15.6 版本；确认零 `apps/**` / `package.json` / workflow 改动。
- [ ] **Step 2: Git Data 链** — blobs → tree（`base_tree` 用 master commit 的 tree sha）→ commit（parent 最新 master）→ ref → PR；PR 正文写明零产品代码、不挂 CI、不触发 `deploy.yml`。
- [ ] **Step 3: 合并与核对** — CI 三必需全 success 后 squash；推后/合并后全树核对差异恰 4 路径、其余零变化；删分支；只读复核 web / `/api/health`。
- [ ] **Step 4: 回填** — 追加今日工作日志与 `MEMORY.md`；母规格不追溯改写任何历史结论。

---

## 执行时状态回填

（留待实际执行后只追加登记，不改写上文。）
