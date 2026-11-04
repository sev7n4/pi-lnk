# SSE 对话回合 · 反馈图标重绘 + 分享能力（复刻 WorkBuddy）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移动端 SSE 对话流新增「分享」能力（微信 / 生成图片 / 复制链接 / 生成二维码 / 离线打开 五模式）+ 重绘有帮助/无帮助图标；以一份**跨端共享**、自包含 HTML 模板为唯一真相源，托管页走 nginx 静态直出绕过 Nest。

**Architecture:** 一份自包含 HTML 模板（`buildShareHtml` 纯函数，位于 `@lnkpi/shared/shareTemplate`）为唯一真相源，三类消费者复用：① 离线 `Blob` 本地打开；② `html-to-image` 导出 PNG；③ 后端 `POST` 双写 DB + 落盘静态 `/share/<id>.html`（含 OG），公开访问由 nginx 直出绕过 Nest。前端仅移动端：回合级入口在 `AgentSideRail` 移动操作栏、会话级入口在 `MobileTopBar` ⋯ 菜单，二者共用 `ConversationShareSheet`（`MobileSheet` 唯一基座），仅默认勾选集合不同。模板支持结构化 `parts`（text/thinking/tool/image/video/mermaid/node_graph/html），折叠内容用原生 `<details>`、HTML 产物用 `<iframe srcdoc sandbox>`——离线零 JS 可展开、Node 端可直接渲染（**模板禁止任何 DOM/browser API**）。

**Tech Stack:** Vue 3 + TypeScript + vitest（web，`--maxWorkers=1 --no-file-parallelism`）；NestJS + Prisma + vitest（server）；`qrcode`（已装）+ `html-to-image`（新增）；`@lnkpi/shared`（既有 workspace 包，承载纯函数）；nginx 静态直出 + 共享卷。

**Spec:** `docs/superpowers/specs/2026-11-04-conversation-turn-share-and-feedback-icons.md`（已自审整改，verify-spec-figures 0/0；执行者须同读规格与本计划）

## Global Constraints

- **仅移动端**：本期改 `AgentSideRail` 移动操作栏、`MobileTopBar`、`MobileCanvasShell`、`CanvasPage` 移动壳层；PC 端文件**不改动**（会话级 `WorkspaceTopBar`、桌面操作栏分享按钮、桌面抽屉变体均属 §12 后续包）。
- **图标判据**：viewBox `0 0 24 24`；`stroke-width="1.5"`（用令牌 `--lnk-icon-stroke`）；`stroke-linecap/linejoin="round"`；`fill="none"`；`stroke="currentColor"`；激活态 = 填充 `--lnk-accent`。禁用 emoji、第三方图标库、裸 hex（用令牌或 currentColor）。
- **分享模板判据**：自包含——内联 `<style>`，**零外链 `<script src>`/`<link href>`、零运行时 CSS 变量依赖**（离线打开无站点样式，必须用内联具体色值）；内容含对话文本 + 图片缩略（URL 或内联 base64）。
- **复制链接判据**：**必须在点击事件的同步回调里**调 `navigator.clipboard.writeText`（iOS 放异步后调用会静默失败）。
- **二维码判据**：容错级 `M`（~15%），尺寸 180–240、margin 2；复用 `qrcode` 包。
- **微信落地判据**：生成托管 URL 的二维码 + 复制链接，用户在微信扫码打开托管 HTML 原文；**不接 JSSDK**（非原生卡片，已与用户确认）。
- **多选判据**：进入面板默认全选；勾选实时更新「已选中 N 条」；分享内容 = 勾选消息有序集合（按时间升序）。
- **安全判据（XSS）**：对话文本进模板**必须 `escapeHtml`**，禁止 `innerHTML` 注入未转义内容。
- **移动端浮层唯一基座**：分享面板移动端**必须**走 `MobileSheet.vue`（G-15 约束），不得在主组件长媒体查询补丁。
- **设计令牌**：仅 `--lnk-*`（禁 `--neo-*` / 新增 hex / emoji）；图标内联 SVG 24 网格 stroke 1.5；移动端触控 ≥44px。
- **html-to-image 兼容**：模板用内联具体色值，不引运行时 CSS 变量。
- **后端静态化契约**：`POST` 双写 `conversation_shares` + 落盘 `SHARE_DIR/<id>.html`（含 OG meta，OG 在落盘时注入）；公开访问由 **nginx 直出**（`location /share/ try_files`）**绕过 Nest**；`POST` 用 `AuthGuard` + **轻量自研内存限频守卫**（见 Task 8，非 `@nestjs/throttler`——该包未安装，不引入重依赖）；`expires_at` TTL 清理用 **`setInterval`（onModuleInit 注册，onModuleDestroy 清理，无 `@nestjs/schedule` 依赖）**。
- **跨端共享契约**：`buildShareHtml` / `escapeHtml` / `ShareTurn` / `ShareTurnPart` 类型 **唯一实现于 `@lnkpi/shared/shareTemplate.ts`**，web（`useShareActions`）与 server（`share.service`）均从此导入，禁止 web/server 双份拷贝。**模板纯函数必须 DOM-free**（不引用 `window`/`document`/`DOMParser`/`XMLSerializer`）——SVG/HTML 的净化在客户端提取阶段完成，模板只内联已净化的信任字符串（server 端 Node 环境无 DOM API）。
- **数据流入契约**：`ConversationShareSheet` 经 `turns: ShareTurn[]` prop 接收；数据组装责任在调用方（回合级传 `[当前 turn]`、会话级传 `[全部 turns]`）；调用方在组装 `turns` 时把 thinking/tool/mermaid/node_graph Svg/html 产物等结构化内容抽进 `parts`（mermaid/node_graph 的 `svg` 须是**已净化**字符串；html 产物的 `content` 由调用方经 `get_node` 取全文）。
- **统一落盘目录**：server 落盘与 nginx 直出**共用同一路径** `SHARE_DIR`（默认 `/app/share`，可用 env 覆盖），docker 共享卷把该目录同时挂进 Nest 容器与 nginx 容器（同一 mount path），nginx `alias` 即指向 `SHARE_DIR`（见 Task 8/9）。
- **测试纪律**：vitest `--maxWorkers=1 --no-file-parallelism`；web 改组件后必跑 `vue-tsc -b`；server 改后必跑 `npx tsc --noEmit` + 其 test。
- **推送纪律**：git https 502 走 REST Git Data API（blob sha 逐项核对）；commit 只在 worktree。

