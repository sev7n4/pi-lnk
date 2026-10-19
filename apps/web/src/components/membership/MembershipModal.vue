<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { membershipApi, membershipLabel, type MembershipPlan } from '@/services/users-api'
import { paymentApi } from '@/services/payment-api'
import { useAuthStore } from '@/stores/auth'
import QrPayPanel from './QrPayPanel.vue'

/**
 * π 套餐弹窗 · 方案丙四档订阅（2026-10-19 视觉重构 + 交互/简洁性补强）
 *
 * 版式骨架对齐成熟付费弹窗范式（参考 Buddy AI 套餐窗）：
 *   品牌头部（当前套餐 + 积分签到）→ 四档能力卡片 → 扫码支付视图（含协议行）。
 * 卡片文案严格取自设计稿 outputs/套餐包设计方案-四档订阅.html。
 *
 * 简洁性（2026-10-19）：共享能力保留在每张卡内（自包含、便于横向对比，不拆块以免割裂）；
 *   去重的是真正冗余的部分——「有效期」不在每个积分行重复（脚注说一次）、续费规则不在
 *   每卡重复（脚注说一次）、.sub 与脚注不再用近乎相同的句子说两遍。
 *
 * 交互（2026-10-19）：
 *   - 整卡可点（点价格/积分/空白都能触发升级），按钮仅作视觉与键盘可达入口；
 *   - 按「档位方向」渲染 CTA：高于当前=立即升级 / 等于=当前套餐 / 低于=低于当前套餐（禁购，
 *     因后端 grantPaidPlanTx 无条件覆盖 membership，买低档=静默降级）；
 *   - 点击即时选中反馈 + 仅被点卡片按钮转圈（payingPlanId），按压 :active 反馈；
 *   - 三个分支都必须有可见反馈：升级=进入支付 / 当前=提示 / 低于=提示+抖动（禁止静默无反应）。
 * 令牌纪律：只用 --neo-* / --lnk-* 语义令牌，不引入裸 hex/rgba（theme-usage 棘轮）。
 */

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const auth = useAuthStore()
const plans = ref<MembershipPlan[]>([])
const points = ref(0)
const membership = ref('free')
const loading = ref(false)
const message = ref('')
/// 正在下单的档位 id（仅该卡按钮转圈，避免四卡同时 loading）。
const payingPlanId = ref('')
/// 被点击选中的档位 id（下单异步间隙的即时选中反馈）。
const selectedPlanId = ref('')
/// 被点击但不可购买的档位 id（抖动反馈用，600ms 后自动清除）。
const nudgePlanId = ref('')
let nudgeTimer: number | undefined

/** select=套餐列表 · pay=扫码支付 */
const view = ref<'select' | 'pay'>('select')
const payPlan = ref<MembershipPlan | null>(null)
const payOrderId = ref('')
const payQrCode = ref('')
/// 可购买档位（排除默认免费档，方案丙四档纯积分模型）。
const purchasablePlans = computed(() => plans.value.filter((p) => p.id !== 'free'))

/// 档位排序（升级/降级判定）：free=0 … flagship=4。
const TIER_RANK: Record<string, number> = {
  free: 0,
  experience: 1,
  standard: 2,
  premium: 3,
  flagship: 4,
}
function tierRank(id?: string): number {
  return id != null ? TIER_RANK[id] ?? 0 : 0
}

/// 单卡 CTA 形态：upgrade=可升级 / current=当前档 / lower=低于当前档（禁购，防降级）。
type CtaKind = 'upgrade' | 'current' | 'lower'
function ctaKind(plan: MembershipPlan): CtaKind {
  if (plan.id === membership.value) return 'current'
  return tierRank(plan.id) < tierRank(membership.value) ? 'lower' : 'upgrade'
}

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

