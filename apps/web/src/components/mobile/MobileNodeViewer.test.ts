import { describe, it, expect, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import MobileNodeViewer from './MobileNodeViewer.vue'
import { stripHtmlTags } from '@lnkpi/shared'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ vitest 是 ESM ⇒ `__dirname` 不可用（仓库既有约定：fileURLToPath(import.meta.url)）
const HERE = dirname(fileURLToPath(import.meta.url))

// 评审 I2：包装真实 useNodeWaveform，捕获每次调用的 opts —— 断言非音频类型的
// url getter 返回 undefined（不发起解码）。（jsdom 无 fetch，用 fetch spy 判据恒绿，弃用）
type WfOpts = Parameters<
  typeof import('@/composables/useNodeWaveform')['useNodeWaveform']
>[0]
const wfState = vi.hoisted(() => ({ lastOpts: null as import('@/composables/useNodeWaveform').UseNodeWaveformOptions | null }))
vi.mock('@/composables/useNodeWaveform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/useNodeWaveform')>()
  return {
    ...actual,
    useNodeWaveform: (opts: WfOpts) => {
      wfState.lastOpts = opts
      return actual.useNodeWaveform(opts)
    },
  }
})

/**
 * D2（2026-10-25 规格 §6.2 / §4.1 P3）：全屏查看器必须有**两条**退出通道
 * ——「右上 X」与「下滑关闭」，且**退出即停**（视频 pause）。
 *
 * ⚠️ 契约变更（D2）：左上 `‹` 文本字符（U+2039 细笔画，形态随字重不稳、
 *   识别失败）已删除，改为**右上角 X 的内联 SVG**（§4.11.5：禁文本字符当图标）。
 *   既有断言 `.viewer-back` 相应改写为 `.viewer-close`，**回归防护保留**。
 */

/** 派发 PointerEvent（jsdom 实例属性只读 ⇒ test-utils trigger 赋值会炸，须走构造器） */
async function firePointer(
  el: Element,
  type: string,
  o: { pointerId: number; clientX?: number; clientY?: number },
): Promise<void> {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...o }))
  await nextTick()
}

