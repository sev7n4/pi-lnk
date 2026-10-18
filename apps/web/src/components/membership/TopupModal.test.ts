import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TopupModal from './TopupModal.vue'
import { useAuthStore } from '@/stores/auth'
import { paymentApi } from '@/services/payment-api'

const topupOptions = {
  tiers: [
    { amountFen: 1000, basePoints: 1000, bonusPoints: 0, totalPoints: 1000 },
    { amountFen: 2000, basePoints: 2000, bonusPoints: 200, totalPoints: 2200 },
    { amountFen: 3000, basePoints: 3000, bonusPoints: 450, totalPoints: 3450 },
    { amountFen: 5000, basePoints: 5000, bonusPoints: 1000, totalPoints: 6000 },
    { amountFen: 10000, basePoints: 10000, bonusPoints: 3000, totalPoints: 13000 },
  ],
  customMinFen: 500,
  customMaxFen: 1000000,
  pointsPerFen: 1,
  expiryDays: 365,
}

vi.mock('@/services/payment-api', () => ({
  paymentApi: {
    topupOptions: vi.fn(async () => ({ data: { data: topupOptions } })),
    createTopup: vi.fn(async () => ({
      data: { data: { orderId: 'ord-1', qrCode: 'https://qr.alipay.com/bax-test', amountFen: 5000 } },
    })),
    getOrder: vi.fn(async () => ({
      data: { data: { id: 'ord-1', status: 'PENDING', points: 6000, amountFen: 5000, kind: 'topup', plan: 'topup', paidAt: null, createdAt: '' } },
    })),
  },
}))

vi.mock('@/services/users-api', () => ({
  membershipApi: {
    getPlans: vi.fn(async () => ({ data: { data: [] } })),
    getPoints: vi.fn(async () => ({ data: { data: { points: 1128, membership: 'free' } } })),
    claimDaily: vi.fn(),
    upgrade: vi.fn(),
  },
}))

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(async () => 'data:image/png;base64,fake'),
  },
}))

/** 渲染 slot 的 ElDialog stub（默认不渲染内容，需手动展开）。 */
const ElDialogSlotStub = {
  props: { modelValue: Boolean, appendToBody: Boolean },
  template: '<div class="el-dialog-stub" :data-append-to-body="String(appendToBody)"><slot name="header" /><slot /></div>',
}

async function mountModal() {
  const pinia = createPinia()
  setActivePinia(pinia)
  // 预置登录态（isLoggedIn = token && user）
  localStorage.setItem('token', 'test-token')
  const auth = useAuthStore()
  auth.user = { id: 'u-1', phone: 'p', nickname: 'tester', points: 1128, membership: 'free' } as never
  const wrapper = mount(TopupModal, {
    props: { modelValue: true },
    global: {
      plugins: [pinia],
      stubs: { ElDialog: ElDialogSlotStub },
    },
  })
  await flushPromises()
  return wrapper
}

describe('TopupModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('append-to-body：必须脱离 canvas chrome 堆叠上下文', async () => {
    const wrapper = await mountModal()
    expect(wrapper.find('.el-dialog-stub').attributes('data-append-to-body')).toBe('true')
    wrapper.unmount()
  })

  it('渲染 6 块瓦片（5 固定档 + 自定义），档位展示含赠送', async () => {
    const wrapper = await mountModal()
    const tiles = wrapper.findAll('.topup-tile')
    expect(tiles).toHaveLength(6)
    // ¥50 档显示合计 6,000（含赠送 +1,000）
    const text = tiles.map((t) => t.text()).join('\n')
    expect(text).toContain('6,000')
    expect(text).toContain('+1,000')
    expect(text).toContain('自定义')
    wrapper.unmount()
  })

  it('选档下单：点击支付 → createTopup 收到对应 amountFen，进入扫码视图', async () => {
    const wrapper = await mountModal()
    const tiles = wrapper.findAll('.topup-tile')
    await tiles[3].trigger('click') // ¥50
    await flushPromises()
    const payBtn = wrapper.find('.topup-pay-btn')
    expect(payBtn.attributes('disabled')).toBeUndefined()
    await payBtn.trigger('click')
    await flushPromises()
    expect(paymentApi.createTopup).toHaveBeenCalledWith(5000, 'qrcode')
    expect(wrapper.findComponent({ name: 'QrPayPanel' }).exists()).toBe(true)
    wrapper.unmount()
  })

  it('自定义金额：低于 ¥5 禁止支付，≥¥5 按分下单', async () => {
    const wrapper = await mountModal()
    const customTile = wrapper.findAll('.topup-tile')[5]
    await customTile.trigger('click')
    await flushPromises()

    const input = wrapper.find('.custom-input')
    await input.setValue('3') // 低于起充
    await flushPromises()
    expect(wrapper.find('.topup-pay-btn').attributes('disabled')).toBeDefined()

    await input.setValue('10')
    await flushPromises()
    const payBtn = wrapper.find('.topup-pay-btn')
    expect(payBtn.attributes('disabled')).toBeUndefined()
    await payBtn.trigger('click')
    await flushPromises()
    expect(paymentApi.createTopup).toHaveBeenCalledWith(1000, 'qrcode')
    wrapper.unmount()
  })
})
