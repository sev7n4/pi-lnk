<script setup lang="ts">
/**
 * 参数微调 Sheet（2026-11-02 卡片 UX 优化 · R9 旋钮进 Sheet）：
 * 对话卡三动作中「调整」的目标面——把模型/比例/分辨率/风格/张数/提示词的
 * 完整参数视图收进 MobileSheet 底部上滑层，对话卡本身不膨胀。
 *
 * 职责边界（2026-11-02 PM 裁决两轮修订，取代 R-B preview-only）：
 * 对话提议卡 = **首次生成的参数调整面**——用户拍板四项全接：模型/比例/分辨率/
 * 提示词 + 张数全部真写回（确认前经 CANVAS_NODE_PATCH_KEY 页面级通路
 * patchNodeData + await 落库，成功才 emit confirmProposal；单执行入口不变量
 * 不变——写参数≠执行，confirmProposal 仍是唯一执行口）；写回失败不确认并
 * 显式报错，杜绝「预览与实际扣费不符」的诚实性陷阱。
 * 合法值来源（实证 2026-11-02，此前「比例无静态枚举」判断仅对视频侧成立）：
 * image 比例/分辨率 = ImageParamsSelector 静态枚举；模型 = studioModels catalog
 * 按模态派生（listModels(modality) + resolveGenerationModel 归一，与 DockPanel 同源）。
 * 模态感知（音视频半接裁决）：video/audio 提议卡 = 模型+提示词可编辑、
 * 其余参数只读真值（videoSettings/audioKind），写回字段随模态分流
 * （videoModel/audioModel），杜绝往 video 节点误写 imageModel 的字段错配。
 * 画布 = 预览 + 产物二次编辑/再生成主场；「在画布精修」逃生钮保留。
 *
 * 复用 MobileSheet（Teleport body + 拖拽把手 + 遮罩），不自造浮层基座。
 * 显隐由父级 `v-if`（`tuneSheetOpen`）控制——MobileSheet 无 open prop。
 * 令牌纪律：新增样式一律 --lnk-*（R7：无 --lnk-danger，用 --lnk-error 家族）。
 */
import { computed, inject, ref, watch } from 'vue'
import MobileSheet from '@/components/mobile/MobileSheet.vue'
import { resolveProposalNodeData, type ProposalCanvasNode } from '@/composables/useProposalNodeData'
import { CANVAS_NODE_PATCH_KEY } from '@/composables/canvasNodeActions'
import { estimateImageCredits, estimateVideoCredits } from '@/constants/credits'
import {
  listModels,
  resolveGenerationModel,
  catalogModelKeyFromValue,
  type StudioModality,
} from '@/constants/studioModels'
import type { ImageAspectRatio, ImageResolution } from '@/components/canvas/ImageParamsSelector.vue'
const props = defineProps<{
  open: boolean
  nodeId: string | null
  /** 画布节点（vue-flow 结构化形状）：与 AgentTurnTimeline 同源透传（R1/R2，不读 store）。 */
  canvasNodes?: ProposalCanvasNode[] | null
}>()

const emit = defineEmits<{
  'update:open': [v: boolean]
  confirmProposal: [nodeId: string]
  'refine-dock': [nodeId: string]
}>()

const data = computed(() =>
  props.nodeId ? resolveProposalNodeData(props.nodeId, props.canvasNodes) : null,
)

/** 张数本地编辑值：每次打开按节点当前 imageCount 复位。 */
const count = ref(1)
const confirming = ref(false)
const confirmError = ref('')

/* —— 模态感知（2026-11-02 音视频半接裁决）：propose_generation 覆盖图/视频/音频，
   三模态参数字段与合法值来源不同——
   · image：imageModel/imageAspect/imageResolution/imageCount（静态枚举，全可编辑）
   · video：videoModel + videoSettings{duration,aspectRatio,resolution}（capability
     驱动 → 本轮模型+提示词可编辑，settings 只读真值展示；全接记 C-later）
   · audio：audioModel + audioKind + voice（音色清单强耦合模型×kind → 本轮
     模型+提示词可编辑，kind/voice 只读；接 voice 记 C-later）
   字段错配修复：video 节点写 videoModel，不再误写 imageModel。 —— */