async function loadData() {
  if (!auth.isLoggedIn) return
  const [plansRes, pointsRes] = await Promise.all([
    membershipApi.getPlans(),
    membershipApi.getPoints(),
  ])
  plans.value = plansRes.data.data
  points.value = pointsRes.data.data.points
  membership.value = pointsRes.data.data.membership
}

watch(() => props.modelValue, (open) => {
  if (open) {
    view.value = 'select'
    payOrderId.value = ''
    payQrCode.value = ''
    selectedPlanId.value = ''
    payingPlanId.value = ''
    window.clearTimeout(nudgeTimer)
    nudgePlanId.value = ''
    message.value = ''
    void loadData()
  }
})

onMounted(() => {
  if (props.modelValue) void loadData()
})

async function claimDaily() {
  loading.value = true
  message.value = ''
  try {
    const { data } = await membershipApi.claimDaily()
    points.value = data.data.points
    auth.setPoints(data.data.points)
    message.value = `已领取 ${data.data.added} 积分`
  } catch {
    message.value = '今日已签到'
  } finally {
    loading.value = false
  }
}

/**
 * 卡片点击（整卡热区）的唯一入口——按「档位方向」分流，三个分支都必须有可见反馈：
 *   - 高于当前 → startPlanPay 进入扫码支付下单；
 *   - 等于当前 → 提示「正在使用该套餐」；
 *   - 低于当前 → 提示「暂不支持购买」+ 卡片抖动（后端 grantPaidPlanTx 无条件覆盖
 *     membership，买低档 = 静默降级，必须拦）。
 * 2026-10-19 修复：此前低于/当前档是静默 return，顶档用户点任何卡都石沉大海，
 * 观感等于「点击没反应」。
 */
async function onPlanClick(plan: MembershipPlan) {
  if (loading.value) return
  const kind = ctaKind(plan)
  if (kind === 'upgrade') {
    await startPlanPay(plan)
    return
  }
  message.value = kind === 'current' ? '你正在使用该套餐' : '该套餐低于当前套餐，暂不支持购买'
  nudgePlanId.value = plan.id
  window.clearTimeout(nudgeTimer)
  nudgeTimer = window.setTimeout(() => {
    nudgePlanId.value = ''
  }, 600)
}

/**
 * 升级 = 真实支付下单（支付宝扫码）。入账以异步回调为准；
 * PAID 后刷新积分与会员档位（服务端 settlePaidOrder 已完成发放）。
 * 仅「高于当前档」可到达此处（入口分流见 onPlanClick）；保留防御性守卫。
 */
async function startPlanPay(plan: MembershipPlan) {
  if (loading.value) return
  if (ctaKind(plan) !== 'upgrade') return
  loading.value = true
  payingPlanId.value = plan.id
  selectedPlanId.value = plan.id
  message.value = ''
  try {
    const { data } = await paymentApi.createSubscriptionOrder(plan.id, 'qrcode')
    payPlan.value = plan
    payOrderId.value = data.data.orderId
    payQrCode.value = data.data.qrCode ?? ''
    view.value = 'pay'
  } catch {
    message.value = '下单失败，请稍后重试'
    selectedPlanId.value = ''
  } finally {
    loading.value = false
    payingPlanId.value = ''
  }
}

async function onPlanPaid() {
  try {
    const { data } = await membershipApi.getPoints()
    points.value = data.data.points
    membership.value = data.data.membership
    if (auth.user) {
      auth.user.points = data.data.points
      auth.user.membership = data.data.membership
    }
  } catch {
    // 刷新失败不阻塞成功提示
  }
  view.value = 'select'
  payOrderId.value = ''
  payQrCode.value = ''
  selectedPlanId.value = ''
  message.value = '升级成功，权益已生效'
}

function onPlanPayFailed(reason: string) {
  view.value = 'select'
  selectedPlanId.value = ''
  message.value = reason === 'CLOSED' ? '订单已关闭，请重新发起' : '订单异常，请联系支持'
}

/* ------------------------------------------------------------------ */
/* 套餐卡片内容（文案取自设计稿；基础/赠送数值来自后端 PLANS）           */
/* ------------------------------------------------------------------ */

