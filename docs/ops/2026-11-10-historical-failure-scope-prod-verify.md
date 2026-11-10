# 历史失败分窗：生产端到端复测 runbook（2026-11-10）

规格：`docs/superpowers/specs/2026-11-10-historical-failure-scope-design.md` §11.4
目标会话：`cmw56hqit00nck801povzca3e`
性质：**只读取证**（不写生产数据）；本 runbook 是宣告闭环的前置条件（规格 R8）

> ⚠️ 上一轮的教训：以「bundle 含代码 + 推断数据形态」代替渲染取证，导致错误结论。本 runbook 要求**真的用浏览器带鉴权打开目标会话**，以 DOM 实测为准。

---

## 1. 为什么需要这份 runbook

`deploy.yml` 部署 web 产物后，`curl` 能证明代码上线，但证明不了「用户重新进入会话时黄条消失」。黄条由运行时链路产生：加载期对账 → 状态转移 → `ElMessage` → DOM。只有浏览器实跑才能观测。

---

## 2. 前置条件与 env（SSOT）

复用 `scripts/prod-cdp-smoke.mjs` 的 `readConfig` / `mintJwt` / `runPreflight`：JWT 由 `ssh deploy-cvm docker exec lnkpi-api printenv JWT_SECRET` 读出后本机自签（`sub = LNKPI_JWT_SUB`），注入 `localStorage.token`，**不写生产 DB、不消费验证码、不改用户密码**。

| 变量 | 值 / 来源 | 说明 |
| --- | --- | --- |
| `LNKPI_BASE_URL` | 生产站点根地址 | 必填 |
| `LNKPI_SESSION_ID` | `cmw56hqit00nck801povzca3e` | 本次取证会话 |
| `LNKPI_JWT_SUB` | 目标会话所属用户的 `User.id`（从 CVM DB 只读查询） | 自签 JWT 的 sub；**只读** |
| `LNKPI_SSH_HOST` | `deploy-cvm` | 默认 |
| `LNKPI_API_CONTAINER` | `lnkpi-api` | 默认 |
| `LNKPI_CDP_PORT` | `9223` | headless Chrome 调试端口 |
| `LNKPI_VIEWPORT_WIDTH` | `1440` | PC 布局（≥767，PREFLIGHT 断言） |
| `LNKPI_SMOKE_WRITE` | **必须 `0`**（默认） | 禁止向生产写真实回合 |

**只读纪律**：全程 `LNKPI_SMOKE_WRITE=0`；「点忽略」是产品既有 `saveCanvas` 行为（用户真实操作），属被测对象的一部分，不是探针写入；不额外构造生成请求、不改 DB 记录。

---

## 3. PREFLIGHT（任一不成立即 FAIL，不得继续）

| # | 判据 | 失败含义 |
| --- | --- | --- |
| P1 | Chrome `--headless=new --no-sandbox --remote-debugging-port=9223 --no-proxy-server` 可连 | 本机 HTTP 代理会拦 127.0.0.1，必须 `--no-proxy-server` |
| P2 | `/json/list` 中同 URL tab 唯一 | 残留 tab 串台会读到旧页面 |
| P3 | `innerWidth >= 767` 且无 `mobileShell`、存在 `aside.agent-side-rail` | 移动端壳层判据不同，禁止静默降级（既有 runbook R3） |
| P4 | `index.html` 引用的 `CanvasPage-*.js` hash == 部署产物 hash | 缓存旧 chunk 会让"改了没生效" |
| P5 | `mintJwt` 成功且 `/api/health` 200 | 鉴权或服务没通，后续 DOM 无意义 |
| P6 | 部署产物：`Deploy to Tencent Cloud` 对应 run conclusion=success，web dist mtime 为本次部署时刻 | 避免拿旧产物取证 |

---

## 4. 取证步骤与判据

