import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// 对齐本仓静态契约测试惯例（见 CanvasPage.mobileChromeHygiene.test.ts）：
// 以测试文件自身位置为锚解析，不依赖 process.cwd()。
const here = dirname(fileURLToPath(import.meta.url))
const MOBILE_DIR = join(here, '..', 'mobile')
const PRESENTATION_DIR = join(here, 'presentation')

// 当前 Mobile* 允许列表（Phase 1 提升后，被提升者从此列表移除并迁入 presentation/）
const ALLOWED_MOBILE = new Set([
  'DiscoverPane', 'MobileAnnotationCapsule', 'MobileCanvasCreateFab', 'MobileCanvasShell',
  'MobileCreateSheet', 'MobileMultiSelectBar', 'MobileMultiSelectMoreSheet',
  'MobileNodeActionSheet', 'MobileNodeAnnotateSheet', 'MobileNodeCoachMark',
  'MobileNodeEditorSheet', 'MobileNodeStatusBar', 'MobileNodeTile', 'MobileNodeHandles',
  'MobileNodeViewer',
  'MobileNodeWaveform', 'MobileReadingSurface', 'MobileSaveStatus', 'MobileSheet',
  'MobileTabBar', 'MobileTaskSheet', 'MobileTopBar', 'MobileUndoToast', 'MobileViewerChrome',
  'ProfilePane',
])

test('no new Mobile* content component beyond pinned allowlist', () => {
  const files = readdirSync(MOBILE_DIR).filter(f => f.endsWith('.vue'))
  // 长度断言：拦截「目录被清空 / 文件被整删」导致的循环空跑盲点
  // （若 files 为空，上面的 for 循环会静默通过，护栏被架空）。
  expect(files.length, 'mobile 目录不应为空（护栏防整删盲点）').toBeGreaterThan(0)
  expect(files.length, 'mobile 组件数量须与 allowlist 一致（防整删 / 漏登记）')
    .toBe(ALLOWED_MOBILE.size)
  for (const f of files) {
    const name = f.replace(/\.vue$/, '')
    expect(ALLOWED_MOBILE.has(name),
      `新增 Mobile 组件 ${name} 须经视图统一评审（应提升为 presentation/ 共享组件），禁止绕过 Phase 0 护栏`
    ).toBe(true)
  }
})

test('mobile components must not import desktop Agent* components', () => {
  const files = readdirSync(MOBILE_DIR).filter(f => f.endsWith('.vue'))
  for (const f of files) {
    const src = readFileSync(join(MOBILE_DIR, f), 'utf8')
    expect(src, `${f} 不得反向依赖桌面 Agent* 组件（壳/内容边界）`)
      .not.toMatch(/from\s+['"][^'"]*components\/agent\/Agent/)
  }
})

test('shared presentation components must not read isMobileLayout', () => {
  const files = readdirSync(PRESENTATION_DIR).filter(f => f.endsWith('.vue'))
  for (const f of files) {
    const src = readFileSync(join(PRESENTATION_DIR, f), 'utf8')
    expect(src, `${f} 属共享内容层，禁止读 isMobileLayout（判据 A）`)
      .not.toContain('isMobileLayout')
  }
})

// 判據 A 强化：共享内容层不仅禁用 isMobileLayout，亦不得通过运行时视口探测
// （window.innerWidth）或媒体查询监听（matchMedia）做设备布局判定。
// 注：禁止在源注释中写入这些字面量（见 NodeTileView 注释纪律），否则守卫假红。
test('shared presentation components must not detect device layout at runtime', () => {
  const files = readdirSync(PRESENTATION_DIR).filter(f => f.endsWith('.vue'))
  for (const f of files) {
    const src = readFileSync(join(PRESENTATION_DIR, f), 'utf8')
    expect(src, `${f} 属共享内容层，禁止 window.innerWidth / matchMedia 设备判定（判據 A）`)
      .not.toMatch(/window\.innerWidth|matchMedia/)
  }
})