const fmt = (n?: number) => (typeof n === 'number' ? n.toLocaleString() : '—')

/** 副标语：档位定位一句话（与设计稿 plan-sub 一致）。 */
const TAGLINES: Record<string, string> = {
  experience: '轻量尝鲜首选',
  standard: '覆盖日常创作',
  premium: '支持高频创作',
  flagship: '满足重度创作',
}

interface PlanRow {
  kind: 'basic' | 'bonus' | 'feature'
  icon?: string
  text: string
}

/**
 * 每张卡自包含完整能力清单（基础/赠送积分 + 四档共享能力 + 高/旗舰优先队列），便于横向对比。
 * 共享能力保留在卡内，不拆到卡片外（拆开显得割裂）。
 */
function planRows(plan: MembershipPlan): PlanRow[] {
  const rows: PlanRow[] = []
  if (typeof plan.basic === 'number') {
    rows.push({ kind: 'basic', text: `每月 ${fmt(plan.basic)} 积分` })
  }
  if (typeof plan.bonus === 'number') {
    rows.push({ kind: 'bonus', text: `每月 ${fmt(plan.bonus)} 积分` })
  }
  for (const f of SHARED_FEATURES) rows.push({ kind: 'feature', icon: f.icon, text: f.text })
  if (plan.recommended || plan.id === 'flagship') {
    rows.push({ kind: 'feature', icon: 'bolt', text: '优先队列 · 高峰不排队' })
  }
  return rows
}

/** 四档共享的创作能力（设计稿「以下权益四档完全一致」区段）——每张卡自包含，便于横向对比。 */
const SHARED_FEATURES: Array<{ icon: string; text: string }> = [
  { icon: 'chat', text: '对话式创作 · 全模态产出' },
  { icon: 'film', text: '从脚本到成片 · 视觉保真' },
  { icon: 'vault', text: '作品沉淀为资产库' },
  { icon: 'calendar', text: '每日签到 +100 积分' },
]

/** 线性图标（描边式，继承 currentColor；静态常量，v-html 安全）。 */
const ICONS: Record<string, string> = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>',
  vault: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19 11a7 7 0 0 1-.1 1.2l2 1.6-2 3.4-2.4-1a7 7 0 0 1-2 1.2L14 20h-4l-.5-2.6a7 7 0 0 1-2-1.2l-2.4 1-2-3.4 2-1.6A7 7 0 0 1 5 11"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
}
</script>

