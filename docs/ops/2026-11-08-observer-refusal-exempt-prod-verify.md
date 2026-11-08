# P0+P3 修复固化刀：生产部署与行为验收报告

状态：已完成（2026-11-08）
对应规格：`docs/superpowers/specs/2026-11-08-agent-observer-refusal-exempt-design.md`
对应计划：`docs/superpowers/plans/2026-11-08-agent-observer-refusal-exempt.md`
交付：PR **#785**，squash merge **`51d187591b711cf74c9d1cc1c718984d18a1857f`**（master HEAD），分支 `phase4/observer-refusal-exempt-20261108` 已删。
前置状态：#3 P4 门禁化（PR #783 / #784，master `45568b8c`）。

## 1. 验收范围与前提

| 项 | 值 |
| --- | --- |
| 生产入口 | `http://119.29.173.89:8888`（nginx :8888 → 127.0.0.1:5100） |
| 部署 run | `42483342773`，`Deploy web to CVM` 13:06:28Z→13:10:27Z，**3m59s**，整体 `success`；`Build API on CVM` 按 paths 跳过 |
| 发布目录 | `/opt/lnkpi/web/dist`，`index.html` mtime `2026-11-08 21:07:36 +0800` / 3635 B |
| 主 bundle | `CanvasPage-lQRMDP9d.js` 1,237,631 B（部署前为 `CanvasPage-B8laxs4J.js` 1,237,599 B） |
| 鉴权 | `ssh deploy-cvm "docker exec lnkpi-api printenv JWT_SECRET"` 读密钥到内存（不落盘不回显）→ Python `hmac-sha256` 自签 HS256 `{sub,iat,exp}` 1h → `Bearer` |
| 隔离探针会话 | `cmw56hqit00nck801povzca3e`（userId `cmrn3ghmt000hpi01fdl0gkjp`） |
| 浏览器 | 独立 headless Chrome `--headless=new --no-sandbox --disable-gpu --remote-debugging-port=9223`，Node 原生 `WebSocket` 直连 CDP，`Page.addScriptToEvaluateOnNewDocument` 注入 `localStorage.token` |

## 2. 部署链证据（#2 增量上传链路回归）

`gh api` 取 `actions/jobs/128739838126/logs` 的实测标记：

```
2026-11-08T13:07:44Z UPLOAD_MODE=incremental
2026-11-08T13:09:57Z MANIFEST_OK files=163
2026-11-08T13:10:00Z WEB_DIST_UPLOAD_OK
```

CVM 侧：`/tmp/lnkpi-web-manifest.sha256` **163 行**，在 `/opt/lnkpi/web/dist` 下 `sha256sum -c` **exit 0**（抽样输出 `./favicon.svg: OK` / `./index.html: OK`）；`web=200` / `api=200`。无 rerun、无手动兜底、无回退到 legacy scp。

## 3. 部署源正确性（本刀最有针对性的判据）

按 `delivery.md` 的教训「凡部署后报某已修复功能又坏了 → 先疑部署源落后」，本刀用生产 bundle 的**源码形态对照**证明新代码确实上线，而不只依赖「页面没报错」：

| 形态 | 部署前 `CanvasPage-B8laxs4J.js` | 部署后 `CanvasPage-lQRMDP9d.js` |
| --- | --- | --- |
| `turnRefusal` 出现次数 | 3（既有 callout 渲染 / store 引用） | 存在，且新增否定守卫 |
| `!x.turnRefusal` 否定守卫 | **0 个** | **2 个**：`!o.turnRefusal`、`!u.turnRefusal` |
| `callId` 出现次数 | 未单独计 | 15 |

两个否定守卫精确对应本刀 P0 的两处改动（`useAgentObserver.ts` 的 `finishOwnTurnViaObserver` 与 `AgentSideRail.vue` 的 off 模式 `finally`）。部署前采集命令：

