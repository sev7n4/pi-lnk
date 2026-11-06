<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import type { MentionOption } from '@/components/canvas/MentionInput.vue'
import type { NodeRef } from '@/composables/useNodeRefs'
import {
  appendOpinionPrefill,
  contextTitle,
  CONTEXT_SUBTITLE,
  humanizeParamLabel,
  paramChipToPrefill,
} from './mobileEditorSheetPolicy'

/**
 * 移动端**轻量编辑器** v2（2026-11-01 规格：iOS 全屏撰写模式重设计）。
 *
 * ⭐ **为什么不再挂 PC 的 `DockStudioRouter`**（v1 起的裁决，不变）：
 *   1. **参数所有权在 agent 侧** —— 提议阶段服务端已写死模型 / 比例 / 分辨率
 *      （`proposeGeneration`），用户再调 ⇒ 两套参数语义打架；
 *   2. PC dock ≈ 4800 行、参数选择器在窄屏**已实证弹不开**（走查⑥），
 *      此前是靠 35 行 `:deep()` 补丁硬修的 —— 换掉 dock 后补丁一并消失；
 *   3. 模式① 的心智是「我说，你做」⇒ 本组件只做「改词 + 提意见」，
 *      出口是「**发给 agent 修改**」（**不**有本地提交按钮）。
 *
 * ⭐ v2 变更（对照规格 图 1）：
 *   - 导航三段：左「取消」/ 中大标题「改词」/ 右上「发送」胶囊（aria 承载完整语义）；
 *     底部通栏大按钮退役（J-3 一个主出口）；
 *   - 无框输入（J-4 内容即界面）：去 border 盒子，role 小标签 + 光标；
 *   - 产物上下文行：四类节点唯一差异化点（图标 + 标题 + 副标题）；
 *   - 参数 chips 只读 + 「由 agent 锁定」标注；点 chip ⇒ 翻译成意见预填（J-1 翻译制，
 *     纯函数在 `mobileEditorSheetPolicy.ts`），不改值、不越权；
 *   - 全屏表单浮层保留自己的布局（`MobileSheet` 是 62vh 选择型，§4.11.8；
 *     V-3 白名单豁免理由不变），z-85 不动（J-5），入场滑入 + reduced-motion 降级。
 *
 * ⭐ v2.1（2026-11-01 真机走查回归修复）：
 *   1. **P0 层序**：Teleport 到 body（同 `MobileSheet` 惯例）。此前挂在
 *      `<main class="relative z-10">` 堆叠上下文内，z-85 对外等效 z-10，
 *      输给 teleport 到 body 的顶栏（z-40）⇒ 真机上「取消/改词」被顶栏盖住、
 *      发送胶囊裁半（用户无法退出）；
 *   2. **裸内部模型 ID 不上屏**：`platform::agnes-image-2.1-flash` → 「agnes 图像
 *      2.1 flash」（`humanizeParamLabel`），全量原值进 aria-label；
 *   3. **桌面拖拽斜纹不上移动端**：`resize: none` + auto-grow（备忘录式自增高），
 *      替代 min-height 96px 的硬撑留白；
 *   4. 「由 agent 锁定」加锁形图标内联；上下文行图标盒瘦身（34px 盒 → 24px 内联）。
 */
const props = withDefaults(
  defineProps<{
    node: EditableFlowNode
    refs?: NodeRef[]
    mentions?: MentionOption[]
    generating?: boolean
    /** 意见预填（v1.5 Q：音频改词经 viewer meta.mediaTime ⇒「at mm:ss」） */
    initialOpinion?: string
  }>(),
  {
    refs: () => [],
    mentions: () => [],
    generating: false,
    initialOpinion: '',
  },
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'patch', patch: Record<string, unknown>): void
  /**
   * 模式①：把「改后提示词 + 我的意见」交给 agent（**不是**本地提交）。
   * ⭐ 页面层负责：写回提示词 → 切回对话页签 → 把意见（空则兜底轻引用）放进
   *   composer 输入框（用户自己按下发送 = 保留意图表达权，§4.5「看得见落地」）。
   */
  (e: 'send-to-agent', payload: { prompt: string; opinion: string }): void
}>()

