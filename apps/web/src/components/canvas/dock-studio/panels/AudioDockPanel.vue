<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { audioKindOf, type AudioKind } from '@lnkpi/shared'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import type { UpstreamNodeContext } from '@/composables/useUpstreamNodeContext'
import type { MentionOption } from '@/components/canvas/MentionInput.vue'
import UniversalModelSelector from '@/components/canvas/UniversalModelSelector.vue'
import VoiceModelSelector from '@/components/canvas/VoiceModelSelector.vue'
import AudioVoiceSettingsSelector from '@/components/canvas/AudioVoiceSettingsSelector.vue'
import DockToolbarShell from '@/components/canvas/dock-studio/shared/DockToolbarShell.vue'
import DockPromptSection from '@/components/canvas/dock-studio/shared/DockPromptSection.vue'
import DockGenerateButton from '@/components/canvas/dock-studio/shared/DockGenerateButton.vue'
import DockMicButton from '@/components/canvas/dock-studio/shared/DockMicButton.vue'
import DockCreditBadge from '@/components/canvas/dock-studio/shared/DockCreditBadge.vue'
import DockRefStrip from '@/components/canvas/dock-studio/shared/DockRefStrip.vue'
import type { LocalRefBinding, NodeRef } from '@/composables/useNodeRefs'
import { useSpeechRecognition } from '@/composables/useSpeechRecognition'
import {
  AUDIO_KIND_OPTIONS,
  DEFAULT_AUDIO_EMOTION,
  DEFAULT_AUDIO_LANGUAGE,
  DEFAULT_AUDIO_PITCH,
  DEFAULT_AUDIO_SPEED,
  DEFAULT_AUDIO_VOLUME,
  DEFAULT_AUDIO_VOICE,
  defaultVoiceForKind,
  type AudioVoiceSettings,
} from '@/constants/dockAudio'
import {
  catalogModelKeyFromValue,
  getModelEntry,
  resolveGenerationModel,
} from '@/constants/studioModels'
import { useModelProviderSettings } from '@/composables/useModelProviderSettings'
import { isNodeGenerating } from '@/constants/dockStudio'
import { estimateAudioCredits } from '@/constants/credits'
import { useDockLocalImageUpload } from '@/components/canvas/dock-studio/shared/useDockLocalImageUpload'

const { getConfig } = useModelProviderSettings()

const props = defineProps<{
  node: EditableFlowNode
  upstream: UpstreamNodeContext
  refs?: NodeRef[]
  mentions?: MentionOption[]
  generating?: boolean
}>()

const emit = defineEmits<{
  patch: [patch: Record<string, unknown>]
  generate: []
  close: []
  removeRef: [ref: NodeRef]
}>()

/** design 的角色→音色表（`role` 为角色名，`voice` 为上游音色 id）。 */
interface AudioRoleRow {
  role: string
  voice: string
}
/** design 的脚本段：`role` 空串表示不指定角色（旁白/音效）。 */
interface AudioScriptRow {
  role: string
  text: string
}

function readKind(data: Record<string, unknown> | undefined): AudioKind {
  return audioKindOf({ modality: 'audio', audioKind: data?.audioKind as AudioKind | undefined })
}

function readRoles(data: Record<string, unknown> | undefined): AudioRoleRow[] {
  const raw = data?.audioRoles
  if (!Array.isArray(raw)) return []
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({ role: String(r.role ?? ''), voice: String(r.voice ?? '') }))
}

function readScripts(data: Record<string, unknown> | undefined): AudioScriptRow[] {
  const raw = data?.audioScripts
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({ role: String(s.role ?? ''), text: String(s.text ?? '') }))
}

const prompt = ref('')
/** 音频二阶分类。存量节点无 `audioKind` ⇒ 缺省视作 `voice`（判据统一走 `audioKindOf`）。 */
const audioKind = ref<AudioKind>(readKind(props.node.data))
const audioModel = ref(getConfig('audio').model)
const audioVoice = ref(DEFAULT_AUDIO_VOICE)
const voiceSettings = ref<AudioVoiceSettings>({
  emotion: DEFAULT_AUDIO_EMOTION,
  language: DEFAULT_AUDIO_LANGUAGE,
  speed: DEFAULT_AUDIO_SPEED,
  volume: DEFAULT_AUDIO_VOLUME,
  pitch: DEFAULT_AUDIO_PITCH,
})
const designRoles = ref<AudioRoleRow[]>([])
const designScripts = ref<AudioScriptRow[]>([])
const designInstruction = ref('')
const musicLyrics = ref('')
const musicInstrumental = ref(false)

