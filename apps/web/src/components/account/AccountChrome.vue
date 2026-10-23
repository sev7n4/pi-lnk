<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import AccountPointsPill from '@/components/account/AccountPointsPill.vue'
import AccountUserMenu from '@/components/account/AccountUserMenu.vue'
import MembershipModal from '@/components/membership/MembershipModal.vue'
import TopupModal from '@/components/membership/TopupModal.vue'

defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{
  compact?: boolean
  rootClass?: string
  ownsModal?: boolean
  /** 2026-10-23 用户裁定：品牌页不展示个人积分（叙事位保持纯净），其余页面不变 */
  hidePoints?: boolean
}>(), {
  compact: false,
  ownsModal: true,
  hidePoints: false,
})

const auth = useAuthStore()
const showMembership = ref(false)
const showTopup = ref(false)

function openMembership() {
  showMembership.value = true
}

function openTopup() {
  showTopup.value = true
}
</script>

<template>
  <template v-if="auth.isLoggedIn">
    <div class="flex items-center gap-2" :class="[rootClass, $attrs.class]">
      <AccountPointsPill v-if="!hidePoints" @click="openMembership" />
      <AccountUserMenu :compact="compact" @open-topup="openTopup" />
    </div>
    <MembershipModal v-if="ownsModal" v-model="showMembership" />
    <TopupModal v-if="ownsModal" v-model="showTopup" />
  </template>
  <button
    v-else
    type="button"
    class="neo-chrome rounded-xl px-3 py-1.5 text-xs transition"
    :class="[rootClass, $attrs.class]"
    @click="auth.openLogin()"
  >
    登录
  </button>
</template>
