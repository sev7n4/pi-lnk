# Phase 3 / P1 生产行为冒烟验收记录（2026-11-08）

> 这是 `docs/superpowers/specs/2026-11-08-agent-siderail-phase3-closeout.md` 中列为「未满足」的 **P0 生产行为验收**的执行证据。
> 结论口径：业务链路判据全通；但按 `docs/agent/delivery.md`「全 passed 但 Errors 非零仍算失败」纪律，**不宣告 ALL_PASS**，另列 1 项未闭环缺陷 F1。

## 1. 验收范围与前提

| 项 | 事实 |
| --- | --- |
| 验收对象 | `AgentSideRail.vue` 经 11 刀 strangler-fig 拆出的 composable 接线（Thread / Queue / Observer-SSE / Propose / Composer / MessageActions / Dock） |
| 生产前端版本 | `dd0c43e5`（#776，含全部 11 刀）；`index.html` 时间 `2026-11-08 09:42:01 +0800` |
| P1 本刀 #777 | 因 `Deploy web to CVM` 的 runner→CVM scp 持久挂死，`gh run cancel 42442096327`（conclusion `cancelled`），**新 dist 未上线**。本刀为零行为变更的死链删除，生产停 #776 无可观测差异 |
| 生产后端 | `/api/health` 200 `{"ok":true,"service":"lnkpi-api"}`（复核时刻 `2026-11-08T04:01:29Z`） |
| 隔离探针 | 会话 `cmw56hqit00nck801povzca3e`（#759 期已用的测试会话），userId `cmrn3ghmt000hpi01fdl0gkjp`；未触碰真实用户会话 |
| 鉴权 | 从容器 `lnkpi-api` 读 `JWT_SECRET`（只在内存中，不落盘不回显），自签 HS256 `{sub,iat,exp}` 1h Bearer；`AuthGuard` 契约验证通过 |
| 取证纪律 | 「纯搬运重构字符串全不变、bundle 指纹无法区分新旧」⇒ 行为级判据为唯一有效验收；`chat/conversation` 异步受理后**轮询到终态再判**，不逐行读 `data:` 后立即取快照 |

## 2. 五层判据结果

### L0 前端资源完整性（公网 HTTP）

| 判据 | 结果 |
| --- | --- |
| `GET /` | 200 / 3,635 B；`<div id="app">` SPA 壳 |
| 入口 `index-C1c9umgB.js` | 200 / 383,296 B |
| 入口 CSS `index-B2xfeKqE.css` | 200 |
| 下钻懒加载 chunk | 入口引用 48 个；`CanvasPage-zje2vIAr.js` 200 / 1,237,673 B、`AgentTurnTimeline-BpQNPPeR.js` 200 / 56,609 B、`SharePage-BT4sc-By.js` 存在 |
| 版本旁证 | chunk hash 已不同于 #759 期的 `CanvasPage-BDoQY33N.js` ⇒ 11 刀后的构建确已上线 |

结论：资源完整、无半截部署、无 404。

### L1 只读后端契约（自签 Bearer）

| 端点 | 结果 |
| --- | --- |
| `/api/sessions` | 200，`data` 413 项 |
| `/api/agent/chat/threads?sessionId=…` | 200，1 个 thread（共享 threadId = sessionId） |
| `/api/agent/chat/user/messages?sessionId=…&threadId=…` | 200，`data` **66 条**历史消息（546 KB） |
| `/api/agent/runtime-health` | 200，`{"ok":true,"latencyMs":1}` |
| `/api/agent/thread-state` | **404，判据剔除** |

`/api/agent/thread-state` 是依据**漂移的本地 controller** 给出的路径（本地工作树相对 master 有 721 个文件内容不同、`digestVersion` 零命中），生产不存在该路由。按「判据必须能真的失败」纪律剔除，既不计 PASS 也不计 FAIL。

### L2 会话页 DOM / 侧栏可见性（headless Chrome CDP）

独立于已有 9222 实例，另起 `--headless=new --no-sandbox --remote-debugging-port=9223`；`Page.addScriptToEvaluateOnNewDocument` 注入 `localStorage.token`。

**A 组（页面加载，10/10 ALL_PASS）**：SPA 挂载（`appChildren=1`）、`bodyTextLen=897`、停留 `/workflow/`、零 `Runtime.exceptionThrown`、零 console error、零 304、token 已注入、无登录重定向、无错误横幅、内容元素存在。DOM 达 4,199 元素，`messageLike=255` / `canvasLike=245` / `railLike=84`。

