# VISP Phase 1a — `read_media` 恢复路径 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 VISP 规格 S-7 + M-9：`read_media` 工具让 agent 在直注失败/事后回看时，经 Nest 唯一取图点拿回图片像素（image block 回传 tool result），并把「可用 read_media 恢复」提示接进识图兜底动态块。

**Architecture:** 三层：① `@lnkpi/shared` 新增纯函数 `resolveSidebarRef`/`imageSidebarRefKeys`（I{n} 标记 ↔ 附件 url，双端同源）；② Nest 新增无状态内部端点 `POST /agent/internal/read-media`（uploads 引用 → 本地盘直读 → mime 判定 → 超 2MB 缩图 → base64）；③ pi-runtime 新增常驻工具 `read_media`（ref/url → Nest 代理 → image block 回传），并在 `agent.service.ts` 直通失败时把恢复提示追加进识图兜底块。pod 对宿主 IP 不可达（hairpin，实测），故取图必须在 Nest 侧完成。

**Tech Stack:** NestJS（apps/server）、pi-runtime 工具框架（LnkpiTool/NestClient）、`@lnkpi/shared`、sharp（`downscaleImageBuffer`）、vitest。

**Spec:** `docs/superpowers/specs/2026-11-05-agent-canvas-visual-perception-design.md`（§2.1 S-7、§4.3 R-V9/R-V10、§6 M-9、§10 A-8/A-9、§11 pod 出口风险）

## Global Constraints

- 分支：`feat/visp-read-media`，**基于 `fix/direct-image-url`（PR #733，commit `7ea2f1b2`）叠加**——Task 5 与 #733 同改 `agent.service.ts` 相邻区域，叠加避免冲突；#733 合并后本分支 rebase 再合。
- 本机命令纪律：apps/server 用 nvm node24 + vitest `--maxWorkers=1 --no-file-parallelism`；**services/pi-runtime 用 node:test + `env -u NODE_OPTIONS ./node_modules/.bin/tsx --test <files>`（非 vitest）**；pnpm 必须 `env -u NODE_OPTIONS`；推前 `tsc --noEmit`（apps/server 与 services/pi-runtime 两包）。
- 测试断言禁 `as never`（CI 编译 `*.test.ts`）。
- L6 静态提示词**零改动**（R-V10：恢复提示走动态块；5 个 VISP 工具全 tier=present 不进延迟集）。
- git https 被代理挡死 → push 走 api.github.com REST Git Data API（blobs `-F content=@file` → tree → commit → refs；推后核对 blob sha == 本地 `git hash-object`）。
- 改动 `services/pi-runtime/**` ⇒ 合并后须手工 dispatch `runtime-deploy`（tag = master 短 SHA）。
- 工具描述文案风格对齐 `view_canvas_media`（中文 label + 英文 description，说明何时该用）。

## Review Focus

1. **超 2MB 大图**：期望缩图后成功返回（`downscaled:true`），而不是报错或静默超时 → Task 2 测试 2c 钉住。
2. **ref 脏输入**（`" i1 "` 小写带空格）：期望容忍解析为 `I1` → Task 1 测试 1b 钉住。
3. **ref 指向非图片素材**（`T1` 文本 / `V1` 视频）或越界 `I9`：期望返回 null 并由工具给出明确指引 → Task 1 测试 1c、Task 3 测试 3c 钉住。
4. **外部 URL / 画布节点 id 传入 Nest 端点**：期望拒绝且**绝不发起网络 fetch**（pod hairpin）→ Task 2 测试 2d 钉住（readBuffer spy 未被调用）。
5. **Nest 调用网络失败**：工具期望 `ok:false` 文本不抛错（直注失败时恢复路径不能再炸）→ Task 3 测试 3d 钉住。

---

### Task 1: shared 纯函数 `resolveSidebarRef` / `imageSidebarRefKeys`

**Files:**
- Modify: `packages/shared/src/sidebarAttachments.ts`（文件尾部追加两个导出）
- Test: `packages/shared/src/sidebarAttachments.test.ts`（已存在则追加 describe；不存在则新建）

