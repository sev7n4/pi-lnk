<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { paymentApi, type PayOrderStatus } from '@/services/payment-api'
import { useQrDataUrl } from '@/composables/useQrDataUrl'

/**
 * 扫码支付面板（真实支付宝）：二维码 + 订单要素 + 轮询。
 * PAID 后 emit('paid')；组件只在 qrCode 存在时轮询，关闭/卸载即停。
 */
const props = defineProps<{
  orderId: string
  qrCode: string
  amountFen: number
  /** 汇总行展示（按订单类型传入：积分总数 / 套餐名等）。 */
  summaryRows?: Array<{ label: string; value: string }>
  expiryText?: string
}>()

const emit = defineEmits<{ paid: []; failed: [reason: string] }>()

const status = ref<PayOrderStatus['status']>('PENDING')
const polling = ref(true)
const qrDataUrl = useQrDataUrl(computed(() => props.qrCode))

const priceText = computed(() => `¥${(props.amountFen / 100).toFixed(2).replace(/\.00$/, '')}`)

let timer: ReturnType<typeof setInterval> | null = null

function stopPolling() {
  polling.value = false
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

async function pollOnce() {
  try {
    const { data } = await paymentApi.getOrder(props.orderId)
    status.value = data.data.status
    if (data.data.status === 'PAID') {
      stopPolling()
      emit('paid')
    } else if (data.data.status === 'CLOSED' || data.data.status === 'REFUNDED') {
      stopPolling()
      emit('failed', data.data.status)
    }
  } catch {
    // 网络抖动：静默重试，不打断扫码流程
  }
}

watch(
  () => props.orderId,
  () => {
    stopPolling()
    polling.value = true
    status.value = 'PENDING'
    void pollOnce()
    timer = setInterval(() => void pollOnce(), 3000)
  },
  { immediate: true },
)

onBeforeUnmount(stopPolling)

defineExpose({ stopPolling })
</script>

<template>
  <div class="qr-pay-panel rounded-xl p-4">
    <div class="flex items-start gap-4">
      <!-- 二维码 -->
      <div class="qr-box flex h-36 w-36 shrink-0 items-center justify-center rounded-lg">
        <img v-if="qrDataUrl" :src="qrDataUrl" alt="支付宝收款二维码" class="h-32 w-32">
        <span v-else class="text-xs text-fg-2">二维码生成中…</span>
      </div>

      <!-- 订单要素 -->
      <div class="min-w-0 flex-1">
        <dl class="space-y-1.5 text-xs">
          <div v-for="row in summaryRows ?? []" :key="row.label" class="flex items-center justify-between gap-3">
            <dt class="text-fg-2">{{ row.label }}</dt>
            <dd class="truncate text-fg">{{ row.value }}</dd>
          </div>
          <div v-if="expiryText" class="flex items-center justify-between gap-3">
            <dt class="text-fg-2">有效期至</dt>
            <dd class="text-fg">{{ expiryText }}</dd>
          </div>
        </dl>
        <div class="mt-2.5 flex items-baseline justify-between">
          <span class="text-[11px] text-fg-2">使用支付宝扫码支付</span>
          <span class="text-lg font-semibold text-fg">{{ priceText }}</span>
        </div>
      </div>
    </div>

    <p v-if="status === 'PAID'" class="mt-3 rounded-lg px-3 py-2 text-center text-xs paid-hint">
      支付成功，积分已到账
    </p>
    <p v-else-if="polling" class="mt-3 text-center text-[11px] text-fg-2">
      完成支付后本页面会自动确认，无需刷新
    </p>
  </div>
</template>

<style scoped>
/* 令牌纪律（2026-10-19）：已迁到 --lnk-* 语义令牌。 */
.qr-pay-panel {
  background: var(--lnk-surface-raised);
  border: 1px solid var(--lnk-border-subtle);
}
/* ⛔ 二维码 quiet zone 规范要求浅色底，深色主题下也必须保持白底——
   这不是漏迁移的硬编码白，换成任何深色底都会直接扫不出。 */
.qr-box {
  background: #fff;
}
.paid-hint {
  color: var(--lnk-accent-text);
  background: var(--lnk-accent-subtle);
}
</style>
