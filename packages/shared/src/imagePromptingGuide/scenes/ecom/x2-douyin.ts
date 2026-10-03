import type { GenerationScene } from '../../types'

/**
 * 电商投放位 · 抖音带货竖版短视频。
 *
 * 参数依据（平台规格会变，改前先核对投放位文档）：
 * - 9:16：抖音竖版全屏沉浸，16:9 会在上下留黑边，完播率显著下降
 * - durationHint: 'short' 而非写死 5s —— 各视频模型能力区间不同（实测 4~15s），
 *   写死秒数会出现「场景说 5s 但模型最小 4s / 最大 15s」的悬空值；
 *   具体秒数由调用侧选定 videoModel 后按能力表 clamp
 * - generateAudio: true —— 抖音带货默认配 BGM/口播，无音轨的视频完播率明显更低
 */
export const ecomDouyin: GenerationScene = {
  id: 'ecom_douyin',
  kind: 'generation_scene',
  label: '抖音带货',
  description:
    '抖音竖版 9:16 全屏（避免上下黑边）· 短时长（按模型能力 clamp）· 生成配乐。',
  modality: 'video',
  groupId: 'ecom_platform',
  groupLabel: '电商投放',
  fundamentalsRefs: ['define_result', 'motion', 'composition'],
  promptScaffold: `创作一段抖音带货风格的竖版短视频。
主体动作明确、有吸引力，产品细节清晰可辨。
节奏紧凑，前 1秒抓住注意力。
画面适合 9:16 全屏竖版，主体居中偏上。
色调明亮，质感干净，符合年轻受众审美。
不要出现平台 logo 或水印。`,
  systemOverlay:
    'Douyin commerce scene: 9:16 full-screen vertical, never letterboxed; hook the viewer in the first second; keep the product legible throughout; upbeat clean color grade; no platform logos or watermarks.',
  preferredParams: {
    aspectRatio: '9:16',
    resolution: '1K',
    durationHint: 'short',
    generateAudio: true,
  },
  capability: {},
}