**Interfaces:**
- Consumes: `SidebarAttachment`（同文件已有类型，字段 `url?/text?/mediaType?`）。
- Produces:
  - `resolveSidebarRef(attachments: Array<{url?;mediaType?}>, ref: string): string | null` —— `I{n}` → 对应图片附件 url；找不到/非图片/无 url → null。
  - `imageSidebarRefKeys(attachments: Array<{url?;mediaType?}>): string[]` —— 与侧栏块编号同源的图片 key 列表（`['I1','I2',…]`）。
  - Task 2/3/5 消费这两个函数。

- [ ] **Step 1: 写失败测试**

```ts
describe('resolveSidebarRef / imageSidebarRefKeys（VISP S-7，与侧栏块 I 编号同源）', () => {
  const atts = [
    { text: '产品文案', mediaType: 'text' },
    { url: 'http://h:8888/api/uploads/u1/a.png', mediaType: 'image' },
    { url: 'http://h:8888/api/uploads/u1/b.jpg', mediaType: 'image' },
    { url: 'http://h:8888/api/uploads/u1/c.mp4', mediaType: 'video' },
  ]

  it('1a: I1/I2 → 对应图片 url（跨 mediaType 计数正确）', () => {
    expect(resolveSidebarRef(atts, 'I1')).toBe('http://h:8888/api/uploads/u1/a.png')
    expect(resolveSidebarRef(atts, 'I2')).toBe('http://h:8888/api/uploads/u1/b.jpg')
  })

  it('1b: 脏输入容忍（小写/空白）', () => {
    expect(resolveSidebarRef(atts, ' i1 ')).toBe('http://h:8888/api/uploads/u1/a.png')
  })

  it('1c: 非图片 ref / 越界 / 非法形态 → null', () => {
    expect(resolveSidebarRef(atts, 'T1')).toBeNull()
    expect(resolveSidebarRef(atts, 'V1')).toBeNull()
    expect(resolveSidebarRef(atts, 'I9')).toBeNull()
    expect(resolveSidebarRef(atts, 'n_abc')).toBeNull()
    expect(resolveSidebarRef(atts, '')).toBeNull()
  })

  it('1d: 附件缺 url 或列表为空 → null / 空 keys', () => {
    expect(resolveSidebarRef([{ mediaType: 'image' }], 'I1')).toBeNull()
    expect(imageSidebarRefKeys(atts)).toEqual(['I1', 'I2'])
    expect(imageSidebarRefKeys([])).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/shared && env -u NODE_OPTIONS npx vitest run src/sidebarAttachments.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（`resolveSidebarRef is not exported`）

- [ ] **Step 3: 最小实现（追加到 `sidebarAttachments.ts` 尾部）**

```ts
const SIDEBAR_IMAGE_PREFIX = 'I'

/** VISP S-7：图片附件的侧栏 key 列表（与 sidebar-block 的 assignSidebarRefKeys 同源同序）。 */
export function imageSidebarRefKeys(attachments: Array<{ mediaType?: string }>): string[] {
  const keys: string[] = []
  let n = 0
  for (const item of attachments) {
    if ((item?.mediaType ?? '').trim().toLowerCase() !== 'image') continue
    n += 1
    keys.push(`${SIDEBAR_IMAGE_PREFIX}${n}`)
  }
  return keys
}

/**
 * VISP S-7：把侧栏图片标记（I1/I2…）解析回附件 url。
 * 仅图片可解析（恢复路径域）；找不到 / 非图片 / 缺 url → null。
 * 容忍小写与首尾空白（模型输出常带脏字符）。
 */
export function resolveSidebarRef(
  attachments: Array<{ url?: string; mediaType?: string }>,
  ref: string,
): string | null {
  const normalized = (ref ?? '').trim().toUpperCase()
  const keys = imageSidebarRefKeys(attachments)
  const idx = keys.indexOf(normalized)
  if (idx < 0) return null
  const images = attachments.filter((a) => (a?.mediaType ?? '').trim().toLowerCase() === 'image')
  const url = (images[idx]?.url ?? '').trim()
  return url || null
}
```

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令，Expected: PASS）

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/sidebarAttachments.ts packages/shared/src/sidebarAttachments.test.ts
git commit -m "feat(shared): resolveSidebarRef/imageSidebarRefKeys——侧栏图片标记与 url 双向同源（VISP S-7）"
```

