# 文本节点 HTML 产物格式（V1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 可生成 HTML 产物——HTML 作为文本节点 `data.format:'html'` + sandbox iframe 渲染视图，不新增节点类型、不新增工具、不动 vendor、不动 DB。

**Architecture:** format 白名单 SSOT 落 shared（写入侧 assert fail-closed / 读取侧 resolve fail-soft）；链路 6 段接线（工具参数 → `/agent/internal/*` body → Nest DTO `@IsIn` → service data 写入 → SSE 透传（零改动）→ 前端按 format 分支）；质量三件套照搬 WorkBuddy 模式（工具出口 `set_node_text` + 规范 `skills/html-craft` + 分层加载 `load_skill` 现状复用）。

**Tech Stack:** zod + typebox（shared/runtime 契约）、class-validator（Nest DTO）、Vue 3 `<script setup>` + VueFlow、vitest（node24）。

**Spec:** `docs/superpowers/specs/2026-10-28-text-node-html-artifact-design.md`（v4；本计划逐任务论证自该规格，执行时两份一起读。§9 文件清单与 §14 定稿件是本计划的直接输入。）

## Global Constraints

- **G2 零类型扩散**：`NodeType`（`packages/shared/src/index.ts:10`）、runtime `CREATE_NODES_BATCH_ALLOWED_TYPES`、Nest `CREATABLE_NODE_TYPES` 三处白名单**逐字符不变**；任何任务不得触碰。
- **G5 零新依赖**：不新增 npm 运行时依赖；vendor（`vendor/earendil-works/pi`）零 diff。
- **format 白名单 SSOT**：`TEXT_NODE_FORMATS = ['plain','markdown','html']`（shared `textNodeFormat.ts`）；所有校验点（typebox / `@IsIn` / service）从 SSOT 派生，禁止手写字面量副本（`@IsIn([...TEXT_NODE_FORMATS])` 形式）。
- **缺省不写键**：format 缺省时 data 中**不得出现** `format` 键（存量节点零回归，G3）。
- **沙箱属性集（§4.3，守卫测试钉死）**：`sandbox="allow-scripts"`、`srcdoc` 注入、禁 `allow-same-origin|allow-top-navigation|allow-popups|allow-forms`；srcdoc 首部注入定稿 CSP：`default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'`。
- **L6 预算**：禁止把 HTML 路由指引写进 prompt 规则（`docs/prompts/**`）；路由只走工具描述（§14.5 定稿全文，**实施不得加长**）。
- **旁路零改动（§4.11）**：`duplicateToCanvasActions` / undo-redo / workflowExchange / compositionExpand 等 data 整包拷贝路径**不改一行**，只在终验断言 format 随行。
- **令牌纪律**：新增样式一律 `--lnk-*`（禁 `--neo-*` 再生长）；改组件后必跑 `vue-tsc -b` 与 design-token 四测试。
- **测试纪律**：所有 vitest 命令前 `source ~/.nvm/nvm.sh && nvm use 24`；vitest 加 `--maxWorkers=1 --no-file-parallelism`；commit 只在 worktree；push 走 api.github.com REST（代理纪律）。
- **移动端浮层唯一基座** = `MobileSheet.vue` 本包不新增 sheet；MobileNodeViewer / MobileNodeEditorSheet 沿用既有契约（双退出通道、44px 触控）。

## Review Focus

1. **恶意 HTML 注入父域**（模型生成 `<script>` 摸 parent/cookie/localStorage）——期望：sandbox 无 `allow-same-origin` 即 opaque origin 全部失败。钉死：Task 4 守卫测试（sandbox 属性 + CSP 断言）。
2. **存量文本节点回归**（无 format 字段的节点被误入 html 分支或丢字段）——期望：渲染/编辑/double-click 行为逐项与改前一致。钉死：Task 5 组件测试（无 format ⇒ 既有路径）+ Task 9 回归线。
3. **format 非法值穿透**（`format:'jsx'` 绕过一层直达 data）——期望：runtime 工具层报错列合法值；直打端点 Nest 400；绕 HTTP 内部调用 service 复检兜底。钉死：Task 1/2/3 各层测试。
4. **format 静默丢失**（duplicate / undo-redo / workflowExchange 往返后 data.format 消失）——期望：format 随 data 整包自动随行。钉死：Task 9 旁路验证清单。
5. **skill 装了但没人加载**（html-craft 进了目录但模型不触发，重演 tool_search 触发率为 0）——期望：`observeSkillLoad('html-craft')` 命中率可观测；工具描述含 load 线索。钉死：Task 8 接线守卫测试。

---

### Task 1: shared 格式白名单 SSOT（textNodeFormat.ts）

**Files:**
- Create: `packages/shared/src/textNodeFormat.ts`
- Modify: `packages/shared/src/agentContract.ts`（`SetNodeContentRequestSchema`，:247 附近）
- Modify: `packages/shared/src/index.ts`（re-export，加在 `export * from './agentContract'` 之前）
- Test: `packages/shared/src/textNodeFormat.test.ts`（新建）

**Interfaces:**
- Consumes: 无（最底层）。
- Produces（后续所有任务依赖，签名逐字固定）:
  - `TEXT_NODE_FORMATS: readonly ['plain','markdown','html']`
  - `type TextNodeFormat = 'plain' | 'markdown' | 'html'`
  - `resolveTextNodeFormat(v: unknown): TextNodeFormat`
  - `assertTextNodeFormat(v: unknown): asserts v is TextNodeFormat`
  - `stripHtmlTags(html: string): string`
  - `htmlNodeSummary(data: Record<string, unknown> | undefined): string`

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/src/textNodeFormat.test.ts
import { describe, expect, it } from 'vitest'
import {
  TEXT_NODE_FORMATS,
  assertTextNodeFormat,
  htmlNodeSummary,
  resolveTextNodeFormat,
  stripHtmlTags,
} from './textNodeFormat'

describe('TEXT_NODE_FORMATS', () => {
  it('白名单恰为 plain/markdown/html（规格 §4.4）', () => {
    expect([...TEXT_NODE_FORMATS]).toEqual(['plain', 'markdown', 'html'])
  })
})

describe('resolveTextNodeFormat（读取侧 fail-soft）', () => {
  it('缺省/未知值/非字符串 ⇒ plain，不抛错', () => {
    expect(resolveTextNodeFormat(undefined)).toBe('plain')
    expect(resolveTextNodeFormat('jsx')).toBe('plain')
    expect(resolveTextNodeFormat(42)).toBe('plain')
    expect(resolveTextNodeFormat({})).toBe('plain')
  })
  it('合法值原样返回', () => {
    expect(resolveTextNodeFormat('html')).toBe('html')
    expect(resolveTextNodeFormat('markdown')).toBe('markdown')
  })
})

describe('assertTextNodeFormat（写入侧 fail-closed）', () => {
  it('非法值 throw 且错误信息列合法值', () => {
    expect(() => assertTextNodeFormat('jsx')).toThrow(/plain, markdown, html/)
    expect(() => assertTextNodeFormat(undefined)).toThrow()
  })
  it('合法值不抛', () => {
    expect(() => assertTextNodeFormat('html')).not.toThrow()
  })
})

describe('stripHtmlTags', () => {
  it('剥标签与 script/style 内容', () => {
    expect(stripHtmlTags('<style>.x{}</style><h1>标题</h1><p>正文</p>')).toBe('标题 正文')
  })
  it('压平空白实体', () => {
    expect(stripHtmlTags('<p>a&nbsp;&nbsp;b</p>')).toBe('a b')
  })
})

