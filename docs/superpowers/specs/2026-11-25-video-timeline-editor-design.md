# 视频编辑时间线工具设计规格

> 状态：**已评审确认（2026-11-25）**；三项已拍板：① 渲染内核 = `mifi/editly` + FFmpeg 服务端 worker；② 节点形态 = 「时间线草稿节点」与「最终视频节点」两个节点；③ 三工具改**常驻集**并在 skill 正文按名点名（遵守 `AGENTS.md`「延迟工具必须被资产点名、未点名即不可达」硬规则）。  
> 日期：2026-11-25  
> 范围：`apps/web` 画布节点卡片、`apps/server` 时间线服务与渲染任务、`services/pi-runtime` 工具面、部署镜像与测试门禁。  
> 实施纪律：本规格被确认后，另起实施计划；本文件不授权写业务代码。

---

## 0. 结论先行

本项目不需要自研剪辑引擎。真正缺的是一条接线：

```
已有素材节点 ──引用──> 时间线草稿节点 ──编译──> Editly spec ──显式渲染──> 最终视频节点
```

三句话定义产品：

1. **素材不上传**：agent 用画布节点 id 引用已生成的视频 / 图片 / 音频；服务端按 `node_id` 反查 url 并做归属校验。
2. **保存 ≠ 渲染**：保存只写 `data.timeline` 并生成草稿节点；只有 `video_timeline_render` 或卡片「导出」按钮才启动渲染并生成最终视频节点。
3. **不新增节点类型**：草稿与成片都是现有 `video` 节点；区别在于草稿有 `data.timeline`、成片有 `url` + `mediaInfo`，二者用连线关联。

采纳的核心决策：

| 决策点     | 结论                                                                  | 理由                                                       |
| ------- | ------------------------------------------------------------------- | -------------------------------------------------------- |
| 渲染内核    | `mifi/editly`（MIT）+ FFmpeg                                          | 声明式 spec 与需求逐项对应；只做薄封装，符合「吃满上游」                          |
| 数据 SSOT | 扩展 `apps/web/src/utils/compositionUpstream.ts` 的 `CompositionTrack` | 已有 `trackOrder/durationSec/startSec/layout` 模型，当前缺的只是消费者 |
| 节点类型    | 复用 `video`，用 `data.timeline` 标记草稿                                   | 不改 `NODE_TYPES` / zod 白名单 / manifest，不触发节点类型连锁           |
| 节点形态    | 草稿节点 + 渲染后另生成成片节点                                                   | 不覆盖草稿，可重复渲染不同版本，状态机清晰                                    |
| 工具面     | 3 个延迟工具：`create` / `edit` / `render`                                | editor 工具合并所有编辑操作，避免工具爆炸；状态复用 `get_generation_status`    |
| 首期 UI   | 画布时间线卡片：可读、可导出；拖拽裁剪在 P1                                             | 先把工具闭环跑通，不把风险压到拖拽交互                                      |
| 运行时     | 服务端 worker，首期限并发 1                                                  | CVM 内存紧张；先正确性后吞吐                                         |

---

## 1. 第一原则：吃满上游、不重复造轮子

**声明**：任何新增判据 / 工具 / 数据字段 / 引擎，立项前必须过三判据——① 等价物检索；② 接线优先于新建，判据锚到既有结构化数据面；③ 禁造数 / 禁自报。本节逐项给出结论。

### *1.1* 开源等价物检索结论表

