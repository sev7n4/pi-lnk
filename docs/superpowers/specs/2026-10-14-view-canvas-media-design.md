# view_canvas_media 视觉感知闭环设计（P0+P1）

> 缘起：生产对话中模型对「看得到生成的图吗」回答「只能看到节点元数据，看不到像素」。
> 取证结论（2026-10-14 会话分析）：模型没说谎——当时上下文里确实零图片。

## 1. 问题定性（四层缺口）

| 维度 | 现状 | 本 spec 是否处理 |
|---|---|---|
| A 时间 | 生成当轮可见（image-refine 缺省 on），2 轮后 T2 治理降级为占位文本 | P1 |
| B 能力 | 全仓没有「按需读画布图片」的工具；T2 占位承诺的 read_document 是断头路（仅文本） | **P0 根因** |
| C 指代 | SEL-REF 只传 id/title（指代≠注入已拍板）；指代后的取图能力缺失 | P0 间接覆盖（常驻工具自发现） |
| D 观测 | 图片降级/剔除无 metrics | 不处理（后续） |

关键事实：
- 上游 `ToolResultMessage.content` 原生支持 `(TextContent | ImageContent)[]`——image-refine 已在用。
- `fetchImageAsBlock`（`services/pi-runtime/src/tools/image-refine.ts`）：2MB 上限、mime 白名单、fail-soft，可直接复用。
- Nest `/agent/internal/get-node` 端点已存在（SessionNodeDto：sessionId+nodeId）。
- 截图模型 agnes-3.0-flash 命中 vision 白名单，**非能力问题**；该轮无侧栏 attachments ⇒ T1 直通返回 undefined。

## 2. P0：view_canvas_media 工具

- tier=read，**常驻**（AGENTS.md 判据：新工具未点名 ⇒ 必须常驻；且 P1 后 T2 占位文案点名它 ⇒ 按点名纪律也必须常驻）。
- 参数：`node_id?`（画布节点，缺省回落 `tc.focusNodeId`）、`url?`（直接媒体 url，覆盖侧栏芯片恢复路径）。优先级 node_id > url > focusNodeId。
- 执行：node_id → `get-node` 取 `data.url` → `fetchImageAsBlock` → ImageContent 进 tool result；文本 part 带 `{"canvasNode":"<id>"}` 锚。
- 失败一律 `{ok:false, error}` 文本，不抛错；video/audio/text 节点、无 url、fetch 失败（timeout/network/http/mime/too-large）分别给出可读原因。
- 已知边界：模型非视觉时图片会被 vendor `downgradeUnsupportedImages` 换成占位（BYOK `supportsVision` 必须显式声明，#123 既有纪律）；>2MB 拒绝（与 image-refine 同限，等 metrics 证明需要再引入缩图）。

## 3. P1：占位符修复 + 节点锚点

- `generation.ts` run_image_generation 附图路径：文本 JSON 增加 `canvasNode: p.node_id`。
- `payload-images.ts`：`labelFor` 除 `[I{n}=` 外提取 `"canvasNode":"<id>"`；有锚占位 = `[图片（画布节点 <id>）已从上下文移除，可用 view_canvas_media(node_id:"<id>") 取回]`；无锚占位恢复提示统一改为 `可调 view_canvas_media 重新查看`（替换断头承诺 read_document）。
- `read-document.ts` 非文本素材错误文案同步指向 view_canvas_media。

## 4. 不做什么

- 不做「画布全量图自动进上下文」（行业反模式：token 爆炸 + 旧图污染）。
- 不改 prompt-registry（L6 预算仅剩 3 字符）；发现语义由工具 description + 常驻下发承载。
- 不做 P2（SEL-REF digest 图片提示行）/ P3（降级 metrics），留待 P0/P1 验证后排期。
- 零 Nest / 零 web / 零 vendor 改动。