| # | 步骤 | DOM / 数据判据 | 期望 |
| --- | --- | --- | --- |
| L1 | 打开 `/workflow/<sessionId>`，等待画布 `nodes` 渲染完成 | 页面无 JS 未捕获异常；画布节点数 = 25 | PASS |
| L2 | **黄条计数**：页面稳定后（≥对账完成 + 2s）统计 Element Plus warning message | `.el-message--warning` 数量 | **0**（改前为 4） |
| L3 | **静态标记**：4 个失败节点占位区文案 | 含「生成失败 · 可重试」的节点数 | **4** |
| L4 | **诚实性**：点开任一失败节点 ⓘ 诊断抽屉 | 可见「上游超时，请稍后重试」与退分信息 | PASS（事实仍可查） |
| L5 | **重试入口**：4 个节点角标 | 重试 / 诊断入口存在且可点 | PASS |
| L6 | **忽略**：点其中一个节点的「忽略」 | 该节点 `failureScope='dismissed'`，`Session.canvasData` 对应节点 data 出现该字段；**其余 3 节点仍 `historical`** | PASS |
| L7 | **刷新不复发**：F5 重新加载同一会话 | 黄条数仍 **0**；被忽略节点保持极简占位；其余 3 个仍是静态标记 | PASS（去重 Set 重建也不复发） |
| L8 | **无回归**：抽样一个 `completed` 节点 | 图片 URL 正常渲染、无新增错误态 | PASS |
| L9 | 截图落盘 | `Page.captureScreenshot` 输出到 `LNKPI_SHOT_DIR` | 留证 |

**取证脚本**：以 `scripts/prod-cdp-smoke.mjs` 的 `Cdp` / `evalJs` 为底座，写一次性 `/tmp/historical-failure-verify.mjs` 做 L1–L9（不入库，避免把生产地址/会话 id 字面量写进仓库 —— 既有 runbook R1）。DOM 选择器以实际页面为准，取证时先 `evalJs` 打印结构再写断言，禁止凭印象写选择器。

实现侧锚点（仅供定位，仍须先打印 DOM 再断言）：静态标记落在节点占位区 `.neo-placeholder-text`；「忽略」按钮为 `.neo-task-dismiss-btn`（`aria-label="忽略此失败提示"`）；诊断入口是左上角 `.neo-status-info-btn` 的 ⓘ（失败态直落「诊断」tab），**不是** `NodeTaskCornerActions` 的错误行 ⓘ —— 历史失败的活跃错误行已被抑制；黄条先按 `.el-message` 全量打印再按 warning 变体筛选，避免选择器变体误判 0。

---

## 5. 只读证据 vs 推断证据（分级）

| 级别 | 证据 | 能否单独宣告闭环 |
| --- | --- | --- |
| A（强） | L2 黄条 0、L3 静态标记 4、L7 刷新不复发（浏览器 DOM 实测） | **能** |
| B（中） | bundle 含 `failureScope` / `isFailureTerminalStatus` token、chunk hash 已换、`/api/health` 200 | 不能 |
| C（弱） | 「代码已合并、CI 绿、推断数据形态」 | **不能**（上一轮就是栽在这） |

只有 A 级齐备 + B 级无反证，才可宣告闭环；A 级缺项必须如实标注「未验证」，不得用 B/C 补齐。

---

## 6. 降级与诚实边界

- 若 CDP 通道不可用（Chrome 起不来 / JWT_SECRET 读不到 / 鉴权失败）：**如实报告未端到端验证**，列出已完成的 B 级证据与缺口，把闭环状态标为「待复测」，不宣告 ALL_PASS。
- 若 L2 仍 >0：回到 `systematic-debugging` Phase 1，按数据流（对账 → 状态转移 → toast → DOM）逐层加诊断，不得直接再改一版代码。
- 若「忽略」触发了非预期的画布覆盖：立即停止，核对 `saveCanvas` 的整份写入是否带来丢失（既有事故线），必要时按规格 §9 回滚顺序处理。
- 本 runbook 不重分类 92 条 `upstream_timeout`、不改退费、不删记录；这些仍属待单独授权的生产写。

---

## 7. 证据落盘清单

| 文件 | 内容 |
| --- | --- |
| `/tmp/historical-failure-verify.mjs` | 一次性 CDP 断言脚本（含 env，不入库） |
| `LNKPI_SHOT_DIR/*.png` | L1 / L6 / L7 三个时点截图 |
| `/tmp/historical-failure-verify.log` | L1–L9 逐条 PASS/FAIL + 原始 DOM 计数 |
| 工作日志 `2026-11-10.md` | 只追加回填：证据摘要 + 诚实边界 |