/** 提议节点模态：决定模型清单/字段名与可编辑范围。 */
const modality = computed<StudioModality>(() => {
  const t = data.value?.nodeType
  return t === 'video' || t === 'audio' || t === 'text' ? t : 'image'
})
const isImage = computed(() => modality.value === 'image')
const isVideo = computed(() => modality.value === 'video')

/** 模态→节点模型字段名（写回目标字段随模态分流）。 */
const modelFieldKey = computed(() =>
  modality.value === 'image' ? 'imageModel' : `${modality.value}Model`,
)

/** 合法值枚举（仅 image 编辑）：与 ImageParamsSelector（画布 dock 同源）逐字一致。 */
const ASPECT_OPTIONS: ImageAspectRatio[] = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9']
const RESOLUTION_OPTIONS: ImageResolution[] = ['1K', '2K', '4K']

/** 模型候选：catalog 按模态派生（与各 DockPanel 同源），value=归一 ref。 */
const modelOptions = computed(() => {
  const seen = new Set<string>()
  const out: { value: string; label: string }[] = []
  for (const m of listModels(modality.value)) {
    const value = resolveGenerationModel(modality.value, m.modelKey)
    if (seen.has(value)) continue
    seen.add(value)
    out.push({ value, label: m.displayName })
  }
  return out
})

const modelValue = ref('')
const aspect = ref<ImageAspectRatio>('1:1')
const resolution = ref<ImageResolution>('1K')
const prompt = ref('')

/** 节点当前模型归一 ref（比较基准与写回值同形，杜绝编码态≠比较态）。 */
const nodeModelRef = computed(() =>
  resolveGenerationModel(modality.value, data.value?.modelId || undefined),
)
/** 节点比例/分辨率基准同样归一（原值非法时与编辑态回落一致，不误报 dirty）。 */
const nodeAspect = computed(() =>
  (ASPECT_OPTIONS as string[]).includes(data.value?.aspectRatio ?? '')
    ? (data.value?.aspectRatio as ImageAspectRatio)
    : '1:1',
)
const nodeResolution = computed(() =>
  (RESOLUTION_OPTIONS as string[]).includes(data.value?.imageResolution ?? '')
    ? (data.value?.imageResolution as ImageResolution)
    : '1K',
)

watch(
  () => [props.open, props.nodeId] as const,
  ([open]) => {
    if (open) {
      const d = data.value
      count.value = d?.imageCount ?? 1
      modelValue.value = nodeModelRef.value
      aspect.value = (ASPECT_OPTIONS as string[]).includes(d?.aspectRatio ?? '')
        ? (d?.aspectRatio as ImageAspectRatio)
        : '1:1'
      resolution.value = (RESOLUTION_OPTIONS as string[]).includes(d?.imageResolution ?? '')
        ? (d?.imageResolution as ImageResolution)
        : '1K'
      prompt.value = d?.prompt ?? ''
      confirmError.value = ''
    }
  },
  { immediate: true },
)

/** 页面级 patch 通路（null=宿主未提供，如独立渲染/旧宿主——见 confirm 降级）。 */
const patchNode = inject(CANVAS_NODE_PATCH_KEY, null)

/** 清空提示词不视为修改（空 prompt 会让生成必然失败，写回无意义）。 */
const promptDirty = computed(
  () => data.value != null && prompt.value.trim() !== '' && prompt.value !== (data.value.prompt ?? ''),
)

