import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import {
  alreadyRefunded,
  applyChargeMeta,
  applyRefundMeta,
  chargedPointsFromRecord,
  isCancelledException,
  isCancelledMeta,
  rethrowWithRefundedPoints,
  throwCancelledException,
} from './charge-session'

describe('charge-session', () => {
  it('chargedPointsFromRecord reads stamped chargedPoints from record metadata', () => {
    expect(
      chargedPointsFromRecord({ metadata: JSON.stringify(applyChargeMeta({ model: 'm' }, 33)) }),
    ).toBe(33)
  })

  it('chargedPointsFromRecord fail-soft: 缺失/损坏/非法值 → undefined（键不出现）', () => {
    expect(chargedPointsFromRecord({ metadata: undefined })).toBeUndefined()
    expect(chargedPointsFromRecord({ metadata: null })).toBeUndefined()
    expect(chargedPointsFromRecord({ metadata: 'not-json{' })).toBeUndefined()
    expect(chargedPointsFromRecord({ metadata: JSON.stringify({ chargedPoints: 0 }) })).toBeUndefined()
    expect(chargedPointsFromRecord({ metadata: JSON.stringify({ chargedPoints: -3 }) })).toBeUndefined()
    expect(chargedPointsFromRecord({ metadata: JSON.stringify({ chargedPoints: '33' }) })).toBeUndefined()
    expect(chargedPointsFromRecord({})).toBeUndefined()
  })

  it('applyChargeMeta adds chargedPoints to meta', () => {
    expect(applyChargeMeta({ foo: 'bar' }, 10)).toEqual({ foo: 'bar', chargedPoints: 10 })
  })

  it('applyRefundMeta adds refundedPoints and refundReason to meta', () => {
    expect(applyRefundMeta({ chargedPoints: 10 }, 10, '文本生成退款')).toEqual({
      chargedPoints: 10,
      refundedPoints: 10,
      refundReason: '文本生成退款',
    })
  })

  it('alreadyRefunded returns true when refundedPoints > 0', () => {
    expect(alreadyRefunded({ refundedPoints: 5 })).toBe(true)
  })

  it('alreadyRefunded returns false when refundedPoints is missing or not positive', () => {
    expect(alreadyRefunded({})).toBe(false)
    expect(alreadyRefunded({ refundedPoints: 0 })).toBe(false)
    expect(alreadyRefunded({ refundedPoints: '5' })).toBe(false)
  })

  it('isCancelledMeta returns true when cancelled flag is set', () => {
    expect(isCancelledMeta({ cancelled: true })).toBe(true)
    expect(isCancelledMeta({ cancelled: false })).toBe(false)
    expect(isCancelledMeta({})).toBe(false)
  })

  it('throwCancelledException includes refundedPoints in response body', () => {
    try {
      throwCancelledException(10)
      expect.fail('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException)
      expect((err as BadRequestException).getResponse()).toMatchObject({
        message: '已取消',
        refundedPoints: 10,
      })
      expect(isCancelledException(err)).toBe(true)
    }
  })

  it('rethrowWithRefundedPoints attaches refundedPoints to existing BadRequestException', () => {
    try {
      rethrowWithRefundedPoints(new BadRequestException('upstream failed'), 10)
      expect.fail('should throw')
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toMatchObject({
        message: 'upstream failed',
        refundedPoints: 10,
      })
    }
  })
})
