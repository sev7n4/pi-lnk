# P1 工具立项设计规格：read_document / save_memory / recall_memory（task_plan 移交 UX P0-P2）

状态：已实现并通过独立终审（①A + ②-⑥ 按推荐默认；2026-09-29 终审后按 I-1/I-2 修订检索语义与 §10 用例数）
前置：pi-runtime 工具注册体系（已上线 0.0.13，PR #65/#66）；Nest `/agent/internal/*` 服务间鉴权通道（x-lnkpi-service-token，在用）；`toolContext.attachments` 注入链路（session-manager.ts:193，已存在）
分支约定：实现走 feature 分支 + PR + squash merge；本 spec 落盘时主工作区被并行分支占用，文件随实现分支首 commit 带入 master。

## 0. 配图索引（结构与视觉两类，均随本文档演进）

本文档的图分两类：**结构图**一律以 Mermaid 内嵌；**视觉稿**以 `assets/` 下的 SVG 附件承载（相对路径引用）。本规格只有结构图，无视觉稿（纯后端工具契约，无 UI 像素级布局）。

| 编号 | 形式 | 内容 | 位置 | 用途 |
|---|---|---|---|---|
| 图 1 | 内嵌 Mermaid flowchart | read_document（零 Nest 链路）与 save/recall_memory（Nest internal + prisma 落库）两条调用链 | §5 | 验收边界：read_document 不新增任何端点；memory 是本包唯一跨 pi-runtime/Nest/DB 三层的新链路 |

## 1. 目标

1. 补齐**素材感知闭环**：`read_document`——侧栏 text 素材目前只有 200 字标签进 prompt（`sidebar-block.ts` F6 截断），agent 无法按需读全文；本工具让模型凭 ref key 主动拉取全文
2. 补齐**跨会话记忆**：`save_memory` / `recall_memory`——agent 对用户偏好的记忆目前完全随会话销毁（每轮重建 pi 会话，多轮记忆仅靠 compressRecentTurns 4 轮注入）；本工具提供显式、用户可感知的长期记忆读写
3. **范围裁决**：`task_plan` 从 P1 移除、并入已合入 master 的 UX P0-P2 spec（`2026-09-28-agent-conversation-ux-p0-p2-design.md`）的 todo 实现——单一机制原则，避免 prompt 标记版与 ui_command 工具版两套计划契约并行漂移

## 2. 范围（含明确不做）

**在范围**：
- pi-runtime 新增 `read_document` 工具（tier=read，新文件 `tools/read-document.ts`）：读 `tc.attachments`，ref key 精确匹配返回全文，零 Nest/DB 改动
- pi-runtime 新增 `save_memory` / `recall_memory`（tier=read 与 write_light，新文件 `tools/memory.ts`）：经 nest-client 调 Nest 新端点
- Nest 新增 internal 端点：`POST /agent/internal/memory-save`、`POST /agent/internal/memory-search`（`agent-canvas-tools.controller.ts` 同款 internal 鉴权 + DTO 模式）
- prisma 新增 model `AgentMemory` + migration（provider=sqlite）
- `tools/config.ts` 装配：三工具**无条件注册**（read_document 不依赖外部服务；memory 依赖的 Nest 是 pi-runtime 存在前提，无需降级开关）
- `tools/config.test.ts` 工具总数断言 35→38（有 TAVILY）/ 33→36（无 TAVILY）

**不在范围**（显式不做，避免隐性范围）：
- 不做 memory 的用户确认面板（ChatGPT「已记住」toast 式交互）——v1 由工具返回文案承载，等真实使用反馈再立项（§12）
- 不做 memory 删除/更新工具——v1 只进不出，避免误删不可逆；清理由 DB 侧人工处理
- 不做向量检索 / 嵌入调用——sqlite + 关键词 LIKE + 时间序，记忆量到数百条前无检索质量问题（YAGNI，§12 登记升级路径）
- 不做 image/video/audio 素材的 read_document 化——图片已走视觉解析（`imageUrlsForParse`），音视频无文本可读，返回指引性错误
- 不做 task_plan 工具——移交 UX P0-P2（§1.3 裁决，§12 登记）
- 不改 vendored pi harness、不动 `SidebarAttachment` shared schema（Nest 侧验证已足够，pi-runtime 侧"不再清洗"契约不变）

## 3. 与既有规格的关系

