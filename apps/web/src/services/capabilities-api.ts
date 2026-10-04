import { api } from './api'
import type { AIModel } from '@lnkpi/shared'

export interface CapabilitiesData {
  text: AIModel[]
  image: AIModel[]
  video: AIModel[]
  /** 2026-10-04 新增：此前 CapabilitiesData 无 audio 字段，音频维度整个缺失。 */
  audio?: AIModel[]
  /** COS 预签名直传是否可用 */
  stsDirectUpload?: boolean
}

export const capabilitiesApi = {
  list: () => api.get<{ data: CapabilitiesData }>('/agent/capabilities/list'),
}
