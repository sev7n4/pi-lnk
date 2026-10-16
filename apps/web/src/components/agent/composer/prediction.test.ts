import { describe, expect, it } from 'vitest'
import { buildGhostPrediction, acceptPrediction } from './prediction'

describe('composer prediction (P2-1.1)', () => {
  it('accepts ghost onto draft', () => {
    expect(acceptPrediction('帮我', '生成三张变体')).toBe('帮我生成三张变体')
  })
  it('no prediction context → null (layer hidden)', () => {
    expect(buildGhostPrediction({ draft: '', history: [], refs: [] })).toBeNull()
  })
})
