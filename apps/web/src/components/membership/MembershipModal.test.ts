import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { ElMessage } from 'element-plus'
import MembershipModal from './MembershipModal.vue'
import { useAuthStore } from '@/stores/auth'
import type { MembershipPlan } from '@/services/users-api'

/// 与后端 membership.service.ts PLANS 对齐的夹具（方案丙四档 + free）。
/// ⚠️ vi.mock 工厂会被提升到文件顶部，夹具/可变状态必须走 vi.hoisted 否则 TDZ 报错。
const PLANS_FIXTURE = vi.hoisted((): MembershipPlan[] => [
  { id: 'free', name: '免费版', points: 1000, price: 0, features: ['每日 100 积分'] },
  { id: 'experience', name: '体验版', points: 3000, price: 29, basic: 2000, bonus: 1000, features: ['每日 100 积分'] },
  { id: 'standard', name: '标准版', points: 11000, price: 99, basic: 5000, bonus: 6000, features: ['每日 100 积分'] },
  { id: 'premium', name: '高级版', points: 25000, price: 199, basic: 10000, bonus: 15000, features: ['每日 100 积分', '优先队列'], recommended: true },
  { id: 'flagship', name: '旗舰版', points: 70000, price: 499, basic: 25000, bonus: 45000, features: ['每日 100 积分', '优先队列'] },
])

/// 可变测试状态：当前档位 / 积分 / 今日是否已签到。
const state = vi.hoisted(() => ({ membership: 'premium', points: 116365, claimedToday: false }))

/// 订阅快照夹具（锁定卡提示里要显示「仍可用至 X」）。
const SUBSCRIPTION_FIXTURE = vi.hoisted(() => ({
  plan: 'premium',
  planName: '高级版',
  status: 'active',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  agreementBound: false,
  daysRemaining: 20,
}))

const paymentMocks = vi.hoisted(() => ({
  createSubscriptionOrder: vi.fn(async () => ({ data: { data: { orderId: 'o1', qrCode: 'qr-x' } } })),
}))

vi.mock('@/services/users-api', () => ({
  membershipApi: {
    getPlans: vi.fn(async () => ({ data: { data: PLANS_FIXTURE } })),
    getPoints: vi.fn(async () => ({
      data: { data: { points: state.points, membership: state.membership, claimedToday: state.claimedToday } },
    })),
    claimDaily: vi.fn(async () => ({ data: { data: { points: state.points + 100, added: 100 } } })),
    getSubscription: vi.fn(async () => ({ data: { data: SUBSCRIPTION_FIXTURE } })),
    cancelSubscription: vi.fn(),
  },
  membershipLabel: vi.fn((id?: string) => PLANS_FIXTURE.find((p) => p.id === id)?.name ?? '免费版'),
  subscriptionLabel: vi.fn(
    (id?: string) => (id && id !== 'free' ? PLANS_FIXTURE.find((p) => p.id === id)?.name : undefined) ?? '未订阅',
  ),
}))

vi.mock('@/services/payment-api', () => ({
  paymentApi: {
    createSubscriptionOrder: paymentMocks.createSubscriptionOrder,
    getOrder: vi.fn(),
  },
}))

/// QrPayPanel 会轮询订单状态，测试里整体 stub 掉，避免副作用。
vi.mock('./QrPayPanel.vue', () => ({
  default: {
    name: 'QrPayPanel',
    props: ['orderId', 'qrCode', 'amountFen', 'summaryRows'],
    template: '<div class="qr-stub" />',
  },
}))

function loginStubs() {
  return {
    ElDialog: {
      props: ['modelValue', 'appendToBody', 'width'],
      template: '<div class="el-dialog-stub"><slot name="header" /><slot /></div>',
    },
    ElButton: {
      props: ['loading', 'type', 'size'],
      emits: ['click'],
      template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
    },
  }
}

function mountAs(membership: string) {
  state.membership = membership
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  auth.token = 'test-token'
  auth.user = { id: 'u1', membership, points: state.points } as never
  return mount(MembershipModal, {
    props: { modelValue: true },
    global: { plugins: [pinia], stubs: loginStubs() },
  })
}

/// Toast 是锁定/当前档点击的唯一可见反馈，统一打桩断言。
function spyMessage() {
  return {
    warning: vi.spyOn(ElMessage, 'warning').mockImplementation(() => undefined as never),
    info: vi.spyOn(ElMessage, 'info').mockImplementation(() => undefined as never),
    success: vi.spyOn(ElMessage, 'success').mockImplementation(() => undefined as never),
  }
}

beforeEach(() => {
  paymentMocks.createSubscriptionOrder.mockClear()
  state.points = 116365
  state.claimedToday = false
})

