---
name: video-timeline-editing
version: "1.0.0"
description: 视频编辑时间线。当用户要求把画布上的镜头/图片/音频拼成成片、插入图片指定时长、裁剪或排序片段、叠加旁白配乐、设置导出分辨率/格式，或要求先保存时间线再显式渲染时使用。素材必须来自画布节点，禁止模型自报 URL。
---

# 视频编辑时间线（video-timeline-editing）

## 何时使用

- 多镜头短剧拼接、分镜成片合成、图片 + 视频混剪。
- 旁白 / 配乐叠加，最多 2 条音频轨，同一轨内片段不得重叠。
- 需要「先保存草稿，用户确认后再渲染」的视频剪辑。

## 标准流程

1. **建草稿**：用 `video_timeline_create(source_node_ids, title)` 按视觉顺序引用画布已有 image/video/audio 节点。返回值 `nodeId` 是草稿节点；此步**不渲染**，也不创建生成任务。
2. **编辑**：用 `video_timeline_edit(node_id, ops)` 调整片段。ops 支持 `add_visual / add_audio / move_visual / trim / set_volume / remove / set_export / request_render`。任何错误整批拒绝，画布不会产生半状态。
3. **请求确认**：确认要出片时，先调用 `video_timeline_edit(node_id, ops:[{op:"request_render"}])`，画布草稿进入 `status=pending_confirm` 且 `proposalKind=video_timeline_render`，用户可在卡片上查看并确认。
4. **渲染**：只有用户确认后，且节点仍带上述确认事实时，才调用 `video_timeline_render(node_id)`。渲染成功后画布新增独立成片视频节点，草稿保留。
5. **状态查询**：用现有生成状态能力查询 `generationRecordId`，不要自行宣称已导出。

## 硬约束

- 素材只能传画布 `node_id`；不要传 URL、文件路径或你认为存在的文件名。
- 视觉轨按 `trackOrder` 无缝拼接；音频轨按 `start_sec` 对齐；同一 `audio_track_index` 内区间不得重叠。
- 默认成片在画面结束时裁掉过长音频；只有用户明确要求保留完整尾段时才设置 `keep_full_audio_tail=true`。
- 保存 / 编辑不等于渲染；没有用户确认不得调用 `video_timeline_render`。
- 若渲染能力未启用，如实说明需要服务端开启，不要反复重试或改走普通视频生成。

## 工具可用性

- `video_timeline_create` / `video_timeline_edit` / `video_timeline_render` 均为常驻工具，按名字直接调用。
- 工具不在你的列表里时先 `tool_search` 关键词「视频时间线」。
