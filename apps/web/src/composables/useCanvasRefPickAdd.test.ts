import { describe, expect, it, beforeEach } from 'vitest'
import { useCanvasRefPickAdd } from './useCanvasRefPickAdd'
import { useSidebarAttachments } from './useSidebarAttachments'

describe('useCanvasRefPickAdd', () => {
  beforeEach(() => {
    useSidebarAttachments().clear()
  })

  it('addNodesToRefs writes to the shared singleton (does not depend on agentRailRef)', () => {
    const { addNodesToRefs } = useCanvasRefPickAdd()
    const r = addNodesToRefs([{ id: 'n1', type: 'image', data: { url: 'https://x/1.jpg' } }])
    expect(r.added).toBe(1)
    // 落库不依赖侧栏实例：单例里已持有
    expect(useSidebarAttachments().pendingAttachments.value).toHaveLength(1)
  })

  it('showRefPickToast sets refPickToast with the count', () => {
    const { showRefPickToast, refPickToast } = useCanvasRefPickAdd()
    showRefPickToast(3)
    expect(refPickToast.value?.count).toBe(3)
  })

  it('showRefPickToast(0) is a no-op', () => {
    const { showRefPickToast, refPickToast } = useCanvasRefPickAdd()
    showRefPickToast(0)
    expect(refPickToast.value).toBeNull()
  })

  it('bumpSessionAdded / resetSessionAdded track the pick-session count', () => {
    const { bumpSessionAdded, resetSessionAdded, sessionAdded } = useCanvasRefPickAdd()
    bumpSessionAdded(2)
    bumpSessionAdded(1)
    expect(sessionAdded.value).toBe(3)
    resetSessionAdded()
    expect(sessionAdded.value).toBe(0)
  })
})
