import { ref, onUnmounted } from 'vue'

/**
 * P2-2（Task 13）：录音电平反馈（时长走各自会话 ticker，本模块只管电平）。
 *
 * getUserMedia + AnalyserNode 的 RMS → level ref（0-1）。浏览器不支持/拒绝授权时
 * start() 返回 false，level 恒为 0（UI 以最小宽度兜底，不影响录音主链路——
 * ASR 本体走 useSpeechRecognition，不依赖本模块）。
 */
export function useMicLevel() {
  const level = ref(0)
  let ctx: AudioContext | null = null
  let stream: MediaStream | null = null
  let raf = 0

  async function start(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return false
    }
    const w = window as Window & { webkitAudioContext?: typeof AudioContext }
    const Ctor = window.AudioContext ?? w.webkitAudioContext
    if (!Ctor) return false
    ctx = new Ctor()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const d = buf[i] - 128
        sum += d * d
      }
      // RMS 归一：/64 让正常说话落在 ~0.4-0.8 区间，钳到 1
      level.value = Math.min(1, Math.sqrt(sum / buf.length) / 64)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return true
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    void ctx?.close().catch(() => {})
    ctx = null
    level.value = 0
  }

  onUnmounted(stop)
  return { level, start, stop }
}