- **显式复用** `truncateMarkdown`（`tools/web.ts`，PR #65）——read_document 与 web_fetch 共用同一 20k 窗口 + `start_index` 续读语义，同包内 import，不新建 util 文件
- **显式复用** `LnkpiToolContext.attachments`（`tools/types.ts:35`）——Nest 每轮经 `/sessions` body 原样透传，本包零注入链路改动
- **显式复用** `NestClient.post` + `userId` fail-closed 模式（`canvas-write.ts` 现有）——memory 两工具同款
- **显式复用** Nest internal 端点三件套：`@Post` + DTO + 服务间 token guard（`agent-canvas-tools.controller.ts:982` remove-nodes 同款）
- **显式移交** task_plan → UX P0-P2 spec §2.2 的 plan 标记实现（`⟦plan⟧` prompt 标记 + `task_list`/`task_update` 事件 + 休眠的 `agentTaskProgress.ts` 前端）；若未来仍需独立工具，只允许在该通道上加工具，不得另起事件契约
- **显式推翻** 无：不修改任何现有工具的 schema/tier/语义

## 4. 规范与判据

- **不猜判据（read_document）**：ref 匹配只认精确命中（refKey 或素材 id）；不命中时返回附件清单（refKey + mediaType + 文本预览 80 字）并要求模型重查——对标 Claude Code「精确 handle，不模糊猜测」；模糊 label 匹配在多附件同名时静默读错素材，危害大于「读不到」
- **单一窗口判据**：全文超过 20k 字符时截断 + `next_start_index`，与 web_fetch 行为完全一致——agent 只需学一种「长文本续读」模式
- **fail-closed 判据（memory）**：`tc.userId` 缺失 → execute 抛错（对齐「需 userId 的工具侧 fail-closed」既有红线）；`sessionId` 同样只取 `tc.sessionId`，schema 不暴露给模型
- **检索简单化判据**：`recall_memory` 无 query = 按时间倒序取近期；有 query = **大小写不敏感的子串匹配**（终审 I-1/I-2 修订）——SQL `LIKE`/Prisma `contains` 已弃用，原因有二：① sqlite 的 LIKE 对 ASCII **大小写不敏感**（原规格记为「敏感」，实测写反）；② `%`/`_` 在 LIKE 中是通配符，用户说「折扣 50%」时查 `50%` 会退化成通配召回无关记忆，而 Prisma 不支持 ESCAPE 子句。改为拉取最近 `MEMORY_SCAN_MAX=200` 条后 JS 侧 `toLowerCase().includes()` 过滤；已知限制：记忆条数超过 200 时仅扫描最近 200 条（§12 登记升级路径）
- **记忆写入无审批判据**：save_memory 免确认直接落库——v1 价值验证优先；工具返回文案带「已记住：{content 前 50 字}」供模型透传给用户，保持记忆写入对用户可见

## 5. 架构与契约

**图 1 · read_document（零 Nest 链路）与 save/recall_memory（Nest internal + prisma 落库）调用链**

```mermaid
flowchart LR
    subgraph read_document 链路（零 Nest 改动）
        M1[模型调 read_document<br/>ref=T1] --> T1[pi-runtime<br/>tools/read-document.ts]
        T1 -->|读 tc.attachments<br/>refKey/id 精确匹配| C1[命中: 全文<br/>20k 截断 + start_index]
        T1 -->|不命中: 附件清单<br/>让模型重查| C2[不猜]
    end
    subgraph memory 链路（唯一跨三层新链路）
        M2[模型调 save_memory / recall_memory] --> T2[pi-runtime<br/>tools/memory.ts<br/>userId fail-closed]
        T2 -->|nest-client.post| N1[Nest internal<br/>memory-save / memory-search<br/>x-lnkpi-service-token]
        N1 --> DB[(prisma sqlite<br/>AgentMemory)]
    end
```

### 5.1 read_document 工具契约

- name：`read_document`；tier：`read`
- parameters：`{ ref: string, start_index?: number }`
  - `ref`：侧栏素材引用键（`T1`/`I1`/`V1`/`A1`，大小写不敏感）或素材 id（Nest 透传的完整 attachments 对象含 id 字段，pi-runtime 类型收窄前以 `(item as {id?:string}).id` 宽容读取）
  - `start_index`：续读偏移，缺省 0；非负整数，execute 内兜底
- 匹配算法：按 `tc.attachments` 顺序复刻 `assignSidebarRefKeys`（`packages/shared/src/sidebar-block.ts` 的 T/I/V/A 计数法）计算 refKey（纯函数 `resolveRef`，随包测试）；`ref` 与 refKey（大小写折叠）或素材 id 精确相等即命中
- 命中且 `mediaType==="text"` 且 `text` 非空 → `truncateMarkdown(text, start_index)`，返回 `{ ok, text, start_index, next_start_index|null, total_length, ref }`（**textResult 形态，无 details.actions——本工具不产 CanvasAction**）
- 命中但非 text 素材 → 错误文案：「{ref} 是 {mediaType} 素材，read_document 仅支持文本素材；图片素材已随对话注入视觉解析」
- 未命中 → `{ ok:false, error:"ref {ref} 不存在", attachments:[{ref, mediaType, preview(80)}] }`，HTTP 层仍 200（不进 trace 错误分支），由模型依据清单自纠
- `tc.attachments` 缺失/空 → `{ ok:false, error:"本会话没有侧栏参考素材", attachments:[] }`

