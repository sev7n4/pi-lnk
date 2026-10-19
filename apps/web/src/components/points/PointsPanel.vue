<script setup lang="ts">
/**
 * 我的积分（双端共享面板 · PC 路由页与移动端 pane 共用同一份实现）
 *
 * 设计来源：移动端「我的积分」页截图（卡片形态与话术照抄）。
 * 核心数字口径（**刻意用 getPoints().points**，不是 points-breakdown 合计）：
 * User.points 是扣减链路的单一权威余额；breakdown.totalAvailable 是账本按池聚合且
 * 会扣除过期部分，两个数字并存会让用户看到「余额 X ≠ 池合计 Y」的困惑。
 * 池明细只作为下方解释性信息出现。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { membershipApi, type PointsBreakdown } from '@/services/users-api'
import { useAuthStore } from '@/stores/auth'

const emit = defineEmits<{ 'open-usage': []; 'open-topup': [] }>()

const auth = useAuthStore()
const points = ref(0)
/// 今日每日签到是否已领取（卡片右上角领用区的终态）。
const claimedToday = ref(false)
const claiming = ref(false)
const monthlyUsed = ref(0)
const breakdown = ref<PointsBreakdown | null>(null)
const loading = ref(false)

const usedRatio = computed(() => {
  const total = points.value + monthlyUsed.value
  if (total <= 0) return 0
  return Math.min(100, Math.round((monthlyUsed.value / total) * 100))
})

const POOL_LABELS: Record<string, string> = {
  purchased: '购买获得',
  granted: '赠送获得',
  subscription: '订阅赠送',
}

const pools = computed(() => {
  const p = breakdown.value?.pools
  if (!p) return []
  return (Object.keys(p) as Array<keyof typeof p>)
    .map((k) => ({ key: k, label: POOL_LABELS[k] ?? k, ...p[k] }))
    .filter((row) => row.total !== 0 || row.available !== 0 || row.expired !== 0)
})

async function load() {
  loading.value = true
  try {
    const [pRes, bRes, sRes] = await Promise.all([
      membershipApi.getPoints(),
      membershipApi.pointsBreakdown(),
      membershipApi.pointsSummary('month'),
    ])
    points.value = pRes.data.data.points
    claimedToday.value = pRes.data.data.claimedToday
    breakdown.value = bRes.data.data
    monthlyUsed.value = sRes.data.data.insights?.netConsumedTotal ?? 0
  } catch {
    // 读失败保持既有值，不清零（避免闪一下 0 积分）
  } finally {
    loading.value = false
  }
}

async function claimDaily() {
  if (claiming.value || claimedToday.value) return
  claiming.value = true
  try {
    const { data } = await membershipApi.claimDaily()
    points.value = data.data.points
    auth.setPoints(data.data.points)
    claimedToday.value = true
    ElMessage.success(`已领取 +${data.data.added} 积分`)
  } catch {
    claimedToday.value = true
    ElMessage.info('今日已领取')
  } finally {
    claiming.value = false
  }
}

onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <div class="pt-panel">
    <div class="pt-card">
      <!-- 卡片右上角：积分余额 + 每日签到领用（自套餐页迁来，一个信息只出现一处） -->
      <div class="pt-card-top">
        <div class="pt-balance">
          <p class="pt-label">可用积分</p>
          <p class="pt-value">{{ points.toLocaleString() }}</p>
        </div>
        <button
          type="button"
          class="pt-claim"
          :class="{ 'is-claimed': claimedToday }"
          :disabled="claiming || claimedToday"
          @click="claimDaily"
        >
          {{ claimedToday ? '今日已领取' : claiming ? '领取中…' : '领取 +100' }}
        </button>
      </div>
      <div class="pt-bar" role="img" aria-label="本月已用与当前可用积分占比">
        <div class="pt-bar-used" :style="{ width: `${usedRatio}%` }" />
      </div>
      <div class="pt-bar-legend">
        <span>本月已用 {{ monthlyUsed.toLocaleString() }}</span>
        <span>可用 {{ points.toLocaleString() }}</span>
      </div>

      <div class="pt-actions">
        <!-- 明细：复用 PC 用量页同一个 UsagePanel（用户裁决：不另造轮子） -->
        <button type="button" class="pt-btn" @click="emit('open-usage')">明细</button>
        <button type="button" class="pt-btn pt-btn--primary" @click="emit('open-topup')">充值</button>
      </div>
    </div>

    <section v-if="pools.length" class="pt-block">
      <h3 class="pt-block-title">积分构成</h3>
      <div v-for="row in pools" :key="row.key" class="pt-row">
        <span class="pt-row-label">{{ row.label }}</span>
        <span class="pt-row-value">
          {{ row.available.toLocaleString() }}
          <em v-if="row.expired > 0" class="pt-row-expired">（已过期 {{ row.expired.toLocaleString() }}）</em>
        </span>
      </div>
      <p v-if="breakdown?.expiredTotal" class="pt-note">
        已过期积分不计入可用余额，账本仍保留用于对账。
      </p>
    </section>

    <p v-if="loading" class="pt-loading">加载中…</p>
  </div>
</template>

<style scoped>
.pt-panel {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-4);
}
.pt-card {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-3);
  padding: var(--lnk-pad-card);
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-xl);
  background: var(--lnk-surface-raised);
}
.pt-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--lnk-space-3);
  flex-wrap: wrap;
}
.pt-balance {
  min-width: 0;
}
.pt-claim {
  flex-shrink: 0;
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-elevated);
  padding: 6px 14px;
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-secondary);
  cursor: pointer;
  white-space: nowrap;
}
.pt-claim.is-claimed {
  color: var(--lnk-success);
  background: var(--lnk-success-bg);
  border-color: var(--lnk-success-border);
  cursor: default;
}
.pt-label {
  margin: 0;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-secondary);
}
/* 积分专用语义色 --lnk-credit（勿用 --lnk-energy，后者仅用于连线/能量流动） */
.pt-value {
  margin: 0;
  font-size: var(--lnk-text-4xl);
  font-weight: 700;
  line-height: 1.1;
  color: var(--lnk-credit);
  font-variant-numeric: tabular-nums;
}
.pt-bar {
  height: 8px;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-sunken);
  overflow: hidden;
}
.pt-bar-used {
  height: 100%;
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-accent);
  transition: width var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.pt-bar-legend {
  display: flex;
  justify-content: space-between;
  gap: var(--lnk-space-2);
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-muted);
}
.pt-actions {
  display: flex;
  gap: var(--lnk-space-2);
}
.pt-btn {
  border: 1px solid var(--lnk-border-default);
  border-radius: var(--lnk-radius-full);
  background: var(--lnk-surface-elevated);
  padding: 8px 20px;
  font-size: var(--lnk-text-sm);
  color: var(--lnk-text-primary);
  cursor: pointer;
}
.pt-btn--primary {
  color: var(--lnk-text-on-accent);
  background: var(--lnk-accent);
  border-color: var(--lnk-accent);
}
.pt-block {
  padding: var(--lnk-pad-card);
  border: 1px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-xl);
  background: var(--lnk-surface-base);
}
.pt-block-title {
  margin: 0 0 var(--lnk-space-3);
  font-size: var(--lnk-text-sm);
  font-weight: 600;
  color: var(--lnk-text-primary);
}
.pt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--lnk-space-3);
  padding: var(--lnk-space-2) 0;
  font-size: var(--lnk-text-sm);
}
.pt-row-label {
  color: var(--lnk-text-secondary);
}
.pt-row-value {
  color: var(--lnk-text-primary);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.pt-row-expired {
  font-style: normal;
  font-size: var(--lnk-text-2xs);
  font-weight: 400;
  color: var(--lnk-text-muted);
}
.pt-note {
  margin: var(--lnk-space-2) 0 0;
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-muted);
}
.pt-loading {
  margin: 0;
  font-size: var(--lnk-text-2xs);
  color: var(--lnk-text-muted);
}
</style>