describe('MobileNodeViewer（退出通道 · D2）', () => {
  it('右上角有 X 按钮（44px 触控目标）并 emit close', async () => {
    const wrapper = mount(MobileNodeViewer, { global: { stubs: { teleport: true } },
      props: { type: 'image', data: { url: 'https://x/a.png' } },
    })
    const btn = wrapper.find('[data-testid="mobile-viewer-close"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('audio 分支存在（D2 修订 2026-10-27）：波形查看器而非死分支', () => {
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'x.png' } } })
    // 回归面：image 视图不得渲染 video/audio 元素
    expect(w.find('video').exists()).toBe(false)
    expect(w.find('audio').exists()).toBe(false)
    w.unmount()
  })

  it('audio: 渲染波形查看器（D2 修订 2026-10-27，走查④）——audio 元素 + 波形 + 播放 + 可拖进度', () => {
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'audio', data: { url: 'x.mp3' } } })
    expect(w.find('[data-testid="mobile-viewer-audio"]').exists()).toBe(true)
    expect(w.find('audio').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-viewer-audio-play"]').exists()).toBe(true)
    expect(w.find('input[type="range"]').exists()).toBe(true)
    expect(w.findComponent({ name: 'MobileNodeWaveform' }).exists()).toBe(true)
  })

  it('audio: 点播放 ⇒ audio.play 被调用（磁贴内联保留，查看器全屏控制）', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    try {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'audio', data: { url: 'x.mp3' } } })
      await w.get('[data-testid="mobile-viewer-audio-play"]').trigger('click')
      expect(play).toHaveBeenCalled()
    } finally {
      play.mockRestore()
    }
  })

  it('audio: 有圈选入口（底图 = 波形图，§4.3）', async () => {
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'audio', data: { url: 'x.mp3' } } })
    const btn = w.find('[data-testid="mobile-viewer-bottom-annotate"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(w.find('[data-testid="mobile-viewer-ink"]').isVisible()).toBe(true)
    w.unmount()
  })

  it('audio: 退出即停（close 前调用 pause，P3）', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    try {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'audio', data: { url: 'x.mp3' } } })
      await w.get('[data-testid="mobile-viewer-close"]').trigger('click')
      expect(pause).toHaveBeenCalled()
    } finally {
      pause.mockRestore()
    }
  })

  it('image: 全屏灯箱（根容器有 testid + 渲染 img）', () => {
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'x.png' } } })
    expect(w.find('[data-testid="mobile-viewer"]').exists()).toBe(true)
    expect(w.find('img').exists()).toBe(true)
  })

  it('text: 渲染阅读器内容', () => {
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'text', data: { content: '正文' } } })
    expect(w.text()).toContain('正文')
  })

  it('位移不足阈值 ⇒ 不 emit close', async () => {
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'x.png' } } })
    const root = w.get('[data-testid="mobile-viewer"]')
    await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
    await root.trigger('touchmove', { touches: [{ clientY: 200 }] })
    await root.trigger('touchend')
    expect(w.emitted('close')).toBeFalsy()
  })

  // ── 退出手势仲裁（走查③ + 回归⑤ · 规格 §6.2 退出表）─────────────────────
  // 走查③修了方向反转；回归⑤（真机二轮）实证：passive 监听挡不住浏览器下拉刷新
  // ⇒ 下拉关闭体感不可用 ⇒ 改**双向关闭**：媒体上滑任意位置可关（用户习惯）；
  // 长文/审核层仅滚到底后上滑才关（走查③「滚动途中永不关」不回退）。下拉保留。
  describe('退出手势仲裁（双向关闭 + 滚动守卫）', () => {
    it('媒体查看器上滑（clientY 减小）超阈值 ⇒ 关闭（回归⑤：无可滚动内容，任意位置可关）', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'x.png' } } })
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 300 }] })
      await root.trigger('touchmove', { touches: [{ clientY: 150 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toHaveLength(1)
    })

    it('真下拉（clientY 增加）超过阈值 ⇒ emit close', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'x.png' } } })
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
      await root.trigger('touchmove', { touches: [{ clientY: 300 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toHaveLength(1)
    })

    it('阅读器滚动途中（scrollTop>0）下拉不关闭（W-30 长文误关）', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'text', data: { content: '长文' } } })
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
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'text', data: { content: '短文' } } })
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
      await root.trigger('touchmove', { touches: [{ clientY: 300 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toHaveLength(1)
    })

    it('文本阅读器滚动途中（未到底）上滑 ⇒ 不关闭（走查③不回退）', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'text', data: { content: '长文' } } })
      const el = w.get('.viewer-reader').element as HTMLElement
      // jsdom 无布局 ⇒ 显式 stub 可滚动几何：3000 高视口 600，scrollTop 停在中段
      Object.defineProperty(el, 'scrollHeight', { value: 3000, configurable: true })
      Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
      el.scrollTop = 500
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 300 }] })
      await root.trigger('touchmove', { touches: [{ clientY: 150 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toBeFalsy()
    })

    it('文本阅读器滚到底（scrollHeight−scrollTop−clientHeight≤2）上滑 ⇒ 关闭（到底守卫放行）', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'text', data: { content: '长文' } } })
      const el = w.get('.viewer-reader').element as HTMLElement
      Object.defineProperty(el, 'scrollHeight', { value: 3000, configurable: true })
      Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
      el.scrollTop = 2400
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 300 }] })
      await root.trigger('touchmove', { touches: [{ clientY: 150 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toHaveLength(1)
    })

    it('音频查看器 audio 带 preload=metadata（回归③：否则 duration=0 进度条 max=0 死区）', () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'audio', data: { url: 'x.mp3' } } })
      expect(w.find('audio').attributes('preload')).toBe('metadata')
    })

    it('媒体区收进 .viewer-body；圈选在底栏（入口统一）、倍速在 body 内（绝对锚点=媒体区底）', () => {
      const img = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'x.png' } } })
      const body = img.find('.viewer-body')
      expect(body.exists()).toBe(true)
      expect(img.find('[data-testid="mobile-viewer-bottom-annotate"]').exists()).toBe(true)
      img.unmount()
      const vid = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'video', data: { url: 'x.mp4' } } })
      expect(vid.find('.viewer-body [data-testid="mobile-viewer-speed"]').exists()).toBe(true)
      vid.unmount()
    })

    it('底部主栏是 .viewer-body 的**兄弟**（文档流，非覆盖式 absolute）', () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } },
        props: {
          type: 'audio',
          data: { url: 'x.mp3' },
          bottomActions: [{ key: 'reword', label: '改词' }],
        },
      })
      const body = w.get('.viewer-body')
      const bar = w.get('.viewer-bottom-actions')
      // 兄弟关系：bar 不在 body 内部
      expect(body.find('.viewer-bottom-actions').exists()).toBe(false)
      expect(bar.element.parentElement).toBe(body.element.parentElement)
      // 音频控制条在 body 内 ⇒ 与主栏无重叠可能
      expect(body.find('.viewer-audio-controls').exists()).toBe(true)
    })

    it('容器 overscroll-behavior:none（回归⑤：压浏览器下拉刷新抢手势）', () => {
      const src = readFileSync(join(HERE, 'MobileNodeViewer.vue'), 'utf8')
      const rootRule = /\.mobile-node-viewer\s*\{([^}]*)\}/.exec(src)?.[1] ?? ''
      expect(rootRule).toMatch(/overscroll-behavior:\s*none/)
    })
  })

    it('标注态下手势不触发关闭（评审 C1：画圈 >100px 不得关掉查看器丢标注）', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'x.png' } } })
      await w.get('[data-testid="mobile-viewer-bottom-annotate"]').trigger('click')
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
      await root.trigger('touchmove', { touches: [{ clientY: 400 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toBeFalsy()
      w.unmount()
    })

    it('多点触控不误关（评审 I5：第二指落下/换指后 touches[0] 跳变不累计位移）', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'x.png' } } })
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
      // 双指捏合：touches.length=2 且 touches[0] 已换指（Y 跳到 400）
      await root.trigger('touchmove', { touches: [{ clientY: 400 }, { clientY: 200 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toBeFalsy()
      w.unmount()
    })

    it('音频控制条上的手势不触发关闭（评审 I6：拖进度条纵向漂移不误关）', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'audio', data: { url: 'x.mp3' } } })
      const controls = w.find('.viewer-audio-controls')
      expect(controls.exists()).toBe(true)
      await controls.trigger('touchstart', { touches: [{ clientY: 150 }] })
      await controls.trigger('touchmove', { touches: [{ clientY: 400 }] })
      await controls.trigger('touchend')
      expect(w.emitted('close')).toBeFalsy()
      w.unmount()
    })

    it('非音频类型不发起波形解码（评审 I2：url getter 对图片/视频返回 undefined）', async () => {
      const img = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'https://x/img.png' } } })
      expect(wfState.lastOpts, '查看器必须调用 useNodeWaveform').toBeTruthy()
      expect(wfState.lastOpts!.url()).toBeUndefined()
      img.unmount()
      const vid = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'video', data: { url: 'https://x/v.mp4' } } })
      expect(wfState.lastOpts!.url()).toBeUndefined()
      vid.unmount()
      const aud = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'audio', data: { url: 'https://x/a.mp3' } } })
      expect(wfState.lastOpts!.url()).toBe('https://x/a.mp3')
      aud.unmount()
    })

    it('静态契约：音频标注底图只认真实 peaks（评审 I1，占位波形必须降级）', () => {
      const src = readFileSync(join(HERE, 'MobileNodeViewer.vue'), 'utf-8')
      const scriptStart = src.indexOf("if (type === 'audio')")
      const scriptEnd = src.indexOf('// 图片：', scriptStart)
      const audioBranch = src.slice(scriptStart, scriptEnd)
      expect(audioBranch).toContain("waveSource.value !== 'real'")
    })

    it('静态契约：磁贴音频 preload=metadata（评审 I7，iOS 时长唯一来源）', () => {
      const tile = readFileSync(join(HERE, 'MobileNodeTile.vue'), 'utf-8')
      expect(tile).toMatch(/<audio[^>]*preload="metadata"/)
    })

  // ── 回归③④：底部互殴结构性修复 ─────────────────────────────────────────
  describe('底部布局结构（回归③④：viewer-body + 文档流主栏）', () => {
    it('媒体区收进 .viewer-body；圈选在底栏（入口统一）、倍速在 body 内（绝对锚点=媒体区底）', () => {
      const img = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'x.png' } } })
      const body = img.find('.viewer-body')
      expect(body.exists()).toBe(true)
      expect(img.find('[data-testid="mobile-viewer-bottom-annotate"]').exists()).toBe(true)
      img.unmount()
      const vid = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'video', data: { url: 'x.mp4' } } })
      expect(vid.find('.viewer-body [data-testid="mobile-viewer-speed"]').exists()).toBe(true)
      vid.unmount()
    })

    it('底部主栏是 .viewer-body 的**兄弟**（文档流，非覆盖式 absolute）', () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } },
        props: {
          type: 'audio',
          data: { url: 'x.mp3' },
          bottomActions: [{ key: 'reword', label: '改词' }],
        },
      })
      const body = w.get('.viewer-body')
      const bar = w.get('.viewer-bottom-actions')
      expect(body.find('.viewer-bottom-actions').exists()).toBe(false)
      expect(bar.element.parentElement).toBe(body.element.parentElement)
      expect(body.find('.viewer-audio-controls').exists()).toBe(true)
    })

    it('容器 overscroll-behavior:none（回归⑤：压浏览器下拉刷新抢手势）', () => {
      const src = readFileSync(join(HERE, 'MobileNodeViewer.vue'), 'utf8')
      const rootRule = /\.mobile-node-viewer\s*\{([^}]*)\}/.exec(src)?.[1] ?? ''
      expect(rootRule).toMatch(/overscroll-behavior:\s*none/)
    })
  })

  it('视频退出即停：close 前调用 pause()（P3「退出即停」）', async () => {
    // ⚠️ 用原型 spy 而非替换 ref —— 组件内部持有自己的 ref，
    // 从外部替换 exposed.videoRef 换不掉内部引用（第一次写错，红了才发现）。
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    try {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'video', data: { url: 'x.mp4' } } })
      await w.get('[data-testid="mobile-viewer-close"]').trigger('click')
      expect(pause).toHaveBeenCalled()
    } finally {
      pause.mockRestore()
    }
  })

  // ── 视频倍速（走查⑤ · W-32：原生进度条已有，倍速循环按钮补齐）──────────
  it('video: 倍速按钮存在，循环 1→1.5→2→0.5→1 且作用到 video.playbackRate', async () => {
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'video', data: { url: 'x.mp4' } } })
    const btn = w.find('[data-testid="mobile-viewer-speed"]')
    expect(btn.exists()).toBe(true)
    // ⭐ §13.2 Teleport **stub** 渲染下每次状态更新重建子树：点击时元素被赋 rate 后随即
    //    重建 ⇒ 新 video 元素回默认 1、旧按钮 wrapper 文本恒 '1x'（真机真实 Teleport 为
    //    原地 patch，无此伪象）。断言策略：首点击断 video 元素副作用（证明 @click→
    //    cycleVideoRate→el.playbackRate 接线），label 循环用 fresh find 断状态机。
    const speedBtn = () => w.find('[data-testid="mobile-viewer-speed"]')
    const video = w.find('video').element as HTMLVideoElement
    expect(speedBtn().text()).toBe('1x')
    await speedBtn().trigger('click')
    expect(video.playbackRate).toBe(1.5)
    expect(speedBtn().text()).toBe('1.5x')
    await speedBtn().trigger('click')
    expect(speedBtn().text()).toBe('2x')
    await speedBtn().trigger('click')
    expect(speedBtn().text()).toBe('0.5x')
    await speedBtn().trigger('click')
    expect(speedBtn().text()).toBe('1x')
  })

  it('video: 倍速按钮只出现在视频上（音频有自己的进度条，图片无播放）', () => {
    const img = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'x.png' } } })
    expect(img.find('[data-testid="mobile-viewer-speed"]').exists()).toBe(false)
    img.unmount()
    const aud = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'audio', data: { url: 'x.mp3' } } })
    expect(aud.find('[data-testid="mobile-viewer-speed"]').exists()).toBe(false)
    aud.unmount()
  })

  // ── 标注态（L1 · §4.3：只有一支笔）──────────────────────────────────
  describe('标注态（显式进入 + 轻点即画）', () => {
    it('有「圈选」入口（显式进入，⛔ 不做隐式双击手势）', () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'https://x/a.png' } } })
      expect(w.find('[data-testid="mobile-viewer-bottom-annotate"]').exists()).toBe(true)
      w.unmount()
    })

    it('文本节点不提供圈选入口（文本走文字引用，无底图）', () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'text', data: { content: '你好' } } })
      expect(w.find('[data-testid="mobile-viewer-bottom-annotate"]').exists()).toBe(false)
      w.unmount()
    })

    it('点「圈选」⇒ 进入标注态（画布覆盖层出现 + 按钮文案变「取消」）', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'https://x/a.png' } } })
      await w.get('[data-testid="mobile-viewer-bottom-annotate"]').trigger('click')
      expect(w.find('[data-testid="mobile-viewer-ink"]').isVisible()).toBe(true)
      expect(w.get('[data-testid="mobile-viewer-bottom-annotate"]').text()).toContain('取消')
      w.unmount()
    })

    it('入口统一（真机反馈①）：confirmed image 底栏 = [圈选][改词] 同工具栏，浮动圆钮退役', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } },
        props: { type: 'image', data: { url: 'x.png' }, bottomActions: [{ key: 'edit', label: '改词', variant: 'primary' as const }] },
      })
      expect(w.find('.viewer-annotate').exists()).toBe(false)
      const bar = w.get('.viewer-bottom-actions')
      const keys = bar.findAll('[data-testid]').map((b) => b.attributes('data-testid'))
      expect(keys).toEqual(['mobile-viewer-bottom-annotate', 'mobile-viewer-bottom-edit'])
      w.unmount()
    })

    it('标注聚焦模式（真机反馈③）：圈选态底栏收敛为唯一 [取消圈选]，改词退场', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } },
        props: { type: 'image', data: { url: 'x.png' }, bottomActions: [{ key: 'edit', label: '改词' }] },
      })
      await w.get('[data-testid="mobile-viewer-bottom-annotate"]').trigger('click')
      const keys = w.get('.viewer-bottom-actions').findAll('[data-testid]').map((b) => b.attributes('data-testid'))
      expect(keys).toEqual(['mobile-viewer-bottom-annotate'])
      expect(w.get('[data-testid="mobile-viewer-bottom-annotate"]').text()).toContain('取消圈选')
      // 再点 = 退出
      await w.get('[data-testid="mobile-viewer-bottom-annotate"]').trigger('click')
      expect(w.find('[data-testid="mobile-viewer-ink"]').isVisible()).toBe(false)
      w.unmount()
    })

    it('标注态下画布覆盖层独占手势（touch-action: none ⇒ 单指不滚动/缩放）', () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'https://x/a.png' } } })
      const src = readFileSync(join(HERE, 'MobileNodeViewer.vue'), 'utf-8')
      expect(src).toMatch(/\.viewer-ink\s*\{[^}]*touch-action:\s*none/)
      w.unmount()
    })
  })

  /**
   * pending 审核内容层（§4.8 修订，2026-10-26）：
   * propose_generation 产物确认后才生成 ⇒ pending 打开查看器时无 url。
   * 历史缺陷：空媒体区 + `--lnk-surface-canvas` ⇒ 满屏黑 + 只剩底部决策按钮
   * （R2-T2「空白全屏」在 pending 分支复活）。本组断言钉住修复。
   */
  describe('pending 审核内容层（§4.8 修订）', () => {
    it('pending + 无产物 → 渲染审核内容层（提示词全文 + 参数摘要），不渲染空媒体区', () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } },
        props: {
          type: 'image',
          data: {
            status: 'pending_confirm',
            prompt: '赛博朋克城市夜景，霓虹雨后反射，电影感构图，超长提示词……'.repeat(3),
            imageAspect: '16:9',
            imageResolution: '2K',
          },
        },
      })
      expect(w.find('[data-testid="mobile-viewer-review"]').exists()).toBe(true)
      expect(w.find('[data-testid="mobile-viewer-review-prompt"]').text()).toContain('霓虹雨后反射')
      expect(w.find('[data-testid="mobile-viewer-review-params"]').text()).toBe('16:9 · 2K')
      expect(w.find('img').exists()).toBe(false)
      expect(w.find('video').exists()).toBe(false)
      w.unmount()
    })

    it('pending + 无产物 → 不提供圈选（无产物底图，意见走文字通道 = 改词）', () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } },
        props: { type: 'image', data: { status: 'pending_confirm', prompt: '一段提示词' } },
      })
      expect(w.find('[data-testid="mobile-viewer-bottom-annotate"]').exists()).toBe(false)
      w.unmount()
    })

    it('pending + 有产物 → 正常渲染媒体，不出审核内容层（产物预览为主，§4.7）', () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } },
        props: { type: 'image', data: { status: 'pending_confirm', url: 'x.png', prompt: '一段提示词' } },
      })
      expect(w.find('[data-testid="mobile-viewer-review"]').exists()).toBe(false)
      expect(w.find('img').exists()).toBe(true)
      expect(w.find('[data-testid="mobile-viewer-bottom-annotate"]').exists()).toBe(true)
      w.unmount()
    })

    it('非 pending 节点不受审核层影响（confirmed 正常灯箱）', () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } },
        props: { type: 'image', data: { status: 'confirmed', url: 'x.png' } },
      })
      expect(w.find('[data-testid="mobile-viewer-review"]').exists()).toBe(false)
      expect(w.find('img').exists()).toBe(true)
      w.unmount()
    })
  })

  // ── §17 v2（M5 · 2026-10-27）：pending 审核层批注态 / 编辑态 ─────────────
  // 壳层 pending 底栏两键（批注/编辑）经 bottomActions 注入；viewer 内消化：
  // 批注=圈选→首笔即弹胶囊→⚓ 合成带回；编辑=就地 textarea 改字→保存上抛。
  describe('§17 v2 审核层：批注态（首笔即弹胶囊 → ⚓ 带回）', () => {
    const SHELL_TWO_KEYS = [
      { key: 'annotate', label: '批注', variant: 'primary' as const },
      { key: 'edit', label: '编辑' },
    ]
    const pendingProps = {
      type: 'image' as const,
      data: { status: 'pending_confirm', prompt: '赛博朋克城市夜景，霓虹雨后反射' },
      bottomActions: SHELL_TWO_KEYS,
    }

    it('底栏【批注】⇒ 进入批注态（review 层 is-annotating + 画笔层可见），不上抛 bottom-action', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: pendingProps })
      await w.get('[data-testid="mobile-viewer-bottom-annotate"]').trigger('click')
      expect(w.find('.viewer-review.is-annotating').exists()).toBe(true)
      expect(w.find('[data-testid="mobile-viewer-ink"]').isVisible()).toBe(true)
      expect(w.emitted('bottom-action')).toBeFalsy()
      w.unmount()
    })

    it('首笔落定 ⇒ 胶囊弹出（无「完成」步骤）；再点【批注】⇒ 退出并收胶囊（可放弃）', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: pendingProps })
      await w.get('[data-testid="mobile-viewer-bottom-annotate"]').trigger('click')
      const ink = w.get('[data-testid="mobile-viewer-ink"]')
      // 画笔已迁 useInkOverlay：Pointer Events 采集（touchstart → pointerdown）
      await firePointer(ink.element as Element, 'pointerdown', { pointerId: 1, clientX: 10, clientY: 10 })
      await firePointer(ink.element as Element, 'pointermove', { pointerId: 1, clientX: 40, clientY: 30 })
      await firePointer(ink.element as Element, 'pointerup', { pointerId: 1 })
      expect(w.find('[data-testid="mobile-annotation-capsule"]').exists()).toBe(true)
      await w.get('[data-testid="mobile-viewer-bottom-annotate"]').trigger('click')
      expect(w.find('[data-testid="mobile-annotation-capsule"]').exists()).toBe(false)
      expect(w.find('.viewer-review.is-annotating').exists()).toBe(false)
      w.unmount()
    })

    it('胶囊填意见 + 点 ⚓ ⇒ emit annotate（payload 带文字；jsdom 无 2d ⇒ 诚实降级路径）', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: pendingProps })
      await w.get('[data-testid="mobile-viewer-bottom-annotate"]').trigger('click')
      const ink = w.get('[data-testid="mobile-viewer-ink"]')
      await firePointer(ink.element as Element, 'pointerdown', { pointerId: 1, clientX: 10, clientY: 10 })
      await firePointer(ink.element as Element, 'pointerup', { pointerId: 1 })
      await w.get('[data-testid="mobile-annotation-capsule-input"]').setValue('配色太冷')
      await w.get('[data-testid="mobile-annotation-capsule-anchor"]').trigger('click')
      await vi.waitFor(() => expect(w.emitted('annotate')).toBeTruthy())
      const payload = w.emitted('annotate')![0]![0] as { text: string; degraded: boolean }
      expect(payload.text).toBe('配色太冷')
      expect(w.emitted('bottom-action')).toBeFalsy()
      w.unmount()
    })

    it('批注态锁滚动：.viewer-review.is-annotating ⇒ touch-action:none（V-17a）', () => {
      const src = readFileSync(join(HERE, 'MobileNodeViewer.vue'), 'utf-8')
      const rule = /\.viewer-review\.is-annotating\s*\{([^}]*)\}/.exec(src)?.[1] ?? ''
      expect(rule).toMatch(/touch-action:\s*none/)
    })
  })

  describe('§17 v2 审核层：编辑态（就地改字，拍板②）', () => {
    const pendingProps = {
      type: 'image' as const,
      data: { status: 'pending_confirm', prompt: '赛博朋克城市夜景' },
      bottomActions: [
        { key: 'annotate', label: '批注', variant: 'primary' as const },
        { key: 'edit', label: '编辑' },
      ],
    }

    it('底栏【编辑】⇒ 提示词就地换 textarea 且预填 prompt，不上抛 bottom-action', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: pendingProps })
      await w.get('[data-testid="mobile-viewer-bottom-edit"]').trigger('click')
      const ta = w.get('[data-testid="mobile-viewer-review-edit"]')
      expect((ta.element as HTMLTextAreaElement).value).toBe('赛博朋克城市夜景')
      expect(w.find('[data-testid="mobile-viewer-review-prompt"]').exists()).toBe(false)
      expect(w.emitted('bottom-action')).toBeFalsy()
      w.unmount()
    })

    it('编辑态底栏 = 取消/保存；保存 ⇒ emit edit-save（新文本），不上抛 bottom-action', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: pendingProps })
      await w.get('[data-testid="mobile-viewer-bottom-edit"]').trigger('click')
      expect(w.find('[data-testid="mobile-viewer-bottom-edit-cancel"]').exists()).toBe(true)
      expect(w.find('[data-testid="mobile-viewer-bottom-edit-save"]').exists()).toBe(true)
      await w.get('[data-testid="mobile-viewer-review-edit"]').setValue('改后的词')
      await w.get('[data-testid="mobile-viewer-bottom-edit-save"]').trigger('click')
      expect(w.emitted('edit-save')).toEqual([['改后的词']])
      expect(w.emitted('bottom-action')).toBeFalsy()
      w.unmount()
    })

    it('编辑态取消 ⇒ 退出编辑态，不 emit edit-save', async () => {
      const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: pendingProps })
      await w.get('[data-testid="mobile-viewer-bottom-edit"]').trigger('click')
      await w.get('[data-testid="mobile-viewer-bottom-edit-cancel"]').trigger('click')
      expect(w.emitted('edit-save')).toBeFalsy()
      expect(w.find('[data-testid="mobile-viewer-review-edit"]').exists()).toBe(false)
      w.unmount()
    })
  })
})