### 5.2 save_memory / recall_memory 工具契约

- `save_memory`：tier `write_light`；parameters：`{ content: string }`（1..2000 字符，execute 内截断到 2000 并在返回中注明 `truncated:true`）
  - Nest 端点：`POST /agent/internal/memory-save`，DTO `{ userId: string, content: string }`，返回 `{ id, createdAt }`
  - pi-runtime 返回：`{ ok, id, createdAt, note:"已记住：{content 前 50 字}（跨会话生效，用户可要求你随时回顾）" }`——textResult 形态
- `recall_memory`：tier `read`；parameters：`{ query?: string, limit?: number }`（limit 1..50，缺省 10，execute 内夹取）
  - Nest 端点：`POST /agent/internal/memory-search`，DTO `{ userId: string, query?: string, limit?: number }`，返回 `{ items: [{ id, content, createdAt }] }`（按 createdAt 倒序；有 query 时按**大小写不敏感子串**过滤，扫描窗口 `MEMORY_SCAN_MAX=200` 条）
  - pi-runtime 返回：`{ ok, count, items }`；count=0 时附 `note:"没有相关记忆"`（有 query 时追加提示「可尝试其他关键词或去掉 query 拉取最近记忆」）
- 鉴权与安全：两端点挂在既有 internal guard 之后（服务间 token）；`userId` 由 pi-runtime 从 `tc.userId` 取（Nest 注入，模型入参不可覆盖），Nest 侧不再信任 body 之外的来源

### 5.3 prisma model

```prisma
model AgentMemory {
  id        String   @id @default(cuid())
  userId    String
  content   String
  createdAt DateTime @default(now())

  @@index([userId])
  @@map("agent_memories")
}
```

不做 userId+content 唯一约束——用户重复嘱托同一偏好时允许重复写入，由 recall 时间序自然让最新条目优先。

## 6. 主场景规格（可验收）

1. 用户上传纯文本素材并说「参考 T1 全文改写这段文案」→ 模型调 `read_document {ref:"T1"}` → 拿到全文（≤20k 一次读完；>20k 时模型带 `start_index` 续读）→ 不再只见 200 字标签
2. 模型调 `read_document {ref:"I1"}`（图片素材）→ 收到指引性错误，转而依赖既有视觉解析，不重试浪费轮次
3. 用户说「记住：我的品牌色是 #0F4C81」→ 模型调 `save_memory` → 返回「已记住：…」→ **新开会话**后用户问「我的品牌色是什么」→ 模型调 `recall_memory {query:"品牌色"}` → 命中并回答
4. 大小写不敏感子串匹配：存入「Brand Color Is #0F4C81」后 `recall_memory {query:"brand color"}` **命中**（终审 I-1 修订：sqlite LIKE 对 ASCII 大小写不敏感，原规格写反）
5. `recall_memory {query:"折扣 50%"}` 只命中字面含「50%」的记忆，**不**退化成通配召回全部（终审 I-2 修订）
6. `recall_memory {query:"无关词"}` 未命中 → 模型收到「没有相关记忆；可尝试其他关键词，或去掉 query 拉取最近记忆」
7. 工具总数断言：有 TAVILY env 时 38、无时 36（config.test.ts）

## 7. 数据与状态变更

- sqlite 新表 `agent_memories`（§5.3）；migration 由 `prisma migrate dev` 生成，随 PR 入库
- 无既有表结构变更、无数据回填；删表回滚 = migration down，无不可逆风险
- pi-runtime 无状态（memory 全落 Nest/DB），pod 重建零迁移

## 8. 纯函数与算法

- `resolveRef(attachments, ref)` → `{ index, item } | null`：复刻 T/I/V/A 计数（`assignSidebarRefKeys` 同算法），refKey 大小写折叠比对 + id 精确比对；node:test 全覆盖（含空列表、未知 mediaType 跳过、同类型多素材计数、大小写）
- 截断：复用 `web.ts` 的 `truncateMarkdown`，不复制不移动（同包 import；若 PR 期间 web.ts 重构挪位，以实现分支实际为准更新 import）
- 记忆截断/夹取：`content.slice(0,2000)`、`Math.min(Math.max(limit,1),50)`——execute 内兜底（harness 不做 schema 校验，默认值必须 execute 内落地）

