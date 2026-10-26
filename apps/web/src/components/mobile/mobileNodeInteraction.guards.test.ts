import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ vitest 是 ESM ⇒ `__dirname` 不可用（仓库既有约定：fileURLToPath(import.meta.url)）
const HERE = dirname(fileURLToPath(import.meta.url))
// ⚠️ 用 resolve（⛔ 不用 join：`join` 会把 `../` 归一化掉，跨出 HERE 就找不到）
const read = (p: string) => readFileSync(resolve(HERE, p), 'utf-8')

/** 剥离注释（JS 注释 + HTML 注释）—— 注释里提到组件名/术语是**规范说明**，不是引用 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const policy = read('../../composables/mobileNodeOpenPolicy.ts')
const policy2 = read('../../composables/mobileNodeActionPolicy.ts')
const viewer = stripComments(read('./MobileNodeViewer.vue'))
const editor = stripComments(read('./MobileNodeEditorSheet.vue'))
const annotate = stripComments(read('./MobileNodeAnnotateSheet.vue'))
const actionSheet = stripComments(read('./MobileNodeActionSheet.vue'))
const tile = stripComments(read('./MobileNodeTile.vue'))
const page = read('../../pages/CanvasPage.vue')

/**
 * 移动端节点交互 · **行为级守卫**（规格 §10.2 G-1..G-18 集中化）。
 *
 * ⭐ 这些守卫防的是「**交互语义退化**」—— 本轮重构把移动端统一到 iOS HIG /
 *   Material 3 的组件语义（Menu 化 / 撤销优先 / 浮层基座 / 图标体系统一），
 *   没有守卫，下一个人很容易写回「点按进编辑器」「删除零确认」「裸 fixed 浮层」。
 *
 * ⭐ 全部用**源码契约**形态（静态断言）—— 仓库既有形态（如
 *   `home-profile-p3.guard.test.ts`）；**行为级**用例在各自组件测试里。
 */
describe('移动端节点交互 · 行为级守卫（规格 §10.2）', () => {
  it('G-1 空节点 / 生成中 / 失败无旧产物 tap 不进编辑器（意图 = none）', () => {
    expect(policy).toContain("'none'")
    // 状态门控：generating 优先、error 看有无旧产物、其余 empty
    expect(policy).toMatch(/generating[\s\S]{0,80}'none'/)
    expect(policy).toMatch(/'pending'[\s\S]{0,40}'viewer'/)
  })

  it('G-2 查看器有两条退出通道（右上 X + 下滑关闭）', () => {
    expect(viewer).toContain('mobile-viewer-close')
    expect(viewer).toMatch(/touchstart/)
    expect(viewer).toMatch(/touchmove/)
  })

  it('G-3 退出即停：close 前先 pause 视频', () => {
    expect(viewer).toMatch(/function requestClose[\s\S]{0,200}pause\(\)/)
  })

  it('G-4 多选态 tap = 切换选中，不开查看器', () => {
    // 多选态信号统一走 computed `isSelectionMode`（注入可能是真 ref 或普通对象，
    // 直接判 ref 会在普通对象形态下得到「恒 truthy」的错判）
    expect(tile).toMatch(/const isSelectionMode = computed\(/)
    expect(tile).toMatch(/isSelectionMode\.value[\s\S]{0,160}emit\('toggle-select'\)/)
  })

  it('G-5/G-17 删除走「撤销优先」（删除 + Snackbar 撤销），不用二次确认弹层', () => {
    expect(page).toContain('handleMobileNodeSendToAgent') // 编辑器通道
    expect(page).toMatch(/removeSingleNode\(nodeId\)[\s\S]{0,300}showUndoToast/)
    expect(page).toContain('undoLastDelete')
  })

  it('G-6/G-12 状态门控在策略层（generating 禁产物类操作与删除）', () => {
    expect(policy2).toMatch(/state !== 'generating'/)
    expect(policy2).toMatch(/hasContent/)
  })

  it('G-7 移动端编辑器不挂 PC studio dock', () => {
    expect(editor).not.toContain('DockStudioRouter')
    expect(editor).not.toContain('dock-studio')
  })

  it('G-8 移动端编辑器无「生成」按钮（生成权归 agent）', () => {
    const tpl = /<template>([\s\S]*?)<\/template>/.exec(editor)?.[1] ?? ''
    expect(tpl).not.toContain('生成')
    expect(tpl).toContain('发给 agent 修改')
  })

  it('G-9 标注产出是「带标记的整图」（底图铺满，不裁切）', () => {
    const compose = read('./annotate/composeAnnotatedImage.ts')
    expect(compose).toMatch(/drawImage\([^)]*0,\s*0,\s*baseWidth,\s*baseHeight/)
  })

  it('G-10 标注回传按钮用品牌锚位图（⛔ 不新造图标）', () => {
    expect(annotate).toContain('anchor-locate.png')
  })

  it('G-11 标注回传后切回对话页 + 写入 composer 引用（看得见落地）', () => {
    expect(page).toMatch(/handleMobileAnnotateSend[\s\S]{0,2000}addFromPayload/)
    expect(page).toMatch(/mobileAppTab\.value = 'chat'/)
  })

  it('G-12 视频无 CORS / 取不到帧 ⇒ 诚实降级（只带文字，明说不带图）', () => {
    expect(viewer).toMatch(/degraded:\s*true/)
    expect(annotate).toContain('只带文字')
  })

  it('G-13 长按承载的是 Menu（一级 ≤5 项 + 二级「更多」）', () => {
    expect(policy2).toMatch(/primary\.length < 5/)
    expect(policy2).toContain('MOBILE_NODE_SECONDARY_ACTION_KEYS')
    expect(actionSheet).toContain('data-action="more"')
  })

  it('G-14 破坏性项置底 + 前置分隔线 + 红色（--lnk-error）', () => {
    expect(policy2).toContain('MOBILE_NODE_DESTRUCTIVE_ACTION_KEYS')
    expect(actionSheet).toMatch(/action-item--danger[\s\S]{0,300}border-top/)
  })

  it('G-15 移动端浮层统一走 MobileSheet 基座（⛔ 禁第二套 sheet 皮肤）', () => {
    expect(actionSheet).toContain('MobileSheet')
    expect(annotate).toContain('MobileSheet')
    expect(actionSheet).not.toMatch(/position:\s*fixed/)
  })

  it('G-16 移动端模板无文本字符当功能图标（‹ × ⋯）', () => {
    expect(viewer).not.toMatch(/>\s*[‹×⋯]\s*</)
    expect(actionSheet).not.toMatch(/>\s*[‹×⋯]\s*</)
  })

  it('G-18 命中区令牌被使用（44px 触控下限，§4.11.6）', () => {
    expect(viewer).toContain('--lnk-touch-target')
    expect(actionSheet).toContain('--lnk-touch-target')
  })

  it('⛔ 零 --neo-* 旧令牌（G-15 / AGENTS.md）', () => {
    for (const f of ['./MobileNodeViewer.vue', './MobileNodeActionSheet.vue', './MobileNodeAnnotateSheet.vue']) {
      expect(read(f), `${f} 不得出现 --neo-*`).not.toContain('--neo-')
    }
  })
})
