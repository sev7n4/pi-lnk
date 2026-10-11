<!-- apps/web/src/pages/admin/AdminRoutesPage.vue -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi, AdminApiError, type AdminRouteRow } from '@/services/admin-api'

const loading = ref(false)
const version = ref(0)
const routes = ref<AdminRouteRow[]>([])
const actionError = ref('')

async function reload() {
  loading.value = true
  try {
    const data = await adminApi.listRoutes()
    version.value = data.version
    routes.value = data.routes
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '加载失败'
  } finally {
    loading.value = false
  }
}

async function toggleEnabled(row: AdminRouteRow) {
  actionError.value = ''
  try {
    await adminApi.updateRoute(row.id, { enabled: !row.enabled })
    ElMessage.success('已更新，路由缓存本进程即时生效（跨实例 5s TTL 兜底）')
    await reload()
  } catch (err) {
    actionError.value = err instanceof AdminApiError ? err.message : '操作失败'
    await reload() // 开关状态与服务端对齐
  }
}

onMounted(reload)
</script>

<template>
  <section class="p-2">
    <header class="mb-3 flex items-center gap-3">
      <h1 class="text-base font-semibold text-fg">上游路由表</h1>
      <span class="text-sm text-fg-3">routesVersion {{ version }}</span>
      <el-button :loading="loading" @click="reload">刷新</el-button>
    </header>
    <p v-if="actionError" class="mb-2 rounded border border-danger-border bg-danger-bg p-2 text-sm text-danger">{{ actionError }}</p>
    <el-table :data="routes" v-loading="loading" size="small" border>
      <el-table-column prop="priority" label="优先级" width="80" />
      <el-table-column prop="matchType" label="匹配" width="90" />
      <el-table-column prop="pattern" label="pattern" min-width="140" />
      <el-table-column prop="capability" label="能力" width="80" />
      <el-table-column prop="upstream" label="上游" width="120" />
      <el-table-column prop="fallbackApiKeyEnvName" label="fallbackKey" min-width="140" />
      <el-table-column label="启用" width="90">
        <template #default="{ row }">
          <el-switch :model-value="row.enabled" @change="toggleEnabled(row)" />
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>
