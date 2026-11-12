# SSE 事件一等化 P2 前端 W1c 实施计划（state 驱动重建 + 终态卡）

> 日期：2026-11-12　|　性质：**实施计划（待拍板）**，零代码改动
> Spec：[`../specs/2026-11-12-sse-p2-web-interruption-state-design.md`](../specs/2026-11-12-sse-p2-web-interruption-state-design.md)
> 母计划：[`2026-11-11-sse-session-resume-p0-p2.md`](./2026-11-11-sse-session-resume-p0-p2.md) §3（W1c-1/2/3）
> 基线：master `ba0592834096fc5107d33328d0ae4b3d0db031bc`
> **前置裁决**：spec §3 D1 必须拍板。本计划按**推荐案 A**（服务端 additive `interruption` 字段）书写；
> 若拍板案 B，删除 Task 1 与 §4 中 W1c-2 全部用例，并把 W1c-2 显式降级为 No-Go 回填母计划。
> 案 C 不推荐（会推翻 P1c-6 已验收判据）。

---

## 1. Goal

让 ask_user 确认卡在「刷新 / 切出切回 / 换设备 / 后端重启」后由持久化门状态裁决：
仍可点的门重建出可提交卡，已终态的门呈只读终态卡（已回答 / 已跳过 / 已超时），
消灭「卡片活着但点了执行不了」的假交互，且不破坏 H1-c 退役端点、P1c 账本投影、P2 终态抑制。

---

## 2. 变更清单（预计 15 路径 = 13 代码/测试 + 2 文档）

| # | 路径 | 动作 | 内容 |
|---|---|---|---|
| 1 | `apps/server/src/agent/pending-interruption.service.ts` | 改 | 新增 `InterruptionSummary` 类型 + `getLatest(threadId)`；`getPending` 不动 |
| 2 | `apps/server/src/agent/agent.service.ts` | 改 | `getThreadResumeState` 返回体新增 `interruption`；`pendingInterruption` 原样 |
| 3 | `apps/server/src/agent/agent.controller.ts` | 改 | 仅注释同步（端点 / DTO 不变） |
| 4 | `apps/server/src/agent/agent.service.eventLedger.test.ts` | 改 | S4 增 `interruption` 断言（空表 ⇒ null） |
| 5 | `apps/server/src/agent/agent.service.p2Interruption.test.ts` | 改 | 新增「终态门仍返回 `interruption.status`」+ 变异自检；T4/S5 原样 |
| 6 | `apps/web/src/components/agent/interruptionState.ts` | **新增** | `fetchInterruptionState` + `resolveInterruption` + `InterruptionSummary` 类型（纯函数，可注入 fetch；不引跨包运行时依赖） |
| 7 | `apps/web/src/components/agent/interruptionState.test.ts` | **新增** | W1c-1/2 纯函数矩阵 + M1–M4 变异自检 |
| 8 | `apps/web/src/components/agent/turnTimeline.ts` | 改 | question status 加 `expired`；新增 `reconcileTimelineInterruption(timeline, summary, now): boolean` |
| 9 | `apps/web/src/stores/agent.ts` | 改 | `applyInterruptionState(summary, now): boolean` 转发到上者 |
| 10 | `apps/web/src/components/agent/AgentSideRail.vue` | 改 | **仅 script 块**：import + `loadHistory` / `reconcileLatestAssistant` 两处接线 + 竞态护栏；零模板零样式 |
| 11 | `apps/web/src/components/agent/AgentTurnTimeline.vue` | 改 | `v-else` 三态文案（已回答 / 已跳过 / 已超时） |
| 12 | `apps/web/src/components/agent/AgentTurnTimeline.terminalQuestion.test.ts` | **新增** | 终态卡 DOM 判据（不可提交 / 三态文案） |
| 13 | `apps/web/src/components/agent/AgentSideRail.interruptionStateWiring.test.ts` | **新增** | 接线钉子：两处调用、`cache:'no-store'`、403 fail-open、`thread-state` 零字面量 |
| 14 | `docs/superpowers/specs/2026-11-12-...` + 本计划 | 文档 | 随 PR 一并落档（docs-only 零发布，但同 PR 便于评审） |

