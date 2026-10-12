<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useClickOutside } from '@/composables/useClickOutside'
import {
  clampVideoDuration,
  DEFAULT_VIDEO_SETTINGS,
  snapVideoSettingsToCapabilities,
  videoBaselineAspectOptionsForCapabilities,
  videoBaselineResolutionOptionsForCapabilities,
  VIDEO_CROP_OPTIONS,
  VIDEO_DURATION_MARKS,
  type VideoAspectRatio,
  type VideoModelCapabilities,
  type VideoSettings,
} from '@lnkpi/shared'
// S2-1b：resolveModelKey 改读服务端下发目录（归一层注入 rows），不再直读 shared 常量。
import { resolveModelKey } from '@/constants/studioModels'

const props = defineProps<{
  modelValue: VideoSettings
  capabilities?: VideoModelCapabilities
  modelKey?: string
  seed?: number
  negativePrompt?: string
}>()

const nativeParams = computed(() => {
  const hidden = { generateAudio: false, crop: false, seed: false, negativePrompt: false }
  if (!props.modelKey) return hidden
  const resolved = resolveModelKey('video', props.modelKey)
  if (resolved.fallback) return hidden
  return {
    generateAudio: resolved.entry.params.generateAudio === 'native',
    crop: resolved.entry.params.crop === 'native',
    seed: resolved.entry.params.seed === 'native',
    negativePrompt: resolved.entry.params.negativePrompt === 'native',
  }
})

const showGenerateAudio = computed(() => nativeParams.value.generateAudio)

const showSeed = computed(() => nativeParams.value.seed)

const showNegativePrompt = computed(() => nativeParams.value.negativePrompt)

const showCrop = computed(() => nativeParams.value.crop)

const durationBounds = computed(() => ({
  min: props.capabilities?.minDuration ?? 4,
  max: props.capabilities?.maxDuration ?? 15,
}))

/** 离散时长档位（如 cogvideox 仅 5/10s）；非空时以 pill 呈现，替代连续滑轨 */
const discreteDurations = computed(() => props.capabilities?.allowedDurations ?? null)

const durationMarks = computed(() =>
  VIDEO_DURATION_MARKS.filter((mark) => mark >= durationBounds.value.min && mark <= durationBounds.value.max),
)

const durationBelowMinHint = computed(() => {
  const min = props.capabilities?.minDuration
  if (min == null || props.modelValue.duration >= min) return null
  return `该模型最短 ${min} 秒`
})

/**
 * Seedance 基线全集常驻展示；模型不支持的能力置灰（disabled + title 提示），
 * 与选中值无关——切换模型时能力差异一眼可见。
 */
const aspectOptions = computed(() => videoBaselineAspectOptionsForCapabilities(props.capabilities))

const resolutionOptions = computed(() => videoBaselineResolutionOptionsForCapabilities(props.capabilities))

const disabledCapabilityTitle = '当前模型不支持，由模型自动处理'

function ensureAllowedSettings() {
  const { next, adjusted } = snapVideoSettingsToCapabilities(props.modelValue, props.capabilities ?? null)
  if (adjusted.length > 0) {
    patch(next)
  }
}

const emit = defineEmits<{
  'update:modelValue': [value: VideoSettings]
  'update:seed': [value: number | undefined]
  'update:negativePrompt': [value: string]
}>()

function onSeedInput(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed) {
    emit('update:seed', undefined)
    return
  }
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(n)) return
  emit('update:seed', n)
}

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
useClickOutside(rootRef, () => {
  open.value = false
})

function patch(partial: Partial<VideoSettings>) {
  const next = { ...DEFAULT_VIDEO_SETTINGS, ...props.modelValue, ...partial }
  if ('duration' in partial) {
    next.duration = clampVideoDuration(next.duration, durationBounds.value)
  }
  emit('update:modelValue', next)
}

watch(open, (isOpen) => {
  if (!isOpen) return
  ensureAllowedSettings()
})

watch(
  () => [props.capabilities, props.modelValue.aspectRatio, props.modelValue.resolution] as const,
  () => {
    ensureAllowedSettings()
  },
)

/** 比例小图标：按宽高比绘制示意矩形（与图片参数卡同款） */
function aspectRect(value: string) {
  if (value === 'adaptive') {
    return { x: 2, y: 5, width: 14, height: 8 }
  }
  const [w, h] = value.split(':').map(Number)
  const max = 14
  const scale = max / Math.max(w, h)
  const rw = Math.max(4, Math.round(w * scale))
  const rh = Math.max(4, Math.round(h * scale))
  return {
    x: (18 - rw) / 2,
    y: (18 - rh) / 2,
    width: rw,
    height: rh,
  }
}

function aspectLabel(value: VideoAspectRatio): string {
  return value === 'adaptive' ? '自适应' : value
}
</script>

