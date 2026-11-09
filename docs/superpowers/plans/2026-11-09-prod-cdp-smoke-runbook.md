# CDP 五层冒烟参数化 ops runbook（路标 #4）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

spec-figures: off —— 理由：实施计划按 writing-plans 模板组织，唯一结构图已在同名 spec 的 §0 / §5 承载，计划只描述执行步骤，不重复配图。

**Goal:** 把 `/tmp` 四份一次性生产取证脚本固化为仓库内单一参数化只读入口，并把上一轮暴露的三条 CDP 环境坑做成可失败 PREFLIGHT 硬闸门。

**Architecture:** 一个 `scripts/prod-cdp-smoke.mjs` 内分 config / cdp / preflight / layers 四段；一个独立的 `scripts/verify-prod-cdp-runbook.py` 只读脚本文本做 V1–V7 源级判据；`docs/ops/2026-11-09-prod-cdp-smoke-runbook.md` 是 env 与五层判据的 SSOT。脚本零产品代码改动，L3 真实回合默认关闭，不进 CI。

**Tech Stack:** Node 24 ESM（无第三方依赖，`node:` 内置模块）、Python 3 标准库、headless Chrome DevTools Protocol、自签 HS256 JWT、`gh api` Git-Data 链、GitHub Actions（只读观察，不接线）。

**Spec:** `docs/superpowers/specs/2026-11-09-prod-cdp-smoke-runbook-design.md`
**True master:** `683b29eff67339e5d6377a0ef83ad83e54254896`（`gh api` 读取）
**执行方式:** 用户已明确「按 native 走」「继续推进」⇒ 本计划由当前会话连续执行全部 Task，不再逐阶段等待审阅。

---

## Global Constraints

- **真值来源**：本机 git 与工作树不可信；`apps/web` 是符号链接 → `/tmp/pi-lnk-master/sev7n4-pi-lnk-21056b8/apps/web`。推前用 `gh api` 取 master HEAD + 全树，逐路径比对裸 blob sha（`sha1("blob %d\0" + data)`），差异文件先从 master blob 落盘再重放改动。
- **零产品代码改动**：不改 `apps/**`、`services/**`、`charts/**`；不改 `package.json`（`deploy.yml` 的 `push.paths` 含它，改一次触发一次生产发布）；不改 `.github/workflows/**`。
- **并行工作边界**：PR #787（P1+P2，head `17d8377a`，11 文件，CI success）当前 open，由并行会话持有。本刀不合并、不修改、不覆盖其任何文件；推 PR 用 `base_tree` 只叠加自己 9 个路径。
- **提交链**：HTTPS git 被代理挡死、SSH key 不可用 ⇒ 全程 `gh api` Git-Data 链（blob → tree → commit → refs PATCH → pulls），tree entry 路径用 repo-root 相对路径；每次 `gh` 读写带 retry/backoff（曾遇 502）。
- **本机命令**：`export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH && unset NODE_OPTIONS`；Bash cwd 每条重置 ⇒ 内联 `cd <dir> &&`。
- **判据纪律**：verifier 全绿 → 逐条变异 RED 且命中预期组 → 恢复后全绿且裸 blob sha 全等；变异不 RED 先怀疑伪变异；注释伪变异必须仍全绿。源级断言前一律 `stripComments`。
- **只追加**：三份既有文档衔接只允许字符级 `insert`，禁 `delete` / `replace`；推前用 `difflib.SequenceMatcher` 校验，不用 `unified_diff`（表格行内插入会被误判成删改）。
- **合并**：CI 三必需（Verify spec figures / Build monorepo / Build API Docker image）全绿后 `merge_method=squash`；合并树逐文件 blob sha 核对、删分支。
- **不追溯改写** P0 报告 §6 / #3 规格 §12 / P0+P3 规格 §12 当时的历史结论，只追加状态演进。
- **不宣称** #4 已成为 CI 门禁；**不宣称**复现任何产品缺陷；默认只读模式下不向生产写回合数据。

---

## Review Focus