| 候选                       | 一手事实                                                                                                                                                                                                                                         | 结论                 | 本方案如何接线                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------- |
| `mifi/editly`            | MIT；5,653★；最后 push 2025-05；声明式 JSON/JSON5 spec；`clips[].duration`、`video.cutFrom/cutTo`、`image` layer、`audioTracks[].start/cutFrom/cutTo/mixVolume`、`clipsAudioVolume`、`keepSourceAudio`、`width/height/fps`、`outPath`；Node API + FFmpeg 流式合成 | ✅ **直接采用为渲染内核**    | 我方只做 `timeline -> Editly spec` 纯函数；所有裁剪/拼接/图片时长/多轨混音交给它 |
| `FFmpeg`                 | 默认 LGPL-2.1+；`--enable-gpl` 后 GPL；`--enable-nonfree` 产物不可再分发                                                                                                                                                                                 | ✅ 作为 Editly 底层 CLI | 镜像内固定版本与编译选项，禁止 nonfree；GPL 组合需在部署文档登记                  |
| `remotion-dev/remotion`  | 源码可见但为 Remotion License，非单一 OSI；个人 / ≤3 人公司 / 非营利可免费商用，较大公司须 Company License；React 组件即视频                                                                                                                                                     | ❌ 不采用              | 商业许可不确定，且对"拼接已有镜头"过重                                    |
| `OpenCut-app/OpenCut`    | MIT，99,325★，README 明说正在从零重写；classic 仓库已 archived                                                                                                                                                                                             | ⚠️ 仅作 UI 交互参考      | 不引入其引擎 / 依赖；时间线卡片布局可借鉴                                  |
| `MakeMyClip/editor`      | MIT，36★，活跃，FFmpeg + MCP + browser timeline                                                                                                                                                                                                   | ⚠️ 仅作 MCP 工具组织参考   | 不引入依赖；工具命名与描述风格可参考                                      |
| `tnfe/FFCreator`         | MIT，3,165★，最后 push 2024-12                                                                                                                                                                                                                   | ❌ 不采用              | 停更，且 Editly 的声明式 spec 更贴合                               |
| MLT / Shotcut / Kdenlive | LGPL/GPL 桌面 NLE 引擎栈                                                                                                                                                                                                                          | ❌ 不采用              | 过重，许可与部署面复杂                                             |

**取证边界**：Editly 文档明确 mp4/mkv/gif 输出；`.mov` 只作为输入示例出现。「默认把音频裁到画面结尾」未被文档直接保证；二者必须由 P0 冒烟测试与 golden fixture 锁死，不能靠口头假设。若 Editly 不直接支持，用 FFmpeg `-t` / remux 补齐，仍不引入第二套剪辑引擎。

### 1.2 本项目等价物检索结论表

| 候选等价物       | 真实路径 / 符号                                                                                                                                                                                                     | 结论          | 本方案如何接线                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| 时间线数据模型     | `apps/web/src/utils/compositionUpstream.ts`：`CompositionTrack`、`mergeCompositionTracks`、`applyTrackOrder`、`reorderTrackIds`、`compositionTracksToNodePatch`、`computeTimelineLayout`、`totalTimelineDurationSec` | ✅ 直接复用并最小扩展 | `type` 从 `video\|audio` 扩为 `video\|image\|audio`；字段新增 `sourceInSec/sourceOutSec/volume/muted/audioTrackIndex` |
| 节点类型白名单     | `packages/shared/src/index.ts:NodeType`；`packages/shared/src/agentContract.ts:NODE_TYPES`；`apps/web/src/components/canvas/NodeRenderer.vue`                                                                   | ✅ 不改动       | 草稿仍是 `video` 节点，`data.timeline` 是 `data: Record<string, unknown>` 内的合法字段                                      |
| 按节点引用素材     | `services/pi-runtime/src/tools/view-canvas-media.ts` + `/agent/internal/get-node`                                                                                                                             | ✅ 复用        | 工具层拿 `node_id` 后走 Nest 内部取节点，不接收模型自报 URL                                                                      |
| 媒体归属校验 / 暂存 | `apps/server/src/media/media.service.ts:resolveDownloadSource()`、`openDownloadStream()`                                                                                                                       | ✅ 复用        | 所有素材下载前先过账号归属校验，禁止 SSRF / 跨账号引用                                                                               |
| 画布写治理       | `apps/server/src/sessions/canvas-op-write.ts:transactGovernedCanvasOps()`                                                                                                                                     | ✅ 唯一合法写通道   | 草稿与成片节点的创建/更新全走事务内 `applyCanvasActions` + staged 守卫；新增写者须在治理测试白名单登记合规理由                                       |
| 生成任务与状态     | `services/pi-runtime/src/tools/canvas-read.ts:get_generation_status`；`GenerationRecord` 家族                                                                                                                    | ✅ 复用        | 渲染建立 GenerationRecord，模型/前端用既有状态通道轮询，不新建任务状态机                                                                 |
| 产物落库        | `apps/server/src/assets/persist-remote.service.ts:PersistRemoteService`                                                                                                                                       | ✅ 复用        | 渲染结果并经 `storage` adapter 落库，再写回成片节点 url                                                                       |
| 工具注册与渐进加载   | `services/pi-runtime/src/tools/registry.ts`、`tiering.ts`、`verify-tool-tiering`                                                                                                                                | ✅ 复用        | 3 个工具进延迟集；skill 只写能力描述引导 `tool_search`，不写死工具名                                                                 |
| 节点卡片        | `apps/web/src/components/canvas/CanvasNodeVideo.vue`、`NeoBaseNode.vue`                                                                                                                                        | ✅ 复用        | 新增 `VideoTimelineCard` 作为 `data.timeline` 分支，无 timeline 时保持现状逐字节不变                                            |

