import { describe, expect, it } from 'vitest'
import {
  isDockGenerateBusy,
  isNodeGenerating,
  isPendingConfirmNode,
  NODE_GENERATION_STATUS,
  NODE_PENDING_CONFIRM_STATUS,
} from '@/constants/dockStudio'

describe('isNodeGenerating', () => {
  it('treats generating as busy', () => {
    expect(isNodeGenerating(NODE_GENERATION_STATUS.generating)).toBe(true)
  })

  it('treats fallback_pending as busy/readonly', () => {
    expect(isNodeGenerating(NODE_GENERATION_STATUS.fallback_pending)).toBe(true)
  })

  it('does not treat completed/error/draft as busy', () => {
    expect(isNodeGenerating(NODE_GENERATION_STATUS.completed)).toBe(false)
    expect(isNodeGenerating(NODE_GENERATION_STATUS.error)).toBe(false)
    expect(isNodeGenerating(NODE_GENERATION_STATUS.draft)).toBe(false)
    expect(isNodeGenerating(undefined)).toBe(false)
  })
})

describe('isDockGenerateBusy', () => {
  it('is true only for generating', () => {
    expect(isDockGenerateBusy(NODE_GENERATION_STATUS.generating)).toBe(true)
  })

  it('is false for fallback_pending (Dock shows arrow)', () => {
    expect(isDockGenerateBusy(NODE_GENERATION_STATUS.fallback_pending)).toBe(false)
  })

  it('is false for idle/terminal statuses', () => {
    expect(isDockGenerateBusy(NODE_GENERATION_STATUS.draft)).toBe(false)
    expect(isDockGenerateBusy(NODE_GENERATION_STATUS.error)).toBe(false)
    expect(isDockGenerateBusy(NODE_GENERATION_STATUS.completed)).toBe(false)
    expect(isDockGenerateBusy(undefined)).toBe(false)
  })
})

describe('isPendingConfirmNode（ADR-0011 T4 判据）', () => {
  it('is true only for pending_confirm status', () => {
    expect(isPendingConfirmNode({ data: { status: NODE_PENDING_CONFIRM_STATUS } })).toBe(true)
  })

  it('is false for generation/terminal statuses and missing data', () => {
    expect(isPendingConfirmNode({ data: { status: NODE_GENERATION_STATUS.draft } })).toBe(false)
    expect(isPendingConfirmNode({ data: { status: NODE_GENERATION_STATUS.generating } })).toBe(false)
    expect(isPendingConfirmNode({ data: { status: NODE_GENERATION_STATUS.completed } })).toBe(false)
    expect(isPendingConfirmNode({ data: {} })).toBe(false)
    expect(isPendingConfirmNode({})).toBe(false)
    expect(isPendingConfirmNode(null)).toBe(false)
    expect(isPendingConfirmNode(undefined)).toBe(false)
  })
})
