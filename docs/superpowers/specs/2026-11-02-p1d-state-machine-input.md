# P1-D 审批分级 · 状态机输入文档

> 2026-11-02 · C2③ 产出（规格 2026-11-02-p1c-write-path-governance-design §4 条目 4 前置）。
> 真相源 = 代码实况（master `3576de6f`），非记忆。目的：给 P1-D「审批分级」设计提供一张**已验证的**节点状态转移表 + 幂等键清单，避免 D 的裁决逻辑建立在过期假设上。

## 1. 状态词表（节点 `data.status`，string，缺省 `draft`）

| 状态 | 语义 | 写入方 |
|---|---|---|
| `draft` | 初始/提案撤回后 | 缺省（`node.data?.status ?? 'draft'`）、`clearProposeGeneration` |
| `pending_confirm` | 待用户确认（**唯一审批闸口**） | `proposeGeneration`（同时 proposalEpoch+1） |
| `generating` | 生成中 | 四类 `start-*` confirm 后（同时写 `generationRecordId`） |
| `completed` | 生成成功终态 | 管线结算回填（7 写点，含产物 URL） |
| `error` | 失败终态 | 结算失败（12 写点）、**cancel 也落此态**（`errorMessage: '已取消'`） |

ⓘ 节点级**没有** `cancelled` 独立状态——`cancelled` 只是 cancel 工具的**返回值**，节点落 `error`。P1-D 若要「已取消」可感知，需复用 `errorMessage` 或 D 里正名。

## 2. 合法转移表（服务端写点实证）

```
draft ──propose──▶ pending_confirm ──start-*──▶ generating ──结算──▶ completed
  ▲                    │    ▲            │              └─结算失败──▶ error
  │                    │    └─start-*（带同纪元）          ▲
  │              clearProposeGeneration                  │
  └──────────────────────────────────────cancel（error + errorMessage='已取消'）
```

| 转移 | 触发 | 守卫 |
|---|---|---|
| draft → pending_confirm | proposeGeneration | proposalEpoch+1；撤回重提纪元递增 |
| pending_confirm → draft | clearProposeGeneration | 幂等（非 pending 一律幂等返回）；零生成调用 |
| pending_confirm → generating | 四类 start-* | **epoch 断言在 P0-1 dedup 之前**（迟到确认不得吃幂等直返） |
| generating → completed | 管线结算 | 结算点直发 late-generation-notify（B1） |
| generating → error | 结算失败 / cancel | error 附 errorMessage |
| 终态（completed/error）→ 任意 | 无 | **无服务端写点**；客户端 PATCH/PUT 亦被 C0 守卫拦 |

**客户端（web PATCH/PUT）对 pending_confirm 节点**：仅允许停在 `pending_confirm` 或改 `generating`（`PENDING_CONFIRM_CLIENT_EXITS`）；违规**字段级**保留服务端值（不 409 整单）；脏 JSON 直通保存优先。终态客户端无权直达。

## 3. 幂等键清单（P1-D 裁决逻辑必须尊重的既有机制）

| # | 键/机制 | 归属 | 语义 | 对 P1-D 的约束 |
|---|---|---|---|---|
| 1 | `proposalEpoch` | B6（#665） | propose mark 时 +1；start-* 断言相等（缺省跳过=手动生成/老客户端/run_* 兼容；节点无 epoch 跳过=存量宽容；不等→409） | 低 tier 跳过审批直达 generating 的路径**必须**定义自己的 epoch 语义，或同样递增 |
| 2 | `generationRecordId` | P0-2/3 | 双源锚点：活跃启动判定 = `status==='generating' && recordId 非空`；start 成功才写 | 分级后的直发路径仍须先落锚点再起 job，锚点即 SSOT |
| 3 | P0-1 单链幂等 | P0（#640） | start* 撞活跃启动 → 返回现有 recordId `{ok, deduped:true}`（与 /answers 同形） | D 的 bypass 通道若复用 start-*，幂等回执形态不得改 |
| 4 | P1-A 墓碑裁决 | P1-A（#661） | /answers：deduped+prior=幂等回执；deduped 无 prior=真丢失 → durable part CAS 双闸裁决 → late-answer 注入（失败回滚 CAS 并 503 可重试） | D 的审批决策若改走 durable part，须兼容既有 CAS 键（callId 维度） |
| 5 | B1 job 化 handle | P1-B（#663/#664） | start 即返 handle（无 recordId，容忍面）；结算点直发 notify；写者收敛归 Nest | 分级不影响 job 层；低 tier 只是省掉 pending_confirm 停留 |

## 4. P1-D 设计裁决点（建议在 D 规格中显式回答）

1. **分级维度**：按操作类型（如低风险生成 skip 审批）还是按会话信任级（用户开关）？——现状只有「propose→confirm」一道闸，D 引入 tier 等于在 `pending_confirm` 前加旁路。
2. **skip 审批路径的状态转移**：draft → generating 直达（不经 pending_confirm）？若是，`PENDING_CONFIRM_CLIENT_EXITS` 无需改（守卫只看 pending_confirm 节点），但 epoch 语义须定（建议：直达路径同样由服务端递增 epoch，保持「重提即纪元」不变式）。
3. **cancel 语义正名**：现状 cancel 落 `error(已取消)`。D 若引入「已取消」独立可感知（UI 区分失败/取消），改动点是 errorMessage 约定或新增终态——新增终态会同时牵动 C0 守卫与 web 状态渲染，成本不低。
4. **审批决策的幂等归属**：确认/拒绝走 /answers（已有墓碑+CAS）；D 的「自动批准」是否也走同一裁决面（推荐复用，避免第二套幂等键）。
5. **审计面**：分级放行的操作建议沿用 `canvas_put_deprecated` 式 logger 打点（如 `approval_tier_bypassed`），两周观测后再收紧。

## 5. 侦察锚点（复核用）

- `apps/server/src/agent/agent-canvas-tools.service.ts`：L1232-1275（propose+epoch）、L1852-1927（assertProposalEpoch+活跃启动锚点）、L2008-2019（generating+recordId 写入）、L2680-2695（cancel→error('已取消')）、L1284-1306（clearProposeGeneration）
- `apps/server/src/canvas/pending-confirm-guard.ts`：L25-29（CLIENT_EXITS）、L39+（字段级守卫）
- `apps/server/src/agent/agent.service.ts`：L1140-1163（/answers 三分叉）、L1169-1235（durable part 裁决+late-answer CAS）
