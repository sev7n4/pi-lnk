import { ElMessage } from 'element-plus'
import type { Ref } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { submitAnswers } from '@/components/agent/agentAnswers'
import {
  resolveProposeCancelCallId,
  resolveProposeCancelNodeId,
  resolveProposeConfirmCallId,
} from '@/components/agent/proposeWaitActions'

export interface AgentProposeDeps {
  /** 线程 id ref（由组件以 props.sessionId 初始化），用于提交 propose/ask 答案。 */
  agentThreadId: Ref<string>
  /** 当前会话 id（props.sessionId），提交答案时透传。 */
  sessionId: string
  /** 仅用于 clearProposeGeneration 事件上行（画布节点取消后收口）。 */
  emit: (event: 'clearProposeGeneration', nodeId: string) => void
  /** 无 callId 的旧 v1 卡回填路径：拼回文本后走原会话流。 */
  sendMessage: (message: string, branchFromEntryId?: string, isRetry?: boolean) => Promise<unknown>
  /** 答案回传的 fetch 包装（含明文 HTTP 降级），由组件提供以复用其 apiUrl/authHeaders。 */
  answersPost: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
}

/**
 * Phase 3 strangler-fig 第六刀：把 AgentSideRail 中阻塞等待（propose_generation /
 * ask_user）的确认/取消/作答交互收敛到独立 composable。
 *
 * 关键不变量（与抽取前逐字等价）：
 * - `settledProposeCallIds` 是**组件实例级** Set（原组件 `<script setup>` 顶层 const，
 *   每实例一份）。本 composable 每次调用创建一份新的 Set，语义与原组件一致，
 *   不会跨实例泄漏（避免把已进入 generating 的节点打回 draft 的 stale 误判）。
 * - 真实状态所有权仍在组件/store：`agent`（pendingProposal / trackWaitingUser /
 *   resolveQuestionPart）、`agentThreadId`、`props.sessionId`、`emit`、`sendMessage`
 *   均由组件注入；composable 只做消费壳 + 幂等收敛。
 */
