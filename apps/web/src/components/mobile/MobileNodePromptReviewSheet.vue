<script setup lang="ts">
import { computed, ref } from 'vue'
import MobileReadingSurface from './MobileReadingSurface.vue'
import MobileAnnotationCapsule from './MobileAnnotationCapsule.vue'
import { composeAnnotatedImage } from './annotate/composeAnnotatedImage'
import { renderReviewBaseImage } from './annotate/renderReviewBaseImage'
import { useInkOverlay } from './annotate/useInkOverlay'

/**
 * 提示词全文审核层（规格 §4.7.1，2026-10-27 S1 批次 · 场景1 补齐）。
 *
 * **载体**：独立全屏**文本阅读面**——消费共享结构 `MobileReadingSurface`
 * （§4.8.1 三形态收敛），⛔ **不是** `MobileNodeViewer` 的一个 `type`
 * （D2 audio 死分支教训：契约位留死分支 = 未来按契约调用必得空白屏；
 * 且 type 分支会连带卷入标注门控）。数据源显式注入（`data.prompt` + 参数字段），
 * ⛔ 本组件不读 `data.content`。
 *
 * **入口**（同源，不造第二套）：磁贴提示词 chips（G1）+ 查看器提示词摘要条
 * —— pending 态不走本层（全文入口 = 磁贴 tap → 查看器审核内容层，§16-④ + M5
 * 批注/编辑/拒绝语义单一确认面，ADR-0011）。
 *
 * **内容**：提示词**全文**（可滚动）+ 生成参数**只读摘要一行**（缺省项不猜不占位）。
 *
 * **动作（§17 v2 收敛后的两键 + 朗读）**：
 * ①【批注】显式进入标注态——底图 = `renderReviewBaseImage`（提示词全文渲染页，
 *   ⭐ R-17 当前视口语义：滚动到哪圈哪，skipLines 按 scrollTop 折算；⛔ 不做全文长图拼接）；
 *   首笔落定弹胶囊，⚓ 合成**满屏截图**（image 芯片 + 意见）经 §5.3 锚管线回传；
 * ②【编辑】就地改字（§17-④：不弹 sheet）→ 保存 ⇒ 页面层覆盖磁贴提示词；
 * ③ 朗读（共享面内建，退出即停）。
 *
 * ⛔ **无「确认 / 拒绝」按钮、无参数控件**（单一确认面 ADR-0011 + P4 参数只读）——
 * V-11 组件层断言守此判据。
 */
const props = defineProps<{
  node: { id?: string; type: 'image' | 'video' | 'audio' | 'text'; data?: any }
}>()

const emit = defineEmits<{
  (e: 'close'): void
  /** 批注锚带回（满屏截图 + 意见）——页面层复用 §5.3 上传+芯片管线 */
  (e: 'annotate', payload: { imageBlob?: Blob; degraded: boolean; text?: string }): void
  /** 编辑保存（就地改字）⇒ 页面层覆盖磁贴提示词（§17-④ 拍板②：不触发生成） */
  (e: 'edit-save', prompt: string): void
}>()

const TYPE_LABELS: Record<string, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
}

const nodeData = computed(() => (props.node?.data ?? {}) as Record<string, unknown>)
const prompt = computed(() => String(nodeData.value.prompt ?? '').trim())

/** 标题 = 「提示词 · 名字」：名字取 label ?? title ?? 类型名（PC resolveNeoNodeTitle 兜底链同源） */
const title = computed(() => {
  const d = nodeData.value
  const name =
    (typeof d.label === 'string' && d.label.trim()) ||
    (typeof d.title === 'string' && d.title.trim()) ||
    TYPE_LABELS[props.node?.type] ||
    '节点'
  return `提示词 · ${name}`
})

/** 参数只读摘要：与磁贴 proposeParams / 查看器 reviewParams 同源（缺省项不猜不占位） */
const paramsLine = computed(() => {
  const d = nodeData.value
  const model = d.imageModel ?? d.videoModel ?? d.textModel ?? d.audioModel
  const parts: string[] = []
  if (typeof model === 'string' && model.trim()) parts.push(model.trim())
  if (typeof d.imageAspect === 'string' && d.imageAspect.trim()) parts.push(d.imageAspect.trim())
  if (typeof d.imageResolution === 'string' && d.imageResolution.trim())
    parts.push(d.imageResolution.trim())
  return parts.join(' · ')
})

