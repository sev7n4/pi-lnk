import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createVideoTimelineTools } from './video-timeline.js'

const calls: Array<{ path: string; body: Record<string, unknown> }> = []
const client = {
  post: async (path: string, body: unknown) => {
    calls.push({ path, body: body as Record<string, unknown> })
    return { ok: true, data: { nodeId: 'vt_1', trackCount: 2, estimatedVisualDurationSec: 5 } }
  },
} as never

const tools = createVideoTimelineTools(client)
const byName = (name: string) => tools.find((t) => t.name === name)!

test('three timeline tools are registered with expected tiers', () => {
  assert.deepEqual(tools.map((t) => [t.name, t.tier]), [
    ['video_timeline_create', 'write_light'],
    ['video_timeline_edit', 'write_light'],
    ['video_timeline_render', 'gen'],
  ])
})

test('create forwards node ids and never accepts urls', async () => {
  calls.length = 0
  const tool = byName('video_timeline_create')
  const res = await tool.execute('id', { title: '雨夜回家', source_node_ids: ['v1', 'i1'] } as never, {} as never, {
    sessionId: 's1', userId: 'u1',
  } as never)
  assert.equal(calls[0]?.path, '/agent/internal/video-timeline/create')
  assert.deepEqual(calls[0]?.body, {
    sessionId: 's1', userId: 'u1', title: '雨夜回家', sourceNodeIds: ['v1', 'i1'],
  })
  assert.match((res.content[0] as { text: string }).text, /"ok":true/)
})

test('edit forwards ops and save marker', async () => {
  calls.length = 0
  const tool = byName('video_timeline_edit')
  await tool.execute('id', { node_id: 'vt_1', ops: [{ op: 'request_render' }], save: true } as never, {} as never, {
    sessionId: 's1', userId: 'u1',
  } as never)
  assert.deepEqual(calls[0]?.body, {
    sessionId: 's1', userId: 'u1', nodeId: 'vt_1', ops: [{ op: 'request_render' }], save: true,
  })
})

test('render carries no self-reported confirmation field', async () => {
  calls.length = 0
  const tool = byName('video_timeline_render')
  await tool.execute('id', { node_id: 'vt_1' } as never, {} as never, {
    sessionId: 's1', userId: 'u1',
  } as never)
  assert.deepEqual(calls[0]?.body, { sessionId: 's1', userId: 'u1', nodeId: 'vt_1' })
})