---

### Task 2: Nest 纯加载器 `loadReadMediaImage`

**Files:**
- Create: `apps/server/src/agent/read-media.ts`
- Test: `apps/server/src/agent/read-media.test.ts`

**Interfaces:**
- Consumes: `parseUploadRefPath`（`@lnkpi/shared`，绝对/相对 `/api/uploads/` → `{userId, fileName}`，非 uploads → null）；`downscaleImageBuffer`（`../media/upstream-ref-downscale`，签名 `(input: Buffer, maxEdgePx?) => Promise<{buffer: Buffer; width; height; changed}>`，**缩放时输出转 jpeg**）。
- Produces: `loadReadMediaImage(input: {url?: string}, deps?) => Promise<ReadMediaResult>`（`deps.uploadsRoot` 可注入供测试）；Task 3 的 service 方法直接调用。
- **注意**：不用 `resolveUploadsFilePath`（其 `UPLOADS_ROOT` 是模块级常量不可注入）；本加载器自行 `join(deps.uploadsRoot ?? join(process.cwd(), 'uploads'), userId, fileName)`。

- [ ] **Step 1: 写失败测试（vitest，临时目录造真文件）**

```ts
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadReadMediaImage, READ_MEDIA_MAX_BYTES } from './read-media'

// 1×1 PNG（67 字节）
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

describe('loadReadMediaImage（VISP S-7 Nest 取图）', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'read-media-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const seed = async (rel: string, buf: Buffer) => {
    const p = join(dir, rel)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, buf)
  }
  const deps = (overrides: Partial<Parameters<typeof loadReadMediaImage>[1]> = {}) => ({
    uploadsRoot: dir,
    ...overrides,
  })

  it('2a: 相对 /api/uploads/ 引用 → 读盘成功返回 base64+mime', async () => {
    await seed('u1/a.png', PNG_1PX)
    const out = await loadReadMediaImage({ url: `/api/uploads/u1/a.png` }, deps())
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.mimeType).toBe('image/png')
      expect(out.fileName).toBe('a.png')
      expect(out.downscaled).toBe(false)
      expect(Buffer.from(out.base64, 'base64')).toEqual(PNG_1PX)
    }
  })

  it('2b: 绝对公网 URL（事故形态）→ 同样读盘成功', async () => {
    await seed('u1/b.jpg', PNG_1PX)
    const out = await loadReadMediaImage(
      { url: 'http://119.29.173.89:8888/api/uploads/u1/b.jpg' },
      deps(),
    )
    expect(out.ok).toBe(true)
  })

  it('2c: 超 2MB → 缩图后成功且 downscaled=true、mime 转 jpeg', async () => {
    await seed('u1/big.png', Buffer.alloc(READ_MEDIA_MAX_BYTES + 1, 1))
    const big = { buffer: Buffer.from('jpeg-bytes'), width: 1024, height: 768, changed: true }
    const out = await loadReadMediaImage(
      { url: '/api/uploads/u1/big.png' },
      deps({ downscale: async () => big }),
    )
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.downscaled).toBe(true)
      expect(out.mimeType).toBe('image/jpeg')
      expect(out.base64).toBe(big.buffer.toString('base64'))
    }
  })

  it('2d: 外部 URL（非 uploads 引用）→ 拒绝且绝不 fetch', async () => {
    let called = 0
    const out = await loadReadMediaImage(
      { url: 'https://cdn.example.com/img/a.png' },
      deps({ readBuffer: async () => { called += 1; return Buffer.alloc(0) } }),
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('uploads')
    expect(called).toBe(0)
  })

  it('2e: 文件不存在 / 扩展名不支持 → 明确错误', async () => {
    expect((await loadReadMediaImage({ url: '/api/uploads/u1/missing.png' }, deps())).ok).toBe(false)
    await seed('u1/x.tiff', Buffer.alloc(4))
    const out = await loadReadMediaImage({ url: '/api/uploads/u1/x.tiff' }, deps())
    expect(out.ok).toBe(false)
  })
})
```

（import 需补 `mkdir` 与 `dirname`：`import { mkdir, mkdtemp, writeFile, rm } from 'fs/promises'`、`import { dirname, join } from 'path'`。）

