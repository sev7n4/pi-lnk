// P2-5.1 技能入口降级：技能少时 chip 直选比菜单轻。
// 阈值 ≤3 → 'chip'（点击即切换，不展开菜单）；≥4 → 'menu'（popover 列表）。
export function skillMenuMode(count: number): 'chip' | 'menu' {
  return count >= 4 ? 'menu' : 'chip'
}
