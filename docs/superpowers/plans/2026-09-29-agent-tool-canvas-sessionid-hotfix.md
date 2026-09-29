# agent 画布工具会话身份错位修复（hotfix）实现计划

对应规格：`docs/superpowers/specs/2026-09-29-agent-tool-canvas-sessionid-hotfix-design.md`
状态：已实现（2026-09-29）
执行方式：Native（顺序执行，逐步验证）

本文件不含配图（纯步骤清单，无空间/分支/契约关系需图形表达，判据见 SPEC-CONVENTIONS §1 反面判据）。

---

## Task 0｜基线确认

1. 工作区：`.worktrees/hotfix-tool-sessionid`，分支 `fix/tool-context-canvas-session`，基线 `origin/master` = `ba27d5f`。
2. 确认在途 PR：#72（`feat/vision-self-refine-loop`）同改 `session-manager.ts`，但落点在 `attachEvents`（~508 行），与本包不重叠。
3. 环境自检：`services/pi-runtime` 与 `apps/server` 各跑一个既有用例通过。

**验收**：工作区干净、两侧测试可跑。

---

## Task 1｜pi-runtime 侧：会话身份两分

1. `services/pi-runtime/src/session-manager.ts`
   - `CreateOptions` 增 `canvasSessionId?: string`（注释：画布会话 id，与 pi 会话键解耦，工具经 `toolContext.sessionId` 取用）。
   - `SessionEntry` 增 `canvasSessionId?: string`。
   - `build()` 里 `canvasSessionId: opts.canvasSessionId`。
   - `doCreate()` 内存 resume 分支（身份一致、未重建）补 `if (opts.canvasSessionId) existing.canvasSessionId = opts.canvasSessionId;`（判据 E-4 每轮自愈）。
   - `toolContext: () => ({ sessionId: entry.canvasSessionId ?? key, userId: entry.userId, ...entry.turn })`。
2. `services/pi-runtime/src/app.ts`
   - `/sessions` 的 `Body` 类型增 `canvasSessionId?: string`；
   - `manager.create(threadKey, { … canvasSessionId: request.body?.canvasSessionId … })`。
3. `services/pi-runtime/src/tools/types.ts`
   - `LnkpiToolContext.sessionId` 注释改为「**画布会话 id**（Nest 用其查库）；pi 会话键不在此字段」。

**验收**：
- `pnpm typecheck` 通过；
- 既有 `session-manager` 用例若断言 `toolContext.sessionId === key`，改为同时覆盖「传了 canvasSessionId」与「未传」两种；不得放宽为「随便哪个都行」。

---

## Task 2｜Nest 侧：把画布会话 id 传给 pi-runtime

1. `apps/server/src/agent/pi-runtime/pi-runtime.client.ts`
   - `CreateSessionOptions` 增 `canvasSessionId?: string`；
   - `/sessions` body 增该字段。
2. `apps/server/src/agent/agent.service.ts`
   - `ensurePiSession` 的 `opts` 增 `canvasSessionId?: string`；
   - 调用点（`streamConversation` 内）传 `canvasSessionId: sessionId`（**注意**：此处 `sessionId` 是画布会话 id，`sessionKey` 是 pi 会话键，两者不得混用）。

**验收**：`tsc --noEmit` 通过。

---

## Task 3｜回归锁

| 文件 | 用例 |
|---|---|
| `services/pi-runtime/src/session-manager.test.ts` | ① 传 `canvasSessionId` → `toolContext.sessionId` 等于它，且 `activeKeys()` 仍为 sanitize 后的键；② 不传 → 回落 `toSessionKey(threadKey)`；③ 内存 resume 后传新值 → 已刷新 |
| `apps/server/src/agent/pi-runtime/pi-runtime.client.test.ts` | `createSession(key, { canvasSessionId })` → 请求 body 含 `canvasSessionId` |
| `apps/server/src/agent/agent.service.pi-runtime.test.ts` | 传复合 `threadId`（`<sessionId>:<uuid>`）→ 断言 `createSession` 的 `canvasSessionId` === 画布 `sessionId`（**核心回归锁**） |

