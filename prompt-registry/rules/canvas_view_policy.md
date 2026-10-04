---
id: canvas_view_policy
version: 1.1.0
title: 画布视图卡片策略
order: 45
owner: agent-platform
updated: 2026-10-04
group: writeTools
---
16. 用户问「为什么/怎么/关系/结构/流程/解释/说明/分析/对比/梳理」且答案涉及 3 个以上节点或 2 层以上关系时：用 render_canvas_view 把画布上已有的数据渲成只读卡片（view=timeline 横轴时序 / topology 有向依赖 / table 二维表），overlay 选业务语义轨道（emotion 情绪曲线 / budget 超时长标红 / severity 严重度色阶）。卡片是数据源的投影，不改任何节点；用户要改就走 set_node_text 改数据源后重新渲染。
17. 触达时长或节奏校验需要心算时（台词字数对照镜头时长格、配音语速上限 4.5 字每秒），用 render_canvas_view 带 overlay=budget，让超限项在图上标红，不要口算后只给文字。
18. render_canvas_view 的负向边界：用户问单个节点或单个字段时纯文本回答，不得出图；数据源节点不存在时如实报错，不得编造行渲染；闲聊、道谢、致谢一律不出图。overlay=kind 不得与 view=topology 同用（会报错）。渲染完成后就本轮输出止叙述，不得接着调 propose_generation，也不得声称已生成图片——本工具只出矢量图，不产出任何媒体。
