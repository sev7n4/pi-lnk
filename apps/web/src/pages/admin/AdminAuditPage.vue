<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { adminApi, AdminApiError, type AuditLogRow } from '@/services/admin-api'

const loading = ref(false)
const rows = ref<AuditLogRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const filters = ref({ action: '', resource: '' })
const error = ref('')

async function reload() {
  loading.value = true
  error.value = ''
  try {
    const data = await adminApi.listAuditLogs({
      action: filters.value.action.trim() || undefined,
      resource: filters.value.resource.trim() || undefined,
      page: page.value,
      pageSize: pageSize.value,
    })
    rows.value = data.rows
    total.value = data.total
    page.value = data.page
    pageSize.value = data.pageSize
  } catch (err) {
    error.value = err instanceof AdminApiError ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function onPageChange(p: number) {
  page.value = p
  void reload()
}

// brief 原文为模板内联 TS 箭头 (s: number) => {...}，仓库无先例；提为具名函数以规避
// 模板表达式 TS 语法在 vue-tsc/编译链上的不确定性，行为不变。
function onSizeChange(s: number) {
  pageSize.value = s
  page.value = 1
  void reload()
}

onMounted(reload)

// 测试经 w.vm 直调（同 AdminModelsPage / AdminPricingPage 先例）：script setup 顶层绑定默认不暴露。
defineExpose({ filters, page, pageSize, reload })
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">审计日志</h1>
      <el-input v-model="filters.action" placeholder="action 精确匹配" class="w-56" clearable @keyup.enter="page = 1; reload()" />
      <el-input v-model="filters.resource" placeholder="resource 精确匹配" class="w-56" clearable @keyup.enter="page = 1; reload()" />
      <el-button type="primary" @click="page = 1; reload()">查询</el-button>
    </header>
    <p v-if="error" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ error }}</p>
    <el-table :data="rows" v-loading="loading" size="small" border>
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="p-3 font-mono text-xs">
            <p class="text-fg-2">before：<pre class="whitespace-pre-wrap">{{ row.before ?? 'null' }}</pre></p>
            <p class="text-fg-2">after：<pre class="whitespace-pre-wrap">{{ row.after ?? 'null' }}</pre></p>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="createdAt" label="时间" min-width="170" />
      <el-table-column prop="action" label="action" min-width="200" />
      <el-table-column prop="resource" label="resource" min-width="200" />
      <el-table-column prop="actor" label="actor" width="90" />
    </el-table>
    <el-pagination
      class="mt-3 justify-end"
      layout="total, sizes, prev, pager, next"
      :total="total"
      :current-page="page"
      :page-size="pageSize"
      :page-sizes="[20, 50, 100]"
      @current-change="onPageChange"
      @size-change="onSizeChange"
    />
  </section>
</template>
