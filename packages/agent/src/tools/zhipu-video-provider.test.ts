import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ZhipuVideoProvider,
  isZhipuBaseUrl,
  isZhipuVideoModel,
} from './zhipu-video-provider'
import { createVideoProvider } from './video-provider'

describe('isZhipuVideoModel / isZhipuBaseUrl', () => {
  it('cogvideox 家族名与大模型 host 判真，其余判假', () => {
    expect(isZhipuVideoModel('cogvideox-flash')).toBe(true)
    expect(isZhipuVideoModel('CogVideoX-3')).toBe(true)
    expect(isZhipuVideoModel('agnes-video-2.5-flash')).toBe(false)
    expect(isZhipuVideoModel(undefined)).toBe(false)
    expect(isZhipuBaseUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(true)
    expect(isZhipuBaseUrl('https://api.z.ai/api/paas/v4')).toBe(true)
    expect(isZhipuBaseUrl('https://apihub.agnes-ai.com/v1')).toBe(false)
    expect(isZhipuBaseUrl(undefined)).toBe(false)
  })
})

describe('createVideoProvider 分发', () => {
  it('cogvideox 模型名 → ZhipuVideoProvider；缺 key 显式失败', () => {
    expect(createVideoProvider({ model: 'cogvideox-flash', apiKey: 'k' })).toBeInstanceOf(
      ZhipuVideoProvider,
    )
    expect(() => createVideoProvider({ model: 'cogvideox-flash' })).toThrow(/智谱/)
    expect(() => createVideoProvider({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4' })).toThrow(
      /智谱/,
    )
  })
})

describe('ZhipuVideoProvider.generate', () => {
  const env = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env = { ...env }
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    process.env = env
    vi.unstubAllGlobals()
  })

  it('创建 → 轮询 SUCCESS → 返回 video_result[0].url（不冒充 lastFrameUrl）', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'task-1', task_status: 'PROCESSING' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task_status: 'PROCESSING',
          video_result: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task_status: 'SUCCESS',
          video_result: [{ url: 'https://cdn.example.com/v.mp4', cover_image_url: 'https://cdn.example.com/c.png' }],
        }),
      })
    const provider = new ZhipuVideoProvider('zk', 'https://open.bigmodel.cn/api/paas/v4', 'cogvideox-flash', 1, 5, 1)
    const out = await provider.generate('一只猫')
    expect(out).toEqual({ url: 'https://cdn.example.com/v.mp4' })
    expect(out.lastFrameUrl).toBeUndefined()
    // 创建 URL 与轮询 URL（async-result 契约）
    const createCall = fetchMock.mock.calls[0]!
    expect(String(createCall[0])).toBe('https://open.bigmodel.cn/api/paas/v4/videos/generations')
    expect(JSON.parse(createCall[1]!.body)).toMatchObject({ model: 'cogvideox-flash', prompt: '一只猫' })
    const pollCall = fetchMock.mock.calls[1]!
    expect(String(pollCall[0])).toBe('https://open.bigmodel.cn/api/paas/v4/async-result/task-1')
  })

  it('图生视频：image/referenceImages 进 image_url（≤2 张=首尾帧）', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'task-2', task_status: 'PROCESSING' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task_status: 'SUCCESS',
          video_result: [{ url: 'https://cdn.example.com/v2.mp4' }],
        }),
      })
    const provider = new ZhipuVideoProvider('zk', undefined, 'cogvideox-flash', 1, 5, 1)
    await provider.generate('让它动起来', {
      image: 'https://cdn.example.com/first.png',
      referenceImages: ['https://cdn.example.com/first.png', 'https://cdn.example.com/last.png'],
    })
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body)
    expect(body.image_url).toEqual([
      'https://cdn.example.com/first.png',
      'https://cdn.example.com/last.png',
    ])
  })

  it('创建 429 → withVideoRetry 退避重试后成功', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => '访问量过大' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'task-3', task_status: 'PROCESSING' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task_status: 'SUCCESS',
          video_result: [{ url: 'https://cdn.example.com/v3.mp4' }],
        }),
      })
    const provider = new ZhipuVideoProvider('zk', undefined, 'cogvideox-flash', 1, 5, 1)
    const out = await provider.generate('测试重试')
    expect(out.url).toBe('https://cdn.example.com/v3.mp4')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('task FAIL → 抛错（带上游 error 原文）', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'task-4', task_status: 'PROCESSING' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task_status: 'FAIL',
          error: { code: '1302', message: '内容审核未通过' },
        }),
      })
    const provider = new ZhipuVideoProvider('zk', undefined, 'cogvideox-flash', 1, 5, 1)
    await expect(provider.generate('违规内容')).rejects.toThrow(/内容审核未通过/)
  })

  it('轮询耗尽 → 显式超时错误', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'task-5', task_status: 'PROCESSING', video_result: [] }),
    })
    const provider = new ZhipuVideoProvider('zk', undefined, 'cogvideox-flash', 1, 3, 1)
    await expect(provider.generate('慢任务')).rejects.toThrow(/timed out after 3 polls/)
  })
})
