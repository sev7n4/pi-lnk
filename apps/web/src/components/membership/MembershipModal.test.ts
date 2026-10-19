import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
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

/// 可变测试状态：当前档位 / 积分，按用例改写。
const state = vi.hoisted(() => ({ membership: 'premium', points: 116365 }))

const paymentMocks = vi.hoisted(() => ({
  createSubscriptionOrder: vi.fn(async () => ({ data: { data: { orderId: 'o1', qrCode: 'qr-x' } } })),
}))

vi.mock('@/services/users-api', () => ({
  membershipApi: {
    getPlans: vi.fn(async () => ({ data: { data: PLANS_FIXTURE } })),
    getPoints: vi.fn(async () => ({ data: { data: { points: state.points, membership: state.membership } } })),
    claimDaily: vi.fn(),
    upgrade: vi.fn(),
  },
  membershipLabel: vi.fn((id?: string) => PLANS_FIXTURE.find((p) => p.id === id)?.name ?? '免费版'),
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

beforeEach(() => {
  paymentMocks.createSubscriptionOrder.mockClear()
  state.points = 116365
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
            props: {
              modelValue: Boolean,
              appendToBody: Boolean,
            },
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

  it('renders four purchasable tiers, filters free, and marks recommended/current', async () => {
    const wrapper = mountAs('premium')
    await flushPromises()

    const cards = wrapper.findAll('.plan')
    expect(cards).toHaveLength(4)
    expect(wrapper.text()).not.toContain('免费版')

    // 头部：品牌标题 + 当前套餐标签 + 积分数字
    expect(wrapper.find('.hd-pi').text()).toBe('π')
    expect(wrapper.find('.hd-current').text()).toContain('高级版')
    expect(wrapper.find('.hd-num').text()).toBe('116,365')

    // 当前在推荐档(premium)：角标应显示「当前套餐」而非「推荐」（当前优先）
    const currentCard = cards.find((c) => c.classes().includes('is-current'))
    expect(currentCard).toBeTruthy()
    expect(currentCard!.find('.badge-current').text()).toBe('当前套餐')
    expect(currentCard!.find('.badge-reco').exists()).toBe(false)

    wrapper.unmount()
  })

  it('shows recommended badge + solid CTA on the recommended tier for a free user', async () => {
    const wrapper = mountAs('free')
    await flushPromises()

    const recoCard = wrapper.findAll('.plan').find((c) => c.classes().includes('is-recommended'))
    expect(recoCard).toBeTruthy()
    expect(recoCard!.find('.badge-reco').text()).toBe('推荐')
    // free 用户：四档全是可升级；推荐档(premium)CTA 走主色实心
    expect(recoCard!.find('.plan-cta').classes()).toContain('plan-cta--primary')
    // 其余可升级档走次级描边
    expect(wrapper.findAll('.plan-cta--ghost')).toHaveLength(3)
    // 没有当前档 / 低于当前档
    expect(wrapper.findAll('.plan-cta-current')).toHaveLength(0)
    expect(wrapper.findAll('.plan-cta-lower')).toHaveLength(0)

    wrapper.unmount()
  })

  it('blocks downgrade: premium user sees only flagship upgradable, lower tiers disabled', async () => {
    const wrapper = mountAs('premium')
    await flushPromises()

    const cards = wrapper.findAll('.plan')
    const byName = (name: string) => cards.find((c) => c.find('.plan-name').text() === name)!

    // 高于当前档 → 可升级 CTA
    expect(byName('旗舰版').find('.plan-cta').exists()).toBe(true)
    // 当前档 → 当前套餐
    expect(byName('高级版').find('.plan-cta-current').text()).toBe('当前套餐')
    expect(byName('高级版').find('.plan-cta').exists()).toBe(false)
    // 低于当前档 → 禁购提示，且没有可点 CTA
    expect(byName('体验版').find('.plan-cta-lower').text()).toBe('低于当前套餐')
    expect(byName('体验版').find('.plan-cta').exists()).toBe(false)
    expect(byName('标准版').find('.plan-cta-lower').exists()).toBe(true)

    // 计数：1 可升级 / 1 当前 / 2 低于
    expect(wrapper.findAll('.plan-cta')).toHaveLength(1)
    expect(wrapper.findAll('.plan-cta-current')).toHaveLength(1)
    expect(wrapper.findAll('.plan-cta-lower')).toHaveLength(2)

    wrapper.unmount()
  })

  it('clicking an upgradable card orders payment and opens the pay view', async () => {
    const wrapper = mountAs('free')
    await flushPromises()

    const flagship = wrapper.findAll('.plan').find((c) => c.find('.plan-name').text() === '旗舰版')!
    // 点击卡片本体（非按钮）也应触发升级
    await flagship.trigger('click')
    await flushPromises()

    expect(paymentMocks.createSubscriptionOrder).toHaveBeenCalledWith('flagship', 'qrcode')
    // 进入扫码支付视图
    expect(wrapper.find('.pay-head').exists()).toBe(true)
    expect(wrapper.find('.qr-stub').exists()).toBe(true)

    wrapper.unmount()
  })

  it('clicking a lower-tier card does NOT create an order (no silent downgrade)', async () => {
    const wrapper = mountAs('premium')
    await flushPromises()

    const standard = wrapper.findAll('.plan').find((c) => c.find('.plan-name').text() === '标准版')!
    await standard.trigger('click')
    await flushPromises()

    expect(paymentMocks.createSubscriptionOrder).not.toHaveBeenCalled()
    expect(wrapper.find('.pay-head').exists()).toBe(false)

    wrapper.unmount()
  })

  it('keeps each card self-contained but de-duplicates expiry/renewal copy', async () => {
    const wrapper = mountAs('free')
    await flushPromises()

    // 共享能力保留在每张卡内（自包含、可横向对比），不拆块
    for (const c of wrapper.findAll('.plan')) {
      expect(c.text()).toContain('对话式创作')
    }
    expect(wrapper.find('.shared').exists()).toBe(false)

    // 「有效期」不在每个积分行重复；续费规则不在每卡重复
    expect(wrapper.text()).not.toContain('有效期1个月')
    expect(wrapper.findAll('.plan-price-unit').map((n) => n.text())).toEqual(['/月', '/月', '/月', '/月'])

    // .sub 与脚注不再用近乎相同的句子说两遍
    const sub = wrapper.find('.sub').text()
    const foot = wrapper.find('.footnote').text()
    expect(sub).toContain('共享同一套创作能力')
    expect(foot).not.toContain('共享同一套创作能力')
    // 到期/续费规则在脚注只说一次
    expect(foot).toContain('当月未用完不结转')
    expect(foot).toContain('连续包月')

    wrapper.unmount()
  })
})