## Review Focus

1. **XSS 注入**：用户文本含 `<img src=x onerror=alert(1)>` 或 `<script>` 时，分享 HTML 渲染后脚本**不执行**（转义生效）。→ Task 1 单测 ③ 钉死。
2. **复制链接静默失败**：在移动端（尤其 iOS Safari）点击「复制链接」必须真的写入剪贴板，不能在 `await` 之后才调 `clipboard.writeText`。→ Task 3 step 断言同步回调内调用。
3. **离线媒体降级**：离线打开图片内联 base64 时，若 `fetch` 媒体失败（鉴权过期/网络），必须降级为占位图而非整页崩溃或空白。→ Task 3 `openOffline` 的 fetch 失败分支覆盖。
4. **nginx 直出真绕过 Nest**：外部访问 `/share/<id>.html` 必须由 nginx 直接返回静态文件，**不命中 Nest 业务路由**（验证零计算占用）。→ Task 9 集成验收。
5. **TTL 清理原子性**：过期清理触发后，DB 行与静态文件**二者必须同步删除**（不能只删其一导致孤儿文件或 404）。→ Task 8 清理单测 + 集成。
6. **模板 Node 端可渲染（DOM-free）**：`buildShareHtml` 在 server（Node，无 DOM）被调用不得抛 `window is not defined` / `document is not defined`。→ Task 1 单测（纯 node 环境跑）覆盖 ⑥⑦⑨，Task 8 集成调用同一函数验证不依赖 DOM。

---

### Task 1: shared — `escapeHtml` + `buildShareHtml` 纯函数 + 类型（跨端单源）

**Files:**
- Create: `packages/shared/src/shareTemplate.ts`
- Create: `packages/shared/src/shareTemplate.test.ts`
- Modify: `packages/shared/src/index.ts`（导出 `escapeHtml`/`buildShareHtml`/`ShareTurn`/`ShareTurnPart`/`ShareHtmlOptions`）
- Modify: `packages/shared/package.json`（`exports` 增加 `"./shareTemplate": "./src/shareTemplate.ts"`）

**Interfaces:**
- Produces:
  - `escapeHtml(s: string): string`（转义 `& < > " '` 五类；纯函数，无 DOM）
  - 类型 `ShareTurnPart`（联合）：
    - `{ type:'text'; text:string }`
    - `{ type:'thinking'; text:string; done:boolean }`（渲染为 `<details>` 默认收起）
    - `{ type:'tool'; name:string; args?:unknown; result?:unknown; isError?:boolean }`（渲染为 `<details>`）
    - `{ type:'image'; url:string; caption?:string }`
    - `{ type:'video'; url:string; posterUrl?:string; title?:string; durationMs?:number }`（渲染为占位卡：标题+时长+在线链接）
    - `{ type:'mermaid'; svg:string; code?:string }`（`svg` 须为**已净化**字符串；包进 `<details>`）
    - `{ type:'node_graph'; svg:string; title?:string }`（同 mermaid 处理）
    - `{ type:'html'; content:string; title?:string }`（agent HTML 产物；内联 `<iframe srcdoc sandbox="allow-scripts">` + CSP meta）
  - 类型 `ShareTurn = { id:string; role:'user'|'assistant'; contentText?:string; parts?:ShareTurnPart[]; createdAt:number; attachments?: Array<{kind:'image'|'video'|'file'; url:string; thumbUrl?:string}> }`（parts 优先；无 parts 时由 contentText+attachments 推导）
  - 类型 `ShareHtmlOptions = { inlineMedia?:'online'|'offline'; includeOg?:boolean; og?:{title:string; description:string; image?:string} }`
  - `buildShareHtml(turns: ShareTurn[], opts?: ShareHtmlOptions): string` —— 自包含 HTML 字符串（内联 `<style>`，无外链 script/link，无运行时 CSS 变量；`inlineMedia==='offline'` 时图片 `url` 已是 `data:` URI 则原样用、否则保留外链占位；`includeOg` 时 `<head>` 注入 OG meta）。**纯函数，不 fetch、不引 DOM。**