/** 参数相对节点是否被修改（模型/提示词全模态；张数/比例/分辨率仅 image）。 */
const dirty = computed(
  () =>
    data.value != null &&
    (modelValue.value !== nodeModelRef.value ||
      promptDirty.value ||
      (isImage.value &&
        (count.value !== data.value.imageCount ||
          aspect.value !== nodeAspect.value ||
          resolution.value !== nodeResolution.value))),
)

/**
 * 确认 = 真写回（2026-11-02 PM 裁决，四字段全接）：
 * 1. 参数未改 → 直接 confirmProposal（既有快路径，行为不变）
 * 2. 参数已改 → 只对**有差异的字段**构建 patch，先经页面通路 patch + await 落库，
 *    成功才 confirmProposal；失败/通道缺失 → 不确认 + 显式报错（诚实性：预览=实际）。
 * 单执行入口不变量：confirmProposal 仍是唯一执行 emit，本函数只做参数写。
 */
async function onConfirm() {
  if (!props.nodeId || confirming.value) return
  if (!dirty.value) {
    emit('confirmProposal', props.nodeId)
    onClose()
    return
  }
  if (!patchNode) {
    confirmError.value = '画布通道未就绪，暂不能应用修改——请在画布中调整后重试'
    return
  }
  const d = data.value
  if (!d) return
  const patch: Record<string, unknown> = {}
  if (modelValue.value !== nodeModelRef.value) patch[modelFieldKey.value] = modelValue.value
  if (promptDirty.value) patch.prompt = prompt.value
  if (isImage.value) {
    if (count.value !== d.imageCount) patch.imageCount = count.value
    if (aspect.value !== nodeAspect.value) patch.imageAspect = aspect.value
    if (resolution.value !== nodeResolution.value) patch.imageResolution = resolution.value
  }
  confirming.value = true
  confirmError.value = ''
  let ok = false
  try {
    ok = (await patchNode(props.nodeId, patch)) !== false
  } catch {
    ok = false
  }
  confirming.value = false
  if (!ok) {
    confirmError.value = '参数保存失败，未确认生成——请重试或回画布调整'
    return
  }
  emit('confirmProposal', props.nodeId)
  onClose()
}

/**
 * 积分实时联动：image=张数×分辨率（model 不参与，C-later 服务端权威）；
 * video=时长档（≤10s=30 / <15s=50 / ≥15s=70，shared estimateVideoCredits）；
 * audio/text 本轮不展示本地估算（音频档与 music/kind 耦合，避免误导）。
 */
const credit = computed(() =>
  isVideo.value
    ? estimateVideoCredits(data.value?.videoDuration ?? 5)
    : estimateImageCredits(count.value, resolution.value),
)
const showCredit = computed(() => isImage.value || isVideo.value)

function onClose() {
  emit('update:open', false)
}
</script>

