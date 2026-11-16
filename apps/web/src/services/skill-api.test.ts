// 文件：apps/web/src/services/skill-api.test.ts
// M1-3 web skill-api 单测：信封解包 + 端点路径/字段名对齐 Nest controller。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { unwrapSkillEnvelope, skillApi, SkillApiError } from './skill-api'

const { apiGet, apiPost, apiPatch, apiDelete } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}))
vi.mock('./api', () => ({ api: { get: apiGet, post: apiPost, patch: apiPatch, delete: apiDelete } }))

describe('unwrapSkillEnvelope — 业务信封解包', () => {
  it('code=0 返回 data', async () => {
    await expect(unwrapSkillEnvelope(Promise.resolve({ data: { code: 0, message: 'ok', data: { x: 1 } }, status: 200 }))).resolves.toEqual({ x: 1 })
  })
  it('code!==0 抛 SkillApiError（业务失败不静默）', async () => {
    await expect(
      unwrapSkillEnvelope(Promise.resolve({ data: { code: 403, message: '未审', data: null }, status: 200 })),
    ).rejects.toBeInstanceOf(SkillApiError)
  })
})

describe('skillApi — 端点路径与字段名对齐 Nest', () => {
  beforeEach(() => {
    apiGet.mockReset(); apiPost.mockReset(); apiPatch.mockReset(); apiDelete.mockReset()
    apiGet.mockResolvedValue({ data: { code: 0, data: [] }, status: 200 })
    apiPost.mockResolvedValue({ data: { code: 0, data: {} }, status: 200 })
    apiPatch.mockResolvedValue({ data: { code: 0, data: {} }, status: 200 })
    apiDelete.mockResolvedValue({ data: { code: 0, data: {} }, status: 200 })
  })

  it('catalog 查询参数透传（q/vertical/tag/sort/limit）', async () => {
    await skillApi.catalog({ q: '分镜', vertical: 'short-drama', limit: '20' })
    expect(apiGet).toHaveBeenCalledWith('/skills/catalog', {
      params: { q: '分镜', vertical: 'short-drama', limit: '20' },
    })
  })

  it('mine 无参 GET', async () => {
    await skillApi.mine()
    expect(apiGet).toHaveBeenCalledWith('/skills/mine')
  })

  it('install 用 packageHash 路径，无 body', async () => {
    await skillApi.install('abc123')
    expect(apiPost).toHaveBeenCalledWith('/skills/abc123/install')
  })

  it('setEnabled body 字段名逐字为 enabled', async () => {
    await skillApi.setEnabled('row-1', true)
    expect(apiPatch).toHaveBeenCalledWith('/skills/row-1/enabled', { enabled: true })
  })

  it('uninstall 批量 body 含 ids + confirmed', async () => {
    await skillApi.uninstallBatch(['a', 'b'], true)
    expect(apiPost).toHaveBeenCalledWith('/skills/uninstall', { ids: ['a', 'b'], confirmed: true })
  })

  it('DELETE 单删 confirmed 走 query 字符串 true（非 body）', async () => {
    await skillApi.remove('row-1')
    expect(apiDelete).toHaveBeenCalledWith('/skills/row-1', { params: { confirmed: 'true' } })
  })

  it('invoke body intent 逐字透传', async () => {
    await skillApi.invoke('row-1', 'implicit')
    expect(apiPost).toHaveBeenCalledWith('/skills/row-1/invoke', { intent: 'implicit' })
  })

  it('import body 字段名逐字为 text + sourceType', async () => {
    await skillApi.import('---\nname: x\n---\nbody', 'paste')
    expect(apiPost).toHaveBeenCalledWith('/skills/import', { text: '---\nname: x\n---\nbody', sourceType: 'paste' })
  })
})
