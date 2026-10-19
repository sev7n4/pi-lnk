import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { ElMessageBox } from 'element-plus'
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

const membershipMocks = vi.hoisted(() => ({
  cancelSubscription: vi.fn(async () => ({
    data: { data: { membership: 'free', points: 116365, changed: true } },
  })),
}))

vi.mock('@/services/users-api', () => ({
  membershipApi: {
    getPlans: vi.fn(async () => ({ data: { data: PLANS_FIXTURE } })),
    getPoints: vi.fn(async () => ({ data: { data: { points: state.points, membership: state.membership } } })),
    claimDaily: vi.fn(),
    upgrade: vi.fn(),
    cancelSubscription: membershipMocks.cancelSubscription,
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
  membershipMocks.cancelSubscription.mockClear()
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

  it('免费档用户：四档全部可直接购买，推荐档主色实心、其余次级描边', async () => {
    const wrapper = mountAs('free')
    await flushPromises()

    const recoCard = wrapper.findAll('.plan').find((c) => c.classes().includes('is-recommended'))
    expect(recoCard).toBeTruthy()
    expect(recoCard!.find('.badge-reco').text()).toBe('推荐')
    expect(recoCard!.find('.plan-cta').classes()).toContain('plan-cta--primary')
    expect(recoCard!.find('.plan-cta').text()).toBe('立即购买')
    expect(wrapper.findAll('.plan-cta--ghost')).toHaveLength(3)
    // 无当前档 / 无锁定档
    expect(wrapper.findAll('.plan-cta-current')).toHaveLength(0)
    expect(wrapper.findAll('.plan-cta-locked')).toHaveLength(0)
    // 免费档没有退订入口
    expect(wrapper.find('.hd-cancel').exists()).toBe(false)

    wrapper.unmount()
  })

  it('已持付费档：仅当前档可识别，其余三档「需先退订」且提供退订入口', async () => {
    const wrapper = mountAs('premium')
    await flushPromises()

    const cards = wrapper.findAll('.plan')
    const byName = (name: string) => cards.find((c) => c.find('.plan-name').text() === name)!

    // 当前档
    expect(byName('高级版').find('.plan-cta-current').text()).toBe('当前套餐')
    // 其余三档（含更高的旗舰版）一律需先退订——一个用户同时只持有一个套餐
    for (const name of ['体验版', '标准版', '旗舰版']) {
      expect(byName(name).find('.plan-cta-locked').text()).toBe('需先退订')
      expect(byName(name).find('.plan-cta').exists()).toBe(false)
    }
    expect(wrapper.findAll('.plan-cta-locked')).toHaveLength(3)
    expect(wrapper.findAll('.plan-cta')).toHaveLength(0)
    // 退订入口存在
    expect(wrapper.find('.hd-cancel').exists()).toBe(true)

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

  it('点击需退订的卡片：给出提示+抖动，且不产生订单', async () => {
    const wrapper = mountAs('premium')
    await flushPromises()

    const standard = wrapper.findAll('.plan').find((c) => c.find('.plan-name').text() === '标准版')!
    await standard.trigger('click')
    await flushPromises()

    expect(paymentMocks.createSubscriptionOrder).not.toHaveBeenCalled()
    expect(wrapper.find('.pay-head').exists()).toBe(false)
    // 关键回归：必须指向「先退订」而不是静默无反应
    expect(wrapper.find('.msg').text()).toContain('需先退订')
    expect(wrapper.find('.msg').text()).toContain('高级版')
    expect(standard.classes()).toContain('is-nudge')

    wrapper.unmount()
  })

  it('点击当前档卡片：提示正在使用，不产生订单', async () => {
    const wrapper = mountAs('premium')
    await flushPromises()

    const premium = wrapper.findAll('.plan').find((c) => c.find('.plan-name').text() === '高级版')!
    await premium.trigger('click')
    await flushPromises()

    expect(paymentMocks.createSubscriptionOrder).not.toHaveBeenCalled()
    expect(wrapper.find('.msg').text()).toContain('正在使用该套餐')

    wrapper.unmount()
  })

  it('顶档（旗舰版）用户：每张卡都有反馈，全程零订单', async () => {
    const wrapper = mountAs('flagship')
    await flushPromises()

    for (const name of ['体验版', '标准版', '高级版']) {
      const card = wrapper.findAll('.plan').find((c) => c.find('.plan-name').text() === name)!
      await card.trigger('click')
      await flushPromises()
      expect(wrapper.find('.msg').text()).toContain('需先退订')
    }
    const current = wrapper.findAll('.plan').find((c) => c.find('.plan-name').text() === '旗舰版')!
    await current.trigger('click')
    await flushPromises()
    expect(wrapper.find('.msg').text()).toContain('正在使用该套餐')

    expect(paymentMocks.createSubscriptionOrder).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('退订：二次确认后清档，其余档位恢复可购买', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const wrapper = mountAs('premium')
    await flushPromises()

    await wrapper.find('.hd-cancel').trigger('click')
    await flushPromises()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(membershipMocks.cancelSubscription).toHaveBeenCalledTimes(1)
    // 档位清空 → 头部显示免费版、退订入口消失
    expect(wrapper.find('.hd-current').text()).toContain('免费版')
    expect(wrapper.find('.hd-cancel').exists()).toBe(false)
    // 四档恢复可购买
    expect(wrapper.findAll('.plan-cta')).toHaveLength(4)
    expect(wrapper.findAll('.plan-cta-locked')).toHaveLength(0)
    expect(wrapper.find('.msg').text()).toContain('已退订')

    confirmSpy.mockRestore()
    wrapper.unmount()
  })

  it('退订确认被取消：不调用接口，档位保持不变', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel' as never)
    const wrapper = mountAs('premium')
    await flushPromises()

    await wrapper.find('.hd-cancel').trigger('click')
    await flushPromises()

    expect(membershipMocks.cancelSubscription).not.toHaveBeenCalled()
    expect(wrapper.find('.hd-current').text()).toContain('高级版')
    expect(wrapper.find('.hd-cancel').exists()).toBe(true)

    confirmSpy.mockRestore()
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
    // 单套餐规则写进脚注
    expect(foot).toContain('一个用户同时只持有一个套餐')

    wrapper.unmount()
  })
})