<template>
  <!-- append-to-body: escape canvas chrome pointer-events-none / z-50 stacking -->
  <el-dialog
    v-model="visible"
    width="1080px"
    class="membership-dialog"
    append-to-body
    align-center
  >
    <template #header>
      <div class="hd">
        <div class="hd-brand">
          <span class="hd-pi">π</span>
          <span class="hd-title">套餐</span>
          <span class="hd-current">当前套餐：{{ membershipLabel(membership) }}</span>
        </div>
        <div class="hd-points">
          <span class="hd-bolt" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4.5 13.5h5.6L11 22l8.5-11.5h-5.6L13 2z" /></svg>
          </span>
          <span class="hd-num">{{ points.toLocaleString() }}</span>
          <el-button
            class="hd-claim"
            size="small"
            :loading="loading"
            @click="claimDaily"
          >
            领取 +100
          </el-button>
        </div>
      </div>
    </template>

    <div v-if="auth.isLoggedIn" class="body">
      <!-- 扫码支付视图 -->
      <template v-if="view === 'pay' && payPlan">
        <button type="button" class="back" @click="view = 'select'">‹ 返回套餐列表</button>

        <div class="pay-head">
          <div class="pay-head-name">
            {{ payPlan.name }} · 连续包月
            <span class="pay-head-sub">到期前一天自动续费，随时取消</span>
          </div>
          <div class="pay-head-price">
            ¥{{ payPlan.price }}<span class="pay-head-unit">/月</span>
          </div>
        </div>

        <QrPayPanel
          :order-id="payOrderId"
          :qr-code="payQrCode"
          :amount-fen="payPlan.price * 100"
          :summary-rows="[
            { label: '套餐', value: payPlan.name },
            { label: '到账积分', value: `${fmt(payPlan.points)}（基础 ${fmt(payPlan.basic)} + 赠送 ${fmt(payPlan.bonus)}）` },
          ]"
          @paid="onPlanPaid"
          @failed="onPlanPayFailed"
        />

        <div class="agree">
          <span class="agree-dot" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
          <span>我已阅读并同意《π 个人会员订阅服务协议（含自动续费服务规则）》</span>
        </div>
      </template>

      <!-- 套餐列表视图 -->
      <template v-else>
        <p class="sub">
          四档套餐<b>共享同一套创作能力</b>，差异只在每月创作额度（基础 + 赠送）。
        </p>

        <div class="plans">
          <article
            v-for="plan in purchasablePlans"
            :key="plan.id"
            class="plan"
            :class="{
              'is-recommended': plan.recommended,
              'is-current': membership === plan.id,
              'is-selected': selectedPlanId === plan.id,
              'is-nudge': nudgePlanId === plan.id,
              'is-actionable': ctaKind(plan) === 'upgrade',
              'is-lower': ctaKind(plan) === 'lower',
            }"
            @click="onPlanClick(plan)"
          >
            <!-- 当前套餐角标优先于推荐角标：你已在推荐档时，标明「当前套餐」比「推荐」更有用 -->
            <span v-if="membership === plan.id" class="badge badge-current">当前套餐</span>
            <span v-else-if="plan.recommended" class="badge badge-reco">推荐</span>

            <h3 class="plan-name">{{ plan.name }}</h3>
            <p class="plan-sub">
              <svg class="plan-bolt" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4.5 13.5h5.6L11 22l8.5-11.5h-5.6L13 2z" /></svg>
              <b>{{ fmt(plan.points) }}</b>
              <span class="plan-sub-tail">积分 · {{ TAGLINES[plan.id] ?? '' }}</span>
            </p>

            <hr class="divider">

            <ul class="rows">
              <li v-for="(row, i) in planRows(plan)" :key="i" class="row">
                <span
                  v-if="row.kind === 'basic'"
                  class="tag tag-basic"
                >基础</span>
                <span
                  v-else-if="row.kind === 'bonus'"
                  class="tag tag-bonus"
                >赠送</span>
                <span v-else class="row-icon" aria-hidden="true" v-html="ICONS[row.icon!]" />
                <span class="row-text">{{ row.text }}</span>
              </li>
            </ul>

            <div class="plan-foot">
              <div class="plan-price">
                <span class="plan-price-num">¥{{ plan.price }}</span>
                <span class="plan-price-unit">/月</span>
              </div>
              <!-- 高于当前档：可升级。推荐档用主色实心，其余次级描边，形成主次 -->
              <el-button
                v-if="ctaKind(plan) === 'upgrade'"
                class="plan-cta"
                :class="plan.recommended ? 'plan-cta--primary' : 'plan-cta--ghost'"
                type="primary"
                :loading="payingPlanId === plan.id"
              >
                立即升级
              </el-button>
              <!-- 当前档 -->
              <span v-else-if="ctaKind(plan) === 'current'" class="plan-cta-current">当前套餐</span>
              <!-- 低于当前档：禁购（后端会静默降级），弱化提示 -->
              <span v-else class="plan-cta-lower">低于当前套餐</span>
            </div>
          </article>
        </div>

        <!-- 四档共享能力：保留在每张卡内自包含（见 planRows），不拆块以免割裂 -->

        <p v-if="message" class="msg">{{ message }}</p>

        <footer class="footnote">
          出图、出视频、写文案、配音均消耗积分，额度用尽当月暂停生成、次月恢复；积分 = 每月基础 + 每月赠送，有效期 1 个月，当月未用完不结转。套餐为连续包月，到期自动续费，可随时取消。
        </footer>
      </template>
    </div>
    <p v-else class="login-hint">请先登录</p>
  </el-dialog>
