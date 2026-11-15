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
    for (const bad of [
      'addNode(', 'ingestMediaFile(', 'addFromFile(',
      'mergeFocusNodeRef(', 'selectionNodeIds',
    ]) {
      expect(promoteBody).not.toContain(bad)
    }
    expect(promoteBody).not.toMatch(/text:\s*text\.slice\(/)
    expect(promoteBody).not.toMatch(/text:\s*text\.substring\(/)
  })
})
