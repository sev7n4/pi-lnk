# Composer 长文本粘贴 → 文本素材芯片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 composer 中超过阈值的纯文本粘贴自动成为一枚 T* 文本素材芯片（可引用/可移除/可 ⌘Z 还原），同时修掉抢走 composer 粘贴的全局 paste 缺陷，并让模型能取回芯片全文。

**Architecture:** 判定抽成纯函数 → `MentionInput` 只做「同步 policy + preventDefault + emit」的通用事件层 → `useAgentComposer`（既有 Composer & Attachments 收敛点）持有唯一副作用（构造 `SidebarAttachment(text)`、可逆栈、toast）→ 既有 `attachments` 上行链路与 `read_document` 全文工具消费。粘贴来源不做溯源；画布全局 paste 通过共享 `isTypingTarget` 守卫放行可编辑目标。

**Tech Stack:** Vue 3 `<script setup>` / TypeScript、原生 `<textarea>`、Vitest + jsdom（web）、`node --import tsx --test`（pi-runtime）、zod schema（`@lnkpi/shared`）、ElMessage、gh api REST（推 PR）。

**Spec:** `docs/superpowers/specs/2026-11-15-composer-paste-text-chip-design.md`（计划与规格同行，执行者两份都读）。

## Global Constraints

- 取证/实施基线：`master` = `e3c7428148e85cf6f61640970cd2427e2429b6ad`。**主仓 `/Users/4seven/workspace/pi-lnk` 的 `apps/web` / `packages/agent` / `packages/shared` 是悬空软链且 git 工作树长期脏，禁止在主仓改代码**；实施在 master tarball 干净树 `/tmp/pilnk-master-tree` 上进行，下文所有路径均相对仓库根。
- 本机 git push 502 / SSH denied ⇒ **不执行 `git commit` / `git push`**；最终由 Task 6 用 `gh api` REST（blob → tree(`base_tree` 只传改动路径) → commit → ref → PR）构造单 commit。每个 Task 末尾改为「登记改动路径」。
- 干净树无 `node_modules`。本地跑测试可把真仓库已有 `node_modules` 软链进来（`/Users/4seven/workspace/pi-lnk/node_modules` 与 `services/pi-runtime/node_modules` 均为实体目录），但**绝不执行 `pnpm install`**（会写穿软链删真仓库依赖）；跑前把软链换成实体空目录的纪律见 `docs/agent/delivery.md`。CI 是类型与全量测试的权威。
- 测试命令：`vitest run --maxWorkers=1 --no-file-parallelism`（nvm node24，`PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"`）；pi-runtime 用 `node --import tsx --test`；`vue-tsc -b` 不加 `--noEmit`（composite TS6310）；本机 pnpm 须 `env -u NODE_OPTIONS`。
- `SIDEBAR_ATTACHMENT_MAX = 5`（`packages/shared/src/sidebarAttachments.ts:3`），不得改。
- 阈值 `PASTE_TEXT_CHIP_MIN_CHARS = 1000`，按 **Unicode 码点字符数**（`[...text].length`），**禁止按字节**；阈值是必要非充分条件。
- `TEXT_LABEL_MAX = 200`（`apps/server/src/agent/pi-runtime/sidebar-block.ts:31`）是 F6 已拍板裁决，**不改**。
- L6 提示词预算最紧组合实测 3197 / 3200，**余量 3 字符**（2026-11-15 `pnpm prompt:lint` 实测；`AGENTS.md` 的 3132/余 68 为历史值）⇒ **禁止改 `prompt-registry/**`（含 `prompt-registry.fallback.ts` 内嵌常量）**。
- `sourceKind` 复用 `'upload'`，**不新增枚举值、不改 `SidebarAttachmentSchema`、不改上行协议、不改 `apps/server`、不创建画布节点**。
- 不改 `buildSidebarBlock`，不调用 `addNode()` / `ingestMediaFile()` / `addFromFile()` / `mergeFocusNodeRef()`；`selectedNodeIds` 与 `attachments` 继续两个独立上行字段（M3 D-A）。
- 芯片 `text` 字段必须写入**完整原文**，禁止 `slice/truncate`；原文不得同时留在输入框。
- `tiering.ts` 的 `verify-tool-tiering` 会把 `new Set([...])` 区间内**注释里的带引号工具名**解析成集合成员 ⇒ 新写注释一律不带引号工具名。
- 变异自检判 RED 必须用完整 stdout 的 `AssertionError` / `failing tests` 标记（禁止 `| tail` 吃退出码）；先排除模块解析失败与「判据自匹配恒绿」。
- **CI 全绿后停在合并前等用户单独授权**（本刀触发发布：`apps/web` 走 `deploy.yml`，`services/pi-runtime` 需手工 dispatch `runtime-deploy.yml`）。不许自行合并/部署/宣告上线闭环。

## Review Focus

| # | 规格没写透但会咬人的输入/条件 | 应有行为 | 钉在哪个 Task 的测试 |
|---|---|---|---|
| 1 | 粘贴超阈值但 textarea **有选区**（用户在做「替换一段文字」） | 保持原生替换，不转芯片 | Task 2 `has-selection` + Task 3 组件用例 |
| 2 | 中文/emoji 长文本（400 汉字 ≈ 1200 字节） | 按码点判 `too-short`，不因字节误触发 | Task 2 计量单位变异自检 |
| 3 | 连续粘贴 6 次 / 芯片已满 5 枚 | 第 6 次降级为原生粘贴，原文在输入框可见，不静默丢 | Task 2 `capacity-full` + Task 4 宿主用例 |
| 4 | 粘贴后立刻 ⌘/Ctrl+Z（textarea 没插入过文本，原生 undo 无事可撤） | 芯片移除 + 原文插回输入框 | Task 3 `undo-paste` emit + Task 4 还原用例 |
| 5 | 画布空白处粘贴文本 / 剪贴板带图片 | 前者仍建画布 text 节点；后者不接管走原画布通路 | Task 1 双用例 + Task 2 `has-files` |
| 6 | 转芯片后 `attachments.text` 被偷偷截断成 200 字 | 必须全文，静态契约变异 RED | Task 4 `AgentSideRail.pasteTextChip.test.ts` 变异自检 |

## File Structure

