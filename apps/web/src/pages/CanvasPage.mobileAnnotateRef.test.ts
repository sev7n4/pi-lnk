import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ vitest 是 ESM ⇒ `__dirname` 不可用（仓库既有约定：fileURLToPath(import.meta.url)）
const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'CanvasPage.vue'), 'utf-8')

/**
 * 取 `handleMobileAnnotateSend` 的函数体。
 * ⚠️ 不能用 `/async function handleMobileAnnotateSend\([\s\S]*?\n\}/` ——
 *   它的参数是**对象类型**（`payload: { … }`）⇒ 闭合 `}` 在行首 ⇒ 会在参数处
 *   提前截断，拿不到函数体。⇒ 锚到函数**末尾的确定行**。
 */
const FN_BODY = /async function handleMobileAnnotateSend\([\s\S]*?mobileAnnotateUploading\.value = false\s*\n\s*\}/.exec(SRC)?.[0] ?? ''

/**
 * 标注回传的引用写入（L1 / M1 · 规格 §4.3 + §4.5）。
 *
 * ⭐ **Review Focus #4 的另一半（blob 不入引用）**：引用契约**拒 blob URL** ⇒
 *   合成图必须先上传（`fileToPersistedPayload`）才能进 composer。
 *
 * ⭐ **去重陷阱**：`useSidebarAttachments.addFromPayload` 会按 `url` **或**
 *   `sourceNodeId` 去重 ⇒ 同一节点**连续两次标注**若用同一个 `sourceNodeId`，
 *   第二次会被**静默丢弃**（用户看不到任何反馈）⇒ 必须每次唯一。
 */
describe('标注回传 → composer 引用（L1 / M1）', () => {
  it('⛔ blob URL 不入引用：合成图必须先上传（fileToPersistedPayload）', () => {
    const body = FN_BODY
    expect(body).toContain('fileToPersistedPayload')
    expect(body).toMatch(/blob:\s*'/) // 显式拒绝 blob
  })

  it('每次标注的 sourceNodeId 唯一（同节点连续两次标注都能进 composer）', () => {
    expect(SRC).toMatch(/mobileAnnotateSeq/)
    const body = FN_BODY
    expect(body).toMatch(/\$\{ctx\.nodeId\}#annotate-\$\{\+\+mobileAnnotateSeq\}/)
  })

  it('写入走 useSidebarAttachments.addFromPayload（单一真源）', () => {
    const body = FN_BODY
    expect(body).toContain('addFromPayload')
    expect(body).toContain("sourceKind: 'canvasNode'")
  })

  it('降级（无图）⇒ mediaType 为 text + 明说「只带文字」', () => {
    const body = FN_BODY
    expect(body).toMatch(/url \? 'image' : 'text'/)
    expect(body).toContain('只带文字')
  })

  it('回传后切回对话页签（看得见落地，§4.5）', () => {
    const body = FN_BODY
    expect(body).toContain("mobileAppTab.value = 'chat'")
  })
})
