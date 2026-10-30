import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ 不用 `new URL('./AgentSideRail.vue', import.meta.url)`：vitest 环境下相对
// URL 解析抛 "The URL must be of scheme file"，与兄弟测试
// AgentSideRail.historyFetchNoStore.test.ts 同款 dirname/join 模式对齐。
const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, './AgentSideRail.vue'), 'utf8')

describe('AgentSideRail 历史加载失败重试卡（规格 H0-d / K3 / 验收 S1）', () => {
  it('存在失败态状态机（不再是 toast+空白）', () => {
    expect(src).toContain("'idle' | 'loading' | 'failed'")
  })
  it('失败卡带重试入口且重新调用 loadHistory', () => {
    expect(src).toContain('对话历史加载失败')
    expect(src).toContain('@click="loadHistory()"')
  })
  it('res.ok 失败分支与 catch 分支都置 failed', () => {
    expect(src.match(/historyLoadState\.value = 'failed'/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
