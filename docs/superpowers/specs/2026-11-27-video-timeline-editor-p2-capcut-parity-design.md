# 视频时间线编辑器 P2：对标剪映的交互语法与轻量全屏编辑器设计

日期：2026-11-27
状态：已批准并闭环（P2.1~P2.7 全部合并部署；master `5704482`；生产 CDP 21/21、启用态取证 13/13）
上游：P1 规格 `2026-11-27-video-timeline-editor-p1-interaction-design.md`（P1.1~P1.5 已上线，master `5f6f751e`）

---

## 1. 背景与用户拍板

用户在 P1 上线后提出四点交互缺口，并追加两条拍板：

| # | 用户诉求 | 拍板 |
|---|---|---|
| 1 | 缺一根沿横轴移动、贯穿视频与音频的纵向分割线（播放头） | 纳入 |
| 2 | 收起态保持 nodrag 防误触；但当前只有左上角标题能拖，卡片主体应可拖 | **整框可拖 + 按钮局部 nodrag** |
| 3 | 编辑时间线是否支持音频（BGM/音频） | **全做，含音频分割与真实波形** |
| 4 | 整个视频分镜可左右滑动视频和音频通道 | 纳入 |
| 5 | 整体 UI 是否应复刻剪映；移动端当前轻量但界面可抄作业 | **充分调研剪映桌面+移动，系统性纳入；移动端做独立全屏编辑器** |

本规格的定位：**抄剪映的交互语法（信息架构、操作范式、反馈机制），不抄剪映的功能清单（内核兑现不了的功能做成按钮就是死按钮）**。

---

## 2. 调研结论：剪映的交互语法（桌面 + 移动）

Sources: 剪映专业版界面解析（头条/新片场/B站教程）、CapCut 官方指南与移动端操作手册、音频编辑专题（太平洋科技/微信公众号教程），检索日期 2026-11-27。

### 2.1 桌面（剪映专业版）四分区

```
┌──────────┬──────────────────────────┬──────────────┐
│ 素材区    │ 预览窗口（播放器）          │ 参数检查器    │
│ 媒体/文本 │ 实时显示播放头所在帧；      │ 选中片段后   │
│ 贴纸/特效 │ 可拖动缩放画面             │ 显示对应参数 │
│ 转场/滤镜 ├──────────────────────────┴──────────────┤
│          │ 时间线：主轨(A-Roll)+叠加轨；视频/音频/文字/特效轨 │
│          │ 播放头竖线；刻度缩放；磁吸；分割/删除/复制/撤销    │
└──────────┴───────────────────────────────────────────┘
```

关键交互事实：
- **主轨磁吸**：导入素材自动首尾相接；分割删除后后续素材自动前移吸附，无空隙断片。
- **自动吸附**：拖动素材靠近另一素材或播放头时出现青色吸附线；播放头靠近剪辑点/边缘也吸附。
- **时间轴缩放**：双指捏合（移动）/ Ctrl+滚轮（桌面）/ +/- 键 / Shift+Z 适配全部；拖拽刻度尺平移视口。
- **播放头**：可拖拽的时间游标（带三角标记），点击时间轴任意处定位；方向键逐帧；空格播放/暂停；预览轴（hover 出现黄线，实时显示该帧）。
- **片段选中**：白框选中 + 两端白色手柄（拖入手柄裁剪入出点）；选中态自动弹出上下文工具栏。
- **分割**：播放头定位 + `S`/`Ctrl+B`；删除后主轨自动吸附闭合。
- **音频**：独立音轨（多轨混音），波形可视化；整体音量、关键帧音量曲线、淡入淡出（拖片段两端白色图标）、分离原声、降噪、闪避、变速/变调、节拍踩点。
- **两级工具栏**：未选中片段时显示一级（剪辑/音频/文本/贴纸/画中画/特效…）；选中片段自动弹出二级（分割/变速/动画/特效/删除…），可横向滑动展开更多。

### 2.2 移动端（剪映 App）

