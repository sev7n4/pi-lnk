<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AudioKind, GenerationType } from '@lnkpi/shared'
import { contextWindowLabel } from '@lnkpi/shared'
import { type StudioModality } from '@/constants/studioModels'
import { useClickOutside } from '@/composables/useClickOutside'
import { useModelSelectorOptions } from '@/composables/useModelSelectorOptions'
import { useModelConfigView } from '@/composables/useModelConfigView'
import ModelConfigPanel from '@/components/agent/ModelConfigPanel.vue'
import ModelOptionRow from '@/components/agent/ModelOptionRow.vue'
import type { ThinkingLevel } from '@/components/agent/composer/thinkingLevels'
import DockTypeIcon from '@/components/canvas/dock-studio/shared/DockTypeIcon.vue'

/** 兼容既有 import：`SelectorModelOption` 从 composable 重导出。 */
export type { SelectorModelOption } from '@/composables/useModelSelectorOptions'

const props = withDefaults(
  defineProps<{
    modelValue: string
    type: GenerationType
    /** Override catalog modality (e.g. audio when type is not in GenerationType) */
    modality?: StudioModality
    /** ghost：无边框，hover 才高亮（Agent / 单层 dock） */
    ghost?: boolean
    /**
     * 只对 audio 生效：按二阶分类过滤候选模型。缺省不过滤 ⇒ 存量调用零变化。
     *
     * 🔴 这不是锦上添花而是防错：服务端 `assertAudioKindMatchesModel` 对
     * 「声明 music 却拿着 TTS 模型」显式 400，所以选了分类后下拉不能列出别的分类。
     */
    audioKind?: AudioKind
    /**
     * 2026-11-20：开启模型配置入口（列表页标题头 + 齿轮 + 同 popover 内二级页）。
     * 缺省 false ⇒ studio 等宿主零变化；思考强度仅在 Agent composer 宿主传入。
     */
    configEnabled?: boolean
    thinkingSupported?: boolean
    thinkingLevel?: ThinkingLevel | null
    readOnly?: boolean
    /** 缺省按 shared 的 contextWindowLabel 规则派生（单一真相源）。 */
    contextLabel?: string
  }>(),
  {
    ghost: false,
    configEnabled: false,
    thinkingSupported: false,
    thinkingLevel: null,
    readOnly: false,
    contextLabel: undefined,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'set-thinking': [level: ThinkingLevel]
}>()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
useClickOutside(rootRef, () => {
  open.value = false
  // 关弹层即复位：下次打开从列表起（与移动 Sheet onModelSheetClose 同语义）
  resetModelView()
})

/* 模型选项投影抽至 composable（2026-11-20）：PC 锚定卡与移动底部 Sheet 共用同一数据源。
 * 依赖仍走 useProviderBootstrap / useModelHealth，既有 mock 契约不变。 */
const {
  selectableOptions,
  current,
  currentLabel,
  currentFullLabel,
  typeIcon,
  typeTitle,
  labelForValue,
  unavailableTitle,
} = useModelSelectorOptions({
  modelValue: () => props.modelValue,
  type: () => props.type,
  modality: () => props.modality,
  audioKind: () => props.audioKind,
})

/* 配置视图状态机与移动端同源（useModelConfigView）：list → config → thinking/context。 */
const {
  view: modelView,
  title: viewTitle,
  showBack: viewShowBack,
  back: viewModelBack,
  openConfig: openModelConfig,
  reset: resetModelView,
} = useModelConfigView()

const panelContextLabel = computed(() => props.contextLabel ?? contextWindowLabel(props.modelValue))

function select(id: string) {
  // S1-3：unavailable 条目不可点（灰显防呆——点了也会在生成链路撞不可用）
  if (selectableOptions.value.find((m) => m.id === id)?.unavailable) return
  emit('update:modelValue', id)
  open.value = false
  resetModelView()
}

/** WorkBuddy 语义：档位选中即写回（宿主），面板返回配置页。 */
function onSetThinking(level: ThinkingLevel) {
  emit('set-thinking', level)
  openModelConfig()
}
</script>

<template>
  <div ref="rootRef" class="relative">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs"
      :class="[ghost ? 'dock-ghost-ctl' : 'neo-ctl', open ? 'is-open' : '']"
      :title="currentFullLabel ? `${typeTitle} · ${currentFullLabel}` : typeTitle"
      @click="open = !open"
    >
      <DockTypeIcon :icon="typeIcon" :size="13" class="opacity-60" />
      <span class="max-w-[140px] truncate font-medium" :class="current?.disabled ? 'text-warning' : ''">
        {{ currentLabel }}
      </span>
      <svg class="h-3 w-3 shrink-0 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    <div
      v-if="open"
      class="neo-popover absolute bottom-full left-0 z-50 mb-1 min-w-[220px] rounded-xl py-1"
      @click.stop
    >
      <!-- 配置入口开启时：popover 顶部标题头（返回 / 标题 / 齿轮），iOS push/pop 同规范 -->
      <div v-if="configEnabled" class="ums-header">
        <button
          v-if="viewShowBack"
          type="button"
          class="ums-back"
          data-testid="pc-model-back"
          aria-label="返回"
          @click="viewModelBack()"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <span class="ums-title">{{ viewTitle }}</span>
        <button
          v-if="modelView === 'list'"
          type="button"
          class="ums-gear"
          data-testid="pc-model-config-open"
          aria-label="模型配置"
          @click="openModelConfig()"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      <!-- 非列表视图：共用 ModelConfigPanel（与移动 Sheet 单源） -->
      <ModelConfigPanel
        v-if="modelView !== 'list'"
        :view="modelView"
        :thinking-supported="thinkingSupported"
        :thinking-level="thinkingLevel"
        :read-only="readOnly"
        :context-label="panelContextLabel"
        @update:view="modelView = $event"
        @set-thinking="onSetThinking"
      />

      <template v-else>
        <button
          v-if="current?.disabled"
          type="button"
          class="flex w-full items-center justify-between px-3 py-2 text-xs text-warning"
          disabled
        >
          <span class="truncate">{{ labelForValue(current.id) }}</span>
          <span class="ml-2 shrink-0 text-warning">已停用</span>
        </button>
        <!-- 2026-11-21 模型卡 R2：列表行共用 ModelOptionRow（与移动 Sheet 单源，
             名称+可识图+渠道+倍率 WorkBuddy 排布）。class 经 attrs 透传到根按钮，
             保留 .neo-popover-item 全局 hover 形态与既有测试选择器。 -->
        <ModelOptionRow
          v-for="model in selectableOptions"
          :key="model.id"
          class="neo-popover-item"
          :option="model"
          :selected="model.id === modelValue && !model.unavailable"
          :title="model.unavailable ? unavailableTitle() : undefined"
          @select="select(model.id)"
        />
        <p v-if="!selectableOptions.length" class="px-3 py-2 text-[11px] text-[var(--neo-text-muted)]">
          暂无可选模型，请先在配置中设置
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* popover 标题头：返回 / 标题 / 齿轮（仅 configEnabled 时渲染）。
   齿轮显式 28×28 尺寸，防「DOM 存在但渲染 0×0」回归（移动端齿轮同教训）。 */
.ums-header {
  display: flex;
  align-items: center;
  gap: var(--lnk-space-1);
  padding: var(--lnk-space-2) var(--lnk-space-3);
  border-bottom: 1px solid var(--lnk-border-subtle);
}

.ums-back {
  display: flex;
  width: 28px;
  height: 28px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-text-secondary);
  cursor: pointer;
}

.ums-back svg {
  width: 16px;
  height: 16px;
}

.ums-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ums-gear {
  display: flex;
  width: 28px;
  height: 28px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-text-muted);
  cursor: pointer;
  transition: background var(--lnk-duration-fast) ease;
}

.ums-gear:hover {
  background: var(--lnk-pressed-overlay);
  color: var(--lnk-text-secondary);
}

.ums-gear svg {
  width: 16px;
  height: 16px;
}
</style>