- [ ] **Step 2: 跑测试确认失败**（`cd apps/server && env -u NODE_OPTIONS npx vitest run src/agent/read-media.test.ts --maxWorkers=1 --no-file-parallelism`，Expected: FAIL 模块不存在）

- [ ] **Step 3: 实现 `read-media.ts`**

```ts
/**
 * read_media 的 Nest 侧取图（VISP S-7）：uploads 引用 → 本地盘直读（唯一取图点）
 * → mime 判定 → 超 2MB 缩图 → base64。无状态：不接受 sessionId、不查库；
 * 只接受 uploads 引用（R-V9：画布节点走 view_canvas_media，外部 URL 拒绝——
 * pod 对宿主 IP hairpin 不可达，任何网络 fetch 都不做）。
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { parseUploadRefPath } from '@lnkpi/shared'
import { downscaleImageBuffer } from '../media/upstream-ref-downscale'

export const READ_MEDIA_MAX_BYTES = 2 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export interface ReadMediaDeps {
  uploadsRoot?: string
  readBuffer?: (path: string) => Promise<Buffer>
  downscale?: (buf: Buffer) => Promise<{ buffer: Buffer; changed: boolean }>
}

export type ReadMediaResult =
  | { ok: true; base64: string; mimeType: string; fileName: string; downscaled: boolean }
  | { ok: false; error: string }

function sniffMime(buf: Buffer): string {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  return 'image/jpeg'
}

export async function loadReadMediaImage(
  input: { url?: string },
  deps: ReadMediaDeps = {},
): Promise<ReadMediaResult> {
  const url = (input?.url ?? '').trim()
  if (!url) return { ok: false, error: '缺少 url（uploads 引用）' }

  // 与 direct-image-payload.resolveUploadsFilePath 同语义（绝对/相对 /api/uploads/，
  // 兜旧 /uploads/ 相对形态），但 uploadsRoot 可注入：
  const upload = parseUploadRefPath(url)
  let rel: { userId: string; fileName: string } | null = upload
  if (!rel) {
    const m = /^\/uploads\/([^/]+)\/([^/?#]+)/.exec(url)
    if (m) rel = { userId: m[1], fileName: m[2] }
  }
  if (!rel) {
    // R-V9 / Review Focus 2d：非 uploads 引用一律拒绝，绝不发起网络 fetch
    return { ok: false, error: `仅支持 uploads 引用（/api/uploads/…），收到: ${url.slice(0, 120)}` }
  }

  const fileName = decodeURIComponent(rel.fileName)
  const localPath = join(deps.uploadsRoot ?? join(process.cwd(), 'uploads'), rel.userId, rel.fileName)
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  const readBuffer = deps.readBuffer ?? (async (p: string) => readFile(p))
  const downscale =
    deps.downscale ?? (async (buf: Buffer) => {
      const r = await downscaleImageBuffer(buf)
      return { buffer: r.buffer, changed: r.changed }
    })

  let buf: Buffer
  try {
    buf = await readBuffer(localPath)
  } catch (err) {
    return { ok: false, error: `读取失败: ${err instanceof Error ? err.message : String(err)}` }
  }

  let mimeType = MIME_BY_EXT[ext] ?? sniffMime(buf)
  let downscaled = false
  if (buf.length > READ_MEDIA_MAX_BYTES) {
    try {
      const r = await downscale(buf)
      buf = r.buffer
      downscaled = true
      mimeType = 'image/jpeg' // downscaleImageBuffer 缩放时输出 mozjpeg
    } catch (err) {
      return { ok: false, error: `缩图失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  return { ok: true, base64: buf.toString('base64'), mimeType, fileName, downscaled }
}
```

- [ ] **Step 4: 跑测试确认通过**（同 Step 2，Expected: PASS 5 例）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent/read-media.ts apps/server/src/agent/read-media.test.ts
git commit -m "feat(agent): read-media Nest 取图加载器——uploads 唯一取图点 + 超 2MB 缩图（VISP S-7）"
```

---

### Task 3: Nest 内部端点 `POST /agent/internal/read-media`