```
┌─────────────────────────┐
│ X  搜索  使用中文  720P  导出 │ ← 顶部：关闭/比例/画质/导出
├─────────────────────────┤
│      预览画面 16:9        │
│         ✨ 魔法按钮        │
├─────────────────────────┤
│ 00:18/01:00  ▶ ⧉ ↶ ↷ ⛶  │ ← 播放控制：时间/播放/原声/撤销/重做/全屏
│ 00:16   00:18   00:20      │ ← 固定时间刻度
│ ▓▓▓▓[选中白框]▓▓▓▓  +      │ ← 视频主轨，片段缩略图，末尾 + 添加
│ ▁▃▅▇▅▃▁▁▃▅▇▅▃▁          │ ← 音频波形轨（青绿色）
│         │                │ ← 白色播放头贯穿刻度+视频+音频
├─────────────────────────┤
│ 剪辑 音频 文本 贴纸 画中画 特效 │ ← 一级工具栏（未选中）
│ ← 分割 变速 动画 特效 删除  AI │ ← 二级工具栏（选中片段）
└─────────────────────────┘
```

关键交互事实（与用户两张截图一致）：
- 播放头是**白色竖线**，贯穿时间刻度、视频轨、音频轨；拖动它定位所有剪辑操作。
- 片段选中态是**白色描边 + 两端白色方块手柄**；选中后底部自动切换成二级工具栏。
- 音频轨显示**真实波形**（青绿色填充），不只是色块。
- 主轨视频是**连续缩略图**（按帧抽帧），不是纯色块；末尾有 `+` 添加按钮。
- 时间轴**可左右滑动**，双指缩放；轨道左侧有锁图标防误触。
- 撤销/重做在播放控制行，紧邻播放键。

### 2.3 可复刻性判定（内核硬边界）

Editly 0.14.2 编译器（`compileTimelineToEditly`）真实支持：
- `video` layer：`cutFrom/cutTo/mixVolume`（裁剪 + 片段音量）
- `audioTracks`：`start/cutFrom/cutTo/mixVolume`（多轨音频、起始、裁剪、音量）
- `keepSourceAudio`、`clipsAudioVolume`、`outputVolume`
- `defaults: { transition: null }` —— **转场被刻意锁定**（P0 spike 实测默认转场吃掉时长）

`TimelineOp`（`packages/shared/src/canvas/videoTimeline.ts`）已支持：
`add_visual / add_audio / move_visual / trim / split / set_volume / remove / set_export / request_render`

明确不支持（内核无兑现路径，做成按钮必然是死按钮）：
转场效果、文本/字幕、贴纸、画中画、特效、滤镜、调色、关键帧动画、变速曲线、降噪、音频闪避、AI 踩点/分离。

**波形特例**：仓库已有 `apps/web/src/composables/useNodeWaveform.ts`（Web Audio `decodeAudioData` 解码真实 PCM → 64 点 peaks，失败返回 null 保持占位、绝不编造）与 `MobileNodeWaveform.vue`（只消费 peaks、区分占位/真实、带 loading 微标）。**直接复用，不新建解码器**。

---

## 3. 等价物检索结论表（第一原则：吃满上游）

| 需求 | 仓库等价物 | 结论 |
|---|---|---|
| 真实音频波形 | `useNodeWaveform` / `waveformPeaks` / `MobileNodeWaveform` | **直接复用**，时间线音轨只传 peaks |
| 音频 op（添加/起始/音量/删除） | `TimelineOp.add_audio/set_volume/remove` + reducer | **直接复用**，只补 UI 与 sources 注入 |
| 音频分割 | reducer `split` 明确 `unsupported_split_audio` | **需扩展** shared reducer + 校验 |
| 拖动手势/长按 | `useLongPress` + Vue Flow 原生拖拽 | **直接复用** |
| 独立 undo/redo | `createEditSession`（base/ops/cursor/redoStack） | **直接复用**，全屏编辑器共享同一 session |
| 提交写治理 | `submitTimelineOps` → `service.edit` → `transactGovernedCanvasOps` | **直接复用**，禁止前端另造 reducer 或整体 PUT |
| 播放预览壳 | `useCanvasEditorStore.openMediaPreview` | **直接复用** |
| 时间轴原子 UI（ruler/playhead/clip/audio lane） | 无（现嵌在 `VideoTimelineEditorOverlay.vue` 模板内） | **需抽取**为共享组件，PC 与移动共用 |
| 移动端全屏壳 | 无（`VideoTimelineEditorOverlay` 是居中浮层） | **需新建** `VideoTimelineStudio.vue` |
| 淡入淡出（Editly fade） | 编译 spec 无 fade 字段 | **需 spike**，不承诺；无内核支持则不做按钮 |