```bash
ssh deploy-cvm 'cd /opt/lnkpi/web/dist/assets && grep -ohE "![A-Za-z_\$][A-Za-z0-9_\$]*\.turnRefusal" *.js | sort -u'
```

⇒ 结论：**部署源是 true master `51d18759`，不是落后的 feature worktree**，也没有回退并行 PR 的改动（163 文件清单校验 + 合并树 11 文件 blob sha 全等）。

## 4. 只读契约（自签 JWT，`/tmp/p0_probe.py`）

`READ_ONLY_CONTRACT PASS`：

| 端点 | 结果 |
| --- | --- |
| `/api/health` | 200 `{"ok":true,...}` |
| `/api/sessions` | 200，data 417 项 |
| `/api/agent/chat/threads` | 200，data 1 项 |
| `/api/agent/chat/user/messages` | 200，data 74 项（回合前基线） |
| `/api/agent/runtime-health` | 200 `latencyMs=19` |
| `/api/agent/thread-state` | **404，已知不存在**，按 P0 报告惯例既不计 PASS 也不计 FAIL |

## 5. CDP 三层判据：首轮、诊断、修正后

### 5.1 首轮（结果保留，不追溯改写）

| 层 | 结果 | 说明 |
| --- | --- | --- |
| L0 页面加载 | **10/10 ALL_PASS** | SPA 挂载、非白屏、无 pageerror、无 304、token 注入、无登录跳转 |
| L2 侧栏展开 | **8/9 HAS_FAILURE** | `B1_rail_expanded` FAIL（`asideWidth=0`）；B2–B9 全 PASS |
| L3 真实回合 | **12/13 HAS_FAILURE** | `C12_rail_still_open` FAIL（`railWidth=0`）；C1–C11、C13 全 PASS；`PAGE ERROR DETAILS []`、`consoleErrors []` |

首轮真实回合本身是成功的：ack `{"code":0,"data":{"accepted":true,"sinceSeq":24627}}`、owner 流 6,114 B、7s finalize、新 assistant 消息 `P0-SMOKE-OK-2`、DOM turn 72→74。

### 5.2 两处 FAIL 的根因诊断（取证环境，非产品回归）

1. **视口落在移动端断点**：`/tmp/p0_session_open.png` 显示「创作空间」顶栏 + 底部「对话/画布/发现/我的」tab，即 `components/mobile/` 的移动端壳层。CDP 量化：`innerWidth=756`（< 767）、`mobileShell=true`、PC 的 `button.agent-fab` **不存在**、`aside.agent-side-rail` 宽度 0，但 `.agent-panel-shell` 宽 756 且 `display:flex`、74 个 `.agent-turn` 全部可见。⇒ `asideWidth > 100` 这个 PC 专属判据在该形态下不适用；B2–B9 全绿正说明对话能力本身正常。
2. **`Emulation.setDeviceMetricsOverride` 是 session-scoped**：在临时脚本里设为 1440×900 后探针立刻读回 `innerWidth=1440`、`fab` 出现、`panel.display=none`（PC 默认收起态），但脚本 `ws.close()` 后 override 随 session 失效，后续脚本仍看到 756。
3. **残留多 tab 串台**：`/json/list` 里存在 **2 个同 URL 的 workflow tab**，各脚本都用 `find(...)` 取第一个，容易连到非预期的那个。
4. `ps` / `pkill` 在本机沙箱返回 `Operation not permitted`，无法靠杀进程重启 Chrome 改窗口；改用 CDP **`Browser.setWindowBounds`**（browser 级、对所有 session 持久），窗口 756×556 → **1440×813**。

### 5.3 修正后的最终判据（PC 窗口 + 清理残留 tab）