**关键下钻**：首轮截图显示画布完整但侧栏不可见。追查发现 `aside.agent-side-rail` 宽度 0、`agent-panel-shell` 为 `display:none` ⇒ 侧栏默认收起，「DOM 存在」不足以证明重构对象可用。依据 `AgentSideRail.vue:2950-2958` 的真实 UI 入口点击 `button.agent-fab`（`title="打开 AI 助手"` → `openPanel`）。

**B 组（展开后，9/9 ALL_PASS）**：

| 判据 | 点击前 | 点击后 |
| --- | --- | --- |
| `aside.agent-side-rail` 宽度 | 0 | **500 px**（`is-docked-open`） |
| `agent-panel-shell` | `display:none` | `flex`，499×913 |
| 可见 `.agent-turn` / `.agent-bubble` | 0 | **64 / 64** |
| 可见 `.agent-msg-action-btn` | 0 | **224**（第十一刀消息气泡操作簇的模板绑定） |
| `body.innerText` | 897 | **10,640** |
| composer / 发送按钮 | — | `textarea.mention-input-field` / `.dock-generate-btn`，均可见可用 |

### L3 真实回合 / SSE 异步受理（两次，驱动真实前端）

| 判据 | 第一轮 | 第二轮 |
| --- | --- | --- |
| `POST /api/agent/chat/conversation` | **200 `application/json`** | 200 `application/json` |
| 响应体 | `{"code":0,"data":{"accepted":true,"sinceSeq":0}}` | `{"code":0,"data":{"accepted":true,"sinceSeq":24185}}` |
| 非 SSE 流 | PASS（`mime` 不含 `event-stream`） | PASS |
| 常驻 `GET /runs/events?…&lastEventId=…` | 200 `text/event-stream`，**6,069 B** 数据 | 200，**8,153 B** 数据 |
| 轮询到终态耗时 | **22 s** | **3 s** |
| 新消息 | user(探针文本) + assistant(`P0-SMOKE-OK`) | user + assistant(`P0-SMOKE-OK-2`) |
| DOM `.agent-turn` | 64 → 66 | 66 → 68 |
| 侧栏 / composer | 保持 500 px / 清空 | 保持 500 px / 清空 |
| console error | 0 | 0 |
| 逐项判据 | 11/13 | **12/13** |

第一轮 `C4` FAIL 是判据写错（把 `accepted` 判在顶层，实际在 `data` 包裹内），修正为 `(ack.data?.accepted ?? ack.accepted) === true` 后第二轮转绿。**未改任何产品代码**。

判据覆盖到第十刀最关键的 send→observer 接线：`observer.releaseObserverTurn()` / `followUpTail.abort()` / `ownTurnViaObserver` / `setLastSeq` / `listenFollowUpTail()` / `seedLastSeq` 在真实发送路径中全部执行且回合正常 finalize。

### L4 画布 / 分享

| 判据 | 结果 |
| --- | --- |
| 画布 | 27 条 `vue-flow__edge`、25 个 `vue-flow__node` 可见；截图 `/tmp/p0_session.png` 显示节点、连线、图片、工具栏、缩放控件完整 |
| 分享静态页 | CVM 本机 `127.0.0.1:8888/share/<id>.html` → **200 / 224,970 B / text/html**，主机 bind mount 与 `conversation_shares` 表各 145 份一致 |
| 分享内容契约 | **8/8 ALL_PASS**：doctype、title、内联 `<style>`、零外链 script/link、198,195 字符、UTC+8 标记、`iframe sandbox` |

两处**取证假象**已排除，不计缺陷：
- `/share/<id>`（不带 `.html`）404 是 nginx `location /share/ { alias …; try_files $uri =404; }` 的预期行为；静态托管页必须带 `.html`。
- 本机直接 curl 该 224 KB 页面偶发 `502 / 59 B`（沙箱代理截断大响应，伴随 `curl (23)`），CVM 本机直连 200 为权威证据。

## 3. 既有缺陷 F1：`AbortError` 未处理 Promise rejection（已由 F1 独立刀承接）

**现象**：两轮真实回合期间分别捕获 1 / 2 个 `Runtime.exceptionThrown`：

```
Uncaught (in promise) AbortError: signal is aborted without reason
  at Object.m [as abort] (CanvasPage-zje2vIAr.js:679:1016)
  at yo (...:682:3737) -> async Jo (...:682:449)
```

两轮业务结果均正确（ack、SSE 帧、assistant 落库、DOM 更新），零 console error ⇒ 非致命，但按项目「Errors 非零仍算失败」纪律，**本验收不宣告 ALL_PASS**。

