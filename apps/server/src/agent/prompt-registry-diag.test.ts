import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { AgentController } from './agent.controller'
import type { PromptRegistrySnapshot } from './pi-runtime/prompt-registry.loader'

/**
 * W1b：提示词注册中心诊断端点。
 *
 * 端点免鉴权（与 capabilities/list / runtime-health 同级），所以它的**安全边界就是响应字段本身**：
 * 只出构建元信息（version/hash/entries/degraded），绝不出提示词正文。因此本测试文件把
 * 「响应字段白名单」锁死——将来谁往里加 body，这里会红。
 */

const SNAP_OK: PromptRegistrySnapshot = {
  registryVersion: '1.0.0',
  registryHash: 'fdf2c1fd5ccf',
  degraded: false,
  entries: [
    {
      id: 'identity.opening',
      version: '1.0.0',
      title: '身份与语气',
      order: 10,
      owner: 'agent-platform',
      updated: '2026-10-02',
      body: '你是 lnkpi 无限画布助手。用简洁中文回答。',
      contentHash: 'cda839c9ee9c',
    },
  ],
}

const SNAP_DEGRADED: PromptRegistrySnapshot = {
  registryVersion: '',
  registryHash: '',
  degraded: true,
  degradedReason: '/app/prompt-registry/rules 下没有任何 .md 规则文件',
  entries: [],
}

function makeController(): AgentController {
  return new AgentController(
    {} as never, // agentService：诊断端点不碰它
    {} as never, // sessionsService
    {} as never, // canvasTools
  )
}

/** 端点方法读的是模块级 loadRegistry，这里用 vi.mock 换掉 loader 的返回。 */
async function withSnapshot(snap: PromptRegistrySnapshot, fn: () => Promise<void>): Promise<void> {
  const loader = await import('./pi-runtime/prompt-registry.loader')
  const original = loader.loadRegistry
  Object.defineProperty(loader, 'loadRegistry', { value: () => snap, configurable: true })
  try {
    await fn()
  } finally {
    Object.defineProperty(loader, 'loadRegistry', { value: original, configurable: true })
  }
}

describe('GET /agent/prompt-registry（W1b 诊断端点）', () => {
  it('正常态：返回 version/hash/entryCount 与每条的 id/version/contentHash', async () => {
    await withSnapshot(SNAP_OK, async () => {
      const res = await makeController().promptRegistry()
      expect(res.code).toBe(0)
      expect(res.data.registryVersion).toBe('1.0.0')
      expect(res.data.registryHash).toBe('fdf2c1fd5ccf')
      expect(res.data.degraded).toBe(false)
      expect(res.data.entryCount).toBe(1)
      expect(res.data.entries).toEqual([
        { id: 'identity.opening', version: '1.0.0', order: 10, contentHash: 'cda839c9ee9c' },
      ])
    })
  })

  it('安全边界：响应里绝不出现提示词正文 / 标题 / owner（免鉴权的前提）', async () => {
    await withSnapshot(SNAP_OK, async () => {
      const res = await makeController().promptRegistry()
      const flat = JSON.stringify(res)
      expect(flat).not.toContain(SNAP_OK.entries[0].body)
      expect(flat).not.toContain('身份与语气')
      expect(flat).not.toContain('agent-platform')
      // 字段白名单：顶层只允许这些键
      expect(Object.keys(res.data).sort()).toEqual(
        [
          'degraded',
          'degradedReason',
          'entries',
          'entryCount',
          'groupChars',
          'registryHash',
          'registryVersion',
        ].sort(),
      )
      // 每条也只有四个键
      for (const e of res.data.entries) {
        expect(Object.keys(e).sort()).toEqual(['contentHash', 'id', 'order', 'version'].sort())
      }
    })
  })

  it('降级态：degraded=true 且带 degradedReason，绝不抛错（fail-soft 是本设计的核心）', async () => {
    await withSnapshot(SNAP_DEGRADED, async () => {
      const res = await makeController().promptRegistry()
      expect(res.code).toBe(0)
      expect(res.data.degraded).toBe(true)
      expect(res.data.degradedReason).toContain('没有任何 .md')
      expect(res.data.entryCount).toBe(0)
      expect(res.data.entries).toEqual([])
    })
  })

  it('groupChars：给出 4 种组合的渲染字符数，让「空静态段」一眼可见', async () => {
    await withSnapshot(SNAP_OK, async () => {
      const res = await makeController().promptRegistry()
      expect(Object.keys(res.data.groupChars).sort()).toEqual(
        ['core', 'core+genTools', 'core+writeTools', 'core+writeTools+genTools'].sort(),
      )
      for (const v of Object.values(res.data.groupChars)) {
        expect(Number.isInteger(v)).toBe(true)
      }
    })
  })

  it('降级时 groupChars 仍给出非零长度（fallback 兜底确实在出文本）', async () => {
    await withSnapshot(SNAP_DEGRADED, async () => {
      const res = await makeController().promptRegistry()
      expect(res.data.groupChars.core).toBeGreaterThan(0)
    })
  })
})
