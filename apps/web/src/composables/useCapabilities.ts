import { onMounted, ref } from 'vue'
import { listModels, TEXT_MODELS, IMAGE_MODELS, VIDEO_MODELS, type AIModel, type GenerationType } from '@lnkpi/shared'
import { capabilitiesApi } from '@/services/capabilities-api'

/**
 * 能力维度。**比 `GenerationType` 多 `audio`** —— shared 的 `GenerationType`
 * 只有 text|image|video（见 `UniversalModelSelector.vue` 的既有注释），
 * 但catalog 的 `StudioModality` 含 audio，音频面板也真实在用模型选择。
 */
export type CapabilityModality = GenerationType | 'audio'

/**
 * shared 未导出 AUDIO_MODELS 常量，audio 维度从 catalog 派生。
 * ⚠️ `AIModel` 的 `type` 是 `GenerationType`（不含 audio），
 * 故用 `'text'` 占位并由调用方按维度过滤 —— 与 `UniversalModelSelector`
 * 「audio when type is not in GenerationType」的既有处理一致。
 */
function audioModelsFromCatalog(): AIModel[] {
  return listModels('audio').map((m) => ({
    id: m.modelKey,
    name: m.displayName,
    provider: 'catalog',
    type: 'text' as GenerationType,
  }))
}

const AUDIO_MODELS = audioModelsFromCatalog()

const cache = ref<Record<CapabilityModality, AIModel[]>>({
  text: [...TEXT_MODELS],
  image: [...IMAGE_MODELS],
  video: [...VIDEO_MODELS],
  audio: AUDIO_MODELS,
})

const stsDirectUpload = ref(false)

let loaded = false

export function useCapabilities() {
  const loading = ref(false)

  async function load() {
    if (loaded) return
    loading.value = true
    try {
      const { data } = await capabilitiesApi.list()
      cache.value = {
        text: data.data.text?.length ? data.data.text : TEXT_MODELS,
        image: data.data.image?.length ? data.data.image : IMAGE_MODELS,
        video: data.data.video?.length ? data.data.video : VIDEO_MODELS,
        audio: data.data.audio?.length ? data.data.audio : AUDIO_MODELS,
      }
      stsDirectUpload.value = Boolean(data.data.stsDirectUpload)
      loaded = true
    } catch (err) {
      // 后端当前**没有** `/agent/capabilities/list` 这条路由（见审计 §2.5），
      // 静默 catch 会让「接口不存在」完全无声、无法与「真的没配置」区分。
      // 保留 catalog 兜底，但至少留一条 warn。
      console.warn('[capabilities] /agent/capabilities/list unavailable, using catalog defaults:', err)
    } finally {
      loading.value = false
    }
  }

  onMounted(() => {
    void load()
  })

  function modelsFor(type: CapabilityModality): AIModel[] {
    return cache.value[type]
  }

  return { loading, modelsFor, reload: load, stsDirectUpload }
}
