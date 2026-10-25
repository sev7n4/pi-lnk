# 品牌锚图标规范（Brand Anchor Icon Spec）

> 状态：已落地（分支 `fix/brand-anchor-icons`，替代 2026-10-24 旧版 line-drawing 方案）
> 关联：lnk π 品牌 Logo 资产 `lnk-pi-logo_assets/c80d7b56-lnk-pi-logo_A_icon-only_v2_1024px_transparent.png`
> 决策来源：用户确认 —— SignatureHero 用「纯锚」；SlideToCreate / CanvasRefTargetIcon / AgentSideRail 用「双色徽标」

## 1. 目的与范围

把产品内锚图标的几何收敛到 lnk π 品牌 Logo 资产的**真实锚几何**（而非另程序化绘制），并区分两种呈现：

- **纯锚**（单色蒙版，随主题）：SignatureHero、DockGenerateButton、AgentSideRail 微图标。
- **双色徽标**（黑盘 + 白锚 + 外环 + 左侧波浪，固定颜色位图）：SlideToCreate、CanvasRefTargetIcon。

**本规范相对旧版（2026-10-24）的变更**：锚几何改为从品牌资产反相抠取（非程序化绘制）；新增 `anchor-badge.png`；改两处消费位代码（mask → `<img>`，突破「只换 PNG」旧约定）。

## 2. 两类锚的来源与几何

### 2.1 纯锚（`anchor-generate.png` / `anchor-locate.png`）
- **来源**：品牌 icon-only 资产 `c80d7b56…transparent.png` 反相抠取。该资产是「黑盘 + 锚负形挖空 + 外环 + 左侧波浪」。
- **方法**（`scripts/gen-brand-anchor-icons.py::extract_anchor_mask`）：取 alpha → flood-fill 外部透明 → 内部封闭透明为「锚 + 波浪」负形 → 取含画布中心连通分量 = 中央锚（自动排除分离的波浪装饰）→ 反相为 white-fill 蒙版（alpha=锚，RGB=255）。
- **几何**：与品牌 Logo 锚完全同源（实心球头 + 横杆 + 双爪 + 长杆），非程序化近似。
- 尺寸：`anchor-generate.png` = 94×106（竖）、`anchor-locate.png` = 93×93（方）。

### 2.2 双色徽标（`anchor-badge.png`）
- **来源**：同一品牌资产，裁整体不透明 bbox。
- **关键处理**（`extract_badge_rgba`）：黑盘内的锚洞负形**填充真实白**（而非透明），使徽标在任意底色（含暗底）上锚都可见；环与盘之间的留白保留透明（维持品牌「环-盘分离」质感）；黑盘/外环/波浪保持源资产黑，外缘透明。
- 尺寸：256×256 透明方块（徽标居中，源 bbox ≈ 692×733 等比缩入）。
- 渲染：`<img>` 引用，CSS `object-fit: contain`，**不随主题变色**（固定双色）。

## 3. 渲染契约

| 类别 | 文件 | 渲染 | 上色 |
|---|---|---|---|
| 纯锚 | `anchor-generate.png` / `anchor-locate.png` | `mask` + `background: currentColor` | 跟随文字色/主题（暗底自动反白） |
| 双色徽标 | `anchor-badge.png` | `<img>` + `object-fit: contain` | 固定黑盘白锚，不随主题 |

> 双色徽标**无法用 `mask` 渲染**——蒙版只认 alpha、忽略 RGB 颜色，黑盘白锚会丢失。故改用 `<img>`（需改 2 个组件，突破旧「只换 PNG」约定）。

## 4. 消费位点

| 图标 | 文件 | 消费位 | 渲染 | 角色 |
|---|---|---|---|---|
| 纯锚 | `anchor-generate.png` | `SignatureHero.vue`（大锚）<br>`DockGenerateButton.vue`（15×17）<br>首页三联 glyph | `mask` | 「点击锚→创作」落款；受 `home-profile-p3.guard.test.ts` 约束走 `anchor-generate.png` |
| 双色徽标 | `anchor-badge.png` | `SlideToCreate.vue`（22×25 滑条纽扣）<br>`CanvasRefTargetIcon.vue`（资产库 hover / 画布节点 / 多选工具栏） | `<img>` | 创作锚 / 定位引用锚，呈现完整品牌徽标 |
| 纯锚 | `anchor-locate.png` | `AgentSideRail.vue`（11×11 / 15×15 微图标） | `mask` | 功能性定位指示（小尺寸保持纯锚保证清晰） |

> 注：AgentSideRail 的定位锚用户点名为「双色徽标」，但其 11/15px 用法落在「会糊」区间，按 PM 决策保持纯锚以保证清晰；完整徽标由 SlideToCreate / CanvasRefTargetIcon 承载品牌感。

## 5. 质量门禁（交付前必须全部通过）

1. **纯锚尺寸精确**：`anchor-generate.png` = 94×106、`anchor-locate.png` = 93×93，逐像素核对。
2. **徽标锚洞为真实白**：锚洞像素 `RGB≈(255,255,255)` 且 `A=255`，非透明；环-盘留白为透明（`A=0`）。
3. **纯锚 white-fill**：不透明像素 `RGB≈(255,255,255)`，无预乘灰边。
4. **无低 alpha 雾**：全幅不得有 `1≤A≤8` 的成片像素。
5. **徽标双底可辨**：在白底与暗底 composite 下锚均可见（锚为真实白，暗底不消失）。
6. **几何同源**：与品牌资产锚对比，球头/横杆/双爪/长杆一致（人工目检）。

## 6. 生成方式约束（环境事实）

`scripts/gen-brand-anchor-icons.py`：Pillow + numpy（本机已装）。
- `extract_anchor_mask()`：从品牌资产反相抠取纯锚蒙版。
- `extract_badge_rgba()`：裁品牌资产整体 + 锚洞填白，输出双色徽标。
- 运行 `python3 scripts/gen-brand-anchor-icons.py` 一次产出三文件，随资产提交，保证可复现。

## 7. 与旧版（2026-10-24）的差异

- 旧版：程序化绘制 line-drawing 锚（负空间环 + 平直方头 + 弯钩），仅 `mask`，不新增文件、不改代码。
- 本次：纯锚改为**品牌资产真实几何**提取；新增双色徽标 `anchor-badge.png`，并用 `<img>` 渲染（改 `SlideToCreate.vue` / `CanvasRefTargetIcon.vue` 两组件）。

## 8. 待办 / 已知限制

- 双色徽标在**暗底**若仍希望保持「黑盘」质感（而非反相），当前已通过「锚洞填白」保证锚可见；若某消费位确为暗底且黑盘不可见，可再出「白盘版」或对该 `<img>` 加 `filter: invert(1)`（当前 SlideToCreate 坐于 stamp-face 浅底、CanvasRefTargetIcon 主要位于浅色画布，无需）。
- AgentSideRail 的 11/15px 定位锚维持纯锚；若后续坚持要徽标，可单独出简化徽标（去外环/波浪）。
