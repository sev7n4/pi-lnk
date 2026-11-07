import { type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { AgentPresentationEnvelope } from '@/components/agent/presentation/types'
import { isRunCancelledState } from '@/components/agent/agentInterruptGate'
import {
  clearForkedThreadId,
  createAgentThreadId,
  persistActiveThreadId,
  resolveBootstrapThreadId,
} from '@/components/agent/streamRecovery'
import { emptyTaskProgress, type AgentTaskProgressState } from '@/components/agent/agentTaskProgress'

/**
 * 第九刀（strangler-fig，2026-11-08）：线程生命周期簇从 AgentSideRail 抽离。
 *
 * 所有权边界（沿用第八刀原则）：`agentThreadId` 与 `threads` 两个 ref 仍由父组件持有，
 * 此处只注入并写入——父组件内 SSE 订阅 / send / fork / rerun 等约 129 处读取
 * `agentThreadId.value` 的代码零改动。composable 仅承载「线程的创建 / 切换 / bootstrap /
 * 归档判定 / 取消态同步」这一组内聚职责，其余 run/session 状态（taskProgress / runCancelled /
 * threadRunState / followLatest …）由父组件注入，函数体逐字搬运以保证零行为变化。
 */

export interface AgentThreadRow {
  id: string
  title: string
  updatedAt: string
  createdAt: string
  /** H0-c：迁移置非空 ⇒ 历史面板渲染禁用态（legacy 线程即将合并到主对话） */
  archivedAt?: string | null
  /** H1-b：服务端 groupBy 随 threads 行带回的计数（bootstrap 不再全量下载消息为数数，D3） */
  messageCount?: number
}

interface ThreadCancelState {
  phase?: string | null
  runCancelled?: boolean | null
  presentation?: AgentPresentationEnvelope | null
}

export interface AgentThreadDeps {
  agentThreadId: Ref<string>
  threads: Ref<AgentThreadRow[]>
  historyOpen: Ref<boolean>
  taskProgress: Ref<AgentTaskProgressState>
  runCancelled: Ref<boolean>
  threadRunState: Ref<{ phase?: string | null; runCancelled?: boolean | null } | null>
  cancelledPresentation: Ref<AgentPresentationEnvelope | null>
  cancelledProgressText: Ref<string | null>
  recoveredPhaseHint: Ref<string | null>
  followLatest: Ref<boolean>
  hasNewBelow: Ref<boolean>
  clearComposer: () => void
  clearAgent: () => void
  loadHistory: () => Promise<void>
  fetchThreads: () => Promise<AgentThreadRow[] | null>
  scrollToBottom: (force?: boolean) => void
  getSessionId: () => string
}

export interface AgentThreadApi {
  isArchivedThread: (thread: AgentThreadRow) => boolean
  selectThread: (threadId: string) => Promise<void>
  bootstrapThread: () => Promise<void>
  newAgentSession: () => void
  syncCancelledFromThreadState: (state: ThreadCancelState | null | undefined) => boolean
  refreshThreadCheckpoint: () => Promise<void>
}

export function useAgentThread(deps: AgentThreadDeps): AgentThreadApi {
  const {
    agentThreadId,
    threads,
    historyOpen,
    taskProgress,
    runCancelled,
    threadRunState,
    cancelledPresentation,
    cancelledProgressText,
    recoveredPhaseHint,
    followLatest,
    hasNewBelow,
    clearComposer,
    clearAgent,
    loadHistory,
    fetchThreads,
    scrollToBottom,
    getSessionId,
  } = deps

  /**
   * H0-c（规格 §2/§5.2 谓词解耦）：归档行（迁移置 archivedAt）渲染禁用态，停止「点了没反应」。
   * 谓词必须是 archivedAt 而非 id 比较——在役 fork（重跑）分支 id 同为 sessionId:后缀 复合键。
   * 合并迁移注（2026-10-29）：PC 侧栏历史入口已随 ADR-0015 删除，现消费方为移动端对话历史面板。
   */
  function isArchivedThread(thread: AgentThreadRow): boolean {
    return thread.archivedAt != null
  }

  async function selectThread(threadId: string) {
    // 多端共享对话（2026-10-26）：只允许切到确定式共享 threadId（= sessionId）。
    // 历史面板可能列出旧的随机 thread，切到它们会让本端与该画布其它设备发散，
    // 故直接忽略（关闭面板、不切换）。
    if (threadId !== getSessionId()) {
      historyOpen.value = false
      return
    }
    if (threadId === agentThreadId.value) {
      historyOpen.value = false
      return
    }
    clearComposer()
    agentThreadId.value = threadId
    persistActiveThreadId(getSessionId(), threadId)
    // 守卫保证此处 threadId === sessionId（共享线程）：用户显式离开重跑分支，
    // 必须同步清 fork key，否则下次刷新 resolveBootstrapThreadId 会把本端弹回分支
    // ——「返回主对话」活不过一次刷新（Phase 1 评审发现 F1）。
    clearForkedThreadId(getSessionId())
    historyOpen.value = false
    taskProgress.value = emptyTaskProgress()
    runCancelled.value = false
    threadRunState.value = null
    cancelledPresentation.value = null
    cancelledProgressText.value = null
    recoveredPhaseHint.value = null
    await loadHistory()
    void refreshThreadCheckpoint()
  }

  async function bootstrapThread() {
    clearComposer()
    clearAgent()
    taskProgress.value = emptyTaskProgress()
    const list = await fetchThreads()
    threads.value = list ?? threads.value
    agentThreadId.value = await resolveBootstrapThreadId(getSessionId(), { threads: list })
    persistActiveThreadId(getSessionId(), agentThreadId.value)
    await loadHistory()
    void refreshThreadCheckpoint()
    scrollToBottom(true)
  }

  function newAgentSession() {
    clearComposer()
    clearAgent()
    taskProgress.value = emptyTaskProgress()
    runCancelled.value = false
    threadRunState.value = null
    cancelledPresentation.value = null
    cancelledProgressText.value = null
    recoveredPhaseHint.value = null
    agentThreadId.value = createAgentThreadId(getSessionId())
    persistActiveThreadId(getSessionId(), agentThreadId.value)
    ElMessage.info('已开始新对话')
    // 新会话：列表清空，跟随状态一并复位（否则会卡在「回看历史」态）
    followLatest.value = true
    hasNewBelow.value = false
  }

  function syncCancelledFromThreadState(
    state: ThreadCancelState | null | undefined,
  ): boolean {
    threadRunState.value = state
      ? { phase: state.phase ?? null, runCancelled: state.runCancelled ?? null }
      : null
    const cancelled = isRunCancelledState(state)
    if (cancelled) {
      cancelledPresentation.value = state?.presentation ?? null
    } else if (!runCancelled.value) {
      // A gate-preserved stop leaves the checkpoint uncancelled; keep the local callout.
      cancelledPresentation.value = null
      cancelledProgressText.value = null
    }
    return cancelled
  }

  /**
   * 重连/切换线程时的终态对账。
   *
   * H1-c（规格 2026-10-28 §5.2）：thread-state 读取已退役（恒返 null 的死端点连同前端
   * 调用一并删除）。恒 null 下只可能同步「运行已停止」这一项 ⇒ 与退役前生产现状
   * （端点恒返 null）行为一致，仅做一次状态复位。
   * 终态判定待 H3 seq 游标窗重接 turnState（规格 §12）。
   */
  async function refreshThreadCheckpoint() {
    syncCancelledFromThreadState(null)
  }

  return {
    isArchivedThread,
    selectThread,
    bootstrapThread,
    newAgentSession,
    syncCancelledFromThreadState,
    refreshThreadCheckpoint,
  }
}
