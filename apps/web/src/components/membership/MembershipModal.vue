<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { membershipApi, type MembershipPlan } from '@/services/users-api'
import { paymentApi } from '@/services/payment-api'
import { useAuthStore } from '@/stores/auth'
import QrPayPanel from './QrPayPanel.vue'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const auth = useAuthStore()
const plans = ref<MembershipPlan[]>([])
const points = ref(0)
const membership = ref('free')
const loading = ref(false)
const message = ref('')

/** select=套餐列表 · pay=扫码支付 */
const view = ref<'select' | 'pay'>('select')
const payPlan = ref<MembershipPlan | null>(null)
const payOrderId = ref('')
const payQrCode = ref('')

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
    message.value = '领取失败'
  } finally {
    loading.value = false
  }
}

/**
 * 升级 = 真实支付下单（支付宝扫码）。入账以异步回调为准；
 * PAID 后刷新积分与会员档位（服务端 settlePaidOrder 已完成发放）。
 */
async function startPlanPay(plan: MembershipPlan) {
  if (loading.value) return
  loading.value = true
  message.value = ''
  try {
    const { data } = await paymentApi.createSubscriptionOrder(plan.id, 'qrcode')
    payPlan.value = plan
    payOrderId.value = data.data.orderId
    payQrCode.value = data.data.qrCode ?? ''
    view.value = 'pay'
  } catch {
    message.value = '下单失败，请稍后重试'
  } finally {
    loading.value = false
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
  message.value = '升级成功，权益已生效'
}

function onPlanPayFailed(reason: string) {
  view.value = 'select'
  message.value = reason === 'CLOSED' ? '订单已关闭，请重新发起' : '订单异常，请联系支持'
}
</script>

<template>
  <!-- append-to-body: escape canvas chrome pointer-events-none / z-50 stacking -->
  <el-dialog
    v-model="visible"
    title="积分与会员"
    width="560px"
    class="membership-dialog"
    append-to-body
    align-center
  >
    <div v-if="auth.isLoggedIn" class="space-y-4">
      <!-- 套餐扫码支付视图 -->
      <template v-if="view === 'pay' && payPlan">
        <button type="button" class="text-xs text-fg-2 transition hover:text-fg" @click="view = 'select'">
          ‹ 返回套餐列表
        </button>
        <QrPayPanel
          :order-id="payOrderId"
          :qr-code="payQrCode"
          :amount-fen="payPlan.price * 100"
          :summary-rows="[
            { label: '套餐', value: payPlan.name },
            { label: '到账积分', value: payPlan.points.toLocaleString() },
          ]"
          @paid="onPlanPaid"
          @failed="onPlanPayFailed"
        />
      </template>

      <!-- 套餐列表视图 -->
      <template v-else>
        <!-- 积分总览：品牌渐变能量卡 -->
        <div class="membership-hero relative overflow-hidden rounded-xl p-4">
          <p class="text-xs text-fg-2">当前积分</p>
          <p class="mt-0.5 flex items-baseline gap-1.5 text-3xl font-semibold text-fg">
            <svg class="h-5 w-5 self-center text-[var(--neo-warm)]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 2 4.5 13.5h5.6L11 22l8.5-11.5h-5.6L13 2z" />
            </svg>
            {{ points }}
          </p>
          <p class="mt-1 text-xs text-fg-2">
            会员：{{ membership === 'pro' ? '专业版' : membership === 'studio' ? '工作室版' : '免费版' }}
          </p>
          <el-button class="membership-claim-btn mt-3" size="small" :loading="loading" @click="claimDaily">
            领取每日积分 (+100)
          </el-button>
        </div>

        <div class="grid gap-3 sm:grid-cols-3">
          <div
            v-for="plan in plans"
            :key="plan.id"
            class="membership-plan rounded-xl border p-4"
            :class="membership === plan.id ? 'is-current' : ''"
          >
            <h3 class="font-medium" style="color: var(--neo-text-primary)">{{ plan.name }}</h3>
            <p class="mt-1 text-lg" style="color: var(--neo-text-primary)">{{ plan.price ? `¥${plan.price}/月` : '免费' }}</p>
            <ul class="mt-2 space-y-1 text-[11px]" style="color: var(--neo-text-muted)">
              <li v-for="f in plan.features" :key="f">· {{ f }}</li>
            </ul>
            <el-button
              v-if="plan.id !== 'free' && membership !== plan.id"
              class="mt-3 w-full"
              size="small"
              type="primary"
              :loading="loading"
              @click="startPlanPay(plan)"
            >
              支付宝扫码升级
            </el-button>
          </div>
        </div>
        <p v-if="message" class="text-sm" style="color: var(--neo-accent-text)">{{ message }}</p>
      </template>
    </div>
    <p v-else class="py-8 text-center" style="color: var(--neo-text-muted)">请先登录</p>
  </el-dialog>
</template>

<style>
.membership-dialog .el-dialog {
  background: var(--neo-surface-card);
  border: 1px solid var(--neo-border);
  border-radius: 16px;
}
.membership-dialog .el-dialog__title {
  color: var(--neo-text-primary);
}
.membership-hero {
  background: var(--neo-brand-gradient);
  box-shadow: 0 8px 24px rgba(109, 93, 252, 0.28);
}
.membership-hero::after {
  content: '';
  position: absolute;
  top: -40px;
  right: -20px;
  width: 140px;
  height: 140px;
  border-radius: 50%;
  background: radial-gradient(circle, rgb(var(--lnk-overlay-rgb) / 0.22), transparent 70%);
  pointer-events: none;
}
.membership-claim-btn {
  --el-button-bg-color: rgba(255, 255, 255, 0.16);
  --el-button-border-color: rgba(255, 255, 255, 0.3);
  --el-button-text-color: #fff;
  --el-button-hover-bg-color: rgba(255, 255, 255, 0.26);
  --el-button-hover-border-color: rgba(255, 255, 255, 0.4);
  --el-button-hover-text-color: #fff;
}
.membership-plan {
  border-color: var(--neo-border);
  background: var(--neo-surface-elevated);
}
.membership-plan.is-current {
  border-color: var(--neo-accent-border);
  background: var(--neo-accent-soft);
}
.membership-dialog .el-button--primary {
  --el-button-bg-color: var(--neo-accent);
  --el-button-border-color: var(--neo-accent);
  --el-button-hover-bg-color: var(--neo-accent-hover);
  --el-button-hover-border-color: var(--neo-accent-hover);
}
</style>