---

## 4. 现状差距逐条（代码事实）

| # | 诉求 | 当前代码事实 | 差距 |
|---|---|---|---|
| 1 | 贯穿播放头 | 浮层只有 `<input type=range>`（`vtm-playhead`），`playheadSec` 仅驱动时间与 split；轨道上无竖线 | 缺可视化竖线 + 点击定位 + 吸附 |
| 2 | 整框可拖 | `VideoTimelineCard.vue` 根 section 带 `nodrag`，整卡不可拖，只剩 `NeoBaseNode` 标题条可拖 | 需反转 nodrag 边界，保留按钮局部 nodrag |
| 3 | 音频编辑 | 数据/编译/agent 均支持；浮层只渲染只读色块；**且浮层 `sources` 未注入**（`CanvasNodeVideo.vue` / `MobileVideoTimelineTile.vue` 均未传），add_audio 必然 `unknown_source_node` | 补 sources 注入 + UI + audio split + 波形 |
| 4 | 左右滑动 | clip 用 `widthPct(totalSec)` 压进 100%，`.vtm-track` 为 `overflow:hidden`，ruler 是 6 个静态 span | 改固定 px/秒 + 共享滚动容器 |
| 5 | 移动端全屏 | 复用 PC 居中浮层，非全屏；无底部两级工具栏 | 新建独立全屏编辑器 |

---

## 5. P2 设计

### 5.1 数据层（`packages/shared/src/canvas/videoTimeline.ts`）

1. **扩展 `split` 支持 audio**：
   - audio split 产生两个 audio track：同 `audioTrackIndex`，`sourceInSec/sourceOutSec` 分割，`startSec` 按可视时长偏移；不进 `trackOrder`（audio 由 `startSec` 定位）。
   - `validateTimeline` 的 audio overlap 检查保持有效（相邻片段 `startSec` 必须 ≥ 前段 `startSec + durationSec`）。
   - 保留 `unsupported_split_audio` 仅在参数非法时返回。
2. **新增 `duplicate` op**：复制 visual clip 插到 `trackOrder` 相邻位置（新 id 由 `ctx.nextId` 生成）；复制 audio clip 则找同轨空位，无空位报错。
3. **新增 `set_moved` / `set_trim_handles` 不需要**：现有 `move_visual` / `trim` 已覆盖，禁止新增重复 op。

### 5.2 共享时间轴原子组件（新建 `apps/web/src/components/timeline/`）

- `TimelineRuler.vue`：固定 px/秒刻度（`PX_PER_SEC` 初值 24，支持 zoom 0.5x~8x），点击定位发出 `seek(sec)`。
- `TimelinePlayhead.vue`：绝对定位竖线（带三角手柄），`left = playheadSec * pxPerSec - scrollLeft`；pointerdown/move/up 拖动；吸附阈值 `6px` 内对齐片段边缘/播放头收藏点。
- `TimelineClip.vue`：片段块（标题/时长/缩略占位）；选中态白框 + 两端手柄（触发 trim）；点击选中。
- `TimelineAudioLane.vue`：A1/A2 两条轨；复用 `MobileNodeWaveform` 消费 `useNodeWaveform` 的 peaks；显示标题/时长/起始；支持 audio split 后的独立片段。
- `useTimelineScroll.ts`：共享 `pxPerSec` / `scrollLeft` / zoom，保证 ruler、视频轨、音频轨三者同一坐标系。

**关键约束**：`scrollLeft` 与 `pxPerSec` 是**纯前端 UI 态**，不写 op、不写服务端——与现有 `playheadSec` 一样属于本地状态。

### 5.3 PC 浮层改造（`VideoTimelineEditorOverlay.vue`）