const nodeData = computed(() => (props.node.data ?? {}) as Record<string, unknown>)
// Task 7（spec 2026-11-05-canvas-digest §10 风险#1）：digest = 系统回合末总览节点，
// 任何编辑都会被下轮 finalizeTurn 翻新覆盖 ⇒ 打开即只读，不提供改词/发送出口。
const isDigestNode = computed(() => nodeData.value.digest === true)
const typeKey = computed(() => String(props.node.type ?? ''))

/** 提示词初值（agent 提议时写入 `data.prompt`） */
const prompt = ref(String(nodeData.value.prompt ?? ''))

/** 我的意见（要一起交给 agent 的自然语言；initialOpinion = 页面层预填，v1.5 Q） */
const opinion = ref(props.initialOpinion)

/** 产物上下文行（四类节点唯一差异化点：图标随 type，标题降级见策略文件） */
const ctxTitle = computed(() => contextTitle(nodeData.value, typeKey.value))

/** 参数 chips（只读值展示；点 chip 走翻译制预填，非选择器；裸 ID 不上屏 → humanize） */
const paramChips = computed(() => {
  const d = nodeData.value
  const out: Array<{ field: string; label: string; raw: string }> = []
  for (const field of ['imageModel', 'imageAspect', 'imageResolution', 'videoModel', 'textModel', 'audioModel']) {
    const v = d[field]
    if (typeof v === 'string' && v.trim() && paramChipToPrefill(field)) {
      out.push({ field, label: humanizeParamLabel(field, v), raw: v })
    }
  }
  return out
})

/** 引用 chips（只读展示；⛔ 不在此提供删除入口 —— 删除引用走画布层） */
const refChips = computed(() =>
  (props.refs ?? []).map((r) => ({ id: r.refId, label: r.label || r.refId })),
)

const canSubmit = computed(() => prompt.value.trim().length > 0 || opinion.value.trim().length > 0)

/** 点参数 chip ⇒ 翻译成意见前缀 + 聚焦意见框光标就位（幂等，见规格 图 3） */
const opinionEl = ref<HTMLTextAreaElement | null>(null)
async function onParamChipTap(field: string) {
  const prefix = paramChipToPrefill(field)
  if (!prefix) return
  const { next } = appendOpinionPrefill(opinion.value, prefix)
  opinion.value = next
  await nextTick()
  const el = opinionEl.value
  if (el) {
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }
}