## 9. 文件级改动清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `services/pi-runtime/src/tools/read-document.ts` | 新增 | read_document 工具 + resolveRef 纯函数 |
| `services/pi-runtime/src/tools/read-document.test.ts` | 新增 | resolveRef + 工具行为（命中/非 text/未命中清单/空 attachments/截断续读） |
| `services/pi-runtime/src/tools/memory.ts` | 新增 | save_memory / recall_memory（nest-client.post，userId fail-closed） |
| `services/pi-runtime/src/tools/memory.test.ts` | 新增 | 两工具行为（fail-closed / 截断夹取 / Nest 调用路径与 body / 空结果 note） |
| `services/pi-runtime/src/tools/config.ts` | 修改 | 装配三工具（无条件注册） |
| `services/pi-runtime/src/tools/config.test.ts` | 修改 | 总数断言 35→38 / 33→36 |
| `services/pi-runtime/src/tools/registry.ts` | 修改 | re-export 新工厂 |
| `apps/server/src/agent/agent-canvas-tools.controller.ts` | 修改 | 新增 memory-save / memory-search 端点 + DTO |
| `apps/server/src/agent/agent-canvas-tools.service.ts` | 修改 | 新增 saveMemory / searchMemory（prisma 读写） |
| `apps/server/prisma/schema.prisma` + `migrations/` | 修改 | AgentMemory model + migration |

## 10. 测试策略与验收标准

- pi-runtime：node:test + tsx，read-document 6 用例、memory 7 用例（含 recall fail-closed 回归锁，spec §10 契约红线）；全量 `pnpm test` 绿；`tsc --noEmit` 过
- Nest：agent-canvas-tools.service 测试补 save/searchMemory 用例（含 query 空与缺失分支）；server 侧 vitest 绿
- 契约红线测试：memory 工具在 `tc.userId` 缺失时抛错（fail-closed 回归锁）；read_document 未命中时绝不返回任何素材全文（不猜回归锁）
- 生产验收（部署后）：① `curl localhost:30100/skills` 同法确认工具注册数；② 前端侧栏传 text 素材让 agent 读全文（场景 §6.1）；③ save → 新会话 → recall 闭环（场景 §6.3）；④ imageID digest 比对 + dist 特征串（read-document.js / memory.js）双验证
- 部署顺带铁律：`--set env.PI_RUNTIME_VERSION=<tag>` 同步（healthz 版本一致性）；构建上下文 = monorepo 根

## 11. 决策点（已拍板，2026-09-29，按推荐默认）

| # | 决策 | 结论 | 对标理由 |
|---|---|---|---|
| ① | task_plan 归属 | **A：移交 UX P0-P2**，P1 仅 read_document + memory 两件 | 单机制原则；Codex/Claude 的 plan/todo 均单链路；UX spec 契约已定，工具只在其通道上加 |
| ② | read_document 匹配 | refKey/id 精确匹配，miss 返回清单不猜 | Claude Code 精确 handle；模糊匹配同名素材会静默读错 |
| ③ | 截断策略 | 复用 20k 窗口 + start_index | 与 web_fetch 同一模式，agent 只学一种续读 |
| ④ | memory 工具形态 | 分立 save_memory / recall_memory | Claude Code memory 族分立动作；description 各写时机，调用准确率高 |
| ⑤ | 存储检索 | AgentMemory 表 + LIKE + 时间序，不做向量 | ChatGPT/Claude memory v1 同款；数百条前无检索质量拐点，零新增基建 |
| ⑥ | 写入确认 | v1 无确认面板，返回文案承载可见性 | ChatGPT 确认 toast 也是 v2 才加；先价值验证 |

## 12. 后续包 / 路线图（本包外，登记避免隐性范围）

- memory 用户确认面板（save 前卡片确认/「已记住」toast）——等 v1 使用反馈
- memory 删除/更新（forget_memory 或 recall 返回项带 id 的 delete）——与确认面板一起立项
- 检索升级（终审 I-2 登记）：记忆条数超过 `MEMORY_SCAN_MAX=200` 后，关键词检索只覆盖最近 200 条——届时改为 FTS5（sqlite 内置全文索引，支持转义与大小写选项）或向量检索（pgvector / 嵌入调用）
- task_plan 工具化——UX P0-P2 落地后，若标记方案不够用，在 task_list/task_update 事件通道上加工具，不得另起契约
- read_document 扩展 URL 素材正文抓取（url 有值且 mediaType=text 的网页类素材）——与 web_fetch 去重后评估

## 13. 配图规范自检

- §0 表格覆盖全文所有图（图 1）；Mermaid 中文标签无特殊字符冲突；表格列数与表头一致；无孤儿图引用——`pnpm verify-spec-figures --file docs/superpowers/specs/2026-09-29-agent-tool-p1-read-document-memory-design.md` 过检为准
