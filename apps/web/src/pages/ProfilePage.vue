<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TopupModal from '@/components/membership/TopupModal.vue'
import UsagePanel from '@/components/usage/UsagePanel.vue'
import { useAuthStore } from '@/stores/auth'
import { subscriptionLabel } from '@/services/users-api'
import { api } from '@/services/api'
import { copyTextToClipboard } from '@/utils/copyToClipboard'
import BrandPatternAvatar from '@/components/account/BrandPatternAvatar.vue'
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
    <!-- P2 Task 5：去弹窗思维 —— 标题行左侧返回，右侧不再有 × -->
    <div class="mb-6 flex items-center gap-3">
      <button
        data-testid="profile-back"
        type="button"
        class="btn-ghost -ml-2 shrink-0 px-2 py-1 text-sm"
        @click="closeProfile"
      >
        ← 返回
      </button>
      <h1 class="font-display text-2xl font-semibold text-fg">个人中心</h1>
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
          <BrandPatternAvatar
            :src="profile.avatar"
            :seed="profile.id"
            :name="profile.nickname"
            size="lg"
          />
          <div class="min-w-0">
            <h2 class="truncate text-lg font-medium">{{ profile.nickname }}</h2>
            <p class="text-sm text-fg-3">{{ profile.phone }}</p>
            <span class="mt-1 inline-block rounded-full bg-overlay/[0.06] px-2.5 py-0.5 text-xs text-fg-2">
              {{ membershipLabel }}
            </span>
          </div>
        </div>
      </section>

      <!-- 能量为主视觉：display 档大数字，充值/会员为从属动作 -->
      <section class="rounded-2xl border border-overlay/8 bg-surface-canvas p-6">
        <p class="text-sm text-fg-3">创作能量</p>
        <p
          data-testid="profile-points"
          class="mt-1 font-bold tabular-nums text-[color:var(--lnk-credit)] [font-size:var(--lnk-text-display-1)] [line-height:var(--lnk-lh-display-1)]"
        >
          {{ profile.points ?? 0 }}
        </p>
        <p v-if="isFreeMembership" class="mt-2 text-xs text-fg-3">开通会员，获得更多积分与高级能力</p>
        <div class="mt-5 flex gap-3">
          <button type="button" class="btn-primary flex-1" @click="showTopup = true">
            充值
          </button>
          <button type="button" class="btn-ghost flex-1" @click="router.push('/subscription')">
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

      <!-- 邀请码降级：低频操作折叠进原生 details（键盘可达），不再各占一张主卡 -->
      <details class="rounded-2xl border border-overlay/8 bg-surface-canvas px-6 py-4">
        <summary class="cursor-pointer list-none text-sm text-fg-2 transition hover:text-fg">
          邀请与设置
        </summary>
        <div data-testid="invite-code-block" class="mt-4">
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
        </div>
      </details>
    </div>

    <div v-if="activeTab === 'billing'">
      <UsagePanel />
    </div>

    <TopupModal v-model="showTopup" />
  </div>
</template>