**根因定位（可核验）**：生产 bundle L679 的 `function m(){…b.round.abort(); for(const C of b.attempts)C.abort(); b.attempt?.abort()}` 与 `apps/web/src/components/agent/follow-up-tail.ts:248-261` 的 `abort()` 逐字对应；该模块 `launch()` 以 `void run(mark)`（L275）丢弃循环 Promise 且无 `.catch()`，`finally` 里 `void r.cancel?.()`（L466）只被同步 `try/catch` 包住，抓不到 Promise 的异步 reject。`TailReaderLike.cancel?: () => unknown`（L57）把返回类型放宽成 `unknown`，TS 因此不会提示补 `.catch()`——注释「可能 reject，吞掉即可」与实现不符。

**与本次重构的关系：非回归**。PR #775（第十刀）只改了 8 个文件（`AgentSideRail.vue`、`useAgentObserver.ts`、6 个 ratchet 测试），**未包含 `follow-up-tail.ts`**；第十刀已用「master blob 原簇文本 + 依赖替换 → 忽略缩进逐行 diff」硬证伪零行为变更。因此该缺陷在 SFC 时代即存在，只是本次行为级冒烟第一次把它记录成可复现证据。

**修复落地（2026-11-08 F1 独立刀，本记录不追溯改写当时的验收结论）**：

1. `follow-up-tail.ts` 内层 `finally` → `void Promise.resolve(r.cancel?.()).catch(() => {})`；外层同步 `try/catch` 保留以接住同步抛错。**原建议把 `TailReaderLike.cancel` 收紧为 `() => Promise<unknown>` 已撤下**：现有测试桩返回 `void`，收紧会连带改测试且 TS 依旧不强制 `.catch`，收益为零。
2. `launch()` → `void run(mark).catch(() => {})`。**不新增 `mark()` 调用**：`run()` 在首响应前抛错时 `launch()` 等不到 ready 属既有语义，本刀不顺带改变，登记为后续包。
3. 原建议 ③ 的「生产 CDP 复现」改为两层可重复判据：CI 内跑确定性 Node 行为级契约（`unhandledRejection` 事件，RED→PASS + 5 条变异），本地跑一次浏览器级 CDP 复核（`unhandledrejection` / `Runtime.exceptionThrown` 前后计数）；生产真实回合复验在部署成功后执行，不作为合并闸门。

规格与实施计划：`docs/superpowers/specs/2026-11-08-follow-up-tail-abort-rejection-design.md`、`docs/superpowers/plans/2026-11-08-follow-up-tail-abort-rejection.md`。

**生产复验（2026-11-08 14:30 +0800，PR #779 合并后）**：

- `Deploy to Tencent Cloud` run `42453812598` **success**（16m52s，上传慢但未挂死）；CVM `/opt/lnkpi/web/dist/index.html` 与 `CanvasPage-B8laxs4J.js` 已更新，`web=200` / `api=200`。
- 重新自签短期 JWT，headless Chrome CDP 注入 `localStorage.token` 打开真实会话页：A 组页面加载 **10/10 ALL_PASS**、B 组展开侧栏 **9/9 ALL_PASS**。
- **连续两轮真实前端短回合各 13/13 ALL_PASS**（ack `{"code":0,"data":{"accepted":true,...}}`、owner 流 6,049 B、轮询到 assistant finalize、DOM turn 68→70→72）：`=== PAGE ERROR DETAILS === []`、`consoleErrors: []` ⇒ **F1 的 `Runtime.exceptionThrown` 在生产归零**。
- ⇒ F1 闭环。§6 结论第 2 条的「不宣告 ALL_PASS」是**当时**的历史结论，保持原貌；本次复验是后续独立取证，不追溯改写。

## 4. 其它排除项与残留风险

- **部署链**：`Deploy to Tencent Cloud` run `42442096327` 因 `Upload web dist and nginx config` 的 runner→CVM scp 在 8.07 分钟时被人工取消；生产 dist 完好（首页/入口 JS/health 全 200）。不为零行为变更刀做高风险手动兜底；新 dist 并入下一行为变更窗口。**结论修订（后续取证，不改写当时判断）**：run `42453812598` 证明同一上传步骤在 15.05 分钟后成功、远端 tgz 字节单调增长 ⇒ 不是持久挂死，而是 16–19 MB 全量载荷在 18–87 KB/s 链路上过慢，且 65.3% 是从不变化的登录动画 mp4；取消属过早但只是运维规避。治理见 `docs/superpowers/specs/2026-11-08-web-dist-incremental-upload-design.md`（差量同步 + 清单校验 + 一键回退），撤销「retry / 改走本机兜底」方向。
- **本地工作树漂移**：`apps/web` 仍有 3 个 canvas 文件漂移（既有、非本轮引入）；server/docs 侧 721 个漂移未处理。本次全部生产结论均以 `gh api` master 与生产实测为准，未采信本地 controller。
- **验收覆盖边界**：本次验证的是生产 #776（11 刀）。P1 本刀 #777 未上线，其零行为变更由提交期的「逐字 diff + 4 类门禁 + 5 条变异」证明，非本轮生产取证范围。
- **未覆盖**：真机移动端、多端并发一致性、长会话 pixelRatio/导出长图、付费任务确认门。这些不是 Phase 3 重构的接线范围。

