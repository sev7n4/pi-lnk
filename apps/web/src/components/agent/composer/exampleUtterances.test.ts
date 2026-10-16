import { describe, expect, it } from 'vitest'
import { selectExampleUtterances, buildDraftFromUtterance, type UtterancePool } from './exampleUtterances'

const pool: UtterancePool = {
  empty: ['e1', 'e2', 'e3', 'e4', 'e5'],
  selection: ['s1', 's2'],
  artifact: ['a1', 'a2', 'a3'],
}

describe('selectExampleUtterances (P1-1.1)', () => {
  it('routes by canvas phase and caps at 4', () => {
    expect(selectExampleUtterances('empty', pool)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(selectExampleUtterances('selection', pool)).toEqual(['s1', 's2'])
    expect(selectExampleUtterances('artifact', pool)).toEqual(['a1', 'a2', 'a3'])
  })
})

describe('buildDraftFromUtterance (P1-1.2)', () => {
  it('returns editable draft text (never submits)', () => {
    expect(buildDraftFromUtterance('把首页 hero 重画成电商横幅')).toBe('把首页 hero 重画成电商横幅')
  })
})