1. **Chrome 落在 756px 移动端断点**：合理期望是 PREFLIGHT 直接 FAIL 并给出 `innerWidth`，而不是自动改走 `.agent-panel-shell` 判据把结果刷绿。→ Task 3 P3 断言 + Task 5 变异 M4。
2. **`/json/list` 残留多个同 URL workflow tab**：合理期望是清理到唯一再取 tab，不能 `list.find()` 直接串台。→ Task 3 P2 + Task 5 变异 M2。
3. **用 `Emulation.setDeviceMetricsOverride` 改视口**：合理期望是改用 browser 级 `Browser.setWindowBounds` 并用全新 session 复核持久性。→ Task 3 P1 + Task 5 变异 M1。
4. **未设置必填 env**：合理期望是启动时明确列出缺失项并 `exit 1`，不能拿隐式默认值连到错误站点。→ Task 2 `readConfig` + Task 6 负向自检。
5. **`LNKPI_SMOKE_WRITE` 未设置**：合理期望是 L3 显示 SKIPPED、SKIP 不计入 PASS 数、不产生任何 POST 写操作。→ Task 4 分支 + Task 5 变异 M5 + Task 6 实测。

---

### Task 1: 写 verifier 的 V1–V7 判据并确认基线 RED

**Files:**
- Create: `scripts/verify-prod-cdp-runbook.py`
- Test: 自身（`python3 scripts/verify-prod-cdp-runbook.py`）

**Interfaces:**
- Consumes: 规格 §10 T1 的七组判据定义。
- Produces: `--json` 输出每组 PASS/FAIL；缺文件时 V1/V2/V3/V4/V5/V7 全 RED，`exit 1`。

- [ ] **Step 1: 写 verifier 骨架**

`stripComments()` 先剥 `//` 与 `/* */`（避免注释伪装假绿）；`read(path)` 读脚本文本；`groups` 为 V1–V7 七个函数，每个返回 `(ok, detail)`。V2 从 `re.findall(r'env\.(LNKPI_[A-Z_]+)', code)` 提取变量集合，从 runbook §2 表格提取 `` `LNKPI_*` `` 集合，断言双向相等。V3 用 `code.index('runPreflight(')` < `code.index('runLayers(')` 表达「先于判据」，并检查 `Browser.setWindowBounds`、`/json/close/`、`mobileShell`、`LNKPI_MIN_PC_WIDTH` 四个锚点。V6 扫描 `.github/workflows/` 全部 yml 不含 `prod-cdp-smoke`。

- [ ] **Step 2: 跑出基线 RED**

Run: `cd /Users/4seven/workspace/pi-lnk && python3 scripts/verify-prod-cdp-runbook.py; echo EXIT=$?`
Expected: 因 `scripts/prod-cdp-smoke.mjs` 与 runbook 尚不存在，V1/V2/V3/V4/V5/V7 报 RED、`EXIT=1`。

- [ ] **Step 3: 记录基线**

把每组失败原因写入 `docs/ops/2026-11-09-prod-cdp-smoke-evidence.md` 的「§1 判据链」表（该文件在 Task 6 补全）。

---

### Task 2: 实现 config / cdp / JWT 三段

**Files:**
- Create: `scripts/prod-cdp-smoke.mjs`（本 Task 写前三段）
- Test: `node --check scripts/prod-cdp-smoke.mjs`

**Interfaces:**
- Consumes: 规格 §5 env 表、§8 四个纯函数签名。
- Produces: `readConfig(env)`、`mintJwt(cfg)`、`dedupeTabs(list, sessionId)`、CDP 连接封装，供 Task 3/4 调用。

- [ ] **Step 1: 写 `readConfig`**

