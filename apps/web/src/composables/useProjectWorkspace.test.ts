import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

/**
 * ⚠️ mock 句柄必须走 `vi.hoisted`：`vi.mock` 的工厂会被提升到 import 之前，
 * 工厂里**直接引用顶层 const** 会撞 TDZ（报 "error when mocking a module"）。
 * 用 `vi.hoisted` 声明的变量与工厂同批初始化，是本仓测试的标准写法。
 */
const { listMock, createMock, updateMock, removeMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn(),
  removeMock: vi.fn(),
}))

vi.mock('@/services/canvas-api', () => ({
  canvasApi: {
    list: (cfg?: unknown) => listMock(cfg),
    create: () => createMock(),
    update: (...args: unknown[]) => updateMock(...args),
  },
}))
vi.mock('@/services/sessions-api', () => ({ sessionsApi: { remove: removeMock } }))

import { useProjectWorkspace, PROJECT_LIST_TIMEOUT_MS } from './useProjectWorkspace'
import { useAuthStore } from '@/stores/auth'

function seedUser(id: string) {
  const auth = useAuthStore()
  auth.user = { id } as never
}

function proj(id: string, extra: Partial<{ title: string; updatedAt: string; coverUrl: string | null; coverNodeId: string | null }> = {}) {
  return {
    id,
    title: extra.title ?? `t-${id}`,
    updatedAt: extra.updatedAt ?? '2026-10-01T00:00:00Z',
    coverUrl: extra.coverUrl ?? null,
    coverNodeId: extra.coverNodeId ?? null,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  listMock.mockReset()
  createMock.mockReset()
  updateMock.mockReset()
  removeMock.mockReset()
})

