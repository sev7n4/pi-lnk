import { ref, watch, onBeforeUnmount, type Ref } from 'vue'
import QRCode from 'qrcode'

/**
 * 文本 → 二维码 dataURL（用于支付宝扫码支付）。
 * qrcode 包按需生成，无网络依赖；内容变化自动重渲染。
 */
export function useQrDataUrl(text: Ref<string | null>) {
  const dataUrl = ref<string | null>(null)
  let seq = 0

  async function render(value: string) {
    const id = ++seq
    try {
      const url = await QRCode.toDataURL(value, {
        width: 360,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      })
      if (id === seq) dataUrl.value = url
    } catch {
      if (id === seq) dataUrl.value = null
    }
  }

  watch(
    text,
    (v) => {
      if (v) void render(v)
      else dataUrl.value = null
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    seq += 0 // 内容仅在组件存活期内渲染，无需显式回收
  })

  return dataUrl
}