describe('htmlNodeSummary（优先级 label > title > strip，≤40 字符）', () => {
  it('label 存在优先', () => {
    expect(htmlNodeSummary({ label: '节点标题', content: '<title>页标题</title><p>正文</p>' })).toBe('节点标题')
  })
  it('label 缺失走 title', () => {
    expect(htmlNodeSummary({ content: '<title>页标题</title><p>正文</p>' })).toBe('页标题')
  })
  it('title 缺失走 strip 首段', () => {
    expect(htmlNodeSummary({ content: '<h1>大标题</h1><p>正文</p>' })).toBe('大标题 正文')
  })
  it('空 content ⇒ 空串', () => {
    expect(htmlNodeSummary({ content: '' })).toBe('')
    expect(htmlNodeSummary(undefined)).toBe('')
  })
  it('超长截断到 ≤40', () => {
    const s = htmlNodeSummary({ content: `<p>${'字'.repeat(60)}</p>` })
    expect(s.length).toBeLessThanOrEqual(40)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm --filter @lnkpi/shared exec vitest run src/textNodeFormat.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 最小实现**

```ts
// packages/shared/src/textNodeFormat.ts
/**
 * 文本节点内容格式白名单 SSOT（规格 2026-10-28-text-node-html-artifact-design §4.4）。
 * 格式即属性（§4.1）：文本系新格式（svg/csv/json…）一律扩这里 + 前端渲染分支，
 * 禁止新增节点类型（NodeType 收敛纪律的延续）。
 * 写入侧 fail-closed（assert），读取侧 fail-soft（resolve）——严格写、宽容渲染（§4.2）。
 */
export const TEXT_NODE_FORMATS = ['plain', 'markdown', 'html'] as const
export type TextNodeFormat = (typeof TEXT_NODE_FORMATS)[number]

const FORMAT_SET: ReadonlySet<string> = new Set(TEXT_NODE_FORMATS)

/** 归一化：未知/缺省 ⇒ 'plain'。读取侧不抛错（渲染宽容）。 */
export function resolveTextNodeFormat(v: unknown): TextNodeFormat {
  return typeof v === 'string' && FORMAT_SET.has(v) ? (v as TextNodeFormat) : 'plain'
}

/** 写入侧白名单：非法值 throw，错误信息必须列出合法值（对齐 create_nodes_batch type 闸门文案模式）。 */
export function assertTextNodeFormat(v: unknown): asserts v is TextNodeFormat {
  if (typeof v !== 'string' || !FORMAT_SET.has(v)) {
    throw new Error(`invalid text node format "${String(v)}" (allowed: ${TEXT_NODE_FORMATS.join(', ')})`)
  }
}

/** 剥 HTML 标签为纯文本（节点卡摘要与移动端 TTS 朗读同源，规格 §8）。 */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 节点卡摘要（§4.7/§8）：label > <title> > strip 首段，≤40 字符。 */
export function htmlNodeSummary(data: Record<string, unknown> | undefined): string {
  const label = typeof data?.label === 'string' ? data.label.trim() : ''
  if (label) return label.slice(0, 40)
  const content = typeof data?.content === 'string' ? data.content : ''
  if (!content.trim()) return ''
  const m = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = m ? m[1].replace(/\s+/g, ' ').trim() : ''
  const base = title || stripHtmlTags(content)
  return base.slice(0, 40)
}
```

`agentContract.ts` 修改（顶部 import 区加 `import { TEXT_NODE_FORMATS } from './textNodeFormat'`）：

```ts
export const SetNodeContentRequestSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  nodeId: z.string(),
  content: z.string(),
  stage: z.boolean().optional(),
  // 文档位（规格 §5.3 实证：本 schema 全仓无消费方）——仅类型契约同步，校验真身
  // = runtime typebox 枚举 + Nest DTO @IsIn + service 复检。禁止因这里有校验就删下游。
  format: z.enum(TEXT_NODE_FORMATS).optional(),
})
```

`index.ts` 在 `export * from './agentContract'` 一行**之前**插入：

```ts
export * from './textNodeFormat'
```

- [ ] **Step 4: 跑测试确认通过**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm --filter @lnkpi/shared exec vitest run src/textNodeFormat.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/textNodeFormat.ts packages/shared/src/textNodeFormat.test.ts packages/shared/src/agentContract.ts packages/shared/src/index.ts
git commit -m "feat(shared): text node format whitelist SSOT (plain|markdown|html)"
```

---

### Task 2: Nest 服务层——DTO 白名单 + setNodeContent/addNodesBatch 写入

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts`（`BatchNodeItemDto` :98、`SetNodeContentDto` :307）
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（`addNodesBatch` 签名 :929 + nodeData 组装 :1004；`setNodeContent` :1375）
- Test: `apps/server/src/agent/agent-canvas-tools.set-node-content.test.ts`（扩展）
- Test: `apps/server/src/agent/agent-canvas-tools.service.test.ts`（扩展 batch 用例；若该文件无 batch describe 块，则用例并入 `set-node-content.test.ts` 同构的独立 describe）

**Interfaces:**
- Consumes: Task 1 的 `assertTextNodeFormat`、`TEXT_NODE_FORMATS`（`import { assertTextNodeFormat, TEXT_NODE_FORMATS } from '@lnkpi/shared'`）。
- Produces: HTTP 契约——`POST /agent/internal/set-node-content` body 可带 `format?: string`；`POST /agent/internal/add-nodes-batch` items[] 可带 `format?: string`。非法值 ⇒ 400 / BadRequestException，错误信息含 `plain, markdown, html`。Task 3 的 runtime 工具按此 body 发送。

- [ ] **Step 1: 写失败测试（setNodeContent 侧，扩展既有文件）**

在 `agent-canvas-tools.set-node-content.test.ts` 追加（复用该文件顶部既有 `makeSvc` 工厂；session 初始画布用 `text: { nodes: [{ id: 'n1', type: 'text', position: {x:0,y:0}, data: {} }], edges: [] }`）：

```ts
describe('setNodeContent —— format 白名单（规格 §4.4/§5.3）', () => {
  it('format:"html" 写入 data 且 status 不受污染', async () => {
    const { svc, sessionUpdate } = await makeSvcWithTextNode()
    await svc.setNodeContent({ sessionId: 's1', userId: 'u1', nodeId: 'n1', content: '<h1>hi</h1>', format: 'html' })
    const written = JSON.parse(sessionUpdate.mock.calls[0][0].data.canvasData)
    expect(written.nodes[0].data.format).toBe('html')
    expect(written.nodes[0].data.status).toBe('completed')
  })
  it('format 缺省 ⇒ data 不出现 format 键（存量语义不变）', async () => {
    const { svc, sessionUpdate } = await makeSvcWithTextNode()
    await svc.setNodeContent({ sessionId: 's1', userId: 'u1', nodeId: 'n1', content: '纯文本' })
    const written = JSON.parse(sessionUpdate.mock.calls[0][0].data.canvasData)
    expect('format' in written.nodes[0].data).toBe(false)
  })
  it('非法值（绕 HTTP 的内部调用）⇒ service 复检 fail-closed 抛错', async () => {
    const { svc } = await makeSvcWithTextNode()
    await expect(
      svc.setNodeContent({ sessionId: 's1', userId: 'u1', nodeId: 'n1', content: 'x', format: 'jsx' as never }),
    ).rejects.toThrow(/plain, markdown, html/)
  })
})
```

（`makeSvcWithTextNode` 为对既有 `makeSvc` 的薄封装：传入含 `n1` text 节点的画布并返回 `{ svc, sessionUpdate }`——参照文件内既有 makeSvc 用法改参即可，不新增基建。）

- [ ] **Step 2: 写失败测试（addNodesBatch 侧）**

```ts
describe('addNodesBatch —— format 透传（规格 §5.3）', () => {
  it('text 节点带 format:"html" ⇒ nodeData.format 写入', async () => {
    // 走 service.test 既有 makeSvc 形态；断言 actions 中 add_node.payload.data.format === 'html'
  })
  it('format 缺省 ⇒ nodeData 无 format 键', async () => {})
  it('image 节点带 format ⇒ BadRequestException（§4.5 仅 text）', async () => {})
  it('非法值 ⇒ 抛错且信息列合法值', async () => {})
})
```

（实施时把 4 个 it 的断言体按文件内既有 batch 用例的 `svc.addNodesBatch({...})` + actions 解析写全——形状照抄既有用例，仅多了 `format` 字段与断言。**此步不允许留 TODO**。）

- [ ] **Step 3: 跑测试确认失败**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm test:server -- src/agent/agent-canvas-tools.set-node-content.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL（`format` 未被写入 / 未校验）。

- [ ] **Step 4: 实现**

`agent-canvas-tools.controller.ts`——顶部确认已 `import { TEXT_NODE_FORMATS } from '@lnkpi/shared'`（无则加），两个 DTO 各追加：

```ts
  // 文本节点内容格式白名单（规格 §4.4）：仅 text 节点合法；service 层复检兜底绕 HTTP 的内部调用。
  @IsOptional()
  @IsIn([...TEXT_NODE_FORMATS])
  format?: string
```

（`BatchNodeItemDto` 与 `SetNodeContentDto` 各一份，字段位置放在各自最后一个可选字段之后。）

`agent-canvas-tools.service.ts`：

`addNodesBatch` 签名（:932 的 items 数组元素类型）追加一行：

```ts
      format?: string
```

nodeData 组装（:1004 的 `const nodeData: Record<string, unknown> = {...}` 块之后、与 `if (item.pipeline)` 等条件键并列处）追加：

```ts
      // 格式即属性（规格 §4.4/§5.3）：缺省不写键（存量语义不变）；仅 text 节点合法；
      // fail-closed 在此兜底（绕 HTTP 的内部调用不过 DTO）。
      if (item.format !== undefined) {
        assertTextNodeFormat(item.format)
        if (nodeType !== 'text') throw new BadRequestException('仅 text 节点可携带 format')
        nodeData.format = item.format
      }
```

`setNodeContent`（:1375）：签名追加 `format?: string`；媒体闸门（`if (['image','video','audio'].includes(...))`）**保留在先不动**，其后追加：

```ts
    // 格式白名单复检（规格 §5.3）：绕 HTTP 的内部调用不过 DTO，fail-closed 在此兜底。
    if (input.format !== undefined) assertTextNodeFormat(input.format)
```

并把 update_node 的 data payload 改为：

```ts
          data: {
            content: input.content,
            status: 'completed',
            ...(input.format !== undefined ? { format: input.format } : {}),
          },
```

- [ ] **Step 5: 跑测试确认通过 + 全量 agent 套件回归**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm test:server -- src/agent/agent-canvas-tools.set-node-content.test.ts src/agent/agent-canvas-tools.service.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS（含 P1-1 媒体闸门既有用例不红）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent/agent-canvas-tools.controller.ts apps/server/src/agent/agent-canvas-tools.service.ts apps/server/src/agent/agent-canvas-tools.set-node-content.test.ts
git commit -m "feat(server): text node format whitelist on set-node-content and add-nodes-batch"
```

---

### Task 3: runtime 工具层——set_node_text / create_nodes_batch 加 format 参数与描述定稿

> **SDD 预检裁决（2026-10-28）**：pi-runtime 的 package.json **没有** `@lnkpi/shared` 依赖（`agent-canvas-tools.service.ts:1462` 注释 = 有意架构决策，禁新增）。runtime 白名单**本地定义**在 `text-format.ts`，由 contract-mirror 测试对 shared 源文件做镜像断言防漂移——本任务代码已按此改写。

**Files:**
- Create: `services/pi-runtime/src/tools/text-format.ts`（runtime 本地白名单 + assert，同语义）
- Modify: `services/pi-runtime/src/tools/canvas-write.ts`（`set_node_text` :277；`create_nodes_batch` :1002 及 body 映射 :1067-1073）
- Test: `services/pi-runtime/src/tools/canvas-write.test.ts`（扩展）
- Test: `services/pi-runtime/src/tools/canvas-write.contract-mirror.test.ts`（追加 shared↔runtime 白名单镜像断言）
- Verify: `pnpm verify-tool-contract && pnpm verify-tool-tiering && pnpm verify:details`（工具契约三脚本，description 变更必跑）
- Verify: `services/pi-runtime/src/tools/tiering.test.ts` 实证**无** set_node_text/create_nodes_batch 断言（2026-10-28 grep 为空）——预期零改动，跑绿即可；若红按失败信息对齐

**Interfaces:**
- Consumes: Task 2 的 HTTP 契约；白名单**本地定义**（预检裁决，见任务头注）——`import { assertTextNodeFormat, TEXT_NODE_FORMATS } from "./text-format.js"`。
- Produces: agent 可见工具签名——`set_node_text{ node_id, prompt?, content?, format? }`、`create_nodes_batch{ items:[{ key, type, prompt, title?, format? }], edges? }`；`format` 仅与 `content` 同发（set_node_text）。

- [ ] **Step 1: 写失败测试（canvas-write.test.ts 追加；复用顶部 makeClient/CTX/findTool）**

```ts
describe("set_node_text format", () => {
  it("content+format:'html' ⇒ set-node-content body 带 format", async () => {
    const { client, calls } = makeClient();
    const tools = createCanvasWriteTools(client);
    const tool = findTool(tools, "set_node_text");
    await tool.execute("t1", { node_id: "n1", content: "<h1>hi</h1>", format: "html" }, undefined, CTX);
    const body = calls.find((c) => c.path === "/agent/internal/set-node-content")?.body;
    assert.equal(body?.format, "html");
  });
  it("format 缺省 ⇒ body 无 format 键", async () => {
    const { client, calls } = makeClient();
    const tool = findTool(createCanvasWriteTools(client), "set_node_text");
    await tool.execute("t1", { node_id: "n1", content: "纯文本" }, undefined, CTX);
    const body = calls.find((c) => c.path === "/agent/internal/set-node-content")?.body;
    assert.equal("format" in (body ?? {}), false);
  });
  it("format 非法值 ⇒ 工具层抛错（信息列合法值），不发请求", async () => {
    const { client, calls } = makeClient();
    const tool = findTool(createCanvasWriteTools(client), "set_node_text");
    await assert.rejects(
      () => tool.execute("t1", { node_id: "n1", content: "x", format: "jsx" }, undefined, CTX),
      /plain, markdown, html/,
    );
    assert.equal(calls.length, 0);
  });
  it("format 无 content ⇒ 抛错（format 仅与 content 同发）", async () => {
    const { client } = makeClient();
    const tool = findTool(createCanvasWriteTools(client), "set_node_text");
    await assert.rejects(
      () => tool.execute("t1", { node_id: "n1", prompt: "p", format: "html" }, undefined, CTX),
      /format requires content/,
    );
  });
});

describe("create_nodes_batch item format", () => {
  it("item.format:'html' ⇒ add-nodes-batch body items 带 format", async () => {
    const { client, calls } = makeClient();
    const tool = findTool(createCanvasWriteTools(client), "create_nodes_batch");
    await tool.execute(
      "t1",
      { items: [{ key: "k1", type: "text", prompt: "落地页", format: "html" }] },
      undefined,
      CTX,
    );
    const body = calls.find((c) => c.path === "/agent/internal/add-nodes-batch")?.body;
    assert.equal((body?.items as Array<Record<string, unknown>>)[0].format, "html");
  });
  it("item.format 非法值 ⇒ 抛错", async () => {
    const { client } = makeClient();
    const tool = findTool(createCanvasWriteTools(client), "create_nodes_batch");
    await assert.rejects(
      () => tool.execute("t1", { items: [{ key: "k1", type: "text", prompt: "p", format: "jsx" }] }, undefined, CTX),
      /plain, markdown, html/,
    );
  });
});

describe("set_node_text description 路由线索（规格 §10 skill 接线守卫）", () => {
  it("描述含 load_skill('html-craft') 强制线索", () => {
    const tool = findTool(createCanvasWriteTools((undefined as never) as never), "set_node_text");
    assert.match(tool.description, /load_skill\('html-craft'\)/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm --filter @pi-lnk/pi-runtime exec vitest run src/tools/canvas-write.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL。

- [ ] **Step 3: 实现**

新建 `text-format.ts`（runtime 本地白名单，**禁止**给 pi-runtime 加 @lnkpi/shared 依赖——预检裁决）：

```ts
// services/pi-runtime/src/tools/text-format.ts
/**
 * 文本节点格式白名单（runtime 本地副本）。
 * ⚠️ pi-runtime 无 @lnkpi/shared 依赖（有意决策，见 agent-canvas-tools.service.ts:1462 注释）。
 * SSOT 在 packages/shared/src/textNodeFormat.ts；两侧一致性由
 * canvas-write.contract-mirror.test.ts 的镜像断言守卫（漂移即红），改任一侧必须同步另一侧。
 */
export const TEXT_NODE_FORMATS = ["plain", "markdown", "html"] as const;
export type TextNodeFormat = (typeof TEXT_NODE_FORMATS)[number];

const FORMAT_SET: ReadonlySet<string> = new Set(TEXT_NODE_FORMATS);

/** 写入侧白名单 fail-closed：非法值 throw，错误信息列合法值（与 shared assertTextNodeFormat 同语义）。 */
export function assertTextNodeFormat(v: unknown): asserts v is TextNodeFormat {
	if (typeof v !== "string" || !FORMAT_SET.has(v)) {
		throw new Error(`invalid text node format "${String(v)}" (allowed: ${TEXT_NODE_FORMATS.join(", ")})`);
	}
}
```

`canvas-write.ts` 顶部 import 加 `import { assertTextNodeFormat, TEXT_NODE_FORMATS } from "./text-format.js";`。

`canvas-write.contract-mirror.test.ts` 追加镜像断言（放文件末尾新 describe）：

```ts
describe("text-node format whitelist mirror（shared SSOT ↔ runtime 本地副本）", () => {
	it("runtime TEXT_NODE_FORMATS 与 shared 源文件数组逐项相等", () => {
		const sharedSrc = readFileSync(
			fileURLToPath(new URL("../../../../packages/shared/src/textNodeFormat.ts", import.meta.url)),
			"utf8",
		);
		const m = sharedSrc.match(/TEXT_NODE_FORMATS = \[([^\]]+)\] as const/);
		assert.ok(m, "shared textNodeFormat.ts 中未找到 TEXT_NODE_FORMATS 数组字面量（结构变更需同步本镜像测试）");
		const sharedList = m[1].split(",").map((s) => s.trim().replaceAll("'", ""));
		assert.deepEqual([...TEXT_NODE_FORMATS], sharedList);
	});
});
```

（该测试文件已 import `readFileSync`/`fileURLToPath`；`TEXT_NODE_FORMATS` 从 `./text-format.js` import。）

**`set_node_text`**：parameters 追加（放在 `content` 之后）：

```ts
				format: Type.Optional(
					Type.Union(
						TEXT_NODE_FORMATS.map((f) => Type.Literal(f)),
						{
							description:
								"Optional content format: 'html' for webpage / interactive artifacts (then call load_skill('html-craft') before writing content via set_node_text).",
						},
					),
				),
```

description 整串替换为规格 §14.5 定稿（逐字，**不得加长**）：

```ts
			description:
				"Update prompt and/or content text on an EXISTING node (at least one of prompt/content; passing both updates both). For creating nodes use upsert_media_node instead. For HTML pages (webpage / prototype / interactive / canvas overview card) set format='html' and ALWAYS call load_skill('html-craft') FIRST — required before writing any html content. Keep it a single self-contained file: images as data URI or inline SVG (remote images blocked), no alert/confirm, everything else inline.",
```

execute 的参数类型与 content 分支：

```ts
				p: { node_id: string; prompt?: string; content?: string; format?: string },
```

在 `if (!p.prompt && !p.content)` 校验之后追加：

```ts
				if (p.format !== undefined) {
					if (!p.content) {
						throw new Error("set_node_text: format requires content (format is a content attribute)");
					}
					assertTextNodeFormat(p.format);
				}
```

content 分支 body 追加条件键：

```ts
					const done = await client.post("/agent/internal/set-node-content", {
						sessionId: tc.sessionId,
						userId: tc.userId,
						nodeId: p.node_id,
						content: p.content,
						...(p.format !== undefined ? { format: p.format } : {}),
					});
```

**`create_nodes_batch`**：item schema（`Type.Object({ key, type, prompt, title })` 内）追加：

```ts
						format: Type.Optional(
							Type.Union(
								TEXT_NODE_FORMATS.map((f) => Type.Literal(f)),
								{
									description:
										"Optional content format: 'html' for webpage / interactive artifacts (then call load_skill('html-craft') before writing content via set_node_text).",
								},
							),
						),
```

execute 参数类型 items 元素加 `format?: string`；type 白名单 for 循环内追加：

```ts
					if (it.format !== undefined) assertTextNodeFormat(it.format);
```

body 映射（:1067-1073）在**既有映射不动**（`key` / `title: it.title ?? it.prompt` / `targetType: it.type` / `prompt: it.prompt`）基础上追加条件键：

```ts
						items: p.items.map((it) => ({
							key: it.key,
							title: it.title ?? it.prompt,
							targetType: it.type,
							prompt: it.prompt,
							...(it.format !== undefined ? { format: it.format } : {}),
						})),
```

- [ ] **Step 4: 跑测试 + 工具契约三脚本**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm --filter @pi-lnk/pi-runtime exec vitest run src/tools/canvas-write.test.ts src/tools/canvas-write.contract-mirror.test.ts src/tools/tiering.test.ts --maxWorkers=1 --no-file-parallelism && pnpm verify-tool-contract && pnpm verify-tool-tiering && pnpm verify:details
```
Expected: 全部 PASS（tiering 预期零改动即绿）。

- [ ] **Step 5: Commit**

```bash
git add services/pi-runtime/src/tools/canvas-write.ts services/pi-runtime/src/tools/canvas-write.test.ts
git commit -m "feat(runtime): optional format param on set_node_text and create_nodes_batch (html artifact routing)"
```

---

### Task 4: HtmlNodePreview.vue（sandbox 预览面 + 行为级守卫）

**Files:**
- Create: `apps/web/src/components/canvas/HtmlNodePreview.vue`
- Test: `apps/web/src/components/canvas/HtmlNodePreview.test.ts`（新建）
- Modify: `docs/superpowers/specs/2026-10-28-text-node-html-artifact-design.md` §5.4（补一行：新增 `embedded` prop——移动端内嵌态不渲染 overlay/关闭钮，宿主负责退出；此为实施期对 §5.4 的最小补充，随 PR 说明）

**Interfaces:**
- Consumes: Task 1 `resolveTextNodeFormat`（测试用）。
- Produces（Task 5/7 依赖，签名逐字固定）:
  - props: `content: string`、`readonly?: boolean = false`、`embedded?: boolean = false`
  - emits: `save(payload: { content: string; format: 'html' })`、`close()`
  - 导出常量供守卫测试引用：`HTML_NODE_SANDBOX_ATTRS = 'allow-scripts'`、`HTML_NODE_CSP`（§4.3 定稿串）

- [ ] **Step 1: 写失败守卫测试（行为级：剥注释后断言产物属性）**

```ts
// apps/web/src/components/canvas/HtmlNodePreview.test.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import HtmlNodePreview, {
  HTML_NODE_CSP,
  HTML_NODE_SANDBOX_ATTRS,
} from './HtmlNodePreview.vue'

const SAMPLE = '<!DOCTYPE html><html><body><h1>hi</h1><script>1+1</script></body></html>'

describe('HtmlNodePreview 沙箱契约（规格 §4.3/§10 行为级守卫）', () => {
  it('iframe sandbox 含 allow-scripts 且禁四项属性', () => {
    const w = mount(HtmlNodePreview, { props: { content: SAMPLE } })
    const iframe = w.find('iframe')
    const sb = iframe.attributes('sandbox') ?? ''
    expect(sb).toContain(HTML_NODE_SANDBOX_ATTRS)
    for (const banned of ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-forms']) {
      expect(sb).not.toContain(banned)
    }
  })
  it('srcdoc 首部为 meta CSP 且串与定稿一致', () => {
    expect(HTML_NODE_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'",
    )
    const w = mount(HtmlNodePreview, { props: { content: SAMPLE } })
    const doc = w.find('iframe').attributes('srcdoc') ?? ''
    const cspIdx = doc.indexOf(HTML_NODE_CSP)
    expect(cspIdx).toBeGreaterThanOrEqual(0)
    expect(doc.indexOf('<!DOCTYPE')).toBeGreaterThan(cspIdx) // CSP 置最前（§5.4）
  })
  it('默认预览态；切源码后保存 emit save 且 payload 带 format:"html"', async () => {
    const w = mount(HtmlNodePreview, { props: { content: SAMPLE } })
    await w.findAll('[data-testid="html-tab"]').find((b) => b.text().includes('源码'))!.trigger('click')
    const ta = w.find('textarea')
    await ta.setValue('<p>edited</p>')
    await w.find('[data-testid="html-save"]').trigger('click')
    expect(w.emitted('save')?.[0]).toEqual([{ content: '<p>edited</p>', format: 'html' }])
  })
  it('readonly ⇒ 无源码 tab、无保存钮', () => {
    const w = mount(HtmlNodePreview, { props: { content: SAMPLE, readonly: true } })
    expect(w.find('textarea').exists()).toBe(false)
    expect(w.find('[data-testid="html-save"]').exists()).toBe(false)
  })
  it('非 embedded ⇒ 有关闭钮并 emit close；embedded ⇒ 无', async () => {
    const w = mount(HtmlNodePreview, { props: { content: SAMPLE } })
    await w.find('[data-testid="html-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    const w2 = mount(HtmlNodePreview, { props: { content: SAMPLE, embedded: true } })
    expect(w2.find('[data-testid="html-close"]').exists()).toBe(false)
  })
  it('空 content ⇒ 降级 pre 态不白屏（§4.8）', () => {
    const w = mount(HtmlNodePreview, { props: { content: '' } })
    expect(w.find('pre').exists()).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm --filter @lnkpi/web exec vitest run src/components/canvas/HtmlNodePreview.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现组件**

```vue
<!-- apps/web/src/components/canvas/HtmlNodePreview.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * HTML 文本节点沙箱预览面（规格 §5.4 组件契约；§4.3 沙箱判据）。
 * 非 embedded：自带 overlay + 关闭钮（PC 双击节点打开）。
 * embedded：纯预览面（移动端 MobileNodeViewer 内嵌；退出由宿主 viewer 负责）。
 * ⚠️ 保存一律 emit('save') 由宿主走 patch 通路——禁 inject CANVAS_NODE_PATCH_KEY
 * （CanvasNodeText.onSave 注释：updateNodeData 会被下一次页面 patch 的旧数据覆盖）。
 */
const props = withDefaults(
  defineProps<{
    content: string
    readonly?: boolean
    embedded?: boolean
  }>(),
  { readonly: false, embedded: false },
)

const emit = defineEmits<{
  (e: 'save', payload: { content: string; format: 'html' }): void
  (e: 'close'): void
}>()

// §4.3 定稿 CSP（守卫测试逐字符钉死；改这里必须同步改测试并过规格评审）。
export const HTML_NODE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'"
export const HTML_NODE_SANDBOX_ATTRS = 'allow-scripts'
</script>
```

⚠️ **实现注意**：`<script setup>` 中不能直接 `export const`——把两个常量放在组件文件同级导出（改为普通 `<script lang="ts">` 块与 `<script setup>` 并存，或独立 `htmlNodePreviewContract.ts`）。采用后者（更干净）：

```ts
// apps/web/src/components/canvas/htmlNodePreviewContract.ts
/** 沙箱契约常量（规格 §4.3 定稿；守卫测试逐字符钉死）。 */
export const HTML_NODE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'"
export const HTML_NODE_SANDBOX_ATTRS = 'allow-scripts'
```

组件正文：

```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import { HTML_NODE_CSP, HTML_NODE_SANDBOX_ATTRS } from './htmlNodePreviewContract'

const props = withDefaults(
  defineProps<{ content: string; readonly?: boolean; embedded?: boolean }>(),
  { readonly: false, embedded: false },
)
const emit = defineEmits<{
  (e: 'save', payload: { content: string; format: 'html' }): void
  (e: 'close'): void
}>()

const tab = ref<'preview' | 'source'>('preview')
const draft = ref('')

const degraded = computed(() => props.content.trim() === '')
const srcdoc = computed(() =>
  degraded.value ? '' : `<meta http-equiv="Content-Security-Policy" content="${HTML_NODE_CSP}">${props.content}`,
)

function openSource() {
  draft.value = props.content
  tab.value = 'source'
}
function onSave() {
  emit('save', { content: draft.value, format: 'html' })
  tab.value = 'preview'
}
</script>

<template>
  <div v-if="!embedded" class="html-preview-overlay" @click.self="emit('close')">
    <div class="html-preview-panel">
      <header v-if="!readonly" class="html-preview-bar">
        <button
          v-for="t in (['preview', 'source'] as const)"
          :key="t"
          type="button"
          class="html-preview-tab"
          :class="{ 'is-active': tab === t || (t === 'source' && tab === 'source') }"
          data-testid="html-tab"
          @click="t === 'source' ? openSource() : (tab = 'preview')"
        >
          {{ t === 'preview' ? '预览' : '源码' }}
        </button>
        <span class="html-preview-hint">沙箱预览：无网络请求、无持久化存储</span>
        <button type="button" class="html-preview-close" data-testid="html-close" aria-label="关闭" @click="emit('close')">✕</button>
      </header>
      <button v-else type="button" class="html-preview-close html-preview-close--solo" data-testid="html-close" aria-label="关闭" @click="emit('close')">✕</button>

      <iframe
        v-if="tab === 'preview' && !degraded"
        class="html-preview-frame"
        :sandbox="HTML_NODE_SANDBOX_ATTRS"
        :srcdoc="srcdoc"
        title="HTML 产物沙箱预览"
      ></iframe>
      <textarea
        v-else-if="tab === 'source'"
        v-model="draft"
        class="html-preview-source"
        spellcheck="false"
        aria-label="HTML 源码"
      ></textarea>
      <pre v-else class="html-preview-degraded">内容为空或不可渲染</pre>

      <footer v-if="!readonly && tab === 'source'" class="html-preview-footer">
        <button type="button" class="html-preview-save" data-testid="html-save" @click="onSave">保存</button>
      </footer>
    </div>
  </div>

  <!-- embedded（移动端）：纯预览面，无 overlay / 关闭钮 / 保存（编辑走宿主编辑 sheet） -->
  <div v-else class="html-preview-embedded">
    <iframe
      v-if="!degraded"
      class="html-preview-frame"
      :sandbox="HTML_NODE_SANDBOX_ATTRS"
      :srcdoc="srcdoc"
      title="HTML 产物沙箱预览"
    ></iframe>
    <pre v-else class="html-preview-degraded">内容为空或不可渲染</pre>
  </div>
</template>

<style scoped>
.html-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 0.4);
}
.html-preview-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(960px, 92vw);
  height: min(720px, 88vh);
  overflow: hidden;
  border-radius: var(--lnk-radius-lg, 12px);
  background: var(--lnk-surface-canvas);
}
.html-preview-bar {
  display: flex;
  align-items: center;
  gap: var(--lnk-space-2, 8px);
  padding: var(--lnk-space-2, 8px) var(--lnk-space-3, 12px);
  border-bottom: 1px solid var(--lnk-border-subtle, rgb(0 0 0 / 0.08));
}
.html-preview-tab {
  min-height: var(--lnk-touch-target, 44px);
  padding: 0 var(--lnk-space-3, 12px);
  border: none;
  border-radius: var(--lnk-radius-md, 8px);
  background: transparent;
  color: var(--lnk-text-secondary, inherit);
  cursor: pointer;
}
.html-preview-tab.is-active {
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-primary, inherit);
}
.html-preview-hint {
  margin-left: auto;
  font-size: 12px;
  color: var(--lnk-text-tertiary, inherit);
}
.html-preview-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--lnk-touch-target, 44px);
  height: var(--lnk-touch-target, 44px);
  border: none;
  border-radius: var(--lnk-radius-md, 8px);
  background: var(--lnk-surface-overlay);
  color: var(--lnk-text-primary, inherit);
  cursor: pointer;
}
.html-preview-close--solo {
  position: absolute;
  top: var(--lnk-space-2, 8px);
  right: var(--lnk-space-2, 8px);
  z-index: 1;
}
.html-preview-frame {
  flex: 1;
  width: 100%;
  border: none;
  background: #fff;
}
.html-preview-source {
  flex: 1;
  padding: var(--lnk-space-3, 12px);
  border: none;
  resize: none;
  font-family: ui-monospace, monospace;
  font-size: 13px;
  background: var(--lnk-surface-canvas);
  color: var(--lnk-text-primary, inherit);
}
.html-preview-degraded {
  flex: 1;
  margin: 0;
  padding: var(--lnk-space-3, 12px);
  overflow: auto;
  white-space: pre-wrap;
  font-family: ui-monospace, monospace;
  font-size: 13px;
}
.html-preview-footer {
  display: flex;
  justify-content: flex-end;
  padding: var(--lnk-space-2, 8px) var(--lnk-space-3, 12px);
  border-top: 1px solid var(--lnk-border-subtle, rgb(0 0 0 / 0.08));
}
.html-preview-save {
  min-height: var(--lnk-touch-target, 44px);
  padding: 0 var(--lnk-space-4, 16px);
  border: none;
  border-radius: var(--lnk-radius-md, 8px);
  background: var(--lnk-accent, #2563eb);
  color: #fff;
  cursor: pointer;
}
.html-preview-embedded {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}
</style>
```

（样式里的 token 兜底值仅为防拼写漂移的兜底；实施时先在 `apps/web/src/styles/design-tokens.css` 确认实际存在的 `--lnk-*` 名，用实际名替换、删除兜底——**禁止引入 `--neo-*`**。）

- [ ] **Step 4: 跑守卫测试确认通过**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm --filter @lnkpi/web exec vitest run src/components/canvas/HtmlNodePreview.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/canvas/HtmlNodePreview.vue apps/web/src/components/canvas/htmlNodePreviewContract.ts apps/web/src/components/canvas/HtmlNodePreview.test.ts docs/superpowers/specs/2026-10-28-text-node-html-artifact-design.md
git commit -m "feat(web): sandboxed HtmlNodePreview surface with behavior-level guard tests"
```

---

### Task 5: CanvasNodeText format 分支（徽章 + 摘要 + 双击预览）

**Files:**
- Modify: `apps/web/src/components/canvas/CanvasNodeText.vue`
- Modify: `apps/web/src/composables/canvasNodeActions.ts`（追加只读注入键）
- Modify: `apps/web/src/styles/neo-node.css`（`.neo-text-card--html` 徽章样式，:876 既有块附近）
- Test: `apps/web/src/components/canvas/CanvasNodeText.test.ts`（新建，若已有同名校偿则并入）

**Interfaces:**
- Consumes: Task 1 `resolveTextNodeFormat`/`htmlNodeSummary`；Task 4 `HtmlNodePreview`。
- Produces: 注入键 `CANVAS_NODE_READONLY_KEY: InjectionKey<true>`（Task 6 两页 provide；Task 5 消费）。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/components/canvas/CanvasNodeText.test.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CanvasNodeText from './CanvasNodeText.vue'

const BASE = { content: '普通文本', label: '节点' }

function mountNode(data: Record<string, unknown>, providers: Record<symbol, unknown> = {}) {
  return mount(CanvasNodeText, {
    props: { data } as never,
    global: { provide: providers },
  })
}

describe('CanvasNodeText format 分支（规格 §4.2/§4.7）', () => {
  it('无 format ⇒ 既有路径：无双击预览语义、显示原文案', () => {
    const w = mountNode(BASE)
    expect(w.find('.neo-text-card--html').exists()).toBe(false)
    expect(w.text()).toContain('普通文本')
  })
  it("format:'html' ⇒ HTML 徽章 + 摘要，不渲染全文", () => {
    const w = mountNode({ content: '<html><title>落地页</title><body>很长很长的正文</body></html>', format: 'html' })
    expect(w.find('.neo-html-badge').text()).toBe('HTML')
    expect(w.text()).toContain('落地页')
    expect(w.text()).not.toContain('很长很长的正文')
  })
  it('format 非法值 ⇒ 按 plain 走既有路径（fail-soft）', () => {
    const w = mountNode({ ...BASE, format: 'jsx' })
    expect(w.find('.neo-text-card--html').exists()).toBe(false)
  })
  it('只读注入 ⇒ 双击不开预览', async () => {
    const w = mountNode({ content: '<p>x</p>', format: 'html' }, { [READONLY_KEY as symbol]: true })
    await w.find('.neo-text-card--html').trigger('dblclick')
    expect(w.findComponent({ name: 'HtmlNodePreview' }).exists()).toBe(false)
  })
  it('预览保存 ⇒ emit 的 payload 走 patch（html payload 透传）', async () => {
    const patch = vi.fn()
    const w = mountNode({ content: '<p>x</p>', format: 'html' }, { [PATCH_KEY as symbol]: patch })
    await w.find('.neo-text-card--html').trigger('dblclick')
    w.findComponent({ name: 'HtmlNodePreview' }).vm.$emit('save', { content: '<p>y</p>', format: 'html' })
    await nextTick()
    expect(patch).toHaveBeenCalledWith(expect.any(String), { content: '<p>y</p>', format: 'html' })
  })
})
```

（`READONLY_KEY`/`PATCH_KEY` 为 `canvasNodeActions.ts` 导出的注入键；`mount` 的 provide 用真实键对象。测试文件顶部按仓库惯例补 import。）

- [ ] **Step 2: 跑测试确认失败**（命令同 Task 4 模式，目标换 `src/components/canvas/CanvasNodeText.test.ts`）。Expected: FAIL。

- [ ] **Step 3: 实现**

`canvasNodeActions.ts` 追加：

```ts
/** 只读页/回放页注入：true ⇒ 节点组件禁开一切编辑/预览浮层（规格 §9 #12）。 */
export const CANVAS_NODE_READONLY_KEY: InjectionKey<true> = Symbol('CANVAS_NODE_READONLY_KEY')
```

`CanvasNodeText.vue` 修改：

props.data 类型加 `format?: string`；script 追加：

```ts
import HtmlNodePreview from './HtmlNodePreview.vue'
import { CANVAS_NODE_READONLY_KEY } from '@/composables/canvasNodeActions'
import { htmlNodeSummary, resolveTextNodeFormat } from '@lnkpi/shared'

const readonlyPage = inject(CANVAS_NODE_READONLY_KEY, false)
const isHtml = computed(() => resolveTextNodeFormat(props.data) === 'html')
const htmlSummary = computed(() => htmlNodeSummary(props.data as Record<string, unknown>))
const previewOpen = ref(false)

function openHtmlPreview() {
  if (readonlyPage) return
  previewOpen.value = true
}

// 规格 §5.4：emit save → 宿主 patch 通路；patchCanvasNode 缺席（无 patch 通道的宿主）
// 不落 updateNodeData fallback——预览本就不该在只读宿主打开（openHtmlPreview 已拦）。
function onHtmlSave(payload: { content: string; format: 'html' }) {
  if (patchCanvasNode && nodeId) {
    patchCanvasNode(nodeId, { content: payload.content, format: payload.format })
  }
  previewOpen.value = false
}
```

template：在既有 `.neo-text-card` div **之前**加 html 分支，原 div 加 `v-else`（其余内容原样不动，含 NodeStatusInfoButton / NodeTaskCornerActions 两个子组件原位保留）：

```html
    <div
      v-if="isHtml"
      class="neo-text-card neo-text-card--html"
      title="双击打开 HTML 沙箱预览"
      @dblclick.stop="openHtmlPreview"
    >
      <span class="neo-html-badge">HTML</span>
      <p class="neo-html-summary">{{ htmlSummary || 'HTML 产物' }}</p>
      <NodeStatusInfoButton v-if="showStatusInfoButton" :status="data.status" :task-kind="taskKind" :task-id="taskId"
        :node-label="typeof data.label === 'string' ? data.label : undefined" />
      <NodeTaskCornerActions :status="data.status" :started-at="typeof data.generationStartedAt === 'string' ? data.generationStartedAt : undefined"
        :error-message="data.errorMessage as string | undefined" :error-code="data.errorCode as string | undefined"
        :task-kind="taskKind" :task-id="taskId"
        :node-label="typeof data.label === 'string' ? data.label : undefined" :session-id="sessionId" error-detail="status-icon" />
    </div>
    <div v-else class="neo-text-card" title="双击打开沉浸编辑（全屏）" @dblclick.stop="openEditor">
```

在 `</NeoBaseNode>` 结束前、`<PromptMarkdownEditor .../>` 之后加：

```html
    <HtmlNodePreview
      v-if="previewOpen"
      :content="String(data.content ?? '')"
      @save="onHtmlSave"
      @close="previewOpen = false"
    />
```

`neo-node.css`（:876 `.neo-text-card` 块附近追加；只用 `--lnk-*`）：

```css
/* HTML 格式文本节点卡（规格 §4.7）：徽章 + 摘要，节点卡不跑 iframe。 */
.neo-text-card--html {
  gap: var(--lnk-space-1, 4px);
}
.neo-html-badge {
  display: inline-flex;
  align-items: center;
  padding: 0 var(--lnk-space-2, 8px);
  border-radius: var(--lnk-radius-sm, 6px);
  background: var(--lnk-accent-bg, rgb(37 99 235 / 0.12));
  color: var(--lnk-accent-text, #2563eb);
  font-size: 11px;
  font-weight: 500;
  line-height: 20px;
}
.neo-html-summary {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 0;
  color: var(--lnk-text-secondary, inherit);
  font-size: 12px;
}
```

- [ ] **Step 4: 跑测试 + 类型检查 + design-token 守卫**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm --filter @lnkpi/web exec vitest run src/components/canvas/CanvasNodeText.test.ts src/styles/design-token.test.ts src/styles/text-token-guard.test.ts src/styles/dead-styles.test.ts --maxWorkers=1 --no-file-parallelism && pnpm --filter @lnkpi/web exec vue-tsc -b
```
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/canvas/CanvasNodeText.vue apps/web/src/composables/canvasNodeActions.ts apps/web/src/styles/neo-node.css apps/web/src/components/canvas/CanvasNodeText.test.ts
git commit -m "feat(web): CanvasNodeText html format branch (badge + summary + sandbox preview)"
```

---

### Task 6: 只读两页接入 readonly 注入

**Files:**
- Modify: `apps/web/src/pages/CanvasReadonlyPage.vue`（script 顶部 provide）
- Modify: `apps/web/src/pages/ReplayPage.vue`（同上）

**Interfaces:**
- Consumes: Task 5 `CANVAS_NODE_READONLY_KEY`。
- Produces: 无（终态接线）。

- [ ] **Step 1: 实现（两页同款）**

```ts
import { provide } from 'vue'
import { CANVAS_NODE_READONLY_KEY } from '@/composables/canvasNodeActions'

// 只读页（规格 §9 #12 v3 升级）：无 patch 通道，必须关死编辑/预览入口，
// 防 updateNodeData fallback 静默假写（§5.4）。
provide(CANVAS_NODE_READONLY_KEY, true)
```

（CanvasReadonlyPage 另有 `pointer-events: none` 兜底，保留不动。）

- [ ] **Step 2: 验证**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm --filter @lnkpi/web exec vue-tsc -b
```
Expected: PASS。手工核对：两页注入在 `<script setup>` 顶层（setup 时机）。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/CanvasReadonlyPage.vue apps/web/src/pages/ReplayPage.vue
git commit -m "feat(web): provide readonly key on canvas readonly/replay pages"
```

---

### Task 7: 移动端——MobileNodeViewer html 分支 + TTS strip

**Files:**
- Modify: `apps/web/src/components/mobile/MobileNodeViewer.vue`
- Test: `apps/web/src/components/mobile/MobileNodeViewer.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1 `stripHtmlTags`/`resolveTextNodeFormat`；Task 4 `HtmlNodePreview`（embedded 态）。
- Produces: 无（终态接线）。

- [ ] **Step 1: 写失败测试（并入既有 MobileNodeViewer.test.ts 形态）**

```ts
describe('MobileNodeViewer text·html 分支（规格 S5）', () => {
  it("format:'html' ⇒ 渲染沙箱 iframe（sandbox 无 allow-same-origin）", () => {
    const w = mountViewer({ type: 'text', data: { content: '<h1>x</h1>', format: 'html' } })
    const iframe = w.find('iframe')
    expect(iframe.exists()).toBe(true)
    expect(iframe.attributes('sandbox')).not.toContain('allow-same-origin')
  })
  it('无 format ⇒ 既有 viewer-reader 纯文本', () => {
    const w = mountViewer({ type: 'text', data: { content: '纯文本' } })
    expect(w.find('iframe').exists()).toBe(false)
    expect(w.find('.viewer-reader').exists()).toBe(true)
  })
  it('html 节点 TTS 朗读源 = strip-tags 纯文本（非 raw html）', () => {
    // 挂载后直调 exposed 的朗读文本来源断言；若 toggleReaderSpeak 未 expose，
    // 改断言 resolvedBottomActions 含 tts 且组件无 raw content 透出——以可行为断言为准。
  })
})
```

（`mountViewer` 沿用该文件既有挂载工厂；TTS 用例实施时以文件内既有的 tts 测试写法为准——`MobileNodeTile.tts.test.ts` 有可参照模式。）

- [ ] **Step 2: 跑测试确认失败**（web filter，目标 `src/components/mobile/MobileNodeViewer.test.ts`）。Expected: FAIL。

- [ ] **Step 3: 实现**

script 追加：

```ts
import HtmlNodePreview from '@/components/canvas/HtmlNodePreview.vue'
import { resolveTextNodeFormat, stripHtmlTags } from '@lnkpi/shared'

const isHtmlNode = computed(() => resolveTextNodeFormat(props.data as Record<string, unknown>) === 'html')
```

TTS 朗读源改为 strip 同源（`toggleReaderSpeak` 内 `const text = ...` 一行替换为）：

```ts
  const raw = String((props.data as Record<string, unknown> | undefined)?.content ?? '')
  const text = isHtmlNode.value ? stripHtmlTags(raw) : raw
```

`resolvedBottomActions` 的 `hasText` 判据同步用 strip 后文本（html 节点 strip 后为空则不出朗读钮）：

```ts
  const rawContent = String((props.data as Record<string, unknown> | undefined)?.content ?? '')
  const hasText = Boolean((isHtmlNode.value ? stripHtmlTags(rawContent) : rawContent).trim())
```

template text 分支替换：

```html
    <template v-else-if="type === 'text'">
      <HtmlNodePreview
        v-if="isHtmlNode"
        class="viewer-reader viewer-reader--html"
        :content="String(data?.content ?? '')"
        embedded
      />
      <div v-else class="viewer-reader">{{ data?.content }}</div>
    </template>
```

（`.viewer-reader--html` 若需高度适配在既有 scoped style 补 `flex:1; min-height:0;` 一条，用 `--lnk-*`。）

- [ ] **Step 4: 跑测试 + 类型检查**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm --filter @lnkpi/web exec vitest run src/components/mobile/MobileNodeViewer.test.ts src/components/mobile/MobileNodeTile.tts.test.ts --maxWorkers=1 --no-file-parallelism && pnpm --filter @lnkpi/web exec vue-tsc -b
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/mobile/MobileNodeViewer.vue apps/web/src/components/mobile/MobileNodeViewer.test.ts
git commit -m "feat(mobile): sandboxed html preview branch in MobileNodeViewer with strip-tags TTS"
```

---

### Task 8: html-craft skill 落盘 + 接线守卫

**Files:**
- Create: `skills/html-craft/SKILL.md`（**全文 = 规格 §14.4 逐字，禁止自行撰写或改数字**）
- Test: `services/pi-runtime/src/skills/html-craft.wiring.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 loader（`services/pi-runtime/src/skills/loader.ts` `discoverSkills`，零改动，规格 §9 #15）。
- Produces: skill index 新条目 `html-craft`；`observeSkillLoad('html-craft')` 指标（机制现状，零改动）。

- [ ] **Step 1: 写失败接线守卫测试**

```ts
// services/pi-runtime/src/skills/html-craft.wiring.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverSkills } from "./loader.js";

const SKILLS_ROOT = fileURLToPath(new URL("../../../../skills", import.meta.url));

/** 规格 §10 skill 接线守卫：html-craft 必须能被 loader 发现且描述含触发词——
 *  装了但路由不到 = 重演 tool_search 触发率为 0 的失效（observeSkillLoad 无样本可观测）。 */
describe("html-craft skill wiring", () => {
  it("discoverSkills 含 html-craft 且描述含触发词", () => {
    const entries = discoverSkills(SKILLS_ROOT);
    const entry = entries.find((e) => e.name === "html-craft");
    assert.ok(entry, "html-craft 未被 loader 发现（检查目录名/frontmatter name）");
    for (const word of ["网页", "原型", "HTML"]) {
      assert.ok(entry.description.includes(word), `description 缺触发词: ${word}`);
    }
  });
  it("正文含环境硬约束关键句（CSP 白名单/图片禁外链/弹窗失效/数据边界）", () => {
    const body = readFileSync(new URL("../../../../skills/html-craft/SKILL.md", import.meta.url), "utf8");
    for (const needle of [
      "cdnjs.cloudflare.com",
      "远程图片",
      "alert / confirm / prompt",
      "取不到的字段一律不写、不编造",
      "load_skill",
    ]) {
      assert.ok(body.includes(needle), `SKILL.md 缺关键约束: ${needle}`);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm --filter @pi-lnk/pi-runtime exec vitest run src/skills/html-craft.wiring.test.ts --maxWorkers=1 --no-file-parallelism
```
Expected: FAIL（目录不存在）。

- [ ] **Step 3: 落盘 SKILL.md**

创建 `skills/html-craft/SKILL.md`，内容**逐字复制**规格 `docs/superpowers/specs/2026-10-28-text-node-html-artifact-design.md` §14.4 代码块内全文（从 `---` frontmatter 到「□ 标题层级清晰」止）。禁止改动任何数字（≤4 次、≤40 字符、盒宽公式 ×7/×6/+24、色系 ≤2 等）。

- [ ] **Step 4: 跑接线守卫确认通过**（命令同 Step 2）。Expected: PASS。

- [ ] **Step 5: 垂类 skill 路由核查（规格 §9 #16，按需）**

```bash
grep -rln "网页\|落地页\|HTML" skills/ --include="*.md" | grep -v html-craft
```
若有垂类 skill 正文涉及「产出网页」语义 ⇒ 该文件补一段 R1 段落级指引（保留「## 工具可用性」小节结构，指引指向 `set_node_text format:'html'` + `load_skill('html-craft')`）；若无（预期如此：现有 8 个垂类均为短剧/电商图像视频语义）⇒ 记录 grep 结果到 PR 描述，零改动。

- [ ] **Step 6: Commit**

```bash
git add skills/html-craft/SKILL.md services/pi-runtime/src/skills/html-craft.wiring.test.ts
git commit -m "feat(skills): html-craft quality skill (WorkBuddy widget_guidelines pattern, verbatim from spec §14.4)"
```

---

### Task 9: 终验——旁路清单、回归线、全量绿

**Files:** 无新增改动（只验证；发现红即回对应任务修复后重跑本任务）。

**Interfaces:** Consumes 全部前序任务。

- [ ] **Step 1: 旁路系统验证（§4.11，零改动路径 format 随行）**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm test:server -- src/agent --maxWorkers=1 --no-file-parallelism
```
并核对既有测试覆盖三条旁路（`duplicateToCanvasActions` 的 `data: node.data ?? {}` 整包拷贝 / undo-redo data patch 透传 / workflowExchange 导入导出）。若既有用例未直接断言 `format` 字段随行，补一条最小断言用例（在对应旁路测试文件内，构造 `data: { content:'<p>x</p>', format:'html' }` 的节点走往返，断言 format 仍在）。

- [ ] **Step 2: 回归线（G3）**

```bash
source ~/.nvm/nvm.sh && nvm use 24 && pnpm --filter @pi-lnk/pi-runtime exec vitest run --maxWorkers=1 --no-file-parallelism && pnpm test:server && pnpm --filter @lnkpi/shared exec vitest run --maxWorkers=1 --no-file-parallelism && pnpm --filter @lnkpi/web exec vitest run --maxWorkers=1 --no-file-parallelism && pnpm --filter @lnkpi/web exec vue-tsc -b
```
Expected: 全绿（存量文本节点双击编辑、P1-1 媒体闸门报错文案、replay 用例不红）。

- [ ] **Step 3: 规格与文档同步核查**

```bash
pnpm verify-spec-figures --file docs/superpowers/specs/2026-10-28-text-node-html-artifact-design.md && pnpm verify-links
```
Expected: 0 错误 0 警告 / 链接通过。

- [ ] **Step 4: 目视验收走查（规格 §10；需要 dev server，人工/截图）**

S1 创建（说「做个落地页」→ 徽章节点）、S2 沙箱（内联脚本运行、外网请求被 CSP 阻断）、S3 预览/源码编辑保存、S4 迭代刷新、S5 移动端 viewer、S8 只读页无编辑入口。每场景一条截图证据贴 PR。

- [ ] **Step 5: PR（squash merge；push 走 api.github.com REST Git Data API）**

PR 描述必含：规格链接（v4）、`observeSkillLoad('html-craft')` 观测说明（上线后看命中率）、§14.5 工具描述 token 增量核对（system 总量前后对比）、Tiering/契约三脚本输出、回退方案（revert 单 PR）。

---

## Self-Review 记录（写计划时已跑）

1. **Spec 覆盖**：§9 #1–#3 → Task 1；#4–#7 → Task 3/2；#8/#10 → Task 5；#11 → Task 4；#12 → Task 6；#13 → Task 7；#14 → Task 8；#15/#16 → Task 8 Step 5（验证/按需）；§6 S1–S9 → Task 9 Step 4 + 各任务测试；§4.11 旁路 → Task 9 Step 1。无缺口。
2. **占位符扫描**：Task 2 Step 2 的 batch 用例与 Task 7 的 mountViewer/tts 断言为「按既有文件形态写全」——属结构引用（同文件既有工厂/用例），非 TBD；实施者打开对应文件即可逐字照抄形态。其余步骤均含真实代码。
3. **类型一致性**：`assertTextNodeFormat`/`resolveTextNodeFormat`/`htmlNodeSummary`/`stripHtmlTags`/`CANVAS_NODE_READONLY_KEY`/`HTML_NODE_CSP`/`HTML_NODE_SANDBOX_ATTRS`/`save payload { content, format }` 各任务引用与定义一致。
4. **Review Focus → 测试映射**：①→Task 4 守卫；②→Task 5 组件测试 + Task 9 Step 2；③→Task 1/2/3 三层各自非法值用例；④→Task 9 Step 1；⑤→Task 8 接线守卫。