/** auto-grow（备忘录式自增高）：输入与初值两条路径都要 fit */
const promptEl = ref<HTMLTextAreaElement | null>(null)
function fit(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
function autogrow(e: Event) {
  fit(e.target as HTMLTextAreaElement)
}
onMounted(() => {
  fit(promptEl.value)
  fit(opinionEl.value)
})

function submit() {
  const nextPrompt = prompt.value.trim()
  const nextOpinion = opinion.value.trim()
  if (!canSubmit.value) return
  // 提示词有改动才回写（避免无谓落库）；意见空与否由页面层兜底（J-2）
  if (nextPrompt && nextPrompt !== String(nodeData.value.prompt ?? '')) {
    emit('patch', { prompt: nextPrompt })
  }
  emit('send-to-agent', { prompt: nextPrompt, opinion: nextOpinion })
}
</script>

<template>
  <!-- P0 层序修复（v2.1）：必须 Teleport 到 body——画布壳层 `<main class="relative z-10">`
       会创建堆叠上下文困住 z-85（对外等效 z-10），输给 teleport 到 body 的顶栏 z-40。
       同 MobileSheet 头注释惯例：「fixed + Teleport body」。 -->
  <Teleport to="body">
    <div class="mobile-editor-sheet" role="dialog" aria-modal="true" aria-label="改词">
      <!-- 导航三段（图 1 ①）：取消 / 大标题 / 发送胶囊（iOS 全屏撰写惯例） -->
      <header class="mobile-editor-nav">
        <button
          class="nav-cancel"
          type="button"
          data-testid="mobile-editor-cancel"
          data-action="close"
          @click="emit('close')"
        >
          取消
        </button>
        <span class="nav-title">{{ isDigestNode ? '画布总览' : '改词' }}</span>
        <!-- 主出口（J-3/J-7）：UI 短文案「发送」，完整语义在 aria-label -->
        <button
          v-if="!isDigestNode"
          class="nav-send"
          type="button"
          :disabled="!canSubmit"
          aria-label="发给 agent 修改"
          data-testid="mobile-editor-send"
          data-action="send"
          @click="submit"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>发送</span>
        </button>
      </header>

      <div v-if="isDigestNode" class="mobile-editor-readonly" data-testid="mobile-editor-readonly">
        <p class="ro-title">画布总览</p>
        <p class="ro-desc">系统产物 · 随每轮对话自动更新，暂不支持在此编辑。如需调整画布内容，请直接对话。</p>
      </div>
      <div v-else class="mobile-editor-body">
        <!-- 产物上下文行（图 1 ②）：四类节点唯一差异化点 -->
        <div class="ctx-row" data-testid="mobile-editor-context">
          <span class="ctx-icon" aria-hidden="true">
            <svg v-if="typeKey === 'image'" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <circle cx="9" cy="10" r="1.6" />
              <path d="m3 17 5-4 4 3 4-4 5 5" />
            </svg>
            <svg v-else-if="typeKey === 'video'" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="6" width="13" height="12" rx="2.5" />
              <path d="m16 10 5-3v10l-5-3" />
            </svg>
            <svg v-else-if="typeKey === 'audio'" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 3h9l4 4v14H6z" />
              <path d="M9 12h7M9 16h7M9 8h3" />
            </svg>
          </span>
          <span class="ctx-meta">
            <span class="ctx-name">{{ ctxTitle }}</span>
            <span class="ctx-sub">{{ CONTEXT_SUBTITLE }}</span>
          </span>
        </div>

        <!-- 提示词：无框输入（图 1 ③，J-4 内容即界面）+ auto-grow -->
        <div class="input-block">
          <span class="input-role">提示词</span>
          <textarea
            ref="promptEl"
            v-model="prompt"
            class="mobile-editor-textarea"
            rows="2"
            placeholder="要改哪句？"
            data-testid="mobile-editor-prompt"
            @input="autogrow"
          />
        </div>

        <!-- 参数 chips：只读值 + 翻译制预填（图 1 ④ / 图 3；agent 锁定，J-1）。
             裸内部 ID 不上屏：显示 humanize 短标签，全量原值进 aria-label。 -->
        <div v-if="paramChips.length" class="meta-row" data-testid="mobile-editor-params">
          <span class="input-role input-role--inline">参数</span>
          <button
            v-for="c in paramChips"
            :key="c.field"
            class="param-chip"
            type="button"
            :data-field="c.field"
            :aria-label="c.raw"
            data-testid="mobile-editor-param-chip"
            @click="onParamChipTap(c.field)"
          >
            {{ c.label }}
          </button>
          <span class="meta-note">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            由 agent 锁定
          </span>
        </div>

        <!-- 引用 chips（只读） -->
        <div v-if="refChips.length" class="meta-row" data-testid="mobile-editor-refs">
          <span class="input-role input-role--inline">引用</span>
          <span v-for="c in refChips" :key="c.id" class="ref-chip">{{ c.label }}</span>
        </div>

        <!-- 我的意见：无框输入（图 1 ⑤）+ auto-grow -->
        <div class="input-block input-block--divided">
          <span class="input-role">我的意见</span>
          <textarea
            ref="opinionEl"
            v-model="opinion"
            class="mobile-editor-textarea"
            rows="2"
            placeholder="想让 agent 怎么改？"
            data-testid="mobile-editor-opinion"
            @input="autogrow"
          />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 全屏表单浮层（不是选择型底部浮层 ⇒ 不走 MobileSheet；V-3 白名单豁免理由不变）。
   ⭐ v2.1：本组件 Teleport 到 body（见模板头注释），z-85 直接参与 body 层排序：
   顶栏 40 < 本浮层 85 < 抽屉 95（生态位不变）。 */
.mobile-editor-sheet {
  position: fixed;
  inset: 0;
  z-index: 85;
  display: flex;
  flex-direction: column;
  background: var(--lnk-surface-canvas);
  box-sizing: border-box;
  /* 入场 = iOS 全屏 modality 自底部滑入；卸载随 v-if 即时（规格 §6-G） */
  animation: editor-sheet-in var(--lnk-duration-base) var(--lnk-ease-decelerate);
}

@keyframes editor-sheet-in {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mobile-editor-sheet {
    animation: none;
  }
}

/* ── 导航三段（图 1 ①）───────────────────────────── */
.mobile-editor-nav {
  flex: none;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: var(--lnk-space-2);
  padding: calc(var(--lnk-space-2) + env(safe-area-inset-top)) var(--lnk-pad-card) var(--lnk-space-2);
}

.nav-cancel {
  min-width: var(--lnk-touch-target);
  min-height: var(--lnk-touch-target);
  padding: 0 var(--lnk-space-2);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-accent);
  font-size: var(--lnk-text-md);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.nav-cancel:active {
  background: var(--lnk-pressed-overlay);
}

.nav-title {
  text-align: center;
  font-size: var(--lnk-text-lg);
  font-weight: var(--lnk-weight-semibold);
  color: var(--lnk-text-primary);
}

.nav-send {
  display: inline-flex;
  align-items: center;
  gap: var(--lnk-space-1);
  min-height: var(--lnk-touch-target);
  padding: 0 calc(var(--lnk-space-3) + 2px);
  border: none;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-accent);
  color: var(--lnk-accent-on-signature);
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-semibold);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.nav-send:active {
  opacity: 0.85;
}

