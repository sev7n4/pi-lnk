# 记忆作用域隔离设计规格（AgentMemory scope / sessionId）

> **For agentic workers:** 实施计划见 `docs/superpowers/plans/2026-10-03-agent-memory-scope-isolation.md`。

**Goal:** 把 `agent_memories` 从「按 userId 一个作用域」拆成 **画布（canvas）/ 用户（user）两级作用域**，
并让 `recall_memory` 的返回显式自曝「这条来自哪个作用域、是否跨画布」，从根上掐掉「A 画布的记忆被当成 B 画布当前观察内容」的归因错误。

**Architecture:** 记忆仍然只落 Nest/SQLite（pi-runtime 无状态不变）；改动分三跳——
① Prisma 模型加 `scope` / `sessionId` / `source` 三列 + 复合索引；
② `save_memory` 默认写画布作用域（只有显式 `scope:'user'` 才跨会话），`recall_memory` 按 scope 过滤并把归属信息随条目返回；
③ pi-runtime 侧从 `toolContext.sessionId` 取画布 id 透传给 Nest（工具上下文已有该字段，无需 vendor 改动）。

**Tech Stack:** NestJS + Prisma(SQLite) + Fastify(pi-runtime) + TypeBox 工具契约 + prompt-registry。

**Spec:** 承接 `docs/superpowers/specs/2026-09-29-agent-tool-p1-read-document-memory-design.md`（P1 记忆工具立项）
与生产取证结论（.workbuddy/memory/2026-10-03.md）。

---

## 1. 背景：本次事故与取证结论

生产会话 `cmur1im5y0002lk01vukfb949`（http://119.29.173.89:8888/workflow/cmur1im5y0002lk01vukfb949）：
用户发了一张图问「你能看到这张图是什么吗」，模型回答「根据项目上下文和消息历史，**这张图应该是短剧《小熊和小爸爸》主角"小柚"的角色设定图**」，
并给出 6 岁东亚女孩、圆脸黑大眼、齐刘海低马尾、米白毛衣+卡其背带裙、浅棕毛绒小熊玩偶等**逐字重合的细节**，外加「窗边木地板 / 写实摄影暖侧逆光」这类无出处描述。

取证（读 Nest SQLite + `AgentMessage.metadata.executionEvents` 内的模型 thinking 全文）：

| 事实 | 证据 |
|---|---|
| 模型本轮**真的调过 `recall_memory`**，返回的就是记忆 `cmuo19fms001gph010veuxeab`（**2026-09-30 存于另一画布**） | `executionEvents` 中 `{type:'tool_call', data:{name:'recall_memory'}}` |
| 记忆原文 = 「短剧《小熊和小爸爸》项目信息…主角：6岁小女孩小柚（圆脸、黑眼、齐刘海低马尾、米白毛衣+卡其背带裙、标志小熊玩偶）」 | 与模型回复逐字对应 |
| 模型自白「从我的记忆库中…但我需要诚实地说明我无法直接查看图片内容」「我的工具中没有直接查看图片的工具」 | 同上 |
| 记忆检索**只有 `where:{userId}` 一个条件**，表上无 canvasId / sessionId / projectId | `apps/server/src/agent/agent-memory.service.ts:60-64` |

**故障链判定：** 主模型没有图片通道（断点在 `session-manager.ts` 的 `lane.prompt(text, undefined, ctx)` 第二参恒 undefined，多模态直通只落地文档）
＋ 侧栏识图兜底块走了失败分支（返回「未能识别」）＋ 记忆跨画布可捞 ⇒ 模型把**记忆内容当成了图片内容**输出。
**所以本 spec 只治「记忆跨作用域泄漏 + 无归属自曝」这一半；图片通道是独立议题，不在此范围。**

## 2. 目标 / 非目标

**目标**