> ⚠️ 实现必须从 master 快照重建这 5 个陈旧文件：`turnTimeline.ts` / `AgentSideRail.vue` /
> `AgentTurnTimeline.vue` / `stores/agent.ts` / `agent.service.ts`。以 `git hash-object` 逐路径核对基线 blob。

---

## 3. Task 分解

### Task 0：干净验证树
```bash
M=ba0592834096fc5107d33328d0ae4b3d0db031bc
mkdir -p /tmp/w1c-verify
gh api "repos/sev7n4/pi-lnk/tarball/$M" > /tmp/w1c/master.tar.gz
tar -xzf /tmp/w1c/master.tar.gz -C /tmp/w1c-verify --strip-components=1
ln -s /Users/4seven/workspace/pi-lnk/node_modules /tmp/w1c-verify/node_modules
# 对每个「master 已存在」的目标路径：git hash-object <path> == master tree 的 blob sha
```
判据：
1. 已存在的目标路径 blob 与 master 全等（重点核 5 个陈旧文件）；`pnpm` 用 `env -u NODE_OPTIONS`。
2. **H1-c 守卫口径已核清**（`historyFetchNoStore.test.ts:28,32,40`）：
   `code = stripComments(readFileSync('AgentSideRail.vue'))` ⇒ 注释被剥离，
   `AgentSideRail.vue:2091` 注释里的 `thread-state` 不触发守卫。
   ⇒ 约束精确为「新增**可执行代码**不得含 `thread-state`」；实现时复核该守卫未被改动即可。
3. 核 `interruptionState.ts` 等新增路径在 master 上确实不存在（避免覆盖并行刀）。

### Task 1：服务端 additive `interruption`（spec §4.1）
1. `getLatest()`：`prisma.pendingInterruption.findFirst({ where:{threadId}, orderBy:{createdAt:'desc'} })`，
   复用 `getPending` 的 questions 解析与 try/catch fail-open；返回 `status` 为表原值。
2. `getThreadResumeState` 返回类型加 `interruption`，值为 `(await this.pendingInterruptions?.getLatest(threadId)) ?? null`。
3. **禁止**改 `pendingInterruption` 那一行、`suppressTerminalGateCards`、`answerPiPending`。
判据：`eventLedger.test.ts` S4/S5 + `p2Interruption.test.ts` T1–T8 原样全绿；新增 T9「终态门 ⇒ `interruption.status==='answered'` 且 `pendingInterruption===null`」。

### Task 2：前端纯函数模块 `interruptionState.ts`（只做 fetch + 决策，不碰 `TimelinePart`）
```ts
export interface InterruptionSummary {
  callId: string; kind: string; questions: unknown[]
  expiresAt: number; status: 'pending' | 'answered' | 'expired' | 'aborted'
}
export async function fetchInterruptionState(threadId: string, fetchImpl = fetch): Promise<InterruptionSummary | null>
// GET /api/agent/threads/${encodeURIComponent(threadId)}/state
// headers: authHeaders()；cache:'no-store'；AbortSignal.timeout(10_000)
// !res.ok / json.code!==0 / 形态不符 / 抛错 ⇒ null（fail-open，绝不 throw）
// ⚠️ 响应取 data.interruption；data.pendingInterruption 保持旧语义，本刀不消费
export function resolveInterruption(
  summary: InterruptionSummary | null, now?: number
): { callId: string | null; targetStatus: 'pending_answer' | 'answered' | 'declined' | 'expired';
     questions: unknown[]; live: boolean }
```
`resolveInterruption` 规则（D2/D3，纯决策、无副作用）：
- `summary === null` ⇒ `{ callId:null, targetStatus:'expired', live:false }`（无权威证据即不可点）。
- `status==='pending' && expiresAt > now` ⇒ `{ callId, targetStatus:'pending_answer', live:true }`。
- 其余 ⇒ `live:false`，`targetStatus` 按 `answered→answered / aborted→declined / expired→expired /
  （pending 但已过 `expiresAt`）→expired` 映射。

