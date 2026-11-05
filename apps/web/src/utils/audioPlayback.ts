/**
 * 音频播放互斥协调器（模块级单例，无框架依赖）。
 *
 * 背景：画布磁贴（MobileNodeTile）与全屏查看器（MobileNodeViewer）各自持有一个
 * <audio> 元素、各自维护一份 playing ref。tap 打开 viewer 时磁贴并没有停，于是
 * 两个实例可以同时 play()：出现双声源、按钮形态互不相干，以及真机上「偶发点了
 * 播放却没变成播放态」（用户看到的按钮属于 A，实际在播的是 B；或 A 的 play()
 * 被系统音频焦点打断却无人复位）。
 *
 * 这里只做一件事：任一实例进入播放态时，先把其它实例的媒体暂停。各实例本地 UI
 * 状态的复位仍由自己的 @pause 事件驱动 —— 保持「媒体事件是播放态单一真源」，
 * 协调器不持有任何 UI 状态，也不替代事件绑定。
 */
let activeEl: HTMLAudioElement | null = null

/** 在 @play 中调用：抢占播放权，暂停此前正在播放的其它实例 */
export function claimAudioPlayback(el: HTMLAudioElement | null): void {
  if (!el) return
  if (activeEl && activeEl !== el) {
    try {
      activeEl.pause()
    } catch {
      /* 元素已随组件卸载，忽略 */
    }
  }
  activeEl = el
}

/** 在 @pause / @ended / 卸载中调用：只释放自己，不误清后来者的播放权 */
export function releaseAudioPlayback(el: HTMLAudioElement | null): void {
  if (el && activeEl === el) activeEl = null
}

/** 仅测试用：避免模块级状态跨用例泄漏 */
export function resetAudioPlaybackForTest(): void {
  activeEl = null
}