const modelVoices = computed(() => getModelEntry(catalogModelKeyFromValue(audioModel.value))?.voices)

const speech = useSpeechRecognition()
const promptSectionRef = ref<InstanceType<typeof DockPromptSection> | null>(null)
const {
  inputRef: refInput,
  uploading: refUploading,
  uploadError: refUploadError,
  pick: pickReferenceImage,
  onFileChange: onRefFileChange,
} = useDockLocalImageUpload({
  getExistingLocalRefs: () => (props.node.data?.localRefs as LocalRefBinding[]) ?? [],
  onPatch: (patch) => emit('patch', patch),
})
const readonly = computed(() => isNodeGenerating(props.node.data?.status) || !!props.generating)
const credits = computed(() => estimateAudioCredits(audioKind.value))

/** 各分类的正文提示语：music 的正文就是 `caption`（风格描述），design 的正文只作记录。 */
const promptPlaceholder = computed(() => {
  if (audioKind.value === 'music') return '描述想要的音乐风格、情绪、乐器...'
  if (audioKind.value === 'design') return '给这段综合音频起个名字（台词填在下方脚本段）...'
  return '输入台词或旁白文本...'
})

function syncVoiceToCatalog(emitPatch: boolean) {
  const voices = getModelEntry(catalogModelKeyFromValue(audioModel.value))?.voices
  if (!voices?.length) return
  if (!voices.some((v) => v.id === audioVoice.value)) {
    audioVoice.value = voices[0].id
    if (emitPatch) {
      emit('patch', { audioVoice: voices[0].id })
    }
  }
}

function syncFromNode() {
  const data = props.node.data ?? {}
  prompt.value = String(data.prompt ?? data.content ?? '')
  audioKind.value = readKind(data)
  audioModel.value = resolveGenerationModel('audio', data.audioModel as string | undefined)
  audioVoice.value = String(data.audioVoice ?? DEFAULT_AUDIO_VOICE)
  syncVoiceToCatalog(true)
  const emotion = data.audioEmotion as AudioVoiceSettings['emotion'] | undefined
  const language = data.audioLanguage as AudioVoiceSettings['language'] | undefined
  const speed = typeof data.audioSpeed === 'number' ? data.audioSpeed : DEFAULT_AUDIO_SPEED
  const volume = typeof data.audioVolume === 'number' ? data.audioVolume : DEFAULT_AUDIO_VOLUME
  const pitch = typeof data.audioPitch === 'number' ? data.audioPitch : DEFAULT_AUDIO_PITCH
  voiceSettings.value = {
    emotion: emotion ?? DEFAULT_AUDIO_EMOTION,
    language: language ?? DEFAULT_AUDIO_LANGUAGE,
    speed,
    volume,
    pitch,
  }
  designRoles.value = readRoles(data)
  designScripts.value = readScripts(data)
  designInstruction.value = String(data.audioInstruction ?? '')
  musicLyrics.value = String(data.audioLyrics ?? '')
  musicInstrumental.value = Boolean(data.audioInstrumental)
}

watch(() => props.node, syncFromNode, { immediate: true, deep: true })

watch(audioModel, () => syncVoiceToCatalog(true))

const hasRefs = computed(() => (props.refs?.length ?? 0) > 0)

/**
 * design 的正文在 `scripts[]` 里（不是 prompt）⇒ 没有台词段时也允许生成，
 * 否则用户填完角色+脚本仍然点不动生成按钮。
 */
const canGenerate = computed(
  () =>
    !!prompt.value.trim() ||
    hasRefs.value ||
    (audioKind.value === 'design' && designScripts.value.some((s) => s.text.trim())),
)

function setAudioKind(next: AudioKind) {
  audioKind.value = next
  // 切分类时把模型换成该分类的首选，避免「音乐分类 + TTS 模型」的必错组合
  // （服务端 `assertAudioKindMatchesModel` 对这种错配显式 400）。
  audioModel.value = resolveGenerationModel('audio', defaultVoiceForKind(next))
  emit('patch', { audioKind: next, audioModel: audioModel.value })
}

function onPromptInput(value: string) {
  prompt.value = value
  emit('patch', { prompt: value })
}

function syncVoiceSettings(value: AudioVoiceSettings) {
  voiceSettings.value = value
  emit('patch', {
    audioEmotion: value.emotion,
    audioLanguage: value.language,
    audioSpeed: value.speed,
    audioVolume: value.volume,
    audioPitch: value.pitch,
  })
}

function patchRoles() {
  emit('patch', { audioRoles: designRoles.value })
}