- G1：同一用户的 **A 画布写下的情节记忆，默认不得在 B 画布被 `recall_memory` 召回**。
- G2：任何被召回的记忆必须**自曝作用域**（`scope` / `sessionId` / 是否跨画布），模型有据可依地判断「这是记忆，不是当前观察」。
- G3：真实跨会话偏好（品牌色、账号暗号、分辨率偏好）**仍然跨画布可召回**——不能为了隔离把有用记忆一刀切没。
- G4：现有 30 条记忆 **零丢失**（先保守保持现状，再按规则收紧到画布作用域）。

**非目标（明确不做）**

- 不做 thread 级作用域（理由见 §3.2）。
- 不做「服务端自动抽取摘要写入 user 层」（那是 v1.1 curated memory，见 §7 展望）。
- 不做记忆删除/遗忘 API（`delete_memory` 另立议题）。
- 不动图片通道、不动 BYOK 的 `input:["text"]` 门禁。

## 3. 作用域模型

### 3.1 两级（默认 canvas 优先）

| scope | 归属 | 可见范围 | 典型内容 | 写入方式 |
|---|---|---|---|---|
| `canvas` | `sessionId`（= 画布 id，`Session.id`） | **仅该画布**（同 sessionId） | 项目知识、角色/场景设定、本轮产出约定、临时结论 | `save_memory` **默认**，工具不传 scope 时即此 |
| `user` | `userId` | 该用户**全部**画布 | 偏好、品牌规则、账号/暗号、跨项目固定指令 | `save_memory {scope:'user'}` **显式**声明 |

不变式（写进代码注释与测试）：
- `scope='canvas'` ⇒ `sessionId` 必非空；`scope='user'` ⇒ `sessionId` 为空（DB 层只能靠应用层保证，见 §4）。
- **记忆永不自动注入**：召回仍由模型主动调 `recall_memory` 触发，不做 ambient injection（与现状一致）。

### 3.2 为什么不做 thread 级（否决理由，留档）

1. `AgentThread` 有 `thread_forked`（前端 `apps/web/src/components/agent/AgentSideRail.vue:433` 的 fork 会复制历史）；
   thread 作用域的记忆会在 fork 时**静默复制/分裂**，隔离语义不可预测。
2. 线程的工作集本就躺在 `AgentMessage` 历史里（`Session → AgentThread → AgentMessage` 已存在），再叠一层记忆作用域**没有增量价值**。
3. 画布（Session）才是用户心智里「一个项目」的边界——用户在画布级切项目，不在线程级。

### 3.3 一级 legacy 就够吗？（对 Q「用户级是否即可」的正面回答）

**不够。** 现状（纯 userId）正是事故根因，单做用户级等于维持现状。
但也不该二选一——**默认收紧到 canvas、显式开 user**，才是「默认安全 + 该跨的还能跨」的形状。
用户级要保留，但它是**白名单式**的：只有模型显式判定为跨会话事实才会写进去。

## 4. 数据模型与迁移

`apps/server/prisma/schema.prisma` 现有（:355-362）：

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

改为：

```prisma
model AgentMemory {
  id        String   @id @default(cuid())
  userId    String
  /// 作用域：'canvas'（本画布）/ 'user'（跨画布）。迁移默认 'user' 保兼容，回填脚本再收紧。
  scope     String   @default("user")
  /// scope='canvas' 时必填：画布会话 id（Session.id，非 pi 会话键）
  sessionId String?
  /// 来源：agent_auto / user_explicit / promoted（审计用，不做行为分支）
  source    String   @default("agent_auto")
  content   String
  createdAt DateTime @default(now())

  @@index([userId, scope, sessionId])
  @@map("agent_memories")
}
```

SQLite 无事务性 ALTER 多列便利，迁移 SQL 手写（与既有 `20260929090000_add_agent_memory` 同风格）：

```sql
-- apps/server/prisma/migrations/<ts>_add_agent_memory_scope/migration.sql
ALTER TABLE "agent_memories" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "agent_memories" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "agent_memories" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'agent_auto';
CREATE INDEX "agent_memories_userId_scope_sessionId_idx" ON "agent_memories"("userId","scope","sessionId");
```

