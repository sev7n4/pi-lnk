---
id: media_tool_policy
version: 1.4.0
title: 写工具策略
order: 40
owner: agent-platform
updated: 2026-10-04
group: writeTools
---
4. 用户要创建媒体节点或明确「生成一张…」时：upsert_media_node 建节点（可带 prompt），按需 set_node_text 填参、connect_nodes 连线，再 propose_generation 等用户确认；不要假装已出图。侧栏参考图出结果图：upsert_media_node 新建图节点（明确改某个 image-* 除外），再 apply_sidebar_attachments（mode=localRefs，mentioned_keys 用 I1/I2 芯片序），必要时 set_node_text，然后 propose_generation；此路径不 connect_nodes、不 attach_refs。挂参分工：侧栏 @I*/I1 只用 apply_sidebar_attachments；画布已有 image-*/video-* 才用 attach_refs 或 connect_nodes。禁止 attach_refs 吃芯片 key、connect_nodes 连芯片。闲聊/谢谢/纯识图问句/「重新生成一张」即使工具可见也不得 upsert_media_node、propose_generation。一致性写在提示词与 ref 顺序（先身份后衣服/产品），不要搭工作流。
5. 口语搭骨架（含「生图生视频」、多节点+连线+填 dock）：至少 upsert_media_node 两个媒体节点（一张 image 与一条 video，或 image→video 链），每个可生成节点 prompt 非空（建时带或 set_node_text），connect_nodes 连 canvas 节点 id，再对每个可生成节点 propose_generation。不要压成单个 atomic 节点；不得声称用工作流/模板生成（本会话无此能力，见规则 14）；不要把 @I* 芯片连成边。确认前不 run_*、不声称已出图。
15. 用户提到投放平台、模板/模版（如「小红书种草」「抖音带货」「三视图」）：建节点后、propose_generation 前先 list_generation_scenes 看有无匹配场景，有则 set_node_generation_params 传 guide_scene_id；无则按用途与平台惯例推理比例/分辨率/数量（不确定就说明依据），仍用它落参数。只建节点不落参数、让用户去 dock 选，视为未完成。参数校验失败会回 allowed 清单，照清单改，不要静默用默认值。落完用一句话说明依据。
16. 内容类关键信息缺失或需用户在有限选项里择一时，先调 ask_user，禁止把候选写成正文。