**验收**：新增用例先红后绿（TDD）；既有全量用例不回归。

---

## Task 4｜文档订正

`docs/superpowers/specs/2026-09-29-persistent-harness-session-design.md` 末尾追加「勘误」段：

- 订正「`services/pi-runtime/src/tools/**` 零改动」的推断缺陷：该结论只对「工具代码不需要改」成立，但**漏判了 `toolContext.sessionId` 的值语义被换**，导致 Nest 全部画布端点 404；
- 记明修复包与判据（本条只增文本，不增图，故不动该文档 §0 索引）。

**验收**：`pnpm verify-spec-figures` 通过。

---

## Task 5｜本地验证

1. `cd services/pi-runtime && pnpm test && pnpm typecheck`
2. `cd apps/server && pnpm exec vitest run src/agent src/sessions && pnpm exec tsc --noEmit`
3. `cd apps/web && pnpm exec vite build`（确认无跨包类型破坏；本包不动 web，作为回归确认）
4. 根目录 `pnpm verify-spec-figures`

**验收**：全绿；失败则回到对应 Task 修，不得跳过。

---

## Task 6｜PR 与合并

1. commit（消息写明：现象 / 根因 / 引入时点 / 判据 / 文件清单 / 验证结果）。
2. push 到 `fix/tool-context-canvas-session`，开 PR（body 附 §2 根因链与 §7.2 回归锁）。
3. 等三项 CI 全绿：Verify spec figures / Build monorepo / Build API Docker image。
4. **确认部署队列已清空**后再 squash 合并（避免 `cancel-in-progress: false` 下新 run 取消旧 pending）。

**验收**：CI 三项 pass；master 前进。

---

## Task 7｜部署（先 API、后 pi-runtime）

1. **API**：等 master push 触发的 API 构建/部署（`Build API on CVM`）成功；核对容器内代码含 `canvasSessionId` 特征串。
2. **pi-runtime**：
   - 现查 `curl -s http://127.0.0.1:5000/v2/pi-runtime/tags/list` 取下一个可用 tag（**不得假设「当前 +1」**）；
   - CVM 构建树 `rsync`（先 `find … -name '*.test.ts' -delete`）+ `docker build --no-cache -f services/pi-runtime/Dockerfile .`；
   - `docker run --rm --entrypoint sh <tag> -c "grep -c canvasSessionId /app/services/pi-runtime/dist/session-manager.js"` 验特征串；
   - push 并记录 digest；
   - `helm upgrade --reuse-values --set image.tag=<tag> --set env.PI_RUNTIME_VERSION=<tag>`，核对 pod imageID digest 与 push digest 逐字符相同。
3. 顺序校验：先确认 API 已升级再升级 pi-runtime。

**验收**：`healthz` 版本号正确、`PI_RUNTIME_MODE=active`、pod digest 一致。

---

## Task 8｜生产端到端验收

1. 复用六步 CRUD 脚本（真实用户 + 真实画布，逐轮）：
   - 每步必须有 `canvas_action`；
   - **首条 `canvas_action` 的时间戳 < 流结束**（实时通道，spec §10.2 #9）；
   - 逐轮回读 `canvasData` 与动作一致；删除的边/节点不复活。
2. 键格式对照复跑：真实 id → 201；加后缀 → 404（既有严格性未放松）。
3. 清理：临时脚本、自建会话。

**验收**：全绿即修复闭环。

---

## Task 9｜收尾

1. 追加 `.workbuddy/memory/2026-09-29.md` 与 `.workbuddy/memory/MEMORY.md`（把「待裁决」改为「已修 + 版本号/rev/digest」）。
2. 清理 worktree 与远端分支（按项目惯例：合并后手工清理；`refs/pull/<N>/head` 保留历史）。
3. 提醒 PR #72 作者：本包已合并，其分支需并入新 master（同改 `session-manager.ts`，虽不重叠但需 rebase/merge）。