```js
export function readConfig(env) {
  const required = ['LNKPI_BASE_URL', 'LNKPI_SESSION_ID', 'LNKPI_JWT_SUB']
  const missing = required.filter((k) => !env[k])
  if (missing.length) throw new Error('missing required env: ' + missing.join(', '))
  const num = (k, d) => { const v = Number(env[k] ?? d); if (!Number.isFinite(v) || v <= 0) throw new Error('invalid numeric env: ' + k); return v }
  return {
    base: env.LNKPI_BASE_URL.replace(/\/$/, ''),
    sessionId: env.LNKPI_SESSION_ID,
    sub: env.LNKPI_JWT_SUB,
    sshHost: env.LNKPI_SSH_HOST ?? 'deploy-cvm',
    apiContainer: env.LNKPI_API_CONTAINER ?? 'lnkpi-api',
    cdpHost: env.LNKPI_CDP_HOST ?? '127.0.0.1',
    cdpPort: num('LNKPI_CDP_PORT', 9223),
    width: num('LNKPI_VIEWPORT_WIDTH', 1440),
    height: num('LNKPI_VIEWPORT_HEIGHT', 900),
    minPcWidth: num('LNKPI_MIN_PC_WIDTH', 767),
    tokenFile: env.LNKPI_TOKEN_FILE ?? '/tmp/lnkpi-smoke-token',
    shotDir: env.LNKPI_SHOT_DIR ?? '/tmp/lnkpi-smoke-shots',
    write: env.LNKPI_SMOKE_WRITE === '1',
    probeText: env.LNKPI_PROBE_TEXT ?? '生产只读冒烟探针：请只回复一行纯文本 SMOKE-OK，不要生成图片，不要改动画布。',
    pollLimitMs: num('LNKPI_POLL_LIMIT_MS', 180000),
    shareId: env.LNKPI_SHARE_ID ?? '',
  }
}
```

- [ ] **Step 2: 写 `mintJwt`**

用 `execFileSync('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=12', cfg.sshHost, 'docker exec ' + cfg.apiContainer + ' printenv JWT_SECRET'])` 取 secret，断言长度 ≥ 32；`createHmac('sha256', secret)` 签名 `base64url(header).base64url(payload)`；`iat/exp` 用 `Math.floor(Date.now()/1000)` 与 `+3600`；写入 `cfg.tokenFile` 并 `chmodSync(..., 0o600)`。secret 与 token 都不 `console.log`。

- [ ] **Step 3: 写 `dedupeTabs` 与 CDP 封装**

`dedupeTabs` 返回 `{ keep, close }`，匹配 `t.url.includes('/workflow/' + sessionId)`；CDP 封装提供 `connect(wsUrl)`、`send(method, params)`（带 30s 超时与 id 映射）、`evalJs(expression)`、事件数组收集、`close()`。

- [ ] **Step 4: 语法检查**

Run: `cd /Users/4seven/workspace/pi-lnk && export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH && node --check scripts/prod-cdp-smoke.mjs`
Expected: 无输出、`EXIT=0`。

---

### Task 3: 实现三条 PREFLIGHT 硬闸门

**Files:**
- Modify: `scripts/prod-cdp-smoke.mjs` 追加 `runPreflight(cdp, cfg)` 与 `assertPcViewport(probe, minWidth)`
- Test: `python3 scripts/verify-prod-cdp-runbook.py --only V3`

**Interfaces:**
- Consumes: Task 2 的 CDP 封装与 cfg。
- Produces: `runPreflight` 在失败时抛错并由 main 捕获转 `exit 1`；verifier V3 三个锚点齐备。

- [ ] **Step 1: P1 窗口宽度（browser 级、新 session 复核）**

在 page session 上 `Browser.getWindowForTarget` 取 `windowId`，再 `Browser.setWindowBounds({ windowId, bounds: { width: cfg.width, height: cfg.height } })`；**关闭该 ws、另开一个全新 session** 复核 `innerWidth >= cfg.minPcWidth`，不满足抛错。脚本中不出现 `Emulation.setDeviceMetricsOverride`。

- [ ] **Step 2: P2 tab 唯一**

`fetch('http://<cdpHost>:<cdpPort>/json/list')` → `dedupeTabs` → 对 `close[]` 逐个 `PUT /json/close/<id>` → 重新枚举断言匹配数恰好 1；为 0 时 `PUT /json/new?<url>` 创建。禁止裸用 `list.find(...)` 取目标 tab。

- [ ] **Step 3: P3 PC 布局断言**

