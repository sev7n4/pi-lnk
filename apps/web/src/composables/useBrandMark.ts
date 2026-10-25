import { computed } from 'vue'
import { BRAND_MARK_ON_DARK_URL, BRAND_MARK_ON_LIGHT_URL } from '@/constants/brand'
import { useCanvasTheme } from '@/composables/useCanvasTheme'

/**
 * 品牌标志位（导航头 / 法务页头）的**双色徽标**取址——单一真相源。
 *
 * 为什么抽出来：三个消费位（BrandLogo / TermsPage / PrivacyPage）都要按主题反相取
 * 徽标，各写一遍 `theme === 'light' ? A : B` 迟早有一处写反（写反的表现是「深色下
 * 徽标消失」，且只在只读了另一个文件的人眼里才暴露）。
 *
 * 主题源：`useCanvasTheme()` 的 `theme` 以 `<html data-theme>` 为准（模块内注释已
 * 说明：主题是应用级关注点，不由页面模块持有）。
 */
export function useBrandMark() {
  const { theme } = useCanvasTheme()
  const brandMarkUrl = computed(() =>
    theme.value === 'light' ? BRAND_MARK_ON_LIGHT_URL : BRAND_MARK_ON_DARK_URL,
  )
  return { brandMarkUrl }
}
