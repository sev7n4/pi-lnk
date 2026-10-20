import { ref, computed, onUnmounted } from 'vue'

interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: { transcript: string }
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}

interface SpeechRecognitionErrorEventLike {
  error?: string
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

/** 识别失败码 → 中文提示（失败必须可见：此前静默 stop，用户以为功能坏了） */
const SPEECH_ERROR_TEXT: Record<string, string> = {
  'not-allowed': '麦克风权限被拒绝，请在浏览器设置里允许后重试',
  'service-not-allowed': '当前浏览器不允许语音识别服务',
  'audio-capture': '没有检测到麦克风设备',
  'no-speech': '没听到声音，请长按说话',
  network: '语音识别服务不可达（网络受限），可改用键盘输入',
  aborted: '语音识别已中断',
}

function speechErrorText(code: string | null): string | null {
  if (!code) return null
  return SPEECH_ERROR_TEXT[code] ?? '语音识别失败，请改用键盘输入'
}

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function useSpeechRecognition() {
  const supported = !!getSpeechRecognition()
  const listening = ref(false)
  /**
   * 最近一次识别失败原因（2026-10-21 真机走查：此前 onerror 静默 stop，
   * 用户长按「按住说话」后**零反馈**——像坏了而不是像不支持）。
   * 常见码：not-allowed（麦克风权限被拒）/ no-speech（没说话）/ network（识别服务不可达）/
   * service-not-allowed / audio-capture（没有麦克风设备）。
   */
  const lastError = ref<string | null>(null)
  /** 最近一次失败的中文提示（无失败 = null） */
  const errorText = computed(() => speechErrorText(lastError.value))
  let recognition: SpeechRecognitionLike | null = null

  function stop() {
    recognition?.stop()
    recognition = null
    listening.value = false
  }

  function start(onTranscript: (text: string, isFinal: boolean) => void) {
    const Ctor = getSpeechRecognition()
    if (!Ctor) return false

    stop()
    lastError.value = null
    recognition = new Ctor()
    recognition.lang = 'zh-CN'
    recognition.continuous = false
    recognition.interimResults = true

    recognition.onresult = (event) => {
      let interim = ''
      let finalText = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript
        if (event.results[i].isFinal) finalText += chunk
        else interim += chunk
      }
      if (finalText) onTranscript(finalText, true)
      else if (interim) onTranscript(interim, false)
    }

    recognition.onerror = (event) => {
      lastError.value = event?.error ?? 'unknown'
      stop()
    }
    recognition.onend = () => { listening.value = false }

    recognition.start()
    listening.value = true
    return true
  }

  onUnmounted(stop)

  return { supported, listening, lastError, errorText, start, stop }
}
