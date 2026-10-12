import { describe, expect, it } from 'vitest'
import type { UpstreamRouteRow } from '@lnkpi/shared'
import {
  buildEntryOps,
  foldPlatformTraffic,
  parseAvailabilityByName,
  resolveEntryEndpoint,
} from './model-catalog-link'

/**
 * model-catalog-link 纯逻辑单测（2026-10-12 目录页【上游端点 + 链路状态】增强）。
 * IO（prisma / env / 路由缓存）在控制器；这里只钉死三个纯函数的口径。
 */

const ROUTE_ROWS: UpstreamRouteRow[] = [
  { matchType: 'prefix', pattern: 'minimax-h3', capability: '*', upstream: 'minimax', priority: 100, enabled: true },
  { matchType: 'default', pattern: null, capability: '*', upstream: 'agnes_hub', priority: 0, enabled: true },
]

describe('parseAvailabilityByName', () => {
  it('合法 JSON → name→availability 映射；非法值/缺 name 条目跳过', () => {
    const raw = JSON.stringify([
      { name: 'm-1', capability: 'text', availability: 'unavailable' },
      { name: 'm-2', capability: 'text', availability: 'available' },
      { name: 'm-3', capability: 'text' }, // 旧格式无 availability → 跳过（不进 map）
      { capability: 'text', availability: 'available' }, // 缺 name → 跳过
      { name: 'm-4', availability: 'bogus' }, // 非法值 → 跳过
    ])
    const map = parseAvailabilityByName(raw)
    expect(map.get('m-1')).toBe('unavailable')
    expect(map.get('m-2')).toBe('available')
    expect(map.has('m-3')).toBe(false)
    expect(map.has('m-4')).toBe(false)
  })

  it('null / 畸形 JSON / 非数组 → 空 map（保守不猜）', () => {
    expect(parseAvailabilityByName(null).size).toBe(0)
    expect(parseAvailabilityByName('not-json{').size).toBe(0)
    expect(parseAvailabilityByName('{"a":1}').size).toBe(0)
  })
})

describe('foldPlatformTraffic', () => {
  it('只保留 channelId=platform 行；BYOK 行（userId 前缀段）不计入', () => {
    const map = foldPlatformTraffic([
      { model: 'm-1', channelId: 'platform', completed: 3, balance402Count: 1 },
      { model: 'm-1', channelId: 'platform', completed: 1, balance402Count: 0 },
      { model: 'm-1', channelId: 'cmrrxageh', completed: 99, balance402Count: 42 },
      { model: 'm-2', channelId: 'byok-user', completed: 5, balance402Count: 5 },
      { model: '', channelId: 'platform', completed: 7, balance402Count: 0 },
    ])
    expect(map.get('m-1')).toEqual({ completed24h: 4, balance40224h: 1 })
    expect(map.has('m-2')).toBe(false)
  })

  it('空输入 → 空 map', () => {
    expect(foldPlatformTraffic([]).size).toBe(0)
  })
})

describe('resolveEntryEndpoint', () => {
  it('命中 default 行 → agnes_hub；baseUrl 取注入的 OPENAI_BASE_URL', () => {
    const r = resolveEntryEndpoint(ROUTE_ROWS, 'agnes-2.5-flash', 'text', 'https://apihub.agnes-ai.cn/v1')
    expect(r).toEqual({ upstream: 'agnes_hub', baseUrl: 'https://apihub.agnes-ai.cn/v1' })
  })

  it('agnes_hub 注入空串 → baseUrl null（上游端点未知）', () => {
    const r = resolveEntryEndpoint(ROUTE_ROWS, 'agnes-2.5-flash', 'text', '')
    expect(r).toEqual({ upstream: 'agnes_hub', baseUrl: null })
  })

  it('静态注册表上游（stepfun）→ baseUrl 取注册表缺省，与注入无关', () => {
    const rows: UpstreamRouteRow[] = [
      { matchType: 'prefix', pattern: 'step-', capability: '*', upstream: 'stepfun', priority: 100, enabled: true },
    ]
    const r = resolveEntryEndpoint(rows, 'step-tts-1', 'text', '')
    expect(r.upstream).toBe('stepfun')
    expect(r.baseUrl).toBeTruthy()
  })

  it('空路由表（无 default 行）→ 双 null，绝不抛出', () => {
    const r = resolveEntryEndpoint([], 'any-model', 'text', 'https://x')
    expect(r).toEqual({ upstream: null, baseUrl: null })
  })
})

describe('buildEntryOps', () => {
  it('四源组装：在镜像读 availability，不在镜像报 null；缺流量补零', () => {
    const avail = parseAvailabilityByName(
      JSON.stringify([{ name: 'm-1', capability: 'text', availability: 'unavailable' }]),
    )
    const inMirror = (name: string) => name === 'm-1' || name === 'm-2'
    const traffic = new Map([['m-1', { completed24h: 2, balance40224h: 1 }]])
    const ops1 = buildEntryOps('m-1', 'text', ROUTE_ROWS, 'https://agnes', avail, inMirror, traffic)
    expect(ops1).toEqual({
      upstream: 'agnes_hub',
      baseUrl: 'https://agnes',
      availability: 'unavailable',
      completed24h: 2,
      balance40224h: 1,
    })
    // 在镜像但无合法值（旧格式）→ unknown；无流量 → 补零
    const ops2 = buildEntryOps('m-2', 'text', ROUTE_ROWS, 'https://agnes', avail, inMirror, new Map())
    expect(ops2.availability).toBe('unknown')
    expect(ops2).toMatchObject({ completed24h: 0, balance40224h: 0 })
    // 不在镜像（软删/未对齐新条目）→ availability null
    const ops3 = buildEntryOps('m-9', 'text', ROUTE_ROWS, 'https://agnes', avail, inMirror, new Map())
    expect(ops3.availability).toBeNull()
  })
})
