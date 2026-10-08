import { onMounted, ref } from 'vue'
import { listModels, type AIModel, type GenerationType, type StudioModality } from '@lnkpi/shared'
import { capabilitiesApi } from '@/services/capabilities-api'

/**
 * 能力维度。**比 `GenerationType` 多 `audio`** —— shared 的 `GenerationType`
 * 只有 text|image|video（见 `UniversalModelSelector.vue` 的既有注释），
 * 但catalog 的 `StudioModality` 含 audio，音频面板也真实在用模型选择。
 */
export type CapabilityModality = GenerationType | 'audio'

/**
 * 全部 modality 的候选**一律从 `STUDIO_MODEL_CATALOG` 派生**。
 *
 * ⛔ 2026-10-08：此前 text/image/video 三维用的是 `packages/shared/src/index.ts`
 * 里手写的 `TEXT_MODELS`/`IMAGE_MODELS`/`VIDEO_MODELS`（gpt-4o / dall-e-3 / sora…），
 * 那份清单与 catalog **零重叠** ⇒ 接口失败时兜底给用户一份「后端根本不认」的选项。
 * 那三个常量已删除；现在四个维度同源。
 *
 * ⚠️ `AIModel.type` 是 `GenerationType`（不含 audio），audio 维度用 `'text'`
 * 占位并由调用方按维度过滤 —— 与 `UniversalModelSelector` 的既有处理一致。
 */
function modelsFromCatalog(modality: StudioModality): AIModel[] {
  return listModels(modality).map((m) => ({
    id: m.modelKey,
    name: m.displayName,
    provider: m.providerBinding,
    type: (modality === 'audio' ? 'text' : modality) as GenerationType,
  }))
}

const CATALOG_DEFAULTS: Record<CapabilityModality, AIModel[]> = {
  text: modelsFromCatalog('text'),
  image: modelsFromCatalog('image'),
  video: modelsFromCatalog('video'),
  audio: modelsFromCatalog('audio'),
}

const cache = ref<Record<CapabilityModality, AIModel[]>>({
  text: [...CATALOG_DEFAULTS.text],
  image: [...CATALOG_DEFAULTS.image],
  video: [...CATALOG_DEFAULTS.video],
  audio: [...CATALOG_DEFAULTS.audio],
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
        text: data.data.text?.length ? data.data.text : CATALOG_DEFAULTS.text,
        image: data.data.image?.length ? data.data.image : CATALOG_DEFAULTS.image,
        video: data.data.video?.length ? data.data.video : CATALOG_DEFAULTS.video,
        audio: data.data.audio?.length ? data.data.audio : CATALOG_DEFAULTS.audio,
      }
      stsDirectUpload.value = Boolean(data.data.stsDirectUpload)
      loaded = true
    } catch (err) {
      // 兜底已改为 catalog 派生（见上方 CATALOG_DEFAULTS），所以这里失败
      // **不会**让用户拿到一份后端不认的模型清单；但接口不可用仍值得留痕，
      // 否则「后端异常」与「真的没配模型」在页面上无法区分。
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