function patchScripts() {
  emit('patch', { audioScripts: designScripts.value })
}

function addRole() {
  designRoles.value = [...designRoles.value, { role: '', voice: DEFAULT_AUDIO_VOICE }]
  patchRoles()
}

function removeRole(index: number) {
  designRoles.value = designRoles.value.filter((_, i) => i !== index)
  patchRoles()
}

function addScript() {
  designScripts.value = [...designScripts.value, { role: '', text: '' }]
  patchScripts()
}

function removeScript(index: number) {
  designScripts.value = designScripts.value.filter((_, i) => i !== index)
  patchScripts()
}

function onInstructionInput(value: string) {
  designInstruction.value = value
  emit('patch', { audioInstruction: value })
}

function onLyricsInput(value: string) {
  musicLyrics.value = value
  emit('patch', { audioLyrics: value })
}

function toggleInstrumental() {
  musicInstrumental.value = !musicInstrumental.value
  emit('patch', { audioInstrumental: musicInstrumental.value })
}

function onGenerate() {
  // 参数区按 kind 互斥：只写当前分类用得到的字段，避免把上一分类的残留值发到上游。
  const kindPatch: Record<string, unknown> =
    audioKind.value === 'design'
      ? {
          audioRoles: designRoles.value,
          audioScripts: designScripts.value,
          audioInstruction: designInstruction.value,
        }
      : audioKind.value === 'music'
        ? { audioLyrics: musicLyrics.value, audioInstrumental: musicInstrumental.value }
        : {
            audioVoice: audioVoice.value,
            audioEmotion: voiceSettings.value.emotion,
            audioLanguage: voiceSettings.value.language,
            audioSpeed: voiceSettings.value.speed,
            audioVolume: voiceSettings.value.volume,
            audioPitch: voiceSettings.value.pitch,
          }
  emit('patch', {
    prompt: prompt.value,
    audioKind: audioKind.value,
    audioModel: audioModel.value,
    ...kindPatch,
  })
  emit('generate')
}

function toggleVoice() {
  if (speech.listening.value) {
    speech.stop()
    return
  }
  speech.start((text, isFinal) => {
    if (isFinal) {
      const next = prompt.value ? `${prompt.value} ${text}` : text
      onPromptInput(next)
    }
  })
}

function onRefReorder(refIds: string[]) {
  emit('patch', { refOrder: refIds })
}

function onRefRemove(ref: NodeRef) {
  emit('removeRef', ref)
}

function onRefMention(refKey: string) {
  promptSectionRef.value?.insertRefMention(refKey)
}
</script>