describe('useProjectWorkspace', () => {
  it('list 失败：error=true、返回空、不创建任何项目（INV-6）', async () => {
    seedUser('u1')
    listMock.mockRejectedValue(new Error('timeout'))
    const ws = useProjectWorkspace()
    const out = await ws.list()
    expect(out).toEqual([])
    expect(ws.error.value).toBe(true)
    expect(ws.loading.value).toBe(false)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('list 默认带 15s 超时（2026-10-19 事故兜底，删了就是回归）', async () => {
    seedUser('u1')
    listMock.mockResolvedValue({ data: { data: [] } })
    const ws = useProjectWorkspace()
    await ws.list()
    expect(listMock).toHaveBeenCalledWith({ timeout: PROJECT_LIST_TIMEOUT_MS })
    expect(PROJECT_LIST_TIMEOUT_MS).toBe(15_000)
  })

  it('list 成功：projects 被填充为单一数据源（INV-10）', async () => {
    seedUser('u1')
    listMock.mockResolvedValue({ data: { data: [proj('p1'), proj('p2')] } })
    const ws = useProjectWorkspace()
    await ws.list()
    expect(ws.projects.value.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(ws.error.value).toBe(false)
  })

  it('记忆的项目被删除后：resolveTarget 回落，不把用户送进 404（Review Focus #4）', async () => {
    seedUser('u1')
    listMock.mockResolvedValue({ data: { data: [proj('p2')] } })
    const ws = useProjectWorkspace()
    await ws.list()
    ws.rememberProject('p-gone')
    // 记忆值本身仍读得到（纯读取），但 resolveTarget 校验它不在 list 中 ⇒ 回落
    expect(ws.resolveLastProjectId()).toBe('p-gone')
    expect(ws.resolveTarget()?.id).toBe('p2')
  })

  it('不同 userId 的记忆互不相串（换号天然隔离）', async () => {
    seedUser('u1')
    const a = useProjectWorkspace()
    a.rememberProject('p1')
    seedUser('u2')
    const b = useProjectWorkspace()
    expect(b.resolveLastProjectId()).toBeNull()
    seedUser('u1')
    expect(useProjectWorkspace().resolveLastProjectId()).toBe('p1')
  })

  it('create 无条件调用一次，且不传 title（Review Focus #5 + §3.3）', async () => {
    seedUser('u1')
    createMock.mockResolvedValue({ data: { data: proj('p-new', { title: '未命名项目' }) } })
    const ws = useProjectWorkspace()
    const created = await ws.create()
    expect(createMock).toHaveBeenCalledTimes(1)
    // ⛔ 不传 title：标题由后端默认值决定（IA v4 = 「未命名项目」）。
    //    前端传死「未命名画布」是 IA v4 之前的旧行为，且会让后端 list 的
    //    「未命名 → 项目 N」编号兜底对新建项失效。
    expect(createMock).toHaveBeenCalledWith()
    expect(created.id).toBe('p-new')
    // 建完即记住，供 resolveTarget 使用
    expect(ws.resolveLastProjectId()).toBe('p-new')
  })

  it('create 拿不到 id 时抛错，不写坏记忆', async () => {
    seedUser('u1')
    createMock.mockResolvedValue({ data: { data: null } })
    const ws = useProjectWorkspace()
    await expect(ws.create()).rejects.toThrow()
    expect(ws.resolveLastProjectId()).toBeNull()
  })

  it('resolveTarget：记忆有效 → 有产物 → list[0] → null（spec §3.0.2 环节 3）', async () => {
    seedUser('u1')
    listMock.mockResolvedValue({
      data: {
        data: [
          proj('p-empty', { coverUrl: null, updatedAt: '2026-10-25T00:00:00Z' }),
          proj('p-art', { coverUrl: 'https://cdn/x.png', updatedAt: '2026-10-24T00:00:00Z' }),
        ],
      },
    })
    const ws = useProjectWorkspace()
    await ws.list()

    // ① 无记忆 ⇒ 取最近**有产物**的，不是 list[0]（最近更新的可能是个空项目）
    expect(ws.resolveTarget()?.id).toBe('p-art')

    // ② 有有效记忆 ⇒ 优先记忆
    ws.rememberProject('p-empty')
    expect(ws.resolveTarget()?.id).toBe('p-empty')

    // ③ 记忆失效（不在 list 中）⇒ 回落有产物的
    ws.rememberProject('p-gone')
    expect(ws.resolveTarget()?.id).toBe('p-art')

    // ④ list 为空 ⇒ null（调用方据此走「零项目」分支）
    listMock.mockResolvedValue({ data: { data: [] } })
    await ws.list()
    expect(ws.resolveTarget()).toBeNull()
  })

  it('rename：走后端 update 并同步本地 projects', async () => {
    seedUser('u1')
    listMock.mockResolvedValue({ data: { data: [proj('p1', { title: '旧' })] } })
    const ws = useProjectWorkspace()
    await ws.list()
    await ws.rename('p1', '新名字')
    expect(updateMock).toHaveBeenCalledWith('p1', { title: '新名字' })
    expect(ws.projects.value[0]!.title).toBe('新名字')
  })

  it('remove：走 sessionsApi.remove 并同步本地 projects', async () => {
    seedUser('u1')
    listMock.mockResolvedValue({ data: { data: [proj('p1'), proj('p2')] } })
    removeMock.mockResolvedValue({})
    const ws = useProjectWorkspace()
    await ws.list()
    await ws.remove('p1')
    expect(removeMock).toHaveBeenCalledWith('p1')
    expect(ws.projects.value.map((p) => p.id)).toEqual(['p2'])
  })
})

// ---------------------------------------------------------------------------
// 2026-10-25 生产实证（用户报「点全部项目 → 抽屉只显示几个 → 过会变项目加载失败」）：
//   ① 一次后台刷新失败**把已加载的清单清空** ⇒ 用户正在看的项目一起消失；
//   ② 同一时刻重复拉列表 ⇒ 两个请求抢同一条被 SSE 占满的连接通道 ⇒ 后到的那个超时；
//   ③ 抽屉打开时无条件重拉 ⇒ 必然发出一次注定排队的请求。
// ---------------------------------------------------------------------------
describe('useProjectWorkspace：失败不得毁掉已有数据 / 不重复打接口', () => {
  beforeEach(() => {
    listMock.mockReset()
    createMock.mockReset()
    updateMock.mockReset()
    removeMock.mockReset()
    seedUser('u1')
  })

  it('刷新失败**不清空**已有清单（error 仍是「这次没拿到」的信号）', async () => {
    const ws = useProjectWorkspace()
    listMock.mockResolvedValue({ data: { data: [proj('p1'), proj('p2')] } })
    await ws.list()
    expect(ws.projects.value.map((p) => p.id)).toEqual(['p1', 'p2'])

    // 后台刷新失败
    listMock.mockRejectedValue(new Error('timeout'))
    const out = await ws.list()
    expect(ws.error.value, 'error 必须置位：调用方靠它区分「失败」与「零项目」').toBe(true)
    expect(
      ws.projects.value.map((p) => p.id),
      '失败不得清空已有清单（清空 = 用户正在看的项目一起消失）',
    ).toEqual(['p1', 'p2'])
    expect(out, '返回值仍要表达「这次没拿到」⇒ 空数组').toEqual([])
  })

  it('同一时刻的重复 list 只发一次请求（single-flight）', async () => {
    const ws = useProjectWorkspace()
    let resolveFn: (v: unknown) => void = () => {}
    listMock.mockImplementation(
      () => new Promise((res) => { resolveFn = res as (v: unknown) => void }),
    )
    const a = ws.list()
    const b = ws.list()
    expect(listMock, '并发调用必须共享同一个在途请求').toHaveBeenCalledTimes(1)
    resolveFn({ data: { data: [proj('p1')] } })
    await a
    await b
    expect(ws.projects.value.map((p) => p.id)).toEqual(['p1'])
  })

  it('loadIfStale：数据还新鲜时不重复请求；已失败（数据是旧的）时仍要重试得动', async () => {
    const ws = useProjectWorkspace()
    listMock.mockResolvedValue({ data: { data: [proj('p1')] } })
    await ws.list()
    listMock.mockClear()

    // 新鲜期内 ⇒ 不发请求，直接用内存里的
    await ws.loadIfStale()
    expect(listMock, '新鲜期内不得重复打接口（会排队 → 15s 超时 → 假失败）').toHaveBeenCalledTimes(0)
    expect(ws.projects.value.map((p) => p.id)).toEqual(['p1'])

    // 失败后数据仍是旧的 ⇒ 刷新必须真的重试（否则用户点「重试」永远没反应）
    listMock.mockRejectedValue(new Error('timeout'))
    await ws.list()
    expect(ws.error.value).toBe(true)
    listMock.mockClear()
    listMock.mockResolvedValue({ data: { data: [proj('p1'), proj('p9')] } })
    await ws.list()
    expect(listMock, '失败后的重试必须真的发请求').toHaveBeenCalledTimes(1)
    expect(ws.error.value).toBe(false)
    expect(ws.projects.value.map((p) => p.id)).toEqual(['p1', 'p9'])
  })

  it('新建的项目立刻进清单（新建完在抽屉里要能看见自己刚建的）', async () => {
    const ws = useProjectWorkspace()
    listMock.mockResolvedValue({ data: { data: [proj('p1')] } })
    await ws.list()
    createMock.mockResolvedValue({ data: { data: proj('p-new') } })
    await ws.create()
    expect(ws.projects.value.map((p) => p.id)).toEqual(['p-new', 'p1'])
  })
})