export function useAgentPropose(deps: AgentProposeDeps) {
  const agent = useAgentStore()
  const settledProposeCallIds = new Set<string>()

  /** 提交成功后本地翻终态（resolved 事件的同构回喂，reason 决定标签）。
   *  P1-A：reason 扩 'timeout'——Nest expired 回执时 part 按 #654 映射翻 expired（非 confirmed）。 */
  function resolveProposePartLocally(callId: string, reason: 'answered' | 'aborted' | 'timeout') {
    agent.trackWaitingUser({ status: 'resolved', toolName: 'propose_generation', callId, reason })
  }

  async function cancelProposeForNode(
    nodeId?: string,
    opts?: { note?: string },
  ): Promise<boolean> {
    // 根治 2026-10-29：等待态单一真相 = 时间线 proposal part（store.pendingProposal）。
    const wait = agent.pendingProposal
    if (!wait || wait.toolName !== 'propose_generation') return false
    const waitNodeId = resolveProposeCancelNodeId(wait)
    if (!waitNodeId) return false
    if (nodeId && waitNodeId !== nodeId) return false
    const callId = resolveProposeCancelCallId(wait)
    // 单飞：该等待已成功结算（确认或取消任一）⇒ 本入口 no-op（连 clear-propose 也不发，
    // 避免把已进入 generating/completed 的节点打回 draft——17:01:27 的 stale clear 实证）。
    if (callId && settledProposeCallIds.has(callId)) return false
    if (callId) {
      try {
        // 乐观翻态：不等旁听流的 resolved（缺席/迟到会让卡片永久 pending、
        // 状态条倒计时空转）——decline 语义 = aborted。P1-A：Nest expired 回执
        // 时 part 按 timeout 翻 expired（late 收口仍按 aborted 语义呈现）。
        const result = await submitAnswers(
          {
            threadId: deps.agentThreadId.value,
            sessionId: deps.sessionId,
            callId,
            answers: {},
            decision: 'decline',
            // §17.8：批注锚带回随 decline 透传批注意见（trim 后非空才发）
            ...(opts?.note?.trim() ? { note: opts.note.trim() } : {}),
          },
          deps.answersPost,
        )
        settledProposeCallIds.add(callId)
        resolveProposePartLocally(callId, result.expired ? 'timeout' : 'aborted')
      } catch {
        // 幂等端点：失败说明网络/鉴权异常，画布侧仍要收敛（轮询兜底会判 rejected）
      }
    }
    deps.emit('clearProposeGeneration', waitNodeId)
    return true
  }

  /**
   * L1 显式确认（2026-10-06）：画布/dock 点生成时，把 propose 等待以 registry
   * **answered** 收口——runtime 侧 answered 即 confirmed（canvas-write.ts），
   * 因此确认不再依赖「SSOT 状态被正确写入」这条时序链。
   *
   * 返回是否真的发出确认（false = 当前没有该节点的 propose 等待，调用方走原路径）。
   * 失败不阻断画布生成：轮询兜底仍在，最坏退回修复前的行为。
   */
  async function confirmProposeWait(nodeId: string): Promise<boolean> {
    // 根治 2026-10-29：callId 取自上游 waiting_user 事件收敛成的 proposal part。
    const callId = resolveProposeConfirmCallId(agent.pendingProposal, nodeId)
    if (!callId) return false
    // 单飞（2026-10-31 大章鱼回合实证）：该等待已成功结算 ⇒ no-op。
    if (settledProposeCallIds.has(callId)) return false
    try {
      const result = await submitAnswers(
        { threadId: deps.agentThreadId.value, sessionId: deps.sessionId, callId, answers: {} },
        deps.answersPost,
      )
      settledProposeCallIds.add(callId)
      // 乐观翻态（answered）：所有确认入口（画布确认面 / 聚合条 / 内联卡）同帧收口，
      // 状态条倒计时熄灭；不再依赖旁听流的 resolved（迟到/缺席 = 多入口持续可点）。
      // P1-A：Nest expired 回执 = 提议已过 deadline 被 timeout 收口，翻 expired 而非 confirmed。
      resolveProposePartLocally(callId, result.expired ? 'timeout' : 'answered')
      return true
    } catch {
      return false
    }
  }

  /** 组件侧回答回传：payload 组装收敛在 agentAnswers 模块（含明文 HTTP 降级）。 */
  async function onAskSubmit(
    callId: string | undefined,
    payload: { answers: Record<string, string[]>; skipped?: string[] },
  ) {
    if (!callId) {
      // 无 callId 的旧路径（Task 2 契约：卡片回填为下一轮 user message）——
      // 答案值拼回文本复用 sendMessage，零新建回流；answers 为空（skip）= 用户放弃作答，
      // v1 语义与 cancel 同义，补发「取消」防模型永远等不到信号（final fix I-2）
      const text = Object.values(payload.answers).flat().map((v) => v.trim()).filter(Boolean).join(' ')
      await deps.sendMessage(text || '取消')
      return
    }
    // 乐观置位：先翻终态防双击双发（幂等端点兜底，但 UI 及时收敛）
    agent.resolveQuestionPart(callId, 'answered')
    try {
      const result = await submitAnswers(
        {
          threadId: deps.agentThreadId.value,
          sessionId: deps.sessionId,
          callId,
          answers: payload.answers,
        },
        deps.answersPost,
      )
      if (result.deduped) {
        // 迟到回答（callId 已 settle，如刷新恢复出的卡片）：spec §5.2 降级为普通
        // user message 走新 turn，不得静默吞掉用户答案（final fix I-1）
        const text = Object.values(payload.answers).flat().map((v) => v.trim()).filter(Boolean).join(' ')
        if (text) await deps.sendMessage(text)
      }
    } catch {
      agent.resolveQuestionPart(callId, 'pending_answer') // 失败恢复卡（幂等端点保证重试安全）
      ElMessage.error('提交失败，请重试')
    }
  }

  async function onAskCancel(callId: string | undefined) {
    // 阻塞卡 cancel = 以「全部跳过」语义 resolve 阻塞 pending（空 answers = 全部 skipped；
    // registry answer 即 resolve，工具层 skipped 推导自然生效，模型看到「用户未作答」后续行）。
    // 否则 pending 仍挂着：超时窗口内自由文本走正常消息会撞 409（fix round 1 Finding 2）。
    if (!callId) {
      // 无 callId 的 v1 卡：对齐 base 行为发「取消」，模型才能收到放弃信号（final fix I-2）
      void deps.sendMessage('取消')
      return
    }
    // 乐观置位：先翻终态防双击双发，失败恢复卡（幂等端点重试安全）
    agent.resolveQuestionPart(callId, 'declined')
    try {
      const result = await submitAnswers(
        {
          threadId: deps.agentThreadId.value,
          sessionId: deps.sessionId,
          callId,
          answers: {},
        },
        deps.answersPost,
      )
      if (result.deduped) return // cancel 空 answers 迟到 = pending 已被别的路径收口，仅收起不发消息（final fix I-1）
    } catch {
      agent.resolveQuestionPart(callId, 'pending_answer')
      ElMessage.error('提交失败，请重试')
    }
  }

  return { confirmProposeWait, cancelProposeForNode, onAskSubmit, onAskCancel }
}
