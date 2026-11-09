# 生产 CDP 五层冒烟 ops runbook（2026-11-09）

> 状态：生效。路标 #4 的交付物。**不挂 required check、不进 CI**；默认只读，只有显式开关才会向生产写真实回合数据。
> 规格：`docs/superpowers/specs/2026-11-09-prod-cdp-smoke-runbook-design.md`；计划：`docs/superpowers/plans/2026-11-09-prod-cdp-smoke-runbook.md`
> 五层判据定义 SSOT：`docs/ops/2026-11-08-phase3-prod-smoke.md` §2。

## 1. 适用与边界

适用：Phase 3 重构后，对生产会话页做一次可重复的行为回归取证（页面加载、只读契约、侧栏展开、真实回合、画布/分享）。

**不挂 CI 的理由（门禁准入三问）**：① 依赖生产 SSH 私钥、容器内 `JWT_SECRET` 与本机 headless Chrome，非零外部依赖；② 页面渲染与真实回合结果非确定性；③ L3 会向生产写真实回合数据。`docs/superpowers/specs/2026-11-08-agent-siderail-p4-gates-design.md` §3.3 的拆包结论不变：P4 只做源级确定性门禁，本 runbook 由人工按需执行。

执行前置：

1. 本机可 `ssh -o BatchMode=yes <LNKPI_SSH_HOST> 'docker exec <LNKPI_API_CONTAINER> printenv JWT_SECRET'`（secret 只在内存，不回显）。
2. 本机有独立 headless Chrome，调试端口与 `LNKPI_CDP_PORT` 一致且未被其它实例占用。
3. 已准备一个隔离测试会话（不触碰真实用户会话）。
4. 本机 Node 24（`export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH && unset NODE_OPTIONS`）。

## 2. 环境变量（SSOT）

脚本内**不含任何生产地址、站点端口、容器名、会话 id、JWT 来源的字面量**（由 `scripts/verify-prod-cdp-runbook.py` 的 V1 强制）。

| 变量 | 必填 | 默认 | 用途 |
| --- | --- | --- | --- |
| `LNKPI_BASE_URL` | 是 | — | 生产站点根地址，末尾斜杠自动去除 |
| `LNKPI_SESSION_ID` | 是 | — | 隔离测试会话 id |
| `LNKPI_JWT_SUB` | 是 | — | 自签 HS256 JWT 的 `sub` |
| `LNKPI_SSH_HOST` | 否 | `deploy-cvm` | 读取 `JWT_SECRET` 的 SSH 别名 |
| `LNKPI_API_CONTAINER` | 否 | `lnkpi-api` | 承载 `JWT_SECRET` 的容器名 |
| `LNKPI_CDP_HOST` | 否 | `127.0.0.1` | Chrome 调试地址 |
| `LNKPI_CDP_PORT` | 否 | `9223` | Chrome 调试端口 |
| `LNKPI_VIEWPORT_WIDTH` | 否 | `1440` | browser 级窗口宽 |
| `LNKPI_VIEWPORT_HEIGHT` | 否 | `900` | browser 级窗口高 |
| `LNKPI_MIN_PC_WIDTH` | 否 | `767` | PC 布局断点下限 |
| `LNKPI_TOKEN_FILE` | 否 | `/tmp/lnkpi-smoke-token` | 短时 JWT 落盘路径，权限 0600 |
| `LNKPI_SHOT_DIR` | 否 | `/tmp/lnkpi-smoke-shots` | 截图输出目录 |
| `LNKPI_SMOKE_WRITE` | 否 | `0` | 仅 `1` 才执行 L3 写操作 |
| `LNKPI_PROBE_TEXT` | 否 | 固定探针文本 | L3 发送内容 |
| `LNKPI_POLL_LIMIT_MS` | 否 | `180000` | L3 终态轮询上限 |
| `LNKPI_SHARE_ID` | 否 | 空 | 提供时才执行 L4 分享静态页判据 |

缺任一必填项 ⇒ 启动时列出缺失项并 `exit 1`，不会用隐式默认值连到错误站点。

## 3. 三条 PREFLIGHT（必须先于任何判据）

这三条来自 2026-11-08 生产 CDP 取证的真实翻车记录，详见 `docs/ops/2026-11-08-observer-refusal-exempt-prod-verify.md`。**任何一条不成立即终止，且不允许静默改判据口径。**

### P1 · 视口宽度必须 browser 级修正

Chrome 默认窗口可能落在 `innerWidth=756`（< 767 移动端壳层），此时 PC 专属的 `asideWidth > 100` 判据不适用，会假报「侧栏未展开」。

- 正确做法：`Browser.getWindowForTarget` → `Browser.setWindowBounds({ bounds: { width, height } })`，然后**关闭该 ws、另开一个全新 CDP session** 复核 `innerWidth >= LNKPI_MIN_PC_WIDTH`。
- 错误做法：`Emulation.setDeviceMetricsOverride` 是 **session-scoped**，`ws.close()` 后立刻失效；本 runbook 脚本中禁止出现该方法。
- 本机 `ps` / `pkill` 被沙箱拒绝（`Operation not permitted`），不要指望重启 Chrome 改窗口尺寸。

### P2 · 同 URL tab 必须清理到唯一