- 模板内嵌时间轴替换为 §5.2 共享组件组合。
- 保留现有 `data-vt-*` 选择器（CDP 判据不回归）。
- transport 的 range 滑杆可保留作为精确输入，或与播放头二选一（建议保留，二者绑定同一 `playheadSec`）。
- 工具栏从平铺按钮改为**两级语义**：未选中片段显示「选择片段 / 添加素材 / 导出设置」，选中后显示「分割/裁剪/删除/左移/右移/复制/撤销/重做」（DOM 常驻或形态切换必须遵守防误触三件套：DOM 下沉 + capture 守卫 + 形态复位）。

### 5.4 收起态 nodrag 反转（`VideoTimelineCard.vue`）

- 根 section 去掉 `nodrag`；给 3 个按钮（✂/▶/导出）保留 `nodrag` + `@pointerdown.stop`。
- 缩略图条、ruler、footer 空白区恢复可拖（Vue Flow 默认整框拖拽）。
- 加 `cursor: grab` 提示。
- **防误触判据**：pointerdown 落按钮 → 不触发节点移动；pointerdown 落卡片主体 → 可拖；移动端 tile 不受影响（另有壳层手势隔离）。

### 5.5 音频编辑（`VideoTimelineEditorOverlay.vue` + 移动端共享）

- 补 `sources` 注入：`CanvasNodeVideo.vue` / `MobileVideoTimelineTile.vue` 把当前画布的 audio 节点传给浮层（`VideoTimelineEditorOverlay` 已有 `sources?` prop，未接线）。
- 新增控件：**+ 音频**（从画布音频节点选择，走 `add_audio`）、**音频分割**（播放头定位 + `split`）、**音量**（`set_volume` + 静音）、**起始时间**（`trim` 对 audio 调整 sourceIn/Out + startSec）、**删除**（`remove`）。
- 音轨波形复用 `useNodeWaveform`；真实 peaks 不可得时保持占位 + loading 微标，**绝不编造数据**。
- **淡入淡出**：先做内核 spike（Editly 是否支持 audio fade）；不支持则不提供按钮，在规格中明确标注为「不抄」。

### 5.6 移动端独立全屏编辑器（新建 `VideoTimelineStudio.vue`）

- 落在 `apps/web/src/components/mobile/`，Teleport 到 body，`position: fixed; inset: 0`，全屏。
- 结构对标剪映移动截图：
  - 顶部：关闭 / 标题 / 比例标记（复用节点 `videoSettings.aspectRatio`）/ 画质 / 导出（走现有 `request_render` 确认门）
  - 预览区：`openMediaPreview` 同款沉浸式播放壳（16:9/9:16 按节点比例）
  - 播放控制行：时间 / 播放 / 撤销 / 重做
  - 时间轴：§5.2 共享组件（ruler + 贯穿播放头 + 视频主轨 + A1/A2 音频波形轨），支持横滑与双指缩放
  - 底部两级工具栏：一级（剪辑/音频/文本占位…只挂载内核能兑现的）→ 二级（分割/变速?/动画?/删除→只保留真实可用的）
- `NodeTileView` 的 timeline tile 点「编辑」后打开此全屏壳，而非复用 PC 浮层；PC 浮层保持独立。
- 手势纪律：全屏壳在 body 层，需与 `MobileNodeTile` 壳层手势彻底隔离（DOM 下沉 + `.stop` + 形态复位；防误触三件套）。
- allowlist + phase4 manifest 审计登记（新 `Mobile*` 组件须评审登记）。

### 5.7 不抄清单（明确写入 UI 帮助文案，避免用户寻找）

转场、文本、贴纸、画中画、特效、滤镜、调色、关键帧动画、曲线变速、降噪、闪避、AI 踩点/分离、多轨视频叠加。

---

## 6. 测试与完成定义

### 6.1 单测（TDD，先 RED 后 GREEN）
- shared reducer：audio split 语义、overlap 校验、duplicate op、非法参数拒绝。
- 时间轴组件：playhead 拖动/吸附/点击定位、ruler px/sec 映射、zoom、横滑坐标一致。
- nodrag 反转：按钮 pointerdown 阻断、主体可拖（DOM class 断言）。
- 音频 sources 注入：浮层拿到真实 audio 节点、add_audio 不再 `unknown_source_node`。
- 波形：真实 peaks 复用、占位/真实/loading 三态、绝不编造。
- 全屏编辑器：挂载、关闭、两级工具栏形态切换、防误触守卫、commit 走 submitTimelineOps。

