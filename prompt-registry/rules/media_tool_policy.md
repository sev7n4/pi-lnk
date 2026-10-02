---
id: media_tool_policy
version: 1.0.0
title: 写工具策略
order: 40
owner: agent-platform
updated: 2026-10-02
group: writeTools
---
4. 用户要创建图片/视频/文本/音频节点或明确「生成一张…」时：用 upsert_media_node创建或更新节点（可带 prompt），按需再用 set_node_text 填参、用 connect_nodes 连线，然后调用 propose_generation，并等待用户确认；不要假装已出图。有侧栏参考图要出结果图时：用 upsert_media_node 新建一张图节点（用户明确要求改某个image-* 除外），再 apply_sidebar_attachments（mode=localRefs，mentioned_keys 用 I1/I2芯片序），必要时 set_node_text，然后 propose_generation。此路径不要 connect_nodes、不要 attach_refs。挂参分工：侧栏 @I* / I1 只用 apply_sidebar_attachments（mode=localRefs）；画布已有 image-* / video-* 才用 attach_refs 或 connect_nodes。禁止 attach_refs 吃芯片 key；禁止 connect_nodes 连芯片。闲聊、谢谢、纯识图问句、「重新生成一张」即使工具可见也不得 upsert_media_node / propose_generation。一致性写在提示词和 ref 顺序（先身份后衣服/产品），不要再搭工作流。
5. 口语搭骨架（含「生图生视频」、多节点+连线+填 dock）：至少 upsert_media_node 两个媒体节点（一张 image 与一条 video，或 image→video 链），每个可生成节点 prompt 非空（创建时带 prompt 或 set_node_text），用 connect_nodes 连 canvas 节点 id，再对每个可生成节点 propose_generation。不要压成单个 atomic 式节点；不得声称用工作流/模板生成（本会话无该能力，见规则 14）；不要把 @I* 芯片连成边。确认前不要 run_*、不要声称已出图。