`/json/list` 可能残留 2 个以上同 URL 的 workflow tab；历史脚本用 `list.find(...)` 直接取，导致各脚本操作到不同 tab、结果串台。脚本用 `dedupeTabs` 保留首个、其余逐个 `/json/close/<id>`，导航后再复核一次唯一性。

### P3 · PC 布局断言，移动端直接 FAIL

页面加载后断言 `innerWidth >= LNKPI_MIN_PC_WIDTH`、`mobileShell === false`、`aside.agent-side-rail` 存在。若落在移动端壳层 ⇒ **FAIL 并打印实测值**，不自动切换到 `.agent-panel-shell` 判据（那会把取证环境错误伪装成产品通过）。`button.agent-fab` 的存在性只用于决定 L2 是否需要点击展开，不作为 PC 布局硬判据 —— 因为复用的 Chrome profile 可能已记住展开态。

> 历史对照：2026-11-08 首轮在 756px 下得到 L2 8/9、L3 12/13（两处 `railWidth=0`）；用 browser 级 `Browser.setWindowBounds` 改到 1440×813 并清理残留 tab 后，L0 10/10、L2 9/9（`asideWidth=500`）、L3 13/13。原始 FAIL 结果如实保留在证据文档中，未追溯改写。

## 4. 五层判据清单

| 层 | 判据数 | 内容 |
| --- | --- | --- |
| L0 | 4 | `index.html` 200 + SPA 壳、入口 JS 200、入口 CSS 200、至少一个 `CanvasPage-` 懒加载 chunk 200 |
| L1 | 5 | `/api/health`、`/api/sessions`、`/api/agent/chat/threads`、`/api/agent/chat/user/messages`、`/api/agent/runtime-health` |
| L2 | 19 | A 组 10 项（页面加载）+ B 组 9 项（点 `button.agent-fab` 展开侧栏） |
| L3 | 13 | C 组 13 项（真实回合 / ack / SSE / finalize / DOM）；**默认整层 SKIPPED** |
| L4 | 3 | 画布 `.vue-flow__node`、画布 `.vue-flow__edge`、分享静态页（第 3 项可 SKIP） |

**L3 写入闸门**：未设置 `LNKPI_SMOKE_WRITE=1` 时脚本输出 `L3_SKIPPED`，不产生任何 POST 写操作；`SKIP` 不计入 PASS 数，并在汇总里显式列出。设置后才会注入 composer、点击发送、轮询到 owner 流 finalize（**异步受理，禁止逐行读 `data:` 后立刻取快照**）、再判 13 项。

**L4 分享子判据**：需显式提供 `LNKPI_SHARE_ID`；未提供时该子判据 `SKIP` 且不计 PASS，避免「恒绿伪判据」。

## 5. 执行与退出码

启动 Chrome（独立 profile，避免串台）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --no-sandbox --disable-gpu \
  --remote-debugging-port=9223 --window-size=1440,900 \
  --user-data-dir=/tmp/lnkpi-smoke-chrome about:blank > /tmp/lnkpi-smoke-chrome.log 2>&1 &
```

默认只读跑法（推荐，不写生产）：

```bash
cd /Users/4seven/workspace/pi-lnk
export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH && unset NODE_OPTIONS
LNKPI_BASE_URL=<站点根地址> \
LNKPI_SESSION_ID=<隔离会话 id> \
LNKPI_JWT_SUB=<隔离用户 sub> \
node scripts/prod-cdp-smoke.mjs
```

需要 L3 真实回合时追加 `LNKPI_SMOKE_WRITE=1`（会向生产写 1 个回合）；需要分享页判据时追加 `LNKPI_SHARE_ID=<id>`。

输出格式逐条 `PASS` / `FAIL` / `SKIP` + detail，末尾 `VERDICT pass=… fail=… skip=… total=…`。**任一 FAIL ⇒ `exit 1`**；全部非 FAIL ⇒ `exit 0`。截图写入 `LNKPI_SHOT_DIR/prod-cdp-smoke.png`。JWT secret 与 token 永不打印、secret 永不落盘。

收尾用 browser 级 `Browser.close` 关闭实例，不要留下调试端口占用。

## 6. 证据链索引

| 文档 | 内容 |
| --- | --- |
| `docs/ops/2026-11-08-phase3-prod-smoke.md` | 五层判据原始定义与首次 P0 生产验收 |
| `docs/ops/2026-11-08-observer-refusal-exempt-prod-verify.md` | 三条 CDP 环境坑的实证记录 |
| `docs/ops/2026-11-09-prod-cdp-smoke-evidence.md` | 本 runbook 的只读实测记录 |
| `docs/superpowers/specs/2026-11-09-prod-cdp-smoke-runbook-design.md` | 13 章设计规格与图 1 |
| `scripts/verify-prod-cdp-runbook.py` | V1–V7 静态判据（零外部依赖、确定性、可失败） |

**诚实边界**：默认只读验收只覆盖 PREFLIGHT 与 L0/L1/L2/L4；L3 的代码路径由源级契约与 2026-11-08 P0 报告两轮 13/13 历史实证承接，本 runbook 的只读跑法**不宣称**复现真实回合，也不宣称复现任何产品缺陷。