- [ ] **Step 1: 写失败测试**（覆盖 spec §8 ①–⑨ + 视频 + OG）

```ts
import { describe, it, expect } from 'vitest'
import { buildShareHtml, escapeHtml, type ShareTurn, type ShareTurnPart } from './shareTemplate'

const turn = (over: Partial<ShareTurn> = {}): ShareTurn => ({
  id: 't1', role: 'user', contentText: 'hi', createdAt: 0, ...over,
})
const parts = (p: ShareTurnPart[]): ShareTurn => turn({ parts: p })

describe('buildShareHtml', () => {
  it('① 自包含：无外链 script/link', () => {
    const h = buildShareHtml([turn()])
    expect(h).not.toMatch(/<script\s+src=/i)
    expect(h).not.toMatch(/<link\s+href=/i)
    expect(h).toContain('<style>')
  })
  it('② 空 turns 兜底不抛错', () => {
    expect(() => buildShareHtml([])).not.toThrow()
    expect(buildShareHtml([])).toContain('暂无分享内容')
  })
  it('③ XSS：注入 onerror 不执行', () => {
    const evil = '<img src=x onerror=alert(1)>'
    const h = buildShareHtml([turn({ contentText: evil })])
    expect(h).toContain(escapeHtml(evil))
    expect(h).not.toContain('<img src=x onerror=alert(1)>')
  })
  it('④ 图片附件以 <img src=url> 呈现', () => {
    const h = buildShareHtml([turn({ attachments: [{ kind:'image', url:'https://x/a.png' }] })], { inlineMedia:'online' })
    expect(h).toContain('<img src="https://x/a.png"')
  })
  it('⑤ 离线副本不依赖运行时 CSS 变量', () => {
    const h = buildShareHtml([turn()])
    expect(h).not.toMatch(/var\(--/)
  })
  it('⑥ 折叠块渲染为原生 <details>，thinking 默认收起（无 JS 可展开）', () => {
    const h = buildShareHtml([parts([ { type:'thinking', text:'let me think', done:true } ])])
    expect(h).toContain('<details')
    expect(h).toContain('<summary')
    expect(h).toMatch(/<details[^>]*open[^>]*>/) // 仅 tool 可能 open；thinking 收起 ⇒ 不应带 open
    expect(h).not.toMatch(/<details[^>]*>\s*<summary[^>]*>.*<\/summary>\s*<script/i)
    expect(h).not.toContain('useDisclosure') // 不搬 JS 状态机
  })
  it('⑦ Mermaid 内联已净化 SVG，无 mermaid 库/无 script', () => {
    const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    const h = buildShareHtml([parts([ { type:'mermaid', svg, code:'graph TD' } ])])
    expect(h).toContain('<details')
    expect(h).toContain(svg)
    expect(h).not.toContain('<script')
  })
  it('⑧ offline 模式图片内联 data: URI', () => {
    const h = buildShareHtml([turn({ attachments:[{kind:'image', url:'data:image/png;base64,AAAA'}]})], { inlineMedia:'offline' })
    expect(h).toContain('data:image')
  })
  it('⑨ agent HTML 产物内联为 iframe srcdoc sandbox + CSP', () => {
    const html = '<h1>artifact</h1>'
    const h = buildShareHtml([parts([ { type:'html', content: html, title:'产物' } ])])
    expect(h).toContain('<iframe')
    expect(h).toContain('srcdoc=')
    expect(h).toContain('sandbox="allow-scripts"')
    expect(h).toContain('default-src &#39;none&#39;') // HTML_NODE_CSP 内联（转义后）
    // 沙箱内脚本不得获取父页面：断言 sandbox 无 allow-same-origin / allow-top-navigation
    expect(h).not.toMatch(/allow-(same-origin|top-navigation)/)
  })
  it('video 附件渲染为占位卡（非坏链）', () => {
    const h = buildShareHtml([turn({ attachments:[{kind:'video', url:'https://x/v.mp4'}]})])
    expect(h).toContain('在线观看')
    expect(h).not.toContain('<video')
  })
  it('includeOg 注入 OG meta', () => {
    const h = buildShareHtml([turn()], { includeOg:true, og:{ title:'T', description:'D', image:'https://x/og.png' } })
    expect(h).toContain('og:title')
    expect(h).toContain('og:description')
    expect(h).toContain('og:image')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `cd packages/shared && pnpm vitest run src/shareTemplate.test.ts --maxWorkers=1 --no-file-parallelism` → FAIL（模块不存在）
- [ ] **Step 3: 最小实现**（`shareTemplate.ts`，约 160–220 行）：
  - `escapeHtml`：转义 `& < > " '`（同 `node-graph-export.ts` 实现，纯函数）。
  - 定义 `ShareHtmlOptions` / `ShareTurnPart` / `ShareTurn` 联合类型。
  - `HTML_NODE_CSP` 常量（复刻 `htmlNodePreviewContract.ts` 的值：`"default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'"`；注释要求与 `htmlNodePreviewContract` 保持同步）。
  - `buildShareHtml`：
    - 拼 `<!doctype html><html><head><meta charset><style>具体色值内联</style>`；`includeOg` 时注入 `<meta property="og:*">`（title/description/image 用 `escapeHtml`）。
    - `renderTurn(turn)`：role 决定气泡左右；`turn.parts ?? deriveFromContent(turn)` 遍历渲染：`text`→`<p>`转义；`thinking`→`<details><summary>思考过程</summary><div>转义text</div></details>`（**不**带 `open`）；`tool`→`<details open><summary>工具：name</summary>...</details>`；`image`→`<img src=url>`（offline 模式 url 已是 data: 则原样）；`video`→占位卡 `div`（标题+「在线观看」链接，不含 `<video>`）；`mermaid`/`node_graph`→`<details><summary>图表/画布</summary> svg(原样，已净化)</details>`；`html`→`<iframe srcdoc="<meta CSP>escapedContent" sandbox="allow-scripts"></iframe>`（`srcdoc` 值需对 `"` 转义为 `&quot;`、`&` 转义为 `&amp;`，content 自身已 escapeHtml）。
    - `deriveFromContent(turn)`：无 parts 时 `contentText`→text part；`attachments`→image/video parts。
    - **禁止**任何 `window`/`document`/`DOMParser` 引用。