.nav-send:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── 主体：无框输入 + 弱化元信息行（J-4）───────────── */
.mobile-editor-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: var(--lnk-space-2) var(--lnk-pad-card) var(--lnk-pad-card);
}

/* Task 7：系统总览节点只读说明面（与主体同几何；无输入框、无发送出口） */
.mobile-editor-readonly {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-2) var(--lnk-pad-card) var(--lnk-pad-card);
  text-align: center;
}

.ro-title {
  margin: 0;
  font-size: var(--lnk-text-lg);
  font-weight: var(--lnk-weight-semibold);
  color: var(--lnk-text-primary);
}

.ro-desc {
  margin: 0;
  font-size: var(--lnk-text-sm);
  line-height: var(--lnk-lh-sm);
  color: var(--lnk-text-secondary);
}

/* 产物上下文行（图 1 ②）—— v2.1 瘦身：34px 图标盒 → 24px 内联图标 */
.ctx-row {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-2) 0;
}

.ctx-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--lnk-accent);
}

.ctx-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ctx-name {
  font-size: var(--lnk-text-sm);
  font-weight: var(--lnk-weight-semibold);
  color: var(--lnk-text-primary);
}

.ctx-sub {
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-muted);
}

/* 无框输入块（图 1 ③⑤） */
.input-block {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-1);
  padding: var(--lnk-space-3) 0;
}

.input-block--divided {
  border-top: 1px solid var(--lnk-divider);
}

.input-role {
  font-size: var(--lnk-text-2xs);
  font-weight: var(--lnk-weight-medium);
  letter-spacing: 0.08em;
  color: var(--lnk-text-muted);
}

.input-role--inline {
  flex: none;
  align-self: center;
}

/* ⭐ v2.1：resize: none —— 桌面拖拽斜纹绝不上移动端；高度走 auto-grow */
.mobile-editor-textarea {
  width: 100%;
  min-height: 52px;
  box-sizing: border-box;
  padding: var(--lnk-space-1) 0;
  border: none;
  background: transparent;
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-md);
  line-height: var(--lnk-lh-md);
  caret-color: var(--lnk-accent);
  resize: none;
  overflow: hidden;
}

.mobile-editor-textarea:focus {
  outline: none;
}

.mobile-editor-textarea::placeholder {
  color: var(--lnk-text-muted);
}

/* 元信息行：参数 chips / 引用 chips（图 1 ④） */
.meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-2) 0;
}

.param-chip {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 var(--lnk-space-2);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-sm);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.param-chip:active {
  background: var(--lnk-pressed-overlay);
}

.ref-chip {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 var(--lnk-space-2);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-secondary);
  font-size: var(--lnk-text-2xs);
}

/* 锁定标注（v2.1：锁形图标内联，弱化但可辨识） */
.meta-note {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-muted);
}
</style>
