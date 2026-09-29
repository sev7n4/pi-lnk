import 'reflect-metadata'
import { BadRequestException, ValidationPipe } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentCanvasToolsController,
  InstantiateRecipeDto,
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
