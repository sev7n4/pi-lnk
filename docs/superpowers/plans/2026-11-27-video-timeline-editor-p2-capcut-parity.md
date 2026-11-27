# 实施计划：视频时间线编辑器 P2 对标剪映

日期：2026-11-27
状态：已闭环（规格 `2026-11-27-video-timeline-editor-p2-capcut-parity-design.md` 已批准；P2.1~P2.7 全部合并部署并生产复测，master `5704482`）
纪律：每期分支 → TDD（先 RED 后 GREEN）→ 变异自检 → 静态门禁 → PR → CI 4/4 → 合并核树 → 部署；不宣告未闭环 ALL_PASS。

---

## Task 1 — 数据层：audio split + duplicate（P2.1）

**文件**：`packages/shared/src/canvas/videoTimeline.ts`、`videoTimeline.test.ts`

- [x] 扩展 `split`：允许 `type === 'audio'`，生成两段 audio track；同 `audioTrackIndex`；`startSec` 按可视时长偏移；不写 `trackOrder`。
- [x] `validateTimeline`：audio overlap 校验对 split 后相邻片段仍成立（相邻 `startSec >= 前段 startSec + durationSec`）。
- [x] 新增 `duplicate` op：visual 插到 `trackOrder` 相邻位（新 id 由 `ctx.nextId`）；audio 找同轨空位，无空位报错。
- [x] 测试：audio split 时长守恒、overlap 拒绝、duplicate 两种类型、非法参数；变异：删 audio split 分支 → RED。
- [x] 门禁：shared 单测 + `vue-tsc -b`。

## Task 2 — 共享时间轴原子组件（P2.2）

**文件**：`apps/web/src/components/timeline/`（新建）、对应 `.test.ts`

- [x] `useTimelineScroll.ts`：`pxPerSec`（默认 24）、`zoom`（0.5~8）、`scrollLeft`；纯前端态，不写 op。
- [x] `TimelineRuler.vue`：按 px/sec 生成刻度 span；`seek(sec)` emit；点击定位。
- [x] `TimelinePlayhead.vue`：绝对定位竖线 + 三角手柄；pointerdown/move/up 拖动；6px 内吸附片段边缘/关键时间点；`left = sec * pxPerSec - scrollLeft`。
- [x] `TimelineClip.vue`：片段块 + 选中白框 + 两端 trim 手柄；点击选中 emit。
- [x] `TimelineAudioLane.vue`：A1/A2 轨；复用 `MobileNodeWaveform` + `useNodeWaveform` 的 peaks；显示标题/时长/起始。
- [x] 测试：坐标映射、zoom、横滑一致性、吸附阈值、波形三态（占位/真实/loading）、不编造 peaks；变异：吸附阈值改 no-op → RED。
- [x] 门禁：新组件 allowlist 检查（若命中 viewUnification）、design-token/style guards、`vue-tsc -b`。

## Task 3 — PC 浮层接入新时间轴（P2.3）

**文件**：`apps/web/src/components/canvas/VideoTimelineEditorOverlay.vue`（+ test）

- [x] 用 Task 2 组件替换内嵌 ruler/track/audio row；保留全部 `data-vt-*` 选择器（CDP 判据不回归）。
- [x] `playheadSec` 与播放头竖线/range 滑杆双向绑定；点击 ruler 定位；拖动竖线定位。
- [x] 工具栏按「未选中/选中」两级语义重组，DOM 存在性遵守防误触三件套。
- [x] 测试：竖线位置随 playheadSec、拖动改 playheadSec、点击 ruler 定位、split 用新 playheadSec、横滑后坐标不错位；变异：playhead 拖动 no-op → RED。
- [x] 门禁：`VideoTimelineEditorOverlay.test.ts`、三静态契约、行数棘轮（若触发）。

## Task 4 — 收起态 nodrag 反转（P2.4）

**文件**：`apps/web/src/components/canvas/VideoTimelineCard.vue`（+ test）、manifest（若行数变）

- [x] 根 section 去 `nodrag`；3 个按钮保留 `nodrag` + `@pointerdown.stop`（已有）。
- [x] 缩略图条/ruler/footer 空白区恢复可拖；加 `cursor: grab`。
- [x] 测试：根无 nodrag、按钮有 nodrag + pointerdown.stop、主体可拖区存在；变异：把根 nodrag 加回 → RED。
- [x] CDP 判据：pointerdown 落按钮不移动节点、落主体可移动（P2.7 执行）。
- [x] 门禁：行数棘轮 V1-V7、design-token。

## Task 5 — 音频编辑全套 + fade spike（P2.5）

**文件**：`CanvasNodeVideo.vue`、`MobileVideoTimelineTile.vue`、`VideoTimelineEditorOverlay.vue`（+ tests）