**Files:**
- Modify: `apps/server/src/agent/agent-canvas-tools.controller.ts:1265`（`get-node` 之后插入）
- Modify: `apps/server/src/agent/agent-canvas-tools.service.ts`（`getNode`（:886）附近追加方法）
- Test: 复用 Task 2 纯函数测试（控制器是透传层，与 `get-node` 同款薄壳，不单测）

**Interfaces:**
- Consumes: Task 2 `loadReadMediaImage`。
- Produces: HTTP 契约 `POST /agent/internal/read-media`，body `{ url: string }`，响应 `{ code: 0, message: 'ok', data: ReadMediaResult }`（NestClient 解包 `data`）——Task 4 的工具消费。

- [ ] **Step 1: DTO + 控制器（镜像 `get-node` 的薄壳风格，DTO 声明风格对齐同文件 `SessionNodeDto`）**

```ts
// controller（get-node 之后插入；DTO 与同文件 SessionNodeDto（:164）同款 class-validator 风格）：
class ReadMediaDto {
  @IsString()
  url!: string
}

@Post('read-media')
async readMedia(@Body() dto: ReadMediaDto) {
  const data = await this.tools.readMedia(dto)
  return { code: 0, message: 'ok', data }
}
```

```ts
// service（getNode 附近追加）：
/** VISP S-7：read_media 取图（无状态：不查库，只读 uploads 本地盘）。 */
async readMedia(input: { url?: string }) {
  return loadReadMediaImage({ url: input?.url })
}
```

（`import { loadReadMediaImage } from './read-media'`；DTO 与 `@Post` 同文件已有 import（`IsString` 来自 class-validator，已在文件头）。）