`Page.addScriptToEvaluateOnNewDocument` 注入 `localStorage.token` → `Page.navigate` 到 `<base>/workflow/<sessionId>` → 等 `Page.loadEventFired` + 固定 7s → 探针取 `{ innerWidth, mobileShell, fabPresent, asidePresent }`。`assertPcViewport` 要求四项全满足，否则抛错并打印实测值（不静默换判据）。

- [ ] **Step 4: verifier V3 定向**

Run: `cd /Users/4seven/workspace/pi-lnk && python3 scripts/verify-prod-cdp-runbook.py --only V3`
Expected: `V3 PASS`。

---

### Task 4: 实现 L0–L4 五层判据、L3 opt-in 与汇总

**Files:**
- Modify: `scripts/prod-cdp-smoke.mjs` 追加 `runLayers(...)` / `summarize(checks)`
- Create: `docs/ops/2026-11-09-prod-cdp-smoke-runbook.md`
- Test: `python3 scripts/verify-prod-cdp-runbook.py`

**Interfaces:**
- Consumes: Task 3 已注入 token 的页面、cfg、CDP 事件数组。
- Produces: `checks[]`（每项 `{ id, layer, status, detail }`）、`summarize` 的 `{ pass, fail, skip, exitCode }`；runbook §2 env 表与 §4 判据清单。

- [ ] **Step 1: L0 四项 / L1 五项**

L0 用 `fetch(cfg.base + '/')` 读 index.html，正则提取入口 `.js` / `.css`，各自 GET；从入口 JS 提取 `CanvasPage-*.js` 至少一个 GET。L1 用 `mintJwt` 的 token 带 `Authorization` + `Cache-Control: no-cache` + `Accept-Encoding: identity` 请求五个只读端点，判据按规格 §6。

- [ ] **Step 2: L2 A 组 10 项 + B 组 9 项**

A 组从 CDP 事件数组统计 `Runtime.exceptionThrown` / console error / `Network.responseReceived status=304` / loadingFailed，从 DOM 探针取 `appChildren` / `bodyTextLen` / `href` / 登录文案 / 错误横幅 / token 注入 / 内容元素计数。B 组点 `button.agent-fab` 等 3s，取 `asideWidth`、`shellDisplay`、`fabStillPresent`、可见 turn / bubble / 消息操作按钮 / 聊天滚动区、composer 与发送按钮数。

- [ ] **Step 3: L3 分支（默认 SKIPPED）**

```js
if (!cfg.write) {
  checks.push({ id: 'L3', layer: 'L3', status: 'SKIP', detail: 'LNKPI_SMOKE_WRITE != 1，只读模式' })
} else {
  // C 组 13 项：注入 composer → 点 .dock-generate-btn → 轮询 owner 流 finalize
  // → 再取 ack / SSE / DOM 快照；SKIP 分支绝不产生任何 POST
}
```

C 组 13 项 id 为 `C1_post_made` … `C13_composer_cleared`，与 P0 报告 §2 逐项同名。

- [ ] **Step 4: L4 与汇总**

L4 取 `.vue-flow__node` / `.vue-flow__edge` 可见数；`cfg.shareId` 非空时经 SSH 在 CVM 本机 curl `/share/<id>.html` 判 200 + doctype + 内联 style，否则该项 `SKIP`。`summarize` 逐条打印 `PASS/FAIL/SKIP`，任一 FAIL ⇒ `exitCode=1`；SKIP 不计入 pass。截图写 `cfg.shotDir`。

- [ ] **Step 5: 写 runbook**

`docs/ops/2026-11-09-prod-cdp-smoke-runbook.md` 含 §1 适用与不挂 CI 声明、§2 env 表（16 个变量，与 `env.LNKPI_*` 双向一致）、§3 三条坑与首轮 FAIL 的取证解释、§4 五层判据清单（L0 4 / L1 5 / L2 19 / L3 13 / L4 ≥2）、§5 退出码与样例命令、§6 证据链索引。

- [ ] **Step 6: 全量 verifier**

Run: `cd /Users/4seven/workspace/pi-lnk && python3 scripts/verify-prod-cdp-runbook.py; echo EXIT=$?`
Expected: `V1..V7` 全 PASS、`EXIT=0`。

---

