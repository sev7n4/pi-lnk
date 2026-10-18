import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import QrPayPanel from './QrPayPanel.vue'
import { paymentApi } from '@/services/payment-api'

vi.mock('@/services/payment-api', () => ({
  paymentApi: {
    getOrder: vi.fn(),
  },
}))

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async () => 'data:image/png;base64,fake'),
  },
}))

const baseOrder = {
  id: 'ord-1',
  plan: 'topup',
  kind: 'topup',
  points: 6000,
  amountFen: 5000,
  status: 'PENDING',
  paidAt: null,
  createdAt: '',
}

type GetOrderRes = Awaited<ReturnType<typeof paymentApi.getOrder>>
/** 测试响应只需 data 层；AxiosResponse 其余字段与本测试无关。 */
function mockGetOrder(order: Record<string, unknown>) {
  vi.mocked(paymentApi.getOrder).mockResolvedValue({ data: { data: order } } as unknown as GetOrderRes)
}

describe('QrPayPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('渲染二维码与金额（¥50），PENDING 时不发 paid', async () => {
    mockGetOrder({ ...baseOrder })
    const wrapper = mount(QrPayPanel, {
      props: {
        orderId: 'ord-1',
        qrCode: 'https://qr.alipay.com/bax-test',
        amountFen: 5000,
        summaryRows: [{ label: '积分总数', value: '6,000' }],
        expiryText: '2027-10-18（到期不自动续购）',
      },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('¥50')
    expect(wrapper.text()).toContain('6,000')
    expect(wrapper.text()).toContain('2027-10-18')
    expect(wrapper.find('img[alt="支付宝收款二维码"]').exists()).toBe(true)
    expect(wrapper.emitted('paid')).toBeUndefined()
    wrapper.unmount()
  })

  it('轮询到 PAID → emit paid 并停止轮询', async () => {
    mockGetOrder({ ...baseOrder, status: 'PAID', paidAt: '2026-10-18T08:00:00Z' })
    const wrapper = mount(QrPayPanel, {
      props: { orderId: 'ord-1', qrCode: 'https://qr.alipay.com/bax-test', amountFen: 5000 },
    })
    await flushPromises()
    expect(wrapper.emitted('paid')).toHaveLength(1)
    expect(wrapper.text()).toContain('支付成功')
    wrapper.unmount()
  })

  it('订单关闭 → emit failed', async () => {
    mockGetOrder({ ...baseOrder, status: 'CLOSED' })
    const wrapper = mount(QrPayPanel, {
      props: { orderId: 'ord-1', qrCode: 'https://qr.alipay.com/bax-test', amountFen: 5000 },
    })
    await flushPromises()
    expect(wrapper.emitted('failed')).toHaveLength(1)
    expect(wrapper.emitted('failed')![0]).toEqual(['CLOSED'])
    wrapper.unmount()
  })

  it('orderId 变化（重新下单）→ 重新开始轮询', async () => {
    mockGetOrder({ ...baseOrder })
    const wrapper = mount(QrPayPanel, {
      props: { orderId: 'ord-1', qrCode: 'https://qr.alipay.com/bax-1', amountFen: 5000 },
    })
    await flushPromises()
    expect(paymentApi.getOrder).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ orderId: 'ord-2', qrCode: 'https://qr.alipay.com/bax-2' })
    await flushPromises()
    expect(paymentApi.getOrder).toHaveBeenCalledTimes(2)
    expect(paymentApi.getOrder).toHaveBeenLastCalledWith('ord-2')
    wrapper.unmount()
  })
})