**检索结论**：需要新增的只有 4 类东西——**时间线到 Editly spec 的纯函数、渲染 worker、3 个工具及其 Nest 端点、画布时间线卡片**。不新增节点类型、不新建确认机制、不新建任务状态通道、不新建媒体存储通道。

### 1.3 禁造数 / 禁自报约束

- 素材来源必须是 `node_id` 或画布连线解析出的真实节点；模型传入的裸 URL 不作为渲染输入。
- 片段时长优先取服务端 `ffprobe` 实测值；`durationSec` 缺失时按默认 5s（视频）/ 3s（音频）并标记 `durationEstimated:true`，禁止把默认值冒充真实时长。
- 渲染成功必须有服务端事实：`GenerationRecord.status === 'succeeded'` 且产物 url 可被 `MediaService` 解析；不得用模型自述"已导出"当完成判据。
- 时间线编辑按钮若未接线，必须禁用并说明原因，禁止画假控件。

---

## 2. 目标与非目标

### 2.1 目标

支持以下用户意图，全部可由 agent 用画布节点完成：

1. 把多个视频镜头按顺序拼成一条完整成片。
2. 插入图片并指定显示时长；图片与视频混剪。
3. 对片段做裁剪、顺序调整、静音 / 音量控制。
4. 最多 2 条音频轨，可放背景音乐、旁白、环境音；同轨不重叠；音频与画面按秒对齐。
5. 成片默认在画面结束时裁掉过长音频；`keepFullAudioTail=true` 时保留完整音频尾段。
6. 设置导出文件名、分辨率（720p / 1080p / 2K / 4K）、容器（MP4 / MOV）、整体音量 / 静音。
7. 保存与执行分离：保存生成草稿节点；显式渲染/导出才生成最终视频节点。

### 2.2 非目标（首期）

- 不做转场、滤镜、关键帧、文字动画、画中画、字幕。
- 不做浏览器端 WebCodecs 渲染、不做客户端导出。
- 不做拖拽式时间线编辑器（P1）。
- 不做跨用户共享时间线模板、不做云端批量渲染队列。
- 不改变现有生成节点、资产库、分享链路语义。

### 2.3 成功判据

| 判据     | 可验证事实                                                                         |
| ------ | ----------------------------------------------------------------------------- |
| 引用而非上传 | 工具只接 `source_node_ids` / `node_id`；请求体不含文件内容与模型自报 URL                         |
| 保存不渲染  | `video_timeline_edit(save)` 后草稿节点有 `data.timeline`，无 `url`，无 GenerationRecord |
| 显式渲染   | 只有 `video_timeline_render` 或卡片导出按钮创建 GenerationRecord                         |
| 两节点    | 渲染成功后画布新增独立 `video` 节点（有 url/mediaInfo），草稿节点仍存在且用边连接                          |
| 音频约束   | 同 `audioTrackIndex` 区间重叠时工具返回结构化错误，不写画布                                       |
| 尾段语义   | 默认输出时长 == 画面轨总长；`keepFullAudioTail=true` 时输出时长 >= 画面轨总长                       |
| 产物可下载  | 成片 url 经 `MediaService.resolveDownloadSource()` 可解析并由前端下载                     |

---

## 3. 产品模型与画布映射

参考截图中的视觉结构：

- 左侧多个镜头节点（标题 + 1280×720 标识）→ 连线汇入右侧「视频成片：雨夜回家」卡片。
- 右侧卡片顶部：剪刀 / 删除 / 撤销 / 重做、`00:30/00:30` 播放头与进度、音量、导出按钮。
- 卡片主体：时间标尺（0:00 / 0:05 / …）+ 连续缩略图片段 + 片段内小数字标记（序号/时长）。

*本*规格的映射：