### Task 3：`turnTimeline.ts` + `stores/agent.ts`（应用决策）
`reconcileTimelineInterruption(timeline, summary, now): boolean` 消费 `resolveInterruption` 的结果：
- `live:true` ⇒ 按稳定 id `question:${callId}` upsert：无 part 且 `questions` 非空 ⇒ 补建
  `pending_answer`（题面取 `questions`）；有则只校正状态/题面；其余 callId 的活卡一律翻 `expired`
  （单门语义，防多卡残留，对齐 P3 四卡生产实证）。
- `live:false` ⇒ 该 callId 的 part 翻映射终态；无 part ⇒ 补建终态 part（保证 W1c-2c 可见）。
  `callId===null`（老会话 / 403 / 超时）⇒ 把全部 `pending_answer` 翻 `expired`；
  无 question part ⇒ `changed:false`（阴性保证，有机历史零改动）。
- 幂等：同输入跑两次，第二次 `changed:false`（除首次补建）。
- `upsert` 必须复用 `applyTimelineEvent` 的 `ask_user` 稳定 id 语义，不追加重复 part。
- store `applyInterruptionState(summary, now): boolean`：只作用于**最后一条带 timeline 的 assistant**；
  `pendingQuestion` computed 不改（天然只认 `pending_answer`）。
- 前后端各自声明 `InterruptionSummary`，**不引跨包运行时依赖**（RB-D7）。

### Task 4：`AgentSideRail.vue` 两处接线（D4/D6）
- `loadHistory()` 成功分支 `agent.loadHistory(sanitized.rows)` 之后：
  `void reconcileInterruptionFromState()`。
- `reconcileLatestAssistant()` 每次拉到新页并灌入 store 之后：同款调用。
- `reconcileInterruptionFromState()`：捕获 `agentThreadId.value` 作序号，响应回来若已变化直接丢弃；
  `authHeaders()` 复用 `:1380-1383`；失败静默（fail-open）。
- **零模板 / 零样式 / 零 `isMobileLayout` / 零 `defineExpose` 改动**。

### Task 5：`AgentTurnTimeline.vue` 三态文案
`v-else` 由二元改三元：`answered → '已回答'` / `declined → '已跳过'` / `expired → '已超时'`。
沿用现有 `class="text-[10px] text-[var(--lnk-text-muted)]"`，不新增字号 / hex / `--neo-*`。

### Task 6：测试 + 变异自检（§4 / §5）
### Task 7：本机全量回归（§6）
### Task 8：REST 推 PR → CI → **停在合并前等单独授权**（§7）

---

## 4. 测试用例矩阵（母计划 W1c-1/2/3）

| # | 用例 | 判据 |
|---|---|---|
| **W1c-1a** | 刷新重建可点卡：state 给 `pending`，历史无卡片事件 | 补建 `pending_answer` part（id=`question:${callId}`），题面/选项来自 `summary.questions`；`AskUserCard` 渲染；提交走 `/answers` 且带同 callId |
| **W1c-1b** | 权威校正：历史重放出 `pending_answer`，state 为终态 | 该 part 翻终态；`pendingQuestion` 归 null；`sendMessage` 不再被 `pendingQ` 拦截 |
| **W1c-1c** | expiresAt 客户端裁决：state `pending` 但 `expiresAt <= now` | 视同终态 `expired`，不出可点卡（sweep 未跑也不出活卡） |
| **W1c-1d** | 403 / 超时 / 网络异常 / 形态不符 | `fetchInterruptionState` 返回 null；历史渲染零中断、零告警 |
| **W1c-1e** | 竞态：拉取中切线程 | 陈旧响应被丢弃，不污染新线程 timeline |
| **W1c-1f** | 幂等：同一 state 连跑两次 | 第二次 `changed:false`，不重复建 part |
| **W1c-2a** | 终态卡 answered | 卡片呈「已回答」，`AskUserCard` 不渲染，无 submit 通道 |
| **W1c-2b** | 终态卡 expired | 卡片呈「已超时」，`question.status==='expired'` |
| **W1c-2c** | 终态 + 历史无 part（P2 抑制后真实形态） | 补建终态 part，卡片可见但不可提交 |
| **W1c-2d** | aborted → declined | 呈「已跳过」 |
| **W1c-2e** | 多卡：4 张 ask_user，state 只认 1 个 callId | 仅目标 callId 校正，其余活卡翻终态；**不误翻第一张**（P3 判据） |
| **W1c-2f** | 老会话（表无行） | `interruption:null` + `pendingInterruption:null` ⇒ `changed:false`，有机历史零改动 |
| **W1c-3a** | 回归：P0 T1–T9 / P1 W1–W3 | 全绿 |
| **W1c-3b** | 回归：现有 9 份相关测试 | `agent.pendingQuestion` / `AgentSideRail.askInline` / `turnTimeline.callIdResolve` / `turnTimeline.replayAskUser` / `AskUserCard` / `agentAnswers` / `useAgentPropose` / `historyFetchNoStore` / `streamRecovery` 全绿 |
| **W1c-3c** | 棘轮全表（spec §1.3） | `isMobileLayout`=11、`defineExpose`=11、H1-c 退役守卫（剥注释口径）、设计令牌 / 字号 / neo / 滚动宿主守卫全绿 |
| **S-T9** | 服务端：终态门 state | `interruption.status==='answered'` 且 `pendingInterruption===null`；`suppressTerminalGateCards` 行为不变 |

