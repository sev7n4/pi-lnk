import { Type } from 'typebox'
import type { LnkpiTool, LnkpiToolContext } from './types.js'
import type { NestClient } from './nest-client.js'

type Result = { content: Array<{ type: 'text'; text: string }>; details: undefined }

function result(payload: unknown): Result {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], details: undefined }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createVideoTimelineTools(client: NestClient): LnkpiTool[] {
  return [
    {
      tier: 'write_light',
      name: "video_timeline_create",
      label: '创建视频时间线',
      description:
        'Create a video timeline draft from existing canvas image/video/audio node ids. Does NOT render. Use when the user wants to assemble shots, mix images with video, or cut a short film.',
      summary: '把画布素材节点编成时间线草稿（不渲染）',
      parameters: Type.Object({
        title: Type.String({ description: 'Draft node title' }),
        source_node_ids: Type.Array(Type.String(), { description: 'Canvas node ids, in visual order' }),
      }),
      execute: async (
        _id,
        p: { title: string; source_node_ids: string[] },
        _u,
        tc: LnkpiToolContext,
      ): Promise<Result> => {
        try {
          const data = await client.post('/agent/internal/video-timeline/create', {
            sessionId: tc.sessionId,
            userId: tc.userId,
            title: p.title,
            sourceNodeIds: p.source_node_ids,
          })
          return result({ ok: true, ...(data as object) })
        } catch (err) {
          return result({ ok: false, error: message(err) })
        }
      },
    },
    {
      tier: 'write_light',
      name: "video_timeline_edit",
      label: '编辑视频时间线',
      description:
        'Edit a timeline draft: add/trim/reorder/remove clips, set audio start/volume, export settings, or request_render. Saving never starts rendering.',
      summary: '编辑时间线片段与导出设置',
      parameters: Type.Object({
        node_id: Type.String(),
        ops: Type.Array(
          Type.Object(
            {
              op: Type.String(),
              node_id: Type.Optional(Type.String()),
              at: Type.Optional(Type.Number()),
            },
            { additionalProperties: true },
          ),
        ),
        save: Type.Optional(Type.Boolean()),
      }),
      execute: async (
        _id,
        p: { node_id: string; ops: unknown[]; save?: boolean },
        _u,
        tc: LnkpiToolContext,
      ): Promise<Result> => {
        try {
          const data = await client.post('/agent/internal/video-timeline/edit', {
            sessionId: tc.sessionId,
            userId: tc.userId,
            nodeId: p.node_id,
            ops: p.ops,
            save: p.save,
          })
          return result({ ok: true, ...(data as object) })
        } catch (err) {
          return result({ ok: false, error: message(err) })
        }
      },
    },
    {
      tier: 'gen',
      name: "video_timeline_render",
      label: '渲染视频时间线',
      description:
        'Render a confirmed timeline draft into a final video node. Requires the draft to be in user-confirmed pending_confirm state; never call without user approval.',
      summary: '按已确认时间线渲染成片',
      parameters: Type.Object({ node_id: Type.String() }),
      execute: async (
        _id,
        p: { node_id: string },
        _u,
        tc: LnkpiToolContext,
      ): Promise<Result> => {
        try {
          const data = await client.post('/agent/internal/video-timeline/render', {
            sessionId: tc.sessionId,
            userId: tc.userId,
            nodeId: p.node_id,
          })
          return result({ ok: true, ...(data as object) })
        } catch (err) {
          return result({ ok: false, error: message(err) })
        }
      },
    },
  ]
}
