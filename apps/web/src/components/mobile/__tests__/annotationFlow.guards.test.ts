import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ vitest 是 ESM ⇒ `__dirname` 不可用；⚠️ 跨目录读源码用 resolve(HERE, p)
//（⛔ join 会把 `../` 归一化掉——仓库既有教训）
const HERE = dirname(fileURLToPath(import.meta.url))

/** 剥注释（行注释 + 块注释）：判据取**实质**不取字面（注释里提到组件名=规范说明） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function read(p: string): string {
  return stripComments(readFileSync(resolve(HERE, p), 'utf-8'))
}

/**
 * §17 v2 批注流静态守卫（V-17b / V-17g · 2026-10-27）。
 *
 * ⭐ 守卫纪律（仓库教训）：① 扫全对象清单、不做子集抽样（点名个别文件=给自己开后门）；
 * ② 判据取实质不取字面；③ 新守卫必做变异测试（改坏实现 ⇒ EXIT=1 且指名报错）。
 */
describe('批注流静态守卫（§17 v2）', () => {
  // ── V-17b：审核层底栏 = 批注/编辑两键（拍板①：三键退役）────────────────
  it('V-17b：壳层 pending 分支 = annotate + edit 两键，⛔ 不含 pending-cancel / pending-confirm / 拒绝 / 确认', () => {
    const shell = read('../MobileCanvasShell.vue')
    // pending 分支：从两键注释起到 return actions 止（比锚整函数更抗漂移）
    const branch = /if \(isPending\) \{[\s\S]*?return actions\s*\n\s*\}/.exec(shell)?.[0] ?? ''
    expect(branch, '壳层必须保留 pending 底栏分支').toBeTruthy()
    expect(branch).toContain("key: 'annotate'")
    expect(branch).toContain("key: 'edit'")
    expect(branch).not.toContain('pending-cancel')
    expect(branch).not.toContain('pending-confirm')
    expect(branch).not.toContain('pending_confirm') // 确认键的字面键名一并退役
    expect(branch).not.toContain('拒绝')
    expect(branch).not.toContain('确认')
  })

  // ── V-17g：批注流不按节点类型分叉（同源同容器，§17.3）──────────────────
  // 限定本次新增模块文件清单（⛔ 不扫全 viewer 历史——viewer 旧代码有合法的
  // type 分支：媒体区渲染本就按 image/video/audio 分流）。
  it('V-17g：批注流新增模块（胶囊 / 审阅底图渲染器）内无 type === 分支', () => {
    const files = [
      '../MobileAnnotationCapsule.vue',
      '../annotate/renderReviewBaseImage.ts',
    ]
    for (const f of files) {
      const src = read(f)
      expect(src, `${f} 内不得出现按节点类型的分叉（批注流同源同容器）`).not.toMatch(/type\s*===|\.type\b.*\?/)
    }
  })

  // ── 胶囊载体唯一：viewer 只挂 MobileAnnotationCapsule，⛔ 不复活旧 sheet 挂载 ──
  it('胶囊唯一载体：MobileCanvasShell 不再挂载 MobileNodeAnnotateSheet（§16-⑦ 退役）', () => {
    const shell = read('../MobileCanvasShell.vue')
    expect(shell).not.toContain('MobileNodeAnnotateSheet')
  })

  it('锚带回管线唯一：CanvasPage 锚处理经 cancelProposeForNode 结算（不另起 decline 通道）', () => {
    const page = stripComments(
      readFileSync(resolve(HERE, '../../../pages/CanvasPage.vue'), 'utf-8'),
    )
    const anchor = /async function handleMobileAnnotateAnchor\([\s\S]*?只带文字，未附截图'\)\s*\n\s*\}/.exec(page)?.[0] ?? ''
    expect(anchor, 'CanvasPage 锚处理器必须存在').toBeTruthy()
    expect(anchor).toContain('cancelProposeForNode')
    // ⛔ 不得本地硬置节点状态翻转（2026-10-13 虚假确认教训）：状态一律走服务端收敛
    expect(anchor).not.toMatch(/status\s*[:=]\s*['"](?:draft|confirmed|pending)/)
  })
})
