/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import {
  seedTaskProgressFromEvents,
  applyPollRecordToTask,
  applyTaskEvent,
  emptyTaskProgress,
  formatTaskProgressLine,
  mapRecordStatusToTaskStatus,
} from './agentTaskProgress'

describe('formatTaskProgressLine', () => {
  it('shows done/total and current running title', () => {
    const line = formatTaskProgressLine([
      { id: 'a', title: '白底主图', status: 'done' },
      { id: 'b', title: '礼盒主视觉', status: 'running' },
      { id: 'c', title: '送礼场景', status: 'pending' },
    ])
    expect(line).toBe('已完成 1/3 · 正在生成：礼盒主视觉')
  })

  it('falls back to first pending when nothing running', () => {
    const line = formatTaskProgressLine([
      { id: 'a', title: '白底主图', status: 'done' },
      { id: 'b', title: '礼盒主视觉', status: 'pending' },
    ])
    expect(line).toBe('已完成 1/2 · 正在生成：礼盒主视觉')
  })

  it('C1 呈现链：running 项优先用 activeForm 作为阶段说明', () => {
    const line = formatTaskProgressLine([
      { id: 'a', title: '确定活动主题和 slogan', status: 'done' },
      { id: 'b', title: '写三条朋友圈预热文案', status: 'running', activeForm: '正在写预热文案' },
    ])
    expect(line).toBe('已完成 1/2 · 正在生成：正在写预热文案')
  })
})

describe('applyTaskEvent', () => {
  it('stores banner from task_list', () => {
    const s = applyTaskEvent(emptyTaskProgress(), {
      type: 'task_list',
      data: {
        items: [{ id: 'a', title: '礼盒主视觉', nodeId: 'n1' }],
        banner: '出图进行中，请勿切换标签页',
      },
    })
    expect(s.banner).toBe('出图进行中，请勿切换标签页')
  })

  it('C1 payload 先行消费：task_list items 携带 status/activeForm（V-B′ 三态）', () => {
    const s = applyTaskEvent(emptyTaskProgress(), {
      type: 'task_list',
      data: {
        items: [
          { id: 'a', title: '起稿', status: 'running', activeForm: '正在起稿' },
          { id: 'b', title: '配图', status: 'pending' },
          { id: 'c', title: '导出', status: 'done' },
        ],
      },
    })
    expect(s.items[0]).toMatchObject({ status: 'running', activeForm: '正在起稿' })
    expect(s.items[1].status).toBe('pending')
    expect(s.items[2].status).toBe('done')
  })

  it('向后兼容：无 status 的旧 task_list（⟦plan⟧ 重放）仍渲染 pending', () => {
    const s = applyTaskEvent(emptyTaskProgress(), {
      type: 'task_list',
      data: { items: [{ id: 'a', title: '旧协议条目' }] },
    })
    expect(s.items[0].status).toBe('pending')
    expect(s.items[0].activeForm).toBeUndefined()
  })

  it('C1 呈现链：task_update 携带的 title/activeForm 落到 item（Nest snapshot 反查）', () => {
    let s = applyTaskEvent(emptyTaskProgress(), {
      type: 'task_list',
      data: { items: [{ id: 'a', title: '起稿' }] },
    })
    s = applyTaskEvent(s, {
      type: 'task_update',
      data: { id: 'a', status: 'running', title: '起稿', activeForm: '正在起稿' },
    })
    expect(s.items[0]).toMatchObject({ status: 'running', title: '起稿', activeForm: '正在起稿' })
  })
  it('applies task_update retrying attempt', () => {
    let s = applyTaskEvent(emptyTaskProgress(), {
      type: 'task_list',
      data: { items: [{ id: 'a', title: '主图', nodeId: 'n1' }] },
    })
    s = applyTaskEvent(s, {
      type: 'task_update',
      data: { id: 'a', status: 'retrying', attempt: 1, maxAttempts: 2 },
    })
    expect(s.items[0].status).toBe('retrying')
    expect(s.items[0].attempt).toBe(1)
  })

  it('marks finished on task_summary', () => {
    let s = applyTaskEvent(emptyTaskProgress(), {
      type: 'task_list',
      data: { items: [{ id: 'a', title: '主图', nodeId: 'n1' }] },
    })
    s = applyTaskEvent(s, {
      type: 'task_summary',
      data: { success: 1, failed: 0, needsUser: 0, skipped: 0 },
    })
    expect(s.finished).toBe(true)
    expect(s.summary?.success).toBe(1)
  })

  it('W11: defers terminal SSE status when recordId is present', () => {
    let s = applyTaskEvent(emptyTaskProgress(), {
      type: 'task_list',
      data: { items: [{ id: 'a', title: '主图', nodeId: 'n1' }] },
    })
    s = applyTaskEvent(s, {
      type: 'task_update',
      data: { id: 'a', status: 'running', recordId: 'rec-1' },
    })
    s = applyTaskEvent(s, {
      type: 'task_update',
      data: { id: 'a', status: 'done', recordId: 'rec-1' },
    })
    expect(s.items[0].recordId).toBe('rec-1')
    expect(s.items[0].status).toBe('running')
  })

  it('W11: applyPollRecordToTask uses record status as authority', () => {
    let s = applyTaskEvent(emptyTaskProgress(), {
      type: 'task_list',
      data: { items: [{ id: 'a', title: '主图', nodeId: 'n1' }] },
    })
    s = applyTaskEvent(s, {
      type: 'task_update',
      data: { id: 'a', status: 'running', recordId: 'rec-1' },
    })
    s = applyPollRecordToTask(s, 'n1', 'completed')
    expect(s.items[0].status).toBe('done')
  })
})

describe('mapRecordStatusToTaskStatus', () => {
  it('maps studio statuses', () => {
    expect(mapRecordStatusToTaskStatus('completed')).toBe('done')
    expect(mapRecordStatusToTaskStatus('failed')).toBe('failed')
    expect(mapRecordStatusToTaskStatus('fallback_pending')).toBe('needs_user')
    expect(mapRecordStatusToTaskStatus('generating')).toBe('running')
  })
})

describe("seedTaskProgressFromEvents（P1#5 历史恢复）", () => {
  it("从持久化 task 事件播种进度并判定完成", () => {
    const p = seedTaskProgressFromEvents([
      { type: "task_list", data: { items: [{ id: "plan-1", title: "起稿" }] } },
      { type: "task_update", data: { id: "plan-1", status: "done" } },
    ]);
    expect(p?.items).toHaveLength(1);
    expect(p?.items[0]).toMatchObject({ id: "plan-1", status: "done" });
    expect(p?.finished).toBe(true);
  });

  it("无 task 事件返回 null", () => {
    expect(seedTaskProgressFromEvents([{ type: "text_delta", data: { text: "x" } }])).toBeNull();
  });
});
