<script setup lang="ts">
/** 移动端应用骨架 · 我的页签（2026-10-18 IA v3，整页照抄 WorkBuddy 截图4，按本项目裁剪）：
 * 账号信息 / 我的积分（唯一积分入口→会员与充值面板）/ 会员 / 主题 / 模型服务配置 /
 * 返回工作台 / 退出登录。砍：成长计划、券码、下载电脑版、关注服务号（本项目不存在）。 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import ThemeToggle from '@/components/layout/ThemeToggle.vue'
import { BRAND_LOGO_URL } from '@/constants/brand'

const emit = defineEmits<{
  'open-membership': []
  'open-model-settings': []
}>()

const auth = useAuthStore()
const router = useRouter()

const nickname = computed(() => auth.user?.nickname || '未登录')

const membershipLabel = computed(() => {
  const m = auth.user?.membership
  return m === 'pro' ? '专业版' : m === 'studio' ? '工作室版' : '免费版'
})

function backToWorkbench() {
  void router.push('/workflow')
}
</script>

<template>
  <div class="profile-pane">
    <!-- 账号信息卡 -->
    <button
      type="button"
      class="profile-card account-row"
      @click="!auth.isLoggedIn && auth.openLogin()"
    >
      <img :src="BRAND_LOGO_URL" alt="" class="account-avatar" draggable="false">
      <span class="account-name">{{ nickname }}</span>
      <svg v-if="auth.isLoggedIn" class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
        <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
      </svg>
      <span v-else class="login-hint">点击登录</span>
    </button>

    <div v-if="auth.isLoggedIn" class="row-group">
      <!-- 积分：唯一积分入口 → 会员/充值面板 -->
      <button type="button" class="row-item" @click="emit('open-membership')">
        <span class="row-label">我的积分</span>
        <span class="row-value tabular-nums">{{ auth.user?.points ?? 0 }}</span>
        <svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
        </svg>
      </button>
      <!-- 会员 -->
      <button type="button" class="row-item" @click="emit('open-membership')">
        <span class="row-label">会员</span>
        <span class="row-value">{{ membershipLabel }}</span>
        <svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
        </svg>
      </button>
    </div>

    <div class="row-group">
      <!-- 主题：复用既有 ThemeToggle（自身携带浅/深/跟随三态） -->
      <div class="row-item is-static">
        <span class="row-label">主题</span>
        <ThemeToggle class="profile-theme-toggle" />
      </div>
      <!-- 模型服务配置 -->
      <button type="button" class="row-item" @click="emit('open-model-settings')">
        <span class="row-label">模型服务配置</span>
        <svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
        </svg>
      </button>
      <!-- 返回工作台 -->
      <button type="button" class="row-item" @click="backToWorkbench">
        <span class="row-label">返回工作台</span>
        <svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
        </svg>
      </button>
    </div>

    <button
      v-if="auth.isLoggedIn"
      type="button"
      class="logout-btn"
      @click="auth.logout()"
    >
      退出登录
    </button>
  </div>
</template>

<style scoped>
.profile-pane {
  position: fixed;
  inset: 0;
  z-index: 75;
  padding: calc(var(--lnk-topbar-h, 44px) + 12px) 12px calc(var(--lnk-tabbar-h, 56px) + 12px);
  background: var(--lnk-surface-canvas);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.profile-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 14px;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: 14px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background-color var(--lnk-duration-fast, 120ms) var(--lnk-ease-standard, ease);
}

.account-avatar {
  width: 44px;
  height: 44px;
  border-radius: 999px;
  object-fit: contain;
  padding: 2px;
  background: color-mix(in srgb, var(--lnk-text-primary) 6%, transparent);
}

.account-name {
  flex: 1 1 auto;
  font-size: var(--lnk-text-md, 16px);
  font-weight: 500;
}

.login-hint {
  font-size: var(--lnk-text-xs, 12px);
  color: var(--lnk-text-muted);
}

.row-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 14px;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: 14px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-text-primary);
  font-size: var(--lnk-text-base, 14px);
  cursor: pointer;
}

.row-item.is-static {
  cursor: default;
}

.row-label {
  flex: 1 1 auto;
}

.row-value {
  font-size: var(--lnk-text-sm, 13px);
  color: var(--lnk-text-muted);
}

.row-chevron {
  width: 15px;
  height: 15px;
  opacity: 0.4;
}

.profile-theme-toggle {
  pointer-events: auto;
}

.logout-btn {
  margin-top: 8px;
  padding: 13px;
  border: 0.5px solid var(--lnk-border-subtle);
  border-radius: 14px;
  background: var(--lnk-surface-raised);
  color: var(--lnk-error);
  font-size: var(--lnk-text-base, 14px);
  cursor: pointer;
}
</style>