describe('MembershipModal', () => {
  it('enables append-to-body so canvas chrome cannot trap dialog clicks', () => {
    const pinia = createPinia()
    const wrapper = mount(MembershipModal, {
      props: { modelValue: false },
      global: {
        plugins: [pinia],
        stubs: {
          ...loginStubs(),
          ElDialog: {
            props: { modelValue: Boolean, appendToBody: Boolean },
            template: '<div class="el-dialog-stub" :data-append-to-body="String(appendToBody)" />',
          },
        },
      },
    })
    const dialog = wrapper.findComponent({ name: 'ElDialog' })
    if (dialog.exists()) {
      expect(dialog.props('appendToBody')).toBe(true)
    } else {
      expect(wrapper.find('.el-dialog-stub').attributes('data-append-to-body')).toBe('true')
    }
    wrapper.unmount()
  })

  it('渲染四个可购买档位，过滤免费档', async () => {
    const wrapper = mountAs('premium')
    await flushPromises()

    expect(wrapper.findAll('.plan')).toHaveLength(4)
    expect(wrapper.text()).not.toContain('免费版')
    expect(wrapper.find('.hd-pi').text()).toBe('π')

    wrapper.unmount()
  })

  it('头部只留品牌与当前套餐（积分/签到/退订按钮已迁走）', async () => {
    const wrapper = mountAs('premium')
    await flushPromises()

    expect(wrapper.find('.hd-current').text()).toBe('高级版')
    // 精简回归：这三个都不该再出现在套餐页（分别去了我的积分 / 我的订阅）
    expect(wrapper.find('.hd-points').exists()).toBe(false)
    expect(wrapper.find('.hd-claim').exists()).toBe(false)
    expect(wrapper.find('.hd-cancel').exists()).toBe(false)
    expect(wrapper.find('.hd-cancel--danger').exists()).toBe(false)
    // 说明行与「当前套餐」角标也已移除
    expect(wrapper.find('.sub').exists()).toBe(false)
    expect(wrapper.find('.badge-current').exists()).toBe(false)

    wrapper.unmount()
  })

  it('免费档用户：四档全部可直接购买，推荐档主色实心、其余次级描边', async () => {
    const wrapper = mountAs('free')
    await flushPromises()

    const recoCard = wrapper.findAll('.plan').find((c) => c.classes().includes('is-recommended'))
    expect(recoCard).toBeTruthy()
    expect(recoCard!.find('.badge-reco').text()).toBe('推荐')
    expect(recoCard!.find('.plan-cta').classes()).toContain('plan-cta--primary')
    expect(recoCard!.find('.plan-cta').text()).toBe('立即购买')
    expect(wrapper.findAll('.plan-cta--ghost')).toHaveLength(3)
    expect(wrapper.findAll('.plan-cta-current')).toHaveLength(0)
    expect(wrapper.findAll('.plan-cta-locked')).toHaveLength(0)

    wrapper.unmount()
  })

  it('已持付费档：当前档可识别，其余三档「需先退订」', async () => {
    const wrapper = mountAs('premium')
    await flushPromises()

    const cards = wrapper.findAll('.plan')
    const byName = (name: string) => cards.find((c) => c.find('.plan-name').text() === name)!

    expect(byName('高级版').find('.plan-cta-current').text()).toBe('当前套餐')
    for (const name of ['体验版', '标准版', '旗舰版']) {
      expect(byName(name).find('.plan-cta-locked').text()).toBe('需先退订')
      expect(byName(name).find('.plan-cta').exists()).toBe(false)
    }

    wrapper.unmount()
  })

  it('点击可购买卡片下单并进入扫码支付视图（整卡热区）', async () => {
    const wrapper = mountAs('free')
    await flushPromises()

    const flagship = wrapper.findAll('.plan').find((c) => c.find('.plan-name').text() === '旗舰版')!
    await flagship.trigger('click')
    await flushPromises()

    expect(paymentMocks.createSubscriptionOrder).toHaveBeenCalledWith('flagship', 'qrcode')
    expect(wrapper.find('.pay-head').exists()).toBe(true)
    expect(wrapper.find('.qr-stub').exists()).toBe(true)

    wrapper.unmount()
  })

  it('点击锁定卡片：Toast 说明真实路径 + 抖动，零订单', async () => {
    const msg = spyMessage()
    const wrapper = mountAs('premium')
    await flushPromises()

    const standard = wrapper.findAll('.plan').find((c) => c.find('.plan-name').text() === '标准版')!
    await standard.trigger('click')
    await flushPromises()

    expect(paymentMocks.createSubscriptionOrder).not.toHaveBeenCalled()
    expect(msg.warning).toHaveBeenCalledTimes(1)
    const text = String(msg.warning.mock.calls[0][0])
    expect(text).toContain('只能持有一个套餐')
    expect(text).toContain('标准版')
    // 提示必须点明「取消续费仍可用至 X」+「立即退订」两条真实出路
    expect(text).toContain('仍可用至')
    expect(text).toContain('立即退订')
    expect(standard.classes()).toContain('is-nudge')

    wrapper.unmount()
  })

  it('点击当前档卡片：Toast 提示正在使用，零订单', async () => {
    const msg = spyMessage()
    const wrapper = mountAs('premium')
    await flushPromises()

    const premium = wrapper.findAll('.plan').find((c) => c.find('.plan-name').text() === '高级版')!
    await premium.trigger('click')
    await flushPromises()

    expect(paymentMocks.createSubscriptionOrder).not.toHaveBeenCalled()
    expect(msg.info).toHaveBeenCalledTimes(1)
    expect(String(msg.info.mock.calls[0][0])).toContain('高级版')

    wrapper.unmount()
  })

  it('未订阅时头部说「未订阅」而不是「免费版」', async () => {
    const wrapper = mountAs('free')
    await flushPromises()

    expect(wrapper.find('.hd-current').text()).toBe('未订阅')
    expect(wrapper.find('.hd-current').text()).not.toContain('免费版')

    wrapper.unmount()
  })

  it('脚注保留单套餐规则与周期说明', async () => {
    const wrapper = mountAs('free')
    await flushPromises()

    const foot = wrapper.find('.footnote').text()
    expect(foot).toContain('一个用户同时只持有一个套餐')
    expect(foot).toContain('连续包月')
    expect(wrapper.findAll('.plan-price-unit').map((n) => n.text())).toEqual(['/月', '/月', '/月', '/月'])

    wrapper.unmount()
  })
})