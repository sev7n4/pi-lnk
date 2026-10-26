import { api } from './api'
import type { AxiosRequestConfig } from 'axios'
import type { GenerationDiagnostic } from '@lnkpi/shared'

export const canvasApi = {
  /** config 仅在项目抽屉调用处带 15s 超时（弱网兜底，见 AgentSideRail.loadProjects） */
  list: (config?: AxiosRequestConfig) => api.get('/agent/canvas/list', config),
  /** config 可带客户端超时（新建通道收敛后由 CanvasesPage 传 20s，见 useProjectWorkspace.create） */
  create: (title?: string, config?: AxiosRequestConfig) =>
    api.post('/agent/canvas/create', { title }, config),
  update: (id: string, data: { title?: string; canvasData?: unknown }) =>
    api.put('/agent/canvas/update', { id, ...data }),
  /**
   * SP-D（ADR-0014）：手拉边落库走服务端统一校验通道（端点存在/禁自环/禁成环 fail-closed），
   * 与 agent connect_nodes 同一服务方法；硬非法 ⇒ 400，message 逐条点名 `source -> target (reason)`。
   */
  connectNodes: (sessionId: string, edges: Array<{ source: string; target: string }>) =>
    api.post('/agent/canvas/connect-nodes', { sessionId, edges }),
  optimizePrompt: (prompt: string, style?: string) =>
    api.post<{ data: { optimized: string } }>('/agent/chat/optimize-prompt', { prompt, style }),
  confirmMaterialPlatformFallback: (id: string) =>
    api.post(`/agent/canvas/material/${id}/confirm-platform-fallback`, {}, { timeout: 120_000 }),
  cancelMaterialPlatformFallback: (id: string) =>
    api.post(`/agent/canvas/material/${id}/cancel-platform-fallback`),
  cancelMaterial: (id: string) => api.post(`/agent/canvas/material/${id}/cancel`),
  getMaterialDiagnostic: (id: string) =>
    api
      .get<{ data: GenerationDiagnostic }>(`/agent/canvas/material/${id}/diagnostic`)
      .then((r) => r.data.data),
  /** Phase 2c.1: Nest Jwt clear pending_confirm → draft (browser path). */
  clearProposeGeneration: (sessionId: string, nodeId: string) =>
    api.post<{ data: { nodeId: string; status: 'draft' } }>('/agent/clear-propose', {
      sessionId,
      nodeId,
    }),
}
