# propose 确认的确定性信号（2026-10-06）

> 产品级交互契约：**「用户确认了生成」这件事由什么信号担保**。
> 起因是生产事故——用户点了画布节点的「生成」，agent 却回「用户取消了生成确认」。

## 现象与根因（事故复核）

会话 `cmus6ha64001dk601lzsymqfa`：侧栏 propose 卡片等待中，用户手动点画布节点生成，
agent 回复「用户取消了生成确认」，而图其实已经在跑。四步链路：

| # | 环节 | 事实 |
|---|---|---|
| 1 | 等待期前端状态是**过期的** | `update_node{status:'pending_confirm'}` 挂在 propose 的 tool result 里，而阻塞工具的 tool result 要等**等待结束**才发（`useCanvasActions.ts:21-28` 注释即此项设计）⇒ 等待期本地节点一直是 `draft` |
| 2 | 点击生成时把这个 stale 值写回了 SSOT | `handleNodeGenerate` 先 `debouncedNodePatch.flush()`（`CanvasPage.vue`）→ `saveCanvas` **整份覆盖** |
| 3 | 之后没有第二次落盘 | `generating` 只 patch 本地；SSOT 要等 `studioApi.generateImage` 返回后 `resolveStudioRecord → saveCanvas`（`useNodeGeneration.ts:701`），中间隔着一次真实出图请求 |
| 4 | runtime 把 `draft` 读成「用户取消」 | 轮询臂的 draft 稳定性启发式：连续 ≥2 次（2s 间隔）读到 `draft` ⇒ `reason=rejected`（`canvas-write.ts`）⇒ 文案「用户取消了该节点的生成确认」|

⇒ 触发面不止「点生成」：**等待期内任何 saveCanvas**（拖节点 / 改参数 / 改标题 /
别的节点出图完成）都会用 stale draft 覆写 SSOT 的待确认，同样被判成取消。

## 契约（本次拍板）

| 用户动作 | 权威信号 | 工具结果语义 |
|---|---|---|
| **确认**（dock / 节点「生成」按钮） | `POST /agent/sessions/:id/answers`（`callId`）→ registry `answered` | `confirmed:true`，文案「生成已由画布启动」，禁止 `run_*` |
| 确认（无 /answers 的兜底） | SSOT 节点离开 `pending_confirm`（轮询臂） | 同上 |
| **取消**（侧栏琥珀卡） | `clear-propose` → SSOT 停 `draft` ×2 轮询 | `reason=rejected`，**文案中性**（不断言「用户已取消」） |
| 超时 | registry timer（生产 300s） | `reason=timeout` |
| 中止（停止按钮） | `registry.abortAll` | `reason=aborted` |

**判据：确认必须走确定性事件，不得由共享状态枚举兜推**——`draft` 同时被「用户取消」和
「已确认但尚未同步」两种语义复用，靠轮询次数区分必然有竞态窗口。这与仓库既有铁律
「状态担保 = 确定性 UI/事件，不赌模型/时序自觉」同源。

## 实现落点

1. **runtime**（`services/pi-runtime/src/tools/canvas-write.ts`）：
   race 双臂中 registry 的 `answered` 映射为 `confirmed:true`
   （此前落到 `timeout` 分支 ⇒ 显式确认被回报成「未在时限内确认」）。
2. **前端 L1**（`AgentSideRail.vue` 暴露 `confirmProposeWait` + `CanvasPage.vue` 两处生成入口）：
   本节点存在 propose 等待时，先发 `/answers(callId)` 再起生成；失败不阻断生成（轮询兜底仍在）。
3. **前端 L2**（`waiting_user` → `proposeWaitStart` → `CanvasPage.handleProposeWaitStart`）：
   等待开始即把本地节点同步成 `pending_confirm`，消除 stale draft ⇒ 等待期所有 saveCanvas 无害。
   守卫 `shouldSyncProposePending`：只覆盖 `draft`/无状态，in-flight 与终态不动
   （与 `useCanvasActions` 的 stale-pending_confirm 守卫互为镜像）。

## 已知残余 / 未做

- 取消仍靠轮询推断（约 4s 才结算）：**去向是 fail-safe**（真取消必被识别），故本次不改；
  要提速可让 `clear-propose` 也显式 resolve registry（需先给 `aborted` 之外的语义留位）。
- `draftStreak` 启发式保留为兜底；文案已中性化，避免模型照抄「用户取消了」。
- 不覆盖多选批量生成入口（该入口在选区含 `pending_confirm` 时本就阻断）。
- 镜像残留（**未修，已记录**）：琥珀卡取消后，propose 的 tool result 仍带着
  `update_node{pending_confirm}` 到达前端，而 `useCanvasActions` 的 stale 守卫只拦
  in-flight/终态（`draft` 不在其中，否则会拦掉正常的 propose 写入）⇒ 本地可能停在
  `pending_confirm` 而 SSOT 已是 `draft`。影响仅限下一次 saveCanvas 会把该状态写回去、
  以及节点视觉；用户再点生成不受影响。彻底修需要让动作带「本次等待已结束」的标记。

## 回滚

三处可独立回退：① runtime 的 `answered` 分支；② `confirmProposeWait` 调用点；
③ `proposeWaitStart` 同步。任一单独回退不破坏另外两层。