- [ ] **Step 4: 跑测试确认通过** + **变异**：把 `contentText` 渲染改成不经 `escapeHtml` → ③ 必须红；把 `thinking` 的 `<details>` 去掉 → ⑥ 必须红。
- [ ] **Step 5: 更新 `packages/shared/src/index.ts`** 导出上述符号；`package.json` 的 `exports` 增加 `"./shareTemplate": "./src/shareTemplate.ts"`。Commit `feat(shared): buildShareHtml 跨端共享自包含模板纯函数（唯一真相源）`

---

### Task 2: web — 图标重绘 + 操作栏（移动端）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（移动操作栏 `agent-msg-actions` 区块；重绘有帮助/无帮助 SVG 为 stroke 1.5 + 激活填充，新增分享按钮 SVG）
- Test: `apps/web/src/components/agent/AgentSideRail.icon.test.ts`（静态契约：读文件 stripComments 后正则断言图标 `stroke-width="1.5"`、无 emoji、激活态含 `--lnk-accent`）

**Interfaces:**
- Consumes: 设计令牌 `--lnk-accent`、`--lnk-icon-stroke`（先 grep `design-tokens.css` 确认存在，无则新增 `--lnk-icon-stroke: 1.5`）
- Produces: 移动端 assistant 回合操作栏四项 `[有帮助][无帮助][复制][分享]`；分享按钮 `@click` 暂发自定义事件 `share`（Task 5 接面板）

- [ ] **Step 1: 写静态契约失败测试**（断言项：有帮助/无帮助图标 `stroke-width="1.5"`；存在 `currentColor`；分享图标存在；无 `<emoji>`/裸 hex）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
  - 有帮助/无帮助：把现有 `stroke-width="1.75"` 改为 `1.5`，保留 `fill="none"`；激活态（本地 `ref` 切换）时增加 `:fill="active ? 'var(--lnk-accent)' : 'none'"` + `:stroke="'var(--lnk-accent)'"`。
  - 新增分享按钮：内联 SVG（24 网格、分享箭头、`stroke="currentColor"`、`fill="none"`、`stroke-width="1.5"`），`@click="$emit('share')"`。
  - 沿用现有 hover/focus 显形规则；**仅移动端操作栏**（桌面端 `agent-msg-actions` 本期不改）。
- [ ] **Step 4: 跑测试确认通过** + 跑 `apps/web/src/styles/design-token.test.ts` 守卫
- [ ] **Step 5: Commit** `feat(web): 重绘有帮助/无帮助图标(stroke1.5+激活态)+新增移动端分享按钮`

---

### Task 3: web — `useShareActions` composable（五种模式）

**Files:**
- Create: `apps/web/src/composables/useShareActions.ts`
- Test: `apps/web/src/composables/useShareActions.test.ts`