| 截图元素            | 实现载体                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| 镜头节点            | 现有 `image` / `video` 节点                                                     |
| 「视频成片」卡片        | `video` 节点 + `data.timeline` → `VideoTimelineCard`                          |
| 连线              | 现有 `add_edge`，由 create 工具自动建立（素材 → 草稿）                                      |
| 缩略图片段           | `tracks[]` 的 `url` / `title` / `durationSec`，经 `computeTimelineLayout()` 定位 |
| 时间标尺 / 播放头      | 卡片内只读时间轴；播放头点击可跳到对应片段首帧（P0 可降级为高亮）                                          |
| 剪 / 删 / 撤销 / 重做 | P0 渲染为禁用态并提示「用 agent 编辑时间线」；P1 接线                                           |
| 导出按钮            | 调与 `video_timeline_render` 相同的服务端端点，带显式确认                                   |

---

## 4. 数据模型与不变量

### 4.1 草稿节点

```ts
type TimelineNodeData = {
  status: 'draft' | 'queued' | 'rendering' | 'completed' | 'failed'
  title: string
  timeline: {
    version: 1
    clipCount: number
    trackOrder: string[]        // 视觉轨顺序；沿用既有 helper
    tracks: TimelineTrack[]     // 视觉 + 音频混列，按 type 分流
    export: TimelineExport
  }
  lastRenderRecordId?: string
  lastRenderedNodeId?: string
  errorMessage?: string
}

type TimelineTrack = {
  nodeId: string                // 真实画布节点 id，必填
  type: 'video' | 'image' | 'audio'
  title: string
  url: string
  durationSec: number           // 画面轨：显示时长；音频轨：选中源时长
  startSec: number              // 音频轨：在成片中的起点；视觉轨由 trackOrder 推导
  sourceInSec?: number
  sourceOutSec?: number
  volume?: number               // 0..2，默认 1
  muted?: boolean
  audioTrackIndex?: 0 | 1       // 仅 type==='audio'
  durationEstimated?: boolean
}

type TimelineExport = {
  fileName: string
  resolution: '720p' | '1080p' | '2k' | '4k'
  format: 'mp4' | 'mov'
  volume: number                // 0..2，默认 1
  muted: boolean
  keepFullAudioTail: boolean    // 默认 false
}
```

分辨率映射固定为：`720p=1280×720`、`1080p=1920×1080`、`2K=2560×1440`、`4K=3840×2160`（2K 明确取 QHD，避免歧义）。

### 4.2 成片节点

渲染成功后新建独立 `video` 节点：

- `data.url`：落库后的成片地址。
- `data.mediaInfo`：`ffprobe` 实测的时长、宽高、码率。
- `data.sourceTimelineNodeId`：草稿节点 id。
- `data.generationRecordId`：渲染任务 id。
- 现有边：素材 → 草稿；新增边：草稿 → 成片。

### 4.3 不变量

1. `tracks[].nodeId` 必须在当前 session 的画布中存在，且 type 与 `tracks[].type` 一致。
2. 视觉轨按 `trackOrder` 顺序无缝拼接，不允许空洞；`startSec` 对视觉轨只读推导。
3. `audioTrackIndex` 只能是 0 或 1；同一索引内 `[startSec, startSec+durationSec)` 不得重叠。
4. 音频轨 `startSec >= 0`；`sourceInSec >= 0`；`sourceOutSec > sourceInSec`；不得超出源时长。
5. `volume ∈ [0,2]`；`muted=true` 时有效音量为 0。
6. 草稿节点无 `url`；成片节点必有 `url`。
7. 文件名清洗后长度 1..120，去除路径分隔符、控制字符与首尾空白；缺扩展名时按 `format` 补齐。

---

## 5. 工具契约（pi-runtime，常驻集）

### 5.1 `video_timeline_create`

- tier：`write_light`
- 入参：`title`、`source_node_ids?`、`export?`
- 行为：`source_node_ids` 优先；省略时从 `focusNodeId` 的入边按边顺序解析素材，解析结果为空则返回结构化错误并要求显式传 `source_node_ids`。解析成功 → 生成 `tracks` / `trackOrder` → 通过 `transactGovernedCanvasOps` 创建草稿节点与连线。
- 返回：`nodeId`、`trackCount`、`estimatedVisualDurationSec`。
- 不创建 GenerationRecord，不渲染。

### 5.2 `video_timeline_edit`

