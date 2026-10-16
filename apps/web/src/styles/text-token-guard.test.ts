import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const STYLES = HERE

describe('text color token guard (P0-2.3)', () => {
  it('no text/ink/fg token is defined with rgba alpha in styles/*.css', () => {
    const offenders: string[] = []
    for (const f of readdirSync(STYLES).filter((f) => f.endsWith('.css'))) {
      const css = readFileSync(join(STYLES, f), 'utf8')
      for (const m of css.matchAll(/--[a-z0-9-]*(?:text|ink|fg)[a-z0-9-]*\s*:\s*rgba\(/gi)) {
        offenders.push(`${f}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('--neo-text-muted is solid and theme-paired (P0-2.1)', () => {
    const css = readFileSync(join(STYLES, 'neowow-tokens.css'), 'utf8')
    expect(css).toContain('--neo-text-muted: var(--lnk-ink-600)')
    expect(css).toContain('--neo-text-muted: var(--lnk-ink-400)')
    expect(css).not.toMatch(/--neo-text-muted:\s*rgba\(/)
  })
})

describe('composer arbitrary font sizes collapsed (P0-2.2 / B15)', () => {
  it('AgentSideRail has no 10/11/12/13px literal font-size', () => {
    const sfc = readFileSync(join(HERE, '../components/agent/AgentSideRail.vue'), 'utf8')
    const hits = [...sfc.matchAll(/font-size:\s*(10|11|12|13)px/g)].map((m) => m[0])
    expect(hits).toEqual([])
  })
})