> ⚠️ 索引名手写必须与 Prisma 生成的默认名一致（`agent_memories_userId_scope_sessionId_idx`），
> 否则 `prisma migrate dev` 会认为索引缺失、生成一条 `DROP/CREATE INDEX` 迁移（无害但噪音）。
> 落地方式：容器内 `node_modules/.bin/prisma migrate deploy`（容器里有 `@prisma/client`，CLI 在 `apps/server/node_modules/.bin/prisma`）。

## 5. 写入路径（scope 判定）

```
模型 ──save_memory{content, scope?}──▶ pi-runtime tools/memory.ts
                                        └ tc.sessionId（已有的画布会话 id）↓ POST /agent/internal/memory-save
                                        Nest AgentMemoryService.saveMemory
                                          · scope = dto.scope ?? 'canvas'
                                          · sessionId = scope==='canvas' ? dto.sessionId : null
                                          · source = 'user_explicit' if dto.scope==='user' else 'agent_auto'
```

关键实现点：
- `services/pi-runtime/src/tools/types.ts:29-46` 的 `LnkpiToolContext` **已有 `sessionId` 字段**（画布会话 id，不是 pi 会话键），
  `session-manager.ts:704` 的 `toolContext: () => ({...})` 已注入 ⇒ **零 vendor 改动**即可透传。
- pi-runtime 侧默认值与 Nest 一致：`scope = p.scope ?? 'canvas'`；`tc.sessionId` 缺失时**降级为 user 作用域并记 warn**
  （宁可放宽也别丢记忆，且模型拿到的 note 会写「（未确定归属，按跨会话保存）」）。
- 返回给模型的 note 文案必须区分：`已记住（仅本画布）` vs `已记住（跨会话生效）`——记忆写入要**对用户可见**（延续 P1 spec 的透明度判据）。

## 6. 召回路径（过滤 + 归属自曝）

```
模型 ──recall_memory{query?, limit?, scope?}──▶ Nest searchMemory
  rows = findMany({ where: { userId, ...scopeFilter, ...sessionFilter } })
  · scopeFilter:  'any' → 不限制 | 'canvas' → scope:'canvas' | 'user' → scope:'user'
  · sessionFilter: 仅当 scope 非 'user' 时加 { sessionId: dto.sessionId }
  items 排序：同画布优先（sessionId 命中排前），其次 scope 归档序（canvas→user），最后 createdAt desc
  每条 item 附加 { id, content, createdAt, scope, sessionId, crossCanvas }
  items 为空时返回 hint（沿用现有「没有相关记忆…」文案）
```

**`crossCanvas` 语义（本次事故的直接止血点）**：`scope==='canvas' && sessionId !== 当前会话` ⇒ `crossCanvas:true`，
并在 tool result 里附一条固定提示：

> 「以下内容来自**另一个画布的记忆**，只作为背景参考。**不能**把它当作当前图片、当前截图或当前对话内容的观察结果。」

这条必须落在**工具返回结果**（数据），不能只落在提示词规则里——
本次事故已经证明：提示词里写得再清楚（现有 `SIDEBAR_VISION_FAIL_HINT` 都要求「用文字说明失败并询问用户」），模型照样违反。

- pi-runtime `memoryResult()` 现状是 `JSON.stringify({ok, count, items})`（`tools/memory.ts:20-22`）⇒ 在 items 元素上补字段即可，协议自解释、无需注册中心。
- `recall_memory` 的 description 同步改写，把 scope 语义讲清（现有 description 只说「durable facts saved about the user」，这是漏洞的一部分）。

## 7. 向后兼容与回填