- tier：`write_light`
- 入参：`node_id`、`ops: TimelineOp[]`、`save?: boolean`
- `TimelineOp` 联合：
  - `add_visual { node_id, at?, source_in_sec?, source_out_sec?, duration_sec? }`
  - `add_audio { node_id, audio_track_index, start_sec, source_in_sec?, source_out_sec?, volume?, muted? }`
  - `move_visual { from, to }`
  - `trim { node_id, source_in_sec, source_out_sec, duration_sec? }`
  - `set_volume { node_id, volume, muted? }`
  - `remove { node_id }`
  - `set_export { file_name?, resolution?, format?, volume?, muted?, keep_full_audio_tail? }`
  - `request_render {}`：仅把草稿置为 `status='pending_confirm'`、`proposalKind='video_timeline_render'`、`proposalEpoch+1`；不创建 GenerationRecord、不渲染。该 op 复用既有确认卡的呈现，但确认按钮必须路由到渲染端点，不得走普通视频生成。
- 行为：纯函数校验全部 ops → 一次事务写回草稿节点；任何错误整批拒绝，不写半状态。
- 返回：`nodeId`、`visualDurationSec`、`appliedOpCount`；错误时返回逐条 `opIndex` + 原因。
- `save=true` 只是显式语义标记，不触发渲染。

### 5.3 `video_timeline_render`

- tier：`gen`（走既有 generation gate；加入 `GATED_TOOLS`）
- 入参：`node_id`
- 前置：草稿节点必须处于 `status='pending_confirm'` 且 `proposalKind='video_timeline_render'`；该状态由 `video_timeline_edit(request_render)` 或卡片「导出」按钮经服务端 propose 端点写入，是用户可见的确认事实，不接受 `confirm_render` 这类模型自报字段。
- 行为：校验草稿与确认态 → 冻结 spec 快照 → 建 GenerationRecord → 异步 worker 渲染 → 落库 → 建成片节点与连线。
- 返回：`generationRecordId`、`draftNodeId`、`status:'queued'`。
- 状态查询复用 `get_generation_status` / `get_generation_diagnostic`。

### 5.4 发现路径与确认事实

三个工具都进**常驻集**，并在新增 skill `video-timeline-editing/SKILL.md` 正文按名字点名（满足 `verify-tool-tiering` A1「被点名工具必须常驻」）。这是对项目硬规则「`tool_search` 触发率 0 ⇒ 未点名的延迟工具不可达」的合规落地：不依赖模型主动搜索，也不在注释里写会被名单解析误判的字面量。

渲染确认复用画布 `pending_confirm` 状态机，但 proposal 必须带 `proposalKind='video_timeline_render'`；前端确认按钮按该 kind 路由到时间线渲染端点，禁止落回按节点类型自动启动的普通视频生成。`generation-gate` 对该工具只放行这一 proposal kind 的 `pending_confirm` 节点，堵住模型自报确认。

---

## 6. 架构与渲染管线

### 6.1 分层

| 层              | 责任                                                    |
| -------------- | ----------------------------------------------------- |
| pi-runtime 工具层 | 收集 `node_id` / ops，结构化错误，不持有业务逻辑                      |
| Nest 时间线服务     | 权限、节点解析、op 校验、草稿落库、渲染任务编排                             |
| shared 纯函数     | `timeline -> Editly spec`、时长计算、文件名清洗、不变量校验；可单测 golden |
| 渲染 worker      | 素材暂存 → 调 Editly → FFmpeg → 产物落库 → 回写状态                |
| web 卡片         | 读 `data.timeline` 展示；导出按钮走同一服务端端点                     |

### 6.2 编译规则

|   |   |
| - | - |

- 视觉轨：按 `trackOrder` 过滤 `video|image`，逐段生成 Editly `clips[]`。
  - `video` 层：`cutFrom=sourceInSec`、`cutTo=sourceOutSec`；`clip.duration=sourceOut-sourceIn`，避免 Editly 自动变速。
  - `image` 层：`clip.duration=durationSec`。
  - `mixVolume = muted ? 0 : volume`；`keepSourceAudio = any(visual.mixVolume>0)`。
- 音频轨：按 `audioTrackIndex` 分组并按 `startSec` 排序，生成 `audioTracks[]`：`start`、`cutFrom`、`cutTo`、`mixVolume = export.volume * track.volume`（`muted` 或 `export.muted` 时为 0）。
- 输出：`width/height` 来自 `export.resolution`；`outPath` 文件名按 `format` 取扩展名。
- 尾段：默认给 FFmpeg 输出加 `-t <visualDuration>` 保证画面结束即裁切；`keepFullAudioTail=true` 时不加 `-t`，并允许输出时长由最长音频决定。
- MOV：`outPath='.mov'` + 显式 container/codec 参数；具体参数在 P0 spike 用 golden fixture 固化，未经取证不写死 codec 字符串。


