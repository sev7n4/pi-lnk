# ADR-0006: SSE 单连接 + lastEventId 续传，拒绝轮询与双通道

| 字段 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-09-29（PR #78）/ 2026-10-01~02 陆续加固 |
| 决策者 | 项目发起人 |

## 背景

Nest 侧要拿到 pi-runtime 的流式事件（文本增量、工具调用、ask_user 等待等）推给前端。

发现一个既有缺陷（生产验收时暴露）：**pi-runtime 会缓冲全量事件，
Nest 每轮都新建订阅 → 客户端只看到上一轮的回答。**

决定性证据（pi-runtime 直连，同一会话两轮）：

| 订阅 | 时点 | 事件数 | seq 范围 | 内容 |
|---|---|---|---|---|
| SUB1 | 轮 1 后 | 35 | 0–34 | 轮 1 文本 ×23 |
| SUB2 | 轮 2 后，全新订阅**不带 lastEventId** | **61** | **0–60** | 轮 1 ×23 + 轮 2 ×15，含**两个 `agent_end`** |

## 考虑过的方案

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| 每轮新建订阅（现状） | 简单 | 重放全量、重复渲染、状态错乱 | ❌ |
| WebSocket 双向 | 功能强 | 我们的场景不需要客户端上行 | ❌ |
| **单连接 + `lastEventId` 增量**（选中） | 语义正确、天然去重 | 断线重连逻辑要写对 | ✅ |
| 轮询 | 无需长连接 | 延迟高、连接数多 | ❌ |

## 决定

1. **一个会话一条SSE 连接**，不每轮重建。
2. **断线重连带 `?lastEventId=n`**，只补增量。服务端 `lastEventId` 优先于 `from=now`。
3. **两种模式**：
   - `live=true` → 只收未来事件
   - 不带 `lastEventId` → 全量重放 buffer（供"从零开始"的场景，如刷新恢复）
4. **两条通道的语义要在代码注释里写死**，避免后来者再搞出"两处都能建订阅"的局面
   （历史遗留：`agent/agent.controller.ts` 与 `agent-canvas-tools.controller.ts` 两套路由并存，
   `api/agent/internal/events` 与 `api/agent/canvas/events` 都存在）。

## 后果

**正面**
- 断线重连不丢不重（有测试：`pi-runtime.client.test.ts:526`、
  `:811`「live=true 断线重连改带 lastEventId，且不再叠加 from=now」）
- 前端不会重复渲染历史内容

**负面 / 代价** ❗
- 两套路由并存是历史债，**新代码不知道该建哪个** —— 已在注释里标注，但没做统一收口
- 需要维护 buffer 与 seq 语义，服务端要记住"发到哪了"
- 长连接在网关/负载均衡上有超时风险

**将来要注意**
- 改事件流时，**确认没新建第三条通道**
- `lastEventId` 与 `from=now` 不要叠加（已有回归测试盯着）
- ask/steer 等阻塞分支的事件也走这条连接，靠 pending 指标暴露

## 关联

- PR：#78（事件订阅跨轮重放修复）、#88（propose 成功不得广播 aborted）
- 实现：`apps/server/src/agent/pi-runtime/pi-runtime.client.ts`
- 相关：ADR-0005（工具分层会广播 `config_update`，走同一通道）
