import type { GenerationScene } from '../../types'

/**
 * 电商投放位 · 小红书种草图。
 *
 * 参数依据（平台规格会变，改前先核对投放位文档）：
 * - 3:4 竖版：小红书信息流首图为 3:4，竖版在双列瀑布流中占位更大，点击率优于 1:1
 * - 1K：社交分发场景按缩略图展示，原生分辨率过高不提升观感，反而抬高生成成本
 * - x2：种草笔记惯用「前后对比 / 双图并排」，单图无法承载对比叙事
 */
export const ecomXiaohongshu: GenerationScene = {
  id: 'ecom_xiaohongshu',
  kind: 'generation_scene',
  label: '小红书种草',
  description:
    '小红书信息流竖版 3:4（双列瀑布流占位更大）· 1K 够用 · x2 承载前后对比叙事。',
  modality: 'image',
  groupId: 'ecom_platform',
  groupLabel: '电商投放',
  fundamentalsRefs: ['define_result', 'composition', 'lighting'],
  promptScaffold: `创作一张小红书风格的种草推荐图。
画面主体清晰突出，质感真实可信，符合年轻女性/男性受众的审美。
构图适合竖版信息流浏览，主体略偏上方留出标题区。
色调明亮通透，有生活感，不要过度商业化。
不要出现平台 logo、水印或多余文字。`,
  systemOverlay:
    'Xiaohongshu seeding scene: vertical 3:4 composition optimized for the two-column feed; authentic lifestyle realism over studio gloss; leave headroom at the top for the caption overlay; no platform logos or watermarks.',
  preferredParams: {
    aspectRatio: '3:4',
    resolution: '1K',
    count: 2,
    quality: 'medium',
  },
  capability: {},
  expandViaPromptMode: 'image_prompt_multi_style',
}