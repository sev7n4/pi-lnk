/**
 * VoiceStudio P3 合规 #1 上传入口权利声明（spec 2026-11-24-voicestudio-p1p2 §6）：
 * 音频类文件上传前弹「声音权利确认」，拒绝即中止上传。
 *
 * 覆盖面（音频上传的三条路，全部经此收口）：
 *   - 画布音频节点：useNodeMediaUpload(kind='audio')（含拖拽 onDrop）
 *   - 资产库面板：CanvasAssetPanel onUploadChange（accept 混合 image/video/audio）
 *   - 侧栏参考 / dock 面板：accept="image/*" 不收音频，无需接入
 *
 * 每次弹（不记忆跳过）：音频上传是低频手动动作，合规声明最强形态优先于省一次点击；
 * 文案同时覆盖合规 #2「AI 标识声明」（克隆成品带 AI 合成标识）。
 */
import { ElMessageBox } from 'element-plus'

export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/')
}

const CONSENT_MESSAGE =
  '请确认您已获得该声音权利人的有效授权，仅使用自有或已获授权的声音素材。' +
  '克隆生成的音频将携带 AI 合成标识，禁止用于仿冒他人、欺骗或侵犯他人权益的场景。'

/** 音频文件上传前的权利确认。返回 false = 用户取消，调用方须中止上传。非音频直接放行。 */
export async function confirmVoiceRightsIfNeeded(file: File): Promise<boolean> {
  if (!isAudioFile(file)) return true
  try {
    await ElMessageBox.confirm(CONSENT_MESSAGE, '声音素材权利确认', {
      confirmButtonText: '我已获得授权',
      cancelButtonText: '取消上传',
      type: 'warning',
    })
    return true
  } catch {
    return false
  }
}