</template>

<style>
.membership-dialog .el-dialog {
  background: var(--neo-surface-card);
  border: 1px solid var(--neo-border);
  border-radius: var(--lnk-radius-xl);
  max-width: calc(100vw - 32px);
  max-height: 88vh;
  overflow: auto;
}
.membership-dialog .el-dialog__header {
  padding: 20px 24px 0;
  margin-right: 0;
}
.membership-dialog .el-dialog__body {
  padding: 12px 24px 24px;
}

/* ---- 头部：品牌 + 当前套餐 + 积分签到 ---- */
.membership-dialog .hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-space-4);
  padding-right: var(--lnk-space-6);
  flex-wrap: wrap;
}
.membership-dialog .hd-brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.membership-dialog .hd-pi {
  font-family: var(--lnk-font-display);
  font-size: 22px;
  font-weight: 700;
  color: var(--neo-accent-text);
  line-height: 1;
}
.membership-dialog .hd-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--neo-text-primary);
}
.membership-dialog .hd-current {
  font-size: var(--lnk-text-xs);
  color: var(--neo-text-secondary);
  white-space: nowrap;
}
.membership-dialog .hd-points {
  display: flex;
  align-items: center;
  gap: var(--lnk-space-2);
  padding: 4px 8px 4px 12px;
  border-radius: var(--lnk-radius-full);
  background: var(--neo-warm-soft);
}
.membership-dialog .hd-bolt {
  width: 14px;
  height: 14px;
  color: var(--neo-warm);
  flex-shrink: 0;
}
.membership-dialog .hd-bolt svg {
  width: 100%;
  height: 100%;
  display: block;
}
.membership-dialog .hd-num {
  font-size: var(--lnk-text-base);
  font-weight: 700;
  color: var(--neo-warm);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.membership-dialog .hd-claim {
  --el-button-bg-color: var(--neo-surface-elevated);
  --el-button-border-color: var(--neo-border);
  --el-button-text-color: var(--neo-text-secondary);
  --el-button-hover-bg-color: var(--neo-hover-bg);
  --el-button-hover-border-color: var(--neo-border-strong);
  --el-button-hover-text-color: var(--neo-text-primary);
}

.membership-dialog .body {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-4);
}
.membership-dialog .sub {
  margin: 0;
  font-size: var(--lnk-text-xs);
  line-height: 1.7;
  color: var(--neo-text-secondary);
}
.membership-dialog .sub b {
  color: var(--neo-text-primary);
  font-weight: 600;
}