<template>
  <div ref="rootRef" class="relative">
    <button
      type="button"
      class="neo-ctl flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs"
      title="视频参数"
      @click="open = !open"
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" class="opacity-60">
        <rect x="2" y="6" width="14" height="12" rx="2" />
        <path d="m16 10 6-3v10l-6-3z" />
      </svg>
      <span class="font-medium">
        {{ modelValue.aspectRatio }} · {{ modelValue.resolution }} · {{ modelValue.duration }}s
      </span>
      <svg class="h-3 w-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    <div
      v-if="open"
      class="absolute bottom-full right-0 z-50 mb-1 w-[264px] neo-popover rounded-xl p-3"
      @click.stop
    >
      <div class="mb-3">
        <p class="mb-1.5 text-[10px] text-[var(--neo-text-muted)]">宽高比</p>
        <div class="grid grid-cols-3 gap-1">
          <button
            v-for="opt in aspectOptions"
            :key="opt.value"
            type="button"
            class="neo-chip flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[10px]"
            :class="[
              modelValue.aspectRatio === opt.value ? 'is-on' : '',
              opt.disabled ? 'cursor-not-allowed opacity-40' : '',
            ]"
            :disabled="opt.disabled"
            :title="opt.disabled ? disabledCapabilityTitle : undefined"
            @click="!opt.disabled && patch({ aspectRatio: opt.value })"
          >
            <svg
              viewBox="0 0 18 18"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              :stroke-dasharray="opt.value === 'adaptive' ? '2 2' : undefined"
            >
              <rect v-bind="aspectRect(opt.value)" rx="1.5" />
            </svg>
            {{ aspectLabel(opt.value) }}
          </button>
        </div>
      </div>

      <div class="mb-3">
        <p class="mb-1.5 text-[10px] text-[var(--neo-text-muted)]">分辨率</p>
        <div class="flex gap-1">
          <button
            v-for="opt in resolutionOptions"
            :key="opt.value"
            type="button"
            class="neo-chip flex-1 rounded-md px-1 py-1 text-[10px]"
            :class="[
              modelValue.resolution === opt.value ? 'is-on' : '',
              opt.disabled ? 'cursor-not-allowed opacity-40' : '',
            ]"
            :disabled="opt.disabled"
            :title="opt.disabled ? disabledCapabilityTitle : undefined"
            @click="!opt.disabled && patch({ resolution: opt.value })"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div class="mb-3">
        <p class="mb-1.5 flex items-center justify-between text-[10px] text-[var(--neo-text-muted)]">
          <span>时长</span>
          <span class="tabular-nums text-[var(--neo-text-secondary)]">{{ modelValue.duration }}s</span>
        </p>
        <template v-if="discreteDurations && discreteDurations.length > 0">
          <div class="flex gap-1">
            <button
              v-for="tier in discreteDurations"
              :key="tier"
              type="button"
              class="neo-chip flex-1 rounded-md px-2 py-1 text-[10px]"
              :class="modelValue.duration === tier ? 'is-on' : ''"
              @click="patch({ duration: tier })"
            >
              {{ tier }}s
            </button>
          </div>
        </template>
        <template v-else>
          <input
            type="range"
            :min="durationBounds.min"
            :max="durationBounds.max"
            step="1"
            class="w-full accent-[var(--neo-text-primary)]"
            :value="modelValue.duration"
            @input="patch({ duration: clampVideoDuration(($event.target as HTMLInputElement).value, durationBounds) })"
          />
          <div class="mt-1 flex justify-between text-[10px]">
            <button
              v-for="mark in durationMarks"
              :key="mark"
              type="button"
              class="text-[var(--neo-text-muted)]"
              :class="mark === modelValue.duration ? 'font-semibold text-fg' : ''"
              @click="patch({ duration: mark })"
            >
              {{ mark }}
            </button>
          </div>
        </template>
        <p
          v-if="durationBelowMinHint"
          class="mt-1 text-[10px] text-warning"
        >
          {{ durationBelowMinHint }}
        </p>
      </div>

      <div v-if="showGenerateAudio" class="mb-3 flex items-center justify-between">
        <p class="text-[10px] text-[var(--neo-text-muted)]">生成音频</p>
        <button
          type="button"
          role="switch"
          :aria-checked="modelValue.generateAudio ?? true"
          class="relative h-[18px] w-8 rounded-full transition-colors"
          :class="(modelValue.generateAudio ?? true) ? 'bg-[var(--neo-text-primary)]' : 'bg-[var(--neo-border-strong)]'"
          :title="(modelValue.generateAudio ?? true) ? '生成音频：开' : '生成音频：关'"
          @click="patch({ generateAudio: !(modelValue.generateAudio ?? true) })"
        >
          <span
            class="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-[var(--neo-text-invert)] transition-all"
            :class="(modelValue.generateAudio ?? true) ? 'left-[16px]' : 'left-[2px]'"
          />
        </button>
      </div>

      <div v-if="showCrop" class="mb-3">
        <p class="mb-1.5 text-[10px] text-[var(--neo-text-muted)]">裁剪</p>
        <div class="flex flex-wrap gap-1">
          <button
            v-for="opt in VIDEO_CROP_OPTIONS"
            :key="opt.value"
            type="button"
            class="neo-chip rounded-md px-2 py-1 text-[10px]"
            :class="modelValue.crop === opt.value
              ? 'is-on'
              : ''"
            @click="patch({ crop: opt.value })"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div v-if="showSeed" class="mb-3">
        <p class="mb-1.5 text-[10px] text-[var(--neo-text-muted)]">Seed</p>
        <input
          type="number"
          class="w-full rounded-md border border-overlay/10 bg-black/25 px-2 py-1 text-[10px] text-fg"
          :value="seed ?? ''"
          placeholder="随机"
          step="1"
          @input="onSeedInput(($event.target as HTMLInputElement).value)"
        >
      </div>

      <div v-if="showNegativePrompt">
        <p class="mb-1.5 text-[10px] text-[var(--neo-text-muted)]">排除内容</p>
        <input
          type="text"
          class="w-full rounded-md border border-overlay/10 bg-black/25 px-2 py-1 text-[10px] text-fg"
          :value="negativePrompt ?? ''"
          placeholder="如 watermark, blur"
          @input="emit('update:negativePrompt', ($event.target as HTMLInputElement).value)"
        >
      </div>

      <button
        type="button"
        class="mt-3 w-full rounded-lg py-1 text-[10px] text-[var(--neo-text-muted)] hover:text-fg-2"
        @click="patch(DEFAULT_VIDEO_SETTINGS)"
      >
        重置默认
      </button>
    </div>
  </div>
</template>
