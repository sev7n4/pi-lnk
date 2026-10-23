/**
 * 文本转语音薄封装（R1-T6，D-A）：移动端长文节点 tap 朗读，短文开阅读器。
 * 仅包装浏览器原生 `speechSynthesis`，无第三方依赖；不支持的环境静默降级。
 */
export function useTextToSpeech() {
  const supported =
    typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined'

  function speak(text: string) {
    if (!supported || !text) return
    try {
      // 先停掉上一段（避免叠加朗读），再朗读当前文本
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))
    } catch {
      /* jsdom / 老浏览器无实现：忽略 */
    }
  }

  function stop() {
    if (!supported) return
    try {
      window.speechSynthesis.cancel()
    } catch {
      /* ignore */
    }
  }

  return { supported, speak, stop }
}