/* ---- 四档卡片 ---- */
.membership-dialog .plans {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--lnk-space-4);
  align-items: stretch;
}
@media (max-width: 1024px) {
  .membership-dialog .plans {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 560px) {
  .membership-dialog .plans {
    grid-template-columns: 1fr;
  }
}
.membership-dialog .plan {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 18px 16px 16px;
  border: 1px solid var(--neo-border);
  border-radius: var(--lnk-radius-lg);
  background: var(--neo-surface-elevated);
  transition: border-color var(--lnk-duration-fast) var(--lnk-ease-standard),
    transform var(--lnk-duration-fast) var(--lnk-ease-standard),
    box-shadow var(--lnk-duration-fast) var(--lnk-ease-standard),
    opacity var(--lnk-duration-fast) var(--lnk-ease-standard);
}
/* 仅「可升级」卡是可点热区：指针 + 悬停抬升 */
.membership-dialog .plan.is-actionable {
  cursor: pointer;
}
.membership-dialog .plan.is-actionable:hover {
  border-color: var(--neo-border-strong);
  transform: translateY(-2px);
  box-shadow: var(--lnk-shadow-sm);
}
/* 按压即时反馈 */
.membership-dialog .plan.is-actionable:active {
  transform: translateY(0) scale(0.985);
}
/* 键盘聚焦（按钮在卡内）时的可达性环 */
.membership-dialog .plan:focus-within {
  border-color: var(--neo-accent-border);
}
.membership-dialog .plan.is-recommended {
  border: 2px solid var(--neo-accent);
  box-shadow: var(--lnk-accent-glow);
}
.membership-dialog .plan.is-current {
  border-color: var(--neo-accent-border);
  background: var(--neo-accent-soft);
}
/* 点击后、下单异步间隙的选中环 */
.membership-dialog .plan.is-selected {
  border-color: var(--neo-accent);
  box-shadow: var(--lnk-accent-glow);
}
/* 点击不可购卡片的抖动反馈：让「点了没反应」变成「点了有回应」 */
@keyframes membership-plan-nudge {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-4px); }
  40% { transform: translateX(4px); }
  60% { transform: translateX(-3px); }
  80% { transform: translateX(2px); }
}
.membership-dialog .plan.is-nudge {
  animation: membership-plan-nudge 0.32s var(--lnk-ease-standard);
}
/* 低于当前档：弱化，暗示不可操作 */
.membership-dialog .plan.is-lower {
  opacity: 0.62;
}
.membership-dialog .badge {
  position: absolute;
  top: -11px;
  right: 14px;
  font-size: var(--lnk-text-2xs);
  line-height: 1;
  padding: 4px 10px;
  border-radius: var(--lnk-radius-full);
  letter-spacing: 1px;
  color: var(--lnk-text-on-accent);
}
.membership-dialog .badge-reco {
  background: var(--neo-accent);
}
.membership-dialog .badge-current {
  background: var(--neo-accent-strong);
}
.membership-dialog .plan-name {
  margin: 0;
  font-size: var(--lnk-text-md);
  font-weight: 700;
  color: var(--neo-text-primary);
}
.membership-dialog .plan-sub {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 5px;
  margin: 6px 0 0;
  font-size: var(--lnk-text-xs);
  color: var(--neo-text-secondary);
}
.membership-dialog .plan-bolt {
  width: 13px;
  height: 13px;
  align-self: center;
  color: var(--neo-warm);
  flex-shrink: 0;
}
.membership-dialog .plan-sub b {
  font-size: var(--lnk-text-lg);
  font-weight: 700;
  color: var(--neo-warm);
  font-variant-numeric: tabular-nums;
}
.membership-dialog .plan-sub-tail {
  color: var(--neo-text-secondary);
}
.membership-dialog .divider {
  border: none;
  border-top: 1px solid var(--neo-border);
  margin: 12px 0;
}
.membership-dialog .rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
  flex: 1;
}
.membership-dialog .row {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: var(--lnk-text-xs);
  line-height: 1.5;
  color: var(--neo-text-primary);
}
.membership-dialog .row-icon {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  color: var(--neo-accent-text);
  flex-shrink: 0;
}
.membership-dialog .row-icon svg {
  width: 100%;
  height: 100%;
  display: block;
}
.membership-dialog .row-text {
  min-width: 0;
}
.membership-dialog .tag {
  flex-shrink: 0;
  font-size: var(--lnk-text-2xs);
  line-height: 1;
  padding: 3px 6px;
  border-radius: var(--lnk-radius-xs);
  margin-top: 1px;
}
.membership-dialog .tag-basic {
  color: var(--neo-accent-text);
  background: var(--neo-accent-soft);
}
.membership-dialog .tag-bonus {
  color: var(--neo-warm);
  background: var(--neo-warm-soft);
}

