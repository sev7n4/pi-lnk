import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ vitest 是 ESM ⇒ `__dirname` 不可用（仓库既有约定：fileURLToPath(import.meta.url)）
const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'CanvasPage.vue'), 'utf-8')

/**
 * 取 `handleMobileAnnotateAnchor` 的函数体（§17 v2 锚带回处理器）。
 * ⚠️ 参数是**对象类型**（`payload: { … }`）⇒ 闭合 `}` 在行首 ⇒ 不能用懒惰
 *   `\n\}` 截断。⇒ 锚到函数**末尾的确定行**（降级提示 ElMessage.info）。
 */
const FN_BODY =
  /async function handleMobileAnnotateAnchor\([\s\S]*?只带文字，未附截图'\)\s*\n\s*\}/.exec(SRC)?.[0] ?? ''

/**
 * 取 `handleMobileViewerEditSave` 的函数体（§17-④ 编辑保存）。
 */
const EDIT_SAVE_BODY =
  /function handleMobileViewerEditSave\([\s\S]*?closeMobileViewer\(\)\s*\n\s*\}/.exec(SRC)?.[0] ?? ''

/**
 * 批注锚带回 → decline 结算 + composer 引用（§17 v2 / §17.8 · 2026-10-27）。
 *
 * ⭐ **Review Focus #1/#2 的静态面**：
 *  - 锚下即标拒绝（拍板④）：先发 decline（note=批注意见，防抢跑），再带回截图；
 *  - 引用契约**拒 blob URL** ⇒ 合成图必须先上传（`fileToPersistedPayload`）；
 *  - 去重陷阱：`useSidebarAttachments.addFromPayload` 按 `url`/`sourceNodeId` 去重
 *    ⇒ 同节点连续两次标注 `sourceNodeId` 必须唯一。
 */
describe('批注锚带回 → decline 结算 + composer 引用（§17 v2）', () => {
  it('锚下即标拒绝：先 cancelProposeForNode（decline 结算），批注意见随 note 透传（§17.8 防抢跑）', () => {
    const body = FN_BODY
    expect(body).toContain('cancelProposeForNode')
    expect(body).toMatch(/opinion \? \{ note: opinion \} : undefined/)
  })

  it('⛔ blob URL 不入引用：合成图必须先上传（fileToPersistedPayload）', () => {
    const body = FN_BODY
    expect(body).toContain('fileToPersistedPayload')
    expect(body).toMatch(/blob:\s*'/) // 显式拒绝 blob
  })

  it('每次标注的 sourceNodeId 唯一（同节点连续两次标注都能进 composer）', () => {
    expect(SRC).toMatch(/mobileAnnotateSeq/)
    const body = FN_BODY
    expect(body).toMatch(/\$\{nodeId\}#annotate-\$\{\+\+mobileAnnotateSeq\}/)
  })

  it('写入走 useSidebarAttachments.addFromPayload（单一真源），胶囊文字预填 composer 正文（拍板③）', () => {
    const body = FN_BODY
    expect(body).toContain('addFromPayload')
    expect(body).toContain("sourceKind: 'canvasNode'")
    expect(body).toMatch(/opinion \? \{ text: opinion \} : \{\}/)
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

/**
 * 编辑保存 ⇒ 覆盖磁贴提示词（§17-④ · 拍板②：编辑保存回画布再确认，不触发生成）。
 * Review Focus #3 反例（V-17f）：保存即 confirm。
 */
describe('查看器编辑保存 → 覆盖磁贴（§17-④）', () => {
  it('保存 = patchNodeData({prompt}) + persistUserEdit（与编辑 sheet 同源通道）', () => {
    expect(EDIT_SAVE_BODY).toContain('patchNodeData')
    expect(EDIT_SAVE_BODY).toContain('prompt: text')
    expect(EDIT_SAVE_BODY).toContain('persistUserEdit')
  })

  it('⛔ 保存不触发生成（不得调用 handleAgentGenerateNode / generateForNode）', () => {
    expect(EDIT_SAVE_BODY).not.toContain('handleAgentGenerateNode')
    expect(EDIT_SAVE_BODY).not.toContain('generateForNode')
    expect(EDIT_SAVE_BODY).not.toContain('confirmProposeWait')
  })

  it('保存后关查看器回画布（回画布再确认）', () => {
    expect(EDIT_SAVE_BODY).toContain('closeMobileViewer')
  })
})

/**
 * 查看器底部主栏动作收敛（§17 v2 · 拍板①）：页面层只剩非 pending 的 `edit`。
 */
describe('查看器底部主栏死分支退役（§17 v2）', () => {
  const fn = /function handleMobileViewerBottomAction\([\s\S]*?\n\}/.exec(SRC)?.[0] ?? ''

  it('pending-confirm / pending-cancel 死分支已退役（viewer 内消化 annotate / pending edit）', () => {
    expect(fn).not.toContain('pending-confirm')
    expect(fn).not.toContain('pending-cancel')
    expect(fn).not.toContain('handleProposeConfirmCancel')
  })

  it('非 pending 的 edit（改词 sheet）保留', () => {
    expect(fn).toContain("key === 'edit'")
    expect(fn).toContain('openMobileNodeEditor')
  })
})
