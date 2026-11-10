/**
 * 历史失败分窗判据的行为级测试。
 *
 * ⚠️ 断言落在「返回 patch 的可观测形状」上，不落在内部实现/注释里：
 * 把实现改回 `status: 'error'`（M3）或覆盖 `dismissed`（M4）必须转红。
 */
import { describe, expect, it } from 'vitest'
import { resolveDismissFailurePatch, resolveHistoricalFailurePatch } from '@/utils/historicalFailure'

const failedRecord = { id: 'rec-1', status: 'failed' }

describe('resolveHistoricalFailurePatch（加载期对账降级）', () => {
  it('T9 ⭐ 历史 failed 节点 + failed 记录 ⇒ 静态 historical patch，绝不产生 error 转移', () => {
    const patch = resolveHistoricalFailurePatch({ status: 'failed' }, failedRecord)
    expect(patch).not.toBeNull()
    expect(patch!.status).toBe('failed')
    expect(patch!.status).not.toBe('error')
    expect(patch!.failureScope).toBe('historical')
    expect(patch!.generationRecordId).toBe('rec-1')
    expect(patch!.errorMessage).toBeNull()
  })

  it('error / fallback_pending 前序失败终态同样降级', () => {
    expect(resolveHistoricalFailurePatch({ status: 'error' }, failedRecord)?.failureScope).toBe('historical')
    expect(
      resolveHistoricalFailurePatch({ status: 'fallback_pending' }, failedRecord)?.failureScope,
    ).toBe('historical')
  })

  it('error 记录同样降级（不只 failed）', () => {
    expect(
      resolveHistoricalFailurePatch({ status: 'failed' }, { id: 'rec-2', status: 'error' })?.status,
    ).toBe('failed')
  })

  it('T10 ⭐ 用户已忽略（dismissed）不被对账覆盖回 historical', () => {
    const patch = resolveHistoricalFailurePatch(
      { status: 'failed', failureScope: 'dismissed' },
      failedRecord,
    )
    expect(patch!.failureScope).toBe('dismissed')
  })

  it('T11 completed 记录 / 非失败终态节点 ⇒ null（走既有回填逻辑，不降级）', () => {
    expect(resolveHistoricalFailurePatch({ status: 'failed' }, { id: 'r', status: 'completed' })).toBeNull()
    expect(resolveHistoricalFailurePatch({ status: 'generating' }, failedRecord)).toBeNull()
    expect(resolveHistoricalFailurePatch({ status: 'completed' }, failedRecord)).toBeNull()
    expect(resolveHistoricalFailurePatch({ status: 'incomplete' }, failedRecord)).toBeNull()
    expect(resolveHistoricalFailurePatch({}, failedRecord)).toBeNull()
  })

  it('非终态记录（generating / 空）⇒ null', () => {
    expect(resolveHistoricalFailurePatch({ status: 'failed' }, { id: 'r', status: 'generating' })).toBeNull()
    expect(resolveHistoricalFailurePatch({ status: 'failed' }, { id: 'r' })).toBeNull()
  })

  it('降级 patch 不含 url/images/content/mediaInfo（不伪造产物）', () => {
    const patch = resolveHistoricalFailurePatch({ status: 'failed' }, failedRecord)!
    for (const key of ['url', 'images', 'content', 'mediaInfo']) {
      expect(Object.prototype.hasOwnProperty.call(patch, key)).toBe(false)
    }
  })
})

describe('resolveDismissFailurePatch（用户点「忽略」判据）', () => {
  it('T12 ⭐ historical 失败终态 ⇒ 只写 dismissed，不动 status / 产物 / 退费', () => {
    const patch = resolveDismissFailurePatch({ status: 'failed', failureScope: 'historical' })
    expect(patch).toEqual({ failureScope: 'dismissed' })
  })

  it('error / fallback_pending 前序失败终态同样可忽略', () => {
    expect(resolveDismissFailurePatch({ status: 'error', failureScope: 'historical' })).toEqual({
      failureScope: 'dismissed',
    })
    expect(
      resolveDismissFailurePatch({ status: 'fallback_pending', failureScope: 'historical' }),
    ).toEqual({ failureScope: 'dismissed' })
  })

  it('已 dismissed ⇒ null（幂等，不重复落库）', () => {
    expect(
      resolveDismissFailurePatch({ status: 'failed', failureScope: 'dismissed' }),
    ).toBeNull()
  })

  it('scope 缺省 / active ⇒ null（本次真实失败不提供忽略入口）', () => {
    expect(resolveDismissFailurePatch({ status: 'failed' })).toBeNull()
    expect(resolveDismissFailurePatch({ status: 'failed', failureScope: 'active' })).toBeNull()
  })

  it('非失败终态 ⇒ null（生成中 / 已完成 / 未完成不可忽略）', () => {
    for (const status of ['generating', 'completed', 'incomplete', 'uploading', undefined]) {
      expect(resolveDismissFailurePatch({ status, failureScope: 'historical' })).toBeNull()
    }
  })
})