/* ---- 卡片底部价格 + CTA ---- */
.membership-dialog .plan-foot {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--neo-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-space-2);
  flex-wrap: wrap;
}
.membership-dialog .plan-price {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}
.membership-dialog .plan-price-num {
  font-size: var(--lnk-text-xl);
  font-weight: 700;
  color: var(--neo-text-primary);
  font-variant-numeric: tabular-nums;
}
.membership-dialog .plan-price-unit {
  font-size: var(--lnk-text-2xs);
  color: var(--neo-text-muted);
  white-space: nowrap;
}
.membership-dialog .plan-cta.el-button {
  flex-shrink: 0;
}
/* 推荐档 CTA：主色实心，视觉主次的最强音 */
.membership-dialog .plan-cta--primary.el-button {
  --el-button-bg-color: var(--neo-accent);
  --el-button-border-color: var(--neo-accent);
  --el-button-text-color: var(--lnk-text-on-accent);
  --el-button-hover-bg-color: var(--neo-accent-hover);
  --el-button-hover-border-color: var(--neo-accent-hover);
  --el-button-hover-text-color: var(--lnk-text-on-accent);
}
/* 其余可升级档 CTA：次级描边，不与推荐档抢焦点 */
.membership-dialog .plan-cta--ghost.el-button {
  --el-button-bg-color: transparent;
  --el-button-border-color: var(--neo-accent-border);
  --el-button-text-color: var(--neo-accent-text);
  --el-button-hover-bg-color: var(--neo-accent-soft);
  --el-button-hover-border-color: var(--neo-accent);
  --el-button-hover-text-color: var(--neo-accent-text);
}
.membership-dialog .plan-cta-current {
  flex-shrink: 0;
  font-size: var(--lnk-text-xs);
  font-weight: 600;
  color: var(--neo-accent-text);
}
.membership-dialog .plan-cta-lower {
  flex-shrink: 0;
  font-size: var(--lnk-text-xs);
  font-weight: 500;
  color: var(--neo-text-muted);
  white-space: nowrap;
}

.membership-dialog .msg {
  margin: 0;
  text-align: center;
  font-size: var(--lnk-text-xs);
  color: var(--neo-accent-text);
}
.membership-dialog .footnote {
  margin-top: 2px;
  text-align: center;
  font-size: var(--lnk-text-2xs);
  line-height: 1.9;
  color: var(--neo-text-muted);
}
.membership-dialog .footnote b {
  color: var(--neo-text-secondary);
  font-weight: 600;
}

/* ---- 支付视图 ---- */
.membership-dialog .back {
  align-self: flex-start;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font-size: var(--lnk-text-xs);
  color: var(--neo-text-secondary);
  transition: color var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.membership-dialog .back:hover {
  color: var(--neo-text-primary);
}
.membership-dialog .pay-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--lnk-space-3);
  padding: 14px 16px;
  border: 1px solid var(--neo-border);
  border-radius: var(--lnk-radius-lg);
  background: var(--neo-surface-elevated);
}
.membership-dialog .pay-head-name {
  font-size: var(--lnk-text-base);
  font-weight: 600;
  color: var(--neo-text-primary);
}
.membership-dialog .pay-head-sub {
  margin-left: 10px;
  font-size: var(--lnk-text-2xs);
  font-weight: 400;
  color: var(--neo-text-muted);
}
.membership-dialog .pay-head-price {
  font-size: var(--lnk-text-2xl);
  font-weight: 700;
  color: var(--neo-text-primary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.membership-dialog .pay-head-unit {
  font-size: var(--lnk-text-xs);
  font-weight: 400;
  color: var(--neo-text-muted);
}
.membership-dialog .agree {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: var(--lnk-text-2xs);
  line-height: 1.6;
  color: var(--neo-text-muted);
}
.membership-dialog .agree-dot {
  width: 14px;
  height: 14px;
  margin-top: 1px;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-success);
  color: var(--lnk-text-on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.membership-dialog .agree-dot svg {
  width: 9px;
  height: 9px;
  display: block;
}
.membership-dialog .login-hint {
  padding: 40px 0;
  text-align: center;
  color: var(--neo-text-muted);
}
</style>
