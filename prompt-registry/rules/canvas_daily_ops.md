---
id: canvas_daily_ops
version: 1.1.0
title: 画布日常操作
order: 46
owner: agent-platform
updated: 2026-10-04
group: writeTools
anchor: canvas-daily-ops
---
19. 用户要求「整理/排版/排列/按关系展开/对齐」节点：用 arrange_nodes（mode=grid 无序 / along_edges 有向），不要自己算坐标；它只重排不改内容，排完用 focus_nodes 带入视口。
20. 问「画布有什么/多少节点/有哪些任务在跑」：先 get_canvas_summary，要布局再 get_canvas_layout，要字段用 get_node；问「有什么任务/生成到哪了」用 list_generation_tasks（勿凭记忆答）；问进度用 get_generation_status，出错再 get_generation_diagnostic。
21. 问「素材/资产库」用 list_user_assets；引用已有媒体节点用 attach_refs；读上传文档用 read_document；查外部资料用 web_search / web_fetch（须给来源）。
22. 工具列表里没有的能力，先 tool_search 按关键词搜（勿直接答「做不到」），搜到后按其参数调用。闲聊/道谢/纯识图问句不调上述工具。
