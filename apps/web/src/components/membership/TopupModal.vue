<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { paymentApi, type TopupOptions, type TopupTier } from '@/services/payment-api'
import { membershipApi } from '@/services/users-api'
import { useAuthStore } from '@/stores/auth'
import QrPayPanel from './QrPayPanel.vue'

/**
 * 购买积分弹窗（积分充值）：6 档瓦片（5 固定档 + 自定义）→ 支付宝扫码支付。
 * 档位/赠送/有效期全部来自服务端 options（单一真源），前端不做业务硬编码。
 */
const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const auth = useAuthStore()

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})

const options = ref<TopupOptions | null>(null)
const points = ref(0)
const membership = ref('free')
const loading = ref(false)
const message = ref('')

/** select=选档 · pay=扫码支付 */
const view = ref<'select' | 'pay'>('select')
const customYuan = ref<string>('')
const payOrderId = ref('')
const payQrCode = ref('')
const payAmountFen = ref(0)
const payTotalPoints = ref(0)

/** 自定义档位固定占最后一位（第 6 块瓦片）。 */
const CUSTOM_SLOT = 'custom'
const selectedSlot = ref<string | null>(null)

const TIER_TAGS: Record<number, string> = {
  1000: '灵活补充',
  2000: '轻度使用',
  3000: '日常加量',
  5000: '高频使用',
  10000: '重度使用',
}

const membershipLabel = computed(() =>
  membership.value === 'pro' ? '专业版' : membership.value === 'studio' ? '工作室版' : '免费版',
)

/** 自定义金额（元）→ 分；非法输入返回 null。 */
const customFen = computed<number | null>(() => {
  if (selectedSlot.value !== CUSTOM_SLOT) return null
  const n = Number(customYuan.value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100)
})

const customValid = computed(() => {
  if (customFen.value === null || !options.value) return false
  return (
    customFen.value >= options.value.customMinFen && customFen.value <= options.value.customMaxFen
  )
})

/** 当前生效的充值分/金额（档位或自定义）。 */
const effectiveFen = computed<number | null>(() => {
  if (selectedSlot.value === null) return null
  if (selectedSlot.value === CUSTOM_SLOT) return customValid.value ? customFen.value : null
  const n = Number(selectedSlot.value)
  return Number.isFinite(n) ? n : null
})

const effectivePoints = computed(() => {
  if (effectiveFen.value === null || !options.value) return 0
  const tier = options.value.tiers.find((t) => t.amountFen === effectiveFen.value)
  return tier ? tier.totalPoints : effectiveFen.value * options.value.pointsPerFen
})

const priceText = computed(() => {
  if (effectiveFen.value === null) return '—'
  return `¥${(effectiveFen.value / 100).toFixed(2).replace(/\.00$/, '')}`
})

const expiryDateText = computed(() => {
  if (!options.value) return ''
  const d = new Date(Date.now() + options.value.expiryDays * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
})

function tierTag(tier: TopupTier) {
  return TIER_TAGS[tier.amountFen] ?? '积分充值'
}

function selectSlot(slot: string) {
  selectedSlot.value = slot
  message.value = ''
}

async function loadData() {
  if (!auth.isLoggedIn) return
  const [optionsRes, pointsRes] = await Promise.all([
    paymentApi.topupOptions(),
    membershipApi.getPoints(),
  ])
  options.value = optionsRes.data.data
  points.value = pointsRes.data.data.points
  membership.value = pointsRes.data.data.membership
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      view.value = 'select'
      selectedSlot.value = null
      customYuan.value = ''
      payOrderId.value = ''
      payQrCode.value = ''
      message.value = ''
      void loadData()
    }
  },
  { immediate: true },
)

