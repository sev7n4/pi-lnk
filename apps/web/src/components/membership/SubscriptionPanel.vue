<script setup lang="ts">
/**
 * 我的订阅（双端共享面板 · PC 路由页与移动端 pane 共用同一份实现）
 *
 * 设计来源：移动端「我的订阅」页截图（卡片形态与话术照抄，按要求去掉客服电话）。
 * 只负责内容与数据；导航壳（返回/路由）由外层负责，故通过 emit 抛「打开套餐页」。
 *
 * 三态（与后端 Subscription 语义严格对齐，禁止 UI 自造状态）：
 *   - 未订阅（无订阅行）：显示「未开通套餐」+ 点击订阅方案 → 打开套餐页
 *   - 生效中：套餐名 + 生效中 + 订阅方案 + 到期时间 + 取消自动续期
 *   - 已取消续期：仍可用到到期日，按钮变为「重新开通自动续费」/ 到期提示
 *
 * ⚠️ 取消自动续期 ≠ 立即退订：当前周期内继续可用，到期才失效。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { membershipApi, type SubscriptionDto } from '@/services/users-api'
import { paymentApi } from '@/services/payment-api'

const emit = defineEmits<{ 'open-plans': [] }>()

const sub = ref<SubscriptionDto | null>(null)
const capabilitySupported = ref(false)
const loading = ref(false)
const cancelling = ref(false)

/// 生效中（active）或已取消续期但未到期的都算「当前持有可用」
const usable = computed(() => sub.value !== null && sub.value.status !== 'expired')
const autoRenewStopped = computed(() => sub.value?.cancelAtPeriodEnd === true)

function formatDate(iso: string): string {
  // 东八区日历日口径（与后端 clampAlipayExecuteDate 保持一致）
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

async function load() {
  loading.value = true
  try {
    const [subRes, capRes] = await Promise.all([
      membershipApi.getSubscription(),
      paymentApi.autoRenewCapability(),
    ])
    sub.value = subRes.data.data
    capabilitySupported.value = capRes.data.data.supported
  } catch {
    sub.value = null
  } finally {
    loading.value = false
  }
}

async function cancelAutoRenew() {
  if (!sub.value || cancelling.value) return
  try {
    await ElMessageBox.confirm(
      `取消后本周期内（至 ${formatDate(sub.value.periodEnd)}）仍可正常使用 ${sub.value.planName}，到期后不再自动续费。`,
      '确认取消自动续费？',
      { confirmButtonText: '确认取消', cancelButtonText: '再想想', type: 'warning' },
    )
  } catch {
    return
  }
  cancelling.value = true
  try {
    await paymentApi.cancelAutoRenew()
    ElMessage.success('已取消自动续费，当前套餐可使用至到期')
    await load()
  } catch (err) {
    // 渠道解约失败时服务端不会改本地状态——如实告知，不谎称已取消
    const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
    ElMessage.error(msg ?? '取消失败，请稍后重试')
  } finally {
    cancelling.value = false
  }
}

onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <div class="sub-panel">
    <div v-if="loading && !sub" class="sub-skeleton">加载中…</div>

    <template v-else-if="usable && sub">
      <div class="sub-card">
        <div class="sub-card-head">
          <div class="sub-plan">
            <span class="sub-plan-name">{{ sub.planName }}</span>
            <span class="sub-status" :class="autoRenewStopped ? 'is-stopped' : 'is-active'">
              {{ autoRenewStopped ? '已取消续费' : '生效中' }}
            </span>
          </div>
          <p v-if="autoRenewStopped" class="sub-hint">
            当前套餐可使用至 {{ formatDate(sub.periodEnd) }}，到期后不再续费
          </p>
        </div>

        <dl class="sub-rows">
          <div class="sub-row">
            <dt>订阅方案</dt>
            <dd>连续包月</dd>
          </div>
          <div class="sub-row">
            <dt>到期时间</dt>
            <dd>{{ formatDate(sub.periodEnd) }}</dd>
          </div>
          <div class="sub-row">
            <dt>自动续费</dt>
            <dd>{{ autoRenewStopped ? '已关闭' : sub.agreementBound ? '已签约' : '未签约（手动续期）' }}</dd>
          </div>
        </dl>

        <div class="sub-actions">
          <button type="button" class="sub-btn sub-btn--primary" @click="emit('open-plans')">
            查看所有方案
          </button>
          <button
            v-if="!autoRenewStopped"
            type="button"
            class="sub-btn"
            :disabled="cancelling"
            @click="cancelAutoRenew"
          >
            {{ cancelling ? '取消中…' : '取消自动续费' }}
          </button>
        </div>
      </div>
    </template>

    <div v-else class="sub-card">
      <p class="sub-empty">未开通套餐</p>
      <button type="button" class="sub-btn sub-btn--primary" @click="emit('open-plans')">
        点击订阅方案
      </button>
    </div>

    <section class="sub-block">
      <h3 class="sub-block-title">支付方式</h3>
      <div class="sub-row">
        <dt>当前支付方式</dt>
        <dd>支付宝</dd>
      </div>
    </section>

    <p class="sub-disclaimer">
      订阅成功后本平台即视为用户已阅读并同意《π 个人会员订阅服务协议（含自动续费服务规则）》；
      取消自动续费后当前周期权益不受影响，到期后不再自动扣款。
    </p>
  </div>
</template>

<style scoped>
.sub-panel {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-4);
}
.sub-card {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-3);
  padding: var(--lnk-pad-card);
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-xl);
  background: var(--lnk-surface-raised);
}
.sub-card-head {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-2);
}
.sub-plan {
  display: flex;
  align-items: center;
  gap: var(--lnk-space-2);
}
.sub-plan-name {
  font-size: var(--lnk-text-xl);
  font-weight: 700;
  color: var(--lnk-text-primary);
}
.sub-status {
  font-size: var(--lnk-text-2xs);
  padding: 2px 8px;
  border-radius: var(--lnk-radius-full);
}
.sub-status.is-active {
  color: var(--lnk-success);
  background: var(--lnk-success-bg);
  border: 1px solid var(--lnk-success-border);
}
.sub-status.is-stopped {
  color: var(--lnk-text-secondary);
  background: var(--lnk-surface-sunken);
  border: 1px solid var(--lnk-border-default);
}
.sub-hint {
  margin: 0;
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-muted);
}
.sub-rows {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-2);
  margin: 0;
}
.sub-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-space-3);
  font-size: var(--lnk-text-sm);
}
.sub-row dt {
  color: var(--lnk-text-secondary);
}
.sub-row dd {
  margin: 0;
  color: var(--lnk-text-primary);
  font-weight: 600;
}
.sub-actions {
  display: flex;
  gap: var(--lnk-space-2);
  flex-wrap: wrap;
}
.sub-btn {
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-elevated);
  padding: 8px 18px;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-primary);
  cursor: pointer;
  transition: border-color var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.sub-btn:disabled {
  color: var(--lnk-text-disabled);
  cursor: default;
}
.sub-btn--primary {
  color: var(--lnk-text-on-accent);
  background: var(--lnk-accent);
  border-color: var(--lnk-accent);
}
.sub-empty {
  margin: 0;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-secondary);
}
.sub-skeleton {
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-muted);
}
.sub-block {
  padding: var(--lnk-pad-card);
  border: 1px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-xl);
  background: var(--lnk-surface-base);
}
.sub-block-title {
  margin: 0 0 var(--lnk-space-2);
  font-size: var(--lnk-text-sm);
  font-weight: 600;
  color: var(--lnk-text-primary);
}
.sub-disclaimer {
  margin: 0;
  font-size: var(--lnk-text-2xs);
  line-height: 1.8;
  color: var(--lnk-text-muted);
}
</style>