### 6.3 素材与产物

- 每个素材经 `resolveDownloadSource(userId, url, ..., sessionId)` 校验归属，流式写入 job 临时目录；远程源走已有 SSRF 防护。
- 临时目录按 job id 隔离；成功/失败/超时均清理。
- 产物通过 `PersistRemoteService.persistRemote()` 落库；最终节点写回走 `transactGovernedCanvasOps()`。

### 6.4 资源与部署

- 首期 worker 与 API 分离部署（独立容器/独立进程），并发上限 1；4K 任务单独限额。
- 2026-11-25 生产实测：`free -h` 显示 3.6Gi 总内存、487Mi 可用、swap 已用 2.8Gi；**扩容/独立 worker 资源到位前不部署渲染能力**。代码可先合并并让 create/edit 与只读卡片上线；render 端点在 `VIDEO_TIMELINE_RENDER_ENABLED=false` 时返回结构化不可用，卡片导出按钮禁用并说明原因，禁止画假控件。
- FFmpeg 镜像固定版本；禁止 `--enable-nonfree`；若启用 GPL 组件须在部署文档登记许可与源码提供义务。
- 部署流水线触发面会随 `apps/server` / `deploy` 改动而触发；文档-only 分支不触发生产部署。

---

## 7. UI 设计

### 7.1 画布卡片

新增 `apps/web/src/components/canvas/VideoTimelineCard.vue`，由 `CanvasNodeVideo.vue` 在 `data.timeline` 存在时条件渲染；无 timeline 时原模板不变。

内容：

- 顶部：标题（来自 `data.title`）、时长 `mm:ss/mm:ss`、音量图标、导出按钮。
- 主体：时间标尺 + 视觉轨缩略图连续排列 + 两条音频轨（若有）以波形/色块表示并按 `startSec` 定位。
- 底部：导出设置摘要（分辨率、格式、文件名）。
- 编辑图标：P0 禁用态 + tooltip「用 agent 编辑时间线」；P1 接入拖拽/裁剪/撤销重做。

### 7.2 状态

- `draft`：卡片正常显示，导出按钮可用。
- `queued/rendering`：卡片显示进度，导出按钮禁用，复用生成状态徽标。
- `completed`：草稿卡片保留，旁边出现成片节点与连线。
- `failed`：显示错误摘要与「重试渲染」，不清除草稿。

### 7.3 移动端

不新增移动端专属分支；`MobileNodeTile` 继续按现有类型展示。点开查看器时以只读列表展示时间线信息，不提供拖拽编辑（符合 AGENTS.md 移动端编排收敛规则）。

---

## 8. 安全与治理

- 所有素材 url 由服务端从画布节点解析，不由模型提供；跨账号节点引用返回 403。
- 文件名只用于展示与落库 key，不参与路径拼接；实际存储路径由服务端生成。
- 渲染输入 spec 是冻结快照；用户在渲染期间修改草稿不影响已排队任务。
- 草稿与成片写入都走 P1-C 合规通道；新增写者必须在 `canvas-write-governance.test.ts` 白名单逐条登记理由。
- 不绕过确认门：`video_timeline_render` 属 gen 工具并加入 `GATED_TOOLS`，但 `generation-gate.ts` 必须按 `proposalKind='video_timeline_render'` 放行（否则草稿 `draft` 态会被通用门拒绝）；不接受模型自报字段。UI 导出按钮必须经服务端 propose 端点写入同一确认事实，再由确认卡按钮触发渲染。
- 不改 prompt-registry 规则正文，避免 6 处同步；只新增 skill 正文点名三工具并保留其尾部 `## 工具可用性` 小节。

---

## 9. 测试与验收

### 9.1 纯函数

- `timeline -> Editly spec` golden：多镜头、图片混剪、2 条音频轨、音量/静音、2K/4K、MOV、尾段裁切与保留。
- 不变量测试：同轨重叠、非法 audioTrackIndex、越界裁剪、未知 nodeId、空视觉轨。
- 时长测试：默认时长带 `durationEstimated` 标记；`ffprobe` 回填后覆盖。

### 9.2 工具与治理