async function startPay() {
  if (effectiveFen.value === null || loading.value) return
  loading.value = true
  message.value = ''
  try {
    const { data } = await paymentApi.createTopup(effectiveFen.value, 'qrcode')
    payOrderId.value = data.data.orderId
    payQrCode.value = data.data.qrCode ?? ''
    payAmountFen.value = data.data.amountFen
    payTotalPoints.value = effectivePoints.value
    view.value = 'pay'
  } catch (err) {
    message.value = (err as { response?: { data?: { message?: string } } }).response?.data?.message ?? '下单失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

async function onPaid() {
  // 入账以服务端为准：刷新积分回写全局 store
  try {
    const { data } = await membershipApi.getPoints()
    points.value = data.data.points
    auth.setPoints(data.data.points)
  } catch {
    // 刷新失败不阻塞成功提示
  }
  view.value = 'select'
  selectedSlot.value = null
  message.value = '充值成功，积分已到账'
}

function onPayFailed(reason: string) {
  message.value = reason === 'CLOSED' ? '订单已关闭，请重新发起' : '订单异常，请联系支持'
  view.value = 'select'
}
</script>

<template>
  <!-- append-to-body: escape canvas chrome pointer-events-none / z-50 stacking -->
  <el-dialog
    v-model="visible"
    width="640px"
    class="topup-dialog"
    append-to-body
    align-center
    :show-close="true"
  >
    <template #header>
      <div class="flex items-center gap-2 pr-6 text-base font-medium text-fg">
        <span>购买积分</span>
        <span class="text-xs font-normal text-fg-2">
          当前套餐 {{ membershipLabel }} ｜ 剩余积分 {{ points.toLocaleString() }}
        </span>
      </div>
    </template>

    <div v-if="!auth.isLoggedIn" class="py-8 text-center text-sm text-fg-2">请先登录</div>

    <!-- 选档视图 -->
    <div v-else-if="view === 'select'" class="space-y-3">
      <div v-if="options" class="grid grid-cols-2 gap-3">
        <button
          v-for="tier in options.tiers"
          :key="tier.amountFen"
          type="button"
          class="topup-tile rounded-xl border p-4 text-left transition"
          :class="selectedSlot === String(tier.amountFen) ? 'is-selected' : ''"
          @click="selectSlot(String(tier.amountFen))"
        >
          <p class="flex items-baseline gap-1 text-xl font-semibold text-fg">
            <svg class="h-4 w-4 self-center text-[var(--neo-warm)]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 2 4.5 13.5h5.6L11 22l8.5-11.5h-5.6L13 2z" />
            </svg>
            {{ tier.totalPoints.toLocaleString() }}
          </p>
          <p class="mt-1 text-sm text-fg-2">¥{{ tier.amountFen / 100 }}</p>
          <p class="mt-0.5 text-[11px] text-fg-2">
            {{ tier.bonusPoints > 0 ? `含赠送 +${tier.bonusPoints.toLocaleString()} · ` : '' }}{{ tierTag(tier) }}
          </p>
        </button>

        <!-- 自定义档位（第 6 块瓦片） -->
        <div
          class="topup-tile rounded-xl border p-4 transition"
          :class="selectedSlot === CUSTOM_SLOT ? 'is-selected' : ''"
          @click="selectSlot(CUSTOM_SLOT)"
        >
          <p class="text-xl font-semibold text-fg">自定义</p>
          <div class="mt-1.5 flex items-center gap-1.5" @click.stop>
            <span class="text-sm text-fg-2">¥</span>
            <input
              v-model="customYuan"
              type="number"
              inputmode="decimal"
              min="5"
              max="10000"
              step="1"
              placeholder="≥5"
              class="custom-input w-24 rounded-lg border px-2 py-1 text-sm text-fg"
              @focus="selectSlot(CUSTOM_SLOT)"
            >
            <span class="text-[11px] text-fg-2">（¥5 起）</span>
          </div>
          <p class="mt-0.5 text-[11px] text-fg-2">
            {{ customValid ? `到账 ${(customFen! * (options?.pointsPerFen ?? 1)).toLocaleString()} 积分` : '100 积分/元' }}
          </p>
        </div>
      </div>
      <p v-else class="py-6 text-center text-xs text-fg-2">档位加载中…</p>

      <p class="flex items-center gap-1 text-[11px] text-fg-2">
        <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4M12 16h.01" stroke-linecap="round" />
        </svg>
        充值积分{{ options ? `自到账起 ${options.expiryDays} 天内有效` : '有效期以支付页为准' }}，到账后不可退款。
      </p>

      <button
        type="button"
        class="topup-pay-btn w-full rounded-xl py-2.5 text-sm font-medium transition"
        :disabled="effectiveFen === null || loading"
        @click="startPay"
      >
        {{ loading ? '下单中…' : effectiveFen === null ? '请先选择充值档位' : `支付宝扫码支付 ${priceText}` }}
      </button>
      <p v-if="message" class="text-center text-xs paid-hint rounded-lg px-3 py-2">{{ message }}</p>
    </div>

    <!-- 扫码支付视图 -->
    <div v-else class="space-y-3">
      <button type="button" class="text-xs text-fg-2 transition hover:text-fg" @click="view = 'select'">
        ‹ 返回选择档位
      </button>
      <QrPayPanel
        :order-id="payOrderId"
        :qr-code="payQrCode"
        :amount-fen="payAmountFen"
        :summary-rows="[
          { label: '积分总数', value: payTotalPoints.toLocaleString() },
        ]"
        :expiry-text="expiryDateText ? `${expiryDateText}（到期不自动续购）` : undefined"
        @paid="onPaid"
        @failed="onPayFailed"
      />
    </div>
  </el-dialog>
</template>

<style>
.topup-dialog .el-dialog {
  background: var(--neo-surface-card);
  border: 1px solid var(--neo-border);
  border-radius: 16px;
}
.topup-dialog .el-dialog__title {
  color: var(--neo-text-primary);
}
.topup-tile {
  border-color: var(--neo-border);
  background: var(--neo-surface-elevated);
  cursor: pointer;
}
.topup-tile:hover {
  border-color: var(--neo-accent-border);
}
.topup-tile.is-selected {
  border-color: var(--neo-accent-border);
  background: var(--neo-accent-soft);
  box-shadow: 0 0 0 1px var(--neo-accent-border);
}
.topup-pay-btn {
  background: var(--neo-accent);
  color: var(--neo-accent-text);
}
.topup-pay-btn:hover:not(:disabled) {
  background: var(--neo-accent-hover);
}
.topup-pay-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.custom-input {
  background: var(--neo-surface-elevated);
  border-color: var(--neo-border);
}
.custom-input:focus {
  outline: none;
  border-color: var(--neo-accent-border);
}
.paid-hint {
  color: var(--neo-accent-text);
  background: var(--neo-accent-soft);
}
</style>
