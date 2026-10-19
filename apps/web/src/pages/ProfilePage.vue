<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TopupModal from '@/components/membership/TopupModal.vue'
import UsagePanel from '@/components/usage/UsagePanel.vue'
import { useAuthStore } from '@/stores/auth'
import { subscriptionLabel } from '@/services/users-api'
import { api } from '@/services/api'
import { copyTextToClipboard } from '@/utils/copyToClipboard'
import { BRAND_LOGO_URL } from '@/constants/brand'
import type { User } from '@lnkpi/shared'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

type ProfileTab = 'account' | 'billing'

const activeTab = computed<ProfileTab>(() => {
  const raw = Array.isArray(route.query.tab) ? route.query.tab[0] : route.query.tab
  if (raw === 'billing' || raw === 'usage') return 'billing'
  return 'account'
})

function setTab(tab: ProfileTab) {
  void router.replace({ query: { ...route.query, tab } })
}

function closeProfile() {
  if (window.history.length > 1) router.back()
  else void router.replace('/workflow')
}

const profile = ref<User | null>(null)
const showTopup = ref(false)
const inviteCopied = ref(false)

/// 账号徽章同样用订阅口径：免费版不是套餐，未订阅一律说「未订阅」。
const membershipLabel = computed(() => subscriptionLabel(profile.value?.membership))

const isFreeMembership = computed(() => !profile.value?.membership || profile.value.membership === 'free')

/// 订阅口径：未订阅说「未订阅」（免费版不是套餐），不出现「当前套餐：免费版」。
const subscriptionText = computed(() =>
  isFreeMembership.value ? '升级会员' : '管理会员',
)

async function copyInvite() {
  const code = profile.value?.inviteCode
  if (!code) return
  try {
    await copyTextToClipboard(code)
    inviteCopied.value = true
    setTimeout(() => {
      inviteCopied.value = false
    }, 1500)
  } catch {
    // ignore clipboard failures
  }
}

async function loadProfile() {
  try {
    const { data } = await api.get<{ data: User }>('/auth/profile')
    profile.value = data.data
    auth.user = data.data
  } catch {
    void router.push('/workflow')
  }
}

onMounted(() => {
  if (!auth.isLoggedIn) {
    auth.openLogin()
    return
  }
  void loadProfile()
})
</script>

<template>
  <div class="mx-auto max-w-6xl px-6 py-10">
    <div class="mb-6 flex items-center justify-between gap-4">
      <h1 class="text-2xl font-semibold">个人中心</h1>
      <button
        type="button"
        class="flex h-9 w-9 items-center justify-center rounded-full text-xl leading-none text-fg-3 transition hover:bg-overlay/[0.06] hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-overlay/40"
        aria-label="关闭"
        @click="closeProfile"
      >
        ×
      </button>
    </div>

    <div class="mb-6 inline-flex rounded-full border border-overlay/8 bg-surface-canvas p-1">
      <button
        v-for="tab in ([['account', '账户'], ['billing', '用量']] as const)"
        :key="tab[0]"
        type="button"
        class="rounded-full px-4 py-1.5 text-sm transition"
        :class="activeTab === tab[0] ? 'bg-overlay/12 text-fg' : 'text-fg-3 hover:text-fg'"
        @click="setTab(tab[0])"
      >
        {{ tab[1] }}
      </button>
    </div>

    <div v-if="profile && activeTab === 'account'" data-account-cards class="space-y-4">
      <section class="rounded-2xl border border-overlay/8 bg-surface-canvas p-6">
        <div class="flex items-center gap-4">
          <div class="profile-avatar flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full">
            <img
              :src="BRAND_LOGO_URL"
              alt="用户"
              class="h-full w-full object-contain p-0.5"
              draggable="false"
            >
          </div>
          <div class="min-w-0">
            <h2 class="truncate text-lg font-medium">{{ profile.nickname }}</h2>
            <p class="text-sm text-fg-3">{{ profile.phone }}</p>
            <span class="mt-1 inline-block rounded-full bg-overlay/[0.06] px-2.5 py-0.5 text-xs text-fg-2">
              {{ membershipLabel }}
            </span>
          </div>
        </div>
      </section>

      <section class="rounded-2xl border border-overlay/8 bg-surface-canvas p-6">
        <p class="text-sm text-fg-3">创作能量</p>
        <p class="mt-2 text-3xl font-semibold tabular-nums text-[var(--lnk-credit)]">{{ profile.points ?? 0 }}</p>
        <p v-if="isFreeMembership" class="mt-3 text-xs text-fg-3">开通会员，获得更多积分与高级能力</p>
        <div class="mt-4 flex gap-3">
          <button type="button" class="flex-1 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-black" @click="showTopup = true">
            充值
          </button>
          <button type="button" class="flex-1 rounded-xl border border-overlay/15 px-4 py-2.5 text-sm text-fg" @click="router.push('/subscription')">
            {{ subscriptionText }}
          </button>
        </div>
        <!-- 我的订阅 / 我的积分：PC 与移动端共用同一面板组件，这里只做入口 -->
        <div class="mt-3 flex gap-3">
          <button
            type="button"
            class="flex-1 rounded-xl border border-overlay/15 px-4 py-2 text-xs text-fg-2 transition hover:text-fg"
            @click="router.push('/subscription')"
          >
            我的订阅
          </button>
          <button
            type="button"
            class="flex-1 rounded-xl border border-overlay/15 px-4 py-2 text-xs text-fg-2 transition hover:text-fg"
            @click="router.push('/points')"
          >
            我的积分
          </button>
        </div>
      </section>

      <section class="rounded-2xl border border-overlay/8 bg-surface-canvas p-6">
        <p class="text-sm text-fg-3">我的邀请码</p>
        <div class="mt-2 flex items-center gap-3">
          <code class="text-lg tracking-widest text-fg">{{ profile.inviteCode ?? '—' }}</code>
          <button
            type="button"
            class="shrink-0 rounded-lg border border-overlay/15 px-3 py-1.5 text-xs text-fg-2 transition hover:bg-overlay/[0.06] hover:text-fg disabled:opacity-40"
            :disabled="!profile.inviteCode"
            @click="copyInvite"
          >
            {{ inviteCopied ? '已复制' : '复制' }}
          </button>
        </div>
        <p class="mt-3 text-sm text-fg-3">已邀请 {{ profile.inviteeCount ?? 0 }} 人</p>
      </section>
    </div>

    <div v-if="activeTab === 'billing'">
      <UsagePanel />
    </div>

    <TopupModal v-model="showTopup" />
  </div>
</template>

<style scoped>
.profile-avatar {
  background: var(--lnk-accent-gradient);
}
</style>
