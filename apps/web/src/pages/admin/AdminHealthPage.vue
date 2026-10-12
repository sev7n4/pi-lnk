<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { HealthAlert, ModelHealthRow } from '@lnkpi/shared/modelHealth'
import { adminApi, AdminApiError, type ProbeRunRow } from '@/services/admin-api'

const WINDOW_OPTIONS = [1, 6, 24, 168] as const

const loading = ref(false)
const windowHours = ref<1 | 6 | 24 | 168>(24)
const generatedAt = ref('')
const rows = ref<ModelHealthRow[]>([])
const alerts = ref<HealthAlert[]>([])
const runs = ref<ProbeRunRow[]>([])
const error = ref('')

function successRateText(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

/** ghost 清单文本（空数组显示 —），供展开行与测试使用 */
function ghostText(row: ProbeRunRow): string {
  return row.ghosts.length > 0 ? row.ghosts.join('、') : '—'
}

/** missing 清单文本，同上 */
function missingText(row: ProbeRunRow): string {
  return row.missing.length > 0 ? row.missing.join('、') : '—'
}

async function reload() {
  loading.value = true
  error.value = ''
  try {
    const [health, probe] = await Promise.all([adminApi.modelHealth(windowHours.value), adminApi.latestProbeRuns()])
    generatedAt.value = health.generatedAt
    rows.value = health.rows
    alerts.value = health.alerts
    runs.value = probe.runs
  } catch (err) {
    error.value = err instanceof AdminApiError ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(reload)

// 测试经 w.vm 直调（同 AdminModelsPage 先例）：script setup 顶层绑定默认不暴露。
defineExpose({ reload, ghostText, missingText })
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">模型健康 / 探活</h1>
      <el-select v-model="windowHours" class="w-28" @change="reload">
        <el-option v-for="w in WINDOW_OPTIONS" :key="w" :value="w" :label="`${w}h`" />
      </el-select>
      <span class="text-sm text-fg-3">{{ generatedAt }}</span>
      <el-button :loading="loading" @click="reload">刷新</el-button>
    </header>
    <p v-if="error" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ error }}</p>

    <div v-if="alerts.length > 0" class="mb-3 rounded border border-warning-border bg-warning-bg p-2">
      <p v-for="a in alerts" :key="`${a.rule}:${a.model}`" class="text-sm text-warning">
        [{{ a.rule }}] {{ a.model }} — 成功率 {{ successRateText(a.successRate) }}（窗口 {{ a.windowHours }}h，共 {{ a.total }} 次）
      </p>
    </div>

    <el-table :data="rows" v-loading="loading" size="small" border class="mb-4">
      <el-table-column prop="model" label="模型" min-width="160" />
      <el-table-column prop="channelId" label="渠道" width="100" />
      <el-table-column prop="total" label="总次数" width="80" />
      <el-table-column prop="completed" label="完成" width="80" />
      <el-table-column prop="failed" label="失败" width="80" />
      <el-table-column label="成功率" width="90">
        <template #default="{ row }">{{ successRateText(row.successRate) }}</template>
      </el-table-column>
      <el-table-column label="errorCode 分布" min-width="180">
        <template #default="{ row }">
          <span v-if="Object.keys(row.errorCodeCounts).length === 0" class="text-fg-3">—</span>
          <span v-for="(cnt, code) in row.errorCodeCounts" :key="code" class="mr-2 text-fg-2">{{ code }}×{{ cnt }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="balance402Count" label="402" width="70" />
    </el-table>

    <h2 class="mb-2 text-sm font-semibold text-fg-2">最近一次探活（各上游）</h2>
    <p v-if="runs.length === 0" class="text-sm text-fg-3">暂无数据（探活间隔默认 6h，部署初态正常）</p>
    <el-table v-else :data="runs" size="small" border>
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="p-3 text-sm">
            <p class="text-fg-2">ghost（上游有、目录没有 → 候选上架）</p>
            <p class="mb-2 font-mono text-xs text-fg">{{ ghostText(row) }}</p>
            <p class="text-fg-2">missing（目录有、上游没有 → 候选下架）</p>
            <p class="font-mono text-xs text-fg">{{ missingText(row) }}</p>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="upstream" label="上游" width="120" />
      <el-table-column prop="ranAt" label="时间" min-width="170" />
      <el-table-column prop="httpStatus" label="HTTP" width="80" />
      <el-table-column prop="modelCount" label="模型数" width="80" />
      <el-table-column label="对账" min-width="160">
        <template #default="{ row }">
          <span class="text-warning">ghost {{ row.ghosts.length }}</span>
          <span class="mx-2 text-fg-2">missing {{ row.missing.length }}</span>
        </template>
      </el-table-column>
      <el-table-column label="错误" min-width="140">
        <template #default="{ row }">
          <span v-if="row.error" class="text-danger">{{ row.error }}</span>
          <span v-else class="text-fg-3">—</span>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>
