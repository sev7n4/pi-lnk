<script setup lang="ts">
/**
 * P3 导入技能弹窗：粘贴 SKILL.md → skillApi.import(text, 'paste')。
 * 解析/hash/兼容校验全部吃服务端 verifyImport 语义（不造前端解析——规格 §4.5）；
 * 失败原样呈现服务端 message；成功 emit imported（宿主刷新 mine + 切「用户自定义」组可见）。
 */
import { computed, ref } from 'vue'
import { skillApi } from '@/services/skill-api'

const emit = defineEmits<{
  close: []
  /** 导入成功（携带新技能名），宿主刷新 mine 列表。 */
  imported: [skillName: string]
}>()

const text = ref('')
const submitting = ref(false)
const error = ref('')
const success = ref('')

const canSubmit = computed(() => text.value.trim().length > 0 && !submitting.value)

async function onSubmit() {
  if (!canSubmit.value) return
  submitting.value = true
  error.value = ''
  success.value = ''
  try {
    const res = await skillApi.import(text.value.trim(), 'paste')
    success.value = `已导入「${res.skill}」`
    emit('imported', res.skill)
  } catch (err) {
    // 服务端信封 message（解析失败/重复 hash/兼容告警）原样呈现，不做前端转译
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="import-mask" data-testid="import-dialog" role="dialog" aria-modal="true" aria-label="导入技能" @click.self="emit('close')">
    <div class="import-box">
      <div class="import-head">
        <span class="import-title">导入技能</span>
        <button type="button" class="import-close" aria-label="关闭导入" data-testid="import-close" @click="emit('close')">
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <p class="import-hint">粘贴完整的 SKILL.md 内容（含 frontmatter）。格式校验、内容哈希与兼容性由服务端完成。</p>
      <textarea
        v-model="text"
        class="import-textarea"
        data-testid="import-textarea"
        :disabled="submitting"
        placeholder="---\nname: my-skill\ndescription: …\n---\n\n# 步骤…"
        rows="12"
      />
      <p v-if="error" class="import-error" data-testid="import-error">{{ error }}</p>
      <p v-if="success" class="import-success" data-testid="import-success">{{ success }}</p>
      <div class="import-actions">
        <button type="button" class="import-btn" @click="emit('close')">取消</button>
        <button
          type="button"
          class="import-btn import-btn-primary"
          data-testid="import-submit"
          :disabled="!canSubmit"
          @click="onSubmit"
        >
          {{ submitting ? '导入中…' : '导入' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.import-mask { position: fixed; inset: 0; z-index: var(--lnk-z-overlay); display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.5); }
.import-box { display: flex; flex-direction: column; gap: var(--lnk-space-3); width: min(560px, 92vw); max-height: 84vh; background: var(--lnk-surface-raised); border-radius: var(--lnk-radius-lg); padding: var(--lnk-space-4); }
.import-head { display: flex; align-items: center; justify-content: space-between; }
.import-title { font-size: var(--lnk-text-sm); font-weight: 600; color: var(--lnk-text-primary); }
.import-close { appearance: none; border: 0; background: transparent; cursor: pointer; color: var(--lnk-text-muted); padding: var(--lnk-space-1); border-radius: var(--lnk-radius-sm); }
.import-hint { color: var(--lnk-text-muted); font-size: var(--lnk-text-xs); }
.import-textarea { width: 100%; flex: 1; min-height: 180px; resize: vertical; border: 1px solid var(--lnk-border-subtle); border-radius: var(--lnk-radius-md); background: var(--lnk-surface-canvas); color: var(--lnk-text-primary); font: inherit; font-size: var(--lnk-text-xs); padding: var(--lnk-space-3); }
.import-textarea:focus { outline: none; border-color: var(--lnk-accent); }
.import-error { color: var(--lnk-error); font-size: var(--lnk-text-xs); }
.import-success { color: var(--lnk-accent); font-size: var(--lnk-text-xs); }
.import-actions { display: flex; justify-content: flex-end; gap: var(--lnk-space-2); }
.import-btn { appearance: none; cursor: pointer; font: inherit; font-size: var(--lnk-text-xs); border: 1px solid var(--lnk-border-subtle); background: var(--lnk-surface-raised); color: var(--lnk-text-primary); border-radius: var(--lnk-radius-sm); padding: var(--lnk-space-1) var(--lnk-space-3); }
.import-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.import-btn-primary { background: var(--lnk-accent); border-color: var(--lnk-accent); color: var(--lnk-text-on-accent); }
</style>