**Interfaces:**
- Consumes: `buildShareHtml`/`escapeHtml`/`ShareTurn`/`ShareTurnPart`（来自 `@lnkpi/shared/shareTemplate`）；`useQrDataUrl`（已存在）；`@/utils/copyToClipboard`；`html-to-image`（新增依赖）
- Produces:
  - `useShareActions()` 返回 `{ openOffline, toImage, copyLink, toQr, toWeChat }`
  - `upload(turns: ShareTurn[], sessionId: string): Promise<{ shareId: string; url: string }>`（内部 `fetch('/api/share/conversation', { method:'POST', headers:{Authorization}, body: JSON.stringify({ sessionId, turns }) })`）
  - `openOffline(turns)` —— 对 `parts`/attachments 中 `kind==='image'` 且 `url` 非 `data:` 者，并行 `fetch`→`blob`→`FileReader.readAsDataURL` 预内联为 `data:` URI（**失败降级占位**）后 `buildShareHtml(turns, { inlineMedia:'offline' })` → `Blob('text/html')` → `window.open(URL.createObjectURL(blob))` 或下载 `.html`
  - `toImage(turns)` —— `buildShareHtml(online)` 渲染进隐藏预览层 → `html-to-image` → 弹窗预览/下载 PNG
  - `copyLink(turns, sessionId)` —— `const { url } = await upload(turns, sessionId)` 后，在**点击同步回调** `navigator.clipboard.writeText(url)` + toast「链接已复制」
  - `toQr(turns, sessionId)` / `toWeChat(turns, sessionId)` —— 均先 `upload` 拿 url，再用 `useQrDataUrl` 生成二维码 dataURL 展示（微信=展示二维码+复制链接按钮）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { useShareActions } from './useShareActions'

describe('useShareActions', () => {
  it('openOffline 内联图片 base64 后生成 Blob（失败降级不崩）', async () => {
    const blobUrl = 'blob:http://x/1'
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(blobUrl)
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const actions = useShareActions()
    await actions.openOffline([{ id:'t', role:'user', contentText:'x', createdAt:0,
      attachments:[{ kind:'image', url:'https://x/a.png' }] }])
    expect(window.open).toHaveBeenCalled()
  })
  it('copyLink 在同步回调写入剪贴板（非 await 后）', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText: write } })
    const actions = useShareActions()
    await actions.copyLink([{ id:'t', role:'user', contentText:'x', createdAt:0 }], 'sess-1')
    expect(write).toHaveBeenCalledWith(expect.stringContaining('/share/'))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（upload 带 `sessionId`；`copyLink`/`toQr`/`toWeChat` 调用方传入 `sessionId`；`openOffline` fetch 失败分支 try/catch 降级为占位 img；toast 用项目既有 toast 工具）
- [ ] **Step 4: 跑测试确认通过** + **变异**：把 `copyLink` 里的 `writeText` 移到 `await` 之后的微任务 → 测试必须红
- [ ] **Step 5: 安装依赖** `cd apps/web && pnpm add html-to-image`，Commit `feat(web): useShareActions 封装五模式(离线/图片/链接/二维码/微信)`

---

### Task 4: web — `ConversationShareSheet` 组件

**Files:**
- Create: `apps/web/src/components/agent/ConversationShareSheet.vue`
- Test: `apps/web/src/components/agent/ConversationShareSheet.test.ts`

**Interfaces:**
- Consumes: `useShareActions`（Task 3）；`MobileSheet`（既有移动端浮层基座）；`ShareTurn` 类型（`@lnkpi/shared/shareTemplate`）
- Produces: 组件 `ConversationShareSheet`，props `{ turns: ShareTurn[]; sessionId: string; modelValue: boolean }`，emits `update:modelValue`；内部多选列表（默认全选）+ 标题「已选中 N 条对话」+ 两行模式网格（行1 微信/朋友圈/QQ/企业微信；行2 生成图片/复制链接/生成二维码/更多→离线打开）；点击模式时显示**上传 loading**（`useShareActions` 的 upload 期间禁用按钮 + spinner）

- [ ] **Step 1: 写失败测试**（默认全选 → 「已选中 N 条」随勾选实时更新；点击各模式调 `useShareActions` 对应方法并展示 loading）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
  - 用 `MobileSheet` 包裹；`selected = ref(turns.map(t=>t.id))` 默认全选；`count = computed(()=>selected.value.length)` 标题 `已选中 ${count} 条对话`。
  - 两行网格（对齐 spec 图 1）：行1 彩色品牌渠道（微信为真实入口，朋友圈/QQ/企业微信首期同落「二维码+链接」）；行2 深灰功能（生成图片/复制链接/生成二维码/更多→离线打开）。
  - 每个模式按钮 `@click` 调 `const a = useShareActions(); await a.copyLink(selectedTurns(), props.sessionId)` 等；`selectedTurns()` = `turns.filter(t=>selected.includes(t.id))` 按时间升序；点击期间 `loading` 态。
- [ ] **Step 4: 跑测试确认通过** + 跑 `vue-tsc -b`
- [ ] **Step 5: Commit** `feat(web): ConversationShareSheet 移动端分享面板(多选+两行网格+loading)`

---

### Task 5: web — 回合级入口接线（移动操作栏 → 面板）

**Files:**
- Modify: `apps/web/src/components/agent/AgentSideRail.vue`（移动操作栏分享按钮 `@click` 接面板）
- Test: `apps/web/src/components/agent/AgentSideRail.share-entry.test.ts`