<template>
  <DockToolbarShell type="audio" @close="emit('close')">
    <DockRefStrip
      :refs="refs ?? []"
      show-add-upload
      :add-upload-disabled="readonly"
      :add-upload-busy="refUploading"
      @reorder="onRefReorder"
      @remove="onRefRemove"
      @mention="onRefMention"
      @add-upload="pickReferenceImage"
    />
    <input ref="refInput" type="file" accept="image/*" class="hidden" @change="onRefFileChange">
    <p v-if="refUploadError" class="mx-3 mb-1 text-[10px] text-red-400/90">{{ refUploadError }}</p>

    <div class="dock-audio-kind-chips">
      <button
        v-for="opt in AUDIO_KIND_OPTIONS"
        :key="opt.value"
        type="button"
        class="neo-chip rounded-md px-2 py-1 text-[10px]"
        :class="{ 'is-on': audioKind === opt.value }"
        :disabled="readonly"
        @click="setAudioKind(opt.value)"
      >
        {{ opt.label }}
      </button>
    </div>

    <DockPromptSection
      ref="promptSectionRef"
      :model-value="prompt"
      :mentions="mentions"
      :placeholder="promptPlaceholder"
      @update:model-value="onPromptInput"
      @submit="onGenerate"
    />

    <!-- 参数区按 kind 互斥：voice 走音色+语音参数，design 走角色/脚本/指导，music 走歌词/纯音乐 -->
    <div v-if="audioKind === 'design'" class="dock-audio-kind-params">
      <div class="dock-audio-kind-params-row">
        <span class="dock-audio-kind-params-label">角色音色</span>
        <div
          v-for="(row, i) in designRoles"
          :key="i"
          class="dock-audio-kind-params-line"
        >
          <input
            v-model="row.role"
            type="text"
            placeholder="角色名"
            class="neo-ctl min-w-0 flex-1 rounded-md px-2 py-1 text-[11px]"
            :disabled="readonly"
            @input="patchRoles"
          >
          <input
            v-model="row.voice"
            type="text"
            placeholder="音色 id"
            class="neo-ctl min-w-0 flex-1 rounded-md px-2 py-1 text-[11px]"
            :disabled="readonly"
            @input="patchRoles"
          >
          <button
            type="button"
            class="neo-chip rounded-md px-2 py-1 text-[10px]"
            :disabled="readonly"
            @click="removeRole(i)"
          >
            删
          </button>
        </div>
        <button
          type="button"
          class="neo-chip rounded-md px-2 py-1 text-[10px]"
          :disabled="readonly"
          @click="addRole"
        >
          加角色
        </button>
      </div>

      <div class="dock-audio-kind-params-row">
        <span class="dock-audio-kind-params-label">脚本段</span>
        <div
          v-for="(row, i) in designScripts"
          :key="i"
          class="dock-audio-kind-params-line"
        >
          <input
            v-model="row.role"
            type="text"
            placeholder="角色（可空）"
            class="neo-ctl min-w-0 flex-1 rounded-md px-2 py-1 text-[11px]"
            :disabled="readonly"
            @input="patchScripts"
          >
          <input
            v-model="row.text"
            type="text"
            placeholder="台词，() 语气 [] 音效"
            class="neo-ctl min-w-0 flex-[2] rounded-md px-2 py-1 text-[11px]"
            :disabled="readonly"
            @input="patchScripts"
          >
          <button
            type="button"
            class="neo-chip rounded-md px-2 py-1 text-[10px]"
            :disabled="readonly"
            @click="removeScript(i)"
          >
            删
          </button>
        </div>
        <button
          type="button"
          class="neo-chip rounded-md px-2 py-1 text-[10px]"
          :disabled="readonly"
          @click="addScript"
        >
          加脚本段
        </button>
      </div>

      <div class="dock-audio-kind-params-row">
        <span class="dock-audio-kind-params-label">整体指导</span>
        <input
          :value="designInstruction"
          type="text"
          placeholder="整体演绎指导（自然语言）"
          class="neo-ctl min-w-0 flex-1 rounded-md px-2 py-1 text-[11px]"
          :disabled="readonly"
          @input="onInstructionInput(($event.target as HTMLInputElement).value)"
        >
      </div>
    </div>

    <div v-else-if="audioKind === 'music'" class="dock-audio-kind-params">
      <div class="dock-audio-kind-params-row">
        <span class="dock-audio-kind-params-label">歌词</span>
        <input
          :value="musicLyrics"
          type="text"
          placeholder="歌词（纯音乐时留空）"
          class="neo-ctl min-w-0 flex-1 rounded-md px-2 py-1 text-[11px]"
          :disabled="readonly"
          @input="onLyricsInput(($event.target as HTMLInputElement).value)"
        >
        <button
          type="button"
          class="neo-chip rounded-md px-2 py-1 text-[10px]"
          :class="{ 'is-on': musicInstrumental }"
          :disabled="readonly"
          @click="toggleInstrumental"
        >
          纯音乐
        </button>
      </div>
    </div>

    <div class="bottom-toolbar-actions flex-wrap">
      <UniversalModelSelector
        v-model="audioModel"
        type="text"
        modality="audio"
        :audio-kind="audioKind"
        @update:model-value="emit('patch', { audioModel: $event })"
      />
      <template v-if="audioKind === 'voice'">
        <VoiceModelSelector
          v-model="audioVoice"
          :voices="modelVoices"
          @update:model-value="emit('patch', { audioVoice: $event })"
        />
        <AudioVoiceSettingsSelector
          v-model="voiceSettings"
          @update:model-value="syncVoiceSettings"
        />
      </template>

      <div class="ml-auto flex items-center gap-2">
        <DockMicButton
          :listening="speech.listening.value"
          :disabled="readonly"
          @toggle="toggleVoice"
        />
        <DockCreditBadge :credits="credits" />
        <DockGenerateButton
          :generating="generating"
          :disabled="!generating && !canGenerate"
          @generate="onGenerate"
        />
      </div>
    </div>
  </DockToolbarShell>
</template>

<style scoped>
/* 形态照抄 VideoDockPanel 的 `.dock-video-chip-actions`，不另造一套 chip 样式。 */
.dock-audio-kind-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0 8px 6px;
}

.dock-audio-kind-params {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0 8px 6px;
}

.dock-audio-kind-params-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.dock-audio-kind-params-line {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
}

.dock-audio-kind-params-label {
  flex-shrink: 0;
  min-width: 44px;
  font-size: 10px;
  color: var(--neo-text-muted);
}
</style>