- [ ] **Step 2: 编译验证**（`cd apps/server && env -u NODE_OPTIONS ./node_modules/.bin/tsc --noEmit -p tsconfig.json`，Expected: 无新增错误）

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/agent/agent-canvas-tools.controller.ts apps/server/src/agent/agent-canvas-tools.service.ts
git commit -m "feat(agent): POST /agent/internal/read-media 内部端点（VISP S-7，无状态透传取图加载器）"
```

---

### Task 4: pi-runtime 工具 `read_media` + 注册 + 分层

**Files:**
- Create: `services/pi-runtime/src/tools/read-media.ts`
- Modify: `services/pi-runtime/src/tools/registry.ts`（`buildViewCanvasMediaTools`（:120-123）之后追加 `buildReadMediaTools` 包装）
- Modify: `services/pi-runtime/src/tools/config.ts:3`（import 追加）+ `:87` 附近（工具数组 spread）
- Modify: `services/pi-runtime/src/tools/tiering.ts:80-82`（`view_canvas_media` 同款常驻列表）
- Test: `services/pi-runtime/src/tools/read-media.test.ts`、`services/pi-runtime/src/tools/tiering.test.ts`（追加归属声明）

**Interfaces:**
- Consumes: Task 3 HTTP 契约；`LnkpiToolContext.attachments`（当前轮附件，`tools/types.ts:71`）；`NestClient.post`（解包 `data`）；shared `resolveSidebarRef`（Task 1）。
- Produces: 工具 `read_media(ref?: string, url?: string)`，tier=`"read"`（常驻）。

- [ ] **Step 1: 写失败测试（pi-runtime 惯例 = node:test + assert/strict，镜像 view-canvas-media.test.ts；跑法 `./node_modules/.bin/tsx --test`，非 vitest）**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadMediaTools } from "./read-media.js";
import type { NestClient } from "./nest-client.js";
import type { LnkpiToolContext } from "./types.js";

const CTX: LnkpiToolContext = {
	sessionId: "s1",
	attachments: [{ url: "http://h:8888/api/uploads/u1/a.png", mediaType: "image" }],
};

function fakeClient(result?: unknown, fail = false) {
	let calls = 0;
	const client = {
		post: async (_path: string, _body: unknown) => {
			calls += 1;
			if (fail) throw new Error("connect ECONNREFUSED");
			return result;
		},
		get callCount() {
			return calls;
		},
	};
	return client as unknown as NestClient & { callCount: number };
}

test("3a: ref → 工具侧解析为 url → Nest 返回时回传 text+image", async () => {
	const [tool] = createReadMediaTools(
		fakeClient({ ok: true, base64: "AAAA", mimeType: "image/png", fileName: "a.png", downscaled: false }),
	);
	const res = await tool.execute("id", { ref: "I1" }, undefined, CTX);
	assert.ok(res.content.some((c: { type: string }) => c.type === "image"));
});

test("3b: 直接给 url 透传", async () => {
	const [tool] = createReadMediaTools(
		fakeClient({ ok: true, base64: "AAAA", mimeType: "image/jpeg", fileName: "b.jpg", downscaled: true }),
	);
	const res = await tool.execute("id", { url: "http://h:8888/api/uploads/u1/b.jpg" }, undefined, CTX);
	assert.ok(res.content.some((c: { type: string }) => c.type === "image"));
});

test("3c: ref 解析失败（非图片 T1/越界 I9）→ ok:false 明确指引，不调 Nest", async () => {
	const client = fakeClient({ ok: false, error: "x" });
	const [tool] = createReadMediaTools(client);
	const res = await tool.execute("id", { ref: "T1" }, undefined, CTX);
	const text = JSON.stringify(res.content);
	assert.match(text, /false/);
	assert.match(text, /view_canvas_media/);
	assert.equal((client as unknown as { callCount: number }).callCount, 0);
});

test("3d: Nest 网络失败 → ok:false 文本，不抛错", async () => {
	const [tool] = createReadMediaTools(fakeClient(undefined, true));
	const res = await tool.execute("id", { url: "http://h:8888/api/uploads/u1/a.png" }, undefined, CTX);
	assert.match(JSON.stringify(res.content), /false/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd services/pi-runtime && env -u NODE_OPTIONS ./node_modules/.bin/tsx --test src/tools/read-media.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `read-media.ts`（镜像 `view-canvas-media.ts` 结构）**

```ts
/**
 * read_media（VISP S-7 恢复路径，spec 2026-11-05-agent-canvas-visual-perception-design.md §2.1）：
 * 直注失败/事后回看时把用户附件像素以 image block 回流 tool result。
 * ref（侧栏 I{n} 标记）在工具侧用 tc.attachments 本地解析为 url；取图走 Nest
 * /agent/internal/read-media（唯一取图点，本地盘直读）——pod 对宿主 IP hairpin
 * 不可达，禁止在 pod 侧 fetch。分工（R-V9）：画布节点走 view_canvas_media。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";
import { resolveSidebarRef } from "@lnkpi/shared";

type ReadMediaResult =
  | { ok: true; base64: string; mimeType: string; fileName: string; downscaled: boolean }
  | { ok: false; error: string };

type ReadResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: undefined;
};

function readResult(payload: Record<string, unknown>): ReadResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: undefined };
}

export function createReadMediaTools(
  client: NestClient,
  deps: { fetchImpl?: typeof fetch } = {},
): LnkpiTool[] {
  void deps;
  return [
    {
      tier: "read" as const,
      name: "read_media",
      label: "读取参考原图",
      description:
        "Fetch the actual pixels of a user-uploaded attachment (sidebar reference) as an image. Use when a placeholder says the original image was not injected into context (recovery path), or when you need to re-examine an uploaded image. Params: ref (sidebar marker like I1, resolved from this turn's attachments) or url (direct /api/uploads/ url). For canvas nodes use view_canvas_media instead.",
      parameters: Type.Object({
        ref: Type.Optional(
          Type.String({
            description:
              "Sidebar image marker from 侧栏参考素材 block, e.g. I1. Resolved locally from this turn's attachments.",
          }),
        ),
        url: Type.Optional(
          Type.String({
            description: "Direct /api/uploads/… url (e.g. from the sidebar block's url= field).",
          }),
        ),
      }),
      execute: async (
        _id,
        p: { ref?: string; url?: string },
        _u,
        tc: LnkpiToolContext,
      ): Promise<ReadResult> => {
        const explicitUrl = (p?.url ?? "").trim();
        let url = explicitUrl;
        if (!url) {
          const ref = (p?.ref ?? "").trim();
          if (!ref) {
            return readResult({ ok: false, error: "缺少参数：ref（如 I1）或 url 二选一" });
          }
          url = resolveSidebarRef(tc?.attachments ?? [], ref) ?? "";
          if (!url) {
            return readResult({
              ok: false,
              error: `ref ${ref} 无法解析为本轮图片附件（仅图片标记可解析、需在侧栏素材列表中）。文本/视频素材不适用本工具；画布节点请用 view_canvas_media。`,
            });
          }
        }
        let data: ReadMediaResult;
        try {
          data = (await client.post("/agent/internal/read-media", { url })) as ReadMediaResult;
        } catch (err) {
          return readResult({
            ok: false,
            error: `取图服务不可达: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        if (!data?.ok) {
          return readResult({ ok: false, error: data?.error ?? "取图失败" });
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                fileName: data.fileName,
                mimeType: data.mimeType,
                downscaled: data.downscaled,
                note: "以下为原图像素（超 2MB 已自动缩图）",
              }),
            },
            { type: "image", data: data.base64, mimeType: data.mimeType },
          ],
          details: undefined,
        };
      },
    },
  ];
}
```

- [ ] **Step 4: 注册（registry.ts + config.ts）+ 分层（tiering.ts）**

```ts
// registry.ts（buildViewCanvasMediaTools 之后追加同款包装）：
/** VISP S-7 恢复路径（spec 2026-11-05-agent-canvas-visual-perception-design.md）：
 *  read_media（tier=read，直注失败/事后回看时经 Nest 唯一取图点回流像素）。 */