// ── W-5：图片双指缩放（拍板 I1 隐含底线，2026-10-27 S2 批次）──────────────────
describe('图片双指缩放（W-5）', () => {
  function mountImage() {
    return mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'image', data: { url: 'x.png' } } })
  }
  const imgStyle = (w: ReturnType<typeof mount>) =>
    w.find('img.viewer-media').attributes('style') ?? ''

  it('双指捏合放大：距离 ×2 ⇒ scale(2)', async () => {
    const w = mountImage()
    const root = w.get('[data-testid="mobile-viewer"]')
    await root.trigger('touchstart', {
      touches: [
        { clientX: 150, clientY: 300 },
        { clientX: 250, clientY: 300 },
      ],
    })
    await root.trigger('touchmove', {
      touches: [
        { clientX: 100, clientY: 300 },
        { clientX: 300, clientY: 300 },
      ],
    })
    expect(imgStyle(w)).toContain('scale(2)')
    w.unmount()
  })

  it('上限 4x：距离拉大 10 倍 ⇒ scale 封顶 scale(4)', async () => {
    const w = mountImage()
    const root = w.get('[data-testid="mobile-viewer"]')
    await root.trigger('touchstart', {
      touches: [
        { clientX: 150, clientY: 300 },
        { clientX: 250, clientY: 300 },
      ],
    })
    await root.trigger('touchmove', {
      touches: [
        { clientX: -350, clientY: 300 },
        { clientX: 650, clientY: 300 },
      ],
    })
    expect(imgStyle(w)).toContain('scale(4)')
    expect(imgStyle(w)).not.toContain('scale(4.0')
    w.unmount()
  })

  it('缩回 1x：位移复位（translate(0px, 0px)），不低于 1', async () => {
    const w = mountImage()
    const root = w.get('[data-testid="mobile-viewer"]')
    await root.trigger('touchstart', {
      touches: [
        { clientX: 150, clientY: 300 },
        { clientX: 250, clientY: 300 },
      ],
    })
    await root.trigger('touchmove', {
      touches: [
        { clientX: 100, clientY: 300 },
        { clientX: 300, clientY: 300 },
      ],
    })
    // 缩回
    await root.trigger('touchmove', {
      touches: [
        { clientX: 190, clientY: 300 },
        { clientX: 210, clientY: 300 },
      ],
    })
    expect(imgStyle(w)).toContain('scale(1)')
    expect(imgStyle(w)).toContain('translate(0px, 0px)')
    w.unmount()
  })

  it('放大态单指 = 平移（translate 变化），松手不关闭', async () => {
    const w = mountImage()
    const root = w.get('[data-testid="mobile-viewer"]')
    // jsdom 无布局 ⇒ img.clientWidth 恒为 0（getter 返回 0 而非 undefined，`?? 320` 不兜底）
    // ⇒ clampPan 把平移夹到 ±0 ⇒ translate 恒 (0px, 0px)。stub 出实例尺寸让 clampPan 生效。
    const imgEl = w.find('img.viewer-media').element as HTMLImageElement
    Object.defineProperty(imgEl, 'clientWidth', { value: 320, configurable: true })
    Object.defineProperty(imgEl, 'clientHeight', { value: 480, configurable: true })
    // 放大到 2x
    await root.trigger('touchstart', {
      touches: [
        { clientX: 150, clientY: 300 },
        { clientX: 250, clientY: 300 },
      ],
    })
    await root.trigger('touchmove', {
      touches: [
        { clientX: 100, clientY: 300 },
        { clientX: 300, clientY: 300 },
      ],
    })
    // 单指平移。⭐ 捏合阶段后 img DOM 节点被重建（同倍速钮，§13.2 Teleport stub 渲染），
    //    旧节点上的 clientWidth/Height stub 随之失效 ⇒ 须对新节点重打 stub
    const imgEl2 = w.find('img.viewer-media').element as HTMLImageElement
    Object.defineProperty(imgEl2, 'clientWidth', { value: 320, configurable: true })
    Object.defineProperty(imgEl2, 'clientHeight', { value: 480, configurable: true })
    await root.trigger('touchstart', { touches: [{ clientX: 200, clientY: 400 }] })
    await root.trigger('touchmove', { touches: [{ clientX: 120, clientY: 360 }] })
    const style = imgStyle(w)
    expect(style).toContain('translate(')
    expect(style).not.toContain('translate(0px, 0px)')
    await root.trigger('touchend')
    expect(w.emitted('close')).toBeFalsy()
    w.unmount()
  })

  it('放大态上滑不关闭（回归⑤不回退：缩放手势与关闭互斥）', async () => {
    const w = mountImage()
    const root = w.get('[data-testid="mobile-viewer"]')
    await root.trigger('touchstart', {
      touches: [
        { clientX: 150, clientY: 300 },
        { clientX: 250, clientY: 300 },
      ],
    })
    await root.trigger('touchmove', {
      touches: [
        { clientX: 100, clientY: 300 },
        { clientX: 300, clientY: 300 },
      ],
    })
    // 上滑 200px（未缩放时任意位可关）
    await root.trigger('touchstart', { touches: [{ clientX: 200, clientY: 400 }] })
    await root.trigger('touchmove', { touches: [{ clientX: 200, clientY: 150 }] })
    await root.trigger('touchend')
    expect(w.emitted('close')).toBeFalsy()
    w.unmount()
  })

  it('捏合后松手（touchend）不触发关闭', async () => {
    const w = mountImage()
    const root = w.get('[data-testid="mobile-viewer"]')
    await root.trigger('touchstart', {
      touches: [
        { clientX: 150, clientY: 300 },
        { clientX: 250, clientY: 300 },
      ],
    })
    await root.trigger('touchmove', {
      touches: [
        { clientX: 100, clientY: 300 },
        { clientX: 300, clientY: 300 },
      ],
    })
    await root.trigger('touchend')
    expect(w.emitted('close')).toBeFalsy()
    w.unmount()
  })

  it('非图片类型不受影响：视频上滑仍可关（媒体关闭惯例）', async () => {
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'video', data: { url: 'v.mp4' } } })
    const root = w.get('[data-testid="mobile-viewer"]')
    await root.trigger('touchstart', { touches: [{ clientY: 300 }] })
    await root.trigger('touchmove', { touches: [{ clientY: 100 }] })
    await root.trigger('touchend')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })
})