/* ── 标注态（§4.3 一支笔 + §17-③ 首笔即弹胶囊；共享 useInkOverlay ────────
 *   ⭐ 2026-10-28 W-26/W-27 真机修复：此前本处与 viewer 各自实现画笔且同犯
 *   「bitmap 尺寸从未设置」bug（默认 300×150 被拉伸全屏 ⇒ 手指笔画大多落在
 *   bitmap 外不可见）——现收敛到共享组合式（DPR bitmap + Pointer Events +
 *   rAF 重绘 + 中点贝塞尔平滑），修一次两处生效。 */
const annotating = ref(false)
const inkCanvas = ref<HTMLCanvasElement | null>(null)
const capsuleVisible = ref(false)
const ink = useInkOverlay({
  canvas: inkCanvas,
  active: annotating,
  // 首笔落定即弹胶囊（§17-③）：落定时 marks 已含该笔
  onStrokeEnd: () => {
    capsuleVisible.value = true
  },
})

/* ── 编辑态（§17-④：就地改字，不弹 sheet）────────────────────────────── */
const editing = ref(false)
const editText = ref('')

/** 手势上锁：标注态画笔 / 编辑态输入不得触发关闭手势（评审 C1 同款） */
const gestureLocked = computed(() => annotating.value || editing.value)

const readingBodyRef = ref<HTMLElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)

function enterAnnotate() {
  editing.value = false
  annotating.value = true
  ink.reset()
  capsuleVisible.value = false
}

function exitAnnotate() {
  annotating.value = false
  ink.reset()
  capsuleVisible.value = false
}

function enterEdit() {
  annotating.value = false
  capsuleVisible.value = false
  editText.value = prompt.value
  editing.value = true
}

function cancelEdit() {
  editing.value = false
}

function saveEdit() {
  const text = editText.value.trim()
  if (!text || text === prompt.value) {
    editing.value = false
    return
  }
  editing.value = false
  emit('edit-save', text)
}

/**
 * 胶囊 ⚓ ⇒ 合成满屏截图 + 意见一并上抛（§5.3 锚管线零新字段）。
 * 底图 = 提示词全文渲染页（R-17：skipLines 按 scrollTop 折算——滚动到哪圈哪）；
 * 无标记 = 降级（只带文字，不静默失败）。
 */
async function onCapsuleAnchor(payload: { text: string }) {
  capsuleVisible.value = false
  const allMarks = ink.marks.value
  annotating.value = false
  const text = payload.text.trim()
  if (!allMarks.length) {
    emit('annotate', { degraded: true, text })
    return
  }
  try {
    const el = rootRef.value
    const body = readingBodyRef.value
    const w = Math.max(320, el?.clientWidth || 390)
    const h = Math.max(480, el?.clientHeight || 640)
    // R-17：底图反映当前视口——按滚动位折算跳过的行数（行高与渲染器 LINE_HEIGHT 同源 24px）
    const scrollTop = body?.scrollTop ?? 0
    const skipLines = Math.floor(scrollTop / 24)
    const c = renderReviewBaseImage({
      prompt: prompt.value,
      paramsLine: paramsLine.value ? `参数：${paramsLine.value}` : '',
      width: w,
      height: h,
      skipLines,
    })
    const composed = composeAnnotatedImage(c, w, h, allMarks)
    const blob = await new Promise<Blob | null>((resolve) => composed.toBlob(resolve, 'image/png'))
    if (!blob) {
      emit('annotate', { degraded: true, text })
      return
    }
    emit('annotate', { imageBlob: blob, degraded: false, text })
  } catch {
    emit('annotate', { degraded: true, text })
  }
}
</script>