<template>
  <MobileSheet
    v-if="open"
    title="参数微调"
    :subtitle="data?.title"
    @close="onClose"
  >
    <div class="tune-body">
      <!-- 模型：catalog 派生下拉（value=归一 ref，与 ImageDockPanel 写回同形） -->
      <div class="field">
        <label class="flabel" for="tune-model">模型</label>
        <select id="tune-model" v-model="modelValue" class="sel" data-test="sel-model">
          <option v-if="!modelOptions.some((o) => o.value === modelValue)" :value="modelValue">
            {{ catalogModelKeyFromValue(modelValue) || '当前模型' }}
          </option>
          <option v-for="o in modelOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>

      <!-- 比例：image=可编辑（静态枚举）；video=只读真值（capability 驱动，C-later 接编辑） -->
      <div v-if="isImage || isVideo" class="field">
        <template v-if="isImage">
          <label class="flabel" for="tune-aspect">比例</label>
          <select id="tune-aspect" v-model="aspect" class="sel" data-test="sel-aspect">
            <option v-for="a in ASPECT_OPTIONS" :key="a" :value="a">{{ a }}</option>
          </select>
        </template>
        <template v-else>
          <span class="flabel">比例</span>
          <span class="fval" data-test="ro-video-aspect">{{ data?.videoAspectRatio || '—' }}</span>
        </template>
      </div>

      <!-- 分辨率：image=分段编辑；video=只读真值 -->
      <div v-if="isImage || isVideo" class="field">
        <template v-if="isImage">
          <span class="flabel">分辨率</span>
          <div class="seg" role="group" aria-label="分辨率">
            <button
              v-for="r in RESOLUTION_OPTIONS"
              :key="r"
              type="button"
              :data-test="`res-${r}`"
              :class="{ on: resolution === r }"
              @click="resolution = r"
            >{{ r }}</button>
          </div>
        </template>
        <template v-else>
          <span class="flabel">分辨率</span>
          <span class="fval" data-test="ro-video-resolution">{{ data?.videoResolution || '—' }}</span>
        </template>
      </div>

      <!-- 视频：时长只读真值（duration 档位与模型能力耦合，C-later 接编辑） -->
      <div v-if="isVideo" class="field">
        <span class="flabel">时长</span>
        <span class="fval" data-test="ro-video-duration">{{ data?.videoDuration ? `${data.videoDuration}s` : '—' }}</span>
      </div>

      <!-- 音频：分类只读（voice/kind 编辑强耦合画布 dock，C-later） -->
      <div v-if="modality === 'audio'" class="field">
        <span class="flabel">类型</span>
        <span class="fval" data-test="ro-audio-kind">{{ data?.audioKind || '—' }}</span>
      </div>

      <div v-if="isImage" class="field">
        <span class="flabel">风格</span>
        <span class="fval" data-test="field-style">{{ data?.style || '—' }}</span>
      </div>

      <!-- 张数：仅 image（视频/音频无张数概念） -->
      <div v-if="isImage" class="field">
        <span class="flabel">张数</span>
        <div class="seg" role="group" aria-label="张数">
          <button
            type="button"
            data-test="count-1"
            :class="{ on: count === 1 }"
            @click="count = 1"
          >1</button>
          <button
            type="button"
            data-test="count-2"
            :class="{ on: count === 2 }"
            @click="count = 2"
          >2</button>
          <button
            type="button"
            data-test="count-4"
            :class="{ on: count === 4 }"
            @click="count = 4"
          >4</button>
        </div>
        <span v-if="count > 1" class="count-chip" data-test="count-chip">{{ count }} 张</span>
      </div>

      <!-- 积分实时联动（image=张数×分辨率；video=时长档；model 维度 C-later） -->
      <p v-if="showCredit" class="credit-live" data-test="credit-live">
        本次预计消耗 <b>{{ credit }}</b> 积分<span class="hint">（暂不含模型维度）</span>
      </p>

      <!-- 提示词：可编辑文本域（清空视为未修改，不写回空 prompt） -->
      <div class="prompt-field">
        <label class="flabel" for="tune-prompt">提示词</label>
        <textarea
          id="tune-prompt"
          v-model="prompt"
          class="prompt-input"
          rows="3"
          data-test="prompt-input"
          placeholder="描述想生成的画面…"
        />
      </div>

      <p class="notice">{{ isImage ? '全部修改将随确认生效；风格与产物二次编辑请回画布精修。' : '模型与提示词修改将随确认生效；时长 / 比例 / 音色等请回画布精修。' }}</p>
      <p v-if="confirmError" class="confirm-error" data-test="confirm-error">{{ confirmError }}</p>

      <div class="sheet-foot">
        <button
          type="button"
          class="btn-ghost"
          data-test="refine-dock"
          @click="emit('refine-dock', props.nodeId ?? '')"
        >在画布精修</button>
        <button
          type="button"
          class="btn-primary"
          data-test="confirm"
          :disabled="!props.nodeId || confirming"
          @click="onConfirm"
        >{{ confirming ? '保存中…' : dirty ? '保存修改并确认' : '确认生成' }}</button>
      </div>
    </div>
  </MobileSheet>
