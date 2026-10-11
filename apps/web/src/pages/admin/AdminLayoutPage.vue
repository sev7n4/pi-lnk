<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { adminApi } from '@/services/admin-api'
import { useAdminStore } from '@/stores/admin'

const admin = useAdminStore()
const route = useRoute()
const tokenInput = ref('')
const verifying = ref(false)
const error = ref('')

onMounted(() => admin.init())

async function submitToken() {
  const token = tokenInput.value.trim()
  if (!token) {
    error.value = '请输入 LNKPI_ADMIN_TOKEN'
    return
  }
  verifying.value = true
  error.value = ''
  admin.setToken(token)
  try {
    await adminApi.verify()
  } catch {
    admin.clearToken()
    error.value = 'token 校验失败（密钥不匹配或服务端未配置 LNKPI_ADMIN_TOKEN）'
  } finally {
    verifying.value = false
  }
}
</script>

<template>
  <div v-if="!admin.hasToken" class="admin-gate flex min-h-screen items-center justify-center bg-surface-canvas">
    <div class="w-80 rounded-lg border border-line-subtle bg-surface-base p-6 shadow-lnk-md">
      <h2 class="mb-3 text-base font-semibold text-fg">运营管理台 · 访问验证</h2>
      <el-input
        v-model="tokenInput"
        type="password"
        show-password
        placeholder="LNKPI_ADMIN_TOKEN"
        @keyup.enter="submitToken"
      />
      <el-button class="mt-3 w-full" type="primary" :loading="verifying" @click="submitToken">验证进入</el-button>
      <p v-if="error" class="mt-2 text-sm text-danger">{{ error }}</p>
    </div>
  </div>
  <el-container v-else class="admin-shell min-h-screen bg-surface-canvas">
    <el-aside width="168px" class="border-r border-line-subtle bg-surface-base">
      <el-menu :default-active="route.path" router>
        <el-menu-item index="/admin/models">模型目录</el-menu-item>
        <el-menu-item index="/admin/routes">上游路由</el-menu-item>
        <el-menu-item index="/admin/health">健康探活</el-menu-item>
        <el-menu-item index="/admin/pricing">渠道定价</el-menu-item>
        <el-menu-item index="/admin/audit">审计日志</el-menu-item>
      </el-menu>
    </el-aside>
    <el-main>
      <router-view />
    </el-main>
  </el-container>
</template>
