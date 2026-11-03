import 'reflect-metadata'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HealthController } from './health.controller'
import { notifyMetrics } from '../studio/notify-metrics'

const env = { ...process.env }

describe('HealthController /health/notify-metrics (E1 G-1 度量端点)', () => {
  let ctrl: HealthController

  beforeEach(() => {
    process.env = { ...env }
    delete process.env.LNKPI_TERMINAL_WRITE_TAP
    notifyMetrics.reset()
    ctrl = new HealthController()
  })

  afterEach(() => {
    process.env = env
    notifyMetrics.reset()
  })

  it('默认（未置 false）⇒ terminalWriteTapEnabled=true', () => {
    const res = ctrl.getNotifyMetrics()
    expect(res.ok).toBe(true)
    expect(res.terminalWriteTapEnabled).toBe(true)
    expect(typeof res.timestamp).toBe('string')
    expect(res.metrics).toHaveProperty('notified')
    expect(res.metrics).toHaveProperty('scans')
  })

  it('LNKPI_TERMINAL_WRITE_TAP=false ⇒ terminalWriteTapEnabled=false', () => {
    process.env.LNKPI_TERMINAL_WRITE_TAP = 'false'
    const res = ctrl.getNotifyMetrics()
    expect(res.terminalWriteTapEnabled).toBe(false)
  })

  it('暴露 notifyMetrics 快照（已通报记录数口径）', () => {
    notifyMetrics.incrNotified('terminal-write', 2)
    notifyMetrics.incrNotified('periodic', 5)
    const res = ctrl.getNotifyMetrics()
    expect(res.metrics.notified['terminal-write']).toBe(2)
    expect(res.metrics.notified['periodic']).toBe(5)
  })

  it('基础 /health 仍可用', () => {
    const res = ctrl.getHealth()
    expect(res.ok).toBe(true)
    expect(res.service).toBe('lnkpi-api')
  })
})