**Interfaces:**
- Consumes: `ConversationShareSheet`（Task 4）；当前回合消息数据（**实施时 grep `agent-msg-actions` 上下文确认 `AgentStreamMessage` 字段名**，映射为单个 `ShareTurn` —— 用 `message.content` + `message.attachments` +（若 `message.timeline` 存在）`message.timeline.parts` 抽成 `ShareTurnPart[]`；helper 放 `lib/share/toShareTurn.ts`）
- Produces: 点击分享按钮 → 用 `[当前 turn 的 ShareTurn]` + `sessionId` 打开 `ConversationShareSheet`（默认勾选仅本轮）

- [ ] **Step 1: 建 `lib/share/toShareTurn.ts`**（共享 mapper：`toShareTurn(msg: AgentStreamMessage, sessionId): ShareTurn`；优先用 `msg.timeline?.parts` 映射 thinking/tool/image/video/mermaid(svg from DOM? 见下)/html；无 timeline 时退化为 `contentText`+`attachments`。mermaid/node_graph 的 `svg` 提取：从 `msg.presentation?.body?.svg`/`mermaid` 等运行时字段——若该字段已是净化 SVG 字符串则直接用；否则降级为 text part。html 产物：若 `msg.linkedOutputs` 含 html 节点，需 `get_node` 异步取全文，本 Task 先留接口、`toShareTurn` 同步路径仅取已可用的文本/图片，html 部分由调用方在打开面板前 `await resolveArtifactContents(turns)` 补全）
- [ ] **Step 2: 在该组件内引入 `ConversationShareSheet`** `<ConversationShareSheet v-model="shareOpen" :turns="shareTurns" :session-id="sessionId" />`，`shareOpen=ref(false)`，`shareTurns=ref<ShareTurn[]>([])`
- [ ] **Step 3: 分享按钮 `@click`** 改为 `shareTurns = [toShareTurn(currentMsg, sessionId)]; shareOpen = true`
- [ ] **Step 4: 组件测试** 断言点击分享按钮后 `shareOpen=true` 且 `shareTurns` 长度为 1
- [ ] **Step 5: 跑 `vue-tsc -b`** + Commit `feat(web): 回合级分享入口(操作栏→面板,默认本轮)`

---

### Task 6: web — 会话级入口接线（顶栏 ⋯ → 面板）

**Files:**
- Modify: `apps/web/src/components/mobile/MobileTopBar.vue`（chat tab ⋯ 菜单新增「分享会话」项，`emit('share')`）
- Modify: `apps/web/src/components/mobile/MobileCanvasShell.vue`（转发 `@share="onShare"`）
- Modify: `apps/web/src/pages/CanvasPage.vue`（实现 `openShare()` 取全部 turns 打开面板）

**Interfaces:**
- Consumes: `ConversationShareSheet`（Task 4）；`toShareTurn`（Task 5）；当前会话全部消息（`grep MobileTopBar/CanvasPage` 确认取数方式，如 store 或 provide/inject 的 messages 列表）
- Produces: 顶栏 ⋯ → `emit('share')` → `MobileCanvasShell` 转发 → `CanvasPage.openShare()` 用 `[全部 turns]` + `sessionId` 打开面板（默认全选）

- [ ] **Step 1: grep 确认链路** `grep -rn "emit('more'\|@more\|onMore" apps/web/src/components/mobile/MobileTopBar.vue apps/web/src/components/mobile/MobileCanvasShell.vue` 确认现有 ⋯ 菜单事件命名，新事件沿用 `share`。
- [ ] **Step 2: `MobileTopBar.vue`** chat tab ⋯ 下拉菜单加「分享会话」项，`@click="$emit('share')"`（置于「发布作品」「导出工作流」附近）
- [ ] **Step 3: `MobileCanvasShell.vue`** 转发 `<MobileTopBar @share="onShare" />`，`onShare` 再 `emit('share')`
- [ ] **Step 4: `CanvasPage.vue`** 实现 `openShare()`：`shareTurns.value = allSessionTurns().map(m => toShareTurn(m, sessionId)); shareOpen.value = true`
- [ ] **Step 5: 组件测试** 断言顶栏「分享会话」点击 → `shareOpen=true` 且 `shareTurns` 长度 = 会话消息数
- [ ] **Step 6: 跑 `vue-tsc -b`** + Commit `feat(web): 会话级分享入口(顶栏⋯→面板,默认全选)`

---

### Task 7: server — Prisma `conversation_shares` 表 + migration

**Files:**
- Modify: `apps/server/prisma/schema.prisma`
- Create: migration（`pnpm --filter server prisma migrate dev --name add_conversation_shares`）

**Interfaces:**
- Produces: 表 `conversation_shares { id String @id @default(cuid()); sessionId String; htmlSnapshot String; staticPath String; createdAt DateTime @default(now()); expiresAt DateTime? }`

