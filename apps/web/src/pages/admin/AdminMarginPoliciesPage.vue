<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  adminApi,
  AdminApiError,
  type MarginPolicyInput,
  type MarginPolicyRow,
} from '@/services/admin-api'

/**
 * S1：利润配置页（平台利润率）。
 * - phase 由服务端 phaseOf(scope, scopeKey) 生成（global 恒 'launch'，其余 scope:scopeKey）；
 *   同 scope+scopeKey 只一条策略，upsert 复用。
 * - 守卫：priceFloorBp 不得高于 profitBp（利润率不可击穿地板）——前端预校验 + 服务端硬拒双保险。
 */

const STATUSES = ['active', 'draft', 'disabled'] as const

const loading = ref(false)
const saving = ref(false)
const actionError = ref('')
const rows = ref<MarginPolicyRow[]>([])

const form = ref<MarginPolicyInput>({
  scope: 'global',
  scopeKey: null,
  profitBp: 1500,
  priceFloorBp: 500,
  status: 'active',
})

function errMsg(err: unknown, fallback: string): string {
  return err instanceof AdminApiError ? err.message : fallback
}

async function reload() {
  loading.value = true
  actionError.value = ''
  try {
    rows.value = await adminApi.pricingS1.listMarginPolicies()
  } catch (err) {
    actionError.value = errMsg(err, '利润策略加载失败')
  } finally {
    loading.value = false
  }
}

function resetForm() {
  form.value = { scope: 'global', scopeKey: null, profitBp: 1500, priceFloorBp: 500, status: 'active' }
}

async function save() {
  actionError.value = ''
  const f = form.value
  if (!f.scope.trim()) {
    actionError.value = 'scope 为必填'
    return
  }
  if (typeof f.priceFloorBp === 'number' && f.priceFloorBp > f.profitBp) {
    actionError.value = `priceFloorBp(${f.priceFloorBp}) 不得超过 profitBp(${f.profitBp})：利润率不可击穿地板`
    return
  }
  saving.value = true
  try {
    const payload: Record<string, unknown> = {
      scope: f.scope.trim(),
      profitBp: f.profitBp,
      priceFloorBp: f.priceFloorBp ?? 500,
      status: f.status,
    }
    if (f.scopeKey && f.scopeKey.trim()) payload.scopeKey = f.scopeKey.trim()
    await adminApi.pricingS1.putMarginPolicy(payload as MarginPolicyInput)
    ElMessage.success(`已保存利润策略（scope=${f.scope}）`)
    resetForm()
    await reload()
  } catch (err) {
    actionError.value = errMsg(err, '保存利润策略失败')
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
      <h1 class="text-base font-semibold text-fg">利润配置</h1>
      <span class="text-sm text-fg-3">平台利润率（按 scope 取生效策略；global 为兜底）</span>
      <el-button :loading="loading" @click="reload">刷新</el-button>
    </header>
    <p v-if="actionError" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>

    <!-- 录入表单 -->
    <div class="mb-3 grid grid-cols-2 gap-2 rounded border border-line-subtle bg-surface-base p-3 md:grid-cols-5">
      <el-input v-model="form.scope" placeholder="scope（如 global / model / provider）" />
      <el-input v-model="form.scopeKey" placeholder="scopeKey（global 留空）" />
      <el-input-number v-model="form.profitBp" :step="100" label="利润率 bp（万分之）" class="w-full" />
      <el-input-number v-model="form.priceFloorBp" :step="100" label="地板 bp" class="w-full" />
      <el-select v-model="form.status" placeholder="状态">
        <el-option v-for="s in STATUSES" :key="s" :label="s" :value="s" />
      </el-select>
      <el-button type="primary" :loading="saving" @click="save">保存利润策略</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" size="small" border max-height="520">
      <el-table-column prop="scope" label="scope" width="120" />
      <el-table-column prop="scopeKey" label="scopeKey" min-width="140" />
      <el-table-column prop="profitBp" label="利润率 bp" width="110" />
      <el-table-column prop="priceFloorBp" label="地板 bp" width="100" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : row.status === 'disabled' ? 'info' : 'warning'" size="small">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="effectiveFrom" label="生效起" min-width="160" />
      <el-table-column prop="effectiveTo" label="生效止" min-width="160" />
    </el-table>
  </section>
</template>
