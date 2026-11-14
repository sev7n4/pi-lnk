<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  adminApi,
  AdminApiError,
  type CostRateInput,
  type CostRateRow,
} from '@/services/admin-api'

/**
 * S1：成本配置页（单一人民币 D9）。
 * - AC10 守卫在服务端：提交 currency/fxRate/fxUsdCny/costUsd/usdPerM 等字段直接 400；
 *   本表单刻意不渲染任何币种/汇率字段，录入即人民币元。
 * - upsert by (channel, modelKey, spec)：同渠道同模型同档位只一条价。
 */

const COST_UNITS = ['per_image', 'per_video', 'per_call', 'per_1m_tokens', 'per_second'] as const
const COST_SOURCES = ['official_list', 'negotiated', 'channel_actual', 'provisional'] as const

const loading = ref(false)
const saving = ref(false)
const actionError = ref('')
const rows = ref<CostRateRow[]>([])

const form = ref<CostRateInput>({
  channel: '',
  modelKey: '',
  spec: '',
  unit: 'per_image',
  costYuan: 0,
  unitQuantity: 1,
  source: 'official_list',
  provider: null,
  upstream: null,
  provisional: false,
})

function errMsg(err: unknown, fallback: string): string {
  return err instanceof AdminApiError ? err.message : fallback
}

async function reload() {
  loading.value = true
  actionError.value = ''
  try {
    rows.value = await adminApi.pricingS1.listCostRates()
  } catch (err) {
    actionError.value = errMsg(err, '成本行加载失败')
  } finally {
    loading.value = false
  }
}

function resetForm() {
  form.value = {
    channel: '',
    modelKey: '',
    spec: '',
    unit: 'per_image',
    costYuan: 0,
    unitQuantity: 1,
    source: 'official_list',
    provider: null,
    upstream: null,
    provisional: false,
  }
}

async function save() {
  actionError.value = ''
  const f = form.value
  if (!f.channel.trim() || !f.modelKey.trim() || !f.spec.trim()) {
    actionError.value = 'channel / modelKey / spec 为必填'
    return
  }
  if (f.costYuan < 0) {
    actionError.value = 'costYuan 必须是非负人民币元金额'
    return
  }
  if (!f.unitQuantity || f.unitQuantity <= 0) {
    actionError.value = 'unitQuantity 必须为正数'
    return
  }
  saving.value = true
  try {
    // 显式剔除 null 可选字段中未填项，避免多传 undefined 干扰服务端手校（服务端也兜底忽略未知字段）。
    const payload: Record<string, unknown> = {
      channel: f.channel.trim(),
      modelKey: f.modelKey.trim(),
      spec: f.spec.trim(),
      unit: f.unit,
      costYuan: f.costYuan,
      unitQuantity: f.unitQuantity,
      source: f.source,
      provisional: f.provisional,
    }
    if (f.provider) payload.provider = f.provider
    if (f.upstream) payload.upstream = f.upstream
    await adminApi.pricingS1.putCostRate(payload as CostRateInput)
    ElMessage.success(`已保存成本行 ${f.channel}/${f.modelKey}/${f.spec}`)
    resetForm()
    await reload()
  } catch (err) {
    actionError.value = errMsg(err, '保存成本行失败')
  } finally {
    saving.value = false
  }
}

onMounted(reload)

defineExpose({ reload, save, form, rows, actionError })
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">成本配置</h1>
      <span class="text-sm text-fg-3">渠道成本（单一人民币，无币种/汇率字段 · AC10）</span>
      <el-button :loading="loading" @click="reload">刷新</el-button>
    </header>
    <p v-if="actionError" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>

    <!-- 录入表单 -->
    <div class="mb-3 grid grid-cols-2 gap-2 rounded border border-line-subtle bg-surface-base p-3 md:grid-cols-4">
      <el-input v-model="form.channel" placeholder="渠道 channel（如 volcengine）" />
      <el-input v-model="form.modelKey" placeholder="模型 modelKey" />
      <el-input v-model="form.spec" placeholder="档位 spec（如 1K）" />
      <el-select v-model="form.unit" placeholder="计量单位">
        <el-option v-for="u in COST_UNITS" :key="u" :label="u" :value="u" />
      </el-select>
      <el-input-number v-model="form.costYuan" :min="0" :precision="4" label="人民币元" class="w-full" />
      <el-input-number v-model="form.unitQuantity" :min="1" :step="1" label="单位数量" class="w-full" />
      <el-select v-model="form.source" placeholder="成本来源">
        <el-option v-for="s in COST_SOURCES" :key="s" :label="s" :value="s" />
      </el-select>
      <div class="flex items-center gap-2">
        <el-checkbox v-model="form.provisional">暂估 provisional</el-checkbox>
      </div>
      <el-input v-model="form.provider" placeholder="provider（可选）" />
      <el-input v-model="form.upstream" placeholder="upstream（可选）" />
      <el-button type="primary" :loading="saving" @click="save">保存成本行</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" size="small" border max-height="520">
      <el-table-column prop="channel" label="渠道" width="120" />
      <el-table-column prop="modelKey" label="模型" min-width="140" />
      <el-table-column prop="spec" label="档位" width="90" />
      <el-table-column prop="unit" label="计量单位" width="120" />
      <el-table-column prop="costYuan" label="成本(元)" width="110" />
      <el-table-column prop="unitQuantity" label="单位数量" width="90" />
      <el-table-column prop="source" label="来源" width="130" />
      <el-table-column label="暂估" width="70">
        <template #default="{ row }">
          <el-tag v-if="row.provisional" type="warning" size="small">暂估</el-tag>
          <span v-else class="text-fg-3">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="创建时间" min-width="160" />
    </el-table>
  </section>
</template>