- **迁移默认 `scope='user'`**：上线后所有旧记忆**行为完全不变**（仍跨画布可召回）⇒ 部署零感知、可秒级回滚（把新列默认值改回/或回滚迁移）。
- **回填脚本** `scripts/backfill-memory-scope.ts`（在容器内 `cat s.cjs | ssh ... 'docker exec -i lnkpi-api node -'` 方式执行，见仓库取证 SOP）：
  1. `--dry-run` 默认，只打印分类结果不写库；
  2. 分类规则（可配置常量表，不用模糊匹配）：
     - 命中「暗号 / 密码 / 凭据 / 账号 / token / 密钥 / 品牌色 / 偏好 / 分辨率 / 尺寸」→ `scope='user'`
     - 其余**显式**项目知识（含「项目信息」「角色设定」「剧本」「分镜」「第 N 集」等）且能从上下文判定归属画布 → `scope='canvas'` + 回填 `sessionId`
     - 判不出来的 → **保持 `user`**，只补 `source='promoted'` 供后续人工看
  3. `--apply` 才写库；执行前 `cp` 备份 `*.db`（容器内路径见 `/opt/lnkpi/...`，由 ops 提供）。
- 生产实测基线（取证值，回填前对照）：`agent_memories` 共 **30 条 / 6 个 userId**；
  大头是项目知识（小熊和小爸爸 ×13、回声鉴定所 ×5）；其中 `cmu…a*` 四条「用户的暗号是"紫罗兰七号"」、
  `cmu…b0wdc`「暗号是：蓝天四十九号」——**凭据级内容**，回填后必须留在 `user` 层（现在任何画布都能捞，是真风险）。

> 回填的目标状态：暗号/偏好留在 user；项目知识降到 canvas（并在 `source` 留痕 `promoted`），
> 让「同一个用户换个画布就还记得《小熊和小爸爸》」这件事**不再默认发生**。

## 8. 验收判据

| # | 判据 | 验证方式 |
|---|---|---|
| A1 | 同画布召回得到本画布记忆 | 单测：`searchMemory({userId, sessionId:'S1'})` 命中 scope=canvas & sessionId=S1 |
| A2 | 跨画布**不再**默认拿到画布记忆 | 单测：`sessionId:'S2'` 时该条**不在**结果里（除非显式 `scope:'any'`） |
| A3 | user 记忆跨画布仍可召回 | 单测：暗号类记忆在 S2 下仍命中 |
| A4 | 返回体带 `scope/sessionId/crossCanvas` | 单测 + 生产 `executionEvents` 抓一次 `recall_memory` 的 tool_result 字段 |
| A5 | `save_memory` 默认 canvas、显式 user | 单测（Nest service + pi-runtime memory.ts 两侧） |
| A6 | 回填 dry-run 与 apply 一致 | 容器内跑 dry-run 打印 30 条分类，人工过一眼再 apply |
| A7 | 全仓类型与用例绿 | `apps/server`: `tsc --noEmit -p tsconfig.json` + `vitest run src/agent/`；`services/pi-runtime`: `tsc` + `node --import tsx --test "src/**/*.test.ts"` |

## 9. Review Focus（spec 说了但用例未必覆盖，最可能咬人的五类输入）

1. **`scope='canvas'` 但 `sessionId` 为 null/空串**（工具没拿 tc.sessionId、DTO 被吞）⇒ 必须 fail-closed 到该画布查不到，而不是降级成全局查。
2. **跨画布记忆 + 图片/截图提问同时发生**（正是本次事故形态）⇒ `crossCanvas` 提示必须真的出现在 tool result 里，而不只是提示词规则。
3. **`sessionId` 语义混淆**：画布 id ≠ pi 会话键（#70 曾因此全画布工具 404）⇒ 断言用 `Session.id`，禁止拿 `toSessionKey()` 结果。
4. **记忆全为空 / 300 条时的检索开销**：`MEMORY_SCAN_MAX=200` 窗口复合 scope 后仍可能全扫描 ⇒ 索引必须落在 `(userId, scope, sessionId)` 前缀上。
5. **回填脚本误伤**：把项目知识判成 canvas 但 sessionId 指向不存在的 Session（画布已被删）⇒ 该行必须回滚成 `user` 并记录，不能留悬空外键式数据。

## 10. 后续展望（本 spec 不做）

- v1.1：服务端 curated 摘要层（对齐 WorkBuddy「跨会话那层是精选摘要，不是原始日志」），以及用户可见的记忆管理 UI（删除/提升为项目知识）。
- v1.1：`delete_memory` / 记忆生命周期。