export function buildReadMediaTools(client: NestClient): LnkpiTool[] {
	return createReadMediaTools(client);
}

// config.ts:3 import 追加 buildReadMediaTools；:87 附近工具数组追加：
...buildReadMediaTools(client),

// tiering.ts：view_canvas_media（:82）同列表追加，注释风格对齐 :80 先例：
// read_media（VISP S-7）：恢复路径必须无门槛可达（直注失败时模型靠它自救），
// 不得进延迟集——tool_search 触发率实测为 0，延迟即不可达（R-V10）。
"read_media",
```

- [ ] **Step 5: tiering.test.ts 追加归属声明**（镜像 `view_canvas_media` 条目断言：`read_media` 在常驻集、不在延迟集）

- [ ] **Step 6: 跑测试确认全绿**

Run: `cd services/pi-runtime && env -u NODE_OPTIONS ./node_modules/.bin/tsx --test src/tools/read-media.test.ts src/tools/tiering.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add services/pi-runtime/src/tools/read-media.ts services/pi-runtime/src/tools/read-media.test.ts services/pi-runtime/src/tools/registry.ts services/pi-runtime/src/tools/config.ts services/pi-runtime/src/tools/tiering.ts services/pi-runtime/src/tools/tiering.test.ts
git commit -m "feat(pi-runtime): read_media 恢复工具——ref 本地解析 + Nest 代理取图，常驻集（VISP S-7/R-V10）"
```

---

### Task 5: 恢复提示接进识图兜底动态块（M-9 闭环）

**Files:**
- Modify: `apps/server/src/agent/pi-runtime/sidebar-block.ts`（追加 `buildImageRecoveryHint`）
- Modify: `apps/server/src/agent/agent.service.ts:2790` 附近（`visionBlock` 装配处，紧跟 PR #733 的 warn 块）
- Test: `apps/server/src/agent/pi-runtime/sidebar-block.test.ts`

**Interfaces:**
- Consumes: Task 1 `imageSidebarRefKeys`（shared）。
- Produces: `buildImageRecoveryHint(attachments) => string`；`agent.service.ts` 把它拼接在 `visionBlock` 之后。

- [ ] **Step 1: 写失败测试**

```ts
it('恢复提示：有图片附件 → 含 read_media 指引与 key；无图片 → 空串', () => {
  const atts = [
    { url: 'http://h:8888/api/uploads/u1/a.png', mediaType: 'image' },
    { text: '文案', mediaType: 'text' },
  ]
  const hint = buildImageRecoveryHint(atts)
  expect(hint).toContain('read_media')
  expect(hint).toContain('I1')
  expect(buildImageRecoveryHint([{ text: '文案', mediaType: 'text' }])).toBe('')
  expect(buildImageRecoveryHint(undefined)).toBe('')
})
```

- [ ] **Step 2: 跑测试确认失败**（`cd apps/server && env -u NODE_OPTIONS npx vitest run src/agent/pi-runtime/sidebar-block.test.ts --maxWorkers=1 --no-file-parallelism`，Expected: FAIL）

- [ ] **Step 3: 实现（sidebar-block.ts 追加；复用 shared `imageSidebarRefKeys`）**

```ts
import { imageSidebarRefKeys } from '@lnkpi/shared'

