<script setup lang="ts">
/** 移动端应用骨架 · 我的页签（2026-10-18 IA v3，整页照抄 WorkBuddy 截图4，按本项目裁剪）：
 * 账号信息 / 积分区（我的积分·账户信息 + 套餐订阅·当前套餐 + 积分充值）/ 设置一级卡片
 * （点击展开二级卡片：外观 + 模型配置，后续二级项在此追加）/ 进入官方 / 退出登录。
 * 砍：成长计划、券码、下载电脑版、关注服务号（本项目不存在）。 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import ThemeToggle from '@/components/layout/ThemeToggle.vue'
import TopupModal from '@/components/membership/TopupModal.vue'
import { OFFICIAL_SITE_URL } from '@/constants/brand'
import BrandPatternAvatar from '@/components/account/BrandPatternAvatar.vue'
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
const router = useRouter()

const nickname = computed(() => auth.user?.nickname || '未登录')

/** 订阅口径：未订阅说「未订阅」（免费版不是套餐）。 */
const membershipLabel = computed(() => subscriptionLabel(auth.user?.membership))

/** 积分充值（2026-10-19 用户裁决补入口）：TopupModal 直连，6 档瓦片 + 自定义 */
const showTopup = ref(false)

/** 设置二级卡片展开态（后续二级项在此追加） */
const settingsOpen = ref(false)

/**
 * 进入官方：官网地址尚未确定（OFFICIAL_SITE_URL 预留为空）。
 * 留空时如实提示「即将上线」，不用占位域名把人导向 404；地址定下来后直接生效。
 */
function openOfficialSite() {
  if (!OFFICIAL_SITE_URL) {
    ElMessage.info('官网即将上线')
    return
  }
  window.open(OFFICIAL_SITE_URL, '_blank', 'noopener,noreferrer')
}

/**
 * 退出登录（2026-10-23 用户裁决第 6 点：「点【我的】-退出登录，应直接跳转到注册登录页，
 * 无需跳到品牌页」）：
 * 登出 ⇒ 回**身份页** /login（不是品牌页）——身份事件回到身份入口，用户在那里重新登录；
 * 登录成功再回 /workflow 品牌页（品牌链路不丢）。
 * ⛔ 不得只调 auth.logout()：那会把用户留在「我的」页这类已无身份归属的壳层里。
 */
function onLogout() {
  auth.logout()
  void router.push('/login')
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
      <BrandPatternAvatar
        :src="auth.user?.avatar"
        :seed="auth.user?.id ?? 'anonymous'"
        :name="nickname"
        size="lg"
        class="account-avatar"
      />
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
        <span class="row-value row-value--credit tabular-nums">{{ auth.user?.points ?? 0 }}</span>
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

    <!-- 设置：一级卡片 → 展开二级卡片（2026-10-19 用户裁决；后续二级项在此追加）。
         账号相关设置，仅登录后可见 —— 登出后不应出现（用户裁决）。 -->
    <div v-if="auth.isLoggedIn" class="row-group">
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

    <div v-if="auth.isLoggedIn" class="row-group">
      <!-- 进入官方（2026-10-19 用户裁决：原「返回工作台」改为官网入口，地址预留中） -->
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
      @click="onLogout"
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
  flex-shrink: 0;
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

/* 积分余额：琥珀色（--lnk-credit 单源）+ 加重——顶栏积分胶囊已撤出（2026-10-21
 * 用户裁决，信息重复），此处是移动端唯一常驻余额展示，需一眼可辨 */
.row-value--credit {
  color: var(--lnk-credit);
  font-weight: var(--lnk-weight-semibold, 600);
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