// ── S5（Task 7）：MobileNodeViewer text·html 分支 + TTS strip 朗读源 ─────────
// format:'html' ⇒ embedded HtmlNodePreview（沙箱 iframe，无第二关闭钮/浮层）；
// 无 format ⇒ 既有 viewer-reader 纯文本路径不变（G3）；html 节点 TTS 朗读
// strip 后纯文本（规格 §8 同源），strip 为空则不出朗读钮。
describe('MobileNodeViewer text·html 分支（规格 S5）', () => {
  // data prop 类型未声明 format（透传字段）⇒ 变量绕开对象字面量 excess check
  const htmlData = (content: string) =>
    ({ content, format: 'html' }) as { content?: string; format?: string }

  it("format:'html' ⇒ 渲染沙箱 iframe（sandbox 无 allow-same-origin）", () => {
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'text', data: htmlData('<h1>x</h1>') } })
    const iframe = w.find('iframe')
    expect(iframe.exists()).toBe(true)
    expect(iframe.attributes('sandbox')).not.toContain('allow-same-origin')
    w.unmount()
  })

  it('html 分支是 embedded 预览面：无第二关闭钮 / 无浮层（退出契约归 viewer）', () => {
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'text', data: htmlData('<h1>x</h1>') } })
    expect(w.find('[data-testid="html-close"]').exists()).toBe(false)
    expect(w.find('.html-preview-overlay').exists()).toBe(false)
    // viewer 自己的 X 与下滑退出契约不动
    expect(w.find('[data-testid="mobile-viewer-close"]').exists()).toBe(true)
    w.unmount()
  })

  it('无 format ⇒ 既有 viewer-reader 纯文本（G3：路径不变）', () => {
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'text', data: { content: '纯文本' } } })
    expect(w.find('iframe').exists()).toBe(false)
    expect(w.find('.viewer-reader').exists()).toBe(true)
    w.unmount()
  })

  it('html 节点 TTS 朗读源 = strip-tags 纯文本（非 raw html）', async () => {
    // 补齐浏览器语音合成 API 面（镜像 MobileNodeTile.tts.test.ts 的 stubSpeech）
    ;(window as any).SpeechSynthesisUtterance = class {
      text: string
      constructor(text: string) {
        this.text = text
      }
    }
    const speak = vi.fn()
    ;(window as any).speechSynthesis = {
      speak,
      cancel: vi.fn(),
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    const content = '<h1>你好</h1><p>世界</p>'
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'text', data: htmlData(content) } })
    await w.get('[data-testid="mobile-viewer-bottom-tts"]').trigger('click')
    expect(speak).toHaveBeenCalledTimes(1)
    const spoken = (speak.mock.calls[0]![0] as { text: string }).text
    expect(spoken).toBe(stripHtmlTags(content))
    expect(spoken).not.toContain('<h1>')
    w.unmount()
  })

  it('html 节点 strip 后为空 ⇒ 不出朗读钮（hasText 判据用 strip 后文本）', () => {
    const w = mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props: { type: 'text', data: htmlData('<script>x</script>') } })
    expect(w.find('[data-testid="mobile-viewer-bottom-tts"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('长按唤起同源 Menu（v1.5 O / G-19）', () => {
  type ViewerProps = InstanceType<typeof MobileNodeViewer>['$props']
  function mountViewer(props: ViewerProps) {
    return mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props })
  }

  it('模板不再有「⋯」按钮', () => {
    const w = mountViewer({ type: 'image', data: { url: 'x.png' } })
    expect(w.find('[data-testid="mobile-viewer-more"]').exists()).toBe(false)
    w.unmount()
  })

  it('长按媒体 500ms ⇒ emit more 且视频轻暂停', async () => {
    vi.useFakeTimers()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    try {
      const w = mountViewer({ type: 'video', data: { url: 'x.mp4' } })
      // jsdom 视频 paused 恒 true ⇒ 伪造「在播」态（fireLongPress 只暂停在播媒体）
      const video = w.find('video').element as HTMLVideoElement
      Object.defineProperty(video, 'paused', { get: () => false, configurable: true })
      await w.find('[data-testid="mobile-viewer-body"]').trigger('touchstart', { touches: [{ clientX: 10, clientY: 10 }] })
      await vi.advanceTimersByTimeAsync(500)
      expect(w.emitted('more')).toHaveLength(1)
      expect(pause).toHaveBeenCalled()
    } finally {
      pause.mockRestore()
      vi.useRealTimers()
    }
  })

  it('位移超 10px 取消长按；touchend 也取消', async () => {
    vi.useFakeTimers()
    try {
      const w = mountViewer({ type: 'image', data: { url: 'x.png' } })
      const body = w.find('[data-testid="mobile-viewer-body"]')
      await body.trigger('touchstart', { touches: [{ clientX: 10, clientY: 10 }] })
      await body.trigger('touchmove', { touches: [{ clientX: 60, clientY: 10 }] })
      await vi.advanceTimersByTimeAsync(600)
      expect(w.emitted('more')).toBeUndefined()
      // touchend 后再按满 500ms 也不弹（上一个手势已被 move 取消，此处验证 end 不重挂计时器）
      await body.trigger('touchstart', { touches: [{ clientX: 10, clientY: 10 }] })
      await body.trigger('touchend', { touches: [] })
      await vi.advanceTimersByTimeAsync(600)
      expect(w.emitted('more')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('文本类型长按不弹 Menu（长按保留给拖选）', async () => {
    vi.useFakeTimers()
    try {
      const w = mountViewer({ type: 'text', data: { content: '长文'.repeat(80) } })
      await w.find('[data-testid="mobile-viewer-body"]').trigger('touchstart', { touches: [{ clientX: 1, clientY: 1 }] })
      await vi.advanceTimersByTimeAsync(500)
      expect(w.emitted('more')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('menuOpen false→true→false：此前在播 ⇒ 恢复播放', async () => {
    vi.useFakeTimers()
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    try {
      const w = mountViewer({ type: 'video', data: { url: 'x.mp4' } })
      const video = w.find('video').element as HTMLVideoElement
      Object.defineProperty(video, 'paused', { get: () => false, configurable: true })
      await w.find('[data-testid="mobile-viewer-body"]').trigger('touchstart', { touches: [{ clientX: 10, clientY: 10 }] })
      await vi.advanceTimersByTimeAsync(500)
      expect(w.emitted('more')).toHaveLength(1)
      await w.setProps({ menuOpen: true })
      await w.setProps({ menuOpen: false })
      expect(play).toHaveBeenCalled()
    } finally {
      play.mockRestore()
      pause.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('chrome 显隐（v1.5 P / G-20）', () => {
  type ViewerProps = InstanceType<typeof MobileNodeViewer>['$props']
  function mountViewer(props: ViewerProps) {
    return mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props })
  }

  it('点按媒体 ⇒ 根元素带 chrome-hidden；再点恢复', async () => {
    const w = mountViewer({ type: 'image', data: { url: 'x.png' } })
    const body = w.find('[data-testid="mobile-viewer-body"]')
    expect(w.find('.mobile-node-viewer').classes()).not.toContain('chrome-hidden')
    await body.trigger('touchstart', { touches: [{ clientX: 5, clientY: 5 }] })
    await body.trigger('touchend', { touches: [] })
    expect(w.find('.mobile-node-viewer').classes()).toContain('chrome-hidden')
    await body.trigger('touchstart', { touches: [{ clientX: 5, clientY: 5 }] })
    await body.trigger('touchend', { touches: [] })
    expect(w.find('.mobile-node-viewer').classes()).not.toContain('chrome-hidden')
    w.unmount()
  })

  it('长按触发后本次触控不切换 chrome（suppress）', async () => {
    vi.useFakeTimers()
    try {
      const w = mountViewer({ type: 'image', data: { url: 'x.png' } })
      const body = w.find('[data-testid="mobile-viewer-body"]')
      await body.trigger('touchstart', { touches: [{ clientX: 5, clientY: 5 }] })
      await vi.advanceTimersByTimeAsync(500)
      expect(w.emitted('more')).toHaveLength(1)
      expect(w.find('.mobile-node-viewer').classes()).not.toContain('chrome-hidden')
      await body.trigger('touchend', { touches: [] })
      expect(w.find('.mobile-node-viewer').classes()).not.toContain('chrome-hidden')
    } finally {
      vi.useRealTimers()
    }
  })

  it('chrome 隐藏态下滑关闭恒可用（P3 不依赖 chrome）', async () => {
    const w = mountViewer({ type: 'image', data: { url: 'x.png' } })
    const root = w.find('.mobile-node-viewer')
    // 先点按隐藏 chrome
    const body = w.find('[data-testid="mobile-viewer-body"]')
    await body.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] })
    await body.trigger('touchend', { touches: [] })
    expect(w.find('.mobile-node-viewer').classes()).toContain('chrome-hidden')
    // 下滑关闭手势在根容器，不受 chrome 影响
    await root.trigger('touchstart', { touches: [{ clientX: 100, clientY: 100 }] })
    await root.trigger('touchmove', { touches: [{ clientX: 100, clientY: 260 }] })
    await root.trigger('touchend', { touches: [] })
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('pending 批注/编辑同迷你条几何（无独立决策栏，§17 v2 对账）', () => {
    // 壳层（MobileCanvasShell.viewerBottomActions）为 pending 注入 [批注][编辑]
    const w = mountViewer({
      type: 'image',
      data: { status: 'pending_confirm', prompt: 'p' },
      bottomActions: [
        { key: 'annotate', label: '批注', variant: 'primary' },
        { key: 'edit', label: '编辑' },
      ],
    })
    expect(w.find('[data-testid="mobile-viewer-bottom-annotate"]').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-viewer-bottom-edit"]').exists()).toBe(true)
    expect(w.find('[data-testid="mobile-viewer-chrome-bar"]').exists()).toBe(true)
    w.unmount()
  })
})

describe('提示词摘要条退役（v1.5 P / G-21）', () => {
  type ViewerProps = InstanceType<typeof MobileNodeViewer>['$props']
  function mountViewer(props: ViewerProps) {
    return mount(MobileNodeViewer, { global: { stubs: { teleport: true } }, props })
  }

  it('查看器不渲染提示词摘要条（G-21：chrome 三态一屏一主角）', () => {
    const w = mountViewer({ type: 'image', data: { url: 'a.png', prompt: '一只猫'.repeat(30), status: 'confirmed' } })
    expect(w.find('[data-testid="mobile-viewer-prompt-strip"]').exists()).toBe(false)
    expect(w.text()).not.toContain('提示词：')
    w.unmount()
  })

  it('pending 审核内容层保留（决策需要全文，非 G-21 管辖）', () => {
    const w = mountViewer({ type: 'image', data: { status: 'pending_confirm', prompt: '一只猫' } })
    expect(w.find('[data-testid="mobile-viewer-review"]').exists()).toBe(true)
    w.unmount()
  })
})
