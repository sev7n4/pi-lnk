<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { HealthAlert, ModelHealthRow } from '@lnkpi/shared/modelHealth'
import { adminApi, AdminApiError, type ProbeRunRow } from '@/services/admin-api'

const WINDOW_OPTIONS = [1, 6, 24, 168] as const
/** 探活 automation job 的 handlerKey（C5 注册名，见 upstream-probe.service）。 */
const PROBE_HANDLER_KEY = 'upstream-probe'

const router = useRouter()
const loading = ref(false)
const windowHours = ref<1 | 6 | 24 | 168>(24)
const generatedAt = ref('')
const rows = ref<ModelHealthRow[]>([])
const alerts = ref<HealthAlert[]>([])
const runs = ref<ProbeRunRow[]>([])
const error = ref('')
const probing = ref(false)
/** 探活 job id 缓存（GET /admin/automations 按 handlerKey 解析，进程内不变）。 */
const probeJobId = ref<string | null>(null)

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

async function ensureProbeJobId(): Promise<string | null> {
  if (probeJobId.value) return probeJobId.value
  const { jobs } = await adminApi.listAutomations()
  const job = jobs.find((j) => j.handlerKey === PROBE_HANDLER_KEY && j.enabled)
  probeJobId.value = job?.id ?? null
  return probeJobId.value
}

/**
 * 轮询 latest 直到出现比 before 新的 run（探活为后台异步执行，触发接口立即返回）。
 * delayMs 供测试注入 0；默认 7.5s × 12 次 = 90s 上限，超时提示手动刷新。
 */
async function waitProbeSettled(before: number, delayMs = 7_500): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, delayMs))
    const probe = await adminApi.latestProbeRuns()
    runs.value = probe.runs
    const maxRanAt = Math.max(0, ...probe.runs.map((r) => +new Date(r.ranAt)))
    if (maxRanAt > before) return true
  }
  return false
}

/** 手动触发一轮探活（复用 C5 automation trigger 端点，与定时共用并发闸）。 */
async function triggerProbe(opts?: { pollDelayMs?: number }) {
  if (probing.value) return
  probing.value = true
  error.value = ''
  try {
    const id = await ensureProbeJobId()
    if (!id) {
      ElMessage.warning('未找到探活任务或已被禁用（handlerKey=upstream-probe）')
      return
    }
    await adminApi.triggerAutomation(id)
    ElMessage.success('探活已触发，完成后自动刷新')
    const before = Math.max(0, ...runs.value.map((r) => +new Date(r.ranAt)))
    const fresh = await waitProbeSettled(before, opts?.pollDelayMs ?? 7_500)
    if (!fresh) ElMessage.info('探活仍在进行，可稍后手动刷新查看')
  } catch (err) {
    error.value = err instanceof AdminApiError ? err.message : '触发失败'
  } finally {
    probing.value = false
  }
}

/** missing 模型一键预填上架：跳目录页并带 prefill query（新增弹窗自动打开）。 */
function goOnboard(modelKey: string) {
  router.push({ path: '/admin/models', query: { prefill: modelKey } })
}

onMounted(reload)

// 测试经 w.vm 直调（同 AdminModelsPage 先例）：script setup 顶层绑定默认不暴露。
defineExpose({ reload, ghostText, missingText, triggerProbe, goOnboard, ensureProbeJobId })
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
      <el-button type="primary" plain :loading="probing" @click="triggerProbe()">立即探活</el-button>
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
            <p class="text-fg-2">ghost（目录有、上游 /models 没报 → 候选下架；上游 /models 清单 ≠ 实际可用，以真实流量为准）</p>
            <p class="mb-2 font-mono text-xs text-fg">{{ ghostText(row) }}</p>
            <p class="text-fg-2">missing（上游有、目录没有 → 候选上架）</p>
            <div v-if="row.missing.length > 0" class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span v-for="m in row.missing" :key="m" class="flex items-center gap-1">
                <span class="font-mono text-xs text-fg">{{ m }}</span>
                <el-button link type="primary" size="small" @click="goOnboard(m)">去上架</el-button>
              </span>
            </div>
            <p v-else class="font-mono text-xs text-fg">{{ missingText(row) }}</p>
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
