import type { Session } from '@lnkpi/shared'
import { api } from './api'
import type { AxiosRequestConfig } from 'axios'

export const sessionsApi = {
  // 2026-10-26 规格收敛 v2（D1/R2）：`list` 已删——列表唯一真源 =
  // `useProjectWorkspace.list`（INV-10，canvasApi /agent/canvas/list）。
  // 以下管理通道全部保留：create 由 useProjectWorkspace 独占转发；
  // remove 依赖（useProjectWorkspace.remove）；update/removeMany/duplicate
  // 为 useProjectManager 管理动作的底层端点（sessions 侧独有）。
  // 可选 config 允许调用方为「用户主动创建」这类动作设短超时（弱网/连接池卡死时快速失败）
  create: (data: { title?: string }, config?: AxiosRequestConfig) =>
    api.post<{ data: Session }>('/sessions', data, config),
  update: (id: string, data: { title?: string; canvasData?: unknown }) =>
    api.put<{ data: Session }>(`/sessions/${id}`, data),
  remove: (id: string) => api.delete(`/sessions/${id}`),
  removeMany: (ids: string[]) =>
    api.post<{ data: { deleted: number } }>('/sessions/batch-delete', { ids }),
  duplicate: (id: string) => api.post<{ data: Session }>(`/sessions/${id}/duplicate`),
}
