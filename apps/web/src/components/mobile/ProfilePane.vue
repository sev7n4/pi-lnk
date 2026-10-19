<script setup lang="ts">
/** 移动端应用骨架 · 我的页签（2026-10-18 IA v3，整页照抄 WorkBuddy 截图4，按本项目裁剪）：
 * 账号信息 / 积分区（我的积分·账户信息 + 套餐订阅·当前套餐 + 积分充值）/ 设置组（主题 + 模型服务配置，
 * 2026-10-19 用户裁决统一降级纳入「设置」）/ 返回工作台 / 退出登录（唯一居中文本）。
 * 砍：成长计划、券码、下载电脑版、关注服务号（本项目不存在）。 */
import { computed, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import ThemeToggle from '@/components/layout/ThemeToggle.vue'
import TopupModal from '@/components/membership/TopupModal.vue'
import { BRAND_LOGO_URL, OFFICIAL_SITE_URL } from '@/constants/brand'
import { subscriptionLabel } from '@/services/users-api'

const emit = defineEmits<{
  'open-membership': []
  'open-model-settings': []
  /** 我的积分 / 我的订阅：移动端 pane（与 PC 路由页共用同一面板组件） */
  'open-points': []
  'open-subscription': []
  /** 账号信息：移动端 pane（与 PC 路由页共用同一面板组件） */
  'open-account': []
}>()

const auth = useAuthStore()

const nickname = computed(() => auth.user?.nickname || '未登录')

/** 订阅口径：未订阅说「未订阅」（免费版不是套餐）。 */
const membershipLabel = computed(() => subscriptionLabel(auth.user?.membership))

/** 积分充值（2026-10-19 用户裁决补入口）：TopupModal 直连，6 档瓦片 + 自定义 */
const showTopup = ref(false)

/** 设置二级卡片展开态（后续二级项在此追加） */
const settingsOpen = ref(false)

/** 进入官方：新窗口打开官网，避免用户离开当前创作上下文 */
function openOfficialSite() {
  window.open(OFFICIAL_SITE_URL, '_blank', 'noopener,noreferrer')
}
</script>

<template>
  <div class="profile-pane">
    <!-- 账号信息卡 -->
    <button
      type="button"
      class="profile-card account-row"
      @click="auth.isLoggedIn ? emit('open-account') : auth.openLogin()"
    >
      <img :src="BRAND_LOGO_URL" alt="" class="account-avatar" draggable="false">
      <span class="account-name">{{ nickname }}</span>
      <svg v-if="auth.isLoggedIn" class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
        <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
      </svg>
      <span v-else class="login-hint">点击登录</span>
    </button>

    <div v-if="auth.isLoggedIn" class="row-group">
      <!-- 我的积分 → 积分页（余额/进度/明细/充值；2026-10-19 从套餐弹窗拆出，此前积分入口误开会员面板） -->
      <button type="button" class="row-item" @click="emit('open-points')">
        <span class="row-label">我的积分</span>
        <span class="row-value tabular-nums">{{ auth.user?.points ?? 0 }}</span>
        <svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
        </svg>
      </button>
      <!-- 我的订阅 → 订阅页（订阅方案/到期时间/取消自动续费/查看所有方案） -->
      <button type="button" class="row-item" @click="emit('open-subscription')">
        <span class="row-label">我的订阅</span>
        <span class="row-value">{{ membershipLabel }}</span>
        <svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
        </svg>
      </button>
      <!-- 套餐订阅：当前订阅套餐 → 会员面板（购买/管理方案） -->
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

    <!-- 设置：一级卡片 → 展开二级卡片（2026-10-19 用户裁决；后续二级项在此追加） -->
    <div class="row-group">
      <button
        type="button"
        class="row-item"
        :aria-expanded="settingsOpen"
        @click="settingsOpen = !settingsOpen"
      >
        <span class="row-label">设置</span>
        <svg
          class="row-chevron"
          :class="{ 'is-open': settingsOpen }"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
        </svg>
      </button>

      <div v-if="settingsOpen" class="settings-sub">
        <div class="row-item is-static">
          <span class="row-label">外观</span>
          <ThemeToggle class="profile-theme-toggle" />
        </div>
        <button type="button" class="row-item" @click="emit('open-model-settings')">
          <span class="row-label">模型配置</span>
          <svg class="row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
            <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>

    <div class="row-group">
      <!-- 进入官方（2026-10-19 用户裁决：原「返回工作台」改为跳转官网主页） -->
      <button type="button" class="row-item" @click="openOfficialSite">
        <span class="row-label">进入官方</span>
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
/* 设置二级卡片：缩进 + 弱化分隔，视觉上从属于「设置」 */
.settings-sub {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--lnk-border-subtle);
  padding-top: 4px;
  margin-top: 2px;
}
.row-chevron {
  transition: transform var(--lnk-duration-fast) var(--lnk-ease-standard);
}
.row-chevron.is-open {
  transform: rotate(90deg);
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