- [x] **sources 注入**：两个父组件把画布 audio 节点传给浮层 `sources`；测试 `add_audio` 不再 `unknown_source_node`；变异：去掉注入 → RED。
- [x] 新增控件：`+ 音频`（选画布 audio 节点→ `add_audio`）、音频分割（播放头 + `split`）、音量（`set_volume` + 静音）、起始时间（`trim`）、删除（`remove`）。
- [x] 音轨波形复用 `useNodeWaveform`；真实 peaks 失败时保持占位 + loading 微标，绝不编造。
- [x] **fade spike**：查 Editly 0.14.2 是否支持 audio fade（查源码/实测 spec）；支持则加 `set_audio_fade` op 与控件，不支持则在规格标注「不抄」且不加按钮。
- [x] 测试：sources 注入、audio split UI、音量 op、波形复用、fade 结论；变异：sources 注入 no-op → RED。
- [x] 门禁：行数棘轮（CanvasNodeVideo 改行数需审计登记）、declutter 测试、viewUnification。

## Task 6 — 移动端独立全屏编辑器（P2.6）

**文件**：`apps/web/src/components/mobile/VideoTimelineStudio.vue`（新建 + test）、`NodeTileView.vue`（接线）、manifest/allowlist

- [x] 新建全屏壳：Teleport body、`fixed inset 0`；顶部（关闭/标题/比例/画质/导出）、预览区（`openMediaPreview`）、播放控制行、时间轴（Task 2 共享组件）、底部两级工具栏。
- [x] 两级工具栏只挂载内核能兑现的入口；「不抄项」不出现；帮助文案说明范围。
- [x] `NodeTileView` 的 timeline tile 点「编辑」→ 打开全屏壳（不再复用 PC 浮层）；PC 浮层独立。
- [x] 手势隔离：DOM 下沉 + capture 意图守卫 + 形态复位；根 `.stop`；与 MobileNodeTile 壳层手势不冲突。
- [x] 测试：挂载/关闭、两级切换、播放头贯穿、横滑、commit 走 `submitTimelineOps`、防误触（pointerdown 落别处 + click 落新控件）；变异：commit no-op → RED。
- [x] 门禁：viewUnification allowlist 登记、phase4 inventory 登记（presentation 目录若新增）、三静态契约、行数棘轮、`vue-tsc -b`、web 全量。

## Task 7 — 生产取证 + CDP 用户视角复测（P2.7）

- [x] 合并后盯部署 workflow success；生产入口 200；产物 chunk 含新标记（`data-vt-playhead` / 全屏壳类名）。
- [x] CDP（账号 `17279698698` 真实登录 + 新建会话 + 种时间线草稿）：
  - [x] 收起态：卡片主体可拖（节点坐标变化）、按钮不误触（点击编辑/播放/导出各自触发且不移动节点）
  - [x] PC 浮层：贯穿播放头可见/可拖动/点击定位/吸附、横滑后坐标一致、音频波形、audio split、音量、删除
  - [x] 移动端全屏：顶部/预览/时间轴/两级工具栏齐备、播放头贯穿、横滑、波形、commit 服务端回读一致
- [x] 启用态 `prod-verify.py` `ENABLE_ALL_PASS 13/13` 不回归；成片 h264/1280×720/4s。
- [x] 工作记忆记录结论与可复用经验。

---

## 交付结论

- P2.6 实现落点为 `components/mobile/VideoTimelineStudio.vue`（规格表格中的 `MobileVideoStudio.vue` 为早期命名，实际以仓库为准）。
- 生产 CDP 21/21（账号 17279698698 真实登录、自建会话）：收起态拖卡片/按钮不拖、PC 贯穿播放头+真实波形+音量回读、移动全屏两级栏+audio split 服务端音轨 1→2。
- 启用态 `ENABLE_ALL_PASS 13/13`；`pintuotuo` 9 容器与 `lnkpi-matting` 保持停止，未经授权不恢复。

## 每期通用门禁清单

```bash
# 单测（nvm node24 + 单 worker）
cd apps/web && env -u NODE_OPTIONS npx vitest run <target> --maxWorkers=1 --no-file-parallelism
cd packages/shared && env -u NODE_OPTIONS npx vitest run --maxWorkers=1 --no-file-parallelism

# tsc
cd apps/web && env -u NODE_OPTIONS npx vue-tsc -b

# 静态门禁（仓库根）
python3 scripts/verify-pc-canvas-legacy-scope.py
python3 scripts/verify-phase4-delete-scope.py
env -u NODE_OPTIONS pnpm verify-spec-figures

# 变异自检
# 对每个关键判据做一次变异，确认 RED 后恢复
```

## 提交纪律

- 本地 git fetch/push 常 502 → 用 `gh api` REST 构造 commit/tree/ref（blob 必 `POST` 上传、`-F content=@file`；tree base_tree 只传改动路径；python 写临时 JSON 再 `--input`）。
- 推前 `compare base...head` 核对变更面只含本期文件。
- REST merge 必须 `-X PUT`；合并后核 `merge tree == CI head tree`。
- 部署只用 `deploy.yml`（web/api）；pi-runtime 无改动不部署。
- `pintuotuo` 9 容器与 `lnkpi-matting` 保持停止，未经授权不恢复。