### Task 5: 规格 / 计划文档衔接、verifier 变异与本地全门禁

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-agent-siderail-p4-gates-design.md` §12（只追加）
- Modify: `docs/superpowers/specs/2026-11-08-agent-observer-refusal-exempt-design.md` §12（只追加）
- Modify: `docs/ops/2026-11-08-phase3-prod-smoke.md` §6（只追加）
- Test: 变异脚本 + 五项 verifier

**Interfaces:**
- Consumes: Task 4 全绿状态。
- Produces: 8 条变异的 RED 记录、全门禁记录、推前核对输入。

- [ ] **Step 1: 三处只追加**

在 #3 规格 §12 追加「#4 已由 2026-11-09 参数化 runbook 承接」状态行；在 P0+P3 规格 §12 追加同型状态行；在 P0 报告 §6 追加第 4 条索引（第 3 条历史修订文字一字不动）。跑字符级 `SequenceMatcher` 校验：`delete_or_replace=0`。

- [ ] **Step 2: 跑 12 条变异**

对 `scripts/prod-cdp-smoke.mjs`、runbook 与 `.github/workflows/ci.yml` 做 M1 删 `Browser.setWindowBounds`、M2 删 `/json/close/`、M3 把 `runPreflight` 调用移到 `runLayers` 之后、M4 把移动端断言改成静默放行、M5 把写开关条件恒真、M6 塞回硬编码生产地址、M7 把关键锚点只写进注释、M8 把 runbook env 变量名改掉、M9 删一条 L0 判据、M10 把脚本命令挂进 CI、M11 删 runbook 的 756px 实证（全文替换）、M12 只追加一行无关注释。Expected: M1/M2/M3/M4/M7 ⇒ 仅 V3 RED；M5 ⇒ 仅 V4；M6 ⇒ 仅 V1；M8 ⇒ 仅 V2；M9 ⇒ 仅 V5；M10 ⇒ 仅 V6；M11 ⇒ 仅 V7；M12 ⇒ 全组仍绿。每条恢复后三个文件的裸 blob sha 全等。

- [ ] **Step 3: 本地全门禁**

```bash
cd /Users/4seven/workspace/pi-lnk
export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH && unset NODE_OPTIONS
pnpm -s verify-spec-figures --file docs/superpowers/specs/2026-11-09-prod-cdp-smoke-runbook-design.md
pnpm -s verify-spec-figures
pnpm -s verify-links
pnpm -s verify-claims
pnpm -s verify-agent-rail-gates
pnpm -s verify-web-upload
python3 scripts/verify-prod-cdp-runbook.py
grep -nE "TB""D|TO""DO|待""填|稍""后""补|implement ""later" \
  docs/superpowers/specs/2026-11-09-prod-cdp-smoke-runbook-design.md \
  docs/superpowers/plans/2026-11-09-prod-cdp-smoke-runbook.md || echo NO_PLACEHOLDERS
```

Expected: 全量 0 error（2 个既有历史 warning 不动）、本文 0 error / 0 warning、claims / rail-gates / web-upload 保持既有全绿计数、`NO_PLACEHOLDERS`。

---

### Task 6: 真实生产只读行为级验收

**Files:**
- Create: `docs/ops/2026-11-09-prod-cdp-smoke-evidence.md`

**Interfaces:**
- Consumes: Task 4 的入口脚本、Task 5 全绿状态。
- Produces: 一次 `exit 0` 的只读实测记录与截图路径。

- [ ] **Step 1: 起独立 Chrome**

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --no-sandbox --disable-gpu \
  --remote-debugging-port=9223 --window-size=1440,900 \
  --user-data-dir=/tmp/lnkpi-smoke-chrome about:blank > /tmp/lnkpi-smoke-chrome.log 2>&1 &
```

`/json/version` 轮询到就绪；若端口已有实例，先 `/json/list` 关闭遗留 workflow tab。

- [ ] **Step 2: 负向自检（必填 env 缺失）**

Run: `cd /Users/4seven/workspace/pi-lnk && env -u LNKPI_BASE_URL -u LNKPI_SESSION_ID -u LNKPI_JWT_SUB node scripts/prod-cdp-smoke.mjs; echo EXIT=$?`
Expected: 明确列出 3 个缺失项、`EXIT=1`，不连任何站点。