| 文件 | 职责 |
|---|---|
| `apps/web/src/utils/isTypingTarget.ts`（新建） | 唯一的可编辑目标判定，键盘与全局 paste 共用 |
| `apps/web/src/composables/pasteTextChip.ts`（新建） | 阈值/闸门纯函数 + `PasteTextProbe` 读取 + 常量 |
| `apps/web/src/composables/useCanvasMedia.ts` | P0：`onPaste` 入口守卫 |
| `apps/web/src/composables/useCanvasKeyboard.ts` | 删本地重复判定，改 import |
| `apps/web/src/components/canvas/MentionInput.vue` | 通用事件层：可选 policy / canUndoPaste / 两个 emit |
| `apps/web/src/components/agent/useAgentComposer.ts` | 唯一副作用点：策略、构造芯片、可逆栈、toast |
| `apps/web/src/components/agent/AgentSideRail.vue` | 仅模板接线（4 个属性/事件） |
| `services/pi-runtime/src/tools/tiering.ts` | `read_document` 提回常驻 |
| `services/pi-runtime/src/tools/tiering.test.ts` | 解除「必须延迟」回归锁 + 新增常驻断言 |
| `docs/agent/tool-capability-catalog.md` | 归属与计数同步（33/21 → 34/20） |
| 6 个测试文件（见各 Task） | 纯函数、组件、守卫、宿主静态契约、工具归属 |

---

### Task 1: 共享 isTypingTarget 与 P0 paste 守卫

**Files:**
- Create: `apps/web/src/utils/isTypingTarget.ts`
- Create: `apps/web/src/composables/useCanvasMedia.paste.test.ts`
- Modify: `apps/web/src/composables/useCanvasKeyboard.ts:17-22`
- Modify: `apps/web/src/composables/useCanvasMedia.ts:1-3, 227-229`

**Interfaces:**
- Consumes: 无。
- Produces: `isTypingTarget(target: EventTarget | null): boolean`；`setupCanvasMediaHandlers().onPaste` 行为变更为「可编辑目标直接 return」。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/composables/useCanvasMedia.paste.test.ts
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { setupCanvasMediaHandlers } from './useCanvasMedia'

function pasteEvent(target: EventTarget, types: string[] = ['text/plain']) {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'target', { value: target, configurable: true })
  Object.defineProperty(ev, 'clipboardData', {
    configurable: true,
    value: {
      items: types.map((type) => ({
        type,
        kind: 'string',
        getAsFile: () => new File(['hello'], 'clip.txt', { type }),
      })),
      files: [],
    },
  })
  return ev as unknown as ClipboardEvent
}