---

## 5. 变异自检（每条判据必须能 RED，还原后 GREEN）

| # | 变异 | 期望 RED 的用例 |
|---|---|---|
| M1 | 删掉 `loadHistory` 后的 state 拉取 | W1c-1a / 1b |
| M2 | `resolveInterruption` 里把 `expiresAt > now` 判定去掉（只看 `status`） | W1c-1c |
| M3 | 终态分支改为 `delete part`（而非翻状态） | W1c-2a / 2b / 2c |
| M4 | 补建 part 用固定 id 而非 `question:${callId}` | W1c-2e |
| M5 | `fetchInterruptionState` 去掉 `cache:'no-store'` | W1c-3b（`historyFetchNoStore` 新增同款钉子） |
| M6 | 新增可执行代码写回 `thread-state` 字面量 / 复活 `fetchThreadStateSafe` 等退役导出 | W1c-3c（H1-c 棘轮，`code` 已剥注释） |
| M7 | `getThreadResumeState` 把 `pendingInterruption` 也改成 `getLatest` | S-T9 + `eventLedger.test.ts:219` |
| M8 | 去掉竞态护栏（不比 `agentThreadId`） | W1c-1e |

> 判据纪律：贴真实生产记录求值后再写断言（阳性 = 已实证的 answered/expired 门；阴性 = 老会话）。
> 「0 命中」必须排除假 0 ⇒ 一律 `grep -E`（BSD grep 不支持 BRE `\|` 轮替）。
> 变异若不 RED，先疑伪变异与判据自匹配恒绿，不判通过。

---

## 6. 本机验证清单

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"
# 定向
pnpm --filter @lnkpi/server exec vitest run src/agent/agent.service.p2Interruption.test.ts \
  src/agent/agent.service.eventLedger.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @lnkpi/web exec vitest run src/components/agent/interruptionState.test.ts \
  src/components/agent/AgentTurnTimeline.terminalQuestion.test.ts \
  src/components/agent/AgentSideRail.interruptionStateWiring.test.ts \
  src/components/agent/turnTimeline.callIdResolve.test.ts \
  src/components/agent/turnTimeline.replayAskUser.test.ts \
  src/components/agent/AgentSideRail.historyFetchNoStore.test.ts \
  src/components/agent/AgentSideRail.askInline.test.ts --maxWorkers=1 --no-file-parallelism
