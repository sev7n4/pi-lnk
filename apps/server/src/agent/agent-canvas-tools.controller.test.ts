import 'reflect-metadata'
import { BadRequestException, ValidationPipe } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentCanvasToolsController,
  InstantiateRecipeDto,
  RunTextGenerationDto,
  SaveMemoryDto,
  SearchMemoryDto,
  UpdateNodeDto,
} from './agent-canvas-tools.controller'

describe('InstantiateRecipeDto', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true })

  it('keeps parentId, delta, and slots under ValidationPipe whitelist', async () => {
    const delta = { remove: ['banner'] }

    const result = await pipe.transform(
      {
        sessionId: 's1',
        userId: 'u1',
        parentId: 'ecommerce-product-visual',
        parentVersion: '1.0.0',
        delta,
        slots: { white_bg: 'a white mug' },
      },
      { type: 'body', metatype: InstantiateRecipeDto },
    )

    expect(result.parentId).toBe('ecommerce-product-visual')
    expect(result.delta).toEqual(delta)
    expect(result.slots).toEqual({ white_bg: 'a white mug' })
  })
})

describe('UpdateNodeDto（spec S2 端点）', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true })
  const meta = { type: 'body' as const, metatype: UpdateNodeDto }

  it('patch 作为对象原样透传（whitelist 不剥离）', async () => {
    const patch = { title: '茶馆主视觉', imageModel: 'platform::seedream-5.0-pro' }
    const result = await pipe.transform({ sessionId: 's1', userId: 'u1', nodeId: 'n1', patch }, meta)
    expect(result.patch).toEqual(patch)
  })

  it('缺 patch → ValidationPipe 拒绝', async () => {
    await expect(pipe.transform({ sessionId: 's1', userId: 'u1', nodeId: 'n1' }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('patch 非对象（字符串）→ ValidationPipe 拒绝', async () => {
    await expect(
      pipe.transform({ sessionId: 's1', userId: 'u1', nodeId: 'n1', patch: 'oops' }, meta),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})

describe('AgentCanvasToolsController 新端点透传', () => {
  const makeController = () => {
    const updateNode = vi.fn(async () => ({ nodeId: 'n1', actions: [] }))
    const listNodeModelOptions = vi.fn(async () => ({ modalities: { image: [] } }))
    const controller = new AgentCanvasToolsController(
      { updateNode, listNodeModelOptions } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    return { controller, updateNode, listNodeModelOptions }
  }

  it('update-node 把 dto 透传给 service 并包成 {code:0,data}', async () => {
    const { controller, updateNode } = makeController()
    const dto = { sessionId: 's1', userId: 'u1', nodeId: 'n1', patch: { title: 'X' } }
    const out = await controller.updateNode(dto)
    expect(updateNode).toHaveBeenCalledWith(dto)
    expect(out).toEqual({ code: 0, message: 'ok', data: { nodeId: 'n1', actions: [] } })
  })

  it('list-model-options 把 dto 透传给 service 并包成 {code:0,data}', async () => {
    const { controller, listNodeModelOptions } = makeController()
    const out = await controller.listModelOptions({ userId: 'u1' })
    expect(listNodeModelOptions).toHaveBeenCalledWith({ userId: 'u1' })
    expect(out).toEqual({ code: 0, message: 'ok', data: { modalities: { image: [] } } })
  })
})

// ── 记忆作用域透传（spec 2026-10-03-agent-memory-scope-isolation-design.md）──
// 风险点：全局ValidationPipe 带 whitelist:true，DTO 没声明的字段会被**静默剥离**——
// sessionId/scope 被吞掉的话，pi-runtime 侧一切作用域隔离都失效且不报错。

describe('SaveMemoryDto（作用域透传）', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true })
  const meta = { type: 'body' as const, metatype: SaveMemoryDto }

  it('DTO 类真实存在（否则 ValidationPipe 跳过校验，下面全是假通过）', () => {
    expect(typeof SaveMemoryDto).toBe('function')
  })

  it('sessionId 不被 whitelist 剥离', async () => {
    const result = await pipe.transform({ userId: 'u1', content: '本画布项目知识', sessionId: 'S1' }, meta)
    expect(result.sessionId).toBe('S1')
  })

  it('scope 不被剥离，且保留 user 取值', async () => {
    const result = await pipe.transform({ userId: 'u1', content: '暗号', scope: 'user' }, meta)
    expect(result.scope).toBe('user')
  })

  it('scope 非法值 →拒绝（不静默当canvas 写入）', async () => {
    await expect(pipe.transform({ userId: 'u1', content: 'x', scope: 'thread' }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })
})

describe('SearchMemoryDto（作用域透传）', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true })
  const meta = { type: 'body' as const, metatype: SearchMemoryDto }

  it('DTO 类真实存在（否则 ValidationPipe 跳过校验）', () => {
    expect(typeof SearchMemoryDto).toBe('function')
  })

  it('sessionId 与 scope 均不被剥离', async () => {
    const result = await pipe.transform({ userId: 'u1', query: '小熊', sessionId: 'S1', scope: 'canvas' }, meta)
    expect(result.sessionId).toBe('S1')
    expect(result.scope).toBe('canvas')
  })

  it('scope=any 也放行（召回默认档）', async () => {
    const result = await pipe.transform({ userId: 'u1', scope: 'any' }, meta)
    expect(result.scope).toBe('any')
  })

  it('scope 非法值 → 拒绝', async () => {
    await expect(pipe.transform({ userId: 'u1', scope: 'everything' }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it('缺 sessionId 时不补默认值（fail-closed 交给 service，DTO 不臆造）', async () => {
    const result = await pipe.transform({ userId: 'u1' }, meta)
    expect(result.sessionId).toBeUndefined()
    expect(result.scope).toBeUndefined()
  })
})

describe('AgentCanvasToolsController memory 端点透传', () => {
  const makeController = () => {
    const saveMemory = vi.fn(async () => ({ id: 'm1', createdAt: 'c', scope: 'canvas', sessionId: 'S1' }))
    const searchMemory = vi.fn(async () => ({ items: [] }))
    const controller = new AgentCanvasToolsController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { saveMemory, searchMemory } as never,
    )
    return { controller, saveMemory, searchMemory }
  }

  it('memory-save 把含sessionId 的 dto 整个透传给 service', async () => {
    const { controller, saveMemory } = makeController()
    const dto = { userId: 'u1', content: '《小熊和小爸爸》设定', sessionId: 'S1' }
    const out = await controller.saveMemory(dto)
    expect(saveMemory).toHaveBeenCalledWith(dto)
    expect(out).toEqual({
      code: 0,
      message: 'ok',
      data: { id: 'm1', createdAt: 'c', scope: 'canvas', sessionId: 'S1' },
    })
  })

  it('memory-search 把含 scope 的 dto 整个透传给 service', async () => {
    const { controller, searchMemory } = makeController()
    const dto = { userId: 'u1', query: '小熊', sessionId: 'S1', scope: 'any' as const }
    await controller.searchMemory(dto)
    expect(searchMemory).toHaveBeenCalledWith(dto)
  })

  it('memory-search 无 sessionId 时不补undefined 键以外的东西（service 负责 fail-closed）', async () => {
    const { controller, searchMemory } = makeController()
    await controller.searchMemory({ userId: 'u1' })
    expect(searchMemory).toHaveBeenCalledWith({ userId: 'u1' })
  })
})

// ⛔ 强制验收项：main.ts:30 是 whitelist:true，漏 @IsOptional() 会被静默剥字段
describe('RunTextGenerationDto', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true })
  const base = { sessionId: 's1', userId: 'u1', nodeId: 'n1' }

  it('keeps nodeContext under ValidationPipe whitelist', async () => {
    const nodeContext = {
      selectionDigest: '当前选中：分镜-03',
      canvasSummary: '画布共 7 个节点',
    }

    const result = await pipe.transform(
      { ...base, nodeContext },
      { type: 'body', metatype: RunTextGenerationDto },
    )

    expect(result.nodeContext).toEqual(nodeContext)
  })

  it('allows nodeContext to be omitted entirely', async () => {
    const result = await pipe.transform(base, {
      type: 'body',
      metatype: RunTextGenerationDto,
    })
    expect(result.nodeContext).toBeUndefined()
  })

  it('allows a partial nodeContext (only one of the two fields)', async () => {
    const result = await pipe.transform(
      { ...base, nodeContext: { canvasSummary: '画布共 2 个节点' } },
      { type: 'body', metatype: RunTextGenerationDto },
    )
    expect(result.nodeContext).toEqual({ canvasSummary: '画布共 2 个节点' })
  })
})