<template>
  <div ref="rootRef" class="mobile-prompt-review" data-testid="mobile-prompt-review">
    <MobileReadingSurface
      :title="title"
      :speech-text="prompt"
      :gesture-locked="gestureLocked"
      @close="emit('close')"
    >
      <div class="mpr-content" data-testid="mobile-prompt-review-content">
        <textarea
          v-if="editing"
          v-model="editText"
          class="mpr-edit"
          data-testid="mobile-prompt-review-edit-input"
        />
        <p v-else class="mpr-prompt" data-testid="mobile-prompt-review-prompt">{{ prompt }}</p>
        <p v-if="paramsLine" class="mpr-params" data-testid="mobile-prompt-review-params">
          参数：{{ paramsLine }}
        </p>
      </div>

      <template #actions>
        <!-- 编辑态：取消/保存（§17-④ 底栏两键）；标注态：取消批注；常态：批注/编辑 -->
        <template v-if="editing">
          <button
            class="mpr-action"
            type="button"
            data-testid="mobile-prompt-review-edit-cancel"
            @click="cancelEdit"
          >
            取消
          </button>
          <button
            class="mpr-action is-primary"
            type="button"
            data-testid="mobile-prompt-review-edit-save"
            @click="saveEdit"
          >
            保存
          </button>
        </template>
        <template v-else-if="annotating">
          <button
            class="mpr-action"
            type="button"
            data-testid="mobile-prompt-review-annotate-cancel"
            @click="exitAnnotate"
          >
            取消批注
          </button>
        </template>
        <template v-else>
          <button
            class="mpr-action is-primary"
            type="button"
            data-testid="mobile-prompt-review-annotate"
            @click="annotating ? exitAnnotate() : enterAnnotate()"
          >
            批注
          </button>
          <button
            class="mpr-action"
            type="button"
            data-testid="mobile-prompt-review-edit"
            @click="enterEdit"
          >
            编辑
          </button>
        </template>
      </template>
    </MobileReadingSurface>

    <!-- 画笔覆盖层（标注态；Pointer Events + .stop 防关闭手势抢画笔——评审 C1 同款；
         bitmap 尺寸/DPR/多点过滤由 useInkOverlay 负责，CSS touch-action:none 保采集不被滚动手势打断） -->
    <canvas
      v-show="annotating"
      ref="inkCanvas"
      class="mpr-ink"
      data-testid="mobile-prompt-review-ink"
      @pointerdown.stop="ink.onPointerDown"
      @pointermove.stop="ink.onPointerMove"
      @pointerup.stop="ink.onPointerUp"
      @pointercancel.stop="ink.onPointerCancel"
    />

    <!-- §17-③ 胶囊意见框：首笔落定即弹（内联浮条，可继续补画） -->
    <MobileAnnotationCapsule
      :visible="capsuleVisible"
      @anchor="onCapsuleAnchor"
      @dismiss="capsuleVisible = false"
    />
  </div>
</template>

<style scoped>
.mobile-prompt-review {
  position: fixed;
  inset: 0;
  z-index: 91;
}

/* 画笔覆盖层：盖住阅读主体（底栏仍可点「取消批注」） */
.mpr-ink {
  position: absolute;
  inset: 0;
  z-index: 3;
  touch-action: none;
}

.mpr-content {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-3);
  padding-bottom: var(--lnk-space-6);
}

.mpr-prompt {
  margin: 0;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm);
  line-height: var(--lnk-lh-md);
  white-space: pre-wrap;
  word-break: break-word;
}

.mpr-edit {
  width: 100%;
  min-height: 240px;
  padding: var(--lnk-space-2);
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-base);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm);
  line-height: var(--lnk-lh-md);
  box-sizing: border-box;
  resize: vertical;
}

/* 参数只读摘要行（P4：⛔ 无参数控件——只读一行，缺省项不猜不占位） */
.mpr-params {
  margin: 0;
  padding-top: var(--lnk-space-2);
  border-top: 0.5px solid var(--lnk-border-subtle);
  color: var(--lnk-text-muted);
  font-size: var(--lnk-text-2xs);
  line-height: var(--lnk-lh-2xs);
}

.mpr-action {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 var(--lnk-space-3);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-sm);
  cursor: pointer;
}

.mpr-action.is-primary {
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  box-shadow: 0 0 0 1px var(--lnk-border-strong);
}
</style>
