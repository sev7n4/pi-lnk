/**
 * RB-D6①（spec 2026-10-13-sidebar-ref-bind-invariant-design.md）：dock 直生路径二次确认。
 * 前端是提示层（宽判定，Ruling 4：refs 全量解析含上游边）；门禁 SSOT 在 Nest（RB-D5，只看 localRefs）。
 */
import type { SidebarAttachment } from '@lnkpi/shared'

export const MISSING_REFS_CONFIRM_TITLE = '未检测到参考图'
export const MISSING_REFS_CONFIRM_MESSAGE =
  '本轮上传了参考图，但该节点还没有绑定任何参考图，直接生成将不使用参考图。可先让 Agent 执行 apply_sidebar_attachments 绑定，或手动添加参考图。'

export interface MissingRefsConfirmInput {
  nodeType: string
  /** resolveNodeRefs(...).filter((r) => !r.stale).length（localRefs + 上游边全量解析）。 */
  refCount: number
  /** 本轮（最近一条 user 消息）侧栏图片附件计数。 */
  sidebarImageCount: number
}

/** image/video 消费参考图；其余节点型不确认（Ruling 2 前端镜像）。 */
export function shouldConfirmDirectGenerateWithoutRefs(input: MissingRefsConfirmInput): boolean {
  if (input.nodeType !== 'image' && input.nodeType !== 'video') return false
  if (input.refCount > 0) return false
  return input.sidebarImageCount > 0
}

/** 最近一条 user 消息的侧栏图片计数（与 runtime tc.attachments 本轮语义对齐，Ruling 3）。 */
export function latestUserSidebarImageCount(
  messages: Array<{ role: string; attachments?: SidebarAttachment[] }>,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    return (messages[i].attachments ?? []).filter((a) => a.mediaType === 'image').length
  }
  return 0
}
