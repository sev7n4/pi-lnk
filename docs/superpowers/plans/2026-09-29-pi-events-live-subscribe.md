# pi-runtime 事件订阅跨轮重放与 helm 科学计数法修复实现计划

对应规格：`docs/superpowers/specs/2026-09-29-pi-events-live-subscribe-design.md`
状态：已实现（2026-09-29）
执行方式：Native（顺序执行，逐步验证）

本文件不含配图（纯步骤清单，无空间/分支/契约关系需图形表达，判据见 SPEC-CONVENTIONS §1 反面判据）。

---

## Task 0｜基线确认

1. 工作区：`.worktrees/hotfix-tool-sessionid`，分支 `fix/pi-events-live-subscribe`，基线 `origin/master` = `aec7104`（PR #74 squash）。
2. 确认在途 PR 不与本包同改文件（`session-manager.ts` / `app.ts` / `runtime-config.ts` / `pi-runtime.client.ts` / `agent.service.ts`）。
3. 环境自检：pi-runtime 与 Nest 各跑一个既有用例通过。

**验收**：工作区干净、两侧测试可跑。

---

## Task 1｜pi-runtime 侧：live 订阅语义 + 数字解析修复

1. `services/pi-runtime/src/session-manager.ts`
   - `unsubscribe` 后新增 `subscribeLive(threadKey, listener)`：`this.require(threadKey).listeners.add(listener)`，**不重放缓冲**；未知键 fail-closed 抛 `NotFoundError`（判据 E-4）。
2. `services/pi-runtime/src/app.ts`
   - 新增导出纯函数 `resolveEventsSubscribeMode(query)`（图 2 三路判定：`lastEventId` 优先 → `from=now` → 缺省全量重放，判据 E-2/E-3）；
   - `/events` 路由改用该函数：`live` → `manager.subscribeLive(sessionId, writeEvent)` 且 `buffered` 初值 `[]`；`replay` → 既有 `subscribe(..., afterSeq)`；
   - `Querystring` 类型加 `from?: string`。
3. `services/pi-runtime/src/runtime-config.ts`
   - `parsePositiveInt` 改 `Math.trunc(Number(raw))` + `Number.isFinite` / `n <= 0` 守卫（判据 E-5），保留非法回退语义。

**验收**：`tsc --noEmit` 通过；既有用例若断言旧 `parseInt` 语义，核对后不放宽。

---

## Task 2｜Nest 侧：streamEvents live 选项

1. `apps/server/src/agent/pi-runtime/pi-runtime.client.ts`
   - `streamEvents` 加第 4 参 `opts?: { live?: boolean }`；
   - URL 构造：`lastEventId` 已定 → `?lastEventId=...`（重连语义不变）；未定且 `live` → `?from=now`；否则无 query（旧调用方零影响）。
2. `apps/server/src/agent/agent.service.ts`
   - `iteratePiEvents` 的 `streamEvents` 调用追加 `{ live: true }`（判据 E-1：每轮新订阅必须 from=now）。

**验收**：`tsc --noEmit` 通过；确认全仓 `streamEvents` 仅此一处调用方（`agent.controller.ts` 仅 `chat/conversation` 一处经 `streamConversation` 订阅）。

---

## Task 3｜回归锁

| 文件 | 用例 |
|---|---|
| `services/pi-runtime/src/session-manager.test.ts` | ① `subscribeLive` 不重放缓冲、只收未来事件；② 未知键抛 `NotFoundError` |
| `services/pi-runtime/src/app.test.ts` | ③ `resolveEventsSubscribeMode` 三路判定；④ `/events?from=now` 未知键 404 |
| `services/pi-runtime/src/runtime-config.test.ts` | ⑤ `"1.8e+06" → 1800000` 等 3 例；⑥ `"12abc" → fallback` |
| `apps/server/src/agent/pi-runtime/pi-runtime.client.test.ts` | ⑦ live 首连带 `?from=now`；⑧ live 断流重连（`controller.error()` 触发，**clean close 不触发重连**）改带 `lastEventId` 且不叠加 `from=now`；⑨ live 缺省首连不带 query |
| `apps/server/src/agent/agent.service.pi-runtime.test.ts` | ⑩ 追加断言 `streamEvents.mock.calls[0][3]` `toEqual({ live: true })`（opts 是第 4 参） |

