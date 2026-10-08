<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import type { GenerationType } from '@lnkpi/shared'
import { type StudioModality } from '@/constants/studioModels'

const props = defineProps<{
  modelValue: string
  type: GenerationType
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

/**
 * 🔴 这是一个**薄适配层**，只负责把 `type` 映射到 catalog modality。
 *
 * 候选来源、渠道名、「已停用」态、空态提示全部复用 `UniversalModelSelector`
 * （它走 `/provider/bootstrap` ⇒ `provider.service.ts` 的 `defaultSelectableFor`
 * ⇒ `STUDIO_MODEL_CATALOG`）。
 *
 * ⛔ 2026-10-08 重写。此前本组件直接渲染 `packages/shared/src/index.ts` 里
 * 手写的 `TEXT_MODELS` / `IMAGE_MODELS` / `VIDEO_MODELS`——那份清单与
 * `STUDIO_MODEL_CATALOG` **零重叠**（gpt-4o / dall-e-3 / sora / kling-v1… 全不在
 * 目录里）⇒ 用户在「工作室」页选中 `sora`，后端 `resolveModelKey` 查不到，
 * 静默回落默认模型（`fallback:true` 只写进 metadata）⇒ **选了 A 生成 B，
 * 且照扣费、页面不报错**。那三个常量已删除。
 *
 * 保留本组件（而不是让三个 studio 页面直接用 UniversalModelSelector）是为了
 * 不改动页面模板结构；行为已完全对齐。
 */
const UniversalModelSelector = defineAsyncComponent(
  () => import('@/components/canvas/UniversalModelSelector.vue'),
)

const modality = computed((): StudioModality => props.type)
</script>

<template>
  <UniversalModelSelector
    :model-value="modelValue"
    :type="type"
    :modality="modality"
    @update:model-value="emit('update:modelValue', $event)"
  />
</template>