## 5. 取证文件

| 路径 | 内容 |
| --- | --- |
| `/tmp/p0_probe.py` | 自签 JWT + 只读端点探针 |
| `/tmp/p0_cdp.mjs` | 页面加载 DOM 断言（A 组 10 项） |
| `/tmp/p0_rail_probe.mjs` / `/tmp/p0_open_rail.mjs` | 侧栏可见性下钻与展开（B 组 9 项） |
| `/tmp/p0_send.mjs` | 真实前端发回合 + ack/SSE/finalize 轮询（C 组 13 项） |
| `/tmp/p0_session.png` / `p0_session_open.png` / `p0_after_send.png` | 收起态 / 展开态 / 回合后截图 |
| `/tmp/p0_send.log` / `p0_send2.log` / `p0_cdp_full.log` / `p0_open_full.log` | 两轮回合与 DOM 探针完整输出 |

> `/tmp` 为一次性取证目录，非持久资产；本记录是持久结论。

## 6. 结论

1. **Phase 3 十一刀的生产行为回归：未发现**。会话页（含收起/展开两态）、消息气泡操作簇、composer 发送、SSE 异步受理与常驻 owner 流、Thread/Queue/Observer 接线、画布、分享静态页，五层行为判据全部通过。
2. **结项规格的 P0 缺口由本记录补齐**，当时保留 F1 为未闭环项、按项目纪律不写 `ALL_PASS`；该历史结论保持原貌。F1 后由 2026-11-08 F1 独立刀修复（见 §3「修复落地」），状态演进以修复规格与实施计划为准，不追溯改写本次验收结论。
3. **下一优先级（本轮收尾时的排序）**：F1 修复（行为级 RED→PASS 独立刀，**已完成并生产闭环**，见 §3） > 部署链治理（**已完成并生产验证**，#781 / #782，见 `docs/ops/2026-11-08-web-dist-upload-prod-verify.md`） > P4 门禁化（**已开刀 #3**，见 `docs/superpowers/specs/2026-11-08-agent-siderail-p4-gates-design.md`）。冻结边界不变：`sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项契约。
   - **本轮原建议的显式修订**：原第 3 条把「CDP 冒烟」与「注入依赖/回环数」并列为 P4 可失败门禁；P4 准入复核后**拆包**——CDP 五层冒烟依赖生产 SSH 私钥、容器内 `JWT_SECRET` 与 headless Chrome，且会向生产写真实回合数据，不满足「零外部依赖 / 确定性 / 可逐条变异」的门禁准入三问，改由 #4 以参数化 ops runbook 交付，**不挂 required check**；P4 只做源级确定性门禁。
4. **后续插队刀（2026-11-08 晚，状态演进追加）**：P4 门禁化（#3，PR #783 / #784）已闭环；此后由生产会话诊断触发 P0+P3 产品修复固化插队，优先于 #4 CDP 五层冒烟参数化 ops runbook，后者顺延不取消。规格见 `docs/superpowers/specs/2026-11-08-agent-observer-refusal-exempt-design.md`；本条只追加状态演进，不改写上方第 1–3 条当时的结论。
5. **#4 落地（2026-11-09，状态演进追加）**：第 3 条所述「CDP 冒烟改由 #4 以参数化 ops runbook 交付、不挂 required check」已实现 —— `scripts/prod-cdp-smoke.mjs` 把本记录 §2 的 L0–L4 判据迁移为参数化入口，并把 2026-11-08 取证暴露的 756px 断点 / session-scoped 视口修正 / 多 tab 串台三条坑做成可失败 PREFLIGHT；`scripts/verify-prod-cdp-runbook.py` 提供零外部依赖的七组静态判据。L3 真实回合默认 `SKIPPED`，默认只读跑法不向生产写数据。本条只追加状态，不改写上方第 1–4 条当时的结论。
