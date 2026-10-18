<script setup lang="ts">
/** 移动端应用骨架 · 我的页签（2026-10-18 IA v3，整页照抄 WorkBuddy 截图4，按本项目裁剪）：
 * 账号信息 / 积分区（我的积分·账户信息 + 套餐订阅·当前套餐 + 积分充值）/ 设置组（主题 + 模型服务配置，
 * 2026-10-19 用户裁决统一降级纳入「设置」）/ 返回工作台 / 退出登录（唯一居中文本）。
 * 砍：成长计划、券码、下载电脑版、关注服务号（本项目不存在）。 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import ThemeToggle from '@/components/layout/ThemeToggle.vue'
import TopupModal from '@/components/membership/TopupModal.vue'
import { BRAND_LOGO_URL } from '@/constants/brand'
import { membershipLabel as membershipLabelFn } from '@/services/users-api'

const emit = defineEmits<{
  'open-membership': []
  'open-model-settings': []
}>()

const auth = useAuthStore()
const router = useRouter()

const nickname = computed(() => auth.user?.nickname || '未登录')

const membershipLabel = computed(() => membershipLabelFn(auth.user?.membership))

/** 积分充值（2026-10-19 用户裁决补入口）：TopupModal 直连，6 档瓦片 + 自定义 */
const showTopup = ref(false)

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
      <!-- 我的积分：账户信息（余额）→ 会员与用量面板 -->
      <button type="button" class="row-item" @click="emit('open-membership')">
        <span class="row-label">我的积分</span>
        <span class="row-value tabular-nums">{{ auth.user?.points ?? 0 }}</span>
        <svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
        </svg>
      </button>
      <!-- 套餐订阅：当前订阅套餐 → 会员面板 -->
      <button type="button" class="row-item" @click="emit('open-membership')">
        <span class="row-label">套餐订阅</span>
        <span class="row-value">{{ membershipLabel }}</span>
        <svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
        </svg>
      </button>
      <!-- 积分充值：TopupModal 直连 -->
      <button type="button" class="row-item" @click="showTopup = true">
        <span class="row-label">积分充值</span>
        <svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
        </svg>
      </button>
    </div>

    <!-- 设置组：主题 + 模型服务配置统一降级收纳（2026-10-19 用户裁决） -->
    <div class="row-group">
      <p class="group-caption">设置</p>
      <div class="row-item is-static">
        <span class="row-label">主题</span>
        <ThemeToggle class="profile-theme-toggle" />
      </div>
      <button type="button" class="row-item" @click="emit('open-model-settings')">
        <span class="row-label">模型服务配置</span>
        <svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
        </svg>
      </button>
    </div>

    <div class="row-group">
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

    <TopupModal v-model="showTopup" />
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

.group-caption {
  padding: 0 4px;
  font-size: var(--lnk-text-xs, 12px);
  color: var(--lnk-text-muted);
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
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background-color var(--lnk-duration-fast, 120ms) var(--lnk-ease-standard, ease);
}

.row-item:active {
  background: var(--lnk-accent-subtle);
}

.row-item.is-static {
  cursor: default;
}

.row-item.is-static:active {
  background: var(--lnk-surface-raised);
}

.row-label {
  flex: 1 1 auto;
  text-align: left;
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

/* 退出登录：唯一居中文本（用户裁决），其余行全部左对齐 */
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
