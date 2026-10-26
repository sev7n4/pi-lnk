import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CP = readFileSync(join(HERE, 'CanvasPage.vue'), 'utf8')

/**
 * 走查①（2026-10-24 真机）：节点长按弹出**两个重复的卡片框**
 * （重命名/引用/编辑…各一张）。
 *
 * 根因（代码级）：移动端长按有两条入口同时触发——
 *   ① `MobileNodeTile` 的 `useLongPress`（400ms）⇒ R1-T5 的 `MobileNodeActionSheet`；
 *   ② 浏览器原生 `contextmenu` 事件 ⇒ vue-flow `node-context-menu` ⇒ PC 的
 *      `CanvasContextMenu`（它自带一套旧 D-6 移动端 Teleport sheet 分支）。
 * 两张卡内容一模一样 ⇒ 用户看到双卡片框。
 *
 * 修法（三处，判据全部行为级）：
 *   ① 删掉 `CanvasContextMenu` 的移动端 sheet 分支（组件重写，PC 浮层逐字保留）；
 *   ② 两个 contextmenu 处理器在移动端早退（双保险：即使将来有人给
 *      CanvasContextMenu 加回移动分支，也弹不出来）；
 *   ③ 动作 sheet 的多选三态文案随分支删除一并迁移到 `MobileNodeActionSheet`。
 */
describe('走查①：移动端长按单一入口（双卡片框根因闭环）', () => {
  it('节点 contextmenu 在移动端早退（不弹 PC 浮层）', () => {
    const fn = /function onNodeContextMenu\([\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
    expect(fn, '必须能定位 onNodeContextMenu').not.toBe('')
    // 早退必须发生在 preventDefault / 开菜单之前
    expect(fn).toMatch(/if \(isMobileLayout\.value\) return/)
    const guardIdx = fn.indexOf('if (isMobileLayout.value) return')
    expect(guardIdx).toBeLessThan(fn.indexOf('preventDefault'))
    // 有效性配对：PC 右键路径仍在（没有把函数删成空壳）
    expect(fn).toContain('contextMenu.value = {')
  })

  it('空白处 contextmenu 在移动端同样早退（长按空白不该弹 PC 拾取器）', () => {
    const fn = /function onPaneContextMenu\([\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
    expect(fn, '必须能定位 onPaneContextMenu').not.toBe('')
    expect(fn).toMatch(/if \(isMobileLayout\.value\) return/)
    // 有效性配对：PC 空白处拾取器仍在
    expect(fn).toContain('blankNodePicker.value = {')
  })

  it('CanvasContextMenu 移动端 sheet 分支已删（Teleport / ctx-sheet / 多选 props 全无）', () => {
    // ⚠️ 否定断言先剥注释：迁移说明写在注释里是规范（命中注释 = 假红）
    const raw = readFileSync(join(HERE, '..', 'components', 'canvas', 'CanvasContextMenu.vue'), 'utf8')
    const ctx = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\/[^\n]*/g, '')
    // 旧 D-6 移动端分支的全部痕迹
    for (const gone of ['Teleport', 'ctx-sheet', 'mobile', 'multiSelectActive', 'multiSelectSelected']) {
      expect(ctx, `CanvasContextMenu 不该再有 ${gone}`).not.toContain(gone)
    }
    // 有效性配对：PC 右键浮层本体仍在（不是把组件删了）
    expect(ctx).toContain('neo-popover')
    expect(ctx).toContain('下载图片')
  })

  it('移动端动作 sheet 仍是长按唯一入口（注入键 + 组件都在）', () => {
    expect(CP).toContain('MOBILE_NODE_ACTION_REQUEST_KEY')
    expect(CP).toContain('mobileActionNode.value = {')
    const sheet = readFileSync(
      join(HERE, '..', 'components', 'mobile', 'MobileNodeActionSheet.vue'),
      'utf8',
    )
    // ⚠️ 2026-10-25（§4.11.2 · HIG「Action Sheet ≠ Menu」）：长按承载的是 **Menu**，
    //    根节点已改走 `MobileSheet` 基座（⛔ 不再有裸 `.mobile-action-sheet` 皮肤，
    //    旧皮肤无遮罩 ⇒ 点浮层外画布不会关）。⇒ 断言改为「走基座」。
    expect(sheet).toContain('MobileSheet')
    expect(sheet).not.toContain('mobile-action-sheet')
  })
})
