import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, type VNode } from 'vue'
import { shouldToastForFailure, useGenerationFailureToast } from './useGenerationFailureToast'

vi.mock('element-plus', () => ({
  ElMessage: vi.fn(),
}))

const { ElMessage } = await import('element-plus')

describe('shouldToastForFailure', () => {
  it('generating → error：toast', () => {
    expect(
      shouldToastForFailure({ status: 'generating' }, { status: 'error', errorMessage: '上游超时' }),
    ).toBe(true)
  })
  it('draft → error（参数非法直接失败）：toast', () => {
    expect(
      shouldToastForFailure({ status: 'draft' }, { status: 'error', errorMessage: '积分不足' }),
    ).toBe(true)
  })
  it('已取消（errorMessage 含「已取消」）：不 toast', () => {
    expect(
      shouldToastForFailure(
        { status: 'generating' },
        { status: 'error', errorMessage: '已取消，8 积分已返回' },
      ),
    ).toBe(false)
  })
  it('error → error（重复快照/轮询重放）：不 toast', () => {
    expect(
      shouldToastForFailure(
        { status: 'error', errorMessage: '上游超时' },
        { status: 'error', errorMessage: '上游超时' },
      ),
    ).toBe(false)
  })
  it('completed → error（终态节点被改挂）：不 toast', () => {
    expect(
      shouldToastForFailure({ status: 'completed' }, { status: 'error', errorMessage: 'x' }),
    ).toBe(false)
  })
  it('非 error 终态：不 toast', () => {
    expect(shouldToastForFailure({ status: 'generating' }, { status: 'completed' })).toBe(false)
    expect(shouldToastForFailure({ status: 'generating' }, null)).toBe(false)
  })
})

describe('useGenerationFailureToast', () => {
  const onOpenDetail = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('toast 文案含标题与 userMessage，点击回调带 nodeId', async () => {
    const { onNodeError } = useGenerationFailureToast({ onOpenDetail })
    onNodeError({ id: 'n1', title: '大灰狼视频', status: 'error', errorMessage: '上游超时' })
    expect(ElMessage).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(ElMessage).mock.calls[0][0] as unknown as { message: VNode }
    // ElMessage 选项类型无顶层 onClick：可点击消息以 message VNode 承载（onClick 在 props 上）
    expect((arg.message.children as string)).toBe('大灰狼视频 生成失败：上游超时')
    ;(arg.message.props?.onClick as () => void)()
    expect(onOpenDetail).toHaveBeenCalledWith('n1')
    await nextTick()
  })

  it('同节点重复失败：第二次不 toast（去重）', () => {
    const { onNodeError } = useGenerationFailureToast({ onOpenDetail })
    onNodeError({ id: 'n1', title: 't', status: 'error', errorMessage: 'a' })
    onNodeError({ id: 'n1', title: 't', status: 'error', errorMessage: 'b' })
    expect(ElMessage).toHaveBeenCalledTimes(1)
  })

  it('clearNodeDedupe 后再次失败：第二次 toast（失败→重试→再失败）', () => {
    const { onNodeError, clearNodeDedupe } = useGenerationFailureToast({ onOpenDetail })
    onNodeError({ id: 'n1', title: 't', status: 'error', errorMessage: 'a' })
    clearNodeDedupe('n1')
    onNodeError({ id: 'n1', title: 't', status: 'error', errorMessage: 'b' })
    expect(ElMessage).toHaveBeenCalledTimes(2)
  })

  it('不同节点各自 toast', () => {
    const { onNodeError } = useGenerationFailureToast({ onOpenDetail })
    onNodeError({ id: 'n1', title: 't1', status: 'error', errorMessage: 'a' })
    onNodeError({ id: 'n2', title: 't2', status: 'error', errorMessage: 'b' })
    expect(ElMessage).toHaveBeenCalledTimes(2)
  })
})
