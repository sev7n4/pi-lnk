import { z } from 'zod'

export const SIDEBAR_ATTACHMENT_MAX = 5

export const SidebarAttachmentRoleSchema = z.enum(['product', 'model']).optional()

export const SidebarAttachmentSchema = z.object({
  id: z.string().min(1),
  mediaType: z.enum(['text', 'image', 'video', 'audio']),
  sourceKind: z.enum(['upload', 'asset', 'canvasNode']),
  label: z.string().min(1),
  url: z.string().optional(),
  text: z.string().optional(),
  sourceNodeId: z.string().optional(),
  /** product_visual Phase 1: product vs model ref for QA / routing. */
  role: SidebarAttachmentRoleSchema,
})

export type SidebarAttachment = z.infer<typeof SidebarAttachmentSchema>

export function validateSidebarAttachments(items: SidebarAttachment[]): SidebarAttachment[] {
  // RB-D7/M-3：非数组输入曾走到 items.map 抛英文 TypeError（PR-A 终审 M-3）。
  // 守卫为可行动中文文案：M-1 形态（芯片 key 当数组传）在 Nest 侧可直接自愈。
  if (!Array.isArray(items)) {
    throw new Error('attachments 必须是数组（每项为侧栏附件实体）；请省略该参数，由平台自动填充本轮侧栏附件')
  }
  if (items.length > SIDEBAR_ATTACHMENT_MAX) {
    throw new Error(`最多添加 ${SIDEBAR_ATTACHMENT_MAX} 个参考素材`)
  }
  const parsed = items.map((item) => SidebarAttachmentSchema.parse(item))
  for (const item of parsed) {
    if (!item.url?.trim() && !item.text?.trim()) {
      throw new Error('参考素材缺少 url 或 text')
    }
    if (item.url?.startsWith('blob:')) {
      throw new Error('blob URL 不允许作为参考素材')
    }
  }
  return parsed
}

const SIDEBAR_IMAGE_PREFIX = 'I'

/** VISP S-7：图片附件的侧栏 key 列表（与 sidebar-block 的 assignSidebarRefKeys 同源同序）。 */
export function imageSidebarRefKeys(attachments: Array<{ mediaType?: string }>): string[] {
  const keys: string[] = []
  let n = 0
  for (const item of attachments) {
    if ((item?.mediaType ?? '').trim().toLowerCase() !== 'image') continue
    n += 1
    keys.push(`${SIDEBAR_IMAGE_PREFIX}${n}`)
  }
  return keys
}

/**
 * VISP S-7：把侧栏图片标记（I1/I2…）解析回附件 url。
 * 仅图片可解析（恢复路径域）；找不到 / 非图片 / 缺 url → null。
 * 容忍小写与首尾空白（模型输出常带脏字符）。
 */
export function resolveSidebarRef(
  attachments: Array<{ url?: string; mediaType?: string }>,
  ref: string,
): string | null {
  const normalized = (ref ?? '').trim().toUpperCase()
  const keys = imageSidebarRefKeys(attachments)
  const idx = keys.indexOf(normalized)
  if (idx < 0) return null
  const images = attachments.filter((a) => (a?.mediaType ?? '').trim().toLowerCase() === 'image')
  const url = (images[idx]?.url ?? '').trim()
  return url || null
}