| 层 | 结果 | 关键量 |
| --- | --- | --- |
| L0 页面加载 | **10/10 ALL_PASS** | — |
| L2 侧栏展开 | **9/9 ALL_PASS** | `asideClass="agent-side-rail shrink-0 overflow-visible is-docked-open"`、`asideWidth=500`、`shellRect=[0,0,499,813]`、`fabStillPresent=false`、76 turn / 76 bubble / **266 个 `.agent-msg-action-btn`** 可见、`bodyTextLen=11373` |
| L3 真实回合 | **13/13 ALL_PASS** | ack `accepted:true` (`sinceSeq=24715`)、owner 流 6,073 B、7s finalize、DOM turn 76→**78**、`railWidth=500`、composer 清空、`PAGE ERROR DETAILS []`、`consoleErrors []` |

修正动作可复现命令：

```bash
node /tmp/p0p3_browser_bounds.mjs      # Browser.setWindowBounds → 1440×900
# 关闭所有 /json/list 里的 /workflow/ tab，避免 find() 串台
node /tmp/p0_cdp.mjs && node /tmp/p0_open_rail.mjs && node /tmp/p0_send.mjs
```

⚠️ 上面的「修正」只改变**取证环境**（窗口尺寸与 tab 数量），未改动任何生产代码、判据阈值或产品配置；首轮 8/9 与 12/13 的原始结果如实保留在 §5.1，不追溯改写。

## 6. 结论与显式边界

1. **本刀全链路闭环**：规格 → 计划 → 基线 RED（4 failed/13 passed）→ 修复 17/17 → 9 组变异（8 红 + M6 伪变异对照绿，含 M7 注释伪装守卫）→ 本地全量门禁（122 files / 1064 tests、`vue-tsc -b`、`pnpm -r build`、文档 201 篇 0 error、四项 verifier）→ PR #785 CI 三必需全 pass（run `42482274324`，12m58s）→ squash `51d18759`，合并树 11 文件 blob sha 全等 → 自动部署 success → 生产 CDP 修正后 L0/L2/L3 全绿。
2. **生产零新增异常**：首轮与修正后两轮真实回合，`Runtime.exceptionThrown` 与 console error 均为 0；F1 的 `AbortError` 未复发。
3. ⭐ **不宣称复现 steer 场景**：`turnRefusal` 需要 409 steer 窗口才能稳定构造，本次未构造。P0 的行为保证由两处源级契约（已 `stripComments` 加固）+ 本地 17/17 判据 + M7 变异承接；生产验收只覆盖「零异常 + 常规真实回合不回归 + 部署源正确」。本节**不写**「P0 行为生产 ALL_PASS」式结论。
4. ⭐ **不宣称解决 20min 死挂**：本刀只修展示层矛盾文案与多卡配对脆弱点；agent 侧批量澄清卡 / `confirmedPreferences` 去重 / 阻塞超时按默认继续（诊断 P1）与 steer 新鲜度窗口（诊断 P2）仍属 backlog，见规格 §12。
5. **#4 顺延不取消**：CDP 五层冒烟参数化 ops runbook 仍待做，仍不挂 required check。本次取证中「视口 / 多 tab 串台 / session-scoped override」三条坑应写进 #4 runbook，作为环境变量化与前置自检的准入项。

## 7. 取证文件（`/tmp`，一次性；本报告为持久结论）

| 文件 | 内容 |
| --- | --- |
| `/tmp/p0_probe.py` | 自签 JWT + 只读契约 |
| `/tmp/p0_cdp.mjs` / `p0_open_rail.mjs` / `p0_send.mjs` | L0 / L2 / L3 三层 CDP 判据 |
| `/tmp/p0p3_viewport.mjs` | 视口与侧栏元素量化探针（756 vs 1440） |
| `/tmp/p0p3_browser_bounds.mjs` | browser 级窗口边界修正 + 持久性复核 |
| `/tmp/p0p3_pc_setup.mjs` | session-scoped override 的对照实验（证明其会失效） |
| `/tmp/p0p3_push.py` / `p0p3_verify_merge.py` | Git-Data 提交链与合并树核对 |
| `/tmp/p0_session.png` / `p0_session_open.png` / `p0_after_send.png` | 收起 / 展开 / 回合后截图 |

Chrome 实例已在验收后关闭。