</template>

<style scoped>
.tune-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px 12px;
}
.field {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: var(--lnk-control-md);
}
.flabel {
  flex: none;
  width: 52px;
  font-size: var(--lnk-text-xs);
  color: var(--lnk-text-muted);
}
.fval {
  min-width: 0;
  flex: 1;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 张数分段 */
.seg {
  display: inline-flex;
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-full);
  overflow: hidden;
}
.seg button {
  min-width: 52px;
  height: var(--lnk-touch-target);
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-secondary);
  background: var(--lnk-surface-raised);
  border: none;
  cursor: pointer;
}
.seg button + button { border-left: 1px solid var(--lnk-border-default); }
.seg button.on {
  background: var(--lnk-accent-subtle);
  color: var(--lnk-accent-text);
  font-weight: var(--lnk-weight-semibold);
}
.count-chip {
  font-size: var(--lnk-text-xs);
  color: var(--lnk-text-secondary);
  background: var(--lnk-surface-sunken);
  border: 1px solid var(--lnk-border-default);
  padding: 2px 8px;
  border-radius: var(--lnk-radius-full);
}

/* 积分实时联动（极简定稿同步：与时间线积分 pill 同为中性，不额外上色） */
.credit-live {
  margin: 2px 0 0;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-secondary);
  font-weight: var(--lnk-weight-semibold);
}
.credit-live .hint {
  font-weight: 400;
  font-size: var(--lnk-text-xs);
  color: var(--lnk-text-muted);
}

/* 下拉（模型/比例）：与 seg 同族的中性控件 */
.sel {
  min-width: 0;
  flex: 1;
  height: var(--lnk-touch-target);
  padding: 0 10px;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-primary);
  background: var(--lnk-surface-raised);
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-md);
  cursor: pointer;
}
.sel:focus-visible {
  outline: 2px solid var(--lnk-border-focus);
  outline-offset: 2px;
}

/* 提示词文本域 */
.prompt-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.prompt-input {
  width: 100%;
  padding: 8px 10px;
  font-size: var(--lnk-text-xs);
  font-family: inherit;
  line-height: var(--lnk-lh-sm);
  color: var(--lnk-text-primary);
  background: var(--lnk-surface-raised);
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-md);
  resize: vertical;
  min-height: 64px;
}
.prompt-input:focus-visible {
  outline: 2px solid var(--lnk-border-focus);
  outline-offset: 2px;
}

.notice {
  margin: 0;
  font-size: var(--lnk-text-xs);
  color: var(--lnk-text-muted);
}
.confirm-error {
  margin: 0;
  font-size: var(--lnk-text-xs);
  color: var(--lnk-error);
}

.sheet-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}
/* 触控纪律：钮高 --lnk-touch-target(44px)；focus-visible 环与 AskUserCard 同款 */
.btn-ghost {
  display: inline-flex;
  align-items: center;
  height: var(--lnk-touch-target);
  padding: 0 14px;
  border-radius: var(--lnk-radius-md);
  font-size: var(--lnk-text-sm);
  cursor: pointer;
  border: 1px solid var(--lnk-border-default);
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-secondary);
}
.btn-ghost:hover { border-color: var(--lnk-accent-border); color: var(--lnk-accent-text); }
.btn-primary {
  display: inline-flex;
  align-items: center;
  height: var(--lnk-touch-target);
  padding: 0 16px;
  border-radius: var(--lnk-radius-md);
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-semibold);
  cursor: pointer;
  border: 1px solid transparent;
  background: var(--lnk-accent);
  color: var(--lnk-text-on-accent);
  box-shadow: var(--lnk-accent-glow);
}
.btn-primary:hover { background: var(--lnk-accent-hover); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost:focus-visible,
.btn-primary:focus-visible,
.seg button:focus-visible {
  outline: 2px solid var(--lnk-border-focus);
  outline-offset: 2px;
}
</style>