- [ ] **Step 1: 在 schema.prisma 追加 model**（字段如上；`grep -n "id String" apps/server/prisma/schema.prisma` 看既有 id 策略保持一致）
- [ ] **Step 2: 生成 migration** `cd apps/server && npx prisma migrate dev --name add_conversation_shares`（生产走 `prisma migrate deploy`，勿手工 ALTER）
- [ ] **Step 3: 跑 server 测试确认 schema 编译** `cd apps/server && npx tsc --noEmit`
- [ ] **Step 4: Commit** `feat(server): conversation_shares 表 + migration`

---

### Task 8: server — `share` 模块（双写 + 静态化 + TTL 清理 + 限频）

**Files:**
- Create: `apps/server/src/share/share.controller.ts`
- Create: `apps/server/src/share/share.service.ts`
- Create: `apps/server/src/share/share.module.ts`
- Create: `apps/server/src/share/share-rate-limit.guard.ts`（轻量内存限频守卫）
- Test: `apps/server/src/share/share.service.spec.ts`

**Interfaces:**
- Consumes: `conversation_shares` 表（Task 7）；`@lnkpi/shared/shareTemplate` 的 `buildShareHtml`/`ShareTurn`（**跨端单源，禁止在 server 复制实现**）；前端 `POST` body `{ sessionId: string; turns: ShareTurn[] }`（字段与 web 一致）
- Produces:
  - `POST /api/share/conversation`：`AuthGuard` + `ShareRateLimitGuard`（内存 Map，按 userId 限频，如 60s 内 ≤10 次；无 `@nestjs/throttler` 依赖）；双写 ① DB ② 落盘 `buildShareHtml(turns, { inlineMedia:'online', includeOg:true, og:{title, description, image} })` 到 `SHARE_DIR/<id>.html`；返回 `{ shareId, url: 'https://<域名>/share/<id>.html' }`
  - `GET /api/share/conversation/:id`：返回元数据（可选，需登录/限频）——**非公开访问主路径**
  - `SHARE_DIR = process.env.SHARE_DIR ?? '/app/share'`（目录须与 nginx 共享卷同一 path）
  - TTL 清理：`onModuleInit` 注册 `setInterval`（默认每 1h），扫 `expiresAt < now()` → 删 DB 行 + `fs.promises.unlink(staticPath)`（**原子：二者都成功或都记录失败日志**）；`onModuleDestroy` 清 interval（用 `unref` 避免阻塞退出）

> `buildShareHtml` 来自 `@lnkpi/shared`，其 `og.image` 默认图：取 `process.env.SHARE_OG_IMAGE_URL ?? 'https://<域名>/share-og-default.png'`（文件由 Task 9 提供）。

- [ ] **Step 1: 写失败测试**（service 级，在 Node 环境直接 import `@lnkpi/shared/shareTemplate` 验证 DOM-free）：
  - `createShare` 返回 `url` 含 `/share/`；DB 多一行；`SHARE_DIR/<id>.html` 文件存在且含 `og:title`（验证 Node 端渲染 ⑥⑦⑨ 不报错）。
  - `cleanupExpired`：插一条 `expiresAt` 过去 → 调用后 DB 行消失 **且** 静态文件被 `unlink`。
  - `ShareRateLimitGuard`：同 userId 连续超阈请求被 429。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
  - `share-rate-limit.guard.ts`：`@Injectable()` 实现 `CanActivate`，构造内 `Map<userId, number[]>`（时间戳），`canActivate` 查 `ctx.switchToHttp().getRequest().user?.id`，窗口内超阈返回 `false`（配合 `HttpException(429)`）。
  - `share.service.ts`：`createShare(sessionId, turns)` → `id=cuid()` → `og={title:会话标题||首条文本前60字, description:首条文本摘要, image: env}` → `html=buildShareHtml(turns,{inlineMedia:'online',includeOg:true,og})` → `fs.writeFile(path.join(SHARE_DIR,id+'.html'), html)` → `prisma.conversation_shares.create({data:{id,sessionId,htmlSnapshot:html,staticPath,expiresAt:addDays(30)}})`；`cleanupExpired()`；`onModuleInit/onModuleDestroy` 管理 interval。
  - `share.controller.ts`：`@Post()` + `@UseGuards(AuthGuard, ShareRateLimitGuard)`；`@Get(':id')` 元数据。
  - `share.module.ts`：`@Module({ imports:[PrismaModule], controllers:[ShareController], providers:[ShareService, ShareRateLimitGuard] })`（**无需 `@nestjs/schedule`**）。
- [ ] **Step 4: 跑测试确认通过** + 注册 `ShareModule` 到 `app.module.ts`（`grep -n "PrismaModule\|WorksModule" apps/server/src/app.module.ts` 确认聚合方式）
- [ ] **Step 5: Commit** `feat(server): share 模块(双写DB+静态直出+内存限频+TTL清理,无schedule/throttler依赖)`

---

### Task 9: deploy — nginx 静态直出 `/share/` + OG 默认图

