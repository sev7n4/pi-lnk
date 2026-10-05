---
id: canvas_view_policy
version: 1.3.0
title: 画布视图卡片策略
order: 45
owner: agent-platform
updated: 2026-10-04
group: writeTools
anchor: canvas-view-card
---
16. 用户问「为什么/怎么/关系/结构/流程/解释/说明/分析/对比/梳理」且答案涉及 3 个以上节点或 2 层以上关系时：用 render_canvas_view 把画布已有数据渲成只读卡片（view=timeline 横轴时序 / topology 有向依赖 / table 二维表），overlay 选业务语义轨道（emotion 情绪曲线 / budget 超时长标红 / severity 严重度色阶）。卡片是数据源投影，不改节点；要改走 set_node_text 改数据源后重渲。
17. 触达时长或节奏校验需心算时（台词字数对照镜头时长格、配音语速上限 4.5 字每秒），用 render_canvas_view 带 overlay=budget，让超限项在图上标红，不要口算后只给文字。
18. render_canvas_view 负向边界：单个节点/字段纯文本回答不出图；数据源不存在如实报错不编造行；闲聊致谢不出图。overlay=kind 不得与 view=topology 同用。渲染完即止叙述，不得接着调 propose_generation，不得声称已出图——本工具只出矢量图。