# 全量 + 静态守卫
pnpm --filter @lnkpi/web exec vitest run --maxWorkers=1 --no-file-parallelism --testTimeout=20000
pnpm verify-claims && pnpm prompt:lint
vue-tsc -b     # ⛔ 勿加 --noEmit（composite TS6310）
```
判据：全绿；`vue-tsc -b` 零错；`tsc --noEmit`（server 侧）零错；静态守卫 EXIT=0。
本机偶发 5s timeout 用 `--testTimeout=20000` 并与 master 基线对照（历史软链快照负载漂移）。

---

## 7. 交付纪律

1. **推 PR**：本机 ↔ GitHub 仅 `gh api` 可达。逐路径裸 blob `git hash-object` 校验 →
   `tree(base_tree=<master tree>, 只列改动路径)` → `commit(parent=ba059283...)` → 建分支 ref → PR。
   推前逐路径核 master blob（master 前移则按 `MEMORY.md` 纪律重建单 commit）；
   推后 `compare` 验 `DELTA == 改动路径集` + `ALL_PARALLEL_KEPT`；PR 正文**必须回读长度**（`@文件路径` 会静默丢内容）。
2. **CI**：`gh run watch <id> > /tmp/w1c-ci.log 2>&1; echo EXIT=$?`；三 job 全绿才算。
   ⚠️ `ci.yml` 的 xmllint 已是离线 python3 shim（#846 加固），不要再引 apt。
3. **合并**：CI 全绿后**停在合并前，等用户单独授权**（本刀改 `apps/web` + `apps/server`，
   合并即触发 `deploy.yml` 生产发布，属「触发发布的刀」，不得自动合并）。
   合并最强证据 = 合并树 == CI 已验证 PR head 树。
4. **部署**：`deploy.yml` 自动（paths 含 `apps/server|apps/web|packages`）；本刀**不改** pi-runtime /
   skills ⇒ 零手工 `runtime-deploy`。
5. **生产复测**：容器内 JWT 自签（密钥不出 CVM）；显式 `model:'platform::agnes-2.5-flash'`；
   受控数据「双端 sha256 备份 + Prisma 事务 + 计数硬守卫」后清理，`PointTransaction` 不删。
6. **删分支 + 记日志**：追加 `.workbuddy/memory/2026-11-12.md`（append-only）+ 必要时刻回写 `MEMORY.md` 索引。

---

## 8. 生产复测判据（合并授权后执行）

| # | 判据 | 方法 |
|---|---|---|
| V1 | dist 锚点并存 | `lnkpi-api` 容器 `agent.service.js` 命中 `getLatest` / `interruption`；Web chunk 命中 `已超时` / `interruptionState`；P1c / P2 / D1 旧锚点未丢 |
| V2 | state API 新字段 | 受控 pending 门：`pendingInterruption.callId` 有值且 `interruption.status==='pending'`；终态后 `pendingInterruption===null` 而 `interruption.status==='answered'\|'expired'` |
| V3 | W1c-1 真机等价 | 受控回合开闸 → 容器内拉 `getMessages` 与 state，按 §4 纯函数离线求值 ⇒ `pending_answer` part 存在且可提交 |
| V4 | W1c-2 真机等价 | 作答 / 超时后 ⇒ `getMessages` 响应缺该 callId 卡片事件（P2 抑制仍生效）+ state 给终态 ⇒ 纯函数输出终态 part，`AskUserCard` 不渲染 |
| V5 | 旧会话不回归 | 有机 ask_user 会话 `cmwc4nouo000elq01fsrwp5mh` 45 事件、旧会话 `cmwbxf1lr003bnd01vnjjp0h7` GET messages 200 且行数/字节原样 |
| V6 | 零扰动 | health 200、容器 healthy、近 5 分钟 0 error、pi-runtime `healthz.version` 仍 `ba059283`（本刀不动 runtime） |

---

## 9. 边界（禁止 ALL_PASS）

- 严格「重启前后同一 pending 门」对比仍需重启容器（~30s 502，单独授权）——本刀不覆盖。
- A-6 真机走查（iOS Safari + Android Chrome + 鉴权会话）、SSE `Last-Event-ID` 真机抓包，
  本环境不可代跑 ⇒ 不宣告真机验收完成。
- 82 条历史 `truncated` 分层归因、D2–D7 排期、propose_plan D6/D7 仍欠，均不在本刀范围。
- 生产复测产生的一切受控数据须按 §7.5 清理并留备份 sha；账务流水按不可变原则保留。
