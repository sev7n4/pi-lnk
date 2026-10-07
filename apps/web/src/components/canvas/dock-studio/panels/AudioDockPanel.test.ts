import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { encodeChannelModel } from '@lnkpi/shared'
import { audioKindOfModelValue } from '@/constants/dockAudio'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'
import AudioDockPanel from './AudioDockPanel.vue'

const TTS = encodeChannelModel('platform', 'minimax-speech-2.8-hd')
const MUSIC = encodeChannelModel('platform', 'stepaudio-3-music-preview')

/** 每个用例可改写；`setSelectableAudioModels` 在用例内替换用户自定义的可选模型列表。 */
let selectableAudioModels: string[] = [TTS, MUSIC]
/**
 * `true` ⇒ 模拟 bootstrap 未就绪 / 加载失败（`preferences` 为 `null`）。
 * 这与「已知但列表为空」是**两种不同语义**，面板必须区别对待。
 */
let prefsUnknown = false

vi.mock('@/composables/useProviderBootstrap', () => ({
  useProviderBootstrap: () => ({
    // `allChannels` 也是 `UniversalModelSelector` 的依赖（全量 mount 时是真组件渲染）
    allChannels: ref([{ id: 'platform', name: '平台' }, { id: 'ch1', name: 'BYOK' }]),
    preferences: ref(
      prefsUnknown
        ? null
        : {
            selectableAudioModels,
            defaultAudioModel: selectableAudioModels[0] ?? TTS,
          },
    ),
  }),
}))

vi.mock('@/composables/useModelProviderSettings', () => ({
  useModelProviderSettings: () => ({
    getConfig: () => ({ apiKey: '', baseUrl: '', model: selectableAudioModels[0] ?? TTS }),
  }),
}))

vi.mock('@/composables/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    listening: ref(false),
    start: vi.fn(),
    stop: vi.fn(),
  }),
}))

vi.mock('@/components/canvas/dock-studio/shared/useDockLocalImageUpload', () => ({
  useDockLocalImageUpload: () => ({
    inputRef: ref(null),
    uploading: ref(false),
    uploadError: ref(''),
    pick: vi.fn(),
    onFileChange: vi.fn(),
  }),
}))

function createNode(data: Record<string, unknown> = {}): EditableFlowNode {
  return { id: 'audio-1', type: 'audio', position: { x: 0, y: 0 }, data }
}

function mountPanel(node: EditableFlowNode, refs: unknown[] = []) {
  // 不能用 shallowMount：它会把 `DockToolbarShell` 打成 stub，整个子树（含 chip 行与
  // 生成按钮）都不渲染 ⇒ 断言对象都不存在。子组件都无副作用，直接全量 mount。
  return mount(AudioDockPanel, {
    props: {
      node,
      upstream: {} as never,
      refs: refs as never,
    },
  })
}

/** 累计所有 `patch` 发射的内容（面板切分类/生成时都是增量 patch）。 */
function allPatches(wrapper: ReturnType<typeof mountPanel>) {
  const patches: Record<string, unknown>[] = []
  for (const call of wrapper.emitted('patch') ?? []) patches.push(call[0] as Record<string, unknown>)
  return patches
}

function generateButtonDisabled(wrapper: ReturnType<typeof mountPanel>): boolean {
  const btn = wrapper.findComponent({ name: 'DockGenerateButton' })
  return btn.props('disabled') === true
}

async function clickKindChip(wrapper: ReturnType<typeof mountPanel>, label: string) {
  const chip = wrapper.findAll('button').find((b) => b.text() === label)
  expect(chip, `找不到 chip「${label}」`).toBeTruthy()
  await chip!.trigger('click')
}

