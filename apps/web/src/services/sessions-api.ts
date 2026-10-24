import type { Session } from '@lnkpi/shared'
import { api } from './api'
import type { AxiosRequestConfig } from 'axios'

export const sessionsApi = {
  list: () => api.get<{ data: Session[] }>('/sessions'),
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