**验收**：新增用例先红后绿（TDD）；pi-runtime 既有全量（317 例）与 Nest `src/agent`+`src/sessions` 不回归。

---

## Task 4｜文档

1. 本 spec 与 plan 落盘（§0 配图索引 + 图 1/2/3）。
2. `pnpm verify-spec-figures` 0 错 0 警。

---

## Task 5｜本地验证

1. pi-runtime：`runtime-config + session-manager + app` 定向 + 全量 `pnpm test`；
2. Nest：`pi-runtime.client.test.ts` + `vitest run src/agent src/sessions`；
3. 三侧类型：`apps/server tsc --noEmit` → `services/pi-runtime tsc --noEmit` → `apps/web vue-tsc -b`；
4. 根目录 `pnpm verify-spec-figures`。

**验收**：全绿；失败回对应 Task 修，不得跳过。

---

## Task 6｜PR 与合并

1. commit（消息写明：现象 / 根因 / 判据 / 文件清单 / 验证结果）。
2. push 到 `fix/pi-events-live-subscribe`，开 PR（body 附 P0-A 证据表与根因链）。
3. 等三项 CI 全绿：Verify spec figures / Build monorepo / Build API Docker image。
4. **确认部署队列已清空**后再 squash 合并（`cancel-in-progress: false`，队列未清空绝不合并）。

**验收**：CI 三项 pass；master 前进。

---

## Task 7｜部署（先 API、后 pi-runtime，串行）

1. **API**：master push 自动触发 `Build API on CVM`；成功后核对容器内含 `{ live: true }` 特征。
2. **pi-runtime**：
   - 现查 `curl -s http://127.0.0.1:5000/v2/pi-runtime/tags/list` 取下一个可用 tag（**不得假设「当前 +1」**）；
   - CVM `rsync`（先 `find /root/pi-lnk-build -name '*.test.ts' -delete`）+ `docker build --no-cache -f services/pi-runtime/Dockerfile .`；
   - 镜像特征串校验：`docker run --rm --entrypoint sh <tag> -c "grep -c subscribeLive /app/services/pi-runtime/dist/session-manager.js"` 等；
   - push 记 digest；
   - `helm upgrade --reuse-values --set image.tag=<tag> --set env.PI_RUNTIME_VERSION=<tag>`（数字 env 同步改 `--set-string`，判据 E-6）；**动手前 `helm history --max 3` 防并行碰撞**；
   - 核对 pod imageID digest 与 push digest 逐字符相同。

**验收**：`healthz` 版本正确、`PI_RUNTIME_MODE=active`、pod digest 一致。

---

## Task 8｜生产端到端验收

1. 同一会话两轮对话：客户端第二轮必须看到**本轮**回答（P0-A 闭环）。
2. P0-B：`kubectl exec ... printenv` 数字 env 不再是科学计数法（或经 `Math.trunc(Number())` 解析后正确）；sweeper tick 后会话仍在、TTL=30min 生效。
3. 既有能力抽查：六步 CRUD 抽 1–2 步 `canvas_action` 正常（#74 不回归）。
4. 清理：临时脚本、自建会话。

**验收**：全绿即修复闭环。

---

## Task 9｜收尾

1. 更新 `.workbuddy/memory/2026-09-29.md` 与 `.workbuddy/memory/MEMORY.md`（「待决 P0-A/B」改「已修 + 版本号/rev/digest」）。
2. 出报告并展示；清理 worktree 与远端分支。