### 6.2 变异自检
每个关键判据做一次变异（删除对应分支/改 no-op），确认测试 RED；恢复后 GREEN。重点：audio split、sources 注入、playhead 吸附、nodrag 边界、全屏壳 commit。

### 6.3 静态门禁
- `verify-pc-canvas-legacy-scope.py` V1-V7（行数棘轮，改 CanvasNodeVideo/NodeTileView 需审计登记）
- `verify-phase4-delete-scope.py` V1-V7（presentation 目录新文件登记）
- viewUnification mobile allowlist（新 Mobile 组件登记）
- design-token / style guards；`vue-tsc -b`
- 三条 CanvasPage 静态契约（手势/入口/选择）

### 6.4 生产验收
- CI 4/4 全绿；合并树 == CI head tree；部署 success。
- 产物 chunk 含新标记（全屏壳/播放头）。
- CDP 用户视角（账号 `17279698698`，真实登录 + 新建会话）：
  - 收起态：卡片主体可拖、按钮不误触
  - 浮层：贯穿播放头拖动/点击定位/吸附、横滑、音频波形、audio split、音量
  - 移动端全屏：两级工具栏、播放头贯穿、横滑、波形、commit 服务端回读一致
- 启用态 `prod-verify.py` `ENABLE_ALL_PASS 13/13` 不回归；成片 h264/1280×720/4s。

---

## 7. 分期计划（七期，每期一个 PR）

| 期 | 内容 | 主要文件 | 风险 |
|---|---|---|---|
| P2.1 | 数据层：audio split + duplicate + 单测 | shared | 低 |
| P2.2 | 共享时间轴原子组件（ruler/playhead/clip/audio lane + scroll composable） | `components/timeline/` 新建 | 中 |
| P2.3 | PC 浮层接入新时间轴 + 贯穿播放头 + 横滑 + 吸附 | `VideoTimelineEditorOverlay.vue` | 中 |
| P2.4 | 收起态 nodrag 反转 + CDP 防误触判据 | `VideoTimelineCard.vue` | 中（防误触） |
| P2.5 | 音频编辑全套（sources 注入 + 波形复用 + split/音量/起始/删除）+ fade spike | overlay + CanvasNodeVideo + MobileTile | 中高 |
| P2.6 | 移动端独立全屏编辑器（含两级工具栏 + 手势隔离 + allowlist） | `MobileVideoStudio.vue` 新建 | 高 |
| P2.7 | 生产取证 + CDP 用户视角复测 | 脚本/取证 | 中 |

每期：开分支 → TDD → 变异自检 → 静态门禁 → PR → 盯 CI 4/4 → 合并核树 → 部署。P2.7 统一做生产 CDP 验收。

**交付结论（2026-11-27）**：P2.1~P2.5 依次合并（master `d373b9d`/`f49f6d6`/`eff0a0c`/`522009c`/`c3f2671`），P2.6 = PR #1018（`a0cb37a`），CDP 实证的 nodrag 缺口修复 = PR #1019（`5704482`）。P2.7 生产 CDP 21/21 全绿，启用态 `ENABLE_ALL_PASS 13/13`。§8 待确认项已逐条落地：fade spike 结论=Editly 0.14.2 无独立 audio fade，明确不抄且无死按钮；px/sec=24、缩放 0.5~8；两级工具栏只挂内核可兑现入口并有帮助文案；导出复用 `request_render` 确认门。

---

## 8. 待确认

1. **淡入淡出**：需 spike Editly 是否支持 audio fade；若不支持，明确不做（避免死按钮）。
2. **PX_PER_SEC 与缩放范围**：初值 24、0.5x~8x 为建议值，可按实际素材时长调整。
3. **两级工具栏的「不抄项」呈现**：建议只挂载内核能兑现的入口，并在帮助文案说明其余能力不在本工具范围。
4. **移动端全屏壳的导出**：复用现有 `request_render` 确认门，不新增渲染路径。
