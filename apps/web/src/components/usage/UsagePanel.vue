<script setup lang="ts">
/**
 * 用量面板（PC 个人中心「用量」页 与 移动端「明细」共用同一份）
 *
 * 2026-10-19 用户裁决：移动端积分页的「明细」不要另造一套，直接复用 PC 用量页，
 * 只补窄屏响应式。因此把原先写在 ProfilePage 里的取数 + 四个用量组件整体搬到这里，
 * ProfilePage 与移动端 pane 都渲染它——**数据口径只有一处**。
 *
 * 响应式要点（PC 宽屏无感、移动端必需）：
 *   - 热力图 53 周固定宽 ⇒ 窄屏横向滚动而不是被压扁到看不清
 *   - 日粒度表列多 ⇒ 窄屏横向滚动并保留首列
 */
import { computed, onMounted, ref, watch } from 'vue'
import UsageDayTable from '@/components/usage/UsageDayTable.vue'
import UsageHeatmap from '@/components/usage/UsageHeatmap.vue'
import UsageOverviewCards from '@/components/usage/UsageOverviewCards.vue'
import UsageTrend from '@/components/usage/UsageTrend.vue'
import { membershipApi, type UsageDaysResponse, type UsageOverviewResponse, type UsageTrendRangeKey } from '@/services/users-api'

const usage = ref<UsageOverviewResponse | null>(null)
const usageDays = ref<UsageDaysResponse | null>(null)
const usageAllDays = ref<UsageDaysResponse | null>(null)
const usageRange = ref<UsageTrendRangeKey>('7d')
const usageError = ref('')
const daysError = ref('')
const allDaysError = ref('')
const usageLoading = ref(false)
const daysLoading = ref(false)
const allDaysLoading = ref(false)

/** 过期响应丢弃：range 快速切换时旧响应不得覆盖新数据。 */
let usageFetchGeneration = 0
let daysFetchGeneration = 0
let allDaysFetchGeneration = 0

async function loadUsage() {
  const gen = ++usageFetchGeneration
  usageLoading.value = true
  usageError.value = ''
  try {
    const response = await membershipApi.usage()
    if (gen !== usageFetchGeneration) return
    usage.value = response.data.data
  } catch {
    if (gen !== usageFetchGeneration) return
    usageError.value = '用量总览加载失败，请稍后重试'
  } finally {
    if (gen === usageFetchGeneration) usageLoading.value = false
  }
}

async function loadUsageDays() {
  const gen = ++daysFetchGeneration
  daysLoading.value = true
  daysError.value = ''
  try {
    const response = await membershipApi.usageDays(usageRange.value)
    if (gen !== daysFetchGeneration) return
    usageDays.value = response.data.data
  } catch {
    if (gen !== daysFetchGeneration) return
    daysError.value = '用量趋势加载失败，请稍后重试'
  } finally {
    if (gen === daysFetchGeneration) daysLoading.value = false
  }
}

async function loadUsageAllDays() {
  const gen = ++allDaysFetchGeneration
  allDaysLoading.value = true
  allDaysError.value = ''
  try {
    const response = await membershipApi.usageDays('all')
    if (gen !== allDaysFetchGeneration) return
    usageAllDays.value = response.data.data
  } catch {
    if (gen !== allDaysFetchGeneration) return
    allDaysError.value = '用量明细加载失败，请稍后重试'
  } finally {
    if (gen === allDaysFetchGeneration) allDaysLoading.value = false
  }
}

function reload() {
  void loadUsage()
  void loadUsageDays()
  void loadUsageAllDays()
}

const daysViewLoading = computed(() => daysLoading.value || (!usageDays.value && !daysError.value))
const allDaysViewLoading = computed(() => allDaysLoading.value || (!usageAllDays.value && !allDaysError.value))
const usageViewLoading = computed(() => usageLoading.value || (!usage.value && !usageError.value))

const tableTotals = computed(() => ({
  generationCount: usage.value?.overview.generationCount ?? 0,
  netConsumed: usage.value?.overview.netConsumedTotal ?? 0,
  byCategory: usage.value?.overview.byCategory ?? { text: 0, image: 0, audio: 0, video: 0 },
}))

watch(usageRange, () => {
  void loadUsageDays()
})

onMounted(reload)
defineExpose({ reload })
</script>

<template>
  <div class="usage-panel">
    <div v-if="usageError" class="usage-error">
      {{ usageError }}
      <button type="button" @click="loadUsage">重新加载</button>
    </div>
    <UsageOverviewCards v-else-if="usage" :overview="usage.overview" />
    <div v-else class="usage-skeleton" />

    <div class="usage-scroll-x">
      <UsageHeatmap
        v-if="usage && !usageError"
        :from="usage.heatmap.from"
        :to="usage.heatmap.to"
        :active-days="usage.heatmap.activeDays"
        :days="usage.heatmap.days"
      />
      <div v-else-if="usageViewLoading" class="usage-skeleton usage-skeleton--tall" />
    </div>

    <div v-if="daysError" class="usage-error">
      {{ daysError }}
      <button type="button" @click="loadUsageDays">重新加载</button>
    </div>
    <UsageTrend
      v-else
      :range="usageRange"
      :days="usageDays?.days ?? []"
      :loading="daysViewLoading"
      @update:range="usageRange = $event"
    />

    <div v-if="allDaysError" class="usage-error">
      {{ allDaysError }}
      <button type="button" @click="loadUsageAllDays">重新加载</button>
    </div>
    <div v-else class="usage-scroll-x">
      <UsageDayTable
        :days="usageAllDays?.days ?? []"
        :loading="allDaysViewLoading"
        :totals="tableTotals"
      />
    </div>
  </div>
</template>

<style scoped>
.usage-panel {
  display: flex;
  flex-direction: column;
  gap: var(--lnk-space-4);
  min-width: 0;
}
/* 窄屏：热力图与日表保持自身最小宽度，横向滚动而不是被压扁 */
.usage-scroll-x {
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.usage-error {
  padding: var(--lnk-pad-card);
  border: 1px solid var(--lnk-danger-border, var(--lnk-border-default));
  border-radius: var(--lnk-radius-2xl);
  font-size: var(--lnk-text-sm);
  color: var(--lnk-danger, var(--lnk-text-primary));
}
.usage-error button {
  margin-left: var(--lnk-space-2);
  text-decoration: underline;
  cursor: pointer;
}
.usage-skeleton {
  height: 7rem;
  border: 1px solid var(--lnk-border-subtle);
  border-radius: var(--lnk-radius-2xl);
  /* 与 UsageHeatmap/UsageTrend/UsageDayTable 同一张卡语言（surface-canvas），
     不用 sunken —— 凹陷面属另一套语义，会让骨架与真卡在暗色下"跳色" */
  background: var(--lnk-surface-canvas);
}
.usage-skeleton--tall {
  height: 12rem;
}
</style>