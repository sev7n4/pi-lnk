import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P2 回归锁（2026-10-06）：执行过程此前被渲染两遍 ——
 * `AgentExecutionTrace`（msg.executionTrace.steps 的 tool 步）与
 * `msg.toolCalls` → ToolCallCard 平铺行同屏，两份由同一批 SSE 事件双写、
 * 共用 presentToolStep 出文案 ⇒ 「创建节点 / 处理中 / 提议生成」整组重复。
 * 修复 = 下线 toolCalls 平铺，trace 作唯一 SSOT。本锁防复活：
 * SideRail 重新引用 ToolCallCard / 渲染 msg.toolCalls，或组件文件被加回来。
 *
 * ⚠️ 路径用 process.cwd() 定位：本仓 vitest（jsdom 环境）里 import.meta.url
 * 不是 file:// scheme，fileURLToPath 会报 ERR_INVALID_URL_SCHEME。
 * vitest root 恒为 apps/web ⇒ cwd 定位稳定。
 */
const agentDir = resolve(process.cwd(), 'src/components/agent')
const railSource = readFileSync(resolve(agentDir, 'AgentSideRail.vue'), 'utf8')

describe('执行过程单一 SSOT（ToolCallCard 平铺已下线，不得复活）', () => {
  it('AgentSideRail 不再渲染 msg.toolCalls、不再引用 ToolCallCard / collapseToolCalls', () => {
    expect(railSource).not.toMatch(/msg\.toolCalls/)
    expect(railSource).not.toMatch(/import ToolCallCard/)
    expect(railSource).not.toMatch(/collapseToolCalls/)
  })

  it('ToolCallCard / collapseToolCalls 组件文件已删除', () => {
    expect(existsSync(resolve(agentDir, 'ToolCallCard.vue'))).toBe(false)
    expect(existsSync(resolve(agentDir, 'collapseToolCalls.ts'))).toBe(false)
  })
})
