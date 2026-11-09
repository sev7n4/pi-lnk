# PC 会话页自动化视觉回归套件 · 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在删除 `components/agent/presentation/` 下 1100–1450 行 PC 冗余渲染之前，交付一套确定性、可失败、零新依赖的 PC 视觉回归护栏，并把「删除刀必须附空 diff 凭据」写成准入契约。

**Architecture:** 固定 fixture → 本地页面 → headless Chrome 固定 1440×900 视口 → 三条 PREFLIGHT → 采集结构/几何/计算样式 JSON → 与 golden baseline 做确定性文本 diff → `VERDICT ALL_PASS` 作为删除刀 PR 的准入凭据。PNG 只作目视附件，不进退出码。

**True master:** `7c4066e70dfa08fc0f84886021e566ab9a49a15d`（`gh api` 读取，写作时点）。**每个 Task 开始前重新读一次 master HEAD**；本机 git 与工作树因并行会话稀疏检出不可信，推前一律用 `gh api` 取全树逐路径比对裸 blob sha（`sha1("blob %d\0" + data)`）。

**Spec:** `docs/superpowers/specs/2026-11-09-pc-visual-regression-harness-design.md`
**Tech Stack:** Node 22 全局 WebSocket + Chrome DevTools Protocol（复用 `scripts/prod-cdp-smoke.mjs` 的连接范式，不新增 npm 依赖）、Python 3 标准库写 verifier、JSON baseline、PNG 附件。

---

### Task 1: 写 verifier 的 V1–V7 判据并确认基线 RED

**Files:**
- 新增 `scripts/verify-pc-visual-regression.py`
- 参考 `scripts/verify-prod-cdp-runbook.py` 的 `strip_comments` / `function_body` / 分组结构

**Interfaces:**
- Consumes: 尚不存在的 `scripts/pc-visual-regression.mjs` 与 `docs/ops/2026-11-09-pc-visual-regression-runbook.md`（缺失即 RED）
- Produces: `python3 scripts/verify-pc-visual-regression.py` 的 V1–V7 分组判据与 `exit 1`

- [ ] **Step 1: 写基线 RED** — 只建 verifier，判据按规格 §10 T1：V1 零硬编码、V2 env 双向相等、V3 三条 PREFLIGHT 齐备且先于采集、V4 确定性双跑 sha256、V5 diff 三类与 SKIP 不计 PASS、V6 未挂 CI / 未改 package.json、V7 runbook 三条坑与准入契约。`strip_comments` 后判源级断言，防注释假绿。
- [ ] **Step 2: 记录基线** — 跑 `python3 scripts/verify-pc-visual-regression.py`，记录失败组集合与 `exit 1`；不得为了让测试通过先造假实现。

---

### Task 2: 实现采集脚本与固定 fixture

**Files:**
- 新增 `scripts/pc-visual-regression.mjs`
- 新增 `scripts/fixtures/pc-visual-fixture.json`

**Interfaces:**
- Consumes: `LNKPI_PC_BASE_URL` / `LNKPI_PC_CDP_PORT` / `LNKPI_PC_SHOT_DIR` / `LNKPI_MIN_PC_WIDTH` 等 env（V2 双向相等，变量名与 runbook 表格一一对应）
- Produces: `normalizeSnapshot()` 产出的固定键序 JSON、两次采集的 sha256、PNG 截图

- [ ] **Step 1: 三条 PREFLIGHT** — browser 级 `Browser.setWindowBounds` 设 1440×900 + 全新 session 复核 `innerWidth`；`/json/list` 枚举 + `/json/close/` 清残留 tab；PC 布局断言，移动端断点直接 FAIL。三者必须先于任何采集。
- [ ] **Step 2: 固定性与采集** — 固定 `deviceScaleFactor=1`、禁动画、`document.fonts.ready` + 两次 rAF；按规格 §6 S2 采集目标区元素，几何取整、随机 id 剔除；`normalizeSnapshot` / `diffSnapshots` 为纯函数。
- [ ] **Step 3: 负向自检** — `env -u` 去掉 3 个必填 env 后运行，必须明确列出缺失项、`exit 1`、不连任何站点。

