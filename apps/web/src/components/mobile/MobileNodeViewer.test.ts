import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileNodeViewer from './MobileNodeViewer.vue'
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

  it('audio 分支存在（D2 修订 2026-10-27）：波形查看器而非死分支', () => {
    const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
    // 回归面：image 视图不得渲染 video/audio 元素
    expect(w.find('video').exists()).toBe(false)
    expect(w.find('audio').exists()).toBe(false)
    w.unmount()
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

  // ── 退出手势仲裁（走查③ + 回归⑤ · 规格 §6.2 退出表）─────────────────────
  // 走查③修了方向反转；回归⑤（真机二轮）实证：passive 监听挡不住浏览器下拉刷新
  // ⇒ 下拉关闭体感不可用 ⇒ 改**双向关闭**：媒体上滑任意位置可关（用户习惯）；
  // 长文/审核层仅滚到底后上滑才关（走查③「滚动途中永不关」不回退）。下拉保留。
  describe('退出手势仲裁（双向关闭 + 滚动守卫）', () => {
    it('媒体查看器上滑（clientY 减小）超阈值 ⇒ 关闭（回归⑤：无可滚动内容，任意位置可关）', async () => {
      const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 300 }] })
      await root.trigger('touchmove', { touches: [{ clientY: 150 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toHaveLength(1)
    })

    it('真下拉（clientY 增加）超过阈值 ⇒ emit close', async () => {
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

    it('文本阅读器滚动途中（未到底）上滑 ⇒ 不关闭（走查③不回退）', async () => {
      const w = mount(MobileNodeViewer, { props: { type: 'text', data: { content: '长文' } } })
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
      const w = mount(MobileNodeViewer, { props: { type: 'text', data: { content: '长文' } } })
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
      const w = mount(MobileNodeViewer, { props: { type: 'audio', data: { url: 'x.mp3' } } })
      expect(w.find('audio').attributes('preload')).toBe('metadata')
    })

    it('媒体区收进 .viewer-body；圈选 / 倍速在 body 内（绝对锚点=媒体区底，不再被主栏盖）', () => {
      const img = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
      const body = img.find('.viewer-body')
      expect(body.exists()).toBe(true)
      expect(body.find('[data-testid="mobile-viewer-annotate"]').exists()).toBe(true)
      img.unmount()
      const vid = mount(MobileNodeViewer, { props: { type: 'video', data: { url: 'x.mp4' } } })
      expect(vid.find('.viewer-body [data-testid="mobile-viewer-speed"]').exists()).toBe(true)
      vid.unmount()
    })

    it('底部主栏是 .viewer-body 的**兄弟**（文档流，非覆盖式 absolute）', () => {
      const w = mount(MobileNodeViewer, {
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
      const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
      await w.get('[data-testid="mobile-viewer-annotate"]').trigger('click')
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
      await root.trigger('touchmove', { touches: [{ clientY: 400 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toBeFalsy()
      w.unmount()
    })

    it('多点触控不误关（评审 I5：第二指落下/换指后 touches[0] 跳变不累计位移）', async () => {
      const w = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
      const root = w.get('[data-testid="mobile-viewer"]')
      await root.trigger('touchstart', { touches: [{ clientY: 150 }] })
      // 双指捏合：touches.length=2 且 touches[0] 已换指（Y 跳到 400）
      await root.trigger('touchmove', { touches: [{ clientY: 400 }, { clientY: 200 }] })
      await root.trigger('touchend')
      expect(w.emitted('close')).toBeFalsy()
      w.unmount()
    })

    it('音频控制条上的手势不触发关闭（评审 I6：拖进度条纵向漂移不误关）', async () => {
      const w = mount(MobileNodeViewer, { props: { type: 'audio', data: { url: 'x.mp3' } } })
      const controls = w.find('.viewer-audio-controls')
      expect(controls.exists()).toBe(true)
      await controls.trigger('touchstart', { touches: [{ clientY: 150 }] })
      await controls.trigger('touchmove', { touches: [{ clientY: 400 }] })
      await controls.trigger('touchend')
      expect(w.emitted('close')).toBeFalsy()
      w.unmount()
    })

    it('非音频类型不发起波形解码（评审 I2：url getter 对图片/视频返回 undefined）', async () => {
      const img = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'https://x/img.png' } } })
      expect(wfState.lastOpts, '查看器必须调用 useNodeWaveform').toBeTruthy()
      expect(wfState.lastOpts!.url()).toBeUndefined()
      img.unmount()
      const vid = mount(MobileNodeViewer, { props: { type: 'video', data: { url: 'https://x/v.mp4' } } })
      expect(wfState.lastOpts!.url()).toBeUndefined()
      vid.unmount()
      const aud = mount(MobileNodeViewer, { props: { type: 'audio', data: { url: 'https://x/a.mp3' } } })
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
    it('媒体区收进 .viewer-body；圈选 / 倍速在 body 内（绝对锚点=媒体区底，不再被主栏盖）', () => {
      const img = mount(MobileNodeViewer, { props: { type: 'image', data: { url: 'x.png' } } })
      const body = img.find('.viewer-body')
      expect(body.exists()).toBe(true)
      expect(body.find('[data-testid="mobile-viewer-annotate"]').exists()).toBe(true)
      img.unmount()
      const vid = mount(MobileNodeViewer, { props: { type: 'video', data: { url: 'x.mp4' } } })
      expect(vid.find('.viewer-body [data-testid="mobile-viewer-speed"]').exists()).toBe(true)
      vid.unmount()
    })

    it('底部主栏是 .viewer-body 的**兄弟**（文档流，非覆盖式 absolute）', () => {
      const w = mount(MobileNodeViewer, {
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

  /**
   * pending 审核内容层（§4.8 修订，2026-10-26）：
   * propose_generation 产物确认后才生成 ⇒ pending 打开查看器时无 url。
   * 历史缺陷：空媒体区 + `--lnk-surface-canvas` ⇒ 满屏黑 + 只剩底部决策按钮
   * （R2-T2「空白全屏」在 pending 分支复活）。本组断言钉住修复。
   */
  describe('pending 审核内容层（§4.8 修订）', () => {
    it('pending + 无产物 → 渲染审核内容层（提示词全文 + 参数摘要），不渲染空媒体区', () => {
      const w = mount(MobileNodeViewer, {
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
      const w = mount(MobileNodeViewer, {
        props: { type: 'image', data: { status: 'pending_confirm', prompt: '一段提示词' } },
      })
      expect(w.find('[data-testid="mobile-viewer-annotate"]').exists()).toBe(false)
      w.unmount()
    })

    it('pending + 有产物 → 正常渲染媒体，不出审核内容层（产物预览为主，§4.7）', () => {
      const w = mount(MobileNodeViewer, {
        props: { type: 'image', data: { status: 'pending_confirm', url: 'x.png', prompt: '一段提示词' } },
      })
      expect(w.find('[data-testid="mobile-viewer-review"]').exists()).toBe(false)
      expect(w.find('img').exists()).toBe(true)
      expect(w.find('[data-testid="mobile-viewer-annotate"]').exists()).toBe(true)
      w.unmount()
    })

    it('非 pending 节点不受审核层影响（confirmed 正常灯箱）', () => {
      const w = mount(MobileNodeViewer, {
        props: { type: 'image', data: { status: 'confirmed', url: 'x.png' } },
      })
      expect(w.find('[data-testid="mobile-viewer-review"]').exists()).toBe(false)
      expect(w.find('img').exists()).toBe(true)
      w.unmount()
    })
  })
})
