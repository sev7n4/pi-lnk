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
  try {
    // Follow-up ⑤：先验真后落库——verify 显式携带候选 token，成功才写 sessionStorage
    // （此前先 setToken 再 verify，未验证的 token 会短暂落入会话可被其他请求读到）
    await adminApi.verify(token)
    admin.setToken(token)
  } catch {
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
        <el-sub-menu index="/admin/pricing-engine">
          <template #title>渠道定价</template>
          <el-menu-item index="/admin/pricing-hub">定价中心</el-menu-item>
          <!-- P3-B：「原始数据：主体/成本/利润（高级）」三页已下线（运营确认从未使用，
               日常改数走「定价中心」卡片）。后端接口保留，需要时可恢复本行 + router 行。 -->
        </el-sub-menu>
        <el-menu-item index="/admin/pricing">平台渠道定价</el-menu-item>
        <!-- P3-B：以下两项能力已上收到「定价中心」发布面板（diff/发布/回滚/公告），
             菜单先藏、文件与路由保留（回滚逃生口 + 灰度设施），需要时取消注释即可恢复。 -->
        <!--
        <el-menu-item index="/admin/pricing-versions">价目发布流</el-menu-item>
        <el-menu-item index="/admin/gray-release">灰度发布</el-menu-item>
        -->
        <el-menu-item index="/admin/audit">审计日志</el-menu-item>
        <el-menu-item index="/admin/guide">使用说明</el-menu-item>
      </el-menu>
    </el-aside>
    <el-main>
      <router-view />
    </el-main>
  </el-container>
</template>