---

### Task 3: 生成 golden baseline 并证明确定性

**Files:**
- 新增 `scripts/baselines/pc-visual-baseline.json`

**Interfaces:**
- Consumes: Task 2 的采集结果
- Produces: 独立合入、后续只读的 golden 基线

- [ ] **Step 1: 双跑一致性** — 同一 fixture 连续两次采集，`sha256` 必须相等；打印两次摘要与 `DETERMINISM_OK`。
- [ ] **Step 2: 落基线** — 把第二次采集结果写入 `scripts/baselines/pc-visual-baseline.json`，键序固定；verifier 断言该文件存在且可被 diff 脚本解析。
- [ ] **Step 3: 空 diff** — 以刚落盘的 baseline 跑一次完整流程，`diff_count=0`、`VERDICT ALL_PASS`、`exit 0`、PNG 落盘。

---

### Task 4: 写 runbook 与准入契约

**Files:**
- 新增 `docs/ops/2026-11-09-pc-visual-regression-runbook.md`

**Interfaces:**
- Consumes: 规格 §6 S6 的四项凭据要求、#4 runbook 的三条取证坑表述
- Produces: env SSOT、退出码语义、删除刀准入契约

- [ ] **Step 1: env 与判据表** — 列出全部 `LNKPI_PC_*` env（与 V2 双向相等）、五类判据计数、PREFLIGHT 三条、`exit 0/1` 语义。
- [ ] **Step 2: 准入契约** — 明写「删除刀 PR 描述必须含 `VERDICT ALL_PASS`、`diff_count=0`、两次采集 sha256、截图路径；且不得修改 `pc-visual-baseline.json`」，并写明本套件**不挂 required check** 的理由（门禁准入三问不满足）。
- [ ] **Step 3: 三条坑** — 逐条写 `innerWidth=756`、`Emulation.setDeviceMetricsOverride` 为 session-scoped、`/json/list` 重复 tab 串台的取证解释与 PREFLIGHT 对应判据。

---

### Task 5: 变异测试（≥8 组精确 RED + 1 组伪变异对照）

**Files:**
- 只读修改后恢复 `scripts/pc-visual-regression.mjs`、`scripts/verify-pc-visual-regression.py`、`docs/ops/2026-11-09-pc-visual-regression-runbook.md`

**Interfaces:**
- Consumes: Task 1–4 的全绿基线
- Produces: 每条变异的「失败组集合」与恢复后三文件裸 blob sha 全等证据

- [ ] **Step 1: 八组变异** — M1 删 `Browser.setWindowBounds` ⇒ V3 RED；M2 删 `/json/close/` ⇒ V3 RED；M3 PREFLIGHT 移到采集之后 ⇒ V3 RED；M4 双跑改单跑 ⇒ V4 RED；M5 diff 恒空 ⇒ V5 RED；M6 SKIP 计入 PASS ⇒ V5 RED；M7 PNG 像素接进退出码 ⇒ V4 或 V5 RED；M8 删 runbook 准入契约 ⇒ V7 RED；M9 把关键锚点只写进注释 ⇒ 仍 RED（证明 `strip_comments` 有效）。
- [ ] **Step 2: 对照组** — M10 只追加一行无关注释 ⇒ 全组仍绿；若伪变异不 RED 先怀疑注入点被下游过滤吞掉，按「变异不 RED 先怀疑伪变异」纪律复核。
- [ ] **Step 3: 全量替换与恢复** — 变异必须全文替换（#4 M11 曾因只替换首处造成伪变异）；每条恢复后核对三文件裸 blob sha 与基线全等。

---

### Task 6: 本地全量门禁与文档归档

**Files:**
- 本文、规格、runbook、两份基线/脚本（不改 `package.json` / workflows）

**Interfaces:**
- Consumes: Task 5 全绿记录
- Produces: 可写进 PR 描述的门禁结果清单

