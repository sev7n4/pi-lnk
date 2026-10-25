<script setup lang="ts">
import { BRAND_SHORT_NAME } from '@/constants/brand'
import { useBrandMark } from '@/composables/useBrandMark'

// 2026-10-26 用户裁定：品牌标志位改用**双色徽标**（盘 + 锚）。
// 取址由 useBrandMark() 统一按主题反相（浅底黑盘白锚 / 深底白盘黑锚）——
// 徽标是定色资产，单版在另一套主题下会沉进背景，只能出两版。
const { brandMarkUrl } = useBrandMark()

withDefaults(
  defineProps<{
    size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
    showName?: boolean
    name?: string
  }>(),
  {
    size: 'md',
    showName: false,
    // 2026-10-23 用户裁定：品牌展示位（导航左上角）只露「lnk π」，全名留给法务文书
    name: BRAND_SHORT_NAME,
  },
)

const sizeClass: Record<string, string> = {
  xs: 'h-7 w-7',
  sm: 'h-9 w-9',
  md: 'h-11 w-11',
  lg: 'h-16 w-16',
  xl: 'h-24 w-24',
}
</script>

<template>
  <div class="brand-logo inline-flex items-center gap-2">
    <img
      :src="brandMarkUrl"
      :alt="name"
      class="brand-logo__img object-contain"
      :class="sizeClass[size]"
      draggable="false"
    >
    <span v-if="showName" class="font-display text-lg font-semibold tracking-tight text-fg">{{ name }}</span>
  </div>
</template>

<style scoped>
/* 2026-10-26：紫色投影随徽标一起撤掉 —— 它是给旧紫色 3D 吉祥物配的「墨紫色柔光」，
   压在墨黑单色徽标上会在盘缘挂一圈紫边（显脏）。徽标自带盘+锚双层对比，不需要外发光。 */
.brand-logo__img {
  background: transparent;
}
</style>
