# `isMobileLayout` 读取域棘轮门禁 · 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在逐处搬迁 22 处 `isMobileLayout` 之前，补一条零外部依赖、确定性、可失败的 CI 棘轮，锁住「Content/shared 零读取」与「Shell 上限只降不升」。

**Architecture:** Python 标准库 verifier → 递归扫 `AgentSideRail.vue` / `presentation/**` / `packages/shared/**` → 分组 V1–V6 → 挂进既有 `spec-figures` job（不新建 job、不改 `package.json`）。

**True master:** 写作时 `aa4aa528`，但 ②③ 会先合并 ⇒ **每个 Task 开始前重新 `gh api` 读 master**，推前一律全树逐路径裸 blob sha 比对。`deploy.yml` 的 `push.paths` 不含 `.github/workflows/ci.yml` ⇒ 本刀合并不触发生产发布。

**Spec:** `docs/superpowers/specs/2026-11-09-is-mobile-layout-scope-gate-design.md`
**Tech Stack:** Python 3 标准库、GitHub Actions 既有 job、Mermaid 配图。

---

### Task 1: 写 verifier 并确认基线 RED

**Files:**
- 新增 `scripts/verify-is-mobile-layout-scope.py`

- [ ] **Step 1: 写 V1–V6** — V1 零外部依赖、V2 零容忍区为 0、V3 上限棘轮方向、V4 唯一定义点、V5 CI 挂载在位、V6 注释剥离有效；`strip_comments` 逐字符扫描；`--root` 支持沙箱树做行为级变异；`--json` 结构化输出。
- [ ] **Step 2: 记录基线 RED** — 只建 verifier（CI 未挂、常量未对齐）时记录失败组集合与 `exit 1`，不得先造假实现。

---

### Task 2: 挂 CI 与写 runbook

**Files:**
- 修改 `.github/workflows/ci.yml`（`spec-figures` job 追加一步，**只追加**）
- 新增 `docs/ops/2026-11-09-is-mobile-layout-scope-runbook.md`

- [ ] **Step 1: CI 一步** — 在既有门禁步骤区追加 `- name: Verify isMobileLayout scope` + `run: python3 scripts/verify-is-mobile-layout-scope.py`；不改 `package.json`、不新建 job。
- [ ] **Step 2: runbook** — env / 分组判据表 / 上限 21 的来源与只降不升语义 / 三条坑（注释假绿、单文件假绿、改 package.json 触发发布）/ 后继逐处搬的准入条件。
- [ ] **Step 3: 自举** — 本地 `python3 scripts/verify-is-mobile-layout-scope.py` ALL_PASS，且 `ci.yml` 的调用行与脚本路径逐字一致。

---

### Task 3: 变异测试（≥6 组 + 伪变异对照）

**Files:**
- 只读修改后恢复；行为级变异在 `/tmp` 沙箱树内做，**不碰真实产品代码**

- [ ] **Step 1: 六组变异** — M1 沙箱 presentation 注入读取 ⇒ V2 RED；M2 沙箱 SFC 多一处 ⇒ V3 RED；M3 删 ci.yml 挂载 ⇒ V5 RED；M4 把上限判据改成无上限 ⇒ V3 RED；M5 锚点只写注释 ⇒ 仍 RED；M6 只追加无关注释 ⇒ 对照全绿。
- [ ] **Step 2: 恢复校验** — 每条恢复后核 verifier / ci.yml / 沙箱文件裸 blob sha 与基线全等；伪变异不 RED 时按「先怀疑伪变异」纪律复核注入点是否被下游吞掉。

---

### Task 4: 全量门禁、证据与入库

**Files:**
- 新增 `docs/ops/2026-11-09-is-mobile-layout-scope-evidence.md`
- 提交 5 新增 + 1 修改

- [ ] **Step 1: 门禁** — `verify-spec-figures`（本文 0 error / 0 warning、全量 0 error）、`verify-links`、`verify-claims`、`verify-agent-rail-gates`、`verify-web-upload`、`verify-pc-visual-regression`、占位符扫描、推前逐路径 blob sha 核对。
- [ ] **Step 2: 证据** — 记录 grep 22 行 / 有效 21 点的分布、变异结果、CI 自举结果与诚实边界（**不宣称**读取已搬迁、**不宣称**新建 required check）。
- [ ] **Step 3: 推 PR / CI / squash** — Git Data 链；CI 三必需全 success 且 `Verify spec figures` 日志含本门禁步骤；合并后全树核对差异恰 6 路径；删分支；只读复核 web / `/api/health`；确认 `deploy.yml` 最近 run 不含本 master sha。
- [ ] **Step 4: 状态回填** — `Issue #755` 第 3 项登记「门禁已立、逐处搬仍待」；母规格 §15 只追加一条（若与 ③ 抢同一文件，须等 ③ 合并）；更新今日日志与 `MEMORY.md`。不追溯改写历史结论。

---

## 执行时状态回填

- 上限经实现期精算由 22（grep 行数）修正为 **21**（剥离注释后的有效读取点）；M2 伪变异实证见规格 §14。
- 母规格状态登记改由 ③ PR #792 与 `Issue #755` 承担，本刀不改母规格，避免抢同一路径。
- 7 组变异 7/7 OK（M1–M5 精确 RED、M6/M7 对照绿），恢复后 5 文件裸 blob sha 全等；V1–V6 本地 ALL_PASS。