describe('AudioDockPanel 切分类时的模型选择（R17）', () => {
  it('切到音乐时把 audioModel 换成用户可选列表里的音乐模型', async () => {
    const wrapper = mountPanel(createNode({ audioModel: TTS }))
    await clickKindChip(wrapper, '音乐')

    const patches = allPatches(wrapper)
    expect(patches.at(-1)).toMatchObject({ audioKind: 'music', audioModel: MUSIC })
  })

  it('该分类模型被用户停用时切分类，但不改写 audioModel', async () => {
    // 用户把音乐模型移出了音频可选桶（`provider.service.ts` 允许持久化任意数组）
    selectableAudioModels = [TTS]
    const wrapper = mountPanel(createNode({ audioModel: TTS }))
    await clickKindChip(wrapper, '音乐')

    const patches = allPatches(wrapper)
    // kind 仍然切换
    expect(patches.at(-1)).toMatchObject({ audioKind: 'music' })
    // 但绝不把 audioModel 指向用户已停用的模型
    expect(patches.some((p) => 'audioModel' in p && p.audioModel === MUSIC)).toBe(false)
    selectableAudioModels = [TTS, MUSIC]
  })

  it('可选列表里该分类一个都没有时，patch 里完全不带 audioModel', async () => {
    selectableAudioModels = []
    const wrapper = mountPanel(createNode({ audioModel: TTS }))
    await clickKindChip(wrapper, '音乐')

    const last = allPatches(wrapper).at(-1)
    expect(last).toEqual({ audioKind: 'music' })
    selectableAudioModels = [TTS, MUSIC]
  })

  /**
   * 🔴 上一轮修复引入的回归：prefs 未就绪（`preferences === null`）时若也走
   * 「交集为空 ⇒ 不改写」，`audioModel` 会留在**原分类**（TTS），而 kind 已切成 music
   * ⇒ 提交必撞服务端 `assertAudioKindMatchesModel` 400。`CanvasPage` 明确吞掉
   * bootstrap 失败并指望「Dock falls back to catalog defaults」，那条 fallback
   * 在本路径上不能被打破。
   */
  it('prefs 未就绪（null）时切分类 ⇒ 用目录默认，kind 与模型自洽（不会撞 400）', async () => {
    prefsUnknown = true
    const wrapper = mountPanel(createNode({ audioModel: TTS }))
    await clickKindChip(wrapper, '音乐')

    const last = allPatches(wrapper).at(-1)
    expect(last).toMatchObject({ audioKind: 'music' })
    // 必须带 audioModel，且它属于 music 分类（不是留在原分类的 TTS）
    expect(last).toHaveProperty('audioModel')
    expect(audioKindOfModelValue(last!.audioModel as string)).toBe('music')
    prefsUnknown = false
  })

  it('prefs 未就绪时对每个分类都自洽（voice / design / music 逐个验）', async () => {
    prefsUnknown = true
    for (const [label, kind] of [
      ['配音', 'voice'],
      ['综合音频', 'design'],
      ['音乐', 'music'],
    ] as const) {
      const wrapper = mountPanel(createNode({ audioModel: MUSIC }))
      await clickKindChip(wrapper, label)
      const last = allPatches(wrapper).at(-1)
      expect(last, `切到${label} 时应带 audioModel`).toHaveProperty('audioModel')
      expect(audioKindOfModelValue(last!.audioModel as string), `切到${label} 的模型分类不对`).toBe(kind)
    }
    prefsUnknown = false
  })

  it('prefs 已加载但交集为空 ⇒ 仍然不改写 audioModel（上一轮行为不回归）', async () => {
    selectableAudioModels = [TTS]
    const wrapper = mountPanel(createNode({ audioModel: MUSIC }))
    await clickKindChip(wrapper, '综合音频')

    const last = allPatches(wrapper).at(-1)
    expect(last).toEqual({ audioKind: 'design' })
    expect(allPatches(wrapper).some((p) => 'audioModel' in p)).toBe(false)
    selectableAudioModels = [TTS, MUSIC]
  })
})

describe('AudioDockPanel 生成门槛按 kind 分派（R18）', () => {
  const refStub = [{ id: 'r1', sourceKind: 'upload', label: 'a', url: 'https://e/x.png' }]

  it('design：挂了 ref 但 scripts/roles/instruction 全空 ⇒ 不可提交', async () => {
    const wrapper = mountPanel(createNode({ audioKind: 'design' }), refStub)
    expect(generateButtonDisabled(wrapper)).toBe(true)
  })

  it('design：填了任一内容即可提交（门槛不过严）', async () => {
    const wrapper = mountPanel(
      createNode({ audioKind: 'design', audioScripts: [{ role: '', text: '下雨了' }] }),
      refStub,
    )
    expect(generateButtonDisabled(wrapper)).toBe(false)
  })

  it('design：正文 prompt 非空但三类内容全空 ⇒ 仍不可提交（正文不是 design 的内容）', async () => {
    const wrapper = mountPanel(createNode({ audioKind: 'design', prompt: '场景描述' }), refStub)
    expect(generateButtonDisabled(wrapper)).toBe(true)
  })

  it('voice：判定未变（正文非空即可提交，与 ref 无关）', async () => {
    const withPrompt = mountPanel(createNode({ audioKind: 'voice', prompt: '台词' }))
    expect(generateButtonDisabled(withPrompt)).toBe(false)

    const bare = mountPanel(createNode({ audioKind: 'voice' }))
    expect(generateButtonDisabled(bare)).toBe(true)

    const withRefs = mountPanel(createNode({ audioKind: 'voice' }), refStub)
    expect(generateButtonDisabled(withRefs)).toBe(false)
  })

  it('music：判定未变（正文非空或挂了 ref 即可提交）', async () => {
    const withPrompt = mountPanel(createNode({ audioKind: 'music', prompt: '轻快的电子乐' }))
    expect(generateButtonDisabled(withPrompt)).toBe(false)

    const withRefs = mountPanel(createNode({ audioKind: 'music' }), refStub)
    expect(generateButtonDisabled(withRefs)).toBe(false)

    const bare = mountPanel(createNode({ audioKind: 'music' }))
    expect(generateButtonDisabled(bare)).toBe(true)
  })

  it('存量节点无 audioKind ⇒ 落在 voice 且判定与今日一致', () => {
    const withPrompt = mountPanel(createNode({ prompt: '台词' }))
    expect(generateButtonDisabled(withPrompt)).toBe(false)
    expect(withPrompt.find('.dock-audio-kind-chips').exists()).toBe(true)
    const onChip = withPrompt.findAll('.dock-audio-kind-chips button').find((b) => b.classes().includes('is-on'))
    expect(onChip?.text()).toBe('配音')
  })
})