**Files:**
- Modify: `deploy/nginx.conf`（新增 `location /share/` + 共享卷挂载说明）
- Add: `deploy/static/share-og-default.png`（1200×630 默认 OG 卡；实现时用最小 PNG 生成，如 `printf` base64 或 ImageMagick；若环境无工具则引用项目已有公开 logo URL）
- Test/验收: 部署后 `curl -I https://<域名>/share/<id>.html` 返回 `200 text/html` 且响应头**不含 Nest 业务特征**

**Interfaces:**
- Consumes: server 落盘路径 `SHARE_DIR`（默认 `/app/share`，Task 8）；docker 共享卷（Nest 与 nginx 同 mount path `/app/share`）
- Produces: nginx 对 `/share/<id>.html` 直接 `try_files` 返回静态文件，`text/html`，`Cache-Control: public, max-age=86400`；`/share-og-default.png` 由 nginx 静态根提供；Nest 与 nginx 经共享卷见同一目录

- [ ] **Step 1: 读现有 `deploy/nginx.conf`** `grep -n "location \|root \|try_files\|server {" deploy/nginx.conf` 确认 server 块与 root 约定
- [ ] **Step 2: 追加 location（alias 直接指向 SHARE_DIR 同 path）**

```nginx
location /share/ {
    alias /app/share/;          # 与 server SHARE_DIR 同 mount path（共享卷）
    default_type text/html;
    add_header Cache-Control "public, max-age=86400";
    try_files $uri =404;
}
```

- [ ] **Step 3: 提供默认 OG 图** 在 `deploy/static/share-og-default.png` 放 1200×630 默认卡（实现时生成）；nginx 根或独立 `location = /share-og-default.png` 指向该文件
- [ ] **Step 4: 部署验证**（改动 deploy 走对应 workflow；CVM 直改则 `nginx -s reload`）：
  - `curl -sI https://<域名>/share/<id>.html` 断言 `HTTP/2 200`、`content-type: text/html`、`cache-control` 存在
  - 断言响应头**无** `x-powered-by: NestJS`（或未走 Nest 业务路由特征）
- [ ] **Step 5: 前端 `toQr`/`toWeChat`/`copyLink` 联调** 真机点「复制链接」拿到的 `https://<域名>/share/<id>.html` 在微信/浏览器可打开（在线模式外链图片可见）
- [ ] **Step 6: Commit** `feat(deploy): nginx 静态直出 /share/ (绕过 Nest, Cache-Control) + 默认 OG 图`

---

## Author Self-Review

1. **Spec coverage**：§1 目标(图标重绘/分享/多选)→Task 2/3/4；§2 In(操作栏+分享按钮/移动面板/自包含模板/五模式/双写+托管页/双入口)→Task 1/3/4/8/5/6 全覆盖；§4 判据(图标/模板/clipboard/二维码/微信/多选/XSS)→Task 2/1/3 落实；§5.1 静态化→Task 8/9；§5.2 渲染规则(折叠/Mermaid/媒体/HTML产物)→**Task 1 以 `ShareTurnPart` 结构化模型全覆盖 ⑥⑦⑨ + 视频**，DOM-free 设计保证 server 端可渲染（spec §8 ①–⑨ 全部有单测）；§7/§9 文件清单→Task 1-9 对应（共享模板归 `@lnkpi/shared`）；§11 风险→Review Focus(1/2/3/4/5/6) 覆盖 XSS/降级/绕过/清理/Node 渲染。无遗漏任务。
2. **Placeholder scan**：无 TBD/TODO；每 step 含代码块或具体 grep/命令。Task 5/6 的 store 字段用"实施时 grep 确认"明确指引（非留白）；html 产物 `get_node` 异步补全已给出接口与降级路径。
3. **Type consistency**：`ShareTurn`/`ShareTurnPart`/`ShareHtmlOptions` 在 Task 1（shared）定义，Task 3/4/5/6 均从 `@lnkpi/shared/shareTemplate` 引用同一类型；`useShareActions` 方法签名含 `sessionId` 参数（修正旧 plan 遗漏）；server `POST` body 字段与 shared 类型对齐；`buildShareHtml` **唯一实现于 shared**，server import 之（消除旧 plan "抽或复制"的歧义）。
4. **Review Focus**：6 条均钉入对应 Task 测试（Task 1③ / Task 3 copyLink / Task 3 openOffline / Task 9 curl / Task 8 cleanupExpired / Task 1⑥⑦⑨+Task 8 Node 渲染）。非空，已逐条落实。
5. **依赖现实修正（关键）**：旧 plan 引用 `ScheduleModule`/`ThrottlerGuard`——经查 `@nestjs/schedule` 与 `@nestjs/throttler` **均未安装**，已改为 `setInterval`（TTL 清理）+ 自研 `ShareRateLimitGuard`（内存限频），**不引入新依赖**，意图（限频防滥用 / 定期清理）完整保留。
6. **路径/资源收敛**：旧 plan nginx `alias /var/www/share/` 与 server `/app/share/` 不一致——统一为 `SHARE_DIR`（默认 `/app/share`，env 可覆盖），docker 共享卷同 mount path；og:image 默认图由 Task 9 提供 `share-og-default.png`，server 端用 env `SHARE_OG_IMAGE_URL` 引用。