- [ ] **Step 1: 门禁** — `pnpm verify-spec-figures`（本文 0 error / 0 warning）、`verify-links`、`verify-claims`、`verify-agent-rail-gates`、`verify-web-upload`、占位符扫描；`node --check scripts/pc-visual-regression.mjs`；`python3 scripts/verify-pc-visual-regression.py`。
- [ ] **Step 2: 真实运行** — 独立 headless Chrome 起本地页面，仅设必填 env，记录 `DETERMINISM_OK`、`diff_count=0`、`VERDICT ALL_PASS`、`exit 0` 与截图路径；用 browser 级 `Browser.close` 收尾。
- [ ] **Step 3: 证据文档** — 写 `docs/ops/2026-11-09-pc-visual-regression-evidence.md`，记录实测数值与诚实边界：**不宣称**删除动作已完成、**不宣称**套件挂进 CI、**不宣称**覆盖移动端。

---

### Task 7: 推 PR、CI、squash 合并与状态回填

**Files:**
- 提交清单：规格、计划、runbook、证据、2 个脚本、fixture、baseline（全部新增，零产品代码改动）

**Interfaces:**
- Consumes: Task 6 全绿记录与 `gh api` 读取的最新 master 全树
- Produces: PR、squash 后的新 master、合并树逐文件 blob sha 全等、`Issue #755` P2 打勾

- [ ] **Step 1: 推前核对** — 逐路径比较本地裸 blob sha：新增文件应为 `ABSENT`；确认 `apps/**` / `services/**` / `charts/**` / `package.json` / workflows 均不在清单内；若 master 在写作后前移，先做 `MASTER_MOVED_SAFE`（本刀路径在新旧 master blob 全等）再换 parent / `base_tree`，并在规格末尾只追加「推送时基线前移」小节，不改写历史口径。
- [ ] **Step 2: 建 blob/tree/commit/ref/PR** — `POST /git/blobs` 逐文件 → `POST /git/trees` 带 `base_tree=<true master tree>` 只叠加自己路径 → `POST /git/commits`（parent 为最新 master HEAD）→ 创建分支 ref → `POST /pulls`。PR 正文写明零产品代码改动、不挂 CI、合并不触发 `deploy.yml`。
- [ ] **Step 3: 等 CI 三必需并合并** — 轮询 `Verify spec figures` / `Build monorepo` / `Build API Docker image` 全 `success` 后 `PUT /pulls/<n>/merge` 用 `merge_method=squash`；合并后取新 master 全树逐路径比裸 blob sha；删分支；只读复核 web / `/api/health` 200。
- [ ] **Step 4: 状态回填** — 在 `Issue #755` 把 P2「PC 自动化视觉回归套件」打勾并追加说明评论；在母规格 §15.4 之后只追加一条状态登记；更新 `.workbuddy/memory/2026-11-09.md` 与 `MEMORY.md` 索引。**不追溯改写**任何历史验收结论。

---

## 执行时状态回填（2026-11-09，只追加）

- Task 1 基线 RED：`V1–V7` 全 FAIL、`exit 1`（只建 verifier，无实现）；Task 2 后 `V1/V3/V4/V5` 先 RED→PASS，剩余 `V2/V6/V7` 等 runbook 与 baseline 落盘后转绿。
- Task 2/3 实现期补充：新增 `scripts/fixtures/pc-visual-page.html` 与 `scripts/fixtures/pc-visual.vite.config.mjs`，用本地 Vite 挂载**真实** `AgentPresentationHost.vue`（否则删组件不改 DOM ⇒ 伪绿）；详见规格 §14。基线 `elements=101`、`sha256=82d36fe4…`、跨进程复跑 `diff_count=0` / `VERDICT ALL_PASS` / `exit 0`。
- Task 5 变异由 8 组扩到 **11 组**（M1–M9 静态 RED、M10 对照绿、M11 行为级「少渲染一个真实组件 ⇒ `diff_nonzero` + `exit 1`」），11/11 OK，恢复后 4 文件裸 blob sha 全等。
- 本机环境坑：HTTP 代理拦截 `127.0.0.1` ⇒ Chrome 加 `--no-proxy-server`；Vite 服务必须受管后台常驻；`curl` 加 `--noproxy '*'`。
- 真值基线写作时为 `7c4066e7`，推送前须重新读 master；若前移按 Task 7 Step 1 的 `MASTER_MOVED_SAFE` 处理并在此追加登记。