- [ ] **Step 3: 只读正式跑**

```bash
cd /Users/4seven/workspace/pi-lnk
LNKPI_BASE_URL=http://119.29.173.89:8888 \
LNKPI_SESSION_ID=cmw56hqit00nck801povzca3e \
LNKPI_JWT_SUB=cmrn3ghmt000hpi01fdl0gkjp \
node scripts/prod-cdp-smoke.mjs
```

Expected: PREFLIGHT P1/P2/P3 全 PASS（`innerWidth >= 767`）；L0 4/4、L1 5/5、L2 19/19、L4 判据全 PASS；L3 `SKIPPED` 且不计 PASS；`EXIT=0`；无 POST 写操作。

- [ ] **Step 4: 写证据并关闭 Chrome**

证据文档记录实际数值、`EXIT`、截图路径、L3 SKIPPED 事实，以及「本刀不宣称复现产品缺陷」边界。用 browser 级 `Browser.close` 关闭实例。

---

### Task 7: 推 PR、CI、squash 合并与合并树核对

**Files:**
- 提交清单（9 路径）：新规格、新计划、新 runbook、新证据、2 个脚本、3 份只追加衔接文档。

**Interfaces:**
- Consumes: Task 5/6 全绿记录与 master `683b29ef` 全树。
- Produces: PR、squash 后的新 master、合并树逐文件 blob sha 全等。

- [ ] **Step 1: 推前核对**

`gh api` 取 master 全树 → 对 9 个路径逐一比较本地裸 blob sha：新增文件应为 `ABSENT`；3 份衔接文档必须满足字符级 `SequenceMatcher` 只允许 `equal`/`insert`、`delete_or_replace=0`；确认 `charts/` / `services/` / `apps/` / `package.json` / workflows 均不在清单内。

- [ ] **Step 2: 建 blob/tree/commit/ref/PR**

`POST /git/blobs` 逐文件（base64）→ `POST /git/trees` 带 `base_tree=<master tree>` 只叠加 9 路径 → `POST /git/commits`（parent 为 master HEAD）→ 创建分支 ref → `POST /pulls`。PR 正文写明零产品代码改动、不挂 CI、PR #787 未触碰。

- [ ] **Step 3: 等 CI 三必需并合并**

轮询 `Verify spec figures` / `Build monorepo` / `Build API Docker image` 全 `success` 后 `PUT /pulls/<n>/merge` 用 `merge_method=squash`；合并后取新 master 全树，对 9 路径逐一比裸 blob sha；删分支；`curl` 复核 web / `/api/health` 200（本刀不改前端产物，不应触发部署）。

- [ ] **Step 4: 日志收尾**

创建 `.workbuddy/memory/2026-11-09.md` 追加本刀全链路结论，并明确 PR #787 仍 open、本刀未触碰；更新 `MEMORY.md` 中 #4 状态与「CDP 三条坑」判据。

---

## 执行时状态回填（2026-11-09 10:15）

- 文首 `True master: 683b29eff…` 及 Task 6/7 中的 `683b29ef` 为**写作时点基线**，按「不追溯改写历史结论」原样保留。
- 实际推 PR 时 master 已前移至 `6d1f6936c9a2d56ed16e19300c075607dd84139d`（PR #787 于 2026-11-08 17:18Z 合入）。`python3 /tmp/runbook_push.py --check` 实证 `MASTER_MOVED_SAFE`：9 个路径在新旧 master 的 blob 完全一致，3 处只追加文档 `delete_or_replace=0`（+429 / +247 / +346 字符）。故 Task 7 Step 2 的 parent 与 `base_tree` 改用新 HEAD，其余步骤不变。
- Task 7 Step 2「PR #787 未触碰」仍成立（其 12 个改动文件与本刀 9 路径零重叠）；Step 4「PR #787 仍 open」按执行时点改为「已合入 `6d1f6936`」。
- 本轮范围外、单列后续议题：PR #625（SP-E 画布并发 CAS v2 规格，待评审）、A-6 真机复测（需用户设备与确认）。