describe('setupCanvasMediaHandlers.onPaste（P0 守卫）', () => {
  it('textarea 目标：不 preventDefault、不建节点（composer 粘贴保持原生）', async () => {
    const onMedia = vi.fn()
    const { onPaste } = setupCanvasMediaHandlers(ref<HTMLElement | null>(null), onMedia)
    const ev = pasteEvent(document.createElement('textarea'))
    await onPaste(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(onMedia).not.toHaveBeenCalled()
  })

  it('画布目标：仍按既有行为 ingest 文本并建节点', async () => {
    const onMedia = vi.fn()
    const { onPaste } = setupCanvasMediaHandlers(ref<HTMLElement | null>(null), onMedia)
    const ev = pasteEvent(document.createElement('div'))
    await onPaste(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(onMedia).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `cd /tmp/pilnk-master-tree/apps/web && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" npx vitest run src/composables/useCanvasMedia.paste.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: 第 1 个用例 FAIL（`defaultPrevented` 为 true / `onMedia` 被调用 1 次）。

- [ ] **Step 3: 写最小实现**

```ts
// apps/web/src/utils/isTypingTarget.ts（新建）
/** 可编辑目标判定：键盘快捷键与 window 级 paste 处理器共用，避免两份实现漂移。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}
```

`useCanvasKeyboard.ts` 删除 17-22 行的本地 `function isTypingTarget(...)`，在 import 区加：

```ts
import { isTypingTarget } from '@/utils/isTypingTarget'
```

`useCanvasMedia.ts` 在 import 区加同一行 import，并把 `onPaste` 开头改为：

```ts
  async function onPaste(event: ClipboardEvent) {
    if (isTypingTarget(event.target)) return
    const items = event.clipboardData?.items
    if (!items?.length) return
    // 以下逐字保持原样
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: 同 Step 2。Expected: 2 passed。

- [ ] **Step 5: 变异自检**

把 `if (isTypingTarget(event.target)) return` 临时改成 `if (false) return`，重跑 Step 2 命令，完整 stdout 必须出现 `AssertionError` / `failing tests`（第 1 用例 RED）；恢复原样后重跑 PASS。

- [ ] **Step 6: 登记改动路径**

```bash
printf '%s\n' apps/web/src/utils/isTypingTarget.ts apps/web/src/composables/useCanvasKeyboard.ts apps/web/src/composables/useCanvasMedia.ts apps/web/src/composables/useCanvasMedia.paste.test.ts >> /tmp/paste-chip-changes.txt
```

---

### Task 2: 阈值/闸门纯函数

**Files:**
- Create: `apps/web/src/composables/pasteTextChip.ts`
- Create: `apps/web/src/composables/pasteTextChip.test.ts`

**Interfaces:**
- Consumes: 无（纯函数不依赖共享包；`maxCount` 由宿主 `useAgentComposer` 传入）。
- Produces: `PASTE_TEXT_CHIP_MIN_CHARS`、`PasteTextProbe`、`PasteTextContext`、`PasteDecision`、`readPasteTextProbe(event, el): PasteTextProbe`、`shouldPromotePasteToTextChip(ctx, minChars?): PasteDecision`。Task 3/4 依赖这些名字。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/composables/pasteTextChip.test.ts
import { describe, expect, it } from 'vitest'
import { PASTE_TEXT_CHIP_MIN_CHARS, shouldPromotePasteToTextChip } from './pasteTextChip'

const base = (over: Partial<Parameters<typeof shouldPromotePasteToTextChip>[0]> = {}) => ({
  text: 'x'.repeat(PASTE_TEXT_CHIP_MIN_CHARS),
  itemTypes: ['text/plain'],
  hasFiles: false,
  selectionStart: 5,
  selectionEnd: 5,
  isComposing: false,
  pendingCount: 0,
  maxCount: 5,
  ...over,
})

describe('shouldPromotePasteToTextChip', () => {
  it('阈值边界 999 / 1000 / 1001', () => {
    expect(shouldPromotePasteToTextChip(base({ text: 'x'.repeat(999) })).reason).toBe('too-short')
    expect(shouldPromotePasteToTextChip(base()).promote).toBe(true)
    expect(shouldPromotePasteToTextChip(base({ text: 'x'.repeat(1001) })).promote).toBe(true)
  })

  it('按码点不按字节：400 汉字（≈1200 字节）仍 too-short', () => {
    expect(shouldPromotePasteToTextChip(base({ text: '中'.repeat(400) })).reason).toBe('too-short')
  })

  it('emoji 按码点计数', () => {
    expect(shouldPromotePasteToTextChip(base({ text: '😀'.repeat(1000) })).promote).toBe(true)
  })

  it('空白 / 选区 / IME / 文件或媒体 / 容量满 全部拒绝且给出 reason', () => {
    expect(shouldPromotePasteToTextChip(base({ text: '  \n ' })).reason).toBe('empty')
    expect(shouldPromotePasteToTextChip(base({ selectionEnd: 8 })).reason).toBe('has-selection')
    expect(shouldPromotePasteToTextChip(base({ isComposing: true })).reason).toBe('composing')
    expect(shouldPromotePasteToTextChip(base({ hasFiles: true })).reason).toBe('has-files')
    expect(shouldPromotePasteToTextChip(base({ itemTypes: ['text/plain', 'image/png'] })).reason).toBe('has-files')
    expect(shouldPromotePasteToTextChip(base({ pendingCount: 5 })).reason).toBe('capacity-full')
  })

  it('text/html 富文本粘贴不因此被排除', () => {
    expect(shouldPromotePasteToTextChip(base({ itemTypes: ['text/plain', 'text/html'] })).promote).toBe(true)
  })

  it('阈值可覆盖', () => {
    expect(shouldPromotePasteToTextChip(base(), 2000).reason).toBe('too-short')
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `cd /tmp/pilnk-master-tree/apps/web && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" npx vitest run src/composables/pasteTextChip.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（模块 `./pasteTextChip` 不存在）。

- [ ] **Step 3: 写最小实现**

```ts
// apps/web/src/composables/pasteTextChip.ts
export const PASTE_TEXT_CHIP_MIN_CHARS = 1000

export type PasteSkipReason =
  | 'ok' | 'empty' | 'has-files' | 'has-selection'
  | 'composing' | 'too-short' | 'capacity-full'

export interface PasteTextProbe {
  text: string
  itemTypes: readonly string[]
  hasFiles: boolean
  selectionStart: number
  selectionEnd: number
  isComposing: boolean
}

export interface PasteTextContext extends PasteTextProbe {
  pendingCount: number
  maxCount: number
}

export interface PasteDecision {
  promote: boolean
  reason: PasteSkipReason
}

export function shouldPromotePasteToTextChip(
  ctx: PasteTextContext,
  minChars = PASTE_TEXT_CHIP_MIN_CHARS,
): PasteDecision {
  if (!ctx.text.trim()) return { promote: false, reason: 'empty' }
  if (ctx.hasFiles || ctx.itemTypes.some((t) => /^(image|video|audio)\//.test(t))) {
    return { promote: false, reason: 'has-files' }
  }
  if (ctx.selectionStart !== ctx.selectionEnd) return { promote: false, reason: 'has-selection' }
  if (ctx.isComposing) return { promote: false, reason: 'composing' }
  if ([...ctx.text].length < minChars) return { promote: false, reason: 'too-short' }
  if (ctx.pendingCount >= ctx.maxCount) return { promote: false, reason: 'capacity-full' }
  return { promote: true, reason: 'ok' }
}

/** 只读取剪贴板与选区；pendingCount/maxCount 由持有 sidebar 的宿主补齐。 */
export function readPasteTextProbe(event: ClipboardEvent, el: HTMLTextAreaElement): PasteTextProbe {
  const data = event.clipboardData
  const items = data ? Array.from(data.items) : []
  return {
    text: data?.getData('text/plain') ?? '',
    itemTypes: items.map((i) => i.type),
    hasFiles: (data?.files.length ?? 0) > 0 || items.some((i) => i.kind === 'file'),
    selectionStart: el.selectionStart ?? 0,
    selectionEnd: el.selectionEnd ?? 0,
    isComposing: (event as Event & { isComposing?: boolean }).isComposing ?? false,
  }
}
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: 同 Step 2。Expected: 6 passed（阈值边界 / 中文 / emoji / 拒绝项 / 富文本 / 阈值覆盖 共 6 个用例）。

- [ ] **Step 5: 计量单位变异自检（Review Focus #2）**

把 `[...ctx.text].length` 临时改成 `new TextEncoder().encode(ctx.text).length`，重跑完整 stdout 必须出现 `AssertionError`（「400 汉字」用例 RED）；恢复后 PASS。

- [ ] **Step 6: 登记改动路径**

```bash
printf '%s\n' apps/web/src/composables/pasteTextChip.ts apps/web/src/composables/pasteTextChip.test.ts >> /tmp/paste-chip-changes.txt
```

---

### Task 3: MentionInput 通用事件层

**Files:**
- Modify: `apps/web/src/components/canvas/MentionInput.vue:1-27, 184, 258-271`
- Test: `apps/web/src/components/canvas/MentionInput.test.ts`（增补）

**Interfaces:**
- Consumes: `readPasteTextProbe`, `PasteTextProbe`（Task 2）。
- Produces: props `pasteTextPolicy?: (probe: PasteTextProbe) => boolean`、`canUndoPaste?: boolean`；emits `paste-text-chip: [text: string]`、`undo-paste: []`。Task 4 接线用。

- [ ] **Step 1: 写失败测试（追加到 MentionInput.test.ts）**

```ts
import type { PasteTextProbe } from '@/composables/pasteTextChip'
import { shouldPromotePasteToTextChip } from '@/composables/pasteTextChip'

function pasteEvent(text: string, types: string[] = ['text/plain']) {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', {
    configurable: true,
    value: {
      getData: (t: string) => (t === 'text/plain' ? text : ''),
      items: types.map((type) => ({ type, kind: 'string', getAsFile: () => null })),
      files: [],
    },
  })
  return ev as unknown as ClipboardEvent
}

describe('MentionInput paste promotion', () => {
  it('未传 policy 时完全原生：不 preventDefault、不 emit', async () => {
    const w = mount(MentionInput, { props: { modelValue: '', mentions: [] } })
    const ta = w.get('textarea')
    const ev = pasteEvent('x'.repeat(1200))
    ta.element.dispatchEvent(ev)
    await w.vm.$nextTick()
    expect(ev.defaultPrevented).toBe(false)
    expect(w.emitted('paste-text-chip')).toBeUndefined()
  })

  it('policy 命中：preventDefault + emit 完整原文', async () => {
    const text = 'x'.repeat(1200)
    const policy = (probe: PasteTextProbe) => shouldPromotePasteToTextChip({
      ...probe, pendingCount: 0, maxCount: 5,
    }).promote
    const w = mount(MentionInput, { props: { modelValue: '', mentions: [], pasteTextPolicy: policy } })
    const ta = w.get('textarea')
    const ev = pasteEvent(text)
    ta.element.dispatchEvent(ev)
    await w.vm.$nextTick()
    expect(ev.defaultPrevented).toBe(true)
    expect(w.emitted('paste-text-chip')?.[0]).toEqual([text])
  })

  it('policy 拒绝短文本：不 preventDefault', async () => {
    const policy = (probe: PasteTextProbe) => shouldPromotePasteToTextChip({
      ...probe, pendingCount: 0, maxCount: 5,
    }).promote
    const w = mount(MentionInput, { props: { modelValue: '', mentions: [], pasteTextPolicy: policy } })
    const ev = pasteEvent('短句')
    w.get('textarea').element.dispatchEvent(ev)
    await w.vm.$nextTick()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('canUndoPaste 时 ⌘Z 交宿主还原，不吞其他按键', async () => {
    const w = mount(MentionInput, { props: { modelValue: 'a', mentions: [], canUndoPaste: true } })
    const ta = w.get('textarea')
    const undo = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
    ta.element.dispatchEvent(undo)
    await w.vm.$nextTick()
    expect(undo.defaultPrevented).toBe(true)
    expect(w.emitted('undo-paste')).toHaveLength(1)
    const plain = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    ta.element.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `cd /tmp/pilnk-master-tree/apps/web && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" npx vitest run src/components/canvas/MentionInput.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: 4 个新用例 FAIL（prop/emit 未定义）。

- [ ] **Step 3: 写最小实现**

`MentionInput.vue` script 区：

```ts
import { readPasteTextProbe, type PasteTextProbe } from '@/composables/pasteTextChip'
```

props 类型内追加两个可选字段：

```ts
  /** 长文本粘贴是否提升为素材芯片；不传 = 完全原生（另两个使用点零影响） */
  pasteTextPolicy?: (probe: PasteTextProbe) => boolean
  /** 存在可撤销的粘贴提升时，⌘/Ctrl+Z 交宿主还原 */
  canUndoPaste?: boolean
```

emits 改为：

```ts
const emit = defineEmits<{
  'update:modelValue': [v: string]
  submit: []
  'paste-text-chip': [text: string]
  'undo-paste': []
}>()
```

新增 `onPaste`（放在 `onInput` 之后）：

```ts
function onPaste(e: ClipboardEvent) {
  if (!props.pasteTextPolicy) return
  const el = textareaRef.value
  if (!el || !e.clipboardData) return
  const probe = readPasteTextProbe(e, el)
  if (!props.pasteTextPolicy(probe)) return
  e.preventDefault()
  emit('paste-text-chip', probe.text)
}
```

`onKeydown` 函数体最前面插入：

```ts
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && props.canUndoPaste) {
    e.preventDefault()
    e.stopPropagation()
    emit('undo-paste')
    return
  }
```

template 的 `<textarea>` 增加一行（放在 `@input` 之后）：

```vue
        @paste="onPaste"
```

- [ ] **Step 4: 跑测试确认 PASS + 既有回归**

Run: 同 Step 2。Expected: 全部 passed（含原 Escape / Enter / ghost 用例）。

- [ ] **Step 5: 登记改动路径**

```bash
printf '%s\n' apps/web/src/components/canvas/MentionInput.vue apps/web/src/components/canvas/MentionInput.test.ts >> /tmp/paste-chip-changes.txt
```

---

### Task 4: 宿主策略、可逆栈与模板接线

**Files:**
- Modify: `apps/web/src/components/agent/useAgentComposer.ts:1-15, 60, 182-196`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:4055-4071`
- Create: `apps/web/src/components/agent/AgentSideRail.pasteTextChip.test.ts`（静态源码契约）
- Test: `apps/web/src/components/agent/useAgentComposer.paste.test.ts`（新建）

**Interfaces:**
- Consumes: `shouldPromotePasteToTextChip`, `PasteTextProbe`（Task 2）；`MentionInput` 的两个 emit（Task 3）；`sidebar.addFromPayload / assignRefKeys / pendingAttachments`，新增 `sidebar.remove`。
- Produces: `composer.pasteTextPolicy(probe): boolean`、`composer.promotePasteToTextChip(text): void`、`composer.undoPromotedPaste(): void`、`composer.canUndoPaste: ComputedRef<boolean>`。

- [ ] **Step 1: 写失败测试**

```ts
// apps/web/src/components/agent/useAgentComposer.paste.test.ts
import { describe, expect, it, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { useAgentComposer } from './useAgentComposer'
import { useSidebarAttachments } from '@/composables/useSidebarAttachments'
import type MentionInput from '@/components/canvas/MentionInput.vue'

vi.mock('element-plus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('element-plus')>()),
  ElMessage: { success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

function makeComposer() {
  const sidebar = useSidebarAttachments()
  sidebar.clear()
  const input = ref('')
  const stub = { insertText: vi.fn(), focus: vi.fn(), showMenu: ref(false) }
  const composerRef = ref<InstanceType<typeof MentionInput> | null>(null)
  composerRef.value = stub as unknown as InstanceType<typeof MentionInput>
  const insertText = stub.insertText
  const c = useAgentComposer({
    input,
    sidebar,
    composerRef,
    fileInputRef: ref(null),
    cameraInputRef: ref(null),
    isUploading: ref(false),
    isDragOver: ref(false),
    assetPickerOpen: ref(false),
    attachMenuOpen: ref(false),
    readOnly: () => false,
    makeAttachmentItems: (a) => (a ?? []).map((attachment, i) => ({ attachment, refKey: `T${i + 1}` })),
  })
  return { c, sidebar, input, insertText }
}

const longText = '长'.repeat(1200)

describe('useAgentComposer paste promotion', () => {
  it('提升后芯片携带完整原文、T* key、可撤销', () => {
    const { c, sidebar } = makeComposer()
    c.promotePasteToTextChip(longText)
    const item = sidebar.pendingAttachments.value[0]
    expect(item.mediaType).toBe('text')
    expect(item.sourceKind).toBe('upload')
    expect(item.text).toBe(longText)
    expect(item.text?.length).toBe(1200)
    expect(c.canUndoPaste.value).toBe(true)
    expect(ElMessage.success).toHaveBeenCalled()
  })

  it('容量满时 policy 拒绝，原文不进芯片（不静默丢）', () => {
    const { c, sidebar } = makeComposer()
    for (let i = 0; i < 5; i++) {
      sidebar.addFromPayload({ id: `p${i}`, mediaType: 'image', sourceKind: 'upload', label: `a${i}`, url: `https://x/${i}.png` })
    }
    const probe = { text: longText, itemTypes: ['text/plain'], hasFiles: false, selectionStart: 0, selectionEnd: 0, isComposing: false }
    expect(c.pasteTextPolicy(probe)).toBe(false)
    expect(sidebar.pendingAttachments.value).toHaveLength(5)
  })

  it('⌘Z 还原：芯片移除 + 原文插回输入框', async () => {
    const { c, sidebar, insertText } = makeComposer()
    c.promotePasteToTextChip(longText)
    c.undoPromotedPaste()
    await nextTick()
    expect(sidebar.pendingAttachments.value).toHaveLength(0)
    expect(insertText).toHaveBeenCalledWith(longText)
    expect(c.canUndoPaste.value).toBe(false)
  })

  it('发送/清空草稿后撤销机会自动失效', () => {
    const { c, input } = makeComposer()
    c.promotePasteToTextChip(longText)
    input.value = ''
    expect(c.canUndoPaste.value).toBe(false)
  })
})
```

静态契约写**独立文件** `apps/web/src/components/agent/AgentSideRail.pasteTextChip.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const rail = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
const composer = readFileSync(join(here, 'useAgentComposer.ts'), 'utf8')
const promoteBody = composer.slice(
  composer.indexOf('function promotePasteToTextChip('),
  composer.indexOf('function undoPromotedPaste('),
)

describe('composer paste 接线静态契约', () => {
  it('肯定断言：模板四个接线齐备且构造 text 芯片', () => {
    expect(rail).toMatch(/:paste-text-policy="composer\.pasteTextPolicy"/)
    expect(rail).toMatch(/:can-undo-paste="composer\.canUndoPaste"/)
    expect(rail).toMatch(/@paste-text-chip="composer\.promotePasteToTextChip"/)
    expect(rail).toMatch(/@undo-paste="composer\.undoPromotedPaste"/)
    expect(promoteBody).toContain("mediaType: 'text'")
    expect(promoteBody).toContain('text,')
  })
  it('否定断言：提升函数不建节点 / 不上传 / 不改指代 / 不截断原文', () => {
    for (const bad of ['addNode(', 'ingestMediaFile(', 'addFromFile(', 'mergeFocusNodeRef(', 'selectionNodeIds']) {
      expect(promoteBody).not.toContain(bad)
    }
    expect(promoteBody).not.toMatch(/text:\s*text\.slice\(/)
    expect(promoteBody).not.toMatch(/text:\s*text\.substring\(/)
  })
})
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `cd /tmp/pilnk-master-tree/apps/web && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" npx vitest run src/components/agent/useAgentComposer.paste.test.ts src/components/agent/AgentSideRail.pasteTextChip.test.ts --maxWorkers=1 --no-file-parallelism`
Expected: FAIL（`pasteTextPolicy` 等未定义 / 接线缺失）。

- [ ] **Step 3: 写最小实现**

`useAgentComposer.ts` import 区：

```ts
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { SIDEBAR_ATTACHMENT_MAX } from '@lnkpi/shared'
import { shouldPromotePasteToTextChip, type PasteTextProbe } from '@/composables/pasteTextChip'
```

`ComposerSidebarApi` 接口追加：

```ts
  remove: (id: string) => void
```

在 `useAgentComposer` 函数体内（`return` 之前）加入：

```ts
  const PASTE_UNDO_WINDOW_MS = 6000
  const lastPromotion = ref<{ id: string; text: string } | null>(null)
  const canUndoPaste = computed(() => Boolean(lastPromotion.value))
  let pasteUndoTimer: ReturnType<typeof setTimeout> | null = null

  // 用户继续输入 / 发送清空草稿即失去撤销机会（textarea 原生 undo 不覆盖本次提升）
  watch(input, () => { lastPromotion.value = null })
  onUnmounted(() => {
    if (pasteUndoTimer) clearTimeout(pasteUndoTimer)
  })

  function pasteTextPolicy(probe: PasteTextProbe): boolean {
    return shouldPromotePasteToTextChip({
      ...probe,
      pendingCount: sidebar.pendingAttachments.value.length,
      maxCount: SIDEBAR_ATTACHMENT_MAX,
    }).promote
  }

  function promotePasteToTextChip(text: string) {
    const id = randomId()
    sidebar.addFromPayload({
      id,
      mediaType: 'text',
      sourceKind: 'upload',
      label: `粘贴文本 · ${[...text].length} 字`,
      text,
    })
    // addFromPayload 容量满时静默 return；policy 已保证有空位，此处再兜底
    const idx = sidebar.pendingAttachments.value.findIndex((a) => a.id === id)
    if (idx < 0) return
    lastPromotion.value = { id, text }
    if (pasteUndoTimer) clearTimeout(pasteUndoTimer)
    pasteUndoTimer = setTimeout(() => { lastPromotion.value = null }, PASTE_UNDO_WINDOW_MS)
    const keys = sidebar.assignRefKeys()
    ElMessage.success(`已作为 ${keys[idx] ?? 'T1'} 素材加入 · ⌘Z 还原为文本`)
  }

  function undoPromotedPaste() {
    const promotion = lastPromotion.value
    if (!promotion) return
    sidebar.remove(promotion.id)
    lastPromotion.value = null
    if (pasteUndoTimer) { clearTimeout(pasteUndoTimer); pasteUndoTimer = null }
    composerRef.value?.insertText(promotion.text)
    nextTick(() => composerRef.value?.focus())
  }
```

`return { ... }` 内追加四项：

```ts
    pasteTextPolicy,
    promotePasteToTextChip,
    undoPromotedPaste,
    canUndoPaste,
```

`AgentSideRail.vue` 的 `<MentionInput ... />`（约 4055-4071 行）在 `@submit` 前后追加四行：

```vue
                  :paste-text-policy="composer.pasteTextPolicy"
                  :can-undo-paste="composer.canUndoPaste"
                  @paste-text-chip="composer.promotePasteToTextChip"
                  @undo-paste="composer.undoPromotedPaste"
```

⚠️ 静态契约的否定断言必须只扫 Step 1 定义的 `promoteBody` 切片，**不得改成扫 `useAgentComposer.ts` 全文**：该文件既有的 `addFiles()` 合法调用 `sidebar.addFromFile(...)`，全文扫描会误伤既有代码并产出假绿/假红。

- [ ] **Step 4: 跑测试确认 PASS**

Run: 同 Step 2。Expected: 全部 passed。

- [ ] **Step 5: 静默截断变异自检（Review Focus #6）**

把 `text,` 临时改成 `text: text.slice(0, 200),`，重跑完整 stdout 必须出现 `AssertionError`（「完整原文」用例 RED，且静态契约 `text.slice(` 断言 RED）；恢复后 PASS。

- [ ] **Step 6: 登记改动路径**

```bash
printf '%s\n' apps/web/src/components/agent/useAgentComposer.ts apps/web/src/components/agent/AgentSideRail.vue apps/web/src/components/agent/useAgentComposer.paste.test.ts apps/web/src/components/agent/AgentSideRail.pasteTextChip.test.ts >> /tmp/paste-chip-changes.txt
```

---

### Task 5: read_document 提回常驻（保真前置）

**Files:**
- Modify: `services/pi-runtime/src/tools/tiering.ts:85`（`read_media` 之后）
- Modify: `services/pi-runtime/src/tools/tiering.test.ts:417-434`（解除回归锁）
- Modify: `docs/agent/tool-capability-catalog.md:165, 206, 232`（归属与计数）

**Interfaces:**
- Consumes: `ALWAYS_ON_TOOL_NAMES`（同文件已有 Set）。
- Produces: `read_document` ∈ `ALWAYS_ON_TOOL_NAMES`（模型初始即拿到 schema）。

- [ ] **Step 1: 写失败测试**

`tiering.test.ts` 在「减点名下沉」describe 之前新增：

```ts
describe("侧栏文本素材全文读取（2026-11-15 粘贴芯片保真前置）", () => {
	it("read_document 必须常驻：T* 芯片进 prompt 只有 200 字标签，全文恢复路径不得延迟", () => {
		assert.ok(ALWAYS_ON_TOOL_NAMES.has("read_document"));
	});
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `cd /tmp/pilnk-master-tree/services/pi-runtime && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" node --import tsx --test src/tools/tiering.test.ts`
Expected: 新用例 FAIL（当前 `read_document` 在延迟集）。

- [ ] **Step 3: 写最小实现**

`tiering.ts` 在 `"read_media",` 之后插入（注释内不带引号工具名）：

```ts
	// 侧栏文本素材全文读取（2026-11-15 粘贴芯片）：T* 芯片进 prompt 只有 200 字标签，
	// 全文只能靠本工具取回；延迟即不可达（搜索触发率实测 0，同恢复工具先例）。
	"read_document",
```

`tiering.test.ts` 的 `DEMOTED` 数组（现 8 项）移除 `"read_document",` 一行 → 7 项；describe 标题 `describe("减点名下沉：读类诊断 9 工具必须延迟（2026-10-06，已由分级下发实验支持）", () => {` 改为 `describe("减点名下沉：读类诊断 DEMOTED 清单必须延迟（2026-10-06 实验）", () => {`（去掉硬编码数字，避免后续再漂移）。⚠️ 该 describe 上方注释里的「已扩到本批全量 9 个」「hit = 6」是**历史事实记录**，逐字保留不改；只在 DEMOTED 上方补一行说明：

```ts
	// 2026-11-15：read_document 因侧栏文本芯片全文恢复路径提回常驻（见上方 describe），
	// 从本清单移出；其余仍为分级下发实验的下沉结果。
```

`docs/agent/tool-capability-catalog.md`：
- §4 标题 `## 4. 目录 — 常驻集（33）` → `（34）`，表内新增一行 `| 34 | \`read_document\` | 无（恢复路径常驻） | 侧栏 T* 文本素材要读全文——ref 精确匹配 T1/T2 |`；
- §5 标题 `## 5. 目录 — 延迟集（21）` → `（20）`，删除第 232 行 `| 18 | \`read_document\` | ... |`，后续序号按表内实际连续编号重排（18→18 之后依次减 1）；
- §6 复现命令里的 `TOOLS` 名单**不动**（它是全量工具名穷举，与归属无关）。

- [ ] **Step 4: 跑测试 + 门禁确认 PASS**

Run:
```
cd /tmp/pilnk-master-tree/services/pi-runtime && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" node --import tsx --test src/tools/tiering.test.ts
cd /tmp/pilnk-master-tree && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS npx tsx scripts/verify-tool-tiering.ts
```
Expected: tiering 用例全绿；`verify-tool-tiering` EXIT=0（A1 只查延迟集∩点名、A2 查常驻未注册；`read_document` 已注册且零点名，常驻是保守方向）。

- [ ] **Step 5: 变异自检**

把 `tiering.ts` 新加的 `"read_document",` 临时删除，重跑 Step 4 第一条，完整 stdout 必须出现 `AssertionError`（新用例 RED）；恢复后 PASS。

- [ ] **Step 6: 登记改动路径**

```bash
printf '%s\n' services/pi-runtime/src/tools/tiering.ts services/pi-runtime/src/tools/tiering.test.ts docs/agent/tool-capability-catalog.md >> /tmp/paste-chip-changes.txt
```

---

### Task 6: 全量验证、推 PR、CI 核验、停合并前

**Files:** 不新增产品代码；产出 PR 与取证记录。

**Interfaces:** Consumes `/tmp/paste-chip-changes.txt`（Task 1–5 登记的全部路径）。

- [ ] **Step 1: 全量测试与静态门禁**

```
cd /tmp/pilnk-master-tree/apps/web && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" npx vitest run --maxWorkers=1 --no-file-parallelism
cd /tmp/pilnk-master-tree/services/pi-runtime && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" node --import tsx --test "src/**/*.test.ts"
cd /tmp/pilnk-master-tree && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" env -u NODE_OPTIONS npx tsx scripts/prompt-lint.ts
cd /tmp/pilnk-master-tree && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" npx tsx scripts/verify-tool-tiering.ts
cd /tmp/pilnk-master-tree && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" npx tsx scripts/verify-claims.ts
cd /tmp/pilnk-master-tree/apps/web && PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH" npx vue-tsc -b
```
Expected: 全绿；`prompt-lint` 实测 L6 值与基线一致（本刀未改规则）。若本机依赖解析失败，记录为「本机未跑、以 CI 为准」，不得假报绿。

- [ ] **Step 2: 逐条复核变异自检**

对 Task 1/2/4/5 的变异各跑一次并保存完整 stdout 到 `/tmp/paste-chip-mutation-<n>.log`，逐份确认含 `AssertionError` 或 `failing tests`；全部恢复后再跑一次 Step 1 全量确认 PASS。

- [ ] **Step 3: 推前基准比对**

对 `/tmp/paste-chip-changes.txt` 的每个路径，用 `gh api repos/sev7n4/pi-lnk/contents/<path>?ref=master` 取裸 blob sha，与**改动前** master tarball 原版文件逐路径比对（只比未改动的路径必须完全一致；改动路径记录旧 sha 供 compare 用）。禁止用改动后的本地文件当基准。

- [ ] **Step 4: REST 推单 commit + 开 PR**

按 `docs/agent/delivery.md`：blob → tree（`base_tree` = master sha，只传改动路径）→ commit（parent = master sha）→ `PATCH /git/refs/heads/<branch>` → `POST /pulls`。PR 正文必须**回读长度**（`@文件路径` 会静默丢内容），写明 spec / plan / 测试结果 / 变异自检 / 部署提示（`services/pi-runtime` 需手工 dispatch `runtime-deploy.yml`）。PR 创建偶发 502 ⇒ 只重试 `POST /pulls`，勿重推文件。

- [ ] **Step 5: 推后核验**

`gh api repos/sev7n4/pi-lnk/compare/master...<branch>` 断言 `DELTA` 恰为登记路径、`PARALLEL_KEPT`（master 并行前移的路径全保留）、parent = 推前 master sha。若 master 期间前移：目标路径 blob 与新 master 全等才可换 parent；否则基于新 master 重建单 commit。

- [ ] **Step 6: 等 CI 三个 check 全绿并停下**

`Build monorepo` / `Verify spec figures` / `Build API Docker image` 全绿后，**停在合并前**，把 PR 号、CI 结论、compare 结论、本地测试与变异结果汇总给用户，请求单独授权「合并 + 部署（含 runtime-deploy dispatch）+ 生产取证 + 复测」。不自行合并、不宣告上线闭环。

- [ ] **Step 7: 规格状态回填（只追加）**

在 `docs/superpowers/specs/2026-11-15-composer-paste-text-chip-design.md` 状态行追加「实施中：plan=…、PR=…、CI=…」，不改已批准的裁决正文。

---

### Task 7: 授权后上线、生产取证与保真复测（GATED — 本轮不执行）

**Files:** 不改产品代码；产出取证记录与规格状态回填。
**前置：** Task 6 Step 6 用户明确授权「合并 + 部署 + 生产取证 + 复测」。未授权则整个 Task 跳过，且不得宣告特性闭环。

**Interfaces:** Consumes PR 号、CI 已验证的 head 树、合并后 master sha。

- [ ] **Step 1: squash 合并并核验合并树**

用 `gh api -X PUT repos/sev7n4/pi-lnk/pulls/<PR>/merge`  squash 合并；取合并后 master sha，逐路径比对「合并树 == CI 已验证的 PR head 树」。⚠️ 若合并时 master 并行前移：**零交集前移时该等式必然不成立**，改判 `TARGET_KEPT`（本刀全部改动路径 blob 与 PR head 一致）+ `PARALLEL_KEPT`（前移路径全保留）+ parent = 新 master；`MERGEABLE` 不是合并后真树已验证的证据。

- [ ] **Step 2: 部署两个单元**

```
# apps/web 改动由 deploy.yml push.paths 自动触发
gh api repos/sev7n4/pi-lnk/actions/runs?per_page=5 --jq '.workflow_runs[] | [.name,.head_sha,.status,.conclusion] | @tsv'
# services/pi-runtime 不在 deploy.yml paths ⇒ 必须手工 dispatch
printf '{"ref":"master","inputs":{"tag":"<MERGE_SHA>"}}' | gh api -X POST repos/sev7n4/pi-lnk/actions/workflows/runtime-deploy.yml/dispatches --input -
```
环境审批走 `actions/runs/<run_id>/pending_deployments`（数字 env id `23398119885`，`state=approved`；给 `deployments/{id}/statuses` 传 `approved` 会 422）。runbook：`docs/ops/RUNBOOK-pi-runtime-deploy.md`。Nginx `:8888`→5100，健康 `/api/health`，502 窗约 30s。

- [ ] **Step 3: 生产取证（覆盖全部部署单元）**

```
kubectl -n pi-lnk-runtime get pods -o wide
kubectl -n pi-lnk-runtime get deployment pi-lnk-runtime -o jsonpath='{.spec.template.spec.containers[0].image}'
curl -sS --noproxy '*' https://<host>/api/health
```
必须同时核 web bundle 含新代码、`lnkpi-api` 容器、pi-runtime pod 镜像 tag = 合并 sha；**单单元「0 命中」不得下「未部署」结论**。web 静态取证用 `--headless=new --no-sandbox --no-proxy-server` 的 Chrome 或 bundle 字符串检索。

- [ ] **Step 4: 手工走查（spec §7.2 七项）**

300 字短文本原样进输入框且光标/选区/⌘Z 正常；3000 字 → 输入框不出现原文、T1 芯片出现；点芯片插 `@T1`；⌘Z 还原；✕ 移除；带图粘贴走原画布通路；画布空白粘贴长文本仍建 text 节点；连续粘贴 6 次第 6 次降级且原文在输入框可见。逐项记录 PASS/FAIL，不代跑、不臆造结果。

- [ ] **Step 5: 保真 e2e 探针（spec §7.3，唯一闭环判据）**

在生产会话粘贴超过 1000 字的文本并发送「请复述 T1 的最后一段」；检查 transcript 中出现 `read_document(ref:"T1")` 且回答包含末段内容。探针姿位：SSE 订阅**先于** prompt、`/prompt` body 字段是 `text`、显式 `model:'platform::agnes-2.5-flash'`（不传 model 走免费额度长期 429）、429 判定须覆盖 `agent_end.data.status=="failed"`（只看 `type=="error"` 会漏）。**模型只读了 200 字标签、未调工具 ⇒ 判 FAIL，特性未闭环**，回到 D3 重新裁决，不得宣告上线完成。

- [ ] **Step 6: 只追加回填状态**

在 spec 状态行追加「已上线：<merge sha>、部署 run、探针结论」；在 `.workbuddy/memory/2026-11-15.md` 追加一条；不改已批准的裁决正文。

---

## 授权边界（执行者必读）

规格已由用户批准；spec §8 的四个决策点按推荐默认执行：**D1 = 方案 A（自动 + ⌘Z 可逆 + toast）**、**D2 = 1000 码点**、**D3 = `read_document` 提回常驻**、D4 见下。本计划由用户「继续推进计划和实施上线落地」授权连续执行，采用 **native** 执行方式（任务间接口耦合紧、共享同一份 `PasteTextProbe` 契约，且用户要求连续推进）。

D4 取舍：规格建议 P0 paste 守卫单独先上一刀；为减少一次 PR / 部署窗口，本计划把它与本特性合为**同一 PR**，但 Task 1 自带独立测试周期与变异自检，审阅若要求可无损拆成独立 PR，不影响 Task 2–5。

「上线落地」中的**合并与部署是触发发布的刀**，按仓库长期纪律仍须在 CI 全绿后单独向用户请求授权；**Task 6 Step 6 是硬停点**，Task 7 全程 GATED。

---

## 实施偏差回填（只追加，2026-11-15）

计划正文保留原始设计，以下为实施落地的细微差异，供复核：

1. 干净树依赖：`pnpm install --offline --frozen-lockfile --ignore-scripts` 一次成功（EXIT=0，917 包全复用，48.9s）。干净树原本**无任何** `node_modules`，故不存在软链写穿真仓库依赖的风险。
2. Task 1 测试的事件构造改用 `target.dispatchEvent(ev)` 让 jsdom 正确赋值 `Event.target`，而非 `Object.defineProperty(ev, 'target', ...)`，语义等价。
3. Task 3 测试落地为**新建** `apps/web/src/components/canvas/MentionInput.paste.test.ts`（6 个用例，含「有选区」「未开启 canUndoPaste 时 ⌘Z 走原生」两项额外回归），未改动既有 `MentionInput.test.ts`；Step 2/4 的 vitest 命令相应改为跑新文件 + 既有文件回归。
4. `useAgentComposer.ts` 的 `watch(input, ...)` 采用 `{ flush: 'sync' }`（用户一输入即失效，不依赖微任务）；`onUnmounted` 用 `getCurrentInstance()` 守卫，避免无组件实例时的 Vue warn。
5. Task 4 测试用 element-plus **partial mock**（`importOriginal` 展开 + 覆写 `ElMessage`），`composerRef` 用 `as unknown as InstanceType<...>` 替身；全计划无 `as never`。
6. catalog 同步口径：`verify-tool-tiering` 报「注册 57 / 常驻 39 / 延迟 18」，而 catalog §4/§5 是人工清单（33/21，本就落后）；本刀只做相对该文档自身口径的 34/20 与行迁移，未重写全表。
7. `prompt-lint` 实测 L6 最紧组合 3197/3200（余 3 字符），已把 spec 与 plan 里的历史值「余 68」校正。
8. `AgentSideRail.vue` 的四行接线放在 `@submit` 之前；静态契约正则只匹配属性串，位置无关。

---

## ⚠️ 执行受阻状态（2026-11-15，只追加）

**代码与逐刀测试已完成，但命令通道在「全量验证」阶段整体失效，本轮未推 PR、未合并、未部署。**

### 已完成（实证）

| 项 | 结果 |
|---|---|
| 干净树依赖 | `pnpm install --offline --frozen-lockfile --ignore-scripts` EXIT=0（917 包全复用，48.9s） |
| TDD RED | P0 守卫 1 fail（**运行时实证**：textarea 粘贴被 `preventDefault` 抢走）、组件 2 fail、宿主 6 fail、tiering 1 fail |
| Task 1 守卫 + 纯函数 | `8/8 PASS` |
| Task 3 组件 + 既有回归 | `19/19 PASS`（6 新 + 13 既有 `MentionInput.test.ts`） |
| Task 4 宿主 + 静态契约 | `7/7 PASS` |
| Task 5 tiering | `33/33 PASS`，且 `verify-tool-tiering` EXIT=0（注册 57 / 常驻 39 / 延迟 18，延迟集零点名） |
| 静态门禁 | `prompt-lint` / `verify-claims`(7/7) / `verify-tool-tiering` / `verify-spec-figures`(0 错误，2 条历史告警) / `verify-links` **全部 EXIT=0** |

### 未完成（不得假报绿）

- web 全量 `vitest run`、pi-runtime 全量 `npm test`、`vue-tsc -b` **均被环境杀死**，不是代码失败。
- 四条变异自检尚未执行。
- 推 PR / CI 核验 / 合并 / 部署 / 生产取证 / 保真 e2e 探针全部未做。

### 根因（可复现证据）

三个后台任务同一根因，日志分别在 `/tmp/pilnk-web-full.log:382`、`/tmp/pilnk-rt-full.log:1279`、`/tmp/pilnk-vuetsc.log:1`：

```
Error: Broker record capacity exhausted for session 1921d664-c8a4-4c78-84cd-f560fd992e90 (8192/8192); request was not dispatched
    at wrappedReadFileSync (.../node-brokered-fs-shim.cjs:684:5) at getSourceSync (node:internal/modules/esm/load:37:14)
vue-tsc: error TS5033: Could not write file 'apps/web/tsconfig.tsbuildinfo': Broker record capacity exhausted ...
```

WorkBuddy 沙箱 broker 的每会话 IPC 记录上限被大量模块读取打满 ⇒ Node 崩溃、随后所有 Bash 调用的 `brokered-sandbox-bash-env.sh` 初始化都报 `operation not permitted: /dev/null`（exit 127）。**主会话与子代理共用同一失效通道，`dangerouslyDisableSandbox` 亦未恢复**。判据与处置见 `workbuddy-sandbox-tool-failure-triage`。

### 恢复后按序执行清单

改动全部在 `/tmp/pilnk-master-tree`（master `e3c74281` 的 tarball 干净树），**不在主仓工作区**（主仓 `apps/web` 等仍是悬空软链）。改动路径 15 个：

```
新建 apps/web/src/utils/isTypingTarget.ts
新建 apps/web/src/composables/useCanvasMedia.paste.test.ts
新建 apps/web/src/composables/pasteTextChip.ts
新建 apps/web/src/composables/pasteTextChip.test.ts
新建 apps/web/src/components/canvas/MentionInput.paste.test.ts
新建 apps/web/src/components/agent/useAgentComposer.paste.test.ts
新建 apps/web/src/components/agent/AgentSideRail.pasteTextChip.test.ts
修改 apps/web/src/composables/useCanvasMedia.ts
修改 apps/web/src/composables/useCanvasKeyboard.ts
修改 apps/web/src/components/canvas/MentionInput.vue
修改 apps/web/src/components/agent/useAgentComposer.ts
修改 apps/web/src/components/agent/AgentSideRail.vue
修改 services/pi-runtime/src/tools/tiering.ts
修改 services/pi-runtime/src/tools/tiering.test.ts
修改 docs/agent/tool-capability-catalog.md
```

1. **换新会话恢复命令通道**后，先跑 `echo OK` 与 `gh api repos/sev7n4/pi-lnk/commits/master --jq '.sha'` 确认。
2. 全量测试**分批跑**（单批避免打满 8192 broker 记录），或直接在 CI 上跑（CI 是类型与全量测试的权威，本仓长期如此）：
   ```
   cd /tmp/pilnk-master-tree/apps/web && npx vitest run --maxWorkers=1 --no-file-parallelism
   cd /tmp/pilnk-master-tree/services/pi-runtime && npm test
   cd /tmp/pilnk-master-tree/apps/web && npx vue-tsc -b
   ```
3. 补跑四条变异自检（Task 1 守卫 / Task 2 码点 / Task 4 静默截断 / Task 5 常驻声明），判 RED 以完整 stdout 的 `AssertionError` 为准，恢复后重跑 PASS。
4. 把工作区的 `docs/superpowers/specs/2026-11-15-composer-paste-text-chip-design.md` 与 `docs/superpowers/plans/2026-11-15-composer-paste-text-chip.md` 复制进干净树（或按本仓惯例另发 docs-only PR）。
5. 按 `docs/agent/delivery.md` 用 `gh api` REST 推单 commit（blob → tree，`base_tree` 只传改动路径 → commit(parent=master sha) → ref → PR）；推前逐路径裸 blob sha 与**改动前 master 基准**比对，推后 `compare` 核验 `DELTA` 恰为改动路径 + `PARALLEL_KEPT`；PR 正文回读长度。PR 创建 502 只重试 `POST /pulls`。
6. 三个 check 全绿后**停在合并前**，向用户请求「合并 + 部署（`apps/web` 走 `deploy.yml`，`services/pi-runtime` 需手工 dispatch `runtime-deploy.yml`）+ 生产取证 + 复测」的单独授权；授权后执行 Task 7，保真探针未通过不得宣告闭环。
