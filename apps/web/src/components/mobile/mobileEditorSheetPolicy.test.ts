import { describe, it, expect } from 'vitest'
import {
  appendOpinionPrefill,
  composeFallbackOpinion,
  contextTitle,
  nodeTypeLabel,
  paramChipToPrefill,
  CONTEXT_SUBTITLE,
} from './mobileEditorSheetPolicy'

/**
 * 移动端「改词」浮层策略纯函数（2026-11-01 规格 §8）。
 * 翻译制（J-1）与发送必有落点（J-2）的可判定核心全在本文件。
 */
describe('mobileEditorSheetPolicy（改词浮层 v2 策略）', () => {
  it('nodeTypeLabel：四类枚举 + 未知回退「节点」', () => {
    expect(nodeTypeLabel('image')).toBe('图片')
    expect(nodeTypeLabel('video')).toBe('视频')
    expect(nodeTypeLabel('audio')).toBe('音频')
    expect(nodeTypeLabel('text')).toBe('文本')
    expect(nodeTypeLabel('weird')).toBe('节点')
  })

  it('contextTitle：data.title 非空取之，否则降级「{类型}节点」', () => {
    expect(contextTitle({ title: '城市夜景' }, 'video')).toBe('城市夜景')
    expect(contextTitle({ title: '   ' }, 'audio')).toBe('音频节点')
    expect(contextTitle(undefined, 'image')).toBe('图片节点')
    expect(contextTitle({ title: 42 }, 'text')).toBe('文本节点')
  })

  it('paramChipToPrefill：全映射 + 未知字段 null（chip 不渲染可点行为）', () => {
    expect(paramChipToPrefill('imageAspect')).toBe('把画面比例改为')
    expect(paramChipToPrefill('imageResolution')).toBe('把分辨率改为')
    for (const f of ['imageModel', 'videoModel', 'textModel', 'audioModel']) {
      expect(paramChipToPrefill(f)).toBe('把模型改为')
    }
    expect(paramChipToPrefill('unknown')).toBeNull()
  })

  it('appendOpinionPrefill：空意见置为前缀', () => {
    expect(appendOpinionPrefill('', '把模型改为')).toEqual({ next: '把模型改为', changed: true })
  })

  it('appendOpinionPrefill：非空换行追加（保住 at mm:ss 既有预填）', () => {
    expect(appendOpinionPrefill('at 0:07', '把模型改为')).toEqual({
      next: 'at 0:07\n把模型改为',
      changed: true,
    })
  })

  it('appendOpinionPrefill：幂等（同前缀行已存在 ⇒ 原样返回）', () => {
    expect(appendOpinionPrefill('把模型改为', '把模型改为')).toEqual({
      next: '把模型改为',
      changed: false,
    })
    expect(appendOpinionPrefill('at 0:07\n把模型改为 更小', '把模型改为')).toEqual({
      next: 'at 0:07\n把模型改为 更小',
      changed: false,
    })
    // 用户已补全目标值的行不算重复（前缀后直接跟内容 = 已在表达）
    expect(appendOpinionPrefill('把模型改为 sora-2', '把模型改为')).toEqual({
      next: '把模型改为 sora-2',
      changed: false,
    })
  })

  it('composeFallbackOpinion：有标题用标题，无标题降级类型名', () => {
    expect(composeFallbackOpinion('城市夜景', 'video')).toBe(
      '已更新「城市夜景」的提示词，请按新词重做并替换当前产物',
    )
    expect(composeFallbackOpinion('', 'image')).toBe(
      '已更新「图片节点」的提示词，请按新词重做并替换当前产物',
    )
  })

  it('CONTEXT_SUBTITLE 与 fallback 文案同源（不出现「生成」二字，G-8 表达习惯一致）', () => {
    expect(CONTEXT_SUBTITLE).not.toContain('生成')
    expect(composeFallbackOpinion('x', 'image')).not.toContain('生成')
  })
})
