import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeViewer from './MobileNodeViewer.vue'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ vitest 是 ESM ⇒ `__dirname` 不可用（仓库既有约定：fileURLToPath(import.meta.url)）
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * D2（2026-10-25 规格 §6.2 / §4.1 P3）：全屏查看器必须有**两条**退出通道
 * ——「右上 X」与「下滑关闭」，且**退出即停**（视频 pause）。
 *
 * ⚠️ 契约变更（D2）：左上 `‹` 文本字符（U+2039 细笔画，形态随字重不稳、
 *   识别失败）已删除，改为**右上角 X 的内联 SVG**（§4.11.5：禁文本字符当图标）。
 *   既有断言 `.viewer-back` 相应改写为 `.viewer-close`，**回归防护保留**。
 */
describe('MobileNodeViewer（退出通道 · D2）', () => {
  it('右上角有 X 按钮（44px 触控目标）并 emit close', async () => {
    const wrapper = mount(MobileNodeViewer, {
      props: { type: 'image', data: { url: 'https://x/a.png' } },
    })
    const btn = wrapper.find('[data-testid="mobile-viewer-close"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('无 audio 类型分支（音频永不进查看器）', () => {
    const wrapper = mount(MobileNodeViewer, {
      props: { type: 'image', data: { url: 'https://x/a.png' } },
    })
    expect(wrapper.find('video').exists()).toBe(false)
  })

  it('audio: 渲染波形查看器（D2 修订 2026-10-27，走查④）——audio 元素 + 波形 + 播放 + 可拖进度', () => {
    const w = mount(MobileNodeViewer, { props: { type: 'audio', data: { url: 'x.mp3' } } })
    expect(w.find('[data-testid="mobile-viewer-audio"]').exists()).toBe(true)
    expect(w.find('audio').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-viewer-audio-play"]').exists()).toBe(true)
    expect(w.find('input[type="range"]').exists()).toBe(true)
    expect(w.findComponent({ name: 'MobileNodeWaveform' }).exists()).toBe(true)
  })

  it('audio: 点播放 ⇒ audio.play 被调用（磁贴内联保留，查看器全屏控制）', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    try {
      const w = mount(MobileNodeViewer, { props: { type: 'audio', data: { url: 'x.mp3' } } })
      await w.get('[data-testid="mobile-viewer-audio-play"]').trigger('click')
      expect(play).toHaveBeenCalled()
    } finally {
      play.mockRestore()
    }
  })

  it('audio: 有圈选入口（底图 = 波形图，§4.3）', async () => {
    const w = mount(MobileNodeViewer, { props: { type: 'audio', data: { url: 'x.mp3' } } })
    const btn = w.find('[data-testid="mobile-viewer-annotate"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(w.find('[data-testid="mobile-viewer-ink"]').isVisible()).toBe(true)
    w.unmount()
  })

  it('audio: 退出即停（close 前调用 pause，P3）', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    try {
      const w = mount(MobileNodeViewer, { props: { type: 'audio', data: { url: 'x.mp3' } } })
      await w.get('[data-testid="mobile-viewer-close"]').trigger('click')
      expect(pause).toHaveBeenCalled()
    } finally {
      pause.mockRestore()
    }
  })

  it('image: 全屏灯箱（根容器有 testid + 渲染 img）', () => {
    const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
    expect(w.find('[data-testid="mobile-viewer"]').exists()).toBe(true)
    expect(w.find('img').exists()).toBe(true)
  })

  it('text: 渲染阅读器内容', () => {
    const w = mount(MobileNodeViewer, { props: { type: 'text', data: { content: '正文' } } })
    expect(w.text()).toContain('正文')
  })

  it('位移不足阈值 ⇒ 不 emit close', async () => {
    const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
    const root = w.get('[data-testid="mobile-viewer"]')
    await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
    await root.trigger('touchmove', { touches: [{ clientY: 200 }] })
    await root.trigger('touchend')
    expect(w.emitted('close')).toBeFalsy()
  })

  // ── 下滑关闭仲裁（2026-10-27 真机走查③ · 规格 §6.2 退出表）──────────────
  // ⚠️ 旧实现把方向写反（startY − currentY > 100 = 上滑关闭），且上面两条旧测试
  // 用「clientY 300→150」的上滑数据冒充「下滑」——本组按规格重写判据。
  describe('下滑关闭仲裁（走查③：只认下拉 + 滚动守卫）', () => {
    it('上滑（clientY 减小）超过阈值 ⇒ 不关闭（方向反转回归防护）', async () => {
      const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 300 }] })
      await root.trigger('touchmove', { touches: [{ clientY: 150 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toBeFalsy()
    })

    it('真下滑（clientY 增加）超过阈值 ⇒ emit close', async () => {
      const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
      await root.trigger('touchmove', { touches: [{ clientY: 300 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toHaveLength(1)
    })

    it('阅读器滚动途中（scrollTop>0）下拉不关闭（W-30 长文误关）', async () => {
      const w = mount(MobileNodeViewer, { props: { type: 'text', data: { content: '长文' } } })
      // 组件在 touchstart 时读 .viewer-reader 的 scrollTop —— 先把它置于滚动中段
      const reader = w.get('.viewer-reader')
      ;(reader.element as HTMLElement).scrollTop = 500
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
      await root.trigger('touchmove', { touches: [{ clientY: 300 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toBeFalsy()
    })

    it('阅读器在顶部（scrollTop=0）下拉超阈值 ⇒ 关闭（iOS 惯例）', async () => {
      const w = mount(MobileNodeViewer, { props: { type: 'text', data: { content: '短文' } } })
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
      await root.trigger('touchmove', { touches: [{ clientY: 300 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toHaveLength(1)
    })
  })

  it('视频退出即停：close 前调用 pause()（P3「退出即停」）', async () => {
    // ⚠️ 用原型 spy 而非替换 ref —— 组件内部持有自己的 ref，
    // 从外部替换 exposed.videoRef 换不掉内部引用（第一次写错，红了才发现）。
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    try {
      const w = mount(MobileNodeViewer, { props: { type: 'video', data: { url: 'x.mp4' } } })
      await w.get('[data-testid="mobile-viewer-close"]').trigger('click')
      expect(pause).toHaveBeenCalled()
    } finally {
      pause.mockRestore()
    }
  })

  // ── 视频倍速（走查⑤ · W-32：原生进度条已有，倍速循环按钮补齐）──────────
  it('video: 倍速按钮存在，循环 1→1.5→2→0.5→1 且作用到 video.playbackRate', async () => {
    const w = mount(MobileNodeViewer, { props: { type: 'video', data: { url: 'x.mp4' } } })
    const btn = w.find('[data-testid="mobile-viewer-speed"]')
    expect(btn.exists()).toBe(true)
    const video = w.find('video').element as HTMLVideoElement
    expect(btn.text()).toBe('1x')
    await btn.trigger('click')
    expect(video.playbackRate).toBe(1.5)
    expect(btn.text()).toBe('1.5x')
    await btn.trigger('click')
    expect(video.playbackRate).toBe(2)
    expect(btn.text()).toBe('2x')
    await btn.trigger('click')
    expect(video.playbackRate).toBe(0.5)
    expect(btn.text()).toBe('0.5x')
    await btn.trigger('click')
    expect(video.playbackRate).toBe(1)
    expect(btn.text()).toBe('1x')
  })

  it('video: 倍速按钮只出现在视频上（音频有自己的进度条，图片无播放）', () => {
    const img = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
    expect(img.find('[data-testid="mobile-viewer-speed"]').exists()).toBe(false)
    img.unmount()
    const aud = mount(MobileNodeViewer, { props: { type: 'audio', data: { url: 'x.mp3' } } })
    expect(aud.find('[data-testid="mobile-viewer-speed"]').exists()).toBe(false)
    aud.unmount()
  })

  // ── 标注态（L1 · §4.3：只有一支笔）──────────────────────────────────
  describe('标注态（显式进入 + 轻点即画）', () => {
    it('有「圈选」入口（显式进入，⛔ 不做隐式双击手势）', () => {
      const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'https://x/a.png' } } })
      expect(w.find('[data-testid="mobile-viewer-annotate"]').exists()).toBe(true)
      w.unmount()
    })

    it('文本节点不提供圈选入口（文本走文字引用，无底图）', () => {
      const w = mount(MobileNodeViewer, { props: { type: 'text', data: { content: '你好' } } })
      expect(w.find('[data-testid="mobile-viewer-annotate"]').exists()).toBe(false)
      w.unmount()
    })

    it('点「圈选」⇒ 进入标注态（画布覆盖层出现 + 按钮文案变「取消」）', async () => {
      const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'https://x/a.png' } } })
      await w.get('[data-testid="mobile-viewer-annotate"]').trigger('click')
      expect(w.find('[data-testid="mobile-viewer-ink"]').isVisible()).toBe(true)
      expect(w.get('[data-testid="mobile-viewer-annotate"]').text()).toContain('取消')
      w.unmount()
    })

    it('标注态下画布覆盖层独占手势（touch-action: none ⇒ 单指不滚动/缩放）', () => {
      const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'https://x/a.png' } } })
      const src = readFileSync(join(HERE, 'MobileNodeViewer.vue'), 'utf-8')
      expect(src).toMatch(/\.viewer-ink\s*\{[^}]*touch-action:\s*none/)
      w.unmount()
    })
  })
})