/**
 * VISP S-7/M-9：直注失败时的恢复提示（动态块，R-V10 不吃 L6 预算）。
 * 让模型知道恢复入口存在——事故实证：模型拿到 [I1=文件名] 却不知道有任何取图手段。
 */
export function buildImageRecoveryHint(attachments?: SidebarBlockInput[]): string {
  const keys = imageSidebarRefKeys(attachments ?? [])
  if (!keys.length) return ''
  return `\n【原图恢复】本轮图片未能以像素注入上下文。可调用 read_media(ref:"${keys[0]}") 查看原图（本轮图片标记：${keys.join(', ')}）。`
}
```

- [ ] **Step 4: 接线（agent.service.ts，紧跟 `:2790` 附近 visionBlock 装配）**

```ts
// 原（PR #733 后现状）：
const visionBlock = directImages
  ? ''
  : await this.buildSidebarVisionBlock({ ... })
// 改为：
const visionBase = directImages
  ? ''
  : await this.buildSidebarVisionBlock({
      sessionId,
      userId,
      userMessage,
      attachments: piContext?.attachments,
      model,
    })
// M-9：直注失败且有图片附件 → 动态块追加恢复提示（模型需要知道 read_media 存在）
const visionBlock = visionBase + buildImageRecoveryHint(directImages ? undefined : piContext?.attachments)
```

（`import { buildImageRecoveryHint } from './pi-runtime/sidebar-block'`——该文件已有同目录 import 先例。）

- [ ] **Step 5: 跑测试**

Run: `cd apps/server && env -u NODE_OPTIONS npx vitest run src/agent/pi-runtime/sidebar-block.test.ts src/agent/pi-runtime/pi-prompt-assembler.service.test.ts src/agent/agent.service.pi-runtime.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: PASS（assembler 的动态块断言为 `includes` 前缀式，追加提示行不破坏既有断言；若有硬断言失败，按「新提示行属预期增量」修订该断言并注明 VISP M-9）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent/pi-runtime/sidebar-block.ts apps/server/src/agent/pi-runtime/sidebar-block.test.ts apps/server/src/agent/agent.service.ts
git commit -m "feat(agent): 直注失败时动态块追加 read_media 恢复提示（VISP M-9 闭环）"
```

---

### Task 6: 全量验证 + 推送 + PR

- [ ] **Step 1: 两包类型检查**

```bash
cd apps/server && env -u NODE_OPTIONS ./node_modules/.bin/prisma generate && env -u NODE_OPTIONS ./node_modules/.bin/tsc --noEmit -p tsconfig.json
cd ../services/pi-runtime && env -u NODE_OPTIONS ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```
Expected: 两包 0 错误

- [ ] **Step 2: 全量相关测试**

```bash
cd apps/server && env -u NODE_OPTIONS npx vitest run src/agent/direct-image-payload.test.ts src/agent/read-media.test.ts src/agent/pi-runtime/sidebar-block.test.ts src/agent/pi-runtime/pi-prompt-assembler.service.test.ts src/agent/agent.service.pi-runtime.test.ts --maxWorkers=1 --no-file-parallelism
cd ../services/pi-runtime && env -u NODE_OPTIONS ./node_modules/.bin/tsx --test src/tools/read-media.test.ts src/tools/tiering.test.ts
```
Expected: 全绿

- [ ] **Step 3: 提交规划文档本身**（`docs/superpowers/plans/2026-11-05-visp-phase1a-read-media.md` 与规格 R3 一并纳入首个 commit 或单独 docs commit）

- [ ] **Step 4: REST Git Data API 推送分支**（ Global Constraints 流程；blob sha 逐一核对；PR base=master，描述注明「Stacked on #733，先合 #733 后本 PR rebase」）

- [ ] **Step 5: 开 PR**，勾选验收锚点：A-8（本计划测试覆盖）/ A-9（提示闭环，部署后生产复测）
