# F-5 品牌色评审材料（品牌蓝/紫收编方案）

> 状态：**待拍板**。本文件是评审材料，不是执行记录。
> 扫描口径：品牌蓝/紫 hex 全量（indigo 系 `#6366f1/#818cf8/#a5b4fc` + 紫 `#7c3aed/#6d5dfc` + 配套 `#7cc0ff`），共 **57 处**。
> 棘轮 `arbitrary-hex` 基线 39 只锁其中一部分模式，本清单更宽，以本文件为准。

## 一、A 类：var() fallback 值 —— 8 处，**建议保留，无需拍板**

兜底写法 `var(--xxx, #hex)`，hex 不是生效值（生效值由变量决定）：

| 位置 | 形态 |
|---|---|
| AgentNodeGraph.vue:456/493 | `var(--neo-accent, #3b82f6)` |
| CompareView.vue:442 | `var(--neo-hi-bg, #3b82f6)` |
| DockNoticeLayer.vue:92/131/177/191 | `var(--notice-accent, #3b82f6)`（191 为定义处） |
| AgentSideRail.vue:3838 | 注释文本 |

## 二、B 类：SVG 画布内容色 —— 5 处，**建议保留（内容层非 UI 层）**

连线/选择框的 stroke/fill，属于画布内容语义（类似节点标记色）：

| 位置 | 用途 |
|---|---|
| BatchConnectLine.vue:57 / BatchConnectPickerLine.vue:49 | 批量连线 stroke `#818cf8` |
| ConnectPickerLine.vue:107/116 | 连线选择 stroke/fill `#7c3aed` |
| MultiSelectConnectOverlay.vue:150 | 多选框 stroke `#7c3aed` |

## 三、C 类：UI 交互态品牌蓝 —— ~44 处，**需拍板**

全部集中在「品牌主色激活/选中/hover 态」，两种典型模式：

**模式 1：激活 chip/tab**（约 30 处）
`bg-[#6366f1]/30 text-[#818cf8]` 或 `border-[#6366f1]/50 bg-[#6366f1]/15`
→ CanvasZoomBar(7) · GenerationBar(2) · StudioShell(2) · AudioStudioPage(2) · GenerationRecordsPage(2) · ReplayPage(3) · UsageDayTable(1) · VideoEditorPage(2) · CategoryTabs(1 实底选中)

**模式 2：品牌按钮/链接 hover**（约 14 处）
`hover:border-[#6366f1]/30`（WorkCard 卡片）· `bg-[#6366f1] hover:bg-[#5558e3]`（WorkCard 主按钮）· `hover:text-[#818cf8]`（CanvasStatus/WorkCard/SharePage）· CarouselBanner eyebrow · StoryboardDialog/PublishNeoTVDialog 提示文字 · VideoCompositionDockPanel `color:#a5b4fc` · CreatorPage 头像底

### 拍板问题：`#6366f1/#818cf8`（indigo）是什么地位？

现状 `--lnk-accent` = `#6d5dfc`（紫）。indigo 系**不在令牌体系内**，散落 44 处。两种可能：

**方案一（推荐）：确认为「次级品牌蓝」，收编为语义令牌**
- 新增 `--lnk-brand-blue`（#6366f1）/ `--lnk-brand-blue-text`（#818cf8，深色主题）/ 浅色主题对（如 #4f46e5/#4338ca，需过 AA 实测）
- Tailwind 接 `brand-blue` / `brand-blue-text` 键，44 处机械替换
- 收益：进 SSOT + 守卫域（AA 对比度自动看护）、双主题正确（当前 `text-[#818cf8]` 在浅色主题白底上 3.1:1 **不达标**，是存量缺陷）
- 成本：一个批次；浅色对需实测定值

**方案二：全部并入 `--lnk-accent` 紫**
- 收益：单一品牌色，最简
- 代价：44 处视觉全变紫；画布上紫(accent) 与蓝(indigo) 若承担「主操作 vs 次级操作」的区分语义则**丢失层次**；风险高

**方案三：全部换中性色（text-primary/overlay）**
- 放弃品牌蓝表达，仅推荐在方案一/二都被否时使用

### 附：Refine 深蓝系（#7cc0ff 配套 rgba(0,89,179,*) 等 7 处）

P2d 已裁定为「Refine 工具族内容色」暂保留。若方案一通过，可顺带把 `#7cc0ff` 一并收编为 `--lnk-brand-blue-bright`；若拍板不动，维持现状（它们不在 arbitrary-hex 棘轮基线内，不阻塞）。

## 四、与棘轮的关系

- A/B 类不进棘轮（fallback 与内容色）。
- C 类若走方案一：替换后 `arbitrary-hex` 基线可大幅下调（39 → 剩 WorkCard `#5558e3` hover 值等零星），`brand-blue` 系列进 design-token.test.ts 守卫域（alpha 域 + AA）。
