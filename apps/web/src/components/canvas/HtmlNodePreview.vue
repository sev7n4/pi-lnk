<script lang="ts">
// 守卫测试与 Task 5/7 宿主从此处按组件契约引用常量；真相源在 htmlNodePreviewContract.ts。
export { HTML_NODE_CSP, HTML_NODE_SANDBOX_ATTRS } from './htmlNodePreviewContract'
</script>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { HTML_NODE_CSP, HTML_NODE_SANDBOX_ATTRS } from './htmlNodePreviewContract'

/**
 * HTML 文本节点沙箱预览面（规格 §5.4 组件契约；§4.3 沙箱判据）。
 * 非 embedded：自带 overlay + 关闭钮（PC 双击节点打开）。
 * embedded：纯预览面（移动端 MobileNodeViewer 内嵌；退出由宿主 viewer 负责）。
 * ⚠️ 保存一律 emit('save') 由宿主走 patch 通路——禁 inject CANVAS_NODE_PATCH_KEY
 * （CanvasNodeText.onSave 注释：updateNodeData 会被下一次页面 patch 的旧数据覆盖）。
 */
const props = withDefaults(
  defineProps<{ content: string; readonly?: boolean; embedded?: boolean }>(),
  { readonly: false, embedded: false },
)
const emit = defineEmits<{
  (e: 'save', payload: { content: string; format: 'html' }): void
  (e: 'close'): void
}>()

const tab = ref<'preview' | 'source'>('preview')
const draft = ref('')

const degraded = computed(() => props.content.trim() === '')
const srcdoc = computed(() =>
  degraded.value ? '' : `<meta http-equiv="Content-Security-Policy" content="${HTML_NODE_CSP}">${props.content}`,
)

function openSource() {
  draft.value = props.content
  tab.value = 'source'
}
function onSave() {
  emit('save', { content: draft.value, format: 'html' })
  tab.value = 'preview'
}
</script>

<template>
  <div v-if="!embedded" class="html-preview-overlay" @click.self="emit('close')">
    <div class="html-preview-panel">
      <header v-if="!readonly" class="html-preview-bar">
        <button
          v-for="t in (['preview', 'source'] as const)"
          :key="t"
          type="button"
          class="html-preview-tab"
          :class="{ 'is-active': tab === t }"
          data-testid="html-tab"
          @click="t === 'source' ? openSource() : (tab = 'preview')"
        >
          {{ t === 'preview' ? '预览' : '源码' }}
        </button>
        <span class="html-preview-hint">沙箱预览：无网络请求、无持久化存储</span>
        <button type="button" class="html-preview-close" data-testid="html-close" aria-label="关闭" @click="emit('close')">✕</button>
      </header>
      <button v-else type="button" class="html-preview-close html-preview-close--solo" data-testid="html-close" aria-label="关闭" @click="emit('close')">✕</button>

      <iframe
        v-if="tab === 'preview' && !degraded"
        class="html-preview-frame"
        :sandbox="HTML_NODE_SANDBOX_ATTRS"
        :srcdoc="srcdoc"
        title="HTML 产物沙箱预览"
      ></iframe>
      <textarea
        v-else-if="tab === 'source'"
        v-model="draft"
        class="html-preview-source"
        spellcheck="false"
        aria-label="HTML 源码"
      ></textarea>
      <pre v-else class="html-preview-degraded">内容为空或不可渲染</pre>

      <footer v-if="!readonly && tab === 'source'" class="html-preview-footer">
        <button type="button" class="html-preview-save" data-testid="html-save" @click="onSave">保存</button>
      </footer>
    </div>
  </div>

  <!-- embedded（移动端）：纯预览面，无 overlay / 关闭钮 / 保存（编辑走宿主编辑 sheet） -->
  <div v-else class="html-preview-embedded">
    <iframe
      v-if="!degraded"
      class="html-preview-frame"
      :sandbox="HTML_NODE_SANDBOX_ATTRS"
      :srcdoc="srcdoc"
      title="HTML 产物沙箱预览"
    ></iframe>
    <pre v-else class="html-preview-degraded">内容为空或不可渲染</pre>
  </div>
</template>

<style scoped>
.html-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--lnk-z-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--lnk-scrim);
}
.html-preview-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(960px, 92vw);
  height: min(720px, 88vh);
  overflow: hidden;
  border-radius: var(--lnk-radius-lg);
  background: var(--lnk-surface-canvas);
}
.html-preview-bar {
  display: flex;
  align-items: center;
  gap: var(--lnk-space-2);
  padding: var(--lnk-space-2) var(--lnk-space-3);
  border-bottom: 1px solid var(--lnk-border-subtle);
}
.html-preview-tab {
  min-height: var(--lnk-touch-target);
  padding: 0 var(--lnk-space-3);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: transparent;
  color: var(--lnk-text-secondary);
  cursor: pointer;
}
.html-preview-tab.is-active {
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-primary);
}
.html-preview-hint {
  margin-left: auto;
  font-size: var(--lnk-text-xs);
  color: var(--lnk-text-muted);
}
.html-preview-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--lnk-touch-target);
  height: var(--lnk-touch-target);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-primary);
  cursor: pointer;
}
.html-preview-close--solo {
  position: absolute;
  top: var(--lnk-space-2);
  right: var(--lnk-space-2);
  z-index: 1;
}
.html-preview-frame {
  flex: 1;
  width: 100%;
  border: none;
  /* 纸白画布：用户 HTML 默认按白底渲染，需恒白底避免深色主题透底。
     design-tokens.css 无对应语义 token（--lnk-ink-0 属 L1 禁直引），保留最小字面量。 */
  background: #fff;
}
.html-preview-source {
  flex: 1;
  padding: var(--lnk-space-3);
  border: none;
  resize: none;
  font-family: var(--lnk-font-mono);
  font-size: var(--lnk-text-sm);
  background: var(--lnk-surface-canvas);
  color: var(--lnk-text-primary);
}
.html-preview-degraded {
  flex: 1;
  margin: 0;
  padding: var(--lnk-space-3);
  overflow: auto;
  white-space: pre-wrap;
  font-family: var(--lnk-font-mono);
  font-size: var(--lnk-text-sm);
}
.html-preview-footer {
  display: flex;
  justify-content: flex-end;
  padding: var(--lnk-space-2) var(--lnk-space-3);
  border-top: 1px solid var(--lnk-border-subtle);
}
.html-preview-save {
  min-height: var(--lnk-touch-target);
  padding: 0 var(--lnk-space-4);
  border: none;
  border-radius: var(--lnk-radius-md);
  background: var(--lnk-accent);
  color: var(--lnk-text-on-accent);
  cursor: pointer;
}
.html-preview-embedded {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}
</style>