- `video_timeline_*` 的 TypeBox schema 镜像测试；错误路径返回结构化 `ok:false`。
- `verify-tool-tiering`：三工具在延迟集、无规则/技能点名工具名。
- `canvas-write-governance.test.ts`：新写者登记与数量核对。
- 权限测试：跨账号节点引用、伪造 URL、SSRF 目标全部拒绝。

### 9.3 集成

1. agent 从 3 个镜头节点创建草稿 → 无 url / 无 GenerationRecord。
2. 插入图片、设置音频起点与音量 → 保存后数据正确。
3. 同轨重叠音频被拒绝，画布未被写入。
4. 显式 render → 状态经 `get_generation_status` 变为 succeeded；新增成片节点且 url 可下载。
5. 默认音频尾段被裁到画面时长；`keepFullAudioTail=true` 保留完整尾段。
6. 渲染期间修改草稿不影响已排队任务。

### 9.4 生产取证（部署后）

- 用真实会话自建画布，3 镜头 + 1 图片 + 2 音轨，导出 1080p MP4。
- 证据：草稿节点、成片节点、GenerationRecord、产物 url、FFmpeg 实测时长/分辨率、前端卡片截图。

---

## 10. 风险与缓解

| 风险                           | 缓解                                            |
| ---------------------------- | --------------------------------------------- |
| Editly 最后 push 2025-05、维护节奏慢 | 精确 pin 版本；golden 测试锁行为；保留纯 FFmpeg 回退路径但不提前自研  |
| MOV / 音频尾段语义未被文档保证           | P0 spike 固化参数；未通过前不开放 MOV                     |
| FFmpeg 许可组合                  | 镜像构建显式记录编译选项；禁止 nonfree；GPL 组件登记              |
| CVM 内存不足                     | 独立 worker + 并发 1；扩容前不上线                       |
| 新增工具不可发现                     | 常驻集 + skill 正文逐字点名；不依赖 tool_search；展示契约 A5 登记 |
| 时间线卡片影响现有视频节点                | `data.timeline` 条件分支；无 timeline 时模板零变化 + 回归测试 |
| 草稿/成片状态混淆                    | 两节点 + 显式连线；草稿永不写 url                          |

---

## 11. 分期

### P0（本规格首期）

- 3 个工具、两节点模型、草稿卡片只读 + 导出按钮。
- 1080p/720p MP4 全链路；MOV/2K/4K 以 spike 结果解锁。
- 默认音频裁切、`keepFullAudioTail`、音量/静音、同轨不重叠。
- 完整测试与部署资源前置条件。

### P1

- 卡片内拖拽排序、裁剪手柄、两条音频轨波形、撤销/重做。
- 通过同一 `video_timeline_edit` 工具落库，复用 P0 校验。

### P2

- 转场、模板、批量渲染队列、管理员并发/成本策略。

---

## 12. 已定默认值（无需再拍板）

| 项                   | 默认值                                    |
| ------------------- | -------------------------------------- |
| 视觉轨片段默认时长           | 视频 5s / 音频 3s，并标 `durationEstimated`   |
| 2K 语义               | 2560×1440                              |
| 渲染并发                | 1                                      |
| 整体音量 / 片段音量         | 1（范围 0..2）                             |
| 音频轨数量               | 最多 2                                   |
| `keepFullAudioTail` | false                                  |
| 首期导出格式              | MP4；MOV 待 spike                        |
| 首期分辨率               | 720p/1080p；2K/4K 待资源评估                 |
| 工具 tier             | create/edit=`write_light`，render=`gen`；三者均常驻 |

---

## 13. 参考

- 开源项目：`github.com/mifi/editly`、`github.com/FFmpeg/FFmpeg`、`github.com/remotion-dev/remotion`、`github.com/OpenCut-app/OpenCut`、`github.com/MakeMyClip/editor`、`github.com/tnfe/FFCreator`
- 本仓：`apps/web/src/utils/compositionUpstream.ts`、`apps/web/src/components/canvas/CanvasNodeVideo.vue`、`apps/server/src/sessions/canvas-op-write.ts`、`apps/server/src/media/media.service.ts`、`apps/server/src/assets/persist-remote.service.ts`、`services/pi-runtime/src/tools/{registry,tiering,canvas-read,view-canvas-media}.ts`
- 规范：`AGENTS.md` 第一原则 / 移动端呈现；`docs/agent/delivery.md` 分支与测试纪